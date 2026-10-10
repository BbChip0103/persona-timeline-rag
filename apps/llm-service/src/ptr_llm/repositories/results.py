"""Immutable final receipts bridge Python execution and backend commit ACK."""

from typing import Any

from ptr_llm.billing import ProviderError
from ptr_llm.providers.common import fingerprint, js_json

from .database import LlmRepository


def receipt_hash(value: Any) -> str:
    def ordered(item: Any) -> Any:
        if isinstance(item, dict):
            return {k: ordered(item[k]) for k in sorted(item)}
        if isinstance(item, list):
            return [ordered(v) for v in item]
        return item

    return fingerprint(ordered(value))


class ResultReceiptStore(LlmRepository):
    @staticmethod
    def _identity(grant: dict[str, Any]) -> tuple[str, str]:
        execution_id = grant.get("executionId")
        if not isinstance(execution_id, str) or not 1 <= len(execution_id) <= 200:
            raise ProviderError("INVALID_INPUT")
        return execution_id, receipt_hash(grant)

    async def get_result(self, grant: dict[str, Any]) -> dict[str, Any] | None:
        key, grant_hash = self._identity(grant)
        rows = await self.fetch(
            (
                "SELECT grant_hash,result_hash,result_json FROM llm.result_receipt"
                "s WHERE execution_id=$1"
            ),
            [key],
        )
        if not rows:
            return None
        row = rows[0]
        if (
            row["grant_hash"] != grant_hash
            or receipt_hash(row["result_json"]) != row["result_hash"]
        ):
            raise ProviderError("IDEMPOTENCY_CONFLICT")
        return row["result_json"]

    async def put_result(self, grant: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        key, grant_hash = self._identity(grant)
        if not isinstance(result, dict) or len(js_json(result).encode()) > 256 * 1024:
            raise ProviderError("INVALID_INPUT")
        result_hash = receipt_hash(result)
        async with self.pool.connection() as conn, conn.transaction():
            await self.fetch(
                (
                    "INSERT INTO llm.result_receipts(execution_id,grant_hash,result_ha"
                    "sh,result_json) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING"
                ),
                [key, grant_hash, result_hash, js_json(result)],
                connection=conn,
            )
            rows = await self.fetch(
                (
                    "SELECT grant_hash,result_hash,result_json FROM llm.result_receipt"
                    "s WHERE execution_id=$1"
                ),
                [key],
                connection=conn,
            )
            if (
                not rows
                or rows[0]["grant_hash"] != grant_hash
                or rows[0]["result_hash"] != result_hash
            ):
                raise ProviderError("IDEMPOTENCY_CONFLICT")
            return rows[0]["result_json"]

    async def mark_result_ack(self, grant: dict[str, Any]) -> None:
        key, grant_hash = self._identity(grant)
        rows = await self.fetch(
            (
                "UPDATE llm.result_receipts SET acknowledged_at=COALESCE(acknowled"
                "ged_at,now()) WHERE execution_id=$1 AND grant_hash=$2 RETURNING e"
                "xecution_id"
            ),
            [key, grant_hash],
        )
        if not rows:
            raise ProviderError("IDEMPOTENCY_CONFLICT")
