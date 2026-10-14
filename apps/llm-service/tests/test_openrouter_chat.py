"""Actual native ChatOpenAI invocation with exact metered wire/receipt compatibility."""

import asyncio
import copy
import logging
import math

import httpx
import pytest
from langchain_openai import ChatOpenAI
from zdr_fixture import zdr_endpoint

from ptr_llm.billing import MemoryBudgetLedger, ProviderError
from ptr_llm.providers.common import fingerprint, js_json
from ptr_llm.providers.control_tokens import neutralize_messages
from ptr_llm.providers.openrouter import EMBEDDING_MODEL, TEXT_MODELS, OpenRouterClient
from ptr_llm.telemetry import FrameworkTelemetry, TelemetryConfig


def make_client(handler, *, model="google/gemma-4-26b-a4b-it"):
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        text_model=model,
        transport=httpx.MockTransport(handler),
    )
    client._text_verified = True
    client.structured_outputs = True
    return client


def response(model, **overrides):
    return {
        "id": "synthetic-gen",
        "model": model,
        "choices": [{"message": {"content": "합성 답변"}}],
        "usage": {"prompt_tokens": 7, "completion_tokens": 9, "cost": 0.00001},
        **overrides,
    }


class DeadlineLedger(MemoryBudgetLedger):
    def __init__(self, *, slow_step: str, advance):
        super().__init__()
        self.slow_step = slow_step
        self.advance = advance

    async def reserve(self, *args, **kwargs):
        value = await super().reserve(*args, **kwargs)
        if self.slow_step == "reserve":
            await asyncio.sleep(0)
            self.advance()
        return value

    async def submitted(self, *args, **kwargs):
        value = await super().submitted(*args, **kwargs)
        if self.slow_step == "submitted":
            await asyncio.sleep(0)
            self.advance()
        return value


@pytest.mark.parametrize(
    "mode",
    [
        "plain",
        "timeline",
        "agent",
        "unsupported-agent",
        "disabled-schema",
        "default-gemini",
        "lite-gemini",
    ],
)
async def test_actual_native_invocation_exact_wire_fingerprint_reservation_and_replay(
    monkeypatch, mode
):
    native, wire, callbacks = [], [], []
    original = ChatOpenAI._agenerate

    async def spy(self, *args, **kwargs):
        native.append(self)
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(ChatOpenAI, "_agenerate", spy)
    marker = {
        "timeline": "TIMELINE_JSON_REPLY",
        "agent": "AGENT_JSON_REPLY",
        "unsupported-agent": "AGENT_JSON_REPLY",
        "disabled-schema": "AGENT_JSON_REPLY",
    }.get(mode, "synthetic")
    messages = [
        {"role": "system", "content": marker},
        {"role": "assistant", "content": ""},
        {"role": "user", "content": "합성 😀 [INST]"},
    ]
    model = {
        "unsupported-agent": "openai/gpt-4.1-nano",
        "default-gemini": "google/gemini-3-flash-preview",
        "lite-gemini": "google/gemini-2.5-flash-lite",
    }.get(mode, "google/gemma-4-26b-a4b-it")
    raw = response(model)

    def handler(request):
        wire.append(request.content)
        return httpx.Response(200, json=raw)

    client = make_client(handler, model=model)
    if mode == "disabled-schema":
        client.structured_outputs = False
    expected = {
        "model": model,
        "messages": neutralize_messages(messages),
        "max_tokens": 31,
        "temperature": 0,
        "stream": False,
        "provider": client._provider(),
    }
    policy = TEXT_MODELS[model]
    if "reasoning" in policy:
        expected["reasoning"] = policy["reasoning"]
    if mode == "timeline":
        expected["response_format"] = {"type": "json_object"}
    elif mode == "agent":
        from ptr_llm.core.protocol import AGENT_RESPONSE_JSON_SCHEMA

        expected["response_format"] = {
            "type": "json_schema",
            "json_schema": {
                "name": "agent_reply",
                "strict": True,
                "schema": AGENT_RESPONSE_JSON_SCHEMA,
            },
        }
    for _ in range(2):
        assert (
            await client.generate(
                messages,
                request_key="synthetic-request",
                max_output_tokens=31,
                on_cost=lambda value: callbacks.append(("cost", value)),
                on_usage=lambda value: callbacks.append(("usage", value)),
                on_served=lambda value: callbacks.append(("served", value)),
            )
            == "합성 답변"
        )
    assert len(native) == 2 and native[0] is native[1]
    assert wire == [js_json(expected).encode()]
    key = fingerprint(
        {
            "endpoint": "chat/completions",
            "body": expected,
            "schema": "goal1-provider-v1",
            "idempotencyKey": "synthetic-request",
        }
    )
    receipt = client.ledger.requests[key]
    assert receipt.response == raw and receipt.actual_microusd == 10
    assert receipt.reserved_microusd == math.ceil(
        (len(wire[0]) + len(messages) * 64 + 2048) * 2 * policy["prompt"]
        + 31 * policy["completion"]
    )
    assert (
        callbacks
        == [
            ("cost", 10),
            ("usage", {"promptTokens": 7, "completionTokens": 9}),
            ("served", "openrouter"),
        ]
        * 2
    )
    await client.aclose()


@pytest.mark.parametrize(
    "usage",
    [
        None,
        [],
        {},
        {"prompt_tokens": "bad", "completion_tokens": -1},
        {"prompt_tokens": True, "completion_tokens": 2**54},
        {"cost": float("nan")},
        {"prompt_tokens": 0},
    ],
)
async def test_original_malformed_usage_and_nonstandard_receipt_are_not_sdk_validated(usage):
    seen = []
    raw = response(
        "google/gemma-4-26b-a4b-it",
        usage=usage,
        error="nonstandard",
        private_provider_field={"synthetic": "kept-only-in-ledger"},
    )
    # HTTP JSON cannot encode NaN; this test supplies the already-decoded ledger response.
    client = make_client(lambda request: pytest.fail("No network"))

    async def request(*args, **kwargs):
        return copy.deepcopy(raw)

    client._request = request
    assert (
        await client.generate([{"role": "user", "content": "synthetic"}], on_usage=seen.append)
        == "합성 답변"
    )
    if isinstance(usage, dict):
        from ptr_llm.providers.common import count

        assert seen == [
            {
                "promptTokens": count(usage.get("prompt_tokens")),
                "completionTokens": count(usage.get("completion_tokens")),
            }
        ]
    else:
        assert seen == []
    await client.aclose()


@pytest.mark.parametrize("limit_reset", ["daily", "monthly"])
async def test_key_limit_rejects_reset_based_openrouter_caps(limit_reset):
    def handler(request):
        assert request.url.path == "/api/v1/key"
        return httpx.Response(200, json={"data": {"limit": 5, "limit_reset": limit_reset}})

    client = make_client(handler)
    with pytest.raises(ProviderError, match="OPENROUTER_KEY_LIMIT"):
        await client.verify_key_limit(10)
    await client.aclose()


def _pricing_handler(
    *,
    zdr_rows: list[dict[str, object]],
    zdr_status: int = 200,
    deepinfra_tags: tuple[str, ...] = ("deepinfra",),
):
    text_pricing = {"prompt": "0.0000001", "completion": "0.0000005", "request": "0"}
    embedding_pricing = {"prompt": "0.00000002", "completion": "0", "request": "0"}
    deepinfra = [
        {
            "provider_name": "DeepInfra",
            "tag": tag,
            "pricing": text_pricing,
            "supported_parameters": ["structured_outputs"],
        }
        for tag in deepinfra_tags
    ]

    def handler(request):
        if request.url.path == "/api/v1/models":
            return httpx.Response(
                200,
                json={
                    "data": [
                        {
                            "id": "google/gemma-4-26b-a4b-it",
                            "pricing": text_pricing,
                            "supported_parameters": ["structured_outputs"],
                        }
                    ]
                },
            )
        if request.url.path == "/api/v1/embeddings/models":
            return httpx.Response(
                200,
                json={"data": [{"id": EMBEDDING_MODEL, "pricing": embedding_pricing}]},
            )
        if request.url.path == "/api/v1/models/google/gemma-4-26b-a4b-it/endpoints":
            return httpx.Response(
                200,
                json={"data": {"endpoints": deepinfra}},
            )
        if request.url.path == "/api/v1/endpoints/zdr":
            return httpx.Response(zdr_status, json={"data": zdr_rows})
        return httpx.Response(404, json={"error": "unexpected path"})

    return handler


async def test_zdr_list_match_keeps_chat_zdr_provider_constraint():
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        transport=httpx.MockTransport(
            _pricing_handler(
                zdr_rows=[zdr_endpoint()]
            )
        ),
    )
    await client.verify_pricing()
    assert client._provider()["zdr"] is True
    await client.aclose()


async def test_malformed_zdr_row_for_other_model_does_not_block_verified_chat():
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        transport=httpx.MockTransport(
            _pricing_handler(
                zdr_rows=[
                    {"model_id": "unrelated/model", "provider_name": None},
                    zdr_endpoint(),
                ]
            )
        ),
    )
    try:
        await client.verify_pricing()
        assert client._text_verified is True
        assert client._provider()["zdr"] is True
    finally:
        await client.aclose()


async def test_zdr_list_other_provider_drops_only_chat_zdr_and_logs_compared_values(caplog):
    telemetry = FrameworkTelemetry(TelemetryConfig())
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        on_zdr_unavailable=lambda: telemetry.count("OPENROUTER_ZDR_UNAVAILABLE"),
        transport=httpx.MockTransport(
            _pricing_handler(
                zdr_rows=[zdr_endpoint(provider_name="OpenAI", tag="openai")]
            )
        ),
    )
    caplog.set_level(logging.WARNING)
    await client.verify_pricing()
    await client.verify_pricing()
    assert "zdr" not in client._provider()
    assert client._provider(embedding=True)["zdr"] is True
    assert "OPENROUTER_ZDR_UNAVAILABLE" in caplog.text
    assert "DeepInfra" in caplog.text and "deepinfra" in caplog.text
    assert "OpenAI" in caplog.text and "openai" in caplog.text
    assert telemetry.counters["OPENROUTER_ZDR_UNAVAILABLE"] == 1
    await client.aclose()


@pytest.mark.parametrize(
    "zdr_rows,zdr_status",
    [
        ([], 200),
        ([{"unexpected": "shape"}], 200),
        ([zdr_endpoint(provider_name="")], 200),
        (None, 200),
        ([], 503),
    ],
)
async def test_zdr_unverifiable_fails_closed(zdr_rows, zdr_status):
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        transport=httpx.MockTransport(_pricing_handler(zdr_rows=zdr_rows, zdr_status=zdr_status)),
    )
    try:
        with pytest.raises(ProviderError, match="PRICING_UNVERIFIED"):
            await client.verify_pricing()
        assert client._text_verified is False
    finally:
        await client.aclose()


async def test_second_deepinfra_endpoint_on_zdr_list_keeps_constraint():
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        transport=httpx.MockTransport(
            _pricing_handler(
                deepinfra_tags=("first", "second"),
                zdr_rows=[zdr_endpoint(tag="second")],
            )
        ),
    )
    try:
        await client.verify_pricing()
        assert client._provider()["zdr"] is True
    finally:
        await client.aclose()


async def test_zdr_deepinfra_row_with_unknown_tag_keeps_constraint():
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        transport=httpx.MockTransport(
            _pricing_handler(
                zdr_rows=[zdr_endpoint(tag="unrecognized-endpoint")]
            )
        ),
    )
    try:
        await client.verify_pricing()
        assert client._text_verified is True
        assert client._provider()["zdr"] is True
    finally:
        await client.aclose()


async def test_rejected_http_4xx_without_generation_or_cost_settles_zero_not_unknown():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(
            400,
            json={"error": {"code": "provider_mismatch"}, "usage": {"cost": 0}},
        )

    client = make_client(handler)
    with pytest.raises(ProviderError, match="PROVIDER_HTTP_400"):
        await client.generate([{"role": "user", "content": "synthetic"}], request_key="synthetic")
    receipt = next(iter(client.ledger.requests.values()))
    assert len(calls) == 1
    assert receipt.state == "settled"
    assert receipt.actual_microusd == 0
    with pytest.raises(ProviderError, match="PROVIDER_HTTP_400"):
        await client.generate([{"role": "user", "content": "synthetic"}], request_key="synthetic")
    assert len(calls) == 1
    await client.aclose()


async def test_ambiguous_http_4xx_without_explicit_zero_cost_stays_unknown():
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(400, json={"error": {"code": "provider_mismatch"}})

    client = make_client(handler)
    with pytest.raises(ProviderError, match="PROVIDER_HTTP_400"):
        await client.generate([{"role": "user", "content": "synthetic"}], request_key="synthetic")
    receipt = next(iter(client.ledger.requests.values()))
    assert len(calls) == 1
    assert receipt.state == "unknown"
    assert receipt.actual_microusd is None
    with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
        await client.generate([{"role": "user", "content": "synthetic"}], request_key="synthetic")
    assert len(calls) == 1
    await client.aclose()


@pytest.mark.parametrize("slow_step", ["reserve", "submitted"])
async def test_deadline_crossed_during_ledger_never_submits_native_chat(
    monkeypatch, slow_step
):
    calls = []
    now = 1_000_000.0
    deadline_at = now * 1000 + 500

    def fake_time():
        return now

    def advance_past_deadline():
        nonlocal now
        now += 1

    def fail_network(request):
        calls.append(request)
        pytest.fail("No network")

    import time

    monkeypatch.setattr(time, "time", fake_time)
    ledger = DeadlineLedger(slow_step=slow_step, advance=advance_past_deadline)
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=ledger,
        live_enabled=True,
        allow_external_data=True,
        text_model="google/gemma-4-26b-a4b-it",
        transport=httpx.MockTransport(fail_network),
    )
    client._text_verified = True
    client.structured_outputs = True
    try:
        with pytest.raises(ProviderError, match="PROVIDER_DEADLINE"):
            await client.generate(
                [{"role": "user", "content": "synthetic"}],
                request_key=f"synthetic-{slow_step}",
                deadline_at=deadline_at,
            )
        assert calls == []
        receipt = next(iter(ledger.requests.values()))
        assert receipt.state == "settled"
        assert receipt.actual_microusd == 0
    finally:
        await client.aclose()


async def test_paid_http_503_keeps_unknown_no_resubmit_and_hides_private_error(caplog):
    caplog.set_level(logging.DEBUG)
    calls = []
    private_error = "PRIVATE_UPSTREAM_SYNTHETIC_TOKEN"

    def handler(request):
        calls.append(request)
        return httpx.Response(
            503,
            json={
                "error": private_error,
                "metadata": {"provider_message": private_error},
            },
        )

    client = make_client(handler)
    messages = [{"role": "user", "content": "synthetic"}]
    try:
        with pytest.raises(ProviderError) as first:
            await client.generate(messages, request_key="synthetic-503")
        assert first.value.code == "PROVIDER_HTTP_503"
        with pytest.raises(ProviderError) as second:
            await client.generate(messages, request_key="synthetic-503")
        assert second.value.code == "REQUEST_UNRESOLVED_NO_RESUBMIT"
        assert len(calls) == 1
        receipt = next(iter(client.ledger.requests.values()))
        assert receipt.state == "unknown"
        assert receipt.response is None
        first_error = str(first.value)
        second_error = str(second.value)
        assert private_error not in first_error
        assert private_error not in second_error
        assert private_error not in caplog.text
    finally:
        await client.aclose()


async def test_concurrent_native_contexts_keep_signal_key_and_output_isolated():
    seen = []
    client = make_client(lambda request: pytest.fail("No network"))

    async def request(body, endpoint, reservation, **kwargs):
        await asyncio.sleep(0)
        seen.append((body, kwargs))
        return response(client.model)

    client._request = request
    signals = [asyncio.Event(), asyncio.Event()]
    await asyncio.gather(
        *(
            client.generate(
                [{"role": "user", "content": str(i)}],
                signal=signals[i],
                request_key=str(i),
                max_output_tokens=i + 1,
            )
            for i in range(2)
        )
    )
    assert sorted(
        (
            body["messages"][0]["content"],
            body["max_tokens"],
            options["request_key"],
            options["signal"] is signals[int(options["request_key"])],
        )
        for body, options in seen
    ) == [("0", 1, "0", True), ("1", 2, "1", True)]
    await client.aclose()


@pytest.mark.parametrize("lost_response", [False, True])
async def test_native_unknown_receipts_replay_without_paid_resubmission(lost_response):
    calls = []

    def handler(request):
        calls.append(request)
        if lost_response:
            raise httpx.ReadTimeout("synthetic uncertain submission")
        return httpx.Response(
            200, json=response("google/gemma-4-26b-a4b-it", usage={"cost": "bad"})
        )

    client = make_client(handler)
    messages = [{"role": "user", "content": "synthetic"}]
    if lost_response:
        with pytest.raises(ProviderError, match="PROVIDER_TRANSPORT"):
            await client.generate(messages, request_key="synthetic")
        with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
            await client.generate(messages, request_key="synthetic")
    else:
        assert await client.generate(messages, request_key="synthetic") == "합성 답변"
        assert await client.generate(messages, request_key="synthetic") == "합성 답변"
    assert len(calls) == 1
    assert next(iter(client.ledger.requests.values())).state == "unknown"
    await client.aclose()


async def test_no_sdk_clients_or_second_ambient_cache(monkeypatch):
    import openai
    from langchain_core import globals as sdk_globals
    from langchain_core.caches import BaseCache

    def forbidden(*args, **kwargs):
        pytest.fail("Native chat must never construct an unmetered SDK client")

    class Cache(BaseCache):
        def lookup(self, *args):
            forbidden()

        def update(self, *args):
            forbidden()

        def clear(self, **kwargs):
            forbidden()

    monkeypatch.setattr(openai, "OpenAI", forbidden)
    monkeypatch.setattr(openai, "AsyncOpenAI", forbidden)
    monkeypatch.setattr(sdk_globals, "_llm_cache", Cache())
    client = make_client(
        lambda request: httpx.Response(200, json=response("google/gemma-4-26b-a4b-it"))
    )
    assert await client.generate([{"role": "user", "content": "synthetic"}]) == "합성 답변"
    assert client._chat.sdk.cache is False and client._chat.sdk.max_retries == 0
    await client.aclose()


@pytest.mark.parametrize("drift", ["boolean", "nested_order"])
async def test_sdk_payload_drift_fails_before_reservation_even_when_python_dicts_equal(
    monkeypatch, drift
):
    original = ChatOpenAI._get_request_payload

    def payload(self, *args, **kwargs):
        value = original(self, *args, **kwargs)
        if drift == "boolean":
            value["temperature"] = False  # False == 0, but wire bytes/fingerprint differ.
        else:
            value["provider"] = dict(reversed(list(value["provider"].items())))
        return value

    monkeypatch.setattr(ChatOpenAI, "_get_request_payload", payload)
    client = make_client(
        lambda request: httpx.Response(200, json=response("google/gemma-4-26b-a4b-it"))
    )
    with pytest.raises(ProviderError, match="INVALID_INPUT"):
        await client.generate([{"role": "user", "content": "synthetic"}])
    assert not client.ledger.requests
    await client.aclose()


@pytest.mark.parametrize("global_setting", ["_debug", "_verbose", "env_hook"])
async def test_private_native_chat_fails_before_reservation_for_global_raw_logging(
    monkeypatch, global_setting, capsys
):
    from contextvars import ContextVar

    from langchain_core import globals as sdk_globals
    from langchain_core.callbacks import BaseCallbackHandler
    from langchain_core.tracers import context

    # Register only in the monkeypatched registry, restored at test exit.
    monkeypatch.setattr(context, "_configure_hooks", list(context._configure_hooks))
    if global_setting == "env_hook":
        context.register_configure_hook(
            ContextVar("synthetic_raw_hook", default=None),
            inheritable=True,
            handle_class=BaseCallbackHandler,
            env_var="PTR_SYNTHETIC_RAW_HOOK",
        )
        monkeypatch.setenv("PTR_SYNTHETIC_RAW_HOOK", "1")
    else:
        monkeypatch.setattr(sdk_globals, global_setting, True)
    client = make_client(lambda request: pytest.fail("No paid submission"))
    sentinel = "SYNTHETIC_PRIVATE_PROMPT"
    with pytest.raises(ProviderError, match="SDK_RAW_TRACING_FORBIDDEN"):
        await client.generate([{"role": "user", "content": sentinel}])
    assert not client.ledger.requests and sentinel not in capsys.readouterr().out
    await client.aclose()


async def test_private_native_chat_detaches_and_restores_ambient_callback_context():
    from langchain_core.callbacks import BaseCallbackHandler
    from langchain_core.runnables.config import var_child_runnable_config
    from langchain_core.tracers.context import collect_runs

    calls = []

    class Recorder(BaseCallbackHandler):
        def on_chat_model_start(self, *args, **kwargs):
            calls.append(args)

        def on_llm_end(self, *args, **kwargs):
            calls.append(args)

    inherited = {"callbacks": [Recorder()], "metadata": {"private": "synthetic"}}
    token = var_child_runnable_config.set(inherited)
    client = make_client(
        lambda request: httpx.Response(200, json=response("google/gemma-4-26b-a4b-it"))
    )
    try:
        with collect_runs() as runs:
            assert await client.generate([{"role": "user", "content": "synthetic"}])
        assert runs.traced_runs == [] and calls == []
        assert var_child_runnable_config.get() is inherited
    finally:
        var_child_runnable_config.reset(token)
        await client.aclose()
