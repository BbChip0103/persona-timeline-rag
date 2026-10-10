"""Native node SLA with no retries and the existing nonblocking cancel policy."""

import asyncio
import time

import pytest
from langgraph.errors import NodeTimeoutError

from ptr_llm.core.routing import bounded, fallback_reason


async def test_native_timeout_is_mapped_and_only_one_attempt(monkeypatch):
    from ptr_llm.core.classifier_timeout import classifier_graph

    graph = classifier_graph(10)
    assert graph.nodes["classify"].retry_policy is None
    assert graph.nodes["classify"].timeout.run_timeout == 0.01
    calls, cleaned = [], asyncio.Event()

    async def classify():
        calls.append(1)
        try:
            await asyncio.sleep(1)
        finally:
            cleaned.set()

    with pytest.raises(TimeoutError) as error:
        await bounded(classify(), 10)
    await asyncio.wait_for(cleaned.wait(), 0.5)
    assert calls == [1] and fallback_reason(error.value) == "timeout"
    assert not isinstance(error.value, NodeTimeoutError)


@pytest.mark.parametrize("mode", ["slow_cleanup", "suppressed"])
async def test_timeout_does_not_wait_for_noncooperative_classifier(mode):
    from ptr_llm.core.classifier_timeout import classifier_graph

    assert classifier_graph(10).nodes["classify"].timeout is not None
    finish, started, cleaned = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def classify():
        started.set()
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            await finish.wait()
            if mode == "slow_cleanup":
                raise
            return {"late": "not a usable result"}
        finally:
            cleaned.set()

    start = time.monotonic()
    try:
        with pytest.raises(TimeoutError):
            await bounded(classify(), 10)
        assert started.is_set() and time.monotonic() - start < 0.2
    finally:
        finish.set()
        await asyncio.wait_for(cleaned.wait(), 0.5)


async def test_preaborted_and_zero_timeout_never_start():
    calls = []

    async def classify():
        calls.append(1)

    signal = asyncio.Event()
    signal.set()
    with pytest.raises(RuntimeError, match="aborted"):
        await bounded(classify(), 100, signal)
    with pytest.raises(TimeoutError):
        await bounded(classify(), 0)
    assert not calls


async def test_external_abort_and_concurrent_context_isolation():
    signal, ready = asyncio.Event(), asyncio.Event()
    calls = []

    async def slow():
        ready.set()
        try:
            await asyncio.sleep(10)
        finally:
            calls.append("cancelled")

    async def abort():
        await ready.wait()
        signal.set()

    abort_task = asyncio.create_task(abort())

    async def fast():
        return {"result": "other context"}

    cancelled, okay = await asyncio.gather(
        bounded(slow(), 100, signal), bounded(fast(), 100), return_exceptions=True
    )
    await abort_task
    await asyncio.sleep(0.02)
    assert str(cancelled) == "aborted" and okay == {"result": "other context"}
    assert calls == ["cancelled"]
