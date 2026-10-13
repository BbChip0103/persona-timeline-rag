"""One-use request authority issued only after the shared paid ledger commits.

This is not another budget ledger. Gateway checks the trusted worker's assertion
without receiving application DB credentials. Shared Redis consumes the nonce.
"""

import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass
from typing import Any

HEADER = "x-ptr-budget-authorization"
_FIELDS = (
    "model",
    "messages",
    "response_format",
    "max_completion_tokens",
    "max_tokens",
    "temperature",
    "stream",
    "n",
    "seed",
    "top_p",
    "logprobs",
    "top_logprobs",
    "stop",
    "frequency_penalty",
    "presence_penalty",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "reasoning",
    "provider",
    "modalities",
    "audio",
)


@dataclass(frozen=True)
class BudgetAuthority:
    nonce: str
    expires_ms: int
    reserved_microusd: int
    spillover_for_nonce: str | None = None


def spillover_nonce(original_nonce: str) -> str:
    if not re.fullmatch("[a-f0-9]{64}", original_nonce):
        raise ValueError("INVALID_BUDGET_AUTHORITY")
    return hashlib.sha256(("ptr-spillover-v1:" + original_nonce).encode()).hexdigest()


def _mac(body: dict[str, Any], key: str, grant: str) -> str:
    if not isinstance(key, str) or len(key.encode()) < 32:
        raise ValueError("INVALID_BUDGET_AUTHORITY")
    payload = {k: body[k] for k in _FIELDS if k in body}
    raw = json.dumps(
        payload, sort_keys=True, ensure_ascii=True, separators=(",", ":"), allow_nan=False
    )
    return hmac.new(
        key.encode(),
        ("POST /chat/completions capacity-spillover-v1\0" + grant + "\0" + raw).encode(),
        hashlib.sha256,
    ).hexdigest()


def sign_request(
    body: dict[str, Any],
    key: str,
    nonce: str,
    expires_ms: int,
    reserved: int,
    *,
    spillover_for_nonce: str | None = None,
) -> str:
    if (
        not re.fullmatch("[a-f0-9]{64}", nonce)
        or type(expires_ms) is not int
        or type(reserved) is not int
        or not 1 <= reserved <= 1000000
        or (
            spillover_for_nonce is not None
            and (
                not re.fullmatch("[a-f0-9]{64}", spillover_for_nonce)
                or spillover_for_nonce == nonce
            )
        )
    ):
        raise ValueError("INVALID_BUDGET_AUTHORITY")
    grant = (
        f"v1:{nonce}:{expires_ms}:{reserved}"
        if spillover_for_nonce is None
        else f"v1s:{nonce}:{expires_ms}:{reserved}:{spillover_for_nonce}"
    )
    return grant + ":" + _mac(body, key, grant)


def sign_spillover_request(
    body: dict[str, Any], key: str, original_nonce: str, expires_ms: int, reserved: int
) -> str:
    return sign_request(
        body,
        key,
        spillover_nonce(original_nonce),
        expires_ms,
        reserved,
        spillover_for_nonce=original_nonce,
    )


def verify_request_authority(
    body: dict[str, Any], header: str, key: str, *, now_ms: int | None = None
) -> BudgetAuthority:
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if not isinstance(header, str) or len(header) > 300:
        raise ValueError("INVALID_BUDGET_AUTHORITY")
    parts = header.split(":")
    if parts[0] == "v1":
        if len(parts) != 5:
            raise ValueError("INVALID_BUDGET_AUTHORITY")
        spillover_for_nonce = None
    elif parts[0] == "v1s":
        if len(parts) != 6:
            raise ValueError("INVALID_BUDGET_AUTHORITY")
        spillover_for_nonce = parts[4]
    else:
        raise ValueError("INVALID_BUDGET_AUTHORITY")
    try:
        nonce, expires, reserved = parts[1], int(parts[2]), int(parts[3])
        expected = sign_request(
            body,
            key,
            nonce,
            expires,
            reserved,
            spillover_for_nonce=spillover_for_nonce,
        )
        if not now_ms < expires <= now_ms + 30000 or not hmac.compare_digest(header, expected):
            raise ValueError()
    except (ValueError, TypeError, OverflowError):
        raise ValueError("INVALID_BUDGET_AUTHORITY") from None
    return BudgetAuthority(nonce, expires, reserved, spillover_for_nonce)


def verify_request(
    body: dict[str, Any], header: str, key: str, *, now_ms: int | None = None
) -> tuple[str, int, int]:
    authority = verify_request_authority(body, header, key, now_ms=now_ms)
    return authority.nonce, authority.expires_ms, authority.reserved_microusd
