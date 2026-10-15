"""Explicit split-owner maintenance; never called by serving or queue startup."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlsplit

_UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
_MODEL = re.compile(rf"^model:({_UUID}):[0-9a-f]{{64}}$")
_PYTHON = re.compile(r"^python-call-v1:([0-9a-f]{64}):[0-9a-f]{64}$")
_THREAD_TURN_SQL = (
    "c.thread_id IN ('turn:'||t.id,'character:'||t.id) OR "
    f"(c.thread_id ~ '^model:{_UUID}:[0-9a-f]{{64}}$' "
    "AND split_part(c.thread_id,':',2)=t.id) OR "
    "(c.thread_id ~ '^python-call-v1:[0-9a-f]{64}:[0-9a-f]{64}$' "
    "AND split_part(c.thread_id,':',2) IN ("
    "encode(sha256(convert_to(t.id,'UTF8')),'hex'),"
    "encode(sha256(convert_to(t.id||':summary','UTF8')),'hex'),"
    "encode(sha256(convert_to(t.id||':regen','UTF8')),'hex'),"
    "encode(sha256(convert_to(t.id||':register','UTF8')),'hex')))"
)
_SAVER_TABLES = tuple(
    f"llm.{prefix}{name}"
    for prefix in ("", "legacy_ts_")
    for name in ("checkpoint_writes", "checkpoint_blobs", "checkpoints")
)


@dataclass(frozen=True)
class RetentionOptions:
    days: int = 90
    limit: int = 100
    now: datetime | None = None
    apply: bool = False
    confirm_database: str | None = None

    def validate(self) -> None:
        if (
            type(self.days) is not int
            or self.days < 90
            or type(self.limit) is not int
            or not 1 <= self.limit <= 1000
            or type(self.apply) is not bool
            or self.now is not None
            and (not isinstance(self.now, datetime) or self.now.utcoffset() is None)
        ):
            raise ValueError("RETENTION_SCOPE_INVALID")


def linked_thread_ids(
    threads: list[str], turn_ids: list[str], draft_request_keys: list[str] | None = None
) -> list[str]:
    """Match exact, known native/legacy grammars; never deserialize checkpoint data."""
    turns = set(turn_ids)
    scopes = {
        hashlib.sha256(request_key.encode()).hexdigest()
        for turn in turns
        for request_key in (turn, f"{turn}:summary", f"{turn}:regen", f"{turn}:register")
    }
    scopes.update(
        hashlib.sha256(key.encode()).hexdigest()
        for key in (draft_request_keys or [])
        if key.startswith("draft:")
    )
    explicit = {f"{kind}:{turn}" for turn in turns for kind in ("turn", "character")}
    matched = []
    for thread in set(threads):
        model = _MODEL.fullmatch(thread)
        python = _PYTHON.fullmatch(thread)
        if (
            thread in explicit
            or model is not None
            and model[1] in turns
            or python is not None
            and python[1] in scopes
        ):
            matched.append(thread)
    return sorted(matched)


def maintenance_url(env: Any = None) -> str:
    from ptr_llm.repositories.database import assert_llm_database_url

    env = os.environ if env is None else env
    url = env.get("PTR_LLM_MAINTENANCE_DATABASE_URL", "")
    assert_llm_database_url(url)
    if urlsplit(url).username != "ptr_split_owner":
        raise ValueError("RETENTION_REQUIRES_OWNER")
    return url


async def retain_split_data(connection: Any, options: RetentionOptions | None = None) -> dict:
    """One bounded transaction binds purge eligibility to locked terminal app turns.

    Deleted sessions bypass age retention and lose their application truth. Otherwise,
    billing tombstones, turn/message truth and active/resumable work survive. Missing
    execution/turn scopes and stored session draft request keys are matched exactly.
    Opaque or unlinked checkpoint hashes are retained, not guessed.
    Return only counts: no raw payloads, IDs, hashes, credentials or DSNs.
    """
    options = options or RetentionOptions()
    options.validate()
    now = options.now or datetime.now(UTC)
    cutoff = now - timedelta(days=options.days)
    async with connection.transaction():
        identity = await (
            await connection.execute("SELECT current_database() AS db,current_user AS role")
        ).fetchone()
        if (
            not identity
            or identity["db"] not in {"ptr_split_test", "ptr_split_research"}
            or (identity["role"] != "ptr_split_owner")
        ):
            raise ValueError("RETENTION_REQUIRES_CONNECTED_OWNER")
        if options.apply and options.confirm_database != identity["db"]:
            raise ValueError("RETENTION_CONFIRMATION_REQUIRED")
        # SET LOCAL never changes a later pooled invocation's operational settings.
        await connection.execute("SET LOCAL statement_timeout='5s'")
        await connection.execute("SET LOCAL lock_timeout='1s'")
        mandatory = (
            "app.sessions",
            "app.turns",
            "app.turn_outbox",
            "app.turn_execution_grants",
            "llm.result_receipts",
            "llm.ptr_provider_requests",
        )
        present = {}
        for table in mandatory + ("app.user_memories", "app.generated_artifacts") + _SAVER_TABLES:
            row = await (
                await connection.execute("SELECT to_regclass(%s) IS NOT NULL AS present", (table,))
            ).fetchone()
            present[table] = bool(row["present"])
        if not all(present[table] for table in mandatory + _SAVER_TABLES[:3]):
            raise ValueError("RETENTION_SCHEMA_NOT_READY")
        has_request_key = False
        if present.get("app.generated_artifacts"):
            has_request_key = bool(
                await (
                    await connection.execute(
                        "SELECT 1 FROM information_schema.columns WHERE table_schema='app' "
                        "AND table_name='generated_artifacts' AND column_name='request_key'"
                    )
                ).fetchone()
            )
        if options.apply and has_request_key:
            # Freeze draft inserts while selecting sessions and deleting their
            # checkpoints, so a reused key cannot acquire a new live owner.
            await connection.execute("LOCK TABLE app.generated_artifacts IN SHARE MODE")
        tables = [table for table in _SAVER_TABLES if present[table]]
        union = " UNION ".join(f"SELECT thread_id FROM {table}" for table in tables)
        sessions = await (
            await connection.execute(
                "SELECT s.id FROM app.sessions s WHERE s.deleted_at IS NOT NULL "
                + (
                    "AND NOT EXISTS(SELECT 1 FROM app.generated_artifacts a "
                    "JOIN app.generated_artifacts b ON b.request_key=a.request_key AND b.id<>a.id "
                    "JOIN app.sessions live ON live.id=b.session_id AND live.deleted_at IS NULL "
                    "WHERE a.session_id=s.id AND a.request_key IS NOT NULL) "
                    if has_request_key
                    else ""
                )
                + "ORDER BY s.deleted_at,s.id LIMIT %s "
                + ("FOR UPDATE OF s SKIP LOCKED" if options.apply else ""),
                (options.limit,),
            )
        ).fetchall()
        session_ids = [str(row["id"]) for row in sessions]
        deleted_turns = await (
            await connection.execute(
                "SELECT t.id FROM app.turns t WHERE t.session_id=ANY(%s::text[]) "
                "ORDER BY t.id " + ("FOR UPDATE OF t" if options.apply else ""),
                (session_ids,),
            )
        ).fetchall()
        deleted_ids = [str(row["id"]) for row in deleted_turns]
        draft_keys: list[str] = []
        if session_ids and has_request_key:
            draft_rows = await (
                await connection.execute(
                    "SELECT request_key FROM app.generated_artifacts "
                    "WHERE session_id=ANY(%s::text[]) AND request_key IS NOT NULL "
                    "ORDER BY id LIMIT 100001",
                    (session_ids,),
                )
            ).fetchall()
            if len(draft_rows) > 100000:
                raise ValueError("RETENTION_METADATA_LIMIT_EXCEEDED")
            draft_keys = [str(row["request_key"]) for row in draft_rows]
        draft_scopes = [
            hashlib.sha256(key.encode()).hexdigest()
            for key in draft_keys
            if key.startswith("draft:")
        ]
        turns = await (
            await connection.execute(
                "SELECT t.id FROM app.turns t WHERE t.state IN ('completed','failed','cancelled') "
                "AND t.finished_at<%s AND NOT EXISTS(SELECT 1 FROM app.turn_outbox o "
                "WHERE o.turn_id=t.id) AND ("
                f"EXISTS(SELECT 1 FROM ({union}) c WHERE {_THREAD_TURN_SQL}) OR "
                "EXISTS(SELECT 1 FROM app.turn_execution_grants g WHERE g.turn_id=t.id "
                "AND NOT EXISTS(SELECT 1 FROM llm.result_receipts r WHERE "
                "r.execution_id=g.execution_id AND r.created_at>=%s)) OR "
                "EXISTS(SELECT 1 FROM llm.ptr_provider_requests r WHERE r.turn_id=t.id "
                "AND r.request_kind IN ('chat','decision') AND r.response_json IS NOT NULL "
                "AND r.response_scrubbed_at IS NULL AND r.receipt_received_at<%s)) "
                "ORDER BY t.finished_at,t.id LIMIT %s "
                + ("FOR UPDATE OF t SKIP LOCKED" if options.apply else ""),
                (cutoff, cutoff, cutoff, options.limit),
            )
        ).fetchall()
        ids = sorted(set(deleted_ids + [str(row["id"]) for row in turns]))
        if options.apply:
            # Runtime result/ACK writes do not take app turn locks. A short bounded
            # maintenance table lock also prevents a new receipt racing grant
            # deletion. If it cannot be acquired in 1s, roll back, never guess.
            await connection.execute("LOCK TABLE llm.result_receipts IN SHARE ROW EXCLUSIVE MODE")
        # The IDs above are locked on apply, so no active turn can become purgeable
        # beneath the receipt/checkpoint deletes in this transaction.
        thread_rows = await (
            await connection.execute(
                f"SELECT DISTINCT c.thread_id FROM ({union}) c JOIN app.turns t ON "
                f"({_THREAD_TURN_SQL}) WHERE t.id=ANY(%s::text[]) LIMIT 100001",
                (ids,),
            )
        ).fetchall()
        if draft_scopes:
            draft_threads = await (
                await connection.execute(
                    f"SELECT DISTINCT c.thread_id FROM ({union}) c "
                    "WHERE c.thread_id ~ '^python-call-v1:[0-9a-f]{64}:[0-9a-f]{64}$' "
                    "AND split_part(c.thread_id,':',2)=ANY(%s::text[]) LIMIT 100001",
                    (draft_scopes,),
                )
            ).fetchall()
            thread_rows.extend(draft_threads)
        if len(thread_rows) > 100000:
            raise ValueError("RETENTION_METADATA_LIMIT_EXCEEDED")
        threads = linked_thread_ids([str(row["thread_id"]) for row in thread_rows], ids, draft_keys)
        thread_count = await (
            await connection.execute(f"SELECT count(*) AS count FROM ({union}) c")
        ).fetchone()
        receipts = await (
            await connection.execute(
                "SELECT r.execution_id FROM llm.result_receipts r JOIN app.turn_execution_grants g "
                "ON g.execution_id=r.execution_id WHERE g.turn_id=ANY(%s::text[]) "
                "AND (r.created_at<%s OR g.turn_id=ANY(%s::text[])) ORDER BY r.execution_id",
                (ids, cutoff, deleted_ids),
            )
        ).fetchall()
        execution_ids = [str(row["execution_id"]) for row in receipts]
        grant_rows = await (
            await connection.execute(
                "SELECT g.execution_id FROM app.turn_execution_grants g "
                "WHERE g.turn_id=ANY(%s::text[]) AND (g.turn_id=ANY(%s::text[]) "
                "OR NOT EXISTS(SELECT 1 FROM "
                "llm.result_receipts r "
                "WHERE r.execution_id=g.execution_id AND r.created_at>=%s)) "
                "ORDER BY g.execution_id",
                (ids, deleted_ids, cutoff),
            )
        ).fetchall()
        grant_ids = [str(row["execution_id"]) for row in grant_rows]
        raw = await (
            await connection.execute(
                "SELECT r.key FROM llm.ptr_provider_requests r WHERE r.response_json IS NOT NULL "
                "AND r.response_scrubbed_at IS NULL AND (r.turn_id=ANY(%s::text[]) OR r.key IN ("
                "SELECT q.key FROM llm.ptr_provider_requests q WHERE q.response_json IS NOT NULL "
                "AND q.response_scrubbed_at IS NULL AND q.receipt_received_at<%s AND "
                "((q.request_kind='draft' AND q.turn_id IS NULL) OR "
                "(q.request_kind IN ('chat','decision') AND q.turn_id=ANY(%s::text[]))) "
                "ORDER BY q.receipt_received_at,q.key LIMIT %s)) "
                "ORDER BY r.receipt_received_at,r.key "
                + ("FOR UPDATE OF r" if options.apply else ""),
                (deleted_ids, cutoff, ids, options.limit),
            )
        ).fetchall()
        keys = [str(row["key"]) for row in raw]
        orphan_results = await (
            await connection.execute(
                "SELECT count(*) AS count FROM llm.result_receipts r WHERE r.created_at<%s "
                "AND NOT EXISTS(SELECT 1 FROM app.turn_execution_grants g "
                "JOIN app.turns t ON t.id=g.turn_id WHERE g.execution_id=r.execution_id)",
                (cutoff,),
            )
        ).fetchone()
        deferred = await (
            await connection.execute(
                "SELECT count(*) FILTER(WHERE r.request_kind IS NULL OR "
                "r.receipt_received_at IS NULL) AS legacy_unscoped, "
                "count(*) FILTER(WHERE r.request_kind IN ('chat','decision') AND NOT EXISTS "
                "(SELECT 1 FROM app.turns t WHERE t.id=r.turn_id)) AS missing_turn, "
                "count(*) FILTER(WHERE r.request_kind IS NOT NULL AND r.request_kind NOT IN "
                "('chat','decision','draft')) AS unsupported_kind FROM llm.ptr_provider_requests r "
                "WHERE r.response_json IS NOT NULL AND "
                "COALESCE(r.receipt_received_at,r.updated_at)<%s",
                (cutoff,),
            )
        ).fetchone()
        planned = {
            "turns": len(ids),
            "deletedSessions": len(session_ids),
            "checkpointThreads": len(threads),
            "resultReceipts": len(execution_ids),
            "grantSnapshots": len(grant_ids),
            "providerReceipts": len(keys),
            "forgottenMemories": 0,
        }
        if present.get("app.user_memories"):
            forgotten = await (
                await connection.execute(
                    "SELECT count(*) AS count FROM app.user_memories "
                    "WHERE forgotten AND forgotten_at<%s",
                    (cutoff,),
                )
            ).fetchone()
            planned["forgottenMemories"] = forgotten["count"]
        deleted = {
            "sessions": 0,
            "turns": 0,
            "checkpointRows": 0,
            "resultReceipts": 0,
            "grantSnapshots": 0,
            "providerReceipts": 0,
            "forgottenMemories": 0,
        }
        if options.apply:
            if present.get("app.user_memories"):
                deleted["forgottenMemories"] = (
                    await connection.execute(
                        "DELETE FROM app.user_memories WHERE id IN ("
                        "SELECT id FROM app.user_memories WHERE forgotten AND forgotten_at<%s "
                        "ORDER BY forgotten_at,id FOR UPDATE SKIP LOCKED LIMIT %s)",
                        (cutoff, options.limit),
                    )
                ).rowcount
            for table in tables:
                cursor = await connection.execute(
                    f"DELETE FROM {table} WHERE thread_id=ANY(%s::text[])", (threads,)
                )
                deleted["checkpointRows"] += cursor.rowcount
            deleted["resultReceipts"] = (
                await connection.execute(
                    "DELETE FROM llm.result_receipts WHERE execution_id=ANY(%s::text[])",
                    (execution_ids,),
                )
            ).rowcount
            deleted["grantSnapshots"] = (
                await connection.execute(
                    "DELETE FROM app.turn_execution_grants WHERE execution_id=ANY(%s::text[])",
                    (grant_ids,),
                )
            ).rowcount
            deleted["providerReceipts"] = (
                await connection.execute(
                    "UPDATE llm.ptr_provider_requests SET response_json=NULL,"
                    "response_scrubbed_at=%s "
                    "WHERE key=ANY(%s::text[]) AND response_json IS NOT NULL "
                    "AND response_scrubbed_at IS NULL",
                    (now, keys),
                )
            ).rowcount
            await connection.execute(
                "DELETE FROM app.turn_outbox WHERE turn_id=ANY(%s::text[])", (deleted_ids,)
            )
            deleted["turns"] = (
                await connection.execute(
                    "DELETE FROM app.turns WHERE id=ANY(%s::text[])", (deleted_ids,)
                )
            ).rowcount
            deleted["sessions"] = (
                await connection.execute(
                    "DELETE FROM app.sessions WHERE id=ANY(%s::text[])", (session_ids,)
                )
            ).rowcount
        return {
            "cutoff": cutoff.isoformat(),
            "applied": options.apply,
            "planned": planned,
            "deleted": deleted,
            "deferred": {
                **dict(deferred),
                "orphanResultReceipts": orphan_results["count"],
                "unselectedCheckpointThreads": thread_count["count"] - len(threads),
            },
        }


async def run_retention(args: Any, env: Any = None) -> dict:
    from psycopg import AsyncConnection
    from psycopg.rows import dict_row

    url = maintenance_url(env)
    options = RetentionOptions(
        days=args.days, limit=args.limit, apply=args.apply, confirm_database=args.confirm_database
    )
    options.validate()
    async with asyncio.timeout(60):
        async with await AsyncConnection.connect(
            url, row_factory=dict_row, connect_timeout=5
        ) as connection:
            return await retain_split_data(connection, options)
