"""Synthetic HTTP only: pooled transport ownership and cookie isolation."""

import asyncio

import httpx
import pytest

from ptr_llm.billing import MemoryBudgetLedger, ProviderError
from ptr_llm.providers.openrouter import OpenRouterClient


def client_for(transport):
    return OpenRouterClient(
        api_key="synthetic-key",
        ledger=MemoryBudgetLedger(cap_microusd=1_000_000),
        live_enabled=True,
        allow_external_data=True,
        transport=transport,
    )


async def test_one_lazy_pool_reused_without_cookies_and_closed_once(monkeypatch):
    created, requests, closed = [], [], []
    original = httpx.AsyncClient

    class Client(original):
        def __init__(self, *args, **kwargs):
            created.append(self)
            super().__init__(*args, **kwargs)

        async def aclose(self):
            closed.append(self)
            await super().aclose()

    def handler(request):
        requests.append(request)
        return httpx.Response(200, json={"ok": True}, headers={"set-cookie": "sid=secret; Path=/"})

    monkeypatch.setattr(httpx, "AsyncClient", Client)
    client = client_for(httpx.MockTransport(handler))
    assert created == []
    assert await client._fetch("/api/v1/models") == {"ok": True}
    assert await client._fetch("/api/v1/models") == {"ok": True}
    assert len(created) == 1 and closed == []
    assert all("cookie" not in r.headers for r in requests)
    assert list(created[0].cookies) == []
    await asyncio.gather(client.aclose(), client.aclose())
    await client.aclose()
    assert closed == created
    with pytest.raises(ProviderError, match="PROVIDER_CLOSED"):
        await client._fetch("/api/v1/models")
    assert len(requests) == 2


async def test_close_cancels_and_drains_paid_unknown_settlement_before_transport_close():
    entered, settled, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    order = []

    class Ledger(MemoryBudgetLedger):
        async def finish(self, key, cost, response, generation_id):
            if cost is None:
                settled.set()
                await release.wait()
                order.append("settled")
            return await super().finish(key, cost, response, generation_id)

    class Transport(httpx.MockTransport):
        async def aclose(self):
            order.append("transport")

    async def handler(request):
        entered.set()
        await asyncio.Event().wait()

    client = client_for(Transport(handler))
    client.ledger = Ledger(cap_microusd=1_000_000)
    client._text_verified = True
    operation = asyncio.create_task(client.generate([{"role": "user", "content": "synthetic"}]))
    await entered.wait()
    closing = asyncio.create_task(client.aclose())
    await asyncio.wait_for(settled.wait(), 1)
    assert not closing.done() and order == []
    release.set()
    await closing
    assert order == ["settled", "transport"]
    assert isinstance(
        (await asyncio.gather(operation, return_exceptions=True))[0], asyncio.CancelledError
    )
    assert next(iter(client.ledger.requests.values())).state == "unknown"


async def test_signal_then_shutdown_cannot_abandon_shielded_unknown_settlement():
    entered, settling, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    transport_closed = []

    class Ledger(MemoryBudgetLedger):
        async def finish(self, *args):
            settling.set()
            await release.wait()
            return await super().finish(*args)

    class Transport(httpx.MockTransport):
        async def aclose(self):
            transport_closed.append(True)

    async def handler(request):
        entered.set()
        await asyncio.Event().wait()

    client = client_for(Transport(handler))
    client.ledger, client._text_verified = Ledger(), True
    signal = asyncio.Event()
    call = asyncio.create_task(
        client.generate([{"role": "user", "content": "synthetic"}], signal=signal)
    )
    await entered.wait()
    signal.set()
    await settling.wait()
    close = asyncio.create_task(client.aclose())
    # Let cancellation pass through the native SDK/outer deadline cleanup.
    for _ in range(20):
        await asyncio.sleep(0)
    try:
        assert not close.done() and transport_closed == []
    finally:
        release.set()
        await close
        await asyncio.gather(call, return_exceptions=True)
    assert next(iter(client.ledger.requests.values())).state == "unknown"


async def test_cancelled_close_waiter_still_drains_before_returning_cancellation():
    entered, release = asyncio.Event(), asyncio.Event()

    class Transport(httpx.MockTransport):
        async def aclose(self):
            entered.set()
            await release.wait()

    client = client_for(Transport(lambda request: httpx.Response(200, json={})))
    await client._fetch("/synthetic")
    closing = asyncio.create_task(client.aclose())
    await entered.wait()
    closing.cancel()
    await asyncio.sleep(0)
    try:
        assert not closing.done()
    finally:
        release.set()
    assert isinstance(
        (await asyncio.gather(closing, return_exceptions=True))[0], asyncio.CancelledError
    )
    await client.aclose()


async def test_request_cancellation_does_not_close_or_cancel_shared_peer():
    blocked = asyncio.Event()

    async def handler(request):
        if request.url.path.endswith("slow"):
            blocked.set()
            await asyncio.Event().wait()
        return httpx.Response(200, json={"ok": True})

    client = client_for(httpx.MockTransport(handler))
    task = asyncio.create_task(client._fetch("/slow"))
    await blocked.wait()
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert await client._fetch("/fast") == {"ok": True}
    await client.aclose()


async def test_cancel_before_owned_task_starts_never_constructs_operation():
    client = client_for(httpx.MockTransport(lambda request: pytest.fail("No HTTP")))
    created = []

    def operation():
        created.append(True)
        return asyncio.sleep(0)

    task = asyncio.create_task(client._owned(operation))
    await asyncio.sleep(0)  # Ownership wrapper schedules the inner task for the next tick.
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    assert created == [] and client._active == set()
    await client.aclose()


async def test_closed_client_rejects_even_cached_pricing_and_all_public_paid_entrypoints():
    client = client_for(httpx.MockTransport(lambda request: pytest.fail("No HTTP")))
    client._text_verified = True
    await client.aclose()
    operations = [
        client.verify_pricing(),
        client.generate([]),
        client.decide({}),
        client.embed([]),
        client.reconcile("synthetic"),
    ]
    for operation in operations:
        with pytest.raises(ProviderError, match="PROVIDER_CLOSED"):
            await operation
    assert client.ledger.requests == {} and client._http_client is None


@pytest.mark.parametrize("fail_after_creation", [False, True])
async def test_runtime_owns_auxiliary_decision_client(monkeypatch, fail_after_creation):
    from test_runtime_composition import FakePool, _settings

    from ptr_llm import runtime as module

    clients = []

    class Auxiliary:
        def __init__(self, **kwargs):
            self.closed = 0
            clients.append(self)

        async def aclose(self):
            self.closed += 1

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    monkeypatch.setattr(module, "OpenRouterClient", Auxiliary)
    env = {"PTR_LLM_INTENT_CLASSIFIER": "jev"}
    if fail_after_creation:
        env["PTR_LLM_JEV_MIN_CONFIDENCE"] = "invalid"
        with pytest.raises(ProviderError, match="INVALID_RUNTIME_CONFIG"):
            await module.build_runtime(_settings(), env)
    else:
        runtime = await module.build_runtime(_settings(), env)
        await runtime.close()
    assert clients[0].closed == 1
    assert FakePool.instances[-1].closed


@pytest.mark.parametrize("failure", [None, "pricing", "build", "cancel"])
async def test_live_summary_ingestion_always_closes_client(monkeypatch, tmp_path, failure):
    from argparse import Namespace
    from contextlib import asynccontextmanager
    from unittest.mock import AsyncMock

    from ptr_llm.ingestion import summaries
    from ptr_llm.providers import openrouter

    closed = []

    class Client:
        def __init__(self, **kwargs):
            pass

        async def verify_pricing(self):
            if failure == "pricing":
                raise ProviderError("PRICING_UNVERIFIED")

        async def aclose(self):
            closed.append(True)

    class Connection:
        async def execute(self, *args):
            return self

        async def fetchone(self):
            return None

        async def fetchall(self):
            return []

    class Pool:
        @asynccontextmanager
        async def connection(self):
            yield Connection()

    class Ledger:
        def __init__(self, *args):
            pass

        async def exposure(self):
            return 0

    error = asyncio.CancelledError() if failure == "cancel" else ProviderError("BUILD_FAILED")
    build = AsyncMock(
        return_value={"posts": 0}, side_effect=error if failure in ("build", "cancel") else None
    )
    monkeypatch.setattr(openrouter, "OpenRouterClient", Client)
    monkeypatch.setattr(summaries, "RunLedger", Ledger)
    monkeypatch.setattr(summaries, "PostgresBudgetLedger", lambda *args: None)
    monkeypatch.setattr(summaries, "build_index", build)
    args = Namespace(
        max_usd=1,
        budget_record=str(tmp_path / "budget.json"),
        run="synthetic",
        model="synthetic",
        concurrency=1,
        activate=False,
    )
    operation = summaries.execute_live(args, {}, "synthetic-url", Pool(), None, {})
    if failure:
        with pytest.raises(asyncio.CancelledError if failure == "cancel" else ProviderError):
            await operation
    else:
        assert await operation == {"posts": 0, "newExposureMicrousd": 0}
    assert closed == [True]
