"""Direct chat accounting uses its existing receipt; synthetic mock transport only."""

import math
from contextlib import contextmanager

import httpx
import pytest

from ptr_llm.billing import MemoryBudgetLedger, ProviderError
from ptr_llm.providers import OpenRouterClient
from ptr_llm.runtime import ObservedProvider


class Telemetry:
    def __init__(self):
        self.generations = []

    @contextmanager
    def observation(self, *args, **kwargs):
        updates = []
        self.generations.append(updates)

        class Span:
            def update(self, **kwargs):
                updates.append(kwargs)

        yield Span()


@pytest.mark.parametrize("reported", [0.000123, 0, None, float("nan")])
async def test_fresh_and_replayed_receipt_cost_without_resubmit_or_fake_unknown(reported):
    ledger, calls, telemetry = MemoryBudgetLedger(), [], Telemetry()

    async def transport(request):
        calls.append(request.url.path)
        assert request.url.path == "/api/v1/chat/completions"
        # NaN is represented as an invalid string rather than invalid wire JSON.
        value = "NaN" if reported != reported else reported
        return httpx.Response(
            200,
            json={
                "id": "synthetic-generation",
                "model": client.model,
                "choices": [{"message": {"content": "synthetic reply"}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2, "cost": value},
            },
        )

    client = OpenRouterClient(
        api_key="synthetic",
        ledger=ledger,
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(transport),
    )
    # This test targets receipt accounting, not provider catalog validation.
    client._text_verified = True
    observed = ObservedProvider(client, telemetry, client.model)
    costs, usage = [], []
    messages = [{"role": "user", "content": "PRIVATE_SYNTHETIC_NOT_EXPORTED"}]
    for _ in range(2):
        assert (
            await observed.generate(
                messages,
                request_key="synthetic-receipt",
                on_cost=costs.append,
                on_usage=usage.append,
            )
            == "synthetic reply"
        )
    assert calls == ["/api/v1/chat/completions"] and len(ledger.requests) == 1
    receipt = next(iter(ledger.requests.values()))
    valid = reported is not None and reported == reported
    expected_cost = math.ceil(reported * 1_000_000) if valid else None
    assert costs == [expected_cost, expected_cost]
    assert usage == [{"promptTokens": 3, "completionTokens": 2}] * 2
    assert receipt.state == ("settled" if valid else "unknown")
    for updates in telemetry.generations:
        cost_updates = [item["cost_details"] for item in updates if "cost_details" in item]
        assert cost_updates == ([{"total": expected_cost / 1_000_000}] if valid else [])
        assert "PRIVATE_SYNTHETIC" not in repr(updates)


async def test_http_failure_keeps_unknown_cost_and_does_not_resubmit():
    ledger, calls, telemetry = MemoryBudgetLedger(), [], Telemetry()

    async def transport(request):
        calls.append(True)
        return httpx.Response(503, json={"error": "synthetic"})

    client = OpenRouterClient(
        api_key="synthetic",
        ledger=ledger,
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(transport),
    )
    client._text_verified = True
    observed = ObservedProvider(client, telemetry, client.model)
    for code in ("PROVIDER_HTTP_503", "REQUEST_UNRESOLVED_NO_RESUBMIT"):
        with pytest.raises(ProviderError, match=code):
            await observed.generate(
                [{"role": "user", "content": "synthetic"}], request_key="synthetic-error"
            )
    assert len(calls) == 1 and len(ledger.requests) == 1
    assert next(iter(ledger.requests.values())).state == "unknown"
    assert not any("cost_details" in update for run in telemetry.generations for update in run)
