"Shared paid ledger: stable content keys, no retry of ambiguous submissions."

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Any

EXTRA_CAP_MICROUSD = 1_000_000
MAX_TOTAL_MICROUSD = 2_000_000
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class ProviderError(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(code)


def provider_request_scope(request_key: str | None, kind: str) -> dict[str, str] | None:
    if not request_key:
        return None
    if re.fullmatch(r"draft:[^\r\n]{1,400}", request_key):
        return {"kind": "draft"}
    turn_id = re.sub(r"#w\d+$", "", request_key) if kind == "decision" else request_key
    return {"kind": kind, "turnId": turn_id} if _UUID.fullmatch(turn_id) else None


@dataclass
class BudgetRequest:
    key: str
    state: str
    reserved_microusd: int
    actual_microusd: int | None = None
    response: Any = None
    generation_id: str | None = None
    scope: dict[str, str] | None = None
    receipt_scrubbed_at: Any = None


def committed(request: BudgetRequest) -> int:
    return (
        (
            request.actual_microusd
            if request.actual_microusd is not None
            else request.reserved_microusd
        )
        if request.state == "settled"
        else max(request.reserved_microusd, request.actual_microusd or 0)
    )


def validate_reservation(amount: int, scope: dict[str, str] | None, fraction: float | None) -> None:
    if type(amount) is not int or not 1 <= amount <= MAX_TOTAL_MICROUSD:
        raise ProviderError("BUDGET_EXCEEDED")
    if fraction is not None and (type(fraction) not in (float, int) or not 0 <= fraction <= 1):
        raise ProviderError("INVALID_LIMIT")
    if scope and (
        scope.get("kind") not in ("chat", "decision", "draft", "embedding")
        or scope.get("turnId") is not None
        and not _UUID.fullmatch(scope["turnId"])
        or scope.get("kind") in ("chat", "decision")
        and not scope.get("turnId")
        or scope.get("kind") == "draft"
        and scope.get("turnId") is not None
    ):
        raise ProviderError("INVALID_REQUEST_SCOPE")


class MemoryBudgetLedger:
    """Synthetic test ledger only; never selected for billable production mode."""

    def __init__(
        self,
        *,
        cap_microusd: int = MAX_TOTAL_MICROUSD,
        call_cap: int = 10000,
        baseline_committed_microusd: int = 0,
    ):
        self.cap_microusd = min(cap_microusd, MAX_TOTAL_MICROUSD)
        self.call_cap = call_cap
        self.baseline_committed_microusd = baseline_committed_microusd
        self.requests: dict[str, BudgetRequest] = {}
        self._lock = asyncio.Lock()

    async def reserve(
        self,
        key: str,
        amount_microusd: int,
        *,
        scope: dict[str, str] | None = None,
        reserved_call_fraction: float | None = None,
    ) -> tuple[bool, BudgetRequest]:
        import math

        validate_reservation(amount_microusd, scope, reserved_call_fraction)
        async with self._lock:
            if key in self.requests:
                return False, self.requests[key]
            total = sum(committed(r) for r in self.requests.values())
            if (
                total + amount_microusd
                > min(self.cap_microusd, self.baseline_committed_microusd + EXTRA_CAP_MICROUSD)
                or len(self.requests) >= self.call_cap
            ):
                raise ProviderError("BUDGET_EXCEEDED")
            if reserved_call_fraction is not None and self.call_cap - len(
                self.requests
            ) - 1 < math.ceil(self.call_cap * reserved_call_fraction):
                raise ProviderError("DECISION_SUBCAP")
            request = BudgetRequest(key, "reserved", amount_microusd, scope=scope)
            self.requests[key] = request
            return True, request

    async def submitted(self, key: str) -> None:
        async with self._lock:
            if self.requests[key].state != "reserved":
                raise ProviderError("REQUEST_ALREADY_SUBMITTED")
            self.requests[key].state = "submitted"

    async def finish(
        self, key: str, cost_microusd: int | None, response: Any, generation_id: str | None
    ) -> None:
        if cost_microusd is not None and (type(cost_microusd) is not int or cost_microusd < 0):
            raise ProviderError("INVALID_COST")
        async with self._lock:
            request = self.requests[key]
            if request.state == "settled":
                return
            request.state = "unknown" if cost_microusd is None else "settled"
            request.actual_microusd = cost_microusd
            if response is not None and request.receipt_scrubbed_at is None:
                request.response = response
            if generation_id is not None:
                request.generation_id = generation_id

    async def get(self, key: str) -> BudgetRequest | None:
        return self.requests.get(key)


def _mapped(row: dict[str, Any]) -> BudgetRequest:
    return BudgetRequest(
        row["key"],
        row["state"],
        int(row["reserved_microusd"]),
        row["actual_microusd"],
        row.get("response_json"),
        row.get("generation_id"),
        (
            {
                "kind": row["request_kind"],
                **({"turnId": row["turn_id"]} if row.get("turn_id") else {}),
            }
            if row.get("request_kind")
            else None
        ),
        row.get("response_scrubbed_at"),
    )


class PostgresBudgetLedger:
    "No DDL or baseline reset: explicit migration creates both budget rows once."

    def __init__(self, pool: Any, database_url: str):
        from ptr_llm.repositories.database import assert_llm_pool

        assert_llm_pool(pool, database_url)
        self.pool = pool

    async def reserve(
        self,
        key: str,
        amount_microusd: int,
        *,
        scope: dict[str, str] | None = None,
        reserved_call_fraction: float | None = None,
    ) -> tuple[bool, BudgetRequest]:
        import math

        from psycopg.rows import dict_row

        validate_reservation(amount_microusd, scope, reserved_call_fraction)
        async with self.pool.connection() as conn, conn.transaction():
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(
                    "SELECT cap_microusd,call_cap FROM llm.ptr_provider_budget WHERE i"
                    "d='global' FOR UPDATE"
                )
                budget = await cur.fetchone()
                if budget is None:
                    raise ProviderError("BUDGET_NOT_INITIALIZED")
                await cur.execute("SELECT * FROM llm.ptr_provider_requests WHERE key=%s", (key,))
                previous = await cur.fetchone()
                if previous is not None:
                    return False, _mapped(previous)
                await cur.execute(
                    "SELECT baseline_committed_microusd,extra_cap_microusd FROM llm.pt"
                    "r_provider_migration_budget WHERE id='python-split-45'"
                )
                migration = await cur.fetchone()
                if (
                    migration is None
                    or not 0 <= migration["extra_cap_microusd"] <= EXTRA_CAP_MICROUSD
                ):
                    raise ProviderError("BUDGET_NOT_INITIALIZED")
                await cur.execute(
                    "SELECT COALESCE(SUM(CASE WHEN state='settled' THEN COALESCE(actua"
                    "l_microusd,reserved_microusd) ELSE GREATEST(reserved_microusd,COA"
                    "LESCE(actual_microusd,0)) END),0) AS committed,COUNT(*) AS calls "
                    "FROM llm.ptr_provider_requests"
                )
                aggregate = await cur.fetchone()
                maximum = min(
                    budget["cap_microusd"],
                    MAX_TOTAL_MICROUSD,
                    migration["baseline_committed_microusd"] + migration["extra_cap_microusd"],
                )
                if (
                    aggregate["committed"] + amount_microusd > maximum
                    or aggregate["calls"] >= budget["call_cap"]
                ):
                    raise ProviderError("BUDGET_EXCEEDED")
                if reserved_call_fraction is not None and budget["call_cap"] - aggregate[
                    "calls"
                ] - 1 < math.ceil(budget["call_cap"] * reserved_call_fraction):
                    raise ProviderError("DECISION_SUBCAP")
                await cur.execute(
                    (
                        "INSERT INTO llm.ptr_provider_requests (key,state,reserved_microus"
                        "d,request_kind,turn_id) VALUES (%s,'reserved',%s,%s,%s) RETURNING"
                        " *"
                    ),
                    (
                        key,
                        amount_microusd,
                        scope.get("kind") if scope else None,
                        scope.get("turnId") if scope else None,
                    ),
                )
                return True, _mapped(await cur.fetchone())

    async def submitted(self, key: str) -> None:
        async with self.pool.connection() as conn:
            cur = await conn.execute(
                (
                    "UPDATE llm.ptr_provider_requests SET state='submitted',updated_at"
                    "=now() WHERE key=%s AND state='reserved'"
                ),
                (key,),
            )
            if cur.rowcount != 1:
                raise ProviderError("REQUEST_ALREADY_SUBMITTED")

    async def finish(
        self, key: str, cost_microusd: int | None, response: Any, generation_id: str | None
    ) -> None:
        from psycopg.types.json import Jsonb

        if cost_microusd is not None and (type(cost_microusd) is not int or cost_microusd < 0):
            raise ProviderError("INVALID_COST")
        async with self.pool.connection() as conn, conn.transaction():
            await conn.execute(
                "SELECT id FROM llm.ptr_provider_budget WHERE id='global' FOR UPDATE"
            )
            await conn.execute(
                (
                    "UPDATE llm.ptr_provider_requests SET state=CASE WHEN %s::bigint I"
                    "S NULL THEN 'unknown' ELSE 'settled' END,actual_microusd=%s,respo"
                    "nse_json=CASE WHEN response_scrubbed_at IS NOT NULL THEN NULL ELS"
                    "E COALESCE(%s::jsonb,response_json) END,receipt_received_at=CASE "
                    "WHEN response_scrubbed_at IS NULL AND %s::jsonb IS NOT NULL THEN "
                    "COALESCE(receipt_received_at,now()) ELSE receipt_received_at END,"
                    "generation_id=COALESCE(%s,generation_id),updated_at=now() WHERE k"
                    "ey=%s AND state IN ('reserved','submitted','unknown')"
                ),
                (
                    cost_microusd,
                    cost_microusd,
                    Jsonb(response) if response is not None else None,
                    Jsonb(response) if response is not None else None,
                    generation_id,
                    key,
                ),
            )

    async def get(self, key: str) -> BudgetRequest | None:
        from psycopg.rows import dict_row

        async with self.pool.connection() as conn, conn.cursor(row_factory=dict_row) as cur:
            await cur.execute("SELECT * FROM llm.ptr_provider_requests WHERE key=%s", (key,))
            row = await cur.fetchone()
            return _mapped(row) if row else None
