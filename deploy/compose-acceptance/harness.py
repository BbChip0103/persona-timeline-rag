"""Real Redis leases + Postgres ledger + production provider transports, synthetic HTTP."""

import asyncio
import json
import subprocess
import sys
import time
import uuid
from pathlib import Path

import psycopg
from assertions import verify
from fixtures import engine, start, state
from psycopg_pool import AsyncConnectionPool
from ptr_llm.billing import PostgresBudgetLedger, ProviderError
from ptr_llm.core.persona import validate_persona
from ptr_llm.core.runtime import LLMEngine
from ptr_llm.providers.local import DirectLocalTextProvider
from ptr_llm.providers.local_slots import LocalSlots
from ptr_llm.providers.openrouter import OpenRouterClient
from redis.asyncio import Redis

URL = "postgresql://ptr_split_owner:synthetic-acceptance-only@127.0.0.1:58432/ptr_split_test"
KEY = "ptr:compose-acceptance:llm:local-slots"


def setup():
    # The existing ledger migration, in a disposable fixture-only llm schema.
    with psycopg.connect(URL, autocommit=True) as conn:
        assert conn.execute("SELECT current_database()").fetchone()[0] == "ptr_split_test"
        conn.execute("CREATE SCHEMA llm")
        conn.execute("SET search_path=llm,public")
        conn.execute("CREATE TABLE ptr_schema_migrations(name text PRIMARY KEY)")
        conn.execute(
            Path("/source/supabase/migrations/0009_provider_receipt_scope.sql").read_text()
        )
        conn.execute(
            "CREATE TABLE ptr_provider_migration_budget (id text PRIMARY KEY, "
            "baseline_committed_microusd bigint, extra_cap_microusd bigint)"
        )
        conn.execute(
            "INSERT INTO ptr_provider_migration_budget VALUES ('python-split-45',0,1000000)"
        )
        conn.execute("UPDATE ptr_provider_budget SET cap_microusd=1000000 WHERE id='global'")


async def main():
    setup()
    servers = start()
    redis = Redis(host="127.0.0.1", port=6379)
    for _ in range(30):
        try:
            await redis.ping()
            break
        except Exception:
            await asyncio.sleep(0.1)
    pool = AsyncConnectionPool(URL, open=False, kwargs={"autocommit": True})
    await pool.open()
    ledger = PostgresBudgetLedger(pool, URL)
    evidence = []

    async def reset(mode="ok", exhausted=False):
        state.reset(mode)
        await redis.delete(KEY)
        async with pool.connection() as conn:
            await conn.execute("TRUNCATE llm.ptr_provider_requests")
            await conn.execute(
                "UPDATE llm.ptr_provider_budget SET cap_microusd=%s", (0 if exhausted else 1000000,)
            )

    async def provider(timeout=30000):
        paid = OpenRouterClient(
            api_key="synthetic-fixture-only",
            ledger=ledger,
            live_enabled=True,
            allow_external_data=True,
            fixture_enabled=True,
            text_model="google/gemma-4-26b-a4b-it",
            fixture_database="ptr_split_test",
            base_url_override="http://127.0.0.1:18002",
            timeout_ms=timeout,
        )

        class ObservedLocal(DirectLocalTextProvider):
            async def generate(self, messages, **options):
                callback = options.pop("on_served", None)

                def served(upstream):
                    self.acceptance_served.append(upstream)
                    if callback:
                        callback(upstream)

                return await super().generate(messages, on_served=served, **options)

        local = ObservedLocal(
            base_url="http://127.0.0.1:18001/v1",
            model="synthetic-local",
            paid_spillover=paid,
            local_slots=LocalSlots(redis, KEY, 2),
            spillover_wait_ms=2000,
            spillover_min_remaining_ms=10000,
            timeout_ms=30000,
        )
        local.acceptance_served = []
        await local.start_spillover_checks(1)
        return local, paid

    async def counts():
        async with pool.connection() as conn:
            cursor = await conn.execute(
                "SELECT count(*) FILTER (WHERE state IN ('settled','unknown') "
                "AND (generation_id LIKE 'chatcmpl-fake-openrouter-%' OR state='unknown')), "
                "count(*) FILTER (WHERE state='unknown') "
                "FROM llm.ptr_provider_requests"
            )
            return await cursor.fetchone()

    async def burst(case, mode="ok", exhausted=False, draft=False):
        await reset(mode, exhausted)
        local, paid = await provider()
        semaphore = asyncio.Semaphore(4)
        total = 20 if case == "C1" else 8
        served = []
        persona = next(
            item["input"]
            for item in json.loads(
                Path("/source/apps/llm-service/tests/core_domain_golden.json").read_text()
            )
            if item["kind"] == "persona"
        )
        persona = validate_persona(persona)

        class Personas:
            async def get(self, *_):
                return persona

        domain = LLMEngine(provider=local, personas=Personas())

        async def turn(index):
            async with semaphore:
                request_key = f"draft:acceptance:{index}" if draft else str(uuid.uuid4())
                if draft:
                    result = await domain.draft(
                        dict(
                            contractVersion=1,
                            session=dict(
                                personaId=persona["id"],
                                personId=persona["personId"],
                                personaRevision=persona["revision"],
                            ),
                            brief="A fictional blue sky sketch",
                            requestKey=request_key,
                            deadlineAt=time.time() * 1000 + 60000,
                        )
                    )
                    assert "content" in result
                    return result["content"]
                return await local.generate(
                    [
                        {
                            "role": "user",
                            "content": f"K4_ID:{case}-{index} synthetic fictional greeting",
                        }
                    ],
                    request_key=request_key,
                    on_served=served.append,
                    deadline_at=time.time() * 1000 + 60000,
                )

        try:
            results = await asyncio.gather(*(turn(i) for i in range(total)), return_exceptions=True)
            receipts, unknown = await counts()
            data = dict(
                total=total,
                completed=sum(isinstance(r, str) for r in results),
                maximum=engine._counts["max_active"],
                submitted=sum(state.ids.values()),
                receipts=receipts,
                unknown=unknown,
                duplicates=sum(v > 1 for v in state.ids.values()),
                spillover_enabled=local.spillover_enabled,
                offloaded=local.acceptance_served.count("openrouter"),
                local_completed=local.acceptance_served.count("local"),
                mode=mode,
            )
            if case == "C1":
                data["offloaded"] = served.count("openrouter")
                assert data["offloaded"] == data["submitted"]
            verify(case, data)
            evidence.append({"case": case, **data})
            print(json.dumps(evidence[-1]), flush=True)
        finally:
            await local.aclose()
            await paid.aclose()

    try:
        await burst("C1")
        await burst("C2", exhausted=True)
        await burst("C3", mode="check-failure")
        await burst("C3", mode="no-zdr")
        # A separate OS process owns the lease, and is killed without finally.
        # This proves lease reclamation, not BullMQ interrupted-turn recovery.
        await reset()
        child_code = """import asyncio
from redis.asyncio import Redis
from ptr_llm.providers.local_slots import LocalSlots
async def run():
 r=Redis(host="127.0.0.1",port=6379)
 assert await LocalSlots(r,"ptr:compose-acceptance:llm:local-slots",1).acquire("killed",3)
 print("acquired",flush=True)
 await asyncio.sleep(60)
asyncio.run(run())"""
        child = subprocess.Popen(
            [sys.executable, "-c", child_code], stdout=subprocess.PIPE, text=True
        )
        assert await asyncio.to_thread(child.stdout.readline) == "acquired\n"
        started = time.monotonic()
        child.kill()
        await asyncio.to_thread(child.wait)
        slots = LocalSlots(redis, KEY, 1)
        while not await slots.acquire("replacement", 10):
            assert time.monotonic() - started < 3.2
            await asyncio.sleep(0.05)
        recovered = time.monotonic() - started
        assert recovered >= 2.8
        await slots.release("replacement")
        data = dict(
            killed=child.returncode == -9,
            recovered_seconds=round(recovered, 3),
            deadline_seconds=1,
            replayed=1,
            limitation="lease subprocess only; no BullMQ worker recovery evidence",
        )
        # The replay is real local provider work with the reclaimed capacity.
        local, paid = await provider()
        try:
            assert await local.generate([{"role": "user", "content": "synthetic replay"}])
        finally:
            await local.aclose()
            await paid.aclose()
        verify("C4", data)
        evidence.append({"case": "C4", "coverage": "partial", **data})
        print(json.dumps(evidence[-1]), flush=True)
        for mode in ("500", "timeout"):
            await reset(mode)
            local, paid = await provider(timeout=500 if mode == "timeout" else 30000)
            # Hold both slots so exactly one call enters paid transport.
            slots = LocalSlots(redis, KEY, 2)
            await slots.acquire("hold-a", 40)
            await slots.acquire("hold-b", 40)
            try:
                result = await asyncio.gather(
                    local.generate(
                        [{"role": "user", "content": f"K4_ID:C5-{mode} synthetic failure"}],
                        request_key=str(uuid.uuid4()),
                        deadline_at=time.time() * 1000 + 30000,
                    ),
                    return_exceptions=True,
                )
                receipts, unknown = await counts()
                await slots.release("hold-a")
                await slots.release("hold-b")
                unaffected = await local.generate(
                    [{"role": "user", "content": "synthetic other turn"}]
                )
                data = dict(
                    mode=mode,
                    failed=sum(isinstance(r, ProviderError) for r in result),
                    unknown=unknown,
                    submitted=sum(state.ids.values()),
                    receipts=receipts,
                    duplicates=sum(v > 1 for v in state.ids.values()),
                    unaffected=int(bool(unaffected)),
                )
                verify("C5", data)
                evidence.append({"case": "C5", **data})
                print(json.dumps(evidence[-1]), flush=True)
            finally:
                await local.aclose()
                await paid.aclose()
        await burst("C6", draft=True)
        evidence[-1]["coverage"] = "LLMEngine.draft domain path with real configured provider"
        print(
            json.dumps(
                {
                    "result": "provider_checks_passed",
                    "paid_calls": 0,
                    "application_acceptance": "C4 requires worker queue recovery integration",
                    "observations": evidence,
                }
            ),
            flush=True,
        )
    finally:
        await pool.close()
        await redis.aclose()
        for server in servers:
            server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
