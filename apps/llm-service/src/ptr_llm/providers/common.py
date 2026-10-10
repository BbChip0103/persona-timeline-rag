"Cross-language request bytes and bounded, cancellation-aware transport helpers."

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
from collections.abc import Awaitable
from typing import Any

from ptr_llm.billing import ProviderError

_SURROGATES = re.compile(r"[\ud800-\udfff]")


def js_json(value: Any) -> str:
    "JSON.stringify-compatible domain JSON (finite numbers, ordered properties)."
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        # Well-formed JSON.stringify escapes lone UTF-16 surrogates, not normal Unicode.
        encoded = json.dumps(value, ensure_ascii=False)
        return _SURROGATES.sub(lambda match: f"\\u{ord(match.group()):04x}", encoded)
    if isinstance(value, (int, float)):
        if not math.isfinite(value):
            raise ProviderError("INVALID_INPUT")
        if value == 0:
            return "0"
        if isinstance(value, int):
            if abs(value) > 2**53 - 1:
                raise ProviderError("INVALID_INPUT")
            return str(value)
        text = repr(value).lower()
        if "e" not in text:
            return text.removesuffix(".0")
        mantissa, exponent_text = text.split("e")
        exponent = int(exponent_text)
        if -6 <= exponent < 21:
            from decimal import Decimal

            return (
                format(Decimal(text), "f").rstrip("0").rstrip(".")
                if exponent < 0
                else format(Decimal(text), "f").split(".")[0]
            )
        return f"{mantissa.removesuffix('.0')}e{'+' if exponent >= 0 else '-'}{abs(exponent)}"
    if isinstance(value, list):
        return "[" + ",".join(js_json(item) for item in value) + "]"
    if isinstance(value, dict) and all(isinstance(k, str) for k in value):
        # ECMAScript integer-index keys precede other properties regardless of insertion order.
        indexes = sorted(
            (k for k in value if re.fullmatch(r"0|[1-9][0-9]*", k) and int(k) < 2**32 - 1), key=int
        )
        keys = indexes + [k for k in value if k not in indexes]
        return "{" + ",".join(js_json(k) + ":" + js_json(value[k]) for k in keys) + "}"
    raise ProviderError("INVALID_INPUT")


def fingerprint(value: Any) -> str:
    return hashlib.sha256(js_json(value).encode("utf-8")).hexdigest()


def count(value: Any) -> int | None:
    return value if type(value) is int and 0 <= value <= 2**53 - 1 else None


def check_cancel(signal: asyncio.Event | None) -> None:
    if signal is not None and signal.is_set():
        raise ProviderError("CANCELLED")


async def bounded(
    awaitable: Awaitable[Any],
    *,
    timeout: float,
    signal: asyncio.Event | None = None,
    timeout_code: str = "PROVIDER_TIMEOUT",
) -> Any:
    """Cancellation actually cancels the SDK task; no abandoned paid call retry."""
    task = asyncio.ensure_future(awaitable)
    if timeout <= 0:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        raise ProviderError(timeout_code)
    watcher = asyncio.create_task(signal.wait()) if signal is not None else None
    try:
        check_cancel(signal)
        pending = {task} | ({watcher} if watcher is not None else set())
        done, _ = await asyncio.wait(
            pending, timeout=max(0, timeout), return_when=asyncio.FIRST_COMPLETED
        )
        if watcher is not None and watcher in done:
            raise ProviderError("CANCELLED")
        if task not in done:
            raise ProviderError(timeout_code)
        check_cancel(signal)
        return await task
    finally:
        for future in (task, watcher):
            if future is not None and not future.done():
                future.cancel()
        await asyncio.gather(*[f for f in (task, watcher) if f is not None], return_exceptions=True)


def checked_messages(messages: Any, input_bytes: int) -> list[dict[str, str]]:
    if (
        not isinstance(messages, list)
        or not 1 <= len(messages) <= 64
        or any(
            not isinstance(m, dict)
            or set(m) != {"role", "content"}
            or m["role"] not in ("system", "user", "assistant")
            or not isinstance(m["content"], str)
            for m in messages
        )
    ):
        raise ProviderError("INVALID_INPUT")
    if len(js_json(messages).encode("utf-8")) > input_bytes:
        raise ProviderError("INPUT_LIMIT")
    return messages


def checked_text(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or len(value.encode("utf-8")) > 65536:
        raise ProviderError("INVALID_PROVIDER_RESPONSE")
    return value
