"""Native ChatOpenAI with a request-local, metered OpenRouter client boundary.

The SDK owns message/result conversion and async chat invocation. Approved wire
policy, raw receipts, cost provenance and all paid transport remain project-owned.
No OpenAI SDK client, credentials, retries or response repair are introduced.
"""

from __future__ import annotations

import asyncio
from contextvars import ContextVar
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

from langchain_openai import ChatOpenAI
from pydantic import SecretStr

from ptr_llm.billing import ProviderError
from ptr_llm.core.langchain import private_ainvoke

from .common import checked_text, js_json


@dataclass
class _Request:
    body: dict[str, Any]
    reservation: int
    signal: asyncio.Event | None
    request_key: str | None
    deadline_at: float | None
    on_cost: Any
    result: dict[str, Any] | None = None


class _RawResponse:
    headers: dict[str, str] = {}

    def __init__(self, model: str, text: str):
        # Only validated standard chat data enters the SDK. In particular, its
        # stricter usage/error/role interpretation cannot change legacy receipts.
        self.response = {
            "model": model,
            "choices": [{"message": {"role": "assistant", "content": text}}],
            "usage": {},
        }

    def parse(self) -> dict[str, Any]:
        return self.response


class _BlockedSyncChat:
    def create(self, *args: Any, **kwargs: Any) -> Any:
        raise ProviderError("ASYNC_CHAT_REQUIRED")


class _MeteredChat:
    def __init__(self, client: Any, context: ContextVar[_Request | None]):
        self.client, self.context = client, context
        self.with_raw_response = self

    async def create(self, **payload: Any) -> _RawResponse:
        request = self.context.get()
        if request is None:
            raise ProviderError("INVALID_INPUT")
        expected = dict(request.body)
        expected["max_completion_tokens"] = expected.pop("max_tokens")
        if "response_format" in expected:
            expected.pop("stream")  # Native OpenAI parse branch removes this key.
        if payload != expected:
            raise ProviderError("INVALID_INPUT")
        # Restore the approved legacy wire shape/order from validated SDK input.
        messages = [{"role": m["role"], "content": m["content"]} for m in payload["messages"]]
        body = {
            "model": payload["model"],
            "messages": messages,
            "max_tokens": payload["max_completion_tokens"],
            "temperature": payload["temperature"],
            "stream": False,
            "provider": payload["provider"],
            **({"usage": payload["usage"]} if "usage" in payload else {}),
            **({"reasoning": payload["reasoning"]} if "reasoning" in payload else {}),
            **(
                {"response_format": payload["response_format"]}
                if "response_format" in payload
                else {}
            ),
        }
        # Dict equality alone accepts bool/int substitutions and reordered keys.
        # A native SDK upgrade must never silently change paid wire fingerprints.
        if js_json(body) != js_json(request.body):
            raise ProviderError("INVALID_INPUT")
        result = await self.client._request(
            body,
            "chat/completions",
            request.reservation,
            signal=request.signal,
            request_key=request.request_key,
            deadline_at=request.deadline_at,
        )
        request.result = result
        if request.on_cost:
            from .openrouter import reported_cost

            request.on_cost(reported_cost(result))
        if result.get("model", self.client.model) != self.client.model:
            raise ProviderError("MODEL_MISMATCH")
        if not isinstance(result.get("choices"), list) or len(result["choices"]) != 1:
            raise ProviderError("INVALID_PROVIDER_RESPONSE")
        text = checked_text((result["choices"][0].get("message") or {}).get("content"))
        return _RawResponse(self.client.model, text)

    async def parse(self, **payload: Any) -> _RawResponse:
        return await self.create(**payload)


class OpenRouterChat:
    def __init__(self, client: Any):
        self.context: ContextVar[_Request | None] = ContextVar("metered_chat", default=None)
        bridge = _MeteredChat(client, self.context)
        from .openrouter import TEXT_MODELS

        policy = TEXT_MODELS[client.model]
        self.sdk = ChatOpenAI(
            model=client.model,
            api_key=SecretStr("metered-bridge-no-sdk-credential"),
            base_url=client.base_url + "/api/v1",
            temperature=0,
            max_retries=0,
            streaming=False,
            stream_usage=False,
            cache=False,
            use_responses_api=False,
            reasoning=policy.get("reasoning"),
            client=_BlockedSyncChat(),
            async_client=bridge,
            root_async_client=SimpleNamespace(chat=SimpleNamespace(completions=bridge)),
            model_kwargs={"provider": client._provider()},
        )

    async def generate(
        self,
        body: dict[str, Any],
        reservation: int,
        *,
        signal: asyncio.Event | None,
        request_key: str | None,
        deadline_at: float | None,
        on_cost: Any,
    ) -> tuple[str, dict[str, Any]]:
        request = _Request(body, reservation, signal, request_key, deadline_at, on_cost)
        token = self.context.set(request)
        try:
            result = await private_ainvoke(
                self.sdk,
                body["messages"],
                max_tokens=body["max_tokens"],
                **(
                    {"response_format": body["response_format"]}
                    if "response_format" in body
                    else {}
                ),
            )
            if request.result is None:
                raise ProviderError("INVALID_PROVIDER_RESPONSE")
            return checked_text(result.content), request.result
        finally:
            self.context.reset(token)
