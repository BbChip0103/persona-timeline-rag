"""Detached receipt graph: invocation context is fresh, private, and never checkpointed."""

import asyncio
import hashlib
import os
import uuid
from urllib.parse import urlsplit

import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from langgraph.graph import StateGraph
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from ptr_llm.billing import ProviderError
from ptr_llm.providers.checkpoints import CheckpointedTextProvider
from ptr_llm.providers.common import bounded
from ptr_llm.repositories.database import assert_llm_database_url

_RUN_ID = uuid.uuid4().hex


def unique_key(key):
    return _RUN_ID + ":" + key


@pytest.fixture(params=["memory", "postgres"])
async def saver(request):
    if request.param == "memory":
        yield InMemorySaver()
        return
    url = os.environ.get("PTR_PROVIDER_PG_TEST_URL")
    if not url:
        pytest.skip("explicit synthetic PG target not provided")
    assert_llm_database_url(url)
    parsed = urlsplit(url)
    assert parsed.port == 58432 and parsed.path == "/ptr_split_test"
    assert parsed.username == "ptr_split_llm"
    owned_threads = set()

    class OwnedSaver(AsyncPostgresSaver):
        async def aput(self, config, *args, **kwargs):
            owned_threads.add(config["configurable"]["thread_id"])
            return await super().aput(config, *args, **kwargs)

    async with AsyncConnectionPool(
        url,
        min_size=1,
        max_size=8,
        open=False,
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
            "options": "-c search_path=llm,public",
        },
    ) as pool:
        try:
            yield OwnedSaver(pool)
        finally:
            # Delete only exact synthetic thread IDs this fixture itself created.
            async with pool.connection() as conn:
                for table in ("checkpoint_writes", "checkpoint_blobs", "checkpoints"):
                    await conn.execute(
                        "DELETE FROM llm." + table + " WHERE thread_id=ANY(%s)",
                        (list(owned_threads),),
                    )


class InvocationProvider:
    def __init__(self):
        self.calls = []
        self.started = asyncio.Event()
        self.fail_once = False
        self.delay = 0.002

    async def generate(self, messages, *, request_key, signal, on_usage, on_served, **options):
        grant = options["grant"]
        assert grant["request"] == request_key
        await options["before_costly"]()
        self.calls.append((messages, request_key, signal, dict(options)))
        self.started.set()
        await bounded(asyncio.sleep(self.delay), timeout=1, signal=signal)
        if self.fail_once:
            self.fail_once = False
            raise ProviderError("PROVIDER_UNAVAILABLE")
        value = messages[-1]["content"]
        on_usage({"promptTokens": options["priority"], "completionTokens": len(value)})
        on_served(grant["generation"])
        return "reply:" + value


def options(key, i, signal=None, guards=None):
    key = unique_key(key)
    grant = {"request": key, "generation": "synthetic-" + str(i)}

    async def guard():
        if guards is not None:
            guards.append((key, grant["generation"]))

    return {
        "request_key": key,
        "signal": signal or asyncio.Event(),
        "grant": grant,
        "before_costly": guard,
        "deadline_at": 123456789 + i,
        "priority": i,
    }


def messages(i):
    return [{"role": "user", "content": "PRIVATE_CONTEXT_SENTINEL_" + str(i)}]


def thread(provider, values, key):
    key = unique_key(key)
    return (
        "python-call-v1:"
        + hashlib.sha256(key.encode()).hexdigest()
        + ":"
        + provider.request_fingerprint(values, key)
    )


async def assert_receipt_only(saver, provider, values, key):
    rows = [
        row
        async for row in saver.alist({"configurable": {"thread_id": thread(provider, values, key)}})
    ]
    assert len(rows) == 1
    latest = rows[0].checkpoint["channel_values"]
    assert set(latest) == {"fingerprint", "receipt"}
    # Receipt text is deliberately generated from the input, not leaked request state.
    assert all(
        set(row.checkpoint["channel_values"])
        <= {"__start__", "branch:to:model_call", "fingerprint", "receipt"}
        for row in rows
    )
    assert all("before_costly" not in repr(row) and "deadline_at" not in repr(row) for row in rows)


@pytest.mark.asyncio
async def test_concurrent_context_callbacks_and_same_key_distinct_payloads(saver):
    raw, guards = InvocationProvider(), []
    provider = CheckpointedTextProvider(raw, saver)
    captured = {}

    async def invoke(i):
        # Same request key but distinct payloads must get independent fingerprints.
        key = "synthetic-shared-key"
        usage, served = [], []
        result = await provider.generate(
            messages(i),
            **options(key, i, guards=guards),
            on_usage=usage.append,
            on_served=served.append,
        )
        captured[i] = (result, usage, served)

    await asyncio.gather(*(invoke(i) for i in range(16)))
    assert len(raw.calls) == 16
    assert len({thread(provider, messages(i), "synthetic-shared-key") for i in range(16)}) == 16
    assert sorted(guards) == sorted(
        (unique_key("synthetic-shared-key"), "synthetic-" + str(i)) for i in range(16)
    )
    for i, (reply, usage, served) in captured.items():
        assert reply == "reply:" + messages(i)[0]["content"]
        assert usage == [{"promptTokens": i, "completionTokens": len(messages(i)[0]["content"])}]
        assert served == ["synthetic-" + str(i)]
        await assert_receipt_only(saver, provider, messages(i), "synthetic-shared-key")
        replay_usage, replay_served = [], []
        assert (
            await provider.generate(
                messages(i),
                **options("synthetic-shared-key", 999),
                on_usage=replay_usage.append,
                on_served=replay_served.append,
            )
            == reply
        )
        assert replay_usage == usage and replay_served == served
    assert len(raw.calls) == 16 and len(guards) == 16


@pytest.mark.asyncio
async def test_same_fingerprint_concurrent_replays_submit_once(saver):
    raw = InvocationProvider()
    provider = CheckpointedTextProvider(raw, saver)
    outputs = await asyncio.gather(
        *(provider.generate(messages(1), **options("synthetic-one", 1)) for _ in range(16))
    )
    assert len(set(outputs)) == 1 and len(raw.calls) == 1
    await assert_receipt_only(saver, provider, messages(1), "synthetic-one")


@pytest.mark.asyncio
async def test_pending_resume_receives_fresh_grant_signal_and_callbacks(saver):
    raw = InvocationProvider()
    provider = CheckpointedTextProvider(raw, saver)
    raw.fail_once = True
    old_signal, fresh_signal, guards = asyncio.Event(), asyncio.Event(), []
    with pytest.raises(ProviderError, match="PROVIDER_UNAVAILABLE"):
        await provider.generate(messages(1), **options("synthetic-resume", 1, old_signal, guards))
    old_signal.set()
    usage, served = [], []
    result = await provider.generate(
        messages(1),
        **options("synthetic-resume", 2, fresh_signal, guards),
        on_usage=usage.append,
        on_served=served.append,
    )
    assert result == "reply:" + messages(1)[0]["content"]
    assert raw.calls[-1][2] is fresh_signal
    assert raw.calls[-1][3]["deadline_at"] == 123456791
    assert served == ["synthetic-2"] and usage[0]["promptTokens"] == 2
    assert guards == [
        (unique_key("synthetic-resume"), "synthetic-1"),
        (unique_key("synthetic-resume"), "synthetic-2"),
    ]


@pytest.mark.asyncio
async def test_inflight_cancel_isolated_then_resume_and_precancel_replay(saver):
    raw = InvocationProvider()
    raw.delay = 0.04
    provider = CheckpointedTextProvider(raw, saver)
    cancelled = asyncio.Event()
    task = asyncio.create_task(
        provider.generate(messages(1), **options("synthetic-cancel", 1, cancelled))
    )
    await raw.started.wait()
    other = asyncio.create_task(provider.generate(messages(2), **options("synthetic-other", 2)))
    cancelled.set()
    with pytest.raises(ProviderError, match="CANCELLED"):
        await task
    assert await other == "reply:" + messages(2)[0]["content"]
    assert await provider.generate(messages(1), **options("synthetic-cancel", 3)) == (
        "reply:" + messages(1)[0]["content"]
    )
    count = len(raw.calls)
    with pytest.raises(ProviderError, match="CANCELLED"):
        await provider.generate(messages(1), **options("synthetic-cancel", 4, cancelled))
    assert len(raw.calls) == count


@pytest.mark.asyncio
async def test_one_compile_per_wrapper(monkeypatch):
    original = StateGraph.compile
    calls = []

    def compile_once(self, *args, **kwargs):
        calls.append(self)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(StateGraph, "compile", compile_once)
    provider = CheckpointedTextProvider(InvocationProvider(), InMemorySaver())
    await asyncio.gather(
        *(provider.generate(messages(i), **options("synthetic-" + str(i), i)) for i in range(8))
    )
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_exit_final_receipt_commit_awaited_before_success(saver):
    raw = InvocationProvider()
    entered, release, committed = asyncio.Event(), asyncio.Event(), []
    original = saver.aput

    async def blocked(*args, **kwargs):
        entered.set()
        await release.wait()
        result = await original(*args, **kwargs)
        committed.append(True)
        return result

    saver.aput = blocked
    provider = CheckpointedTextProvider(raw, saver)
    task = asyncio.create_task(provider.generate(messages(1), **options("synthetic-await", 1)))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        assert not task.done()
        # EXIT durability: the only write starts AFTER the model has completed.
        assert len(raw.calls) == 1
        release.set()
        assert await task == "reply:" + messages(1)[0]["content"]
        assert committed == [True]
    finally:
        release.set()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_legacy_sync_receipts_replay_without_new_submission(saver):
    raw = InvocationProvider()
    legacy = CheckpointedTextProvider(raw, saver)
    invoke = legacy._graph.ainvoke

    async def sync(*args, **kwargs):
        kwargs["durability"] = "sync"
        return await invoke(*args, **kwargs)

    legacy._graph.ainvoke = sync
    key, values = "synthetic-legacy", messages(3)
    expected = await legacy.generate(values, **options(key, 3))
    rows = [
        row
        async for row in saver.alist({"configurable": {"thread_id": thread(legacy, values, key)}})
    ]
    assert len(rows) == 3
    fresh = CheckpointedTextProvider(raw, saver)
    assert await fresh.generate(values, **options(key, 4)) == expected
    assert len(raw.calls) == 1


@pytest.mark.asyncio
async def test_provider_lifecycle_forwarding_is_public_and_optional():
    raw = InvocationProvider()
    calls = []

    async def close():
        calls.append(True)

    raw.aclose = close
    await CheckpointedTextProvider(raw, InMemorySaver()).aclose()
    assert calls == [True]
    await CheckpointedTextProvider(InvocationProvider(), InMemorySaver()).aclose()


@pytest.mark.asyncio
async def test_postgres_receipt_replays_from_fresh_process(saver):
    if not isinstance(saver, AsyncPostgresSaver):
        pytest.skip("fresh-process replay requires explicit synthetic PG")
    raw = InvocationProvider()
    provider = CheckpointedTextProvider(raw, saver)
    values, key = messages(7), "synthetic-process-replay"
    expected = await provider.generate(values, **options(key, 7))
    # The child has fresh provider/graph/lock state and a separate PG connection;
    # its provider deliberately cannot submit any new model call.
    import json
    import sys

    child = """
import asyncio,json,os,sys
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool
from ptr_llm.providers.checkpoints import CheckpointedTextProvider
from ptr_llm.repositories.database import assert_llm_database_url
class NoSubmission:
    async def generate(self,*args,**kwargs):raise AssertionError("UNEXPECTED_SUBMISSION")
async def main():
    url=os.environ["PTR_PROVIDER_PG_TEST_URL"]
    assert_llm_database_url(url)
    async with AsyncConnectionPool(url,open=False,min_size=1,max_size=1,
        kwargs={"autocommit":True,"prepare_threshold":0,"row_factory":dict_row,
                "options":"-c search_path=llm,public"}) as pool:
        provider=CheckpointedTextProvider(NoSubmission(),AsyncPostgresSaver(pool))
        text=await provider.generate(json.loads(sys.argv[1]),request_key=sys.argv[2])
        print(json.dumps({"matches":text==sys.argv[3]}))
asyncio.run(main())
"""
    process = await asyncio.create_subprocess_exec(
        sys.executable,
        "-c",
        child,
        json.dumps(values),
        unique_key(key),
        expected,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout, _ = await asyncio.wait_for(process.communicate(), 20)
    assert process.returncode == 0
    assert json.loads(stdout) == {"matches": True}
    assert len(raw.calls) == 1
