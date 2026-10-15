"""Synthetic S1 startup and budget contracts."""

import subprocess
import sys
from contextlib import asynccontextmanager
from dataclasses import replace

import httpx
import pytest

from ptr_llm.billing import MemoryBudgetLedger, PostgresBudgetLedger, ProviderError
from ptr_llm.config import ConfigurationError, Settings
from ptr_llm.providers.openrouter import OpenRouterClient
from ptr_llm.runtime import build_runtime
from ptr_llm.server import create_app

URL = "postgresql://ptr_split_llm:synthetic@127.0.0.1:58432/ptr_split_test"
SETTINGS = Settings(
    redis_url="redis://127.0.0.1:58479/0",
    backend_url="http://127.0.0.1:58441",
    control_token="synthetic-control-key-that-is-long-enough",
    database_url=URL,
)


@pytest.mark.parametrize(
    ("changes", "code"),
    [
        ({"PTR_LLM_SPILLOVER": "openrouter"}, "INVALID_SPILLOVER_CONFIG"),
        ({"PTR_LLM_LOCAL_SLOTS": "0"}, "INVALID_RUNTIME_CONFIG"),
        ({"PTR_LLM_LOCAL_SLOTS": "257"}, "INVALID_RUNTIME_CONFIG"),
        ({"PTR_LLM_LOCAL_SLOTS": "bad"}, "INVALID_RUNTIME_CONFIG"),
        ({"PTR_LLM_SPILLOVER_WAIT_MS": "99"}, "INVALID_RUNTIME_CONFIG"),
        ({"PTR_LLM_SPILLOVER_WAIT_MS": "10001"}, "INVALID_RUNTIME_CONFIG"),
        ({"PTR_LLM_OPENROUTER_KEY_LIMIT_CHECK": "invalid"}, "INVALID_RUNTIME_CONFIG"),
        (
            {"PTR_LLM_SPILLOVER": "openrouter", "OPENROUTER_API_KEY": "synthetic"},
            "COMPOSE_OPENROUTER_KEYS_FORBIDDEN",
        ),
        (
            {
                "PTR_LLM_SPILLOVER": "openrouter",
                "PTR_LLM_LOCAL_SLOTS": "2",
                "OPENROUTER_API_KEY": "synthetic",
                "PTR_LLM_OPENROUTER_MODEL": "openai/gpt-4.1-nano",
            },
            "INVALID_SPILLOVER_CONFIG",
        ),
        (
            {
                "PTR_LLM_SPILLOVER": "openrouter",
                "PTR_LLM_LOCAL_SLOTS": "2",
                "OPENROUTER_API_KEY": "synthetic",
                "PTR_LLM_OPENROUTER_KEY_MAX_LIMIT_USD": "2",
            },
            "INVALID_RUNTIME_CONFIG",
        ),
    ],
)
async def test_compose_config_refusal_before_database(changes, code):
    env = {"PTR_LLM_PROVIDER": "local", **changes}
    with pytest.raises(ProviderError, match=code):
        await build_runtime(SETTINGS, env)


async def test_cluster_rejects_local_slots_before_database():
    with pytest.raises(ProviderError, match="INVALID_SPILLOVER_CONFIG"):
        await build_runtime(
            SETTINGS,
            {
                "PTR_LLM_PROVIDER": "local",
                "PTR_NETWORK_MODE": "cluster",
                "KUBERNETES_SERVICE_HOST": "synthetic.svc",
                "PTR_LLM_LOCAL_SLOTS": "2",
            },
        )


async def test_compose_keys_allowed_only_with_spill_and_slots():
    env = {
        "PTR_LLM_DATABASE_URL": URL,
        "PTR_LLM_CONTROL_TOKEN": "synthetic-control-key-that-is-long-enough",
        "OPENROUTER_API_KEY": "synthetic",
        "PTR_LLM_SPILLOVER": "openrouter",
        "PTR_LLM_LOCAL_SLOTS": "2",
    }
    assert Settings.from_env(env).database_url == URL
    with pytest.raises(ConfigurationError, match="COMPOSE_OPENROUTER_KEYS_FORBIDDEN"):
        Settings.from_env({**env, "PTR_LLM_SPILLOVER": "off"})


def test_settings_rejects_invalid_key_limit_check():
    with pytest.raises(ConfigurationError, match="INVALID_OPENROUTER_KEY_LIMIT_CHECK"):
        Settings.from_env(
            {
                "PTR_LLM_DATABASE_URL": URL,
                "PTR_LLM_CONTROL_TOKEN": "synthetic-control-key-that-is-long-enough",
                "PTR_LLM_OPENROUTER_KEY_LIMIT_CHECK": "invalid",
            }
        )


async def test_memory_ledger_remaining_is_read_only_and_tracks_reservations():
    ledger = MemoryBudgetLedger(cap_microusd=1000)
    assert await ledger.remaining_microusd() == 1000
    await ledger.reserve("synthetic", 300)
    assert await ledger.remaining_microusd() == 700
    assert ledger.requests["synthetic"].state == "reserved"
    await ledger.finish("synthetic", 100, None, None)
    assert await ledger.remaining_microusd() == 900


async def test_postgres_remaining_query_uses_read_only_budget_contract():
    statements = []

    class Cursor:
        async def execute(self, sql):
            assert sql.lstrip().startswith("SELECT")
            statements.append(sql)

        async def fetchone(self):
            if len(statements) == 1:
                return {
                    "cap_microusd": 1_000_000,
                    "call_cap": 10,
                    "baseline_committed_microusd": 0,
                    "extra_cap_microusd": 1_000_000,
                }
            return {"committed": 99, "calls": 1}

    class Connection:
        @asynccontextmanager
        async def cursor(self, **_):
            yield Cursor()

    class Pool:
        conninfo = URL
        kwargs = {}

        @asynccontextmanager
        async def connection(self):
            yield Connection()

    assert await PostgresBudgetLedger(Pool(), URL).remaining_microusd() == 999_901
    assert len(statements) == 2


async def test_fixture_flag_refuses_research_identity(monkeypatch):
    from test_runtime_composition import FakePool

    from ptr_llm import runtime

    monkeypatch.setattr(runtime, "AsyncConnectionPool", FakePool)
    monkeypatch.setattr(FakePool, "identity", {**FakePool.identity, "db": "ptr_split_research"})
    with pytest.raises(ProviderError, match="SYNTHETIC_FIXTURE_REQUIRES_TEST_DB"):
        await build_runtime(
            replace(SETTINGS, database_url=URL.replace("ptr_split_test", "ptr_split_research")),
            {"PTR_LLM_SYNTHETIC_PROVIDER_FIXTURE": "1"},
        )


async def test_runtime_owns_dedicated_slot_redis_and_closes_it(monkeypatch, tmp_path):
    from test_direct_local_spillover import _local_runtime_env
    from test_runtime_composition import FakePool

    from ptr_llm import runtime

    class SlotRedis:
        closed = False

        async def aclose(self):
            self.closed = True

    slot_redis = SlotRedis()
    urls = []

    def redis_from_url(url, **_):
        urls.append(url)
        return slot_redis

    monkeypatch.setattr(runtime, "AsyncConnectionPool", FakePool)
    monkeypatch.setattr("redis.asyncio.Redis.from_url", redis_from_url)
    built = await build_runtime(SETTINGS, _local_runtime_env(tmp_path, PTR_LLM_LOCAL_SLOTS="2"))
    try:
        assert urls == [SETTINGS.redis_url]
        assert not slot_redis.closed
    finally:
        await built.close()
    assert slot_redis.closed


def test_compose_loopback_fixture_requires_test_database_identity():
    options = {
        "api_key": "synthetic",
        "ledger": MemoryBudgetLedger(),
        "live_enabled": True,
        "allow_external_data": True,
        "base_url_override": "http://127.0.0.1:8999",
        "fixture_enabled": True,
        "cluster_mode": False,
    }
    client = OpenRouterClient(**options, fixture_database="ptr_split_test")
    assert client.base_url == "http://127.0.0.1:8999"
    with pytest.raises(ProviderError, match="OPENROUTER_URL_NOT_ALLOWED"):
        OpenRouterClient(**options, fixture_database="ptr_split_research")


async def test_worker_metrics_route_exposes_only_spillover_gauge():
    from ptr_llm import spillover_metrics
    spillover_metrics.set_available(True)
    app = create_app(SETTINGS, catalogue=lambda: None, draft=lambda _: None, runner=object())
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://synthetic"
    ) as client:
        response = await client.get("/metrics")
        assert response.status_code == 200
        assert "ptr_llm_spillover_available 1" in response.text
        assert "process_" not in response.text
        assert "python_info" not in response.text
        spillover_metrics.set_available(False)
        response = await client.get("/metrics")
        assert "ptr_llm_spillover_available 0" in response.text


def test_missing_prometheus_dependency_fails_at_import():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; sys.modules['prometheus_client'] = None; "
            "import ptr_llm.spillover_metrics",
        ],
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    assert result.returncode != 0
    assert "ModuleNotFoundError" in result.stderr
