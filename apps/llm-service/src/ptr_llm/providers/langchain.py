"""Bounded LangChain ChatOpenAI transport for LiteLLM and direct local models."""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import math
import time
from contextvars import ContextVar
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from http.cookiejar import CookieJar, DefaultCookiePolicy
from typing import Any
from urllib.parse import urlsplit

from persona_timeline_rag.gateway_budget import HEADER, sign_request, sign_spillover_request

from ptr_llm.billing import ProviderError, provider_request_scope
from ptr_llm.config import _svc_host

from .common import (
    bounded,
    check_cancel,
    checked_messages,
    checked_text,
    count,
    fingerprint,
    js_json,
)
from .control_tokens import neutralize_json_strings, neutralize_messages
from .transport import LimitedTransport

_ALLOWED_CAPACITY_DROP_REASONS = frozenset(("rejected-saturated", "rejected-ttl-expired"))
logger = logging.getLogger(__name__)


class _NoCookies(DefaultCookiePolicy):
    def set_ok(self, cookie: Any, request: Any) -> bool:
        return False


class _ChatOpenAITextProvider:
    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key: str,
        max_output_tokens: int = 512,
        timeout_ms: int = 30000,
        input_bytes: int = 65536,
        ledger: Any = None,
        reservation_microusd: int = 100000,
        transport: Any = None,
        on_metrics: Any = None,
        pricing_ceiling: dict[str, float] | None = None,
        capacity_spillover_key: str | None = None,
        direct_local: bool = False,
        paid_spillover: Any = None,
        on_spillover_check_failure: Any = None,
        spillover_min_remaining_ms: int = 10000,
        cluster_mode: bool = False,
    ):
        import httpx

        if capacity_spillover_key is not None and (
            ledger is None
            or pricing_ceiling is None
            or model != "primary"
            or len(capacity_spillover_key.encode()) < 32
        ):
            raise ProviderError("BUDGET_AUTHORITY_REQUIRED")
        if direct_local and (ledger is not None or capacity_spillover_key is not None):
            raise ProviderError("INVALID_PROVIDER_CONFIG")
        if type(spillover_min_remaining_ms) is not int or spillover_min_remaining_ms < 0:
            raise ProviderError("INVALID_PROVIDER_CONFIG")
        self.direct_local = direct_local
        self.paid_spillover = paid_spillover
        self.on_spillover_check_failure = on_spillover_check_failure
        self.spillover_min_remaining_ms = spillover_min_remaining_ms
        self.spillover_enabled = False
        self._spillover_check_failed = False
        self.capacity_spillover_key = capacity_spillover_key
        try:
            if not isinstance(base_url, str):
                raise ValueError
            url = urlsplit(base_url)
            _ = url.port
        except (ValueError, TypeError):
            raise ProviderError("INVALID_PROXY_URL") from None
        if (
            url.scheme not in ("http", "https")
            or not url.hostname
            or url.username
            or url.password
            or url.query
            or url.fragment
        ):
            raise ProviderError("INVALID_PROXY_URL")
        if direct_local and (
            url.path not in ("", "/", "/v1", "/v1/")
            or (
                not _svc_host(url.hostname)
                if cluster_mode
                else url.hostname not in ("localhost", "127.0.0.1", "::1")
            )
        ):
            raise ProviderError("LOCAL_URL_NOT_ALLOWED")
        if (
            not model.strip()
            or not (api_key.strip() or direct_local)
            or any(
                type(x) is not int or x < 1
                for x in (max_output_tokens, timeout_ms, input_bytes, reservation_microusd)
            )
        ):
            raise ProviderError("INVALID_PROVIDER_CONFIG")
        self.base_url, self.model, self.api_key = base_url, model, api_key
        self.max_output_tokens, self.timeout_ms, self.input_bytes = (
            max_output_tokens,
            timeout_ms,
            input_bytes,
        )
        self.ledger, self.reservation_microusd, self.transport = (
            ledger,
            reservation_microusd,
            transport,
        )
        self.on_metrics = on_metrics
        self.pricing_ceiling = pricing_ceiling
        if ledger is not None and (
            not isinstance(pricing_ceiling, dict)
            or set(pricing_ceiling) != {"prompt", "completion"}
            or any(
                type(value) not in (int, float) or not math.isfinite(value) or value < 0
                for value in pricing_ceiling.values()
            )
        ):
            raise ProviderError("PRICING_UNVERIFIED")
        if capacity_spillover_key is not None and (
            pricing_ceiling is None or any(v <= 0 for v in pricing_ceiling.values())
        ):
            raise ProviderError("PRICING_UNVERIFIED")
        # CA loading is synchronous. Do it once at provider startup, not once
        # per async submission. HTTPX's public factory preserves CA env settings.
        self.ssl_context = (
            httpx.create_ssl_context(verify=True, trust_env=True) if transport is None else None
        )
        self._hook_context: ContextVar[Any] = ContextVar("litellm_request_hooks", default=None)
        self._client: Any = None
        self._sdk: Any = None
        self._paid_sdk: Any = None
        self._runnables: dict[str, Any] = {}
        self._active: set[asyncio.Task[Any]] = set()
        self._closed = False
        self._close_lock = asyncio.Lock()
        self._spillover_check_task: asyncio.Task[None] | None = None

    async def _observe_request(self, request: Any) -> None:
        hooks = self._hook_context.get()
        if hooks is None:
            raise ProviderError("PROVIDER_CONTEXT_REQUIRED")
        await hooks[0](request)

    async def _observe_response(self, response: Any) -> None:
        hooks = self._hook_context.get()
        if hooks is None:
            raise ProviderError("PROVIDER_CONTEXT_REQUIRED")
        await hooks[1](response)

    def _runnable(
        self, mode: str, response_schema: dict[str, Any] | None = None, *, paid: bool = False
    ) -> Any:
        import httpx
        from langchain_openai import ChatOpenAI
        from pydantic import SecretStr

        if self._sdk is None:
            self._client = httpx.AsyncClient(
                transport=LimitedTransport(self.transport, self.ssl_context),
                follow_redirects=False,
                cookies=CookieJar(policy=_NoCookies()),
                event_hooks={
                    "request": [self._observe_request],
                    "response": [self._observe_response],
                },
            )
            self._sdk = ChatOpenAI(
                model=self.model,
                api_key=SecretStr(self.api_key or "local-no-api-key"),
                base_url=self.base_url,
                temperature=0,
                max_completion_tokens=self.max_output_tokens,
                timeout=self.timeout_ms / 1000,
                max_retries=0,
                streaming=False,
                use_responses_api=False,
                cache=False,
                verbose=False,
                http_async_client=self._client,
                extra_body={"chat_template_kwargs": {"enable_thinking": False}}
                if self.direct_local
                else None,
            )
            self._runnables["plain"] = self._sdk
        sdk = self._sdk
        if paid:
            if self._paid_sdk is None:
                self._paid_sdk = self._sdk.model_copy(update={"model_name": "openrouter-primary"})
            sdk = self._paid_sdk
            if mode == "plain" and response_schema is None:
                return sdk
        if response_schema is not None:
            # Reuse the transport, not a private per-turn schema/runnable cache.
            return sdk.with_structured_output(
                {"title": "agent_reply", **response_schema},
                method="json_schema",
                strict=False,
                include_raw=True,
            )
        cache_key = ("paid:" if paid else "") + mode
        if cache_key not in self._runnables:
            if mode == "agent":
                from ptr_llm.core.protocol import AGENT_RESPONSE_JSON_SCHEMA

                self._runnables[cache_key] = sdk.with_structured_output(
                    {"title": "agent_reply", **AGENT_RESPONSE_JSON_SCHEMA},
                    method="json_schema",
                    strict=False,
                    include_raw=True,
                )
            else:
                self._runnables[cache_key] = sdk.bind(response_format={"type": "json_object"})
        return self._runnables[cache_key]

    async def aclose(self) -> None:
        async with self._close_lock:
            self._closed = True
            if self._spillover_check_task is not None:
                self._spillover_check_task.cancel()
                await asyncio.gather(self._spillover_check_task, return_exceptions=True)
            current = asyncio.current_task()
            active = [task for task in self._active if task is not current]
            for task in active:
                task.cancel()
            await asyncio.gather(*active, return_exceptions=True)
            if self._client is not None:
                await self._client.aclose()

    async def start_spillover_checks(
        self, max_limit_usd: float, *, interval_seconds: float = 60
    ) -> None:
        """Fail on key misconfiguration; suspend paid calls during provider outages."""
        if self.paid_spillover is None:
            return

        def update_status(available: bool) -> None:
            if available:
                if not self.spillover_enabled:
                    logger.warning("OPENROUTER_SPILLOVER_ENABLED")
            elif not self._spillover_check_failed:
                logger.warning("OPENROUTER_SPILLOVER_CHECK_FAILED")
                if self.on_spillover_check_failure is not None:
                    self.on_spillover_check_failure("OPENROUTER_SPILLOVER_CHECK_FAILED")
                if self.spillover_enabled:
                    logger.warning("OPENROUTER_SPILLOVER_DISABLED")
            self.spillover_enabled = available
            self._spillover_check_failed = not available

        try:
            available = await self.paid_spillover.verify_key_limit(max_limit_usd)
        except ProviderError:
            update_status(False)
            raise
        if available:
            try:
                await self.paid_spillover.verify_pricing()
            except ProviderError:
                available = False
        update_status(available)

        async def recheck() -> None:
            while True:
                await asyncio.sleep(interval_seconds)
                try:
                    ready = await self.paid_spillover.verify_key_limit(max_limit_usd)
                    if ready:
                        await self.paid_spillover.verify_pricing()
                    update_status(ready)
                except ProviderError:
                    update_status(False)

        self._spillover_check_task = asyncio.create_task(recheck())

    def request_fingerprint(
        self,
        messages: list[dict[str, str]],
        request_key: str | None = None,
        *,
        response_schema: dict[str, Any] | None = None,
    ) -> str:
        return fingerprint(
            {
                "revision": "local-langchain-v1" if self.direct_local else "litellm-langchain-v1",
                "baseUrl": self.base_url,
                "model": self.model,
                "messages": neutralize_messages(messages),
                "maxTokens": self.max_output_tokens,
                "agent": any(
                    m["role"] == "system" and "AGENT_JSON_REPLY" in m["content"] for m in messages
                ),
                "timeline": any(
                    m["role"] == "system" and "TIMELINE_JSON_REPLY" in m["content"]
                    for m in messages
                ),
                "requestKey": request_key,
                **({"capacitySpillover": "budgeted-v1"} if self.capacity_spillover_key else {}),
                **({"directSpillover": "openrouter-v1"} if self.paid_spillover else {}),
                **(
                    {"responseSchema": neutralize_json_strings(response_schema)}
                    if response_schema is not None
                    else {}
                ),
            }
        )

    async def generate(
        self,
        messages: list[dict[str, str]],
        *,
        signal: asyncio.Event | None = None,
        request_key: str | None = None,
        deadline_at: float | None = None,
        priority: int = 0,
        on_served: Any = None,
        on_usage: Any = None,
        response_schema: dict[str, Any] | None = None,
        on_metrics: Any = None,
    ) -> str:
        import httpx
        from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

        from ptr_llm.core.langchain import assert_private_sdk_configuration, private_ainvoke

        if self._closed:
            raise ProviderError("PROVIDER_CLOSED")
        assert_private_sdk_configuration()
        check_cancel(signal)
        checked_messages(messages, self.input_bytes)
        if response_schema is not None:
            if not isinstance(response_schema, dict):
                raise ProviderError("INVALID_INPUT")
            response_schema = neutralize_json_strings(copy.deepcopy(response_schema))
            if not any(
                m["role"] == "system" and "AGENT_JSON_REPLY" in m["content"] for m in messages
            ):
                raise ProviderError("INVALID_INPUT")
            from jsonschema import Draft202012Validator

            try:
                Draft202012Validator.check_schema(response_schema)
            except Exception:
                raise ProviderError("INVALID_INPUT") from None
            # The finite schema repeats quotes/IDs: budget the whole request, not messages alone.
            if (
                len(
                    js_json(
                        {
                            "messages": neutralize_messages(messages),
                            "response_format": {
                                "type": "json_schema",
                                "json_schema": {
                                    "name": "agent_reply",
                                    "schema": {"title": "agent_reply", **response_schema},
                                    "strict": False,
                                },
                            },
                            "model": self.model,
                            "max_completion_tokens": self.max_output_tokens,
                            "temperature": 0,
                            "stream": False,
                            **(
                                {"chat_template_kwargs": {"enable_thinking": False}}
                                if self.direct_local
                                else {}
                            ),
                        }
                    ).encode()
                )
                > self.input_bytes
            ):
                raise ProviderError("INPUT_LIMIT")
        if deadline_at is not None and (
            type(deadline_at) not in (int, float) or not math.isfinite(deadline_at)
        ):
            raise ProviderError("INVALID_INPUT")
        now = time.time() * 1000
        effective_deadline = min(
            now + self.timeout_ms, deadline_at if deadline_at is not None else math.inf
        )
        timeout_code = (
            "PROVIDER_DEADLINE" if effective_deadline == deadline_at else "PROVIDER_TIMEOUT"
        )
        if effective_deadline <= now:
            raise ProviderError(timeout_code)
        started = time.perf_counter()
        metrics_callback = on_metrics if on_metrics is not None else self.on_metrics
        attempts = 0
        usage: dict[str, int | None] = {"promptTokens": None, "completionTokens": None}
        upstream, cost, generation_id = ("local" if self.direct_local else "litellm"), None, None
        primary_cost: int | None = None
        paid_cost: int | None = None
        submitted = finished = False
        transport_error_code: str | None = None
        drop_reason: str | None = None
        local_status: int | None = None
        current_request_model = self.model
        paid_authorized = False
        key = self.request_fingerprint(messages, request_key, response_schema=response_schema)
        if self.ledger:
            safe_body: dict[str, Any] = {
                "model": self.model,
                "messages": neutralize_messages(messages),
                "max_completion_tokens": self.max_output_tokens,
                "temperature": 0,
                "stream": False,
            }
            if any(m["role"] == "system" and "AGENT_JSON_REPLY" in m["content"] for m in messages):
                from ptr_llm.core.protocol import AGENT_RESPONSE_JSON_SCHEMA

                safe_body["response_format"] = {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "agent_reply",
                        "schema": {
                            "title": "agent_reply",
                            **(response_schema or AGENT_RESPONSE_JSON_SCHEMA),
                        },
                        "strict": False,
                    },
                }
            elif any(
                m["role"] == "system" and "TIMELINE_JSON_REPLY" in m["content"] for m in messages
            ):
                safe_body["response_format"] = {"type": "json_object"}
            ceiling = self.pricing_ceiling
            assert ceiling is not None  # constructor validation, not caller trust
            input_upper_bound = len(js_json(safe_body).encode()) + len(messages) * 64 + 2048
            worst_cost = math.ceil(
                input_upper_bound * 2 * ceiling["prompt"]
                + self.max_output_tokens * ceiling["completion"]
            )
            if worst_cost > self.reservation_microusd:
                raise ProviderError("RESERVATION_BELOW_MAXIMUM_COST")

        def report(ok: bool, error: str | None = None) -> None:
            if metrics_callback:
                metrics_callback(
                    {
                        "model": self.model,
                        "ok": ok,
                        **({"error": error} if error else {}),
                        "ttftMs": None,
                        "totalMs": round((time.perf_counter() - started) * 1000),
                        **usage,
                        "attempts": attempts,
                        "costMicrousd": cost,
                    }
                )

        def success(receipt: Any) -> str:
            nonlocal usage
            if (
                not isinstance(receipt, dict)
                or not isinstance(receipt.get("usage"), dict)
                or not isinstance(receipt.get("upstream"), str)
            ):
                raise ProviderError("INVALID_PROVIDER_RESPONSE")
            text = checked_text(receipt.get("text"))
            usage = {
                k: count(receipt["usage"].get(k)) for k in ("promptTokens", "completionTokens")
            }
            if on_usage:
                on_usage(usage)
            if on_served:
                on_served(receipt["upstream"])
            report(True)
            return text

        async def observe_request(request: httpx.Request) -> None:
            nonlocal attempts, transport_error_code, current_request_model
            if self.direct_local and not self.api_key:
                request.headers.pop("authorization", None)
            if (signal is not None and signal.is_set()) or time.time() * 1000 >= effective_deadline:
                transport_error_code = (
                    "CANCELLED" if signal is not None and signal.is_set() else timeout_code
                )
                raise ProviderError(transport_error_code)
            body = json.loads(request.content)
            current_request_model = (
                body.get("model") if isinstance(body.get("model"), str) else self.model
            )
            if self.capacity_spillover_key is not None:
                if not submitted:
                    raise ProviderError("BUDGET_AUTHORITY_REQUIRED")
                expiry = int(min(effective_deadline, time.time() * 1000 + 25000))
                if body.get("model") == "openrouter-primary":
                    if not paid_authorized:
                        raise ProviderError("BUDGET_AUTHORITY_REQUIRED")
                    request.headers[HEADER] = sign_spillover_request(
                        body, self.capacity_spillover_key, key, expiry, self.reservation_microusd
                    )
                else:
                    request.headers[HEADER] = sign_request(
                        body, self.capacity_spillover_key, key, expiry, self.reservation_microusd
                    )
            attempts += 1

        async def observe_response(response: httpx.Response) -> None:
            nonlocal upstream, cost, primary_cost, paid_cost, generation_id, usage
            nonlocal transport_error_code, drop_reason, local_status
            if self.direct_local:
                local_status = response.status_code
            served = (
                None
                if self.direct_local
                else response.headers.get("x-litellm-model-id")
                or response.headers.get("x-ptr-upstream")
            )
            is_paid_call = (
                current_request_model == "openrouter-primary" or served == "openrouter-primary"
            )
            if is_paid_call:
                upstream = "openrouter-primary"
            elif served in ("primary", "secondary", "local-pool", "fake", "openrouter-primary"):
                upstream = served
            if int(response.headers.get("content-length", "0")) > 2 * 1024 * 1024:
                raise ProviderError("PROVIDER_RESPONSE_LIMIT")
            try:
                raw_bytes = await response.aread()
            except ProviderError as error:
                transport_error_code = error.code
                raise
            if len(raw_bytes) > 2 * 1024 * 1024:
                raise ProviderError("PROVIDER_RESPONSE_LIMIT")
            if not response.is_success:
                candidate = response.headers.get(
                    "x-llm-d-request-dropped-reason"
                    if self.direct_local
                    else "llm_provider-x-llm-d-request-dropped-reason"
                )
                drop_reason = (
                    candidate
                    if response.status_code == 429
                    and candidate in _ALLOWED_CAPACITY_DROP_REASONS
                    else None
                )
            if self.ledger and response.is_success:
                call_cost: int | None = None
                try:
                    raw = response.json()
                    generation_id = raw.get("id") if isinstance(raw.get("id"), str) else None
                    billed_usage = raw.get("usage") or {}
                    usage = {
                        "promptTokens": count(billed_usage.get("prompt_tokens")),
                        "completionTokens": count(billed_usage.get("completion_tokens")),
                    }
                    value: Any = billed_usage.get("cost")
                    if self.capacity_spillover_key and is_paid_call:
                        authoritative = response.headers.get("llm_provider-x-litellm-response-cost")
                        value = None
                        if authoritative is not None:
                            try:
                                value = Decimal(authoritative)
                            except InvalidOperation:
                                value = None
                    if type(value) in (float, int, Decimal):
                        try:
                            precise = Decimal(str(value))
                            if precise.is_finite() and precise >= 0:
                                microusd = precise * 1_000_000
                                if microusd <= 2**53 - 1:
                                    call_cost = int(
                                        microusd.to_integral_value(rounding=ROUND_CEILING)
                                    )
                        except InvalidOperation:
                            pass
                except (ValueError, AttributeError, TypeError):
                    raise ProviderError("INVALID_PROVIDER_RESPONSE") from None

                if (
                    self.capacity_spillover_key
                    and not is_paid_call
                    and served in ("local-pool", "primary", "secondary")
                ):
                    call_cost = 0  # Trusted owned gateway selected a nonbillable local deployment.
                if current_request_model == "openrouter-primary":
                    paid_cost = call_cost
                else:
                    primary_cost = call_cost
                cost = call_cost

        token = self._hook_context.set((observe_request, observe_response))
        task = asyncio.current_task()
        assert task is not None
        self._active.add(task)
        try:
            if self.ledger:
                created, saved = await self.ledger.reserve(
                    key,
                    self.reservation_microusd,
                    scope=provider_request_scope(request_key, "chat"),
                )
                if (
                    signal is not None and signal.is_set()
                ) or time.time() * 1000 >= effective_deadline:
                    if created:
                        await self.ledger.finish(key, 0, None, None)
                        finished = True
                    check_cancel(signal)
                    raise ProviderError(timeout_code)
                if not created:
                    if (
                        saved.actual_microusd is not None
                        and saved.actual_microusd > saved.reserved_microusd
                    ):
                        raise ProviderError("PROVIDER_COST_EXCEEDS_RESERVATION")
                    if saved.state == "settled" and saved.response is not None:
                        cost = saved.actual_microusd
                        return success(saved.response)
                    raise ProviderError("REQUEST_UNRESOLVED_NO_RESUBMIT")
                # Must COMMIT before the SDK can submit its first network request.
                await self.ledger.submitted(key)
                submitted = True
            safe = neutralize_messages(messages)
            agent = any(
                m["role"] == "system" and "AGENT_JSON_REPLY" in m["content"] for m in messages
            )
            timeline = any(
                m["role"] == "system" and "TIMELINE_JSON_REPLY" in m["content"] for m in messages
            )
            runnable = self._runnable(
                "agent" if agent else "timeline" if timeline else "plain", response_schema
            )
            input_messages = [
                (
                    SystemMessage
                    if m["role"] == "system"
                    else HumanMessage
                    if m["role"] == "user"
                    else AIMessage
                )(content=m["content"])
                for m in safe
            ]
            remaining = (effective_deadline - time.time() * 1000) / 1000
            try:
                raw = await bounded(
                    private_ainvoke(runnable, input_messages),
                    timeout=remaining,
                    signal=signal,
                    timeout_code=timeout_code,
                )
            except Exception:
                remaining_ms = effective_deadline - time.time() * 1000
                if (
                    self.direct_local
                    and self.spillover_enabled
                    and self.paid_spillover is not None
                    and local_status == 429
                    and drop_reason in _ALLOWED_CAPACITY_DROP_REASONS
                    and attempts == 1
                    and remaining_ms >= self.spillover_min_remaining_ms
                ):
                    paid_usage: dict[str, int | None] = {}

                    def receive_paid_cost(value: int | None) -> None:
                        nonlocal cost
                        cost = value

                    def paid_used(value: dict[str, int | None]) -> None:
                        paid_usage.update(value)

                    text = await self.paid_spillover.generate(
                        messages,
                        signal=signal,
                        request_key=request_key,
                        deadline_at=effective_deadline,
                        response_schema=response_schema,
                        on_cost=receive_paid_cost,
                        on_usage=paid_used,
                    )
                    upstream = "openrouter"
                    receipt = {"text": text, "usage": paid_usage, "upstream": upstream}
                    return success(receipt)
                if (
                    self.capacity_spillover_key is None
                    or drop_reason not in _ALLOWED_CAPACITY_DROP_REASONS
                    or attempts != 1
                ):
                    raise
                paid_authorized = True
                upstream, cost, generation_id = "litellm", None, None
                drop_reason = None
                paid_runnable = self._runnable(
                    "agent" if agent else "timeline" if timeline else "plain",
                    response_schema,
                    paid=True,
                )
                raw = await bounded(
                    private_ainvoke(paid_runnable, input_messages),
                    timeout=(effective_deadline - time.time() * 1000) / 1000,
                    signal=signal,
                    timeout_code=timeout_code,
                )
            if agent:
                if not isinstance(raw, dict) or raw.get("parsed") is None:
                    raise ProviderError("INVALID_PROVIDER_RESPONSE")
                if response_schema is not None:
                    try:
                        Draft202012Validator(response_schema).validate(
                            json.loads(raw["raw"].content)
                        )
                    except Exception:
                        raise ProviderError("INVALID_PROVIDER_RESPONSE") from None
                raw = raw["raw"]
            check_cancel(signal)
            usage = {
                "promptTokens": count((raw.usage_metadata or {}).get("input_tokens")),
                "completionTokens": count((raw.usage_metadata or {}).get("output_tokens")),
            }
            if self.direct_local:
                cost = 0
            receipt = {"text": checked_text(raw.content), "usage": usage, "upstream": upstream}
            if self.ledger:
                cost = paid_cost if paid_authorized else primary_cost
                await self.ledger.finish(key, cost, receipt, generation_id)
                finished = True
                if cost is not None and cost > self.reservation_microusd:
                    raise ProviderError("PROVIDER_COST_EXCEEDS_RESERVATION")
            check_cancel(signal)
            return success(receipt)
        except BaseException as error:
            cause = error
            for _ in range(8):
                if isinstance(cause, ProviderError):
                    transport_error_code = cause.code
                    break
                if self.direct_local and isinstance(cause, httpx.TimeoutException):
                    transport_error_code = "PROVIDER_TIMEOUT"
                    break
                nested = cause.__cause__ or cause.__context__
                if nested is None:
                    break
                cause = nested
            if self.ledger and submitted and not finished:
                no_network_expiry = attempts == 0 and (
                    isinstance(error, asyncio.CancelledError)
                    or isinstance(error, ProviderError)
                    and error.code in ("CANCELLED", "PROVIDER_DEADLINE", "PROVIDER_TIMEOUT")
                    or transport_error_code
                    in ("CANCELLED", "PROVIDER_DEADLINE", "PROVIDER_TIMEOUT")
                )
                cost = paid_cost if paid_authorized else primary_cost
                await asyncio.shield(
                    self.ledger.finish(key, 0 if no_network_expiry else cost, None, generation_id)
                )
            if isinstance(error, asyncio.CancelledError):
                report(False, "CANCELLED")
                raise
            code = (
                error.code
                if isinstance(error, ProviderError)
                else transport_error_code
                if transport_error_code is not None
                else "CANCELLED"
                if signal is not None and signal.is_set()
                else f"PROVIDER_HTTP_{error.status_code}"
                if hasattr(error, "status_code")
                else "PROVIDER_TIMEOUT"
                if isinstance(error, (TimeoutError, httpx.TimeoutException))
                else "PROVIDER_TRANSPORT"
            )
            report(False, code)
            raise ProviderError(code) from None
        finally:
            self._hook_context.reset(token)
            self._active.discard(task)


class LiteLLMTextProvider(_ChatOpenAITextProvider):
    """The retained gateway path during the staged migration."""


class DirectLocalTextProvider(_ChatOpenAITextProvider):
    """Direct local ChatOpenAI calls using the shared bounded text contract."""

    def __init__(
        self,
        *,
        base_url: str,
        model: str,
        api_key: str = "",
        cluster_mode: bool = False,
        paid_spillover: Any = None,
        on_spillover_check_failure: Any = None,
        spillover_min_remaining_ms: int = 10000,
        max_output_tokens: int = 512,
        timeout_ms: int = 30000,
        input_bytes: int = 65536,
        transport: Any = None,
        on_metrics: Any = None,
    ):
        super().__init__(
            base_url=base_url,
            model=model,
            api_key=api_key,
            max_output_tokens=max_output_tokens,
            timeout_ms=timeout_ms,
            input_bytes=input_bytes,
            transport=transport,
            on_metrics=on_metrics,
            direct_local=True,
            cluster_mode=cluster_mode,
            paid_spillover=paid_spillover,
            on_spillover_check_failure=on_spillover_check_failure,
            spillover_min_remaining_ms=spillover_min_remaining_ms,
        )
