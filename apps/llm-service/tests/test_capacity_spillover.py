"""Synthetic budget-first capacity route contracts; no external calls."""

import json
import time

import httpx
import pytest
from persona_timeline_rag.gateway_budget import HEADER, sign_request, verify_request
from test_providers_billing import MESSAGES, response

from ptr_llm.billing import MemoryBudgetLedger, ProviderError
from ptr_llm.providers import LiteLLMTextProvider

KEY = "synthetic-budget-grant-secret-at-least-32-bytes"


def test_budget_grant_binds_generation_fields_and_expires():
    body = {"model": "primary", "messages": MESSAGES, "max_completion_tokens": 512}
    now = int(time.time() * 1000)
    signed = sign_request(body, KEY, "a" * 64, now + 25000, 20000)
    assert verify_request(body, signed, KEY, now_ms=now)[0] == "a" * 64
    for changed in [
        {**body, "messages": []},
        {**body, "max_completion_tokens": 4096},
        {**body, "response_format": {"type": "text"}},
    ]:
        with pytest.raises(ValueError):
            verify_request(changed, signed, KEY, now_ms=now)
    with pytest.raises(ValueError):
        verify_request(body, signed, KEY, now_ms=now + 25001)
    with pytest.raises(ValueError):
        verify_request(body, signed, "another-secret-key-at-least-32-characters", now_ms=now)


@pytest.mark.parametrize("route,cost", [("primary", 0), ("openrouter-primary", 100)])
async def test_committed_budget_signs_actual_sdk_body_and_settles_actual_route(route, cost):
    ledger = MemoryBudgetLedger()
    calls = []

    async def handler(request):
        body = json.loads(request.content)
        nonce, _, _ = verify_request(body, request.headers[HEADER], KEY)
        assert ledger.requests[nonce].state == "submitted"
        calls.append(body)
        return httpx.Response(200, headers={"x-litellm-model-id": route}, json=response())

    provider = LiteLLMTextProvider(
        base_url="https://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.1, "completion": 0.5},
        reservation_microusd=20000,
        capacity_spillover_key=KEY,
        transport=httpx.MockTransport(handler),
    )
    try:
        await provider.generate(MESSAGES, request_key="synthetic")
        await provider.generate(MESSAGES, request_key="synthetic")
        assert len(calls) == 1
        saved = next(iter(ledger.requests.values()))
        assert saved.actual_microusd == cost
        assert saved.response["upstream"] == route
    finally:
        await provider.aclose()


async def test_signed_route_cannot_bypass_global_budget_or_missing_price():
    with pytest.raises(ProviderError):
        LiteLLMTextProvider(
            base_url="https://synthetic.invalid/v1",
            model="primary",
            api_key="synthetic",
            capacity_spillover_key=KEY,
        )
    ledger = MemoryBudgetLedger(cap_microusd=1)
    provider = LiteLLMTextProvider(
        base_url="https://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.1, "completion": 0.5},
        capacity_spillover_key=KEY,
        transport=httpx.MockTransport(lambda _: pytest.fail("network before budget forbidden")),
    )
    try:
        with pytest.raises(ProviderError):
            await provider.generate(MESSAGES)
    finally:
        await provider.aclose()


@pytest.mark.parametrize("valid", [True, False])
async def test_paid_invoice_header_or_missing_cost_is_not_assumed_free(valid):
    ledger = MemoryBudgetLedger()
    calls = []

    async def handler(request):
        calls.append(request)
        headers = {"x-litellm-model-id": "openrouter-primary"}
        if valid:
            headers["llm_provider-x-litellm-response-cost"] = "0.000037"
        payload = response()
        payload["usage"].pop("cost")
        return httpx.Response(200, headers=headers, json=payload)

    p = LiteLLMTextProvider(
        base_url="https://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.1, "completion": 0.5},
        capacity_spillover_key=KEY,
        transport=httpx.MockTransport(handler),
    )
    try:
        await p.generate(MESSAGES, request_key="synthetic-invoice")
        saved = next(iter(ledger.requests.values()))
        assert saved.actual_microusd == (37 if valid else None)
        assert saved.state == ("settled" if valid else "unknown")
        await p.generate(MESSAGES, request_key="synthetic-invoice")
        assert len(calls) == 1
    finally:
        await p.aclose()


async def test_spillover_runtime_cannot_start_unsigned_or_nonbillable(monkeypatch):
    from test_runtime_composition import FakePool, _settings

    from ptr_llm import runtime

    monkeypatch.setattr(runtime, "AsyncConnectionPool", FakePool)
    before = len(FakePool.instances)
    for env in [
        {
            "PTR_LLM_PROVIDER": "litellm",
            "PTR_LLM_LITELLM_BILLABLE": "0",
            "PTR_LLM_CAPACITY_SPILLOVER_KEY": KEY,
        },
        {
            "PTR_LLM_PROVIDER": "litellm",
            "PTR_LLM_LITELLM_BILLABLE": "1",
            "PTR_LLM_CAPACITY_SPILLOVER_KEY": "short",
        },
    ]:
        with pytest.raises(ProviderError, match="BUDGET_AUTHORITY_REQUIRED"):
            await runtime.build_runtime(_settings(), env)
    assert len(FakePool.instances) == before
