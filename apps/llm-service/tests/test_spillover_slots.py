"""Synthetic slot contract against the suite's owned Redis container."""

import asyncio
import time
from uuid import uuid4

import httpx
import pytest
from redis.asyncio import Redis

from ptr_llm.billing import ProviderError
from ptr_llm.providers.local import DirectLocalTextProvider
from ptr_llm.providers.local_slots import LocalSlots

pytest_plugins = ["test_queue_integration"]


async def test_slot_contention_expiry_and_release(owned_redis):
    _, url = owned_redis
    redis = Redis.from_url(url, decode_responses=True)
    slots = LocalSlots(redis, f"ptr:synthetic:{uuid4().hex}:llm:local-slots", 1)
    try:
        first, second = uuid4().hex, uuid4().hex
        assert await slots.acquire(first, 0.15)
        assert not await slots.acquire(second, 0.15)
        await asyncio.sleep(0.2)
        assert await slots.acquire(second, 1)
        await slots.release(second)
        assert await slots.acquire(first, 1)
        await slots.release(first)
    finally:
        await redis.aclose()


async def test_simultaneous_acquire_has_one_winner(owned_redis):
    _, url = owned_redis
    redis = Redis.from_url(url, decode_responses=True)
    slots = LocalSlots(redis, f"ptr:synthetic:{uuid4().hex}:llm:local-slots", 1)
    try:
        winners = await asyncio.gather(slots.acquire("first", 1), slots.acquire("second", 1))
        assert winners.count(True) == 1
        await slots.release("first")
        await slots.release("second")
    finally:
        await redis.aclose()


async def test_slot_acquire_error_cleans_ambiguous_lease():
    calls = []

    class BrokenRedis:
        async def eval(self, *_):
            raise ConnectionError("synthetic ambiguous acquire")

        async def zrem(self, key, lease):
            calls.append((key, lease))

    slots = LocalSlots(BrokenRedis(), "ptr:synthetic:llm:local-slots", 1)
    with pytest.raises(ProviderError, match="LOCAL_SLOT_UNAVAILABLE"):
        await slots.acquire("lease-1", 1)
    assert calls == [("ptr:synthetic:llm:local-slots", "lease-1")]


async def test_slot_wait_cancellation_releases(owned_redis):
    _, url = owned_redis
    redis = Redis.from_url(url, decode_responses=True)
    slots = LocalSlots(redis, f"ptr:synthetic:{uuid4().hex}:llm:local-slots", 1)
    signal = asyncio.Event()
    try:
        assert await slots.acquire("first", 1)
        polled = asyncio.Event()
        original_acquire = slots.acquire

        async def observe_acquire(lease, ttl):
            acquired = await original_acquire(lease, ttl)
            polled.set()
            return acquired

        slots.acquire = observe_acquire
        provider = DirectLocalTextProvider(
            base_url="http://127.0.0.1:8111/v1",
            model="local/synthetic",
            local_slots=slots,
            transport=httpx.MockTransport(lambda _: pytest.fail("local must wait")),
        )
        waiter = asyncio.create_task(
            provider.generate([{"role": "user", "content": "synthetic"}], signal=signal)
        )
        await asyncio.wait_for(polled.wait(), 3)
        started = time.monotonic()
        signal.set()
        with pytest.raises(ProviderError, match="CANCELLED"):
            await waiter
        assert time.monotonic() - started < 0.2
        assert await redis.zcard(slots.key) == 1
        await slots.release("first")
        await provider.aclose()
    finally:
        await redis.aclose()


async def test_release_is_shielded_against_task_cancellation():
    entered = asyncio.Event()
    allow_finish = asyncio.Event()
    calls = []

    class SlowRedis:
        async def zrem(self, key, lease):
            entered.set()
            await allow_finish.wait()
            calls.append((key, lease))

    slots = LocalSlots(SlowRedis(), "ptr:synthetic:llm:local-slots", 1)
    task = asyncio.create_task(slots.release("lease"))
    await entered.wait()
    task.cancel()
    allow_finish.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert calls == [("ptr:synthetic:llm:local-slots", "lease")]
