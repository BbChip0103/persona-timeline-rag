"""Synthetic regression cases for submit-boundary fallback."""

import asyncio
import logging
import time

import httpx
import pytest
from test_direct_local_spillover import _embedding_models_response, _openrouter_models_response
from zdr_fixture import zdr_endpoint

from ptr_llm.billing import MemoryBudgetLedger, ProviderError, SpilloverNotSubmitted
from ptr_llm.providers.local import DirectLocalTextProvider
from ptr_llm.providers.openrouter import OpenRouterClient

MESSAGES = [{"role": "user", "content": "synthetic hello"}]


def local_response() -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "id": "synthetic-local",
            "model": "local/synthetic",
            "choices": [
                {
                    "message": {"role": "assistant", "content": "local result"},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 2, "completion_tokens": 2, "total_tokens": 4},
        },
    )


@pytest.mark.parametrize(
    "code",
    [
        "BUDGET_EXCEEDED",
        "PRICING_UNVERIFIED",
        "INPUT_LIMIT",
        "STRUCTURED_OUTPUT_UNAVAILABLE",
        "BUDGET_NOT_INITIALIZED",
        "REQUEST_UNRESOLVED_NO_RESUBMIT",
        "CANCELLED",
    ],
)
async def test_first_epp_capacity_refusal_retries_local_without_second_spill(code):
    from ptr_llm import spillover_metrics

    local_calls = []
    paid_calls = []

    async def local_handler(_request):
        local_calls.append(True)
        if len(local_calls) == 1:
            return httpx.Response(
                429,
                headers={"x-llm-d-request-dropped-reason": "rejected-saturated"},
                json={"error": "synthetic"},
            )
        return local_response()

    class Paid:
        async def generate(self, *_args, **_kwargs):
            paid_calls.append(True)
            raise SpilloverNotSubmitted(code)

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/synthetic",
        cluster_mode=False,
        paid_spillover=Paid(),
        transport=httpx.MockTransport(local_handler),
    )
    provider.spillover_enabled = True
    if code == "BUDGET_EXCEEDED":
        spillover_metrics.set_available(True)
    try:
        assert (
            await provider.generate(MESSAGES, deadline_at=time.time() * 1000 + 30_000)
            == "local result"
        )
        assert len(local_calls) == 2
        assert len(paid_calls) == 1
        if code == "BUDGET_EXCEEDED":
            assert not spillover_metrics._available
    finally:
        await provider.aclose()


async def test_post_submit_failure_does_not_retry_local():
    local_calls = []

    async def local_handler(_request):
        local_calls.append(True)
        return httpx.Response(
            429,
            headers={"x-llm-d-request-dropped-reason": "rejected-saturated"},
            json={"error": "synthetic"},
        )

    class Paid:
        async def generate(self, *_args, **_kwargs):
            raise ProviderError("PROVIDER_HTTP_500")

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/synthetic",
        paid_spillover=Paid(),
        transport=httpx.MockTransport(local_handler),
    )
    provider.spillover_enabled = True
    try:
        with pytest.raises(ProviderError, match="PROVIDER_HTTP_500"):
            await provider.generate(MESSAGES, deadline_at=time.time() * 1000 + 30_000)
        assert len(local_calls) == 1
    finally:
        await provider.aclose()


async def test_cluster_retries_epp_without_resubmitting_paid(monkeypatch):
    from ptr_llm.spillover_metrics import render

    def retry_count() -> float:
        line = next(
            line for line in render().decode().splitlines()
            if line.startswith("ptr_llm_local_capacity_retries_total ")
        )
        return float(line.split()[-1])

    retries_before = retry_count()
    monkeypatch.setattr("ptr_llm.providers.local.random.uniform", lambda _a, _b: 0.25)
    local_calls = []
    paid_calls = []
    metrics = []

    async def local_handler(_request):
        local_calls.append(True)
        if len(local_calls) < 4:
            return httpx.Response(
                429,
                headers={"x-llm-d-request-dropped-reason": "rejected-saturated"},
                json={"error": "synthetic"},
            )
        return local_response()

    class Paid:
        async def generate(self, *_args, **_kwargs):
            paid_calls.append(True)
            raise SpilloverNotSubmitted("BUDGET_EXCEEDED")

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/synthetic",
        paid_spillover=Paid(),
        transport=httpx.MockTransport(local_handler),
        on_metrics=metrics.append,
    )
    provider.spillover_enabled = True
    try:
        assert (
            await provider.generate(MESSAGES, deadline_at=time.time() * 1000 + 30_000)
            == "local result"
        )
        assert len(local_calls) == 4
        assert len(paid_calls) == 1
        assert metrics[-1]["attempts"] == 4
        assert retry_count() - retries_before == 3
    finally:
        await provider.aclose()


async def test_compose_spills_only_after_two_second_slot_wait():
    class Slots:
        def __init__(self):
            self.acquires = 0

        async def acquire(self, *_):
            self.acquires += 1
            return False

    class Paid:
        async def generate(self, *_args, **_kwargs):
            return "paid result"

    slots = Slots()
    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/synthetic",
        local_slots=slots,
        paid_spillover=Paid(),
        spillover_wait_ms=2000,
        transport=httpx.MockTransport(lambda _: pytest.fail("local must not run")),
    )
    provider.spillover_enabled = True
    started = time.monotonic()
    try:
        assert (
            await provider.generate(MESSAGES, deadline_at=time.time() * 1000 + 30_000)
            == "paid result"
        )
        elapsed = time.monotonic() - started
        assert 2 <= elapsed < 3
        assert slots.acquires >= 35
    finally:
        await provider.aclose()


async def test_compose_pre_submit_refusal_keeps_waiting_for_slot():
    paid_calls = []
    local_calls = []

    class Slots:
        releases = []

        async def acquire(self, *_):
            return bool(paid_calls)

        async def release(self, lease):
            self.releases.append(lease)

    class Paid:
        async def generate(self, *_args, **_kwargs):
            paid_calls.append(True)
            raise SpilloverNotSubmitted("PRICING_UNVERIFIED")

    async def local_handler(_request):
        local_calls.append(True)
        return local_response()

    slots = Slots()
    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/synthetic",
        local_slots=slots,
        paid_spillover=Paid(),
        spillover_wait_ms=100,
        transport=httpx.MockTransport(local_handler),
    )
    provider.spillover_enabled = True
    try:
        assert (
            await provider.generate(MESSAGES, deadline_at=time.time() * 1000 + 30_000)
            == "local result"
        )
        assert len(paid_calls) == 1
        assert len(local_calls) == 1
        assert len(slots.releases) == 1
    finally:
        await provider.aclose()


async def test_compose_slot_released_when_signal_cancels_local_call():
    signal = asyncio.Event()

    class Slots:
        releases = []

        async def acquire(self, *_):
            return True

        async def release(self, lease):
            self.releases.append(lease)

    async def local_handler(_request):
        await asyncio.Event().wait()
        return local_response()

    slots = Slots()
    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/synthetic",
        local_slots=slots,
        transport=httpx.MockTransport(local_handler),
    )
    task = asyncio.create_task(provider.generate(MESSAGES, signal=signal))
    try:
        await asyncio.sleep(0.1)
        signal.set()
        with pytest.raises(ProviderError, match="CANCELLED"):
            await asyncio.wait_for(task, 1)
        assert len(slots.releases) == 1
    finally:
        await provider.aclose()


async def test_compose_redis_acquire_error_never_spills():
    class Slots:
        async def acquire(self, *_):
            raise ProviderError("LOCAL_SLOT_UNAVAILABLE")

    class Paid:
        async def generate(self, *_args, **_kwargs):
            pytest.fail("paid spill must not run after Redis error")

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/synthetic",
        local_slots=Slots(),
        paid_spillover=Paid(),
        transport=httpx.MockTransport(lambda _: pytest.fail("local must not run")),
    )
    provider.spillover_enabled = True
    try:
        with pytest.raises(ProviderError, match="LOCAL_SLOT_UNAVAILABLE"):
            await provider.generate(MESSAGES)
    finally:
        await provider.aclose()


async def test_chat_pre_submit_budget_refusal_has_special_type_and_no_submission():
    ledger = MemoryBudgetLedger(cap_microusd=0)
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=ledger,
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(lambda _: pytest.fail("network")),
    )
    client._text_verified = True
    try:
        with pytest.raises(SpilloverNotSubmitted) as raised:
            await client.generate(MESSAGES, require_zdr=True)
        assert raised.value.code == "BUDGET_EXCEEDED"
        assert ledger.requests == {}
    finally:
        await client.aclose()


async def test_pre_submit_deadline_remains_plain_provider_deadline():
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(lambda _: pytest.fail("network")),
    )
    try:
        with pytest.raises(ProviderError) as raised:
            await client.generate(MESSAGES, deadline_at=time.time() * 1000 - 1)
        assert type(raised.value) is ProviderError
        assert raised.value.code == "PROVIDER_DEADLINE"
    finally:
        await client.aclose()


async def test_closed_chat_client_is_pre_submit_refusal():
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
    )
    await client.aclose()
    with pytest.raises(SpilloverNotSubmitted) as raised:
        await client.generate(MESSAGES, require_zdr=True)
    assert raised.value.code == "PROVIDER_CLOSED"


async def test_missing_deepinfra_zdr_disables_spill_and_recheck_refreshes_cache():
    paths = []
    zdr_present = False

    async def handler(request):
        nonlocal zdr_present
        paths.append(request.url.path)
        if request.url.path == "/api/v1/models":
            return httpx.Response(200, json=_openrouter_models_response())
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        if request.url.path == "/api/v1/endpoints/zdr":
            rows = (
                [zdr_endpoint()]
                if zdr_present
                else [zdr_endpoint(provider_name="OpenAI", tag="openai")]
            )
            return httpx.Response(200, json={"data": rows})
        raise AssertionError("no submission")

    paid = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        transport=httpx.MockTransport(handler),
    )

    async def key_check(_):
        return True

    paid.verify_key_limit = key_check
    local = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/synthetic",
        paid_spillover=paid,
    )
    try:
        await local.start_spillover_checks(1, interval_seconds=0.01)
        assert not local.spillover_enabled
        assert paid._text_verified
        zdr_present = True
        async with asyncio.timeout(1):
            while not local.spillover_enabled:
                await asyncio.sleep(0.01)
        assert paths.count("/api/v1/models") >= 2
        assert paths.count("/api/v1/endpoints/zdr") >= 2
    finally:
        await local.aclose()
        await paid.aclose()


async def test_recheck_survives_ledger_exception_and_recovers(caplog):
    from ptr_llm import spillover_metrics

    checks = 0
    allow_recovery = asyncio.Event()

    class Paid:
        _chat_zdr_available = True

        async def verify_key_limit(self, _):
            return True

        async def verify_pricing(self):
            return None

        async def spillover_budget_available(self):
            nonlocal checks
            checks += 1
            if checks == 2:
                raise ConnectionError("synthetic private detail")
            if checks == 3:
                await allow_recovery.wait()
            return True

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1", model="local/synthetic", paid_spillover=Paid()
    )
    with caplog.at_level(logging.WARNING):
        try:
            await provider.start_spillover_checks(1, interval_seconds=0.01)
            async with asyncio.timeout(1):
                while checks < 2 or provider.spillover_enabled:
                    await asyncio.sleep(0.005)
            assert not spillover_metrics._available
            allow_recovery.set()
            async with asyncio.timeout(1):
                while checks < 3 or not provider.spillover_enabled:
                    await asyncio.sleep(0.005)
            assert "ConnectionError" in caplog.text
            assert "synthetic private detail" not in caplog.text
        finally:
            allow_recovery.set()
            await provider.aclose()


async def test_spill_requires_deepinfra_zdr_before_submit():
    ledger = MemoryBudgetLedger()
    submitted = []

    async def handler(request):
        submitted.append(request.url.path)
        pytest.fail("spill must not submit without DeepInfra ZDR")

    paid = OpenRouterClient(
        api_key="synthetic", ledger=ledger, live_enabled=True, allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it", transport=httpx.MockTransport(handler),
    )
    paid._text_verified = True
    paid._chat_zdr_available = False
    try:
        with pytest.raises(SpilloverNotSubmitted) as raised:
            await paid.generate(MESSAGES, require_zdr=True)
        assert raised.value.code == "ZDR_UNAVAILABLE"
        assert submitted == []
        assert ledger.requests == {}
    finally:
        await paid.aclose()


async def test_reverify_keeps_verified_cache_until_atomic_success():
    entered = asyncio.Event()
    release = asyncio.Event()
    zdr_present = False

    async def handler(request):
        if request.url.path == "/api/v1/models":
            entered.set()
            await release.wait()
            return httpx.Response(200, json=_openrouter_models_response())
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        if request.url.path == "/api/v1/endpoints/zdr":
            rows = (
                [zdr_endpoint()]
                if zdr_present
                else [zdr_endpoint(provider_name="OpenAI", tag="openai")]
            )
            return httpx.Response(200, json={"data": rows})
        pytest.fail("no paid submission")

    paid = OpenRouterClient(
        api_key="synthetic", ledger=MemoryBudgetLedger(), live_enabled=True,
        allow_external_data=True, text_model="google/gemma-4-26b-a4b-it",
        transport=httpx.MockTransport(handler),
    )
    paid._text_verified = True
    paid._chat_zdr_available = True
    try:
        recheck = asyncio.create_task(paid.reverify_spillover())
        await asyncio.wait_for(entered.wait(), 1)
        assert paid._text_verified
        assert paid._chat_zdr_available
        release.set()
        await asyncio.wait_for(recheck, 1)
        assert paid._text_verified
        assert not paid._chat_zdr_available
    finally:
        release.set()
        await paid.aclose()


@pytest.mark.parametrize("reason", ["disabled", "budget", "zdr"])
async def test_cluster_capacity_retries_when_spill_unavailable(monkeypatch, reason):
    monkeypatch.setattr("ptr_llm.providers.local.random.uniform", lambda _a, _b: 0.25)
    local_calls = []
    paid_calls = []

    async def local_handler(_request):
        local_calls.append(True)
        if len(local_calls) == 1:
            return httpx.Response(
                429,
                headers={"x-llm-d-request-dropped-reason": "rejected-saturated"},
                json={"error": "synthetic"},
            )
        return local_response()

    class Paid:
        async def generate(self, *_args, **_kwargs):
            paid_calls.append(True)
            raise SpilloverNotSubmitted("ZDR_UNAVAILABLE" if reason == "zdr" else "BUDGET_EXCEEDED")

    provider = DirectLocalTextProvider(
        base_url="http://synthetic.svc:8111/v1", model="local/synthetic",
        cluster_mode=True, paid_spillover=Paid(), transport=httpx.MockTransport(local_handler),
    )
    provider.spillover_enabled = reason != "disabled"
    try:
        if reason == "budget":
            assert (
                await provider.generate(MESSAGES, deadline_at=time.time() * 1000 + 30_000)
                == "local result"
            )
            assert not provider.spillover_enabled
            local_calls.clear()
        assert (
            await provider.generate(MESSAGES, deadline_at=time.time() * 1000 + 30_000)
            == "local result"
        )
        assert len(local_calls) == 2
        assert len(paid_calls) == (1 if reason in ("budget", "zdr") else 0)
    finally:
        await provider.aclose()


async def test_slot_release_failure_does_not_discard_success(caplog):
    class Slots:
        async def acquire(self, *_):
            return True

        async def release(self, _):
            raise ProviderError("LOCAL_SLOT_UNAVAILABLE")

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1", model="local/synthetic",
        local_slots=Slots(), transport=httpx.MockTransport(lambda _: local_response()),
    )
    with caplog.at_level(logging.WARNING):
        try:
            assert await provider.generate(MESSAGES) == "local result"
            assert "LOCAL_SLOT_UNAVAILABLE" in caplog.text
        finally:
            await provider.aclose()


async def test_cancel_after_successful_acquire_releases_ambiguous_lease():
    signal = asyncio.Event()
    releases = []

    class Slots:
        async def acquire(self, lease, _ttl):
            signal.set()
            return True

        async def release(self, lease):
            releases.append(lease)

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1", model="local/synthetic",
        local_slots=Slots(),
        transport=httpx.MockTransport(lambda _: pytest.fail("local must not run")),
    )
    try:
        with pytest.raises(ProviderError, match="CANCELLED"):
            await provider.generate(MESSAGES, signal=signal)
        assert len(releases) == 1
    finally:
        await provider.aclose()


async def test_direct_openrouter_preserves_pre_submit_provider_code():
    client = OpenRouterClient(
        api_key="synthetic", ledger=MemoryBudgetLedger(), live_enabled=True,
        allow_external_data=True, transport=httpx.MockTransport(lambda _: pytest.fail("network")),
    )
    client._text_verified = True
    try:
        with pytest.raises(ProviderError) as raised:
            await client.generate(MESSAGES, require_zdr=False, response_schema="synthetic-invalid")
        assert type(raised.value) is ProviderError
        assert raised.value.code == "INVALID_INPUT"
    finally:
        await client.aclose()
