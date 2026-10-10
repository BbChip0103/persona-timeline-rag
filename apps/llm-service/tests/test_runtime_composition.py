"""Factory/ownership startup regression proofs without a database or provider call."""

from contextlib import asynccontextmanager

import pytest

from ptr_llm.config import Settings

URL = "postgresql://ptr_split_llm:synthetic@127.0.0.1:58432/ptr_split_test"


class FakeCursor:
    def __init__(self, row):
        self.row = row

    async def fetchone(self):
        return self.row


class FakeConnection:
    def __init__(self, pool):
        self.pool = pool

    async def execute(self, statement):
        assert "app." not in statement
        if statement == "SELECT 1":
            return FakeCursor({"?column?": 1})
        return FakeCursor(self.pool.identity)


class FakePool:
    instances = []
    identity = {
        "role": "ptr_split_llm",
        "db": "ptr_split_test",
        "personas": "llm.personas",
        "receipts": "llm.result_receipts",
        "checkpoints": "llm.checkpoints",
        "cap": 1000000,
    }

    def __init__(self, *, conninfo, open, min_size, max_size, kwargs):
        assert open is False and 1 <= min_size <= max_size
        self.conninfo, self.kwargs = conninfo, kwargs
        self.closed = False
        self.instances.append(self)

    async def open(self, wait=True):
        assert wait

    @asynccontextmanager
    async def connection(self):
        yield FakeConnection(self)

    async def close(self):
        self.closed = True


def _settings():
    return Settings(
        redis_url="redis://127.0.0.1:58479/0",
        backend_url="http://127.0.0.1:58441",
        control_token="synthetic-control-key",
        database_url=URL,
    )


async def test_factory_fake_is_independent_no_ddl_and_accepts_pool_one(monkeypatch):
    from ptr_llm import runtime as module

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    monkeypatch.setenv("LANGFUSE_ENABLED", "true")  # Explicit factory env must prevail.
    built = await module.build_runtime(_settings(), {"PTR_LLM_DB_POOL_MAX": "1"})
    assert built.provider_name == "fake"
    assert built.telemetry.client is None
    assert await built.health()
    await built.close()
    assert FakePool.instances[-1].closed


async def test_factory_schema_cap_missing_fail_closed_and_closes_pool(monkeypatch):
    from ptr_llm import runtime as module
    from ptr_llm.billing import ProviderError

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    monkeypatch.setattr(FakePool, "identity", {**FakePool.identity, "cap": None})
    with pytest.raises(ProviderError, match="RUNTIME_SCHEMA_NOT_READY"):
        await module.build_runtime(_settings(), {})
    assert FakePool.instances[-1].closed


async def test_factory_runtime_owner_role_rejected_before_pool_open(monkeypatch):
    from dataclasses import replace

    from ptr_llm import runtime as module
    from ptr_llm.billing import ProviderError

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    before = len(FakePool.instances)
    settings = replace(_settings(), database_url=URL.replace("ptr_split_llm:", "ptr_split_owner:"))
    with pytest.raises(ProviderError, match="RUNTIME_REQUIRES_LLM_ROLE"):
        await module.build_runtime(settings, {})
    assert len(FakePool.instances) == before


async def test_factory_failed_open_closes_pool(monkeypatch):
    from ptr_llm import runtime as module

    async def fail(self, wait=True):
        raise RuntimeError("synthetic-open-failure")

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    monkeypatch.setattr(FakePool, "open", fail)
    with pytest.raises(RuntimeError, match="synthetic-open-failure"):
        await module.build_runtime(_settings(), {})
    assert FakePool.instances[-1].closed


@pytest.mark.parametrize(
    "prices", [{}, {"PTR_LLM_PROMPT_USD_PER_M": "nan", "PTR_LLM_COMPLETION_USD_PER_M": "0.3"}]
)
async def test_billable_litellm_untrusted_prices_rejected(monkeypatch, prices):
    from ptr_llm import runtime as module
    from ptr_llm.billing import ProviderError

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    with pytest.raises(ProviderError, match="PRICING_UNVERIFIED"):
        await module.build_runtime(
            _settings(),
            {
                "PTR_LLM_PROVIDER": "litellm",
                "PTR_LLM_LITELLM_BILLABLE": "1",
                **prices,
            },
        )
    assert FakePool.instances[-1].closed


async def test_runtime_does_not_duplicate_engine_turn_trace():
    from ptr_llm.runtime import Runtime

    class Engine:
        async def handle(self, grant, **options):
            return {"kind": "failed", "errorCode": "SYNTHETIC"}

    class Telemetry:
        def turn(self, *args, **kwargs):
            raise AssertionError("duplicate root trace")

    runtime = Runtime(None, None, Engine(), None, None, Telemetry(), "fake", "synthetic")
    assert (await runtime.handle({}))["errorCode"] == "SYNTHETIC"
