"""Backend-owned execution control; HTTP transport errors never expose bodies."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx


@lru_cache(maxsize=1)
def _wire_module() -> Any:
    configured = os.environ.get("PTR_LLM_CONTRACTS_DIR")
    directory = (
        Path(configured) if configured else Path(__file__).resolve().parents[4] / "contracts/llm/v1"
    )
    path = directory / "models.py"
    if not path.is_file():
        raise ControlRejected()
    spec = importlib.util.spec_from_file_location("ptr_llm_shared_wire_v1", path)
    if spec is None or spec.loader is None:
        raise ControlRejected()
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def validate_wire(name: str, value: Any) -> dict[str, Any]:
    try:
        return _wire_module().validate_wire(name, value)
    except (ValueError, TypeError, KeyError):
        raise ControlRejected() from None


class ControlUnavailable(RuntimeError):
    def __init__(self) -> None:
        super().__init__("CONTROL_UNAVAILABLE")


class ControlRejected(RuntimeError):
    def __init__(self) -> None:
        super().__init__("CONTROL_REJECTED")


class ControlClient:
    def __init__(
        self,
        base_url: str,
        token: str,
        *,
        timeout: float = 1.0,
        client: httpx.AsyncClient | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self._token = token
        self.timeout = timeout
        self._client = client or httpx.AsyncClient(
            timeout=timeout, follow_redirects=False, trust_env=False
        )
        self._owns_client = client is None

    async def close(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _post(self, action: str, body: dict[str, Any]) -> dict[str, Any]:
        request_names = {
            "start": "StartRequest",
            "status": "StatusRequest",
            "complete": "CompleteRequest",
            "progress": "ProgressRequest",
        }
        response_names = {
            "start": "StartResponse",
            "status": "StatusResponse",
            "complete": "CompleteResponse",
            "progress": "ProgressResponse",
        }
        validate_wire(request_names[action], body)
        try:
            async with asyncio.timeout(self.timeout):
                async with self._client.stream(
                    "POST",
                    f"{self.base_url}/internal/llm/{action}",
                    json=body,
                    headers={"Authorization": f"Bearer {self._token}"},
                    timeout=self.timeout,
                ) as response:
                    if response.status_code >= 500 or response.status_code in {408, 429}:
                        raise ControlUnavailable()
                    if response.status_code != 200:
                        raise ControlRejected()
                    raw = bytearray()
                    async for chunk in response.aiter_bytes():
                        raw.extend(chunk)
                        if len(raw) > 8 * 1024 * 1024:
                            raise ControlRejected()
                decoded = json.loads(raw)
                if not isinstance(decoded, dict) or decoded.get("contractVersion") != 1:
                    raise ControlRejected()
                return (
                    validate_wire(response_names[action], decoded)
                    if action in response_names
                    else decoded
                )
        except (httpx.HTTPError, OSError, TimeoutError):
            raise ControlUnavailable() from None
        except (ValueError, UnicodeError):
            raise ControlRejected() from None

    async def start(self, body: dict[str, Any]) -> dict[str, Any]:
        result = await self._post("start", body)
        if result.get("status") not in {"granted", "lost", "cancelled"}:
            raise ControlRejected()
        if result["status"] == "granted" and not isinstance(result.get("grant"), dict):
            raise ControlRejected()
        return result

    async def status(self, binding: dict[str, Any]) -> dict[str, Any]:
        result = await self._post("status", binding)
        if result.get("status") not in {"current", "lost", "cancelled"}:
            raise ControlRejected()
        return result

    async def complete(self, binding: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        response = await self._post("complete", {**binding, "result": result})
        if response.get("status") not in {"applied", "alreadyApplied", "lost", "cancelled"}:
            raise ControlRejected()
        return response

    async def progress(self, binding: dict[str, Any], state: str) -> None:
        if state not in {"retrieving", "generating", "validating"}:
            raise ControlRejected()
        await self._post("progress", {**binding, "state": state})
