"""Opt-in disposable PostgreSQL, owned fixtures only; never existing DB credentials."""

import asyncio
import hashlib
import json
import os
import subprocess
import time
from datetime import UTC, datetime
from types import SimpleNamespace
from uuid import uuid4

import psycopg
import pytest
from psycopg.rows import dict_row

from ptr_llm.retention import RetentionOptions, retain_split_data

pytestmark = pytest.mark.skipif(
    os.environ.get("PTR_RETENTION_INTEGRATION") != "1", reason="explicit disposable DB opt-in"
)
NOW = datetime(2026, 10, 11, tzinfo=UTC)
OLD = datetime(2020, 1, 1, tzinfo=UTC)
RECENT = datetime(2026, 10, 1, tzinfo=UTC)
TABLES = (
    "checkpoint_writes",
    "checkpoint_blobs",
    "checkpoints",
    "legacy_ts_checkpoint_writes",
    "legacy_ts_checkpoint_blobs",
    "legacy_ts_checkpoints",
)


def docker(*args):
    return subprocess.check_output(["docker", *args], text=True, timeout=30).strip()


@pytest.fixture
async def isolated_pg():
    name = "ptr-retention-test-" + uuid4().hex[:12]
    label = "ptr.retention.owner=" + name
    docker(
        "run",
        "--pull",
        "never",
        "--rm",
        "-d",
        "--name",
        name,
        "--label",
        label,
        "-p",
        "127.0.0.1::5432",
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "-e",
        "POSTGRES_USER=ptr_split_owner",
        "-e",
        "POSTGRES_DB=ptr_split_test",
        "pgvector/pgvector:0.8.1-pg15",
    )
    try:
        inspected = json.loads(docker("inspect", name))[0]
        assert inspected["Config"]["Labels"]["ptr.retention.owner"] == name
        port = inspected["NetworkSettings"]["Ports"]["5432/tcp"][0]["HostPort"]
        url = f"postgresql://ptr_split_owner@127.0.0.1:{port}/ptr_split_test"
        deadline = time.monotonic() + 30
        while True:
            try:
                conn = await psycopg.AsyncConnection.connect(
                    url, autocommit=True, row_factory=dict_row
                )
                await conn.close()
                break
            except psycopg.OperationalError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("OWN_SYNTHETIC_DB_NOT_READY") from None
                await asyncio.sleep(0.1)
        yield url
    finally:
        inspected = json.loads(docker("inspect", name))[0]
        assert inspected["Config"]["Labels"]["ptr.retention.owner"] == name
        docker("rm", "-f", name)


async def seed(connection):
    await connection.execute("CREATE SCHEMA app; CREATE SCHEMA llm")
    await connection.execute("""
        CREATE TABLE app.turns(id text PRIMARY KEY,state text,finished_at timestamptz);
        CREATE TABLE app.turn_outbox(turn_id text);
        CREATE TABLE app.turn_execution_grants(execution_id text PRIMARY KEY,turn_id text,
            context jsonb,result jsonb);
        CREATE TABLE llm.result_receipts(execution_id text PRIMARY KEY,result_json jsonb,
            created_at timestamptz,acknowledged_at timestamptz);
        CREATE TABLE llm.ptr_provider_requests(key text PRIMARY KEY,state text,
            request_kind text,turn_id text,response_json jsonb,response_scrubbed_at timestamptz,
            receipt_received_at timestamptz,updated_at timestamptz,reserved_microusd bigint,
            actual_microusd bigint,generation_id text);
    """)
    for table in TABLES:
        await connection.execute(f"CREATE TABLE llm.{table}(thread_id text,payload text)")
    states = [
        ("completed", OLD),
        ("running", OLD),
        ("completed", RECENT),
        ("completed", OLD),
        ("failed", OLD),
        ("cancelled", OLD),
    ]
    turns = [f"00000000-0000-4000-8000-{i:012d}" for i in range(1, 7)]
    for turn, (state, finished) in zip(turns, states, strict=True):
        await connection.execute("INSERT INTO app.turns VALUES(%s,%s,%s)", (turn, state, finished))
        await connection.execute(
            "INSERT INTO app.turn_execution_grants VALUES(%s,%s,%s,%s)",
            (turn, turn, '{"syntheticContext":true}', '{"syntheticResult":true}'),
        )
        await connection.execute(
            "INSERT INTO llm.result_receipts VALUES(%s,%s,%s,NULL)",
            (turn, '{"syntheticReply":true}', finished),
        )
        for table in TABLES:
            thread = (
                f"python-call-v1:{hashlib.sha256(turn.encode()).hexdigest()}:" + "a" * 64
                if not table.startswith("legacy")
                else f"turn:{turn}"
            )
            await connection.execute(
                f"INSERT INTO llm.{table} VALUES(%s,%s)", (thread, "synthetic-private-receipt")
            )
        await connection.execute(
            "INSERT INTO llm.ptr_provider_requests VALUES"
            "(%s,'unknown','chat',%s,%s,NULL,%s,%s,100,NULL,'synthetic-generation')",
            (turn, turn, '{"syntheticRaw":true}', finished, finished),
        )
    await connection.execute("INSERT INTO app.turn_outbox VALUES(%s)", (turns[3],))
    await connection.execute(
        "INSERT INTO llm.result_receipts VALUES('orphan-result',%s,%s,NULL)",
        ('{"syntheticOrphan":true}', OLD),
    )
    for table in TABLES:
        await connection.execute(
            f"INSERT INTO llm.{table} VALUES(%s,%s)",
            ("python-call-v1:" + "b" * 64 + ":" + "c" * 64, "unlinked"),
        )
    for key, kind, turn in [
        ("legacy", None, None),
        ("embedding", "embedding", None),
        ("missing", "chat", "missing-turn"),
        ("draft", "draft", None),
    ]:
        await connection.execute(
            "INSERT INTO llm.ptr_provider_requests VALUES"
            "(%s,'unknown',%s,%s,%s,NULL,%s,%s,100,NULL,'synthetic-generation')",
            (key, kind, turn, '{"syntheticRaw":true}', OLD, OLD),
        )
    return turns


async def snapshot(connection):
    return {
        table: (await (await connection.execute(f"SELECT * FROM {table} ORDER BY 1")).fetchall())
        for table in (
            "app.turns",
            "app.turn_execution_grants",
            "llm.result_receipts",
            "llm.ptr_provider_requests",
            *(f"llm.{table}" for table in TABLES),
        )
    }


async def test_real_transaction_dry_run_purge_progress_and_tombstones(isolated_pg):
    async with await psycopg.AsyncConnection.connect(
        isolated_pg, autocommit=True, row_factory=dict_row
    ) as connection:
        turns = await seed(connection)
        before = await snapshot(connection)
        dry = await retain_split_data(connection, RetentionOptions(now=NOW))
        assert before == await snapshot(connection)
        assert dry["planned"]["turns"] == 3
        assert dry["planned"]["checkpointThreads"] == 6
        assert dry["deferred"]["orphanResultReceipts"] == 1
        assert dry["deferred"]["legacy_unscoped"] == 1
        assert dry["deferred"]["missing_turn"] == 1
        assert dry["deferred"]["unsupported_kind"] == 1
        applied = await retain_split_data(
            connection,
            RetentionOptions(now=NOW, apply=True, confirm_database="ptr_split_test", limit=1),
        )
        assert applied["deleted"] == {
            "checkpointRows": 6,
            "resultReceipts": 1,
            "grantSnapshots": 1,
            "providerReceipts": 1,
        }
        # Draft selection shares the bounded receipt limit; next batch completes
        # remaining artifacts rather than repeatedly selecting the already-cleaned turn.
        second = await retain_split_data(
            connection,
            RetentionOptions(now=NOW, apply=True, confirm_database="ptr_split_test", limit=100),
        )
        assert second["planned"]["turns"] == 2
        assert second["deleted"]["providerReceipts"] == 3
        final = await snapshot(connection)
        assert final["app.turns"] == before["app.turns"]
        for table in TABLES:
            assert len(final[f"llm.{table}"]) == 4  # active/recent/outbox/opaque orphan
        assert len(final["llm.result_receipts"]) == 4
        ledger = {r["key"]: r for r in final["llm.ptr_provider_requests"]}
        for turn in (turns[0], turns[4], turns[5]):
            assert ledger[turn]["response_json"] is None
            assert ledger[turn]["response_scrubbed_at"] == NOW
            assert ledger[turn]["state"] == "unknown"
            assert ledger[turn]["reserved_microusd"] == 100
            assert ledger[turn]["generation_id"] == "synthetic-generation"
        for key in (turns[1], turns[2], turns[3], "legacy", "embedding", "missing"):
            assert ledger[key]["response_json"] is not None
        repeat = await retain_split_data(
            connection, RetentionOptions(now=NOW, apply=True, confirm_database="ptr_split_test")
        )
        assert repeat["planned"]["turns"] == 0
        assert all(count == 0 for count in repeat["deleted"].values())


async def test_real_locks_skip_active_owner_and_block_new_receipt_until_commit(isolated_pg):
    async with await psycopg.AsyncConnection.connect(
        isolated_pg, autocommit=True, row_factory=dict_row
    ) as connection:
        turns = await seed(connection)
        async with await psycopg.AsyncConnection.connect(
            isolated_pg, row_factory=dict_row
        ) as blocker:
            await blocker.execute("SELECT id FROM app.turns WHERE id=%s FOR UPDATE", (turns[0],))
            result = await retain_split_data(
                connection, RetentionOptions(now=NOW, apply=True, confirm_database="ptr_split_test")
            )
            assert result["planned"]["turns"] == 2
            assert (
                await (
                    await connection.execute(
                        "SELECT result_json FROM llm.result_receipts WHERE execution_id=%s",
                        (turns[0],),
                    )
                ).fetchone()
            ) is not None
            await blocker.rollback()
        # Hold the real maintenance transaction open after purge to prove its
        # absent-row/table lock prevents INSERT, not merely an existing row UPDATE.
        async with connection.transaction():
            await retain_split_data(
                connection, RetentionOptions(now=NOW, apply=True, confirm_database="ptr_split_test")
            )
            async with await psycopg.AsyncConnection.connect(
                isolated_pg, autocommit=True
            ) as writer:
                await writer.execute("SET lock_timeout='100ms'")
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    await writer.execute(
                        "INSERT INTO llm.result_receipts VALUES('concurrent',%s,%s,NULL)",
                        ("{}", OLD),
                    )


async def test_real_mutation_failure_rolls_back_all_prior_purge(isolated_pg):
    async with await psycopg.AsyncConnection.connect(
        isolated_pg, autocommit=True, row_factory=dict_row
    ) as connection:
        await seed(connection)
        before = await snapshot(connection)
        await connection.execute(
            "CREATE FUNCTION llm.reject_scrub() RETURNS trigger LANGUAGE "
            "plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic failure'; END$$"
        )
        await connection.execute(
            "CREATE TRIGGER reject_scrub BEFORE UPDATE ON "
            "llm.ptr_provider_requests FOR EACH ROW EXECUTE FUNCTION "
            "llm.reject_scrub()"
        )
        with pytest.raises(psycopg.errors.RaiseException):
            await retain_split_data(
                connection, RetentionOptions(now=NOW, apply=True, confirm_database="ptr_split_test")
            )
        assert before == await snapshot(connection)


async def test_worker_receipt_timeout_cancels_real_query_and_connection_recovers(isolated_pg):
    from ptr_llm.control import ControlUnavailable
    from ptr_llm.worker import WorkerRunner

    async def noop(*args, **kwargs):
        pass

    runner = object.__new__(WorkerRunner)
    runner.settings = SimpleNamespace(backend_timeout=0.03, status_interval=0.005)
    guard = SimpleNamespace(
        lease=noop, ownership=noop, grant={"deadlineAt": int(time.time() * 1000) + 5000}
    )
    async with await psycopg.AsyncConnection.connect(
        isolated_pg, autocommit=True, row_factory=dict_row
    ) as connection:
        started = time.monotonic()
        with pytest.raises(ControlUnavailable):
            await runner._receipt_io(
                guard,
                lambda: connection.execute("SELECT pg_sleep(10)"),
                terminal_delivery=True,
                committed=True,
            )
        assert time.monotonic() - started < 1
        assert (await (await connection.execute("SELECT 1 AS ready")).fetchone())["ready"] == 1
