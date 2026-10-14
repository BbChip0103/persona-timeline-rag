"Pinned OpenRouter/Jev decisions adapter with the migrated shared paid ledger."

from __future__ import annotations

import asyncio
import json
import logging
import math
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from http.cookiejar import Cookie, CookieJar, DefaultCookiePolicy
from typing import Any
from urllib.parse import urlsplit

from langchain_openai import OpenAIEmbeddings
from pydantic import SecretStr

from ptr_llm.billing import ProviderError, provider_request_scope
from ptr_llm.config import _svc_host

from .common import (
    bounded,
    check_cancel,
    checked_messages,
    count,
    fingerprint,
    js_json,
)
from .control_tokens import neutralize_json_strings, neutralize_messages

logger = logging.getLogger(__name__)

DEFAULT_TEXT_MODEL = "google/gemini-3-flash-preview"
DEFAULT_JEV_MODEL = "typesafe/jev-1.13"
EMBEDDING_MODEL = "openai/text-embedding-3-small"
EMBEDDING_DIMENSIONS = 1536
TEXT_MODELS: dict[str, dict[str, Any]] = {
    DEFAULT_TEXT_MODEL: {"prompt": 0.5, "completion": 3, "reasoning": {"effort": "minimal"}},
    "google/gemini-2.5-flash-lite": {
        "prompt": 0.1,
        "completion": 0.4,
        "reasoning": {"enabled": False},
    },
    "openai/gpt-4.1-nano": {"prompt": 0.1, "completion": 0.4},
    "google/gemma-4-26b-a4b-it": {
        "prompt": 0.1,
        "completion": 0.5,
        "reasoning": {"enabled": False},
        "agentSchema": True,
    },
}


class _NoCookies(DefaultCookiePolicy):
    """Pooling must not introduce cross-request provider cookie state."""

    def set_ok(self, cookie: Cookie, request: Any) -> bool:
        return False

    def return_ok(self, cookie: Cookie, request: Any) -> bool:
        return False


async def _drain(task: asyncio.Task[Any]) -> bool:
    """Drain owned cleanup even after a second cancellation; report caller cancellation."""
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    task.result()  # Consume/propagate cleanup failure; never leave a late error unobserved.
    return cancelled


def _embedding_input_size(inputs: list[str], limit: int, signal: asyncio.Event | None) -> int:
    """Reject an entire batch before SDK chunking or any metered operation."""
    check_cancel(signal)
    if (
        not isinstance(inputs, list)
        or not 1 <= len(inputs) <= 32
        or any(not isinstance(value, str) or not value.strip() for value in inputs)
    ):
        raise ProviderError("INVALID_INPUT")
    size = len(js_json(inputs).encode())
    if size > limit:
        raise ProviderError("INPUT_LIMIT")
    return size


def reported_cost(result: dict[str, Any]) -> int | None:
    value: Any = (
        (result.get("usage") or {}).get("cost") if isinstance(result.get("usage"), dict) else None
    )
    return (
        math.ceil(value * 1_000_000)
        if type(value) in (int, float)
        and math.isfinite(value)
        and value >= 0
        and math.ceil(value * 1_000_000) <= 2**53 - 1
        else None
    )


class _CleanProviderHTTPError(ProviderError):
    pass


class OpenRouterClient:
    def __init__(
        self,
        *,
        api_key: str,
        ledger: Any,
        live_enabled: bool = False,
        allow_external_data: bool = False,
        text_model: str = DEFAULT_TEXT_MODEL,
        max_output_tokens: int = 512,
        input_bytes: int = 32768,
        timeout_ms: int = 30000,
        decision_reserved_call_fraction: float = 0.2,
        transport: Any = None,
        base_url_override: str | None = None,
        fixture_enabled: bool = False,
        cluster_mode: bool = False,
        on_zdr_unavailable: Callable[[], None] | None = None,
    ):
        import httpx

        if not live_enabled or not allow_external_data or not api_key.strip():
            raise ProviderError("LIVE_DISABLED")
        if text_model not in TEXT_MODELS:
            raise ProviderError("MODEL_NOT_ALLOWED")
        if (
            any(type(x) is not int or x < 1 for x in (max_output_tokens, input_bytes, timeout_ms))
            or not 0 <= decision_reserved_call_fraction <= 1
        ):
            raise ProviderError("INVALID_LIMIT")
        self.base_url = "https://openrouter.ai"
        if base_url_override is not None:
            try:
                parsed = urlsplit(base_url_override)
                _ = parsed.port
            except (TypeError, ValueError):
                raise ProviderError("OPENROUTER_URL_NOT_ALLOWED") from None
            if not (
                fixture_enabled
                and cluster_mode
                and parsed.scheme in ("http", "https")
                and _svc_host(parsed.hostname)
                and not parsed.username
                and not parsed.password
                and parsed.path in ("", "/")
                and not parsed.query
                and not parsed.fragment
            ):
                raise ProviderError("OPENROUTER_URL_NOT_ALLOWED")
            self.base_url = base_url_override.rstrip("/")
        self.api_key, self.ledger, self.model = api_key, ledger, text_model
        self.max_output_tokens, self.input_bytes, self.timeout_ms = (
            max_output_tokens,
            input_bytes,
            timeout_ms,
        )
        self.decision_reserved_call_fraction, self.transport = (
            decision_reserved_call_fraction,
            transport,
        )
        self._text_verified = False
        self._decisions_verified: set[str] = set()
        self._chat_zdr_available = True
        self.on_zdr_unavailable = on_zdr_unavailable
        self.structured_outputs = False
        self.ssl_context = (
            httpx.create_ssl_context(verify=True, trust_env=True) if transport is None else None
        )
        self._http_client: httpx.AsyncClient | None = None
        self._closed = False
        self._closing: asyncio.Task[None] | None = None
        self._active: set[asyncio.Task[Any]] = set()
        self._owner: ContextVar[asyncio.Task[Any] | None] = ContextVar(
            "openrouter_operation", default=None
        )
        self._chat: Any = None

    async def _owned(self, operation: Callable[[], Awaitable[Any]]) -> Any:
        if self._closed:
            raise ProviderError("PROVIDER_CLOSED")
        if self._owner.get() in self._active:
            return await operation()

        async def run() -> Any:
            token = self._owner.set(asyncio.current_task())
            try:
                return await operation()
            finally:
                self._owner.reset(token)

        task = asyncio.create_task(run())
        self._active.add(task)
        try:
            return await task
        finally:
            self._active.discard(task)

    async def aclose(self) -> None:
        """Stop new work, drain cancellation/receipt settlement, then close the pool."""
        if self._closing is None:
            self._closed = True

            async def close() -> None:
                tasks = tuple(self._active)
                for task in tasks:
                    if not task.done() and not task.cancelling():
                        task.cancel()
                try:
                    await asyncio.gather(*tasks, return_exceptions=True)
                finally:
                    if self._http_client is not None:
                        await self._http_client.aclose()

            self._closing = asyncio.create_task(close())
        # Cancellation of one shutdown waiter must not interrupt shared cleanup.
        if await _drain(self._closing):
            raise asyncio.CancelledError

    async def _fetch(
        self,
        path: str,
        *,
        body: dict[str, Any] | None = None,
        signal: asyncio.Event | None = None,
        authenticated: bool = False,
        deadline_at: float | None = None,
    ) -> dict[str, Any]:
        return await self._owned(
            lambda: self._fetch_response(
                path,
                body=body,
                signal=signal,
                authenticated=authenticated,
                deadline_at=deadline_at,
            )
        )

    async def _fetch_response(
        self,
        path: str,
        *,
        body: dict[str, Any] | None,
        signal: asyncio.Event | None,
        authenticated: bool,
        deadline_at: float | None,
    ) -> dict[str, Any]:
        import httpx

        from .transport import LimitedTransport

        check_cancel(signal)
        url = f"{self.base_url}{path}"
        headers = (
            {"Authorization": f"Bearer {self.api_key}"} if body is not None or authenticated else {}
        )
        if body is not None:
            headers["Content-Type"] = "application/json"

        async def run() -> dict[str, Any]:
            import time

            if body is not None and deadline_at is not None and time.time() * 1000 >= deadline_at:
                raise ProviderError("PROVIDER_DEADLINE")
            if self._http_client is None:
                self._http_client = httpx.AsyncClient(
                    transport=LimitedTransport(self.transport, self.ssl_context),
                    follow_redirects=False,
                    timeout=self.timeout_ms / 1000,
                    cookies=CookieJar(policy=_NoCookies()),
                )
            async with self._http_client.stream(
                "POST" if body is not None else "GET",
                url,
                headers=headers,
                content=js_json(body).encode() if body is not None else None,
            ) as response:
                if int(response.headers.get("content-length", "0")) > 2 * 1024 * 1024:
                    raise ProviderError("PROVIDER_RESPONSE_LIMIT")
                chunks = bytearray()
                async for chunk in response.aiter_bytes():
                    check_cancel(signal)
                    chunks.extend(chunk)
                    if len(chunks) > 2 * 1024 * 1024:
                        raise ProviderError("PROVIDER_RESPONSE_LIMIT")
                import json

                try:
                    result = json.loads(chunks)
                except (ValueError, TypeError):
                    if not response.is_success:
                        raise ProviderError(f"PROVIDER_HTTP_{response.status_code}") from None
                    raise
                if not isinstance(result, dict):
                    if not response.is_success:
                        raise ProviderError(f"PROVIDER_HTTP_{response.status_code}")
                    raise ProviderError("INVALID_PROVIDER_RESPONSE")
                if not response.is_success:
                    code = f"PROVIDER_HTTP_{response.status_code}"
                    if (
                        400 <= response.status_code < 500
                        and not isinstance(result.get("id"), str)
                        and reported_cost(result) == 0
                    ):
                        raise _CleanProviderHTTPError(code)
                    raise ProviderError(code)
                return result

        try:
            return await bounded(run(), timeout=self.timeout_ms / 1000, signal=signal)
        except ProviderError:
            raise
        except asyncio.CancelledError:
            raise
        except (ValueError, TypeError):
            raise ProviderError("INVALID_PROVIDER_RESPONSE") from None
        except Exception:
            raise ProviderError("PROVIDER_TRANSPORT") from None

    async def verify_pricing(self, signal: asyncio.Event | None = None) -> None:
        await self._owned(lambda: self._verify_pricing(signal))

    async def verify_key_limit(self, max_limit_usd: float) -> bool:
        """Return false on provider outages; reject a real uncapped paid key."""
        if (
            type(max_limit_usd) not in (int, float)
            or not math.isfinite(max_limit_usd)
            or max_limit_usd <= 0
        ):
            raise ProviderError("INVALID_LIMIT")
        try:
            result = await self._fetch("/api/v1/key", authenticated=True)
        except ProviderError as error:
            if error.code == "PROVIDER_CLOSED":
                raise
            return False
        data = result.get("data")
        raw_limit = data.get("limit") if isinstance(data, dict) else None
        raw_reset = data.get("limit_reset") if isinstance(data, dict) else None
        if (
            not isinstance(data, dict)
            or "limit_reset" not in data
            or not isinstance(raw_limit, (int, float))
            or isinstance(raw_limit, bool)
            or raw_reset is not None
        ):
            raise ProviderError("OPENROUTER_KEY_LIMIT")
        # OpenRouter reports key caps in credits; this research budget treats one credit as USD 1.
        limit = float(raw_limit)
        if not math.isfinite(limit) or limit < 0 or limit > max_limit_usd:
            raise ProviderError("OPENROUTER_KEY_LIMIT")
        return True

    async def _verify_pricing(self, signal: asyncio.Event | None = None) -> None:
        if self._text_verified:
            return
        catalog = await self._fetch("/api/v1/models", signal=signal)
        embeddings = await self._fetch("/api/v1/embeddings/models", signal=signal)
        policy = TEXT_MODELS[self.model]
        for rows, model, prompt, completion in (
            (catalog, self.model, policy["prompt"] * 1e-6, policy["completion"] * 1e-6),
            (embeddings, EMBEDDING_MODEL, 0.00000002, 0),
        ):
            data = rows.get("data")
            metadata = (
                next((m for m in data if isinstance(m, dict) and m.get("id") == model), None)
                if isinstance(data, list)
                else None
            )
            if (
                metadata is None
                or not isinstance(metadata.get("pricing"), dict)
                or not {"prompt", "completion"} <= metadata["pricing"].keys()
            ):
                raise ProviderError("PRICING_UNVERIFIED")
            if metadata.get("reasoning", {}).get("mandatory") is True:
                raise ProviderError("MANDATORY_REASONING_NOT_ALLOWED")
            if model == self.model:
                self.structured_outputs = "structured_outputs" in metadata.get(
                    "supported_parameters", []
                )
            for key, value in metadata["pricing"].items():
                try:
                    amount = float(value)
                except (TypeError, ValueError):
                    raise ProviderError("PRICING_CHANGED_OR_UNKNOWN_FEE") from None
                disabled = completion > 0 and key in (
                    "image",
                    "audio",
                    "input_audio_cache",
                    "web_search",
                )
                limit = (
                    prompt
                    if key in ("prompt", "input_cache_read", "input_cache_write")
                    else completion
                    if key in ("completion", "internal_reasoning")
                    else 0
                )
                pinned_gemma_catalog = model == self.model == "google/gemma-4-26b-a4b-it"
                if (
                    not math.isfinite(amount)
                    or amount < 0
                    or not pinned_gemma_catalog and not disabled and amount > limit
                ):
                    raise ProviderError("PRICING_CHANGED_OR_UNKNOWN_FEE")
        if self.model == "google/gemma-4-26b-a4b-it":
            data = catalog.get("data")
            metadata = next(
                (m for m in data if isinstance(m, dict) and m.get("id") == self.model),
                None,
            ) if isinstance(data, list) else None
            endpoints = metadata.get("endpoints") if isinstance(metadata, dict) else None
            if not isinstance(endpoints, list) or not endpoints:
                endpoint_data = await self._fetch(
                    f"/api/v1/models/{self.model}/endpoints", signal=signal
                )
                endpoint_rows = endpoint_data.get("data")
                endpoints = (
                    endpoint_rows.get("endpoints") if isinstance(endpoint_rows, dict) else None
                )
            deepinfra_endpoints = (
                [
                    entry
                    for entry in endpoints
                    if isinstance(entry, dict) and entry.get("provider_name") == "DeepInfra"
                ]
                if isinstance(endpoints, list)
                else []
            )
            if not deepinfra_endpoints:
                raise ProviderError("PRICING_UNVERIFIED")
            deepinfra_tags: set[str] = set()
            for deepinfra in deepinfra_endpoints:
                tag = deepinfra.get("tag")
                pricing = deepinfra.get("pricing")
                if not isinstance(tag, str) or not tag or not isinstance(pricing, dict):
                    raise ProviderError("PRICING_UNVERIFIED")
                deepinfra_tags.add(tag)
                if "supported_parameters" in deepinfra:
                    supported = deepinfra["supported_parameters"]
                    self.structured_outputs = self.structured_outputs and (
                        isinstance(supported, list) and "structured_outputs" in supported
                    )
                if not {"prompt", "completion"} <= pricing.keys():
                    raise ProviderError("PRICING_UNVERIFIED")
                for key, value in pricing.items():
                    try:
                        amount = float(value)
                    except (TypeError, ValueError):
                        raise ProviderError("PRICING_UNVERIFIED") from None
                    cap = (
                        policy["prompt"] * 1e-6
                        if key in ("prompt", "input_cache_read", "input_cache_write")
                        else policy["completion"] * 1e-6
                        if key in ("completion", "internal_reasoning")
                        else 0
                    )
                    if not math.isfinite(amount) or amount < 0 or amount > cap:
                        raise ProviderError("PRICING_CHANGED_OR_UNKNOWN_FEE")
            try:
                zdr_result = await self._fetch(
                    "/api/v1/endpoints/zdr", signal=signal, authenticated=True
                )
            except ProviderError:
                raise ProviderError("PRICING_UNVERIFIED") from None
            zdr_rows = zdr_result.get("data")
            if not isinstance(zdr_rows, list):
                raise ProviderError("PRICING_UNVERIFIED")
            model_rows = [
                row for row in zdr_rows
                if isinstance(row, dict) and row.get("model_id") == self.model
            ]
            if not model_rows or any(
                any(
                    not isinstance(row.get(key), str) or not row[key]
                    for key in ("model_id", "provider_name", "tag")
                )
                for row in model_rows
            ):
                raise ProviderError("PRICING_UNVERIFIED")
            deepinfra_rows = [row for row in model_rows if row["provider_name"] == "DeepInfra"]
            zdr_available = bool(deepinfra_rows)
            if not zdr_available:
                logger.warning(
                    "OPENROUTER_ZDR_UNAVAILABLE endpoint_provider=%s endpoint_tags=%s "
                    "zdr_provider_tags=%s",
                    "DeepInfra",
                    sorted(deepinfra_tags),
                    sorted((row["provider_name"], row["tag"]) for row in model_rows),
                )
                if self.on_zdr_unavailable is not None:
                    self.on_zdr_unavailable()
            self._chat_zdr_available = zdr_available
        self._text_verified = True

    async def _verify_decision_pricing(self, model: str, signal: asyncio.Event | None) -> None:
        if model in self._decisions_verified:
            return
        result = await self._fetch(f"/api/v1/models/{model}/endpoints", signal=signal)
        endpoints = (result.get("data") or {}).get("endpoints")
        if not isinstance(endpoints, list) or not endpoints:
            raise ProviderError("PRICING_UNVERIFIED")
        for endpoint in endpoints:
            pricing = endpoint.get("pricing") if isinstance(endpoint, dict) else None
            if not isinstance(pricing, dict) or not {"prompt", "completion"} <= pricing.keys():
                raise ProviderError("PRICING_UNVERIFIED")
            for key, value in pricing.items():
                try:
                    amount = float(value)
                except (TypeError, ValueError):
                    raise ProviderError("PRICING_CHANGED_OR_UNKNOWN_FEE") from None
                if (
                    not math.isfinite(amount)
                    or amount < 0
                    or amount > (0.00000005 if key == "prompt" else 0)
                ):
                    raise ProviderError("PRICING_CHANGED_OR_UNKNOWN_FEE")
        self._decisions_verified.add(model)

    def _provider(self, embedding: bool = False) -> dict[str, Any]:
        policy = TEXT_MODELS[self.model]
        result = {
            "require_parameters": True,
            "data_collection": "deny",
            "allow_fallbacks": False,
            "max_price": {
                "prompt": 0.02 if embedding else policy["prompt"],
                "completion": 0 if embedding else policy["completion"],
                "request": 0,
            },
        }
        if embedding or self.model != "google/gemma-4-26b-a4b-it" or self._chat_zdr_available:
            result["zdr"] = True
        if not embedding and self.model == "google/gemma-4-26b-a4b-it":
            result["order"] = ["DeepInfra"]
        return result

    async def _request(
        self,
        body: dict[str, Any],
        endpoint: str,
        reservation: int,
        *,
        signal: asyncio.Event | None,
        request_key: str | None = None,
        deadline_at: float | None = None,
    ) -> dict[str, Any]:
        import time

        check_cancel(signal)
        if endpoint != "decisions":
            await self.verify_pricing(signal)
        key = fingerprint(
            {
                "endpoint": endpoint,
                "body": body,
                "schema": "goal1-provider-v1",
                **({"idempotencyKey": request_key} if request_key is not None else {}),
            }
        )
        created, saved = await self.ledger.reserve(
            key,
            reservation,
            scope=provider_request_scope(
                request_key, "decision" if endpoint == "decisions" else "chat"
            ),
            reserved_call_fraction=self.decision_reserved_call_fraction
            if endpoint == "decisions"
            else None,
        )
        if not created:
            if saved.response is not None:
                if not isinstance(saved.response, dict):
                    raise ProviderError("INVALID_PROVIDER_RESPONSE")
                if isinstance(saved.response.get("_provider_error_code"), str):
                    raise ProviderError(saved.response["_provider_error_code"])
                cost = reported_cost(saved.response)
                if saved.state == "unknown" and cost is not None:
                    await self.ledger.finish(key, cost, None, saved.generation_id)
                if cost is not None and cost > saved.reserved_microusd:
                    raise ProviderError("PROVIDER_COST_EXCEEDS_RESERVATION")
                return saved.response
            raise ProviderError("REQUEST_UNRESOLVED_NO_RESUBMIT")
        if signal is not None and signal.is_set():
            await self.ledger.finish(key, 0, None, None)
            check_cancel(signal)
        if deadline_at is not None and time.time() * 1000 >= deadline_at:
            await self.ledger.finish(key, 0, None, None)
            raise ProviderError("PROVIDER_DEADLINE")
        await self.ledger.submitted(key)
        try:
            if deadline_at is not None and time.time() * 1000 >= deadline_at:
                await self.ledger.finish(key, 0, None, None)
                raise ProviderError("PROVIDER_DEADLINE")
            result = await self._fetch(
                "/api/alpha/decisions" if endpoint == "decisions" else f"/api/v1/{endpoint}",
                body=body,
                signal=signal,
                deadline_at=deadline_at,
            )
            generation_id = result.get("id") if isinstance(result.get("id"), str) else None
            cost = reported_cost(result)
            await self.ledger.finish(key, cost, result, generation_id)
            if cost is not None and cost > reservation:
                raise ProviderError("PROVIDER_COST_EXCEEDS_RESERVATION")
            return result
        except _CleanProviderHTTPError as error:
            await _drain(
                asyncio.create_task(
                    self.ledger.finish(key, 0, {"_provider_error_code": error.code}, None)
                )
            )
            raise
        except BaseException:
            # Signal/deadline cancellation can race runtime shutdown. Shielding
            # alone permits a second cancellation to abandon the ledger write.
            await _drain(asyncio.create_task(self.ledger.finish(key, None, None, None)))
            raise

    async def generate(
        self,
        messages: list[dict[str, str]],
        *,
        signal: asyncio.Event | None = None,
        deadline_at: float | None = None,
        **options: Any,
    ) -> str:
        return await self._owned(
            lambda: self._deadline(
                self._generate(messages, signal=signal, deadline_at=deadline_at, **options),
                signal,
                deadline_at,
            )
        )

    async def decide(
        self,
        request: dict[str, Any],
        *,
        signal: asyncio.Event | None = None,
        deadline_at: float | None = None,
        **options: Any,
    ) -> dict[str, Any]:
        return await self._owned(
            lambda: self._deadline(
                self._decide(request, signal=signal, deadline_at=deadline_at, **options),
                signal,
                deadline_at,
            )
        )

    async def _deadline(
        self, operation: Any, signal: asyncio.Event | None, deadline_at: float | None
    ) -> Any:
        import time

        if deadline_at is not None and (
            type(deadline_at) not in (int, float) or not math.isfinite(deadline_at)
        ):
            operation.close()
            raise ProviderError("INVALID_INPUT")
        remaining = (
            (deadline_at - time.time() * 1000) / 1000
            if deadline_at is not None
            else self.timeout_ms / 1000
        )
        if remaining <= 0:
            operation.close()
            raise ProviderError("PROVIDER_DEADLINE")
        return await bounded(
            operation,
            timeout=min(remaining, self.timeout_ms / 1000),
            signal=signal,
            timeout_code="PROVIDER_DEADLINE"
            if deadline_at is not None and remaining <= self.timeout_ms / 1000
            else "PROVIDER_TIMEOUT",
        )

    async def _generate(
        self,
        messages: list[dict[str, str]],
        *,
        signal: asyncio.Event | None = None,
        request_key: str | None = None,
        on_usage: Any = None,
        on_served: Any = None,
        on_cost: Any = None,
        max_output_tokens: int | None = None,
        deadline_at: float | None = None,
        response_schema: dict[str, Any] | None = None,
        **_: Any,
    ) -> str:
        check_cancel(signal)
        checked_messages(messages, self.input_bytes)
        import time

        if deadline_at is not None and deadline_at <= time.time() * 1000:
            raise ProviderError("PROVIDER_DEADLINE")
        await self.verify_pricing(signal)
        agent = any(m["role"] == "system" and "AGENT_JSON_REPLY" in m["content"] for m in messages)
        if response_schema is not None:
            from jsonschema import Draft202012Validator

            if not agent or not isinstance(response_schema, dict):
                raise ProviderError("INVALID_INPUT")
            response_schema = neutralize_json_strings(response_schema)
            try:
                Draft202012Validator.check_schema(response_schema)
            except Exception:
                raise ProviderError("INVALID_INPUT") from None
        timeline = any(
            m["role"] == "system" and "TIMELINE_JSON_REPLY" in m["content"] for m in messages
        )
        policy = TEXT_MODELS[self.model]
        if response_schema is not None and not (
            policy.get("agentSchema") and self.structured_outputs
        ):
            raise ProviderError("STRUCTURED_OUTPUT_UNAVAILABLE")
        response_format = None
        if agent and policy.get("agentSchema") and self.structured_outputs:
            from ptr_llm.core.protocol import AGENT_RESPONSE_JSON_SCHEMA

            response_format = {
                "type": "json_schema",
                "json_schema": {
                    "name": "agent_reply",
                    "strict": True,
                    "schema": response_schema
                    if response_schema is not None
                    else AGENT_RESPONSE_JSON_SCHEMA,
                },
            }
        elif timeline:
            response_format = {"type": "json_object"}
        output = (
            min(max_output_tokens, self.max_output_tokens)
            if type(max_output_tokens) is int and max_output_tokens >= 1
            else self.max_output_tokens
        )
        body = {
            "model": self.model,
            "messages": neutralize_messages(messages),
            "max_tokens": output,
            "temperature": 0,
            "stream": False,
            "provider": self._provider(),
            **({"reasoning": policy["reasoning"]} if "reasoning" in policy else {}),
            **({"response_format": response_format} if response_format else {}),
        }
        # OpenRouter always returns usage.cost, so no deprecated usage include flag is sent.
        body_bytes = len(js_json(body).encode())
        if body_bytes > self.input_bytes:
            raise ProviderError("INPUT_LIMIT")
        reservation = math.ceil(
            (body_bytes + len(messages) * 64 + 2048) * 2 * policy["prompt"]
            + output * policy["completion"]
        )
        if self._chat is None:
            from .openrouter_chat import OpenRouterChat

            self._chat = OpenRouterChat(self)
        text, result = await self._chat.generate(
            body,
            reservation,
            signal=signal,
            request_key=request_key,
            deadline_at=deadline_at,
            on_cost=on_cost,
        )
        if response_schema is not None:
            from jsonschema import Draft202012Validator

            try:
                Draft202012Validator(response_schema).validate(json.loads(text))
            except Exception:
                raise ProviderError("INVALID_PROVIDER_RESPONSE") from None
        if on_usage and isinstance(result.get("usage"), dict):
            on_usage(
                {
                    "promptTokens": count(result["usage"].get("prompt_tokens")),
                    "completionTokens": count(result["usage"].get("completion_tokens")),
                }
            )
        if on_served:
            on_served("openrouter")
        return text

    async def _decide(
        self,
        request: dict[str, Any],
        *,
        signal: asyncio.Event | None = None,
        request_key: str | None = None,
        deadline_at: float | None = None,
    ) -> dict[str, Any]:
        check_cancel(signal)
        if request.get("model") != DEFAULT_JEV_MODEL:
            raise ProviderError("MODEL_NOT_ALLOWED")
        if not isinstance(request.get("questions"), dict) or not isinstance(
            request.get("state"), dict
        ):
            raise ProviderError("INVALID_INPUT")
        body = {
            "model": request["model"],
            "state": neutralize_json_strings(request["state"]),
            "questions": request["questions"],
            "provider": {
                "data_collection": "deny",
                "zdr": True,
                "allow_fallbacks": False,
                "max_price": {"prompt": "0.05", "completion": "0", "request": "0"},
            },
        }
        size = len(js_json(body).encode())
        if size > self.input_bytes:
            raise ProviderError("INPUT_LIMIT")
        await self._verify_decision_pricing(request["model"], signal)
        reservation = math.ceil((size + 1024 + 512 * max(1, len(request["questions"]))) * 0.05)
        result = await self._request(
            body,
            "decisions",
            reservation,
            signal=signal,
            request_key=request_key,
            deadline_at=deadline_at,
        )
        import re

        if not isinstance(result.get("model"), str) or not re.fullmatch(
            re.escape(request["model"]) + r"(?:-\d{8})?", result["model"]
        ):
            raise ProviderError("MODEL_MISMATCH")
        return result

    async def embed(
        self, inputs: list[str], *, signal: asyncio.Event | None = None
    ) -> list[list[float]]:
        return await self._owned(lambda: self._embed(inputs, signal=signal))

    async def _embed(
        self, inputs: list[str], *, signal: asyncio.Event | None = None
    ) -> list[list[float]]:
        size = _embedding_input_size(inputs, self.input_bytes, signal)
        body = {
            "model": EMBEDDING_MODEL,
            "input": inputs,
            "encoding_format": "float",
            "dimensions": EMBEDDING_DIMENSIONS,
            "provider": self._provider(True),
        }
        result = await self._request(
            body, "embeddings", math.ceil((size + len(inputs) * 64 + 1024) * 0.02), signal=signal
        )
        if (
            result.get("model") not in (EMBEDDING_MODEL, "text-embedding-3-small")
            or not isinstance(result.get("data"), list)
            or len(result["data"]) != len(inputs)
        ):
            raise ProviderError("INVALID_EMBEDDINGS")
        vectors: list[Any] = [None] * len(inputs)
        for item in result["data"]:
            index, vector = item.get("index"), item.get("embedding")
            if (
                type(index) is not int
                or not 0 <= index < len(inputs)
                or vectors[index] is not None
                or not isinstance(vector, list)
                or len(vector) != EMBEDDING_DIMENSIONS
                or any(type(v) not in (int, float) or not math.isfinite(v) for v in vector)
            ):
                raise ProviderError("INVALID_EMBEDDINGS")
            vectors[index] = vector
        return vectors

    async def reconcile(self, request_key: str, signal: asyncio.Event | None = None) -> None:
        await self._owned(lambda: self._reconcile(request_key, signal))

    async def _reconcile(self, request_key: str, signal: asyncio.Event | None = None) -> None:
        from urllib.parse import quote

        request = await self.ledger.get(request_key)
        if request is None or not request.generation_id:
            raise ProviderError("GENERATION_ID_UNAVAILABLE")
        result = await self._fetch(
            "/api/v1/generation?id=" + quote(request.generation_id, safe=""),
            signal=signal,
            authenticated=True,
        )
        cost: Any = (result.get("data") or {}).get("total_cost")
        if type(cost) not in (int, float) or not math.isfinite(cost) or cost < 0:
            raise ProviderError("COST_UNAVAILABLE")
        await self.ledger.finish(
            request_key, math.ceil(cost * 1_000_000), None, request.generation_id
        )


class _BlockedSyncEmbeddings:
    def create(self, *args: Any, **kwargs: Any) -> Any:
        raise ProviderError("ASYNC_EMBEDDINGS_REQUIRED")


class _MeteredAsyncEmbeddings:
    """SDK client boundary; billing, transport and response validation stay metered."""

    def __init__(self, client: OpenRouterClient, signal: ContextVar[asyncio.Event | None]):
        self.client, self.signal = client, signal

    async def create(
        self, *, input: list[str], model: str, dimensions: int, encoding_format: str
    ) -> dict[str, Any]:
        if (
            model != EMBEDDING_MODEL
            or dimensions != EMBEDDING_DIMENSIONS
            or encoding_format != "float"
        ):
            raise ProviderError("INVALID_INPUT")
        vectors = await self.client.embed(input, signal=self.signal.get())
        # OpenRouterClient has already validated model/dimensions/index uniqueness
        # and restored input order. The SDK consumes that ordered response.
        return {"data": [{"index": index, "embedding": v} for index, v in enumerate(vectors)]}


class OpenRouterEmbeddingProvider:
    """Native LangChain query/document orchestration over the paid client bridge."""

    model, dimensions = EMBEDDING_MODEL, EMBEDDING_DIMENSIONS

    def __init__(self, client: OpenRouterClient):
        self.client = client
        self._signal: ContextVar[asyncio.Event | None] = ContextVar(
            "openrouter_embedding_signal", default=None
        )
        self._embeddings = OpenAIEmbeddings(
            model=self.model,
            dimensions=self.dimensions,
            client=_BlockedSyncEmbeddings(),
            async_client=_MeteredAsyncEmbeddings(client, self._signal),
            api_key=SecretStr("metered-client-no-sdk-credentials"),
            openai_api_type=None,
            openai_proxy=None,
            chunk_size=32,
            max_retries=0,
            check_embedding_ctx_length=False,
            tiktoken_enabled=False,
            model_kwargs={"encoding_format": "float"},
        )

    async def embed(
        self, inputs: list[str], *, signal: asyncio.Event | None = None
    ) -> list[list[float]]:
        _embedding_input_size(inputs, self.client.input_bytes, signal)
        token = self._signal.set(signal)
        try:
            return await self._embeddings.aembed_documents(inputs)
        finally:
            self._signal.reset(token)

    async def aembed_query(
        self,
        text: str,
        *,
        signal: asyncio.Event | None = None,
        evidence_scope: str = "caption",
    ) -> list[float]:
        # Retrieval owns evidence-scope validation; it never becomes an API field.
        _embedding_input_size([text], self.client.input_bytes, signal)
        token = self._signal.set(signal)
        try:
            return await self._embeddings.aembed_query(text)
        finally:
            self._signal.reset(token)
