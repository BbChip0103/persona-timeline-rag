"""Bounded LangChain ChatOpenAI transport for direct local models."""

from __future__ import annotations

import asyncio
import copy
import json
import logging
import math
import random
import time
from contextvars import ContextVar
from http.cookiejar import CookieJar, DefaultCookiePolicy
from typing import Any
from urllib.parse import urlsplit
from uuid import uuid4

from ptr_llm.billing import ProviderError, SpilloverNotSubmitted
from ptr_llm.config import _svc_host
from ptr_llm.spillover_metrics import set_available

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
from .local_slots import LocalSlots
from .transport import LimitedTransport

_ALLOWED_CAPACITY_DROP_REASONS = frozenset(("rejected-saturated", "rejected-ttl-expired"))
logger = logging.getLogger(__name__)


class _NoCookies(DefaultCookiePolicy):
    def set_ok(self, cookie: Any, request: Any) -> bool:
        return False


class DirectLocalTextProvider:
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
        local_slots: LocalSlots | None = None,
        slot_redis: Any = None,
        spillover_wait_ms: int = 2000,
    ):
        import httpx

        if type(spillover_min_remaining_ms) is not int or spillover_min_remaining_ms < 0:
            raise ProviderError("INVALID_PROVIDER_CONFIG")
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
            or url.path not in ("", "/", "/v1", "/v1/")
            or (
                not _svc_host(url.hostname)
                if cluster_mode
                else url.hostname not in ("localhost", "127.0.0.1", "::1")
            )
        ):
            raise ProviderError("LOCAL_URL_NOT_ALLOWED")
        limits = (max_output_tokens, timeout_ms, input_bytes)
        if not model.strip() or any(type(value) is not int or value < 1 for value in limits):
            raise ProviderError("INVALID_PROVIDER_CONFIG")
        self.base_url, self.model, self.api_key = base_url, model, api_key
        self.max_output_tokens, self.timeout_ms, self.input_bytes = (
            max_output_tokens,
            timeout_ms,
            input_bytes,
        )
        self.transport = transport
        self.cluster_mode = cluster_mode
        self.on_metrics = on_metrics
        self.local_slots = local_slots
        self.slot_redis = slot_redis
        self.spillover_wait_ms = spillover_wait_ms
        self.paid_spillover = paid_spillover
        self.on_spillover_check_failure = on_spillover_check_failure
        self.spillover_min_remaining_ms = spillover_min_remaining_ms
        self.spillover_enabled = False
        self._spillover_check_failed = False
        self.ssl_context = (
            httpx.create_ssl_context(verify=True, trust_env=True) if transport is None else None
        )
        self._hook_context: ContextVar[Any] = ContextVar("local_model_request_hooks", default=None)
        self._client: Any = None
        self._sdk: Any = None
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

    def _runnable(self, mode: str, response_schema: dict[str, Any] | None = None) -> Any:
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
                extra_body={"chat_template_kwargs": {"enable_thinking": False}},
            )
            self._runnables["plain"] = self._sdk
        if response_schema is not None:
            return self._sdk.with_structured_output(
                {"title": "agent_reply", **response_schema},
                method="json_schema",
                strict=False,
                include_raw=True,
            )
        if mode not in self._runnables:
            if mode == "agent":
                from ptr_llm.core.protocol import AGENT_RESPONSE_JSON_SCHEMA

                self._runnables[mode] = self._sdk.with_structured_output(
                    {"title": "agent_reply", **AGENT_RESPONSE_JSON_SCHEMA},
                    method="json_schema",
                    strict=False,
                    include_raw=True,
                )
            else:
                self._runnables[mode] = self._sdk.bind(response_format={"type": "json_object"})
        return self._runnables[mode]

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
            try:
                if self._client is not None:
                    await self._client.aclose()
            finally:
                if self.slot_redis is not None:
                    await self.slot_redis.aclose()

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
            set_available(available)

        try:
            available = await self.paid_spillover.verify_key_limit(max_limit_usd)
        except ProviderError:
            update_status(False)
            raise
        if available:
            try:
                await self.paid_spillover.verify_pricing()
                if not getattr(self.paid_spillover, "_chat_zdr_available", True):
                    available = False
                budget_check = getattr(self.paid_spillover, "spillover_budget_available", None)
                if available and budget_check is not None:
                    available = await budget_check()
            except ProviderError:
                available = False
        update_status(available)

        async def recheck() -> None:
            while True:
                await asyncio.sleep(interval_seconds)
                try:
                    ready = await self.paid_spillover.verify_key_limit(max_limit_usd)
                    if ready:
                        reverify = getattr(self.paid_spillover, "reverify_spillover", None)
                        if reverify is not None:
                            await reverify()
                        else:
                            await self.paid_spillover.verify_pricing()
                        ready = getattr(self.paid_spillover, "_chat_zdr_available", True)
                        budget_check = getattr(
                            self.paid_spillover, "spillover_budget_available", None
                        )
                        if ready and budget_check is not None:
                            ready = await budget_check()
                    update_status(ready)
                except Exception as error:
                    logger.warning(
                        "OPENROUTER_SPILLOVER_RECHECK_FAILED error_class=%s",
                        type(error).__name__,
                    )
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
                "revision": "local-langchain-v1",
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

        _ = priority
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
                            "chat_template_kwargs": {"enable_thinking": False},
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
        upstream, cost = "local", None
        transport_error_code: str | None = None
        drop_reason: str | None = None
        local_status: int | None = None
        lease_id = uuid4().hex if self.local_slots is not None else None
        lease_acquired = False
        spill_attempted = False
        retry_local_after_refusal = False

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
            nonlocal attempts, transport_error_code
            if not self.api_key:
                request.headers.pop("authorization", None)
            if (signal is not None and signal.is_set()) or time.time() * 1000 >= effective_deadline:
                transport_error_code = (
                    "CANCELLED" if signal is not None and signal.is_set() else timeout_code
                )
                raise ProviderError(transport_error_code)
            attempts += 1

        async def observe_response(response: httpx.Response) -> None:
            nonlocal transport_error_code, drop_reason, local_status
            local_status = response.status_code
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
                candidate = response.headers.get("x-llm-d-request-dropped-reason")
                drop_reason = (
                    candidate
                    if response.status_code == 429
                    and candidate in _ALLOWED_CAPACITY_DROP_REASONS
                    else None
                )

        token = self._hook_context.set((observe_request, observe_response))
        task = asyncio.current_task()
        assert task is not None
        self._active.add(task)
        try:
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

            async def paid_result() -> str:
                nonlocal cost
                paid_usage: dict[str, int | None] = {}

                def receive_paid_cost(value: int | None) -> None:
                    nonlocal cost
                    cost = value

                text = await self.paid_spillover.generate(
                    messages,
                    require_zdr=True,
                    signal=signal,
                    request_key=request_key,
                    deadline_at=effective_deadline,
                    response_schema=response_schema,
                    on_cost=receive_paid_cost,
                    on_usage=paid_usage.update,
                )
                return success({"text": text, "usage": paid_usage, "upstream": "openrouter"})

            slot_wait_start = time.monotonic()
            raw: Any = None
            while True:
                check_cancel(signal)
                remaining_ms = effective_deadline - time.time() * 1000
                if remaining_ms <= 0:
                    raise ProviderError(timeout_code)
                if self.local_slots is not None and not lease_acquired:
                    assert lease_id is not None
                    # Reserve 100ms for Redis scheduling so a killed worker's slot
                    # expires by deadline + 2s.
                    lease_acquired = await bounded(
                        self.local_slots.acquire(lease_id, remaining_ms / 1000 + 1.9),
                        timeout=remaining_ms / 1000,
                        signal=signal,
                        timeout_code=timeout_code,
                    )
                    if not lease_acquired:
                        can_spill = (
                            self.spillover_enabled
                            and self.paid_spillover is not None
                            and not spill_attempted
                            and (time.monotonic() - slot_wait_start) * 1000
                            >= self.spillover_wait_ms
                            and remaining_ms >= self.spillover_min_remaining_ms
                        )
                        if can_spill:
                            spill_attempted = True
                            try:
                                return await paid_result()
                            except SpilloverNotSubmitted as error:
                                if error.code in ("BUDGET_EXCEEDED", "BUDGET_NOT_INITIALIZED"):
                                    self.spillover_enabled = False
                                    set_available(False)
                                # The request was never sent; continue waiting for the slot.
                        if signal is None:
                            await asyncio.sleep(min(0.05, remaining_ms / 1000))
                        else:
                            try:
                                await asyncio.wait_for(
                                    signal.wait(), timeout=min(0.05, remaining_ms / 1000)
                                )
                            except TimeoutError:
                                pass
                        continue
                local_status = None
                drop_reason = None
                try:
                    raw = await bounded(
                        private_ainvoke(runnable, input_messages),
                        timeout=(effective_deadline - time.time() * 1000) / 1000,
                        signal=signal,
                        timeout_code=timeout_code,
                    )
                    break
                except Exception:
                    remaining_ms = effective_deadline - time.time() * 1000
                    capacity = local_status == 429 and drop_reason in _ALLOWED_CAPACITY_DROP_REASONS
                    if (
                        capacity
                        and self.spillover_enabled
                        and self.paid_spillover is not None
                        and attempts == 1
                        and remaining_ms >= self.spillover_min_remaining_ms
                    ):
                        try:
                            return await paid_result()
                        except SpilloverNotSubmitted as error:
                            if error.code in ("BUDGET_EXCEEDED", "BUDGET_NOT_INITIALIZED"):
                                self.spillover_enabled = False
                                set_available(False)
                            retry_local_after_refusal = True
                    if capacity and (self.cluster_mode or retry_local_after_refusal):
                        delay = min(random.uniform(0.25, 1), remaining_ms / 1000)
                        if delay <= 0:
                            raise ProviderError(timeout_code)
                        if signal is None:
                            await asyncio.sleep(delay)
                        else:
                            try:
                                await asyncio.wait_for(signal.wait(), timeout=delay)
                            except TimeoutError:
                                pass
                        continue
                    raise
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
            cost = 0
            return success(
                {"text": checked_text(raw.content), "usage": usage, "upstream": upstream}
            )
        except BaseException as error:
            cause = error
            for _ in range(8):
                if isinstance(cause, ProviderError):
                    transport_error_code = cause.code
                    break
                if isinstance(cause, httpx.TimeoutException):
                    transport_error_code = "PROVIDER_TIMEOUT"
                    break
                nested = cause.__cause__ or cause.__context__
                if nested is None:
                    break
                cause = nested
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
            try:
                if lease_id is not None:
                    assert self.local_slots is not None
                    try:
                        await asyncio.shield(self.local_slots.release(lease_id))
                    except Exception:
                        logger.warning("LOCAL_SLOT_UNAVAILABLE")
            finally:
                self._hook_context.reset(token)
                self._active.discard(task)
