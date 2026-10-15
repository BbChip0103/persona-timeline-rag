"""Redis-owned local GPU leases shared by Compose workers."""

from __future__ import annotations

import asyncio
from typing import Any

from ptr_llm.billing import ProviderError

_ACQUIRE = """
local now = redis.call('TIME')
local seconds = tonumber(now[1]) + tonumber(now[2]) / 1000000
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', seconds)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], seconds + tonumber(ARGV[3]), ARGV[1])
return 1
"""


async def _shielded_release(redis: Any, key: str, lease: str) -> None:
    task = asyncio.create_task(redis.zrem(key, lease))
    cancelled = False
    while not task.done():
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            cancelled = True
    task.result()
    if cancelled:
        raise asyncio.CancelledError


class LocalSlots:
    def __init__(self, redis: Any, key: str, count: int):
        self.redis, self.key, self.count = redis, key, count

    async def acquire(self, lease: str, ttl_seconds: float) -> bool:
        try:
            return bool(
                await self.redis.eval(_ACQUIRE, 1, self.key, lease, self.count, ttl_seconds)
            )
        except BaseException as error:
            # EVAL may have committed even when its reply was lost.
            await _shielded_release(self.redis, self.key, lease)
            if isinstance(error, asyncio.CancelledError):
                raise
            raise ProviderError("LOCAL_SLOT_UNAVAILABLE") from None

    async def release(self, lease: str) -> None:
        try:
            await _shielded_release(self.redis, self.key, lease)
        except asyncio.CancelledError:
            raise
        except Exception:
            raise ProviderError("LOCAL_SLOT_UNAVAILABLE") from None
