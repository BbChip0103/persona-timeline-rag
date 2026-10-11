"""Opt-in fresh owned synthetic PG: cumulative cap and runtime cap-write denial.

No provider calls. Caller destroys only its own disposable test container afterward.
"""

import asyncio
import hashlib
import os
from pathlib import Path
from urllib.parse import urlsplit

import psycopg
import pytest
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ptr_llm.billing import PostgresBudgetLedger, ProviderError
from ptr_llm.repositories.database import assert_llm_database_url


@pytest.mark.asyncio
async def test_cumulative_one_usd_unknown_concurrent_and_column_cap_guard():
    owner_url = os.environ.get("PTR_BUDGET_SYNTHETIC_OWNER_URL")
    llm_url = os.environ.get("PTR_BUDGET_SYNTHETIC_LLM_URL")
    if not owner_url or not llm_url:
        pytest.skip("explicit fresh synthetic owner and LLM URLs required")
    assert_llm_database_url(owner_url)
    assert_llm_database_url(llm_url)
    for url, role in ((owner_url, "ptr_split_owner"), (llm_url, "ptr_split_llm")):
        target = urlsplit(url)
        assert target.path == "/ptr_split_test" and target.username == role
    with psycopg.connect(owner_url, autocommit=True, row_factory=dict_row) as owner:
        assert owner.execute("SELECT current_database() AS db,current_user AS role").fetchone() == {
            "db": "ptr_split_test",
            "role": "ptr_split_owner",
        }
        assert (
            owner.execute(
                "SELECT COALESCE(SUM(COALESCE(actual_microusd,reserved_microusd)),0) AS n "
                "FROM llm.ptr_provider_requests"
            ).fetchone()["n"]
            == 0
        )
        migration = (
            Path(__file__).resolve().parents[3] / "supabase/split/0004_cumulative_budget_cap.sql"
        )
        owner.execute(migration.read_text())
        owner.execute(migration.read_text())
        budget = owner.execute(
            "SELECT cap_microusd FROM llm.ptr_provider_budget WHERE id='global'"
        ).fetchone()
        assert budget["cap_microusd"] == 1000000
        baseline = owner.execute(
            "SELECT baseline_committed_microusd,extra_cap_microusd "
            "FROM llm.ptr_provider_migration_budget WHERE id='python-split-45'"
        ).fetchone()
        assert baseline == {"baseline_committed_microusd": 0, "extra_cap_microusd": 1000000}
        owner.execute(
            "INSERT INTO llm.ptr_provider_requests(key,state,reserved_microusd,actual_microusd) "
            "VALUES('synthetic-old-unknown','unknown',900000,NULL),"
            "('synthetic-old-settled','settled',90000,90000)"
        )
    async with AsyncConnectionPool(
        llm_url,
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
            "options": "-c search_path=llm,public",
        },
        min_size=1,
        max_size=8,
        open=False,
    ) as pool:
        ledger = PostgresBudgetLedger(pool, llm_url)

        async def attempt(i):
            try:
                return (
                    await ledger.reserve(
                        hashlib.sha256(f"synthetic-concurrent-{i}".encode()).hexdigest(), 6000
                    )
                )[0]
            except ProviderError as error:
                assert error.code == "BUDGET_EXCEEDED"
                return False

        results = await asyncio.gather(*(attempt(i) for i in range(12)))
        assert sum(results) == 1
        async with pool.connection() as conn:
            r = await (
                await conn.execute(
                    "SELECT SUM(CASE WHEN state='settled' THEN "
                    "COALESCE(actual_microusd,reserved_microusd) ELSE "
                    "GREATEST(reserved_microusd,COALESCE(actual_microusd,0)) END) AS exposure "
                    "FROM llm.ptr_provider_requests"
                )
            ).fetchone()
            assert r["exposure"] == 996000
            assert (
                await (
                    await conn.execute(
                        "SELECT COUNT(*) AS n FROM llm.ptr_provider_requests WHERE state='unknown'"
                    )
                ).fetchone()
            )["n"] == 1
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                await conn.execute(
                    "UPDATE llm.ptr_provider_budget SET cap_microusd=2000000 WHERE id='global'"
                )
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                await conn.execute("DELETE FROM llm.ptr_provider_budget WHERE id='global'")
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                await conn.execute(
                    "INSERT INTO llm.ptr_provider_budget(id,cap_microusd,call_cap) "
                    "VALUES('global',2000000,10000)"
                )
        key = hashlib.sha256(b"synthetic-final-lock").hexdigest()
        created, _ = await ledger.reserve(key, 4000)
        assert created
        await ledger.submitted(key)
        await ledger.finish(key, None, None, None)
        reruns = await asyncio.gather(*(ledger.reserve(key, 4000) for _ in range(12)))
        assert all(not created and row.state == "unknown" for created, row in reruns)
        with pytest.raises(ProviderError, match="BUDGET_EXCEEDED"):
            await ledger.reserve(hashlib.sha256(b"synthetic-over-one").hexdigest(), 1)
        await ledger.finish(key, 1000, None, None)
        assert (await ledger.get(key)).state == "settled"
