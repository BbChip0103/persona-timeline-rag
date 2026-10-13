"""Synthetic budget-first capacity route contracts; no external calls."""

import json
import time

import httpx
import pytest
from persona_timeline_rag.gateway_budget import (
    HEADER,
    sign_request,
    verify_request,
    verify_request_authority,
)
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


@pytest.mark.parametrize(
    "route,cost",
    [("primary", 0), ("secondary", 0), ("local-pool", 0), ("openrouter-primary", 100)],
)
async def test_committed_budget_signs_actual_sdk_body_and_settles_actual_route(route, cost):
    ledger = MemoryBudgetLedger()
    calls = []

    async def handler(request):
        body = json.loads(request.content)
        nonce, _, _ = verify_request(body, request.headers[HEADER], KEY)
        assert ledger.requests[nonce].state == "submitted"
        calls.append(body)
        headers = {"x-litellm-model-id": route}
        if route == "openrouter-primary":
            headers["llm_provider-x-litellm-response-cost"] = "0.0001"
        return httpx.Response(
            200,
            headers=headers,
            json=response(cost=0.0001 if route == "openrouter-primary" else None),
        )

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
        assert saved.state == "settled"
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
        return httpx.Response(200, headers=headers, json=response())

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
        if valid:
            await p.generate(MESSAGES, request_key="synthetic-invoice")
        else:
            with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
                await p.generate(MESSAGES, request_key="synthetic-invoice")
        assert len(calls) == 1
    finally:
        await p.aclose()


async def test_paid_invoice_cost_uses_decimal_micro_usd_rounding():
    ledger = MemoryBudgetLedger()

    async def handler(request):
        payload = response(cost=0.000123)
        return httpx.Response(
            200,
            json=payload,
            headers={
                "x-litellm-model-id": "openrouter-primary",
                "llm_provider-x-litellm-response-cost": "0.000123",
            },
        )

    provider = LiteLLMTextProvider(
        base_url="https://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.1, "completion": 0.5},
        capacity_spillover_key=KEY,
        transport=httpx.MockTransport(handler),
    )
    try:
        await provider.generate(MESSAGES, request_key="synthetic-decimal-invoice")
        assert next(iter(ledger.requests.values())).actual_microusd == 123
    finally:
        await provider.aclose()


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


@pytest.mark.parametrize("reason", ["rejected-saturated", "rejected-ttl-expired"])
async def test_epp_drop_makes_one_paid_call_and_settles_actual_cost(reason):
    ledger = MemoryBudgetLedger()
    calls = []
    served = []

    async def handler(request):
        body = json.loads(request.content)
        calls.append(body["model"])
        if len(calls) == 1:
            original_nonce = verify_request(body, request.headers[HEADER], KEY)[0]
            calls.append(original_nonce)
            return httpx.Response(
                429,
                headers={"llm_provider-x-llm-d-request-dropped-reason": reason},
                json={"error": {"message": "synthetic drop", "type": "throttling_error"}},
            )
        assert body["model"] == "openrouter-primary"
        authority = verify_request_authority(body, request.headers[HEADER], KEY)
        assert authority.spillover_for_nonce == calls[1]
        return httpx.Response(
            200,
            headers={
                "x-litellm-model-id": "openrouter-primary",
                "llm_provider-x-litellm-response-cost": "0.000037",
            },
            json=response(),
        )

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
        await provider.generate(MESSAGES, request_key=reason, on_served=served.append)
        assert calls[0] == "primary"
        assert calls[2] == "openrouter-primary"
        assert len(calls) == 3
        assert served == ["openrouter-primary"]
        saved = next(iter(ledger.requests.values()))
        assert saved.actual_microusd == 37
        assert saved.state == "settled"
    finally:
        await provider.aclose()


@pytest.mark.parametrize(
    "paid_failure",
    [
        "missing-cost",
        "missing-cost-local-pool",
        "missing-cost-primary",
        "missing-cost-secondary",
        "timeout",
        "http-500",
    ],
)
async def test_local_drop_cannot_poison_paid_spillover_cost_as_free(paid_failure):
    ledger = MemoryBudgetLedger()
    calls = []

    async def handler(request):
        body = json.loads(request.content)
        calls.append(body["model"])
        if len(calls) == 1:
            return httpx.Response(
                429,
                headers={
                    "x-litellm-model-id": "local-pool",
                    "llm_provider-x-llm-d-request-dropped-reason": "rejected-saturated",
                },
                json={"error": {"message": "synthetic drop", "type": "throttling_error"}},
            )
        assert body["model"] == "openrouter-primary"
        if paid_failure == "timeout":
            raise httpx.ReadTimeout("synthetic paid timeout", request=request)
        if paid_failure == "http-500":
            return httpx.Response(
                500,
                headers={"x-litellm-model-id": "openrouter-primary"},
                json={"error": {"message": "synthetic paid failure", "type": "synthetic_error"}},
            )
        return httpx.Response(
            200,
            headers={
                "x-litellm-model-id": (
                    paid_failure.removeprefix("missing-cost-")
                    if paid_failure.startswith("missing-cost-")
                    else "openrouter-primary"
                )
            },
            json=response(),
        )

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
        if paid_failure.startswith("missing-cost"):
            await provider.generate(MESSAGES, request_key=paid_failure)
        else:
            with pytest.raises(ProviderError):
                await provider.generate(MESSAGES, request_key=paid_failure)
        saved = next(iter(ledger.requests.values()))
        assert saved.state == "unknown"
        assert saved.actual_microusd is None
        with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
            await provider.generate(MESSAGES, request_key=paid_failure)
        assert calls == ["primary", "openrouter-primary"]
    finally:
        await provider.aclose()


@pytest.mark.parametrize(
    "status,reason",
    [
        (503, None),
        (500, None),
        (500, "rejected-saturated"),
        (429, None),
        (429, "rejected-context-cancelled"),
    ],
)
async def test_non_drop_errors_never_make_paid_call(status, reason):
    calls = []
    ledger = MemoryBudgetLedger()

    async def handler(request):
        calls.append(json.loads(request.content)["model"])
        headers = {"x-litellm-model-id": "primary"}
        if reason:
            headers["llm_provider-x-llm-d-request-dropped-reason"] = reason
        return httpx.Response(
            status,
            headers=headers,
            json={"error": {"message": "synthetic failure", "type": "synthetic_error"}},
        )

    provider = LiteLLMTextProvider(
        base_url="https://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.1, "completion": 0.5},
        capacity_spillover_key=KEY,
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderError):
            await provider.generate(MESSAGES, request_key=f"negative-{status}-{reason}")
        assert calls == ["primary"]
        saved = next(iter(ledger.requests.values()))
        assert saved.state == "unknown"
        assert saved.actual_microusd is None
    finally:
        await provider.aclose()


async def test_timeout_never_makes_paid_call():
    calls = []

    async def handler(request):
        calls.append(json.loads(request.content)["model"])
        raise httpx.ReadTimeout("synthetic timeout", request=request)

    provider = LiteLLMTextProvider(
        base_url="https://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        pricing_ceiling={"prompt": 0.1, "completion": 0.5},
        capacity_spillover_key=KEY,
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderError):
            await provider.generate(MESSAGES, request_key="negative-timeout")
        assert calls == ["primary"]
    finally:
        await provider.aclose()
