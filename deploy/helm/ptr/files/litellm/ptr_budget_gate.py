"""K8s LiteLLM budget gate; no engine selection or fallback routing."""

from __future__ import annotations

import importlib.metadata
import math
import os
from typing import Any
from urllib.parse import urlsplit

from fastapi import HTTPException
from litellm.integrations.custom_logger import CustomLogger
from redis.asyncio import Redis

from persona_timeline_rag.gateway_budget import HEADER, spillover_nonce, verify_request_authority

LOCAL_MODEL = "primary"
LOCAL_ID = "local-pool"
PAID_MODEL = "openrouter-primary"
PINNED_VERSION = "1.104.2"
NONCE_TTL_SECONDS = 35
BUDGET = "_ptr_budget_authorized"
SPILLOVER = "_ptr_spillover_for_nonce"
_CLEAN_METADATA = (
    "_ptr_routing_reservation",
    "_ptr_routing_request",
    "_ptr_routing_deadline",
    "_ptr_routing_prefilled",
    BUDGET,
    SPILLOVER,
)
_GENERATION_OVERRIDES = (
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
_REQUEST_OVERRIDES = (
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


class NonceStore:
    def __init__(self) -> None:
        self._redis: Redis[Any] | None = None

    def _client(self) -> Redis[Any]:
        if self._redis is None:
            self._redis = Redis(
                host=os.environ.get("PTR_ROUTING_REDIS_HOST", "litellm-redis"),
                port=int(os.environ.get("PTR_ROUTING_REDIS_PORT", "6379")),
                password=os.environ.get("PTR_LITELLM_REDIS_PASSWORD"),
                decode_responses=True,
                socket_connect_timeout=1,
                socket_timeout=1,
            )
        return self._redis

    async def claim(self, nonce: str, ttl_seconds: int = NONCE_TTL_SECONDS) -> bool:
        return bool(
            await self._client().set(
                f"ptr-budget-gate-v1:{nonce}", "1", nx=True, ex=ttl_seconds
            )
        )

    async def claim_spillover(
        self, nonce: str, original_nonce: str, ttl_seconds: int = NONCE_TTL_SECONDS
    ) -> bool:
        if not await self._client().exists(f"ptr-budget-gate-v1:{original_nonce}"):
            return False
        return bool(
            await self._client().set(
                f"ptr-budget-gate-v1:spillover:{nonce}",
                original_nonce,
                nx=True,
                ex=ttl_seconds,
            )
        )


class BudgetGate(CustomLogger):
    def __init__(self, nonce_store: Any | None = None) -> None:
        super().__init__()
        if importlib.metadata.version("litellm") != PINNED_VERSION:
            raise RuntimeError("PTR_BUDGET_GATE_LITELLM_VERSION_REQUIRED")
        self.budget_key = os.environ.get("PTR_LLM_CAPACITY_SPILLOVER_KEY", "")
        if len(self.budget_key.encode()) < 32:
            raise RuntimeError("PTR_BUDGET_GATE_KEY_REQUIRED")
        self.nonce_store = nonce_store if nonce_store is not None else NonceStore()

    def _check_router_policy(self) -> None:
        from litellm.proxy.proxy_server import llm_router

        if llm_router is None:
            raise HTTPException(503, "PTR_BUDGET_GATE_ROUTER_REQUIRED")
        model_list = getattr(llm_router, "model_list", None)
        if not isinstance(model_list, list):
            raise HTTPException(503, "PTR_BUDGET_GATE_ROUTER_REQUIRED")
        local = [d for d in model_list if d.get("model_name") == LOCAL_MODEL]
        paid = [d for d in model_list if d.get("model_name") == PAID_MODEL]
        if (
            len(local) != 1
            or (local[0].get("model_info") or {}).get("id") != LOCAL_ID
            or len(paid) != 1
            or (paid[0].get("model_info") or {}).get("id") != PAID_MODEL
        ):
            raise HTTPException(503, "PTR_BUDGET_GATE_DEPLOYMENT_POLICY_REQUIRED")
        params = paid[0].get("litellm_params") or {}
        preferences = (params.get("extra_body") or {}).get("provider") or {}
        prices = preferences.get("max_price") or {}
        prompt_cap = prices.get("prompt")
        completion_cap = prices.get("completion")
        if (
            params.get("max_retries") != 0
            or not str(params.get("model", "")).startswith("openrouter/")
            or [str(v).lower() for v in preferences.get("order") or []] != ["deepinfra"]
            or preferences.get("allow_fallbacks") is not False
            or preferences.get("require_parameters") is not True
            or type(prompt_cap) not in (float, int)
            or type(completion_cap) not in (float, int)
            or not math.isfinite(prompt_cap)
            or not math.isfinite(completion_cap)
            or prompt_cap <= 0
            or completion_cap <= 0
            or prompt_cap > 0.1
            or completion_cap > 0.5
        ):
            raise HTTPException(503, "PTR_BUDGET_GATE_PAID_POLICY_REQUIRED")
    async def async_pre_call_hook(
        self,
        user_api_key_dict: Any,
        cache: Any,
        data: dict[str, Any],
        call_type: Any,
    ) -> Any:
        self._check_router_policy()
        for field in ("metadata", "litellm_metadata"):
            if isinstance(data.get(field), dict):
                for key in _CLEAN_METADATA:
                    data[field].pop(key, None)
        model = data.get("model")
        if model not in (LOCAL_MODEL, PAID_MODEL):
            raise HTTPException(403, "PTR_BUDGET_GATE_ROUTE_REJECTED")
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
            raise HTTPException(403, "PTR_BUDGET_GATE_CHAT_REQUIRED")
        has_generation_override = any(k in data for k in _GENERATION_OVERRIDES)
        has_request_override = any(k in data for k in _REQUEST_OVERRIDES)
        if has_generation_override or has_request_override:
            raise HTTPException(400, "PTR_BUDGET_GATE_REQUEST_OVERRIDE_REJECTED")
        try:
            authority = verify_request_authority(data, header, self.budget_key)
        except (ValueError, TypeError):
            raise HTTPException(403, "PTR_BUDGET_GATE_BUDGET_REQUIRED") from None
        if model == PAID_MODEL and not authority.spillover_for_nonce:
            raise HTTPException(403, "PTR_BUDGET_GATE_DIRECT_PAID_ALIAS_REJECTED")
        if model == LOCAL_MODEL and authority.spillover_for_nonce:
            raise HTTPException(400, "PTR_BUDGET_GATE_SPILLOVER_TARGET_REQUIRED")
        if (
            authority.spillover_for_nonce
            and authority.nonce != spillover_nonce(authority.spillover_for_nonce)
        ):
            raise HTTPException(403, "PTR_BUDGET_GATE_BUDGET_REQUIRED")
        try:
            if authority.spillover_for_nonce:
                claimed = await self.nonce_store.claim_spillover(
                    authority.nonce, authority.spillover_for_nonce, NONCE_TTL_SECONDS
                )
            else:
                claimed = await self.nonce_store.claim(authority.nonce, NONCE_TTL_SECONDS)
        except Exception:
            raise HTTPException(503, "PTR_BUDGET_GATE_STORE_UNAVAILABLE") from None
        if not claimed:
            raise HTTPException(409, "PTR_BUDGET_GATE_NO_RESUBMISSION")
        metadata = data.setdefault("metadata", {})
        if not isinstance(metadata, dict):
            raise HTTPException(400, "PTR_BUDGET_GATE_INVALID_METADATA")
        metadata[BUDGET] = True
        if authority.spillover_for_nonce:
            metadata[SPILLOVER] = authority.spillover_for_nonce
        data["num_retries"] = 0
        data["max_retries"] = 0
        data["disable_fallbacks"] = True
        data["timeout"] = 25
        return data


gate = BudgetGate()
