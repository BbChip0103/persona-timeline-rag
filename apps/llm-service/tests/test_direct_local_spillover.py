"""L1 direct local/OpenRouter contracts; all transports are synthetic."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import httpx
import pytest
from zdr_fixture import zdr_endpoint

from ptr_llm.billing import MemoryBudgetLedger, ProviderError
from ptr_llm.providers import OpenRouterClient
from ptr_llm.providers.openrouter import EMBEDDING_MODEL
from ptr_llm.telemetry import FrameworkTelemetry, TelemetryConfig

MESSAGES = [{"role": "user", "content": "synthetic prompt"}]
AGENT_MESSAGES = [
    {"role": "system", "content": "AGENT_JSON_REPLY"},
    {"role": "user", "content": "synthetic prompt"},
]
SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {"reply": {"type": "string"}},
    "required": ["reply"],
}


def _local_provider_cls():
    from ptr_llm import providers

    return getattr(providers, "DirectLocalTextProvider")


def test_direct_local_public_api_has_no_unused_paid_compatibility_options():
    import inspect

    from ptr_llm import providers

    parameters = inspect.signature(providers.DirectLocalTextProvider).parameters
    assert not {"paid_api_key", "spillover", "spillover_client"} & parameters.keys()
    assert not hasattr(providers, "LocalTextProvider")


def _openrouter_models_response(*, prompt: str = "0.00000007", completion: str = "0.00000034"):
    return {
        "data": [
            {
                "id": "google/gemma-4-26b-a4b-it",
                "pricing": {"prompt": prompt, "completion": completion},
                "supported_parameters": ["structured_outputs"],
                "endpoints": [
                    {
                        "provider_name": "DeepInfra",
                        "tag": "deepinfra",
                        "pricing": {"prompt": prompt, "completion": completion},
                    }
                ],
            }
        ]
    }


def _embedding_models_response():
    return {
        "data": [
            {
                "id": EMBEDDING_MODEL,
                "pricing": {"prompt": "0.00000002", "completion": "0"},
                "supported_parameters": [],
            }
        ]
    }


def _chat_response(content: Any, *, cost: Any = 0.000019, model: str = "google/gemma-4-26b-a4b-it"):
    return {
        "id": "synthetic-generation",
        "model": model,
        "choices": [{"message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 11, "completion_tokens": 7, "cost": cost},
    }


def _openrouter_client(
    handler, *, ledger: MemoryBudgetLedger | None = None, zdr_rows: list | None = None
):
    async def with_zdr(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/endpoints/zdr":
            return httpx.Response(
                200,
                json={
                    "data": zdr_rows
                    if zdr_rows is not None
                    else [zdr_endpoint()]
                },
            )
        return await handler(request)

    return OpenRouterClient(
        api_key="synthetic-paid-key",
        ledger=ledger or MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        transport=httpx.MockTransport(with_zdr),
    )


def _publication_file(tmp_path):
    registry = tmp_path / "synthetic-publication.json"
    registry.write_text('{"database":"ptr_split_test","personas":[]}', encoding="utf-8")
    return str(registry)


def _local_runtime_env(tmp_path, **overrides):
    return {
        "PTR_LLM_PROVIDER": "local",
        "PTR_LLM_LOCAL_BASE_URL": "http://127.0.0.1:8111/v1",
        "PTR_LLM_LOCAL_MODEL": "local/gemma-served",
        "PTR_LLM_PUBLISHED_PERSONAS_FILE": _publication_file(tmp_path),
        **overrides,
    }


def _cluster_env(**overrides):
    return {
        "PTR_NETWORK_MODE": "cluster",
        "KUBERNETES_SERVICE_HOST": "10.0.0.1",
        "PTR_LLM_LOCAL_BASE_URL": "http://model.ptr-llm.svc.cluster.local/v1",
        **overrides,
    }


async def test_runtime_local_provider_is_checkpointed_and_uses_65536_default_bytes(
    monkeypatch, tmp_path
):
    from test_runtime_composition import FakePool, _settings

    from ptr_llm import runtime as module
    from ptr_llm.providers import CheckpointedTextProvider, DirectLocalTextProvider

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    built = await module.build_runtime(_settings(), _local_runtime_env(tmp_path))
    try:
        checkpointed = built.provider.provider
        assert isinstance(checkpointed, CheckpointedTextProvider)
        assert isinstance(checkpointed.provider, DirectLocalTextProvider)
        assert checkpointed.provider.input_bytes == 65536
    finally:
        await built.close()


async def test_runtime_rejects_noncluster_spillover_before_pool(monkeypatch, tmp_path):
    from test_runtime_composition import _settings

    from ptr_llm import runtime as module

    def forbidden_pool(**_):
        pytest.fail("noncluster spillover must fail before opening a pool")

    monkeypatch.setattr(module, "AsyncConnectionPool", forbidden_pool)
    with pytest.raises(ProviderError, match="INVALID_SPILLOVER_CONFIG"):
        await module.build_runtime(
            _settings(),
            _local_runtime_env(
                tmp_path,
                PTR_LLM_SPILLOVER="openrouter",
            ),
        )


@pytest.mark.parametrize("key_name", ["OPENROUTER_API_KEY", "PTR_OPENROUTER_API_KEY"])
async def test_runtime_rejects_compose_openrouter_key_names_before_pool(
    monkeypatch, tmp_path, key_name
):
    from test_runtime_composition import _settings

    from ptr_llm import runtime as module

    def forbidden_pool(**_):
        pytest.fail("compose key guard must fail before opening a pool")

    monkeypatch.setattr(module, "AsyncConnectionPool", forbidden_pool)
    with pytest.raises(ProviderError, match="COMPOSE_OPENROUTER_KEYS_FORBIDDEN"):
        await module.build_runtime(
            _settings(),
            _local_runtime_env(tmp_path, **{key_name: ""}),
        )


async def test_runtime_cluster_spillover_requires_openrouter_key_before_pool(monkeypatch, tmp_path):
    from test_runtime_composition import _settings

    from ptr_llm import runtime as module

    def forbidden_pool(**_):
        pytest.fail("missing paid key must fail before opening a pool")

    monkeypatch.setattr(module, "AsyncConnectionPool", forbidden_pool)
    with pytest.raises(ProviderError, match="OPENROUTER_KEY_REQUIRED"):
        await module.build_runtime(
            _settings(),
            _local_runtime_env(
                tmp_path,
                **_cluster_env(PTR_LLM_SPILLOVER="openrouter"),
            ),
        )


async def test_runtime_never_accepts_paid_key_as_local_key(monkeypatch, tmp_path):
    from test_runtime_composition import _settings

    from ptr_llm import runtime as module

    def forbidden_pool(**_):
        pytest.fail("key isolation must fail before opening a pool")

    monkeypatch.setattr(module, "AsyncConnectionPool", forbidden_pool)
    with pytest.raises(ProviderError, match="PAID_KEY_ON_LOCAL_URL"):
        await module.build_runtime(
            _settings(),
            _local_runtime_env(
                tmp_path,
                **_cluster_env(),
                PTR_LLM_LOCAL_API_KEY="synthetic-same-key",
                OPENROUTER_API_KEY="synthetic-same-key",
            ),
        )


async def test_runtime_requires_local_api_key_when_operational_auth_flag_set(
    monkeypatch, tmp_path
):
    from test_runtime_composition import _settings

    from ptr_llm import runtime as module

    def forbidden_pool(**_):
        pytest.fail("local auth guard must fail before opening a pool")

    monkeypatch.setattr(module, "AsyncConnectionPool", forbidden_pool)
    with pytest.raises(ProviderError, match="LOCAL_API_KEY_REQUIRED"):
        await module.build_runtime(
            _settings(),
            _local_runtime_env(
                tmp_path,
                PTR_LLM_LOCAL_AUTH_REQUIRED="1",
                PTR_LLM_LOCAL_API_KEY="",
            ),
        )


async def test_runtime_cluster_openrouter_outage_disables_spillover(monkeypatch, tmp_path):
    from test_runtime_composition import FakePool, _settings

    from ptr_llm import runtime as module

    class UnreachableOpenRouter:
        def __init__(self, **kwargs):
            self.kwargs = kwargs
            self.pricing_checks = 0

        async def verify_key_limit(self, max_limit_usd):
            assert max_limit_usd == 1.0
            return False

        async def verify_pricing(self):
            self.pricing_checks += 1
            raise AssertionError("pricing must not run after unavailable key check")

        async def aclose(self):
            pass

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    monkeypatch.setattr(module, "OpenRouterClient", UnreachableOpenRouter)
    built = await module.build_runtime(
        _settings(),
        _local_runtime_env(
            tmp_path,
            **_cluster_env(
                PTR_LLM_SPILLOVER="openrouter",
                PTR_LLM_LIVE_ENABLED="1",
                PTR_LLM_ALLOW_EXTERNAL_DATA="1",
                OPENROUTER_API_KEY="synthetic-paid-key",
            ),
        ),
    )
    try:
        local = built.provider.provider.provider
        assert local.paid_spillover is not None
        assert local.spillover_enabled is False
        assert local.paid_spillover.pricing_checks == 0
        assert built.telemetry.counters["OPENROUTER_SPILLOVER_CHECK_FAILED"] == 1
    finally:
        await built.close()


async def test_local_spillover_rechecks_after_key_endpoint_recovers():
    recovered = asyncio.Event()

    class Paid:
        def __init__(self):
            self.checks = 0

        async def verify_key_limit(self, max_limit_usd):
            assert max_limit_usd == 1
            self.checks += 1
            return self.checks > 1

        async def verify_pricing(self):
            recovered.set()

    paid = Paid()
    provider = _local_provider_cls()(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        paid_spillover=paid,
    )
    try:
        await provider.start_spillover_checks(1, interval_seconds=0.01)
        assert provider.spillover_enabled is False
        await asyncio.wait_for(recovered.wait(), timeout=1)
        await asyncio.sleep(0)
        assert provider.spillover_enabled is True
    finally:
        await provider.aclose()


async def test_spillover_check_failure_is_counted_once_until_recovery(caplog):
    telemetry = FrameworkTelemetry(TelemetryConfig())
    outcomes: asyncio.Queue[bool | ProviderError] = asyncio.Queue()
    checks = 0

    class Paid:
        async def verify_key_limit(self, _limit):
            nonlocal checks
            outcome = await outcomes.get()
            checks += 1
            if isinstance(outcome, ProviderError):
                raise outcome
            return outcome

        async def verify_pricing(self):
            return None

    async def wait_for_checks(expected):
        async with asyncio.timeout(1):
            while checks < expected:
                await asyncio.sleep(0.001)
            await asyncio.sleep(0)

    provider = _local_provider_cls()(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        paid_spillover=Paid(),
        on_spillover_check_failure=telemetry.count,
    )
    caplog.set_level(logging.WARNING)
    try:
        outcomes.put_nowait(False)
        await provider.start_spillover_checks(1, interval_seconds=0.001)
        assert provider.spillover_enabled is False
        assert telemetry.counters["OPENROUTER_SPILLOVER_CHECK_FAILED"] == 1

        for expected in (2, 3):
            outcomes.put_nowait(ProviderError("PRICING_UNVERIFIED"))
            await wait_for_checks(expected)
        assert telemetry.counters["OPENROUTER_SPILLOVER_CHECK_FAILED"] == 1
        assert caplog.text.count("OPENROUTER_SPILLOVER_CHECK_FAILED") == 1

        outcomes.put_nowait(True)
        await wait_for_checks(4)
        assert provider.spillover_enabled is True
        assert caplog.text.count("OPENROUTER_SPILLOVER_ENABLED") == 1

        outcomes.put_nowait(ProviderError("PRICING_UNVERIFIED"))
        await wait_for_checks(5)
        assert provider.spillover_enabled is False
        assert telemetry.counters["OPENROUTER_SPILLOVER_CHECK_FAILED"] == 2
        assert caplog.text.count("OPENROUTER_SPILLOVER_CHECK_FAILED") == 2
        assert caplog.text.count("OPENROUTER_SPILLOVER_DISABLED") == 1
    finally:
        await provider.aclose()


async def test_direct_local_spillover_starts_disabled_even_with_paid_client():
    class Paid:
        pass

    provider = _local_provider_cls()(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        paid_spillover=Paid(),
    )
    try:
        assert provider.spillover_enabled is False
    finally:
        await provider.aclose()


@pytest.mark.asyncio
async def test_local_provider_uses_local_key_model_thinking_disabled_and_free_receipt():
    LocalTextProvider = _local_provider_cls()
    calls: list[dict[str, Any]] = []
    metrics: list[dict[str, Any]] = []

    async def local_handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append({"body": body, "authorization": request.headers.get("authorization")})
        return httpx.Response(200, json=_chat_response("local reply", cost=17))

    provider = LocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        api_key="synthetic-local-key",
        max_output_tokens=32,
        timeout_ms=1234,
        input_bytes=65536,
        transport=httpx.MockTransport(local_handler),
        on_metrics=metrics.append,
    )
    try:
        served: list[str] = []
        usage: list[dict[str, int | None]] = []
        text = await provider.generate(
            MESSAGES,
            request_key="00000000-0000-4000-8000-000000000001",
            on_served=served.append,
            on_usage=usage.append,
        )
        assert text == "local reply"
        assert len(calls) == 1
        assert calls[0]["authorization"] == "Bearer synthetic-local-key"
        assert calls[0]["body"]["model"] == "local/gemma-served"
        assert calls[0]["body"]["chat_template_kwargs"] == {"enable_thinking": False}
        assert calls[0]["body"]["stream"] is False
        assert served == ["local"]
        assert usage == [{"promptTokens": 11, "completionTokens": 7}]
        assert metrics and metrics[-1]["costMicrousd"] == 0
        assert not hasattr(provider, "ledger") or provider.ledger is None
    finally:
        await provider.aclose()


async def test_per_call_metrics_are_isolated_across_concurrent_local_calls():
    started = 0
    both_started = asyncio.Event()
    first_done = asyncio.Event()
    first_metrics, second_metrics = [], []

    async def local_handler(request: httpx.Request) -> httpx.Response:
        nonlocal started
        started += 1
        if started == 2:
            both_started.set()
        await both_started.wait()
        content = json.loads(request.content)["messages"][0]["content"]
        if content == "second":
            await first_done.wait()
        return httpx.Response(200, json=_chat_response(content, cost=0))

    provider = _local_provider_cls()(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        transport=httpx.MockTransport(local_handler),
    )
    try:
        async def first_call():
            try:
                return await provider.generate(
                    [{"role": "user", "content": "first"}], on_metrics=first_metrics.append
                )
            finally:
                first_done.set()

        replies = await asyncio.gather(
            first_call(),
            provider.generate(
                [{"role": "user", "content": "second"}], on_metrics=second_metrics.append
            ),
        )
        assert replies == ["first", "second"]
        assert len(first_metrics) == len(second_metrics) == 1
        assert first_metrics[0]["ok"] and second_metrics[0]["ok"]
    finally:
        await provider.aclose()


@pytest.mark.asyncio
async def test_local_provider_never_sends_paid_key_to_local_endpoint():
    LocalTextProvider = _local_provider_cls()
    authorizations: list[str | None] = []
    paid_key = "synthetic-paid-key-must-not-appear"

    async def local_handler(request: httpx.Request) -> httpx.Response:
        authorizations.append(request.headers.get("authorization"))
        return httpx.Response(200, json=_chat_response("local reply", cost=0))

    provider = LocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        api_key="",
        transport=httpx.MockTransport(local_handler),
    )
    try:
        assert await provider.generate(MESSAGES) == "local reply"
        assert authorizations == [None]
        assert all(value != f"Bearer {paid_key}" for value in authorizations)
    finally:
        await provider.aclose()


@pytest.mark.asyncio
async def test_direct_openrouter_chat_body_pins_deepinfra_caps_schema_usage_and_receipt_cost():
    ledger, bodies = MemoryBudgetLedger(), []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/models":
            return httpx.Response(200, json=_openrouter_models_response())
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        assert request.url.path == "/api/v1/chat/completions"
        body = json.loads(request.content)
        bodies.append(body)
        return httpx.Response(200, json=_chat_response('{"reply":"paid"}', cost=0.000019))

    client = _openrouter_client(handler, ledger=ledger)
    try:
        assert (
            await client.generate(
                AGENT_MESSAGES,
                request_key="00000000-0000-4000-8000-000000000002",
                response_schema=SCHEMA,
            )
            == '{"reply":"paid"}'
        )
        assert len(bodies) == 1
        provider = bodies[0]["provider"]
        assert provider["order"] == ["DeepInfra"]
        assert provider["allow_fallbacks"] is False
        assert provider["max_price"] == {"prompt": 0.1, "completion": 0.5, "request": 0}
        assert "usage" not in bodies[0]
        assert bodies[0]["response_format"] == {
            "type": "json_schema",
            "json_schema": {"name": "agent_reply", "strict": True, "schema": SCHEMA},
        }
        receipt = next(iter(ledger.requests.values()))
        assert receipt.state == "settled"
        assert receipt.actual_microusd == 19
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_direct_openrouter_missing_usage_cost_stays_unknown_and_does_not_resubmit():
    ledger, calls = MemoryBudgetLedger(), 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        if request.url.path == "/api/v1/models":
            return httpx.Response(200, json=_openrouter_models_response())
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        calls += 1
        return httpx.Response(
            200,
            json=_chat_response("paid reply", cost=None)
            | {"usage": {"prompt_tokens": 11, "completion_tokens": 7}},
        )

    client = _openrouter_client(handler, ledger=ledger)
    try:
        assert await client.generate(MESSAGES, request_key="unknown-cost") == "paid reply"
        assert await client.generate(MESSAGES, request_key="unknown-cost") == "paid reply"
        assert calls == 1
        assert next(iter(ledger.requests.values())).state == "unknown"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_direct_openrouter_rejects_schema_invalid_paid_response_without_resubmit():
    ledger, calls = MemoryBudgetLedger(), 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        if request.url.path == "/api/v1/models":
            return httpx.Response(200, json=_openrouter_models_response())
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        calls += 1
        return httpx.Response(200, json=_chat_response("{}", cost=0.000012))

    client = _openrouter_client(handler, ledger=ledger)
    try:
        with pytest.raises(ProviderError, match="INVALID_PROVIDER_RESPONSE"):
            await client.generate(
                AGENT_MESSAGES,
                request_key="schema-invalid",
                response_schema=SCHEMA,
            )
        with pytest.raises(ProviderError, match="INVALID_PROVIDER_RESPONSE"):
            await client.generate(
                AGENT_MESSAGES,
                request_key="schema-invalid",
                response_schema=SCHEMA,
            )
        assert calls == 1
        assert next(iter(ledger.requests.values())).state == "settled"
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_direct_openrouter_schema_body_limit_rejects_before_paid_reservation():
    ledger = MemoryBudgetLedger()
    client = OpenRouterClient(
        api_key="synthetic-paid-key",
        ledger=ledger,
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        input_bytes=256,
        transport=httpx.MockTransport(lambda request: pytest.fail("No paid request")),
    )
    client._text_verified = True
    client.structured_outputs = True
    try:
        with pytest.raises(ProviderError, match="INPUT_LIMIT"):
            await client.generate(
                AGENT_MESSAGES,
                response_schema={**SCHEMA, "description": "synthetic" * 100},
            )
        assert not ledger.requests
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_chat_pricing_verification_uses_deepinfra_metadata_and_rejects_over_cap():
    async def allowed(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/models":
            return httpx.Response(200, json=_openrouter_models_response())
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        raise AssertionError("pricing verification must not submit chat")

    async def over_cap(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/models":
            return httpx.Response(
                200,
                json=_openrouter_models_response(prompt="0.00000011", completion="0.00000051"),
            )
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        raise AssertionError("pricing verification must not submit chat")

    allowed_client = _openrouter_client(allowed)
    over_cap_client = _openrouter_client(over_cap)
    try:
        await allowed_client.verify_pricing()
        with pytest.raises(ProviderError, match="PRICING_CHANGED_OR_UNKNOWN_FEE"):
            await over_cap_client.verify_pricing()
    finally:
        await allowed_client.aclose()
        await over_cap_client.aclose()


@pytest.mark.asyncio
async def test_chat_pricing_fetches_official_endpoint_shape_when_catalog_has_no_endpoints():
    seen = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/api/v1/models":
            catalog = _openrouter_models_response()
            del catalog["data"][0]["endpoints"]
            return httpx.Response(200, json=catalog)
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        if request.url.path == "/api/v1/models/google/gemma-4-26b-a4b-it/endpoints":
            return httpx.Response(
                200,
                json={
                    "data": {
                        "id": "google/gemma-4-26b-a4b-it",
                        "endpoints": [
                            {
                                "provider_name": "DeepInfra",
                                "tag": "deepinfra/fp8",
                                "pricing": {
                                    "prompt": "0.00000007",
                                    "completion": "0.00000034",
                                    "discount": 0,
                                },
                            }
                        ],
                    }
                },
            )
        raise AssertionError(f"unexpected synthetic path {request.url.path}")

    client = _openrouter_client(
        handler,
        zdr_rows=[zdr_endpoint(tag="deepinfra/fp8")],
    )
    try:
        await client.verify_pricing()
        assert seen == [
            "/api/v1/models",
            "/api/v1/embeddings/models",
            "/api/v1/models/google/gemma-4-26b-a4b-it/endpoints",
        ]
    finally:
        await client.aclose()


async def test_pinned_chat_uses_deepinfra_price_when_catalog_aggregate_is_higher():
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/models":
            catalog = _openrouter_models_response()
            catalog["data"][0]["pricing"] = {
                "prompt": "0.00000020",
                "completion": "0.00000100",
            }
            return httpx.Response(200, json=catalog)
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        raise AssertionError("No paid submission")

    client = _openrouter_client(handler)
    try:
        await client.verify_pricing()
        assert client._text_verified is True
    finally:
        await client.aclose()


async def test_pinned_chat_rejects_deepinfra_over_cap_with_low_catalog_price():
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/models":
            catalog = _openrouter_models_response()
            catalog["data"][0]["endpoints"][0]["pricing"] = {
                "prompt": "0.00000011",
                "completion": "0.00000051",
            }
            return httpx.Response(200, json=catalog)
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        raise AssertionError("No paid submission")

    client = _openrouter_client(handler)
    try:
        with pytest.raises(ProviderError, match="PRICING_CHANGED_OR_UNKNOWN_FEE"):
            await client.verify_pricing()
        assert not client.ledger.requests
    finally:
        await client.aclose()


async def test_deepinfra_missing_from_zdr_list_drops_chat_zdr():
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/models":
            return httpx.Response(200, json=_openrouter_models_response())
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        raise AssertionError("No paid submission")

    client = _openrouter_client(
        handler,
        zdr_rows=[zdr_endpoint(provider_name="OpenAI", tag="openai")],
    )
    try:
        await client.verify_pricing()
        assert "zdr" not in client._provider()
        assert client._provider(embedding=True)["zdr"] is True
        assert not client.ledger.requests
    finally:
        await client.aclose()


@pytest.mark.parametrize(
    "zdr_status,zdr_payload",
    [(503, {"error": "synthetic outage"}), (200, {"data": [{"unexpected": "shape"}]})],
)
async def test_zdr_unverifiable_keeps_local_spillover_off(zdr_status, zdr_payload):
    telemetry = FrameworkTelemetry(TelemetryConfig())
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v1/models":
            return httpx.Response(200, json=_openrouter_models_response())
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        if request.url.path == "/api/v1/endpoints/zdr":
            return httpx.Response(zdr_status, json=zdr_payload)
        raise AssertionError("No paid submission")

    paid = OpenRouterClient(
        api_key="synthetic-paid-key",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        transport=httpx.MockTransport(handler),
    )

    async def key_available(_limit: float) -> bool:
        return True

    paid.verify_key_limit = key_available
    local = _local_provider_cls()(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        paid_spillover=paid,
        on_spillover_check_failure=telemetry.count,
    )
    try:
        await local.start_spillover_checks(1)
        assert local.spillover_enabled is False
        assert paid._text_verified is False
        assert not paid.ledger.requests
        assert telemetry.counters["OPENROUTER_SPILLOVER_CHECK_FAILED"] == 1
    finally:
        await local.aclose()
        await paid.aclose()


@pytest.mark.parametrize("reason", ["rejected-saturated", "rejected-ttl-expired"])
@pytest.mark.asyncio
async def test_local_spillover_triggers_once_for_authorized_429_drop_reasons(reason):
    LocalTextProvider = _local_provider_cls()
    local_calls, paid_calls = 0, 0
    ledger = MemoryBudgetLedger()

    async def local_handler(request: httpx.Request) -> httpx.Response:
        nonlocal local_calls
        local_calls += 1
        return httpx.Response(
            429,
            headers={"x-llm-d-request-dropped-reason": reason},
            json={"error": "synthetic saturated"},
        )

    async def paid_handler(request: httpx.Request) -> httpx.Response:
        nonlocal paid_calls
        if request.url.path == "/api/v1/models":
            return httpx.Response(200, json=_openrouter_models_response())
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        paid_calls += 1
        return httpx.Response(200, json=_chat_response("paid spillover", cost=0.000023))

    paid = _openrouter_client(paid_handler, ledger=ledger)
    provider = LocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        api_key="",
        transport=httpx.MockTransport(local_handler),
        paid_spillover=paid,
        spillover_min_remaining_ms=10_000,
    )
    try:
        provider.spillover_enabled = True
        deadline = time.time() * 1000 + 30_000
        assert (
            await provider.generate(MESSAGES, request_key=f"spill-{reason}", deadline_at=deadline)
            == "paid spillover"
        )
        assert local_calls == 1
        assert paid_calls == 1
        receipt = next(iter(ledger.requests.values()))
        assert receipt.state == "settled"
        assert receipt.actual_microusd == 23
    finally:
        await provider.aclose()
        await paid.aclose()


@pytest.mark.parametrize(
    ("paid_reply", "expected_error"),
    [('{"reply":"paid"}', None), ('{}', "INVALID_PROVIDER_RESPONSE")],
)
async def test_local_spillover_validates_per_turn_response_schema(paid_reply, expected_error):
    ledger = MemoryBudgetLedger()
    paid_bodies = []

    async def local_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            headers={"x-llm-d-request-dropped-reason": "rejected-saturated"},
            json={"error": "synthetic saturation"},
        )

    async def paid_handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/chat/completions"
        paid_bodies.append(json.loads(request.content))
        return httpx.Response(200, json=_chat_response(paid_reply, cost=0.000012))

    paid = _openrouter_client(paid_handler, ledger=ledger)
    paid._text_verified = True
    paid.structured_outputs = True
    provider = _local_provider_cls()(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        transport=httpx.MockTransport(local_handler),
        paid_spillover=paid,
    )
    try:
        provider.spillover_enabled = True
        if expected_error:
            with pytest.raises(ProviderError, match=expected_error):
                await provider.generate(
                    AGENT_MESSAGES, request_key="schema-spill", response_schema=SCHEMA
                )
        else:
            assert await provider.generate(
                AGENT_MESSAGES, request_key="schema-spill", response_schema=SCHEMA
            ) == paid_reply
        assert len(paid_bodies) == 1
        assert paid_bodies[0]["response_format"]["json_schema"]["schema"] == SCHEMA
        assert next(iter(ledger.requests.values())).state == "settled"
    finally:
        await provider.aclose()
        await paid.aclose()


@pytest.mark.parametrize(
    ("status", "headers", "remaining_ms", "raises"),
    [
        (
            500,
            {"x-llm-d-request-dropped-reason": "rejected-saturated"},
            30_000,
            "PROVIDER_HTTP_500",
        ),
        (503, {}, 30_000, "PROVIDER_HTTP_503"),
        (
            429,
            {"x-llm-d-request-dropped-reason": "rejected-context-cancelled"},
            30_000,
            "PROVIDER_HTTP_429",
        ),
        (
            429,
            {"x-llm-d-request-dropped-reason": "rejected-saturated"},
            5_000,
            "PROVIDER_HTTP_429",
        ),
    ],
)
@pytest.mark.asyncio
async def test_local_spillover_does_not_trigger_for_unauthorized_failures(
    status, headers, remaining_ms, raises
):
    LocalTextProvider = _local_provider_cls()
    paid_calls = 0

    async def local_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, headers=headers, json={"error": "synthetic"})

    async def paid_handler(request: httpx.Request) -> httpx.Response:
        nonlocal paid_calls
        paid_calls += 1
        return httpx.Response(200, json=_chat_response("must not run"))

    paid = _openrouter_client(paid_handler)
    provider = LocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        api_key="",
        transport=httpx.MockTransport(local_handler),
        paid_spillover=paid,
        spillover_min_remaining_ms=10_000,
    )
    try:
        provider.spillover_enabled = True
        deadline = time.time() * 1000 + remaining_ms
        with pytest.raises(ProviderError, match=raises):
            await provider.generate(
                MESSAGES, request_key=f"no-spill-{status}", deadline_at=deadline
            )
        assert paid_calls == 0
    finally:
        await provider.aclose()
        await paid.aclose()


@pytest.mark.asyncio
async def test_local_spillover_does_not_trigger_on_local_timeout():
    LocalTextProvider = _local_provider_cls()
    paid_calls = 0

    async def local_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("synthetic timeout")

    async def paid_handler(request: httpx.Request) -> httpx.Response:
        nonlocal paid_calls
        paid_calls += 1
        return httpx.Response(200, json=_chat_response("must not run"))

    paid = _openrouter_client(paid_handler)
    provider = LocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        api_key="",
        timeout_ms=50,
        transport=httpx.MockTransport(local_handler),
        paid_spillover=paid,
    )
    try:
        with pytest.raises(ProviderError, match="PROVIDER_TIMEOUT|PROVIDER_TRANSPORT"):
            await provider.generate(MESSAGES, request_key="no-spill-timeout")
        assert paid_calls == 0
    finally:
        await provider.aclose()
        await paid.aclose()


async def test_local_429_header_with_unreadable_body_does_not_spill():
    paid_calls = []

    class Paid:
        async def generate(self, *_args, **_kwargs):
            paid_calls.append(True)
            return "must-not-run"

    class BrokenBody(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise httpx.ReadTimeout("synthetic response-body timeout")
            yield b""  # pragma: no cover

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            headers={"x-llm-d-request-dropped-reason": "rejected-saturated"},
            stream=BrokenBody(),
        )

    provider = _local_provider_cls()(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        paid_spillover=Paid(),
        transport=httpx.MockTransport(handler),
    )
    try:
        provider.spillover_enabled = True
        with pytest.raises(ProviderError):
            await provider.generate(MESSAGES)
        assert paid_calls == []
    finally:
        await provider.aclose()


@pytest.mark.parametrize(
    ("kwargs", "error"),
    [
        (
            {"base_url": "https://openrouter.ai/api/v1", "cluster_mode": False},
            "LOCAL_URL_NOT_ALLOWED",
        ),
        (
            {"base_url": "http://model.ptr-llm.svc.cluster.local/v1", "cluster_mode": False},
            "LOCAL_URL_NOT_ALLOWED",
        ),
        (
            {"base_url": "http://127.0.0.1:8111/v1", "cluster_mode": True},
            "LOCAL_URL_NOT_ALLOWED",
        ),
    ],
)
def test_local_base_url_allowlist_rejects_wrong_network(kwargs, error):
    LocalTextProvider = _local_provider_cls()
    with pytest.raises(ProviderError, match=error):
        LocalTextProvider(model="local/gemma-served", api_key="", **kwargs)


def test_local_base_url_allowlist_accepts_loopback_and_cluster_svc():
    LocalTextProvider = _local_provider_cls()
    loopback = LocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma-served",
        api_key="",
        cluster_mode=False,
    )
    svc = LocalTextProvider(
        base_url="http://model.ptr-llm.svc.cluster.local/v1",
        model="local/gemma-served",
        api_key="",
        cluster_mode=True,
    )
    assert loopback.base_url.startswith("http://127.0.0.1")
    assert svc.base_url.startswith("http://model.ptr-llm.svc.cluster.local")


def test_paid_base_url_defaults_to_openrouter_origin_without_override():
    client = OpenRouterClient(
        api_key="synthetic-paid-key",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
    )
    assert client.base_url == "https://openrouter.ai"


@pytest.mark.parametrize(
    "base_url",
    [
        "https://openrouter.ai",
        "https://openrouter.ai/api/v1",
        "https://evil.example/api/v1",
        "http://127.0.0.1:9000/api/v1",
        "http://openrouter-fake.ptr-llm.svc.cluster.local:8080",
    ],
)
def test_paid_base_url_rejects_every_override_without_fixture_cluster_svc(base_url):
    with pytest.raises(ProviderError, match="OPENROUTER_URL_NOT_ALLOWED"):
        OpenRouterClient(
            api_key="synthetic-paid-key",
            ledger=MemoryBudgetLedger(),
            live_enabled=True,
            allow_external_data=True,
            base_url_override=base_url,
        )


@pytest.mark.asyncio
async def test_paid_base_url_allows_fixture_cluster_svc_origin_only_and_appends_api_path():
    seen: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if request.url.path == "/api/v1/models":
            return httpx.Response(200, json=_openrouter_models_response())
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        if request.url.path == "/api/v1/endpoints/zdr":
            return httpx.Response(
                200,
                json={
                    "data": [zdr_endpoint()]
                },
            )
        raise AssertionError(f"unexpected fixture path {request.url.path}")

    client = OpenRouterClient(
        api_key="synthetic-paid-key",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        base_url_override="http://openrouter-fake.ptr-llm.svc.cluster.local:8080",
        fixture_enabled=True,
        cluster_mode=True,
        transport=httpx.MockTransport(handler),
    )
    try:
        assert client.base_url == "http://openrouter-fake.ptr-llm.svc.cluster.local:8080"
        await client.verify_pricing()
        assert seen == [
            "http://openrouter-fake.ptr-llm.svc.cluster.local:8080/api/v1/models",
            "http://openrouter-fake.ptr-llm.svc.cluster.local:8080/api/v1/embeddings/models",
            "http://openrouter-fake.ptr-llm.svc.cluster.local:8080/api/v1/endpoints/zdr",
        ]
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_openrouter_key_limit_accepts_configured_limit():
    paths = []

    async def handler(request: httpx.Request) -> httpx.Response:
        paths.append((request.method, request.url.path, request.headers.get("authorization")))
        return httpx.Response(200, json={"data": {"limit": 5, "limit_reset": None}})

    client = _openrouter_client(handler)
    try:
        assert await client.verify_key_limit(max_limit_usd=10) is True
        assert paths == [("GET", "/api/v1/key", "Bearer synthetic-paid-key")]
    finally:
        await client.aclose()


@pytest.mark.parametrize(
    "payload",
    [
        {"data": {}},
        {"data": {"limit": None}},
        {"data": {"limit": 5}},
        {"data": {"limit": 50}},
        {"data": {"limit": 5, "limit_reset": "daily"}},
        {"data": {"limit": 5, "limit_reset": "monthly"}},
    ],
)
@pytest.mark.asyncio
async def test_openrouter_key_limit_rejects_missing_or_excessive_limit(payload):
    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=payload)

    client = _openrouter_client(handler)
    try:
        with pytest.raises(ProviderError, match="OPENROUTER_KEY_LIMIT"):
            await client.verify_key_limit(max_limit_usd=10)
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_openrouter_key_limit_outage_disables_spillover_without_blocking_local_startup():
    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("synthetic outage", request=request)

    client = _openrouter_client(handler)
    try:
        assert await client.verify_key_limit(max_limit_usd=10) is False
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_openrouter_jev_and_embedding_wire_contracts_do_not_pick_up_chat_pin():
    bodies = []

    async def handler(request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/v1/models":
            return httpx.Response(200, json=_openrouter_models_response())
        if path == "/api/v1/embeddings/models":
            return httpx.Response(200, json=_embedding_models_response())
        if path.endswith("/endpoints"):
            return httpx.Response(
                200,
                json={
                    "data": {
                        "endpoints": [
                            {"pricing": {"prompt": "0.00000005", "completion": "0"}}
                        ]
                    }
                },
            )
        body = json.loads(request.content)
        bodies.append((path, body))
        if path == "/api/alpha/decisions":
            return httpx.Response(200, json={"model": "typesafe/jev-1.13", "answers": {}})
        if path == "/api/v1/embeddings":
            return httpx.Response(
                200,
                json={
                    "model": EMBEDDING_MODEL,
                    "data": [{"index": 0, "embedding": [0.0] * 1536}],
                    "usage": {"cost": 0},
                },
            )
        raise AssertionError(f"unexpected path {path}")

    client = _openrouter_client(handler)
    try:
        await client.decide(
            {"model": "typesafe/jev-1.13", "state": {}, "questions": {}},
            request_key="00000000-0000-4000-8000-000000000003#w0",
        )
        await client.embed(["synthetic"])
        decision_body = next(body for path, body in bodies if path == "/api/alpha/decisions")
        embed_body = next(body for path, body in bodies if path == "/api/v1/embeddings")
        assert "order" not in decision_body["provider"]
        assert decision_body["provider"]["zdr"] is True
        assert "order" not in embed_body["provider"]
        assert embed_body["provider"]["max_price"] == {
            "prompt": 0.02,
            "completion": 0,
            "request": 0,
        }
    finally:
        await client.aclose()

