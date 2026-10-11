"""Migration regressions: synthetic composition and stalled receipt I/O only."""

import asyncio

import pytest
from test_runtime_composition import FakePool, _settings
from test_worker_control import setup

from ptr_llm.billing import ProviderError
from ptr_llm.control import ControlUnavailable
from ptr_llm.worker import ExecutionStopped


def billable_env(**values):
    return {
        "PTR_LLM_PROVIDER": "litellm",
        "PTR_LLM_LITELLM_BILLABLE": "1",
        "PTR_LLM_PROMPT_USD_PER_M": "0.1",
        "PTR_LLM_COMPLETION_USD_PER_M": "0.3",
        "PTR_LLM_LITELLM_BASE_URL": "http://127.0.0.1:1/v1",
        "PTR_LLM_LITELLM_API_KEY": "synthetic-not-a-provider-key",
        **values,
    }


@pytest.mark.parametrize(
    "consent",
    [
        {},
        {"PTR_LLM_LIVE_ENABLED": "1"},
        {"PTR_LLM_ALLOW_EXTERNAL_DATA": "1"},
        {"PTR_LLM_LIVE_ENABLED": "true", "PTR_LLM_ALLOW_EXTERNAL_DATA": "1"},
    ],
)
async def test_billable_proxy_requires_both_explicit_consents_before_pool(monkeypatch, consent):
    from ptr_llm import runtime as module

    def forbidden_pool(**_):
        pytest.fail("Consent must be validated before DB pool construction")

    monkeypatch.setattr(module, "AsyncConnectionPool", forbidden_pool)
    with pytest.raises(ProviderError, match="LIVE_NOT_ENABLED"):
        await module.build_runtime(_settings(), billable_env(**consent))


async def test_billable_proxy_with_both_consents_is_accepted_without_network(monkeypatch, tmp_path):
    from ptr_llm import runtime as module

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    registry = tmp_path / "synthetic-publication.json"
    registry.write_text('{"database":"ptr_split_test","personas":[]}', encoding="utf-8")
    built = await module.build_runtime(
        _settings(),
        billable_env(
            PTR_LLM_LIVE_ENABLED="1",
            PTR_LLM_ALLOW_EXTERNAL_DATA="1",
            PTR_LLM_PUBLISHED_PERSONAS_FILE=str(registry),
        ),
    )
    assert built.provider.provider.ledger is not None
    await built.close()


async def test_factory_preserves_historical_classifier_configuration(monkeypatch):
    from ptr_llm import runtime as module

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    built = await module.build_runtime(_settings(), {})
    assert built.domain_engine.classifier_timeout_ms == 1500
    assert built.domain_engine.min_intent_confidence == 0.6
    assert built.domain_engine.safety_timeout_ms == 2500
    await built.close()


@pytest.mark.parametrize("operation", ["get_result", "put_result", "mark_result_ack"])
async def test_stalled_receipt_io_has_a_bounded_exit(operation):
    runner, job, _, _, store, _ = setup()
    from dataclasses import replace

    runner.settings = replace(runner.settings, backend_timeout=0.03)
    entered = asyncio.Event()

    async def stalled(*_):
        entered.set()
        await asyncio.Event().wait()

    setattr(store, operation, stalled)
    task = asyncio.create_task(runner.process(job, "synthetic-token"))
    await asyncio.wait_for(entered.wait(), 0.5)
    try:
        done, _ = await asyncio.wait({task}, timeout=0.3)
        assert task in done, "Receipt DB I/O ignored its configured operation timeout"
        with pytest.raises((ControlUnavailable, ExecutionStopped)):
            await task
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_cancel_during_receipt_read_stops_before_io_timeout():
    runner, job, control, engine, store, _ = setup()
    entered = asyncio.Event()

    async def stalled(*_):
        entered.set()
        await asyncio.Event().wait()

    store.get_result = stalled
    task = asyncio.create_task(runner.process(job, "synthetic-token"))
    await asyncio.wait_for(entered.wait(), 0.5)
    control.status_value = "cancelled"
    try:
        done, _ = await asyncio.wait({task}, timeout=0.2)
        assert task in done, "Cancellation monitoring was absent during receipt read"
        with pytest.raises(ExecutionStopped, match="EXECUTION_CANCELLED"):
            await task
        assert engine.calls == 0
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_factory_classifier_overrides_and_independent_timeouts(monkeypatch):
    from ptr_llm import runtime as module

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    built = await module.build_runtime(
        _settings(),
        {
            "PTR_LLM_JEV_TIMEOUT_MS": "900",
            "PTR_LLM_SAFETY_TIMEOUT_MS": "2300",
            "PTR_LLM_JEV_MIN_CONFIDENCE": "0.8",
            "PTR_LLM_SAFETY_THRESHOLD_SELF_HARM": "0.15",
        },
    )
    assert built.domain_engine.classifier_timeout_ms == 900
    assert built.domain_engine.safety_timeout_ms == 2300
    assert built.domain_engine.min_intent_confidence == 0.8
    assert built.domain_engine.safety_thresholds["self_harm"] == 0.15
    await built.close()


@pytest.mark.parametrize(
    "values",
    [
        {"PTR_LLM_JEV_TIMEOUT_MS": "49"},
        {"PTR_LLM_SAFETY_TIMEOUT_MS": "10001"},
        {"PTR_LLM_JEV_MIN_CONFIDENCE": "nan"},
        {"PTR_LLM_SAFETY_THRESHOLD_SELF_HARM": "0"},
        {"PTR_LLM_SAFETY_THRESHOLD_SEXUAL": "inf"},
    ],
)
async def test_invalid_classifier_overrides_fail_closed(monkeypatch, values):
    from ptr_llm import runtime as module

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    with pytest.raises(ProviderError, match="INVALID_RUNTIME_CONFIG"):
        await module.build_runtime(_settings(), values)
    assert FakePool.instances[-1].closed


@pytest.mark.parametrize("operation", ["get_result", "put_result"])
@pytest.mark.parametrize("loss", ["token", "status"])
async def test_receipt_io_monitors_lock_and_control_loss(operation, loss):
    runner, job, control, _, store, redis = setup()
    entered = asyncio.Event()

    async def stalled(*_):
        entered.set()
        await asyncio.Event().wait()

    setattr(store, operation, stalled)
    task = asyncio.create_task(runner.process(job, "synthetic-token"))
    await asyncio.wait_for(entered.wait(), 0.5)
    if loss == "token":
        redis.token = "new-synthetic-owner"
    else:
        control.status_failure = True
    try:
        done, _ = await asyncio.wait({task}, timeout=0.2)
        assert task in done, "Receipt I/O ignored ownership/control loss"
        with pytest.raises((ExecutionStopped, ControlUnavailable)):
            await task
        assert control.completions == []
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_factory_preserves_litellm_prompt_byte_limit(monkeypatch, tmp_path):
    from ptr_llm import runtime as module

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    registry = tmp_path / "synthetic-publication.json"
    registry.write_text('{"database":"ptr_split_test","personas":[]}', encoding="utf-8")
    env = billable_env(PTR_LLM_LITELLM_BILLABLE="0", PTR_LLM_PUBLISHED_PERSONAS_FILE=str(registry))
    built = await module.build_runtime(_settings(), env)
    assert built.provider.provider.provider.input_bytes == 65536
    await built.close()
    built = await module.build_runtime(_settings(), {**env, "PTR_LLM_INPUT_BYTES": "12345"})
    assert built.provider.provider.provider.input_bytes == 12345
    await built.close()


class AccountingTelemetry:
    def __init__(self):
        self.updates = []
        self.names = []

    def observation(self, name, **options):
        from contextlib import contextmanager

        self.names.append((name, options))

        @contextmanager
        def span():
            yield self

        return span()

    def update(self, **kwargs):
        self.updates.append(kwargs)


async def test_observed_proxy_metrics_export_cost_only_in_own_generation():
    from ptr_llm.runtime import ObservedProvider, _observe_provider_metrics

    telemetry = AccountingTelemetry()

    class Provider:
        async def generate(self, messages, **options):
            _observe_provider_metrics(
                {
                    "costMicrousd": 123,
                    "attempts": 1,
                    "totalMs": 5,
                    "api_key": "never-export",
                    "raw": messages,
                }
            )
            options["on_usage"]({"promptTokens": 3, "completionTokens": 2})
            return "synthetic"

    observed = ObservedProvider(Provider(), telemetry, "primary")
    assert (
        await observed.generate([{"role": "user", "content": "private-synthetic"}]) == "synthetic"
    )
    assert telemetry.updates[0]["cost_details"] == {"total": 0.000123}
    assert "private-synthetic" not in str(telemetry.updates)
    before = len(telemetry.updates)
    _observe_provider_metrics({"costMicrousd": 999})
    assert len(telemetry.updates) == before


async def test_observed_jev_is_one_call_with_reported_usage_and_no_raw_data():
    from ptr_llm.providers.openrouter import DEFAULT_JEV_MODEL
    from ptr_llm.runtime import ObservedDecisions

    telemetry = AccountingTelemetry()
    calls = []
    result = {
        "answers": {"private": "never-export"},
        "usage": {"cost": 0.001, "prompt_tokens": 4, "completion_tokens": 0},
    }

    class Client:
        async def decide(self, request, **options):
            calls.append((request, options))
            return result

    observed = ObservedDecisions(Client(), telemetry)
    assert (
        await observed.decide(
            {"model": DEFAULT_JEV_MODEL, "state": "never-export"}, request_key="synthetic"
        )
        is result
    )
    assert len(calls) == 1
    assert telemetry.updates[0] == {
        "usage_details": {"input": 4, "output": 0},
        "cost_details": {"total": 0.001},
    }
    assert telemetry.updates[-1]["metadata"]["accounting"] == "reported-receipt"
    assert "never-export" not in str(telemetry.updates)


async def test_unapproved_proxy_alias_cannot_be_declared_nonbillable(monkeypatch):
    from ptr_llm import runtime as module

    def forbidden_pool(**_):
        pytest.fail("Nonbillable alias must be checked before pool construction")

    monkeypatch.setattr(module, "AsyncConnectionPool", forbidden_pool)
    with pytest.raises(ProviderError, match="UNAPPROVED_NONBILLABLE_ALIAS"):
        await module.build_runtime(
            _settings(),
            {
                **billable_env(PTR_LLM_LITELLM_BILLABLE="0"),
                "PTR_LLM_MODEL": "paid-synthetic-alias",
            },
        )
