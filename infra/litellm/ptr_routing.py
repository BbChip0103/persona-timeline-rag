"""Pinned LiteLLM Proxy extension; no replacement HTTP gateway or model retries."""

from __future__ import annotations

import asyncio
import hashlib
import importlib.metadata
import json
import math
import os
import time
import uuid
from collections.abc import Mapping
from contextvars import ContextVar
from typing import Any, cast
from urllib.parse import urlsplit

import httpx
from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger
from litellm.router import CustomRoutingStrategyBase
from redis.asyncio import Redis
from routing_state import RoutingState
from routing_telemetry import metrics_url, parse_capacity_metrics

from persona_timeline_rag.gateway_budget import HEADER, verify_request

TOKEN = "_ptr_routing_reservation"
REQUEST = "_ptr_routing_request"
DEADLINE = "_ptr_routing_deadline"
PREFILLED = "_ptr_routing_prefilled"
BUDGET = "_ptr_budget_authorized"
SPILLOVER_MODEL = "openrouter-primary"
_native_filter_scope: ContextVar[bool] = ContextVar("ptr_native_filter_scope", default=False)
MODEL_GROUP = "primary"
PINNED_VERSION = "1.104.2"


def number(name: str, default: float, minimum: float, maximum: float) -> float:
    import math

    value = float(os.environ.get(name, str(default)))
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise ValueError("INVALID_ROUTING_CONFIG")
    return value


def candidate(deployment: dict[str, Any]) -> dict[str, Any]:
    info = deployment.get("model_info") or {}
    params = deployment.get("litellm_params") or {}
    settings = info.get("ptr_routing") or {}
    identity = json.dumps(
        [params.get("api_base"), params.get("model"), settings.get("epoch", "1")],
        separators=(",", ":"),
    )
    # Only the dedicated, nonbillable OpenAI-compatible engine pool participates.
    if (
        deployment.get("model_name") != MODEL_GROUP
        or not isinstance(info.get("id"), str)
        or not str(params.get("model", "")).startswith("openai/")
        or not params.get("api_base")
    ):
        raise ValueError("INVALID_ROUTING_ENGINE")
    metrics_url(params["api_base"])
    return {
        "id": info["id"],
        "identity": hashlib.sha256(identity.encode()).hexdigest(),
        "max_seqs": settings.get("max_seqs", 32),
        "weight": params.get("weight", 1),
        **{key: settings[key] for key in ("kv_capacity", "prefill_rate") if key in settings},
    }


def reservation(data: Mapping[str, Any], *, reserved_only: bool = False) -> str | None:
    carriers = [data, data.get("litellm_params") or {}]
    for carrier in carriers:
        if not isinstance(carrier, Mapping):
            continue
        for name in ("metadata", "litellm_metadata"):
            metadata = carrier.get(name)
            if not isinstance(metadata, Mapping):
                continue
            for key in (TOKEN,) if reserved_only else (TOKEN, REQUEST):
                value = metadata.get(key)
                if isinstance(value, str) and len(value) == 32:
                    return value
    return None


def deadline(data: Mapping[str, Any]) -> float:
    for carrier in (data, data.get("litellm_params") or {}):
        if not isinstance(carrier, Mapping):
            continue
        for name in ("metadata", "litellm_metadata"):
            metadata = carrier.get(name)
            if not isinstance(metadata, Mapping):
                continue
            value = metadata.get(DEADLINE)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                return value
    if reservation(data):
        raise HTTPException(503, "PTR_ROUTING_DEADLINE_REQUIRED")
    return time.monotonic() + 25


def has_generated_token(chunk: Any) -> bool:
    for choice in getattr(chunk, "choices", []):
        delta = getattr(choice, "delta", None)
        if delta is not None and (
            getattr(delta, "content", None)
            or getattr(delta, "tool_calls", None)
            or getattr(delta, "function_call", None)
            or getattr(delta, "reasoning_content", None)
        ):
            return True
    return False


class Strategy(CustomRoutingStrategyBase):
    def __init__(self, router: Any, owner: RoutingCallback):
        self.router, self.owner = router, owner
        # Bind class implementations, never capture a previous wrapper recursively.
        self.native_async = type(router).async_get_available_deployment.__get__(router)
        self.native_sync = type(router).get_available_deployment.__get__(router)
        self.native_call = type(router)._acompletion.__get__(router)

    async def bounded_acompletion(self, model: str, messages: Any, **kwargs: Any) -> Any:
        if model != MODEL_GROUP:
            return await self.native_call(model=model, messages=messages, **kwargs)
        # HTTP read timeouts do NOT bound total wall time. Keep initial response
        # and nonstream bodies bounded even if the upstream continually drips data.
        kwargs.setdefault("metadata", {}).setdefault(DEADLINE, time.monotonic() + 25)
        try:
            async with asyncio.timeout_at(deadline(kwargs)):
                return await self.native_call(model=model, messages=messages, **kwargs)
        except BaseException as error:
            await asyncio.shield(self.owner._release(kwargs, False))
            if isinstance(error, TimeoutError):
                raise HTTPException(504, "PTR_ROUTING_TOTAL_DEADLINE") from None
            raise

    def get_available_deployment(
        self,
        model: str,
        messages: Any = None,
        input: Any = None,
        specific_deployment: bool | None = False,
        request_kwargs: Any = None,
    ) -> Any:
        if model == MODEL_GROUP:
            raise HTTPException(503, "PTR_ROUTING_ASYNC_REQUIRED")
        return self.native_sync(
            model=model,
            messages=messages,
            input=input,
            specific_deployment=specific_deployment,
            request_kwargs=request_kwargs,
        )

    async def async_get_available_deployment(
        self,
        model: str,
        messages: Any = None,
        input: Any = None,
        specific_deployment: bool | None = False,
        request_kwargs: Any = None,
    ) -> Any:
        if request_kwargs is None:
            request_kwargs = {}
        if model != MODEL_GROUP:
            return await self.native_async(
                model=model,
                request_kwargs=request_kwargs,
                messages=messages,
                input=input,
                specific_deployment=specific_deployment,
            )
        if specific_deployment or input is not None or not isinstance(messages, list):
            raise HTTPException(400, "PTR_ROUTING_CHAT_POOL_REQUIRED")
        if reservation(request_kwargs, reserved_only=True):
            raise HTTPException(409, "PTR_ROUTING_NO_RESUBMISSION")
        until = time.monotonic() + self.owner.queue_timeout
        token = reservation(request_kwargs) or uuid.uuid4().hex
        while True:
            # Preserve native alias/team/health/cooldown/paused/TPM/tag/order filters.
            scope = _native_filter_scope.set(True)
            try:
                deployments = await self.router.async_get_healthy_deployments(
                    model=model,
                    # Native helpers pop internal order/retry-exclusion selectors.
                    # A credit wait must not lose those filters on the next pass.
                    request_kwargs=dict(request_kwargs),
                    messages=messages,
                    input=input,
                    specific_deployment=False,
                )
            finally:
                _native_filter_scope.reset(scope)
            if not isinstance(deployments, list):
                raise HTTPException(400, "PTR_ROUTING_CHAT_POOL_REQUIRED")
            try:
                chosen = await self.owner.state.select(
                    [candidate(d) for d in deployments],
                    messages,
                    request_kwargs.get("max_completion_tokens")
                    or request_kwargs.get("max_tokens")
                    or 512,
                    token,
                    options=self.owner.options,
                )
            except (ValueError, TypeError):
                raise HTTPException(503, "PTR_ROUTING_INVALID_STATE") from None
            except Exception:
                raise HTTPException(503, "PTR_ROUTING_STORE_UNAVAILABLE") from None
            if chosen is not None:
                selected = next(d for d in deployments if d["model_info"]["id"] == chosen)
                request_kwargs.setdefault("metadata", {})[TOKEN] = token
                try:
                    await self.router._async_override_selector_pre_call_check(
                        self.router.routing_strategy,
                        None,
                        selected,
                        None,
                    )
                except BaseException:
                    await self.owner.state.release(token, success=False)
                    raise
                return selected
            if self.owner.spillover:
                if not (request_kwargs.get("metadata") or {}).get(BUDGET):
                    raise HTTPException(403, "PTR_ROUTING_BUDGET_REQUIRED")
                # Native selection of the dedicated alias occurs BEFORE any model
                # submission. Never call another model after a transport failure.
                return await self.native_async(
                    model=SPILLOVER_MODEL,
                    messages=messages,
                    input=None,
                    specific_deployment=False,
                    request_kwargs=request_kwargs,
                )
            if time.monotonic() >= until:
                raise HTTPException(503, "PTR_ROUTING_NO_CREDIT")
            await asyncio.sleep(0.025)


class RoutingCallback(CustomLogger):
    def __init__(self, state: Any = None):
        super().__init__()
        if importlib.metadata.version("litellm") != PINNED_VERSION:
            raise RuntimeError("PTR_ROUTING_UNVALIDATED_LITELLM_VERSION")
        policy = os.environ.get("PTR_ROUTING_POLICY", "least_inflight")
        affinity = os.environ.get("PTR_ROUTING_AFFINITY", "on")
        if policy not in ("least_inflight", "scored") or affinity not in ("on", "off"):
            raise ValueError("INVALID_ROUTING_CONFIG")
        self.options: dict[str, Any] = {
            "policy": policy,
            "affinity": affinity == "on",
            "min_tokens": number("PTR_ROUTING_AFFINITY_MIN_TOKENS", 256, 1, 65536),
            "slack": number("PTR_ROUTING_AFFINITY_SLACK", 0.5, 0, 10),
            "telemetry_poll_s": number("PTR_ROUTING_METRICS_INTERVAL_S", 1, 0.1, 60),
            "lease_s": 35,
        }
        enabled = os.environ.get("PTR_ROUTING_CAPACITY_SPILLOVER", "0")
        if enabled not in ("0", "1"):
            raise ValueError("INVALID_ROUTING_CONFIG")
        self.spillover = enabled == "1"
        self.budget_key = os.environ.get("PTR_LLM_CAPACITY_SPILLOVER_KEY", "")
        if self.spillover and len(self.budget_key.encode()) < 32:
            raise ValueError("PTR_ROUTING_BUDGET_AUTHORITY_REQUIRED")
        self.options["allow_overloaded_idle"] = not self.spillover
        self.queue_timeout = number("PTR_ROUTING_QUEUE_TIMEOUT_S", 10, 0, 10)
        self.metrics_timeout = number("PTR_ROUTING_METRICS_TIMEOUT_S", 0.5, 0.1, 2)
        self._redis: Any = None
        if state is None:
            salt = os.environ.get("LITELLM_SALT_KEY", "")
            if len(salt) < 16:
                raise ValueError("PTR_ROUTING_SHARED_SALT_REQUIRED")
            self._redis = Redis(
                host=os.environ.get("PTR_ROUTING_REDIS_HOST", "litellm-redis"),
                port=int(os.environ.get("PTR_ROUTING_REDIS_PORT", "6379")),
                password=os.environ.get("PTR_LITELLM_REDIS_PASSWORD"),
                decode_responses=True,
                socket_connect_timeout=1,
                socket_timeout=1,
            )
            state = RoutingState(self._redis, namespace="ptr-routing-v1", salt=salt)
        self.state = state
        self._strategy: Strategy | None = None
        self._poll_task: Any = None
        self._router: Any = None

    def attach(self, router: Any) -> None:
        # These features alter model/payload selection before the native filters;
        # do not silently bypass them with this deliberately constrained adapter.
        if (
            router.routing_strategy != "simple-shuffle"
            or getattr(router, "_routing_groups", None)
            or getattr(router, "auto_routers", None)
            or getattr(router, "complexity_routers", None)
            or getattr(router, "quality_routers", None)
            or getattr(router, "adaptive_routers", None)
            or getattr(router, "routing_plugins", None)
        ):
            raise HTTPException(503, "PTR_ROUTING_INCOMPATIBLE_ROUTER_CONFIG")
        if self.spillover:
            paid = [d for d in router.model_list if d.get("model_name") == SPILLOVER_MODEL]
            if (
                len(paid) != 1
                or (paid[0].get("model_info") or {}).get("id") != SPILLOVER_MODEL
                or not str(paid[0]["litellm_params"].get("model", "")).startswith("openrouter/")
            ):
                raise HTTPException(503, "PTR_ROUTING_PAID_DEPLOYMENT_REQUIRED")
        if self.spillover:
            params = paid[0]["litellm_params"]
            preferences = (params.get("extra_body") or {}).get("provider") or {}
            prices = preferences.get("max_price") or {}
            if (
                params.get("max_retries") != 0
                or preferences.get("allow_fallbacks") is not False
                or preferences.get("require_parameters") is not True
                or len(preferences.get("order") or []) != 1
                or not all(
                    type(prices.get(k)) in (float, int)
                    and math.isfinite(prices[k])
                    and prices[k] > 0
                    for k in ("prompt", "completion")
                )
            ):
                raise HTTPException(503, "PTR_ROUTING_PAID_POLICY_REQUIRED")
        for deployment in router.model_list:
            if deployment.get("model_name") == MODEL_GROUP:
                item = candidate(deployment)
                if self.spillover and item["id"] not in ("primary", "secondary"):
                    raise HTTPException(503, "PTR_ROUTING_LOCAL_ID_REQUIRED")
        strategy = self._strategy
        if strategy is None or strategy.router is not router:
            strategy = Strategy(router, self)
            self._strategy = strategy
        assert strategy is not None
        # update_settings can reset custom methods on the SAME router instance.
        if getattr(router.async_get_available_deployment, "__self__", None) is not strategy:
            router.set_custom_routing_strategy(strategy)
        if getattr(router._acompletion, "__self__", None) is not strategy:
            router._acompletion = cast(Strategy, strategy).bounded_acompletion
        self._router = router

    async def async_pre_call_hook(
        self,
        user_api_key_dict: Any,
        cache: Any,
        data: dict[str, Any],
        call_type: Any,
    ) -> Any:
        from litellm.proxy.proxy_server import llm_router

        if llm_router is None:
            raise HTTPException(503, "PTR_ROUTING_ROUTER_REQUIRED")
        self.attach(llm_router)
        for field in ("metadata", "litellm_metadata"):
            if isinstance(data.get(field), dict):
                data[field].pop(TOKEN, None)
                data[field].pop(REQUEST, None)
                data[field].pop(DEADLINE, None)
                data[field].pop(PREFILLED, None)
                data[field].pop(BUDGET, None)
        expires = None
        if self.spillover and data.get("model") == SPILLOVER_MODEL:
            raise HTTPException(403, "PTR_ROUTING_DIRECT_PAID_ALIAS_REJECTED")
        if self.spillover and data.get("model") == MODEL_GROUP:
            original = data.get("proxy_server_request") or {}
            headers = original.get("headers") or {}
            header = headers.pop(HEADER, None)
            for name in ("extra_headers", "headers"):
                if isinstance(data.get(name), dict):
                    data[name].pop(HEADER, None)
            if (
                call_type not in ("completion", "acompletion")
                or urlsplit(original.get("url", "")).path
                not in ("/v1/chat/completions", "/chat/completions")
                or original.get("method", "POST") != "POST"
            ):
                raise HTTPException(400, "PTR_ROUTING_CHAT_REQUIRED")
            # These unsigned generation overrides cannot change a committed budget.
            if any(
                k in data
                for k in (
                    "n",
                    "tools",
                    "tool_choice",
                    "parallel_tool_calls",
                    "stop",
                    "frequency_penalty",
                    "presence_penalty",
                    "logit_bias",
                    "modalities",
                    "audio",
                    "provider",
                    "reasoning",
                )
            ):
                raise HTTPException(400, "PTR_ROUTING_REQUEST_OVERRIDE_REJECTED")
            try:
                nonce, expires, _ = verify_request(data, header, self.budget_key)
            except (ValueError, TypeError):
                raise HTTPException(403, "PTR_ROUTING_BUDGET_REQUIRED") from None
            try:
                claimed = await self.state.claim_budget(nonce)
            except Exception:
                raise HTTPException(503, "PTR_ROUTING_STORE_UNAVAILABLE") from None
            if not claimed:
                raise HTTPException(409, "PTR_ROUTING_NO_RESUBMISSION")
            data.setdefault("metadata", {})[BUDGET] = True
        if data.get("model") == MODEL_GROUP:
            # The pinned Proxy passes its async route name, unlike older docs.
            if call_type not in ("completion", "acompletion"):
                raise HTTPException(400, "PTR_ROUTING_CHAT_REQUIRED")
            forbidden = (
                "api_base",
                "base_url",
                "api_key",
                "specific_deployment",
                "silent_model",
                "fallbacks",
                "context_window_fallbacks",
                "content_policy_fallbacks",
                "extra_body",
                "model_list",
                "routing_strategy",
                "mock_response",
                "mock_testing_rate_limit_error",
                "headers",
            )
            if any(name in data for name in forbidden):
                raise HTTPException(400, "PTR_ROUTING_REQUEST_OVERRIDE_REJECTED")
            # Proxy keeps the original request metadata, while Router copies it.
            # Mint the same ledger ID and absolute deadline BEFORE that split.
            metadata = data.setdefault("metadata", {})
            if not isinstance(metadata, dict):
                raise HTTPException(400, "PTR_ROUTING_INVALID_METADATA")
            metadata[REQUEST] = uuid.uuid4().hex
            metadata[DEADLINE] = (
                time.monotonic() + min(25, (expires - time.time() * 1000) / 1000)
                if expires is not None
                else time.monotonic() + 25
            )
            data["num_retries"] = 0
            data["max_retries"] = 0
            data["disable_fallbacks"] = True
            data["timeout"] = 25
        if self._poll_task is None or self._poll_task.done():
            self._poll_task = asyncio.create_task(self._poll())
        return data

    async def async_filter_deployments(
        self,
        model: str,
        healthy_deployments: list[Any],
        messages: Any,
        request_kwargs: Any = None,
        parent_otel_span: Any = None,
    ) -> Any:
        # An endpoint can capture an older Router just before a concurrent reload.
        # If it has never been attached, reject rather than silently random-route
        # outside shared credit. Normal custom calls preserve all native filters.
        if model == MODEL_GROUP and not _native_filter_scope.get():
            raise HTTPException(503, "PTR_ROUTING_SELECTOR_REQUIRED")
        return healthy_deployments

    async def _poll(self) -> None:
        async with httpx.AsyncClient(
            timeout=self.metrics_timeout,
            follow_redirects=False,
            trust_env=False,
        ) as client:
            semaphore = asyncio.Semaphore(8)

            async def refresh(deployment: dict[str, Any]) -> None:
                async with semaphore:
                    try:
                        item = candidate(deployment)
                        params = deployment["litellm_params"]
                        key = params.get("api_key")
                        headers = {"Authorization": "Bearer " + key} if key else {}
                        async with asyncio.timeout(self.metrics_timeout):
                            async with client.stream(
                                "GET",
                                metrics_url(params["api_base"]),
                                headers=headers,
                            ) as response:
                                if response.status_code != 200:
                                    return
                                body = bytearray()
                                async for chunk in response.aiter_bytes():
                                    body.extend(chunk)
                                    if len(body) > 1024 * 1024:
                                        return
                        kv, waiting, start, running = parse_capacity_metrics(
                            body.decode("utf-8", "strict")
                        )
                        await self.state.update_telemetry(
                            item["id"],
                            kv,
                            waiting,
                            start,
                            identity=item["identity"],
                            running=running,
                        )
                    except Exception:
                        # Preserve previous good samples until stale. No URLs,
                        # credentials, payloads or exception bodies are logged.
                        return

            while True:
                if self._router is not None:
                    await asyncio.gather(
                        *[
                            refresh(d)
                            for d in self._router.model_list
                            if d.get("model_name") == MODEL_GROUP
                        ]
                    )
                await asyncio.sleep(self.options["telemetry_poll_s"])

    async def _release(self, data: Mapping[str, Any], success: bool) -> None:
        token = reservation(data)
        if token:
            try:
                await self.state.release(token, success=success)
            except Exception:
                # TTL sweep recovers this reservation; never resubmit a model.
                pass

    async def async_post_call_success_deployment_hook(
        self,
        request_data: dict[str, Any],
        response: Any,
        call_type: Any,
    ) -> Any:
        if not request_data.get("stream"):
            await self._release(request_data, True)
        return response

    async def async_post_call_streaming_deployment_hook(
        self,
        request_data: dict[str, Any],
        response_chunk: Any,
        call_type: Any,
    ) -> Any:
        token = reservation(request_data)
        if token and has_generated_token(response_chunk):
            metadata = next(
                (
                    carrier[name]
                    for carrier in (request_data, request_data.get("litellm_params") or {})
                    if isinstance(carrier, Mapping)
                    for name in ("metadata", "litellm_metadata")
                    if isinstance(carrier.get(name), dict)
                    and (carrier[name].get(TOKEN) or carrier[name].get(REQUEST)) == token
                ),
                None,
            )
            if metadata is None or metadata.get(PREFILLED):
                return response_chunk
            try:
                await self.state.prefilled(token)
                metadata[PREFILLED] = True
            except Exception:
                pass
        return response_chunk

    async def async_post_call_streaming_iterator_hook(
        self,
        user_api_key_dict: Any,
        response: Any,
        request_data: dict[str, Any],
    ) -> Any:
        if reservation(request_data) is None:
            async for item in response:
                yield item
            return
        completed = False
        try:
            # A stream can keep satisfying its per-read timeout indefinitely.
            # Bound the entire stream by the deadline minted before dispatch.
            until = deadline(request_data)
            iterator = response.__aiter__()
            while True:
                # Proxy keepalives may advance each chunk in a different Task.
                # Never keep a Task-bound timeout context open across yield.
                # Expired timeouts schedule cancellation; immediate buffered
                # chunks can exit the context before that cancellation runs.
                if time.monotonic() >= until:
                    raise TimeoutError("PTR_ROUTING_TOTAL_DEADLINE")
                async with asyncio.timeout_at(until):
                    try:
                        item = await anext(iterator)
                    except StopAsyncIteration:
                        completed = True
                        break
                    # ProxyLogging is the canonical Proxy streaming boundary;
                    # SDK deployment hooks do not cover every Proxy callback path.
                    # Do not rely on their registration/metadata for prefill.
                    await self.async_post_call_streaming_deployment_hook(request_data, item, None)
                if time.monotonic() >= until:
                    raise TimeoutError("PTR_ROUTING_TOTAL_DEADLINE")
                yield item
        finally:
            try:
                if hasattr(response, "aclose"):
                    await asyncio.shield(response.aclose())
            finally:
                await asyncio.shield(self._release(request_data, completed))

    async def async_log_success_event(
        self,
        kwargs: dict[str, Any],
        response_obj: Any,
        start_time: Any,
        end_time: Any,
    ) -> None:
        await self._release(kwargs, True)

    async def async_log_failure_event(
        self,
        kwargs: dict[str, Any],
        response_obj: Any,
        start_time: Any,
        end_time: Any,
    ) -> None:
        await self._release(kwargs, False)

    async def async_post_call_failure_deployment_hook(
        self,
        request_data: Mapping[str, Any],
        exception: Any,
        call_type: Any,
        fallback_depth: Any = None,
    ) -> None:
        await self._release(request_data, False)

    async def async_post_call_success_hook(
        self,
        data: dict[str, Any],
        user_api_key_dict: Any,
        response: Any,
    ) -> Any:
        await self._release(data, True)
        return response

    async def async_post_call_failure_hook(
        self,
        request_data: dict[str, Any],
        original_exception: Any,
        user_api_key_dict: Any,
        traceback_str: Any = None,
    ) -> None:
        await self._release(request_data, False)

    async def aclose(self) -> None:
        if self._poll_task:
            self._poll_task.cancel()
            await asyncio.gather(self._poll_task, return_exceptions=True)
        if self._redis is not None:
            await self._redis.aclose()


router = RoutingCallback()
