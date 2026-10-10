"""Opt-in synthetic-only PG gates; explicit owner setup must precede runtime tests."""

import asyncio
import hashlib
import os
import uuid
from urllib.parse import urlsplit

import pytest
import pytest_asyncio
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import END, START, StateGraph
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ptr_llm.billing import PostgresBudgetLedger, ProviderError
from ptr_llm.core.errors import CoreError
from ptr_llm.providers import CheckpointedTextProvider, FakeTextProvider
from ptr_llm.repositories import PostgresSourceRepository, ResultReceiptStore
from ptr_llm.repositories.database import assert_llm_database_url


@pytest_asyncio.fixture
async def synthetic_pool():
    url = os.environ.get("PTR_PROVIDER_PG_TEST_URL")
    if not url:
        pytest.skip("explicit synthetic PG target not provided")
    assert_llm_database_url(url)
    assert urlsplit(url).path == "/ptr_split_test"
    assert urlsplit(url).username == "ptr_split_llm"
    async with AsyncConnectionPool(
        url,
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
        yield pool, url


@pytest.mark.asyncio
async def test_native_pg_same_key_concurrency_unknown_and_cap(synthetic_pool):
    pool, url = synthetic_pool
    ledger = PostgresBudgetLedger(pool, url)
    key = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
    try:
        results = await asyncio.gather(*(ledger.reserve(key, 100) for _ in range(12)))
        assert sum(int(created) for created, _ in results) == 1
        await ledger.submitted(key)
        await ledger.finish(key, None, None, None)
        created, saved = await ledger.reserve(key, 100)
        assert not created and saved.state == "unknown" and saved.response is None
        with pytest.raises(ProviderError, match="BUDGET_EXCEEDED"):
            await ledger.reserve(hashlib.sha256(uuid.uuid4().bytes).hexdigest(), 2000000)
    finally:
        # This test never submits HTTP: its own synthetic reservation is known zero-cost.
        await ledger.finish(key, 0, None, None)


@pytest.mark.asyncio
async def test_native_pg_nested_receipt_only_replay(synthetic_pool):
    pool, _ = synthetic_pool
    fake, saver = FakeTextProvider(), AsyncPostgresSaver(pool)
    provider = CheckpointedTextProvider(fake, saver)
    messages = [{"role": "user", "content": "합성 저장 검증"}]
    key = str(uuid.uuid4())

    async def outer(_):
        return {"text": await provider.generate(messages, request_key=key)}

    graph = StateGraph(dict)
    graph.add_node("outer", outer)
    graph.add_edge(START, "outer")
    graph.add_edge("outer", END)
    first = await graph.compile().ainvoke({"outer_history": "OUTER_SENTINEL_NOT_DURABLE"})
    assert first["text"] == await provider.generate(messages, request_key=key)
    assert fake.calls == 1
    thread = (
        "python-call-v1:"
        + hashlib.sha256(key.encode()).hexdigest()
        + ":"
        + provider.request_fingerprint(messages, key)
    )
    tuples = [
        row
        async for row in saver.alist({"configurable": {"thread_id": thread, "checkpoint_ns": ""}})
    ]
    assert len(tuples) == 1
    assert "OUTER_SENTINEL_NOT_DURABLE" not in repr(tuples)
    latest = tuples[0].checkpoint["channel_values"]
    assert set(latest) == {"fingerprint", "receipt"}


@pytest.mark.asyncio
async def test_native_pg_result_receipt_grant_fences(synthetic_pool):
    pool, url = synthetic_pool
    store = ResultReceiptStore(pool, url)
    grant = {"executionId": str(uuid.uuid4()), "generation": 1}
    result = {"reply": "합성 답변", "nested": {"z": 1, "a": 2}}
    assert await store.put_result(grant, result) == result
    assert await store.put_result(grant, dict(reversed(list(result.items())))) == result
    assert await store.get_result(grant) == result
    with pytest.raises(ProviderError, match="IDEMPOTENCY_CONFLICT"):
        await store.put_result(grant, {"reply": "다름"})
    with pytest.raises(ProviderError, match="IDEMPOTENCY_CONFLICT"):
        await store.mark_result_ack({**grant, "generation": 2})
    await store.mark_result_ack(grant)
    await store.mark_result_ack(grant)


@pytest.mark.asyncio
async def test_native_pg_immutable_vector_and_person_scope(synthetic_pool):
    pool, url = synthetic_pool
    store = PostgresSourceRepository(pool, url)
    source_id = "synthetic-provider-" + uuid.uuid4().hex
    source = {
        "id": source_id,
        "personId": "synthetic-provider-person",
        "caption": "합성 벡터 검증",
        "postedAt": "2026-01-01T00:00:00Z",
        "eventDate": None,
        "sourceUrl": "https://example.invalid/synthetic",
        "hash": source_id + "-hash",
        "snapshot": source_id + "-snapshot",
        "unsafe": False,
    }
    assert (await store.import_posts([source], "synthetic_fixture"))["inserted"] == 1
    assert (await store.import_posts([source], "synthetic_fixture"))["existing"] == 1
    vector = [1.0] + [0.0] * 1535
    await store.import_vector(source_id, "synthetic-vector-v1", vector)
    await store.import_vector(source_id, "synthetic-vector-v1", vector)
    with pytest.raises(CoreError, match="IDEMPOTENCY_CONFLICT"):
        await store.import_vector(source_id, "synthetic-vector-v1", [1.0, 0.25] + [0.0] * 1534)
    with pytest.raises(CoreError, match="FORBIDDEN"):
        await store.search_lexical(
            {
                "personId": source["personId"],
                "dateBasis": "posted",
                "timezone": "Asia/Seoul",
                "limit": 10,
            },
            {"personId": "synthetic-other"},
        )
