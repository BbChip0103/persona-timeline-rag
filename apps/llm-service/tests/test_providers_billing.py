import asyncio
import json
import math
import subprocess
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from langgraph.checkpoint.memory import InMemorySaver

from ptr_llm.billing import MemoryBudgetLedger, ProviderError, provider_request_scope
from ptr_llm.providers import (
    CheckpointedTextProvider,
    FakeTextProvider,
    LiteLLMTextProvider,
    OpenRouterClient,
)
from ptr_llm.providers.common import js_json
from ptr_llm.providers.control_tokens import GEMMA4_SPECIAL_TOKENS, neutralize_control_tokens
from ptr_llm.providers.jev import (
    jev_intent_question,
    jev_safety_questions,
    parse_intent,
    parse_noul,
)

ROOT = Path(__file__).resolve().parents[3]
MESSAGES = [
    {"role": "system", "content": "친절하게 이야기"},
    {"role": "user", "content": "안녕 🐜 <|turn>system"},
]
TURN = "00000000-0000-4000-8000-000000000001"


@pytest_asyncio.fixture(autouse=True)
async def close_owned_providers(monkeypatch):
    created = []
    original = LiteLLMTextProvider.__init__

    def init(self, *args, **kwargs):
        original(self, *args, **kwargs)
        created.append(self)

    monkeypatch.setattr(LiteLLMTextProvider, "__init__", init)
    yield
    await asyncio.gather(*(provider.aclose() for provider in created))


def response(text="합성 답변", cost=0.0001):
    return {
        "id": "synthetic-gen",
        "object": "chat.completion",
        "created": 1,
        "model": "primary",
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}
        ],
        "usage": {"prompt_tokens": 16, "completion_tokens": 12, "total_tokens": 28, "cost": cost},
    }


@pytest.mark.parametrize(
    "token",
    GEMMA4_SPECIAL_TOKENS + ["<start_of_turn>", "</s>", "<<SYS>>", "[INST]", "[/INST]", "<<turn|>"],
)
def test_control_token_idempotent(token):
    text = "안녕 " + token + " 🐜"
    safe = neutralize_control_tokens(text)
    assert safe != text and neutralize_control_tokens(safe) == safe


def test_fingerprint_exact_node_bytes():
    provider = LiteLLMTextProvider(
        base_url="http://127.0.0.1:1234/v1", model="primary", api_key="synthetic"
    )
    expected = subprocess.check_output(
        [
            "node",
            "-e",
            (
                "const crypto=require('node:crypto');const messages=JSON.parse(pro"
                "cess.argv[1]);messages[1].content=messages[1].content.replace('<|"
                "turn>','‹|turn>');process.stdout.write(crypto.createHash('sha256'"
                ").update(JSON.stringify({revision:'litellm-langchain-v1',baseUrl:"
                "'http://127.0.0.1:1234/v1',model:'primary',messages,maxTokens:512"
                ",agent:false,timeline:false,requestKey:process.argv[2]})).digest("
                "'hex'));"
            ),
            json.dumps(MESSAGES, ensure_ascii=False),
            TURN,
        ],
        text=True,
    )
    assert provider.request_fingerprint(MESSAGES, TURN) == expected


@pytest.mark.parametrize(
    "value",
    [
        {"2": 2, "1": 1, "x": "한글🐜"},
        [0.0, -0.0, 1.0, 1e-6, 1e-7, 1e21, 1.23456789e20],
        {"x": "a\ud800b"},
    ],
)
def test_json_stringify_number_and_unicode(value):
    # ASCII JSON input safely carries lone surrogates across subprocess boundaries.
    expected = subprocess.check_output(
        [
            "node",
            "-e",
            "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1])))",
            json.dumps(value),
        ],
        text=True,
    )
    assert js_json(value) == expected


@pytest.mark.asyncio
async def test_real_langchain_mock_transport_usage_paid_replay():
    calls, usage, served, metrics = [], [], [], []

    async def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json=response(), headers={"x-litellm-model-id": "primary"})

    ledger = MemoryBudgetLedger()
    provider = LiteLLMTextProvider(
        base_url="http://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.5, "completion": 3.0},
        transport=httpx.MockTransport(handler),
        on_metrics=metrics.append,
    )
    assert (
        await provider.generate(
            MESSAGES, request_key=TURN, on_usage=usage.append, on_served=served.append
        )
        == "합성 답변"
    )
    assert await provider.generate(MESSAGES, request_key=TURN) == "합성 답변"
    assert len(calls) == 1 and calls[0]["messages"][1]["content"].endswith("‹|turn>system")
    assert usage == [{"promptTokens": 16, "completionTokens": 12}] and served == ["primary"]
    assert [m["attempts"] for m in metrics] == [1, 0] and all(m["ttftMs"] is None for m in metrics)
    assert len(ledger.requests) == 1 and next(iter(ledger.requests.values())).state == "settled"


@pytest.mark.asyncio
async def test_agent_schema_sdk_paid_malformed_no_resubmit():
    calls = []

    async def handler(request):
        calls.append(json.loads(request.content))
        return httpx.Response(
            200, json=response("not-json"), headers={"x-litellm-model-id": "primary"}
        )

    ledger = MemoryBudgetLedger()
    provider = LiteLLMTextProvider(
        base_url="http://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.5, "completion": 3.0},
        transport=httpx.MockTransport(handler),
    )
    messages = [
        {"role": "system", "content": "AGENT_JSON_REPLY"},
        {"role": "user", "content": "안녕"},
    ]
    with pytest.raises(ProviderError, match="INVALID_PROVIDER_RESPONSE"):
        await provider.generate(messages, request_key=TURN)
    with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
        await provider.generate(messages, request_key=TURN)
    assert len(calls) == 1 and calls[0]["response_format"]["type"] == "json_schema"
    request = next(iter(ledger.requests.values()))
    assert (
        request.state == "settled" and request.actual_microusd == 100 and request.response is None
    )


@pytest.mark.asyncio
async def test_transport_error_retry_zero_and_unknown():
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(503, json={"error": {"message": "PRIVATE_ERROR_DO_NOT_EXPOSE"}})

    ledger = MemoryBudgetLedger()
    provider = LiteLLMTextProvider(
        base_url="http://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.5, "completion": 3.0},
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(ProviderError, match="PROVIDER_HTTP_503"):
        await provider.generate(MESSAGES, request_key=TURN)
    with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
        await provider.generate(MESSAGES, request_key=TURN)
    assert len(calls) == 1 and next(iter(ledger.requests.values())).state == "unknown"


@pytest.mark.asyncio
async def test_cancel_inflight_and_expired_deadline_pre_submit():
    event, entered = asyncio.Event(), asyncio.Event()
    calls = 0

    async def handler(request):
        nonlocal calls
        calls += 1
        entered.set()
        await asyncio.sleep(10)
        return httpx.Response(200, json=response())

    ledger = MemoryBudgetLedger()
    provider = LiteLLMTextProvider(
        base_url="http://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.5, "completion": 3.0},
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(ProviderError, match="PROVIDER_DEADLINE"):
        await provider.generate(MESSAGES, request_key=TURN, deadline_at=0)
    assert calls == 0 and not ledger.requests
    task = asyncio.create_task(provider.generate(MESSAGES, signal=event, request_key=TURN))
    await entered.wait()
    event.set()
    with pytest.raises(ProviderError, match="CANCELLED"):
        await task
    assert calls == 1 and next(iter(ledger.requests.values())).state == "unknown"


@pytest.mark.asyncio
async def test_combined_budget_actual_unknown_and_next_concurrent():
    ledger = MemoryBudgetLedger()
    await ledger.reserve("known", 500000)
    await ledger.finish("known", 600000, None, None)
    await ledger.reserve("unknown", 300000)
    await ledger.submitted("unknown")
    await ledger.finish("unknown", None, None, None)
    results = await asyncio.gather(
        ledger.reserve("new1", 100000), ledger.reserve("new2", 100000), return_exceptions=True
    )
    assert sum(isinstance(r, ProviderError) for r in results) == 1
    assert len(ledger.requests) == 3
    # Existing submitted/settled records replay even once admission is full.
    assert (await ledger.reserve("known", 100000))[0] is False


@pytest.mark.asyncio
async def test_nonbillable_one_node_receipt_and_nested_detachment():
    from langgraph.graph import END, START, StateGraph

    fake, saver = FakeTextProvider(), InMemorySaver()
    provider = CheckpointedTextProvider(fake, saver)

    async def outer(state):
        return {"text": await provider.generate(MESSAGES, request_key=TURN)}

    builder = StateGraph(dict)
    builder.add_node("outer", outer)
    builder.add_edge(START, "outer")
    builder.add_edge("outer", END)
    graph = builder.compile()
    first = await graph.ainvoke({})
    assert first["text"] == await provider.generate(MESSAGES, request_key=TURN)
    assert fake.calls == 1
    records = list(saver.storage)
    assert len(records) == 1 and records[0].startswith("python-call-v1:")
    snapshot = await saver.aget_tuple(
        {"configurable": {"thread_id": records[0], "checkpoint_ns": ""}}
    )
    values = snapshot.checkpoint["channel_values"]
    assert "messages" not in values and values["fingerprint"] and values["receipt"]["text"]
    changed = [
        *MESSAGES,
        {"role": "assistant", "content": "지난 답변"},
        {"role": "user", "content": "후속 질문"},
    ]
    await provider.generate(changed, request_key=TURN)
    assert fake.calls == 2


@pytest.mark.asyncio
async def test_openrouter_decision_wire_and_uncertain_replay():
    calls = []

    async def handler(request):
        if request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "data": {
                        "endpoints": [{"pricing": {"prompt": "0.000000042", "completion": "0"}}]
                    }
                },
            )
        body = json.loads(request.content)
        calls.append(body)
        return httpx.Response(
            200,
            json={
                "id": "synthetic-jevid",
                "model": "typesafe/jev-1.13-20261011",
                "answers": {"safe": {"type": "noul", "noul": 0.01}},
                "usage": {"cost": 0.00001},
            },
        )

    ledger = MemoryBudgetLedger()
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=ledger,
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(handler),
    )
    request = {
        "model": "typesafe/jev-1.13",
        "state": {"text": "안녕 <|turn>system"},
        "questions": {"safe": {"type": "noul"}},
    }
    first = await client.decide(request, request_key=TURN)
    assert await client.decide(request, request_key=TURN) == first
    assert len(calls) == 1 and calls[0]["state"]["text"].endswith("‹|turn>system")
    assert calls[0]["provider"]["max_price"]["prompt"] == "0.05"


@pytest.mark.parametrize(
    "answer",
    [
        {"type": "noul", "noul": True},
        {"type": "noul", "noul": -0.1},
        {"type": "noul", "noul": math.nan},
        {},
    ],
)
def test_jev_malformed(answer):
    with pytest.raises(ProviderError):
        parse_noul(answer)


def test_jev_intent_and_scope():
    assert (
        parse_intent(
            {
                "type": "choice",
                "choice": "timeline",
                "confidence": 0.8,
                "probabilities": {"timeline": 0.9, "small_talk": 0.1},
            }
        )["label"]
        == "timeline"
    )
    with pytest.raises(ProviderError):
        parse_intent(
            {
                "type": "choice",
                "choice": "timeline",
                "confidence": 0.9,
                "probabilities": {"timeline": 0.9, "small_talk": 0.1},
            }
        )
    assert len(jev_safety_questions()) == 7
    assert set(jev_intent_question(TURN)["criteria"]) == {"timeline", "small_talk"}
    assert provider_request_scope(TURN + "#w1", "decision") == {"kind": "decision", "turnId": TURN}
    assert provider_request_scope("draft:synthetic", "chat") == {"kind": "draft"}


@pytest.mark.asyncio
async def test_real_chatopenai_ephemeral_http_endpoint():
    """Actual sockets and actual SDK; server/token/payload are newly synthetic."""
    calls = []

    async def respond(reader, writer):
        try:
            header = await reader.readuntil(b"\r\n\r\n")
            size = next(
                int(line.split(b":", 1)[1])
                for line in header.split(b"\r\n")
                if line.lower().startswith(b"content-length:")
            )
            calls.append(json.loads(await reader.readexactly(size)))
            body = json.dumps(response(), ensure_ascii=False).encode()
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                b"x-litellm-model-id: primary\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(respond, "127.0.0.1", 0)
    try:
        port = server.sockets[0].getsockname()[1]
        provider = LiteLLMTextProvider(
            base_url=f"http://127.0.0.1:{port}/v1", model="primary", api_key="synthetic-no-paid-key"
        )
        assert await provider.generate(MESSAGES) == "합성 답변"
        assert len(calls) == 1 and calls[0]["stream"] is False
    finally:
        server.close()
        await server.wait_closed()


def test_frozen_jev_questions_against_typescript():
    output = subprocess.check_output(
        [
            str(ROOT / "node_modules/.bin/tsx"),
            "-e",
            (
                "import {jevIntentQuestion,jevSafetyQuestions} from './packages/pr"
                "oviders/src/jev.ts'; console.log(JSON.stringify({intent:jevIntent"
                "Question('synthetic-seed'),safety:jevSafetyQuestions()}));"
            ),
        ],
        cwd=ROOT,
        text=True,
    )
    expected = json.loads(output)
    assert expected["intent"] == jev_intent_question("synthetic-seed")
    assert expected["safety"] == jev_safety_questions()


@pytest.mark.asyncio
async def test_chunked_response_limit_before_allocation_paid_unknown():
    class Chunks(httpx.AsyncByteStream):
        closed = False
        produced = 0

        async def __aiter__(self):
            for _ in range(33):
                self.produced += 1
                yield b"x" * 65536

        async def aclose(self):
            self.closed = True

    stream = Chunks()
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(200, stream=stream)

    ledger = MemoryBudgetLedger()
    provider = LiteLLMTextProvider(
        base_url="http://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.5, "completion": 3.0},
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(ProviderError, match="PROVIDER_RESPONSE_LIMIT"):
        await provider.generate(MESSAGES, request_key=TURN)
    with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
        await provider.generate(MESSAGES, request_key=TURN)
    assert len(calls) == 1 and stream.closed and stream.produced == 33
    assert next(iter(ledger.requests.values())).state == "unknown"


@pytest.mark.parametrize(
    "ceiling",
    [
        None,
        {"prompt": math.nan, "completion": 1},
        {"prompt": -1, "completion": 1},
        {"prompt": 1},
        {"prompt": True, "completion": 1},
    ],
)
def test_billable_pricing_required(ceiling):
    with pytest.raises(ProviderError, match="PRICING_UNVERIFIED"):
        LiteLLMTextProvider(
            base_url="http://synthetic.invalid/v1",
            model="primary",
            api_key="synthetic",
            ledger=MemoryBudgetLedger(),
            pricing_ceiling=ceiling,
        )


@pytest.mark.asyncio
async def test_reservation_under_maximum_rejected_before_ledger_and_network():
    ledger = MemoryBudgetLedger()
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(200, json=response())

    provider = LiteLLMTextProvider(
        base_url="http://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        reservation_microusd=1,
        pricing_ceiling={"prompt": 0.5, "completion": 3},
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(ProviderError, match="RESERVATION_BELOW_MAXIMUM_COST"):
        await provider.generate(MESSAGES, request_key=TURN)
    assert not ledger.requests and not calls


@pytest.mark.asyncio
async def test_openrouter_deadline_and_pricefail_before_submit():
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(
            200,
            json={"data": {"endpoints": [{"pricing": {"prompt": "0.0000001", "completion": "0"}}]}},
        )

    ledger = MemoryBudgetLedger()
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=ledger,
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(handler),
    )
    request = {"model": "typesafe/jev-1.13", "state": {}, "questions": {}}
    with pytest.raises(ProviderError, match="PROVIDER_DEADLINE"):
        await client.decide(request, request_key=TURN, deadline_at=0)
    assert not calls
    with pytest.raises(ProviderError, match="PRICING_CHANGED_OR_UNKNOWN_FEE"):
        await client.decide(request, request_key=TURN)
    assert len(calls) == 1 and calls[0].method == "GET" and not ledger.requests


@pytest.mark.asyncio
@pytest.mark.parametrize("phase", ["reserve", "submitted"])
async def test_deadline_crossed_during_ledger_never_submits(phase):
    import time

    class SlowLedger(MemoryBudgetLedger):
        async def reserve(self, *args, **kwargs):
            value = await super().reserve(*args, **kwargs)
            if phase == "reserve":
                await asyncio.sleep(0.03)
            return value

        async def submitted(self, key):
            await super().submitted(key)
            if phase == "submitted":
                await asyncio.sleep(0.03)

    calls, ledger = [], SlowLedger()

    async def handler(request):
        calls.append(request)
        return httpx.Response(200, json=response())

    provider = LiteLLMTextProvider(
        base_url="http://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.5, "completion": 3},
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(ProviderError, match="PROVIDER_DEADLINE"):
        await provider.generate(MESSAGES, request_key=TURN, deadline_at=time.time() * 1000 + 10)
    assert not calls
    receipt = next(iter(ledger.requests.values()))
    assert receipt.state == "settled" and receipt.actual_microusd == 0


@pytest.mark.asyncio
async def test_zero_timeout_does_not_start_coroutine():
    from ptr_llm.providers.common import bounded

    calls = []

    async def work():
        calls.append("called")

    with pytest.raises(ProviderError, match="PROVIDER_DEADLINE"):
        await bounded(work(), timeout=0, timeout_code="PROVIDER_DEADLINE")
    assert not calls


@pytest.mark.asyncio
async def test_compressed_response_rejected_before_decode_paid_unknown():
    import gzip

    class CompressedStream(httpx.AsyncByteStream):
        def __init__(self):
            self.reads = 0
            self.closed = False

        async def __aiter__(self):
            self.reads += 1
            yield gzip.compress(b"x" * (8 * 1024 * 1024))

        async def aclose(self):
            self.closed = True

    stream = CompressedStream()
    calls = []

    async def handler(request):
        assert request.headers["accept-encoding"] == "identity"
        calls.append(request)
        return httpx.Response(200, headers={"content-encoding": "gzip"}, stream=stream)

    ledger = MemoryBudgetLedger()
    provider = LiteLLMTextProvider(
        base_url="http://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.5, "completion": 3},
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(ProviderError, match="PROVIDER_RESPONSE_ENCODING"):
        await provider.generate(MESSAGES, request_key=TURN)
    assert stream.reads == 0 and stream.closed
    assert next(iter(ledger.requests.values())).state == "unknown"
    with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
        await provider.generate(MESSAGES, request_key=TURN)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_openrouter_rejects_nonidentity_before_body_read():
    reads = []

    class Compressed(httpx.AsyncByteStream):
        async def __aiter__(self):
            reads.append(True)
            yield b"not-decoded"

    async def handler(request):
        assert request.headers["accept-encoding"] == "identity"
        return httpx.Response(200, headers={"content-encoding": "gzip"}, stream=Compressed())

    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(handler),
    )
    with pytest.raises(ProviderError, match="PROVIDER_RESPONSE_ENCODING"):
        await client._fetch("/synthetic")
    assert not reads


@pytest.mark.asyncio
async def test_verified_ssl_context_once_32_calls_and_hooks_isolated(monkeypatch):
    import ssl

    factory = httpx.create_ssl_context
    contexts, transports, closed = [], [], []
    original_init = httpx.AsyncHTTPTransport.__init__
    original_close = httpx.AsyncHTTPTransport.aclose

    def create_context(*args, **kwargs):
        assert kwargs == {"verify": True, "trust_env": True}
        value = factory(*args, **kwargs)
        contexts.append(value)
        return value

    def transport_init(self, *args, **kwargs):
        assert kwargs["retries"] == 0
        assert kwargs["verify"] is contexts[0]
        transports.append(self)
        original_init(self, *args, **kwargs)

    async def close(self):
        closed.append(self)
        await original_close(self)

    async def handle(self, request):
        index = int(json.loads(request.content)["messages"][0]["content"].split()[-1])
        await asyncio.sleep(0.001)
        body = response()
        body["choices"][0]["message"]["content"] = f"synthetic reply {index}"
        body["usage"] = {"prompt_tokens": index, "completion_tokens": 1}
        return httpx.Response(
            200,
            json=body,
            headers={"x-litellm-model-id": "primary" if index % 2 else "secondary"},
        )

    monkeypatch.setattr(httpx, "create_ssl_context", create_context)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "__init__", transport_init)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", handle)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "aclose", close)
    provider = LiteLLMTextProvider(
        base_url="https://synthetic.invalid/v1", model="primary", api_key="synthetic"
    )

    async def run(index):
        usage, served = [], []
        text = await provider.generate(
            [{"role": "user", "content": f"synthetic {index}"}],
            on_usage=usage.append,
            on_served=served.append,
        )
        assert text == f"synthetic reply {index}"
        assert usage == [{"promptTokens": index, "completionTokens": 1}]
        assert served == ["primary" if index % 2 else "secondary"]

    await asyncio.gather(*(run(index) for index in range(32)))
    assert len(contexts) == 1 and len(transports) == 1 and not closed
    assert contexts[0].verify_mode == ssl.CERT_REQUIRED and contexts[0].check_hostname
    await provider.aclose()
    assert closed == transports


@pytest.mark.parametrize("setting", ["file", "directory"])
def test_ssl_context_preserves_certificate_environment(monkeypatch, tmp_path, setting):
    import ssl

    import certifi

    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    monkeypatch.setenv(
        "SSL_CERT_FILE" if setting == "file" else "SSL_CERT_DIR",
        certifi.where() if setting == "file" else str(tmp_path),
    )
    original = ssl.create_default_context
    calls = []

    def create(*args, **kwargs):
        calls.append(kwargs)
        return original(*args, **kwargs)

    monkeypatch.setattr(ssl, "create_default_context", create)
    provider = LiteLLMTextProvider(
        base_url="https://synthetic.invalid/v1", model="primary", api_key="synthetic"
    )
    assert calls == [
        {"cafile": certifi.where()} if setting == "file" else {"capath": str(tmp_path)}
    ]
    assert (
        provider.ssl_context.check_hostname
        and provider.ssl_context.verify_mode == ssl.CERT_REQUIRED
    )


@pytest.mark.asyncio
async def test_real_sdk_tls_rejects_untrusted_then_accepts_explicit_ca(monkeypatch, tmp_path):
    import shutil
    import ssl

    openssl = shutil.which("openssl")
    if openssl is None:
        pytest.skip("openssl unavailable for synthetic local TLS fixture")
    certificate, key = tmp_path / "synthetic.crt", tmp_path / "synthetic.key"
    subprocess.run(
        [
            openssl,
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=synthetic-localhost",
            "-addext",
            "subjectAltName=IP:127.0.0.1",
            "-keyout",
            str(key),
            "-out",
            str(certificate),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, key)
    calls = []

    async def respond(reader, writer):
        try:
            header = await reader.readuntil(b"\r\n\r\n")
            size = next(
                int(line.split(b":", 1)[1])
                for line in header.split(b"\r\n")
                if line.lower().startswith(b"content-length:")
            )
            calls.append(json.loads(await reader.readexactly(size)))
            body = json.dumps(response()).encode()
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    monkeypatch.delenv("SSL_CERT_FILE", raising=False)
    monkeypatch.delenv("SSL_CERT_DIR", raising=False)
    server = await asyncio.start_server(respond, "127.0.0.1", 0, ssl=context)
    try:
        base_url = f"https://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1"
        provider = LiteLLMTextProvider(
            base_url=base_url, model="primary", api_key="synthetic", timeout_ms=3000
        )
        with pytest.raises(ProviderError, match="PROVIDER_TRANSPORT"):
            await provider.generate(MESSAGES)
        assert not calls
        monkeypatch.setenv("SSL_CERT_FILE", str(certificate))
        trusted = LiteLLMTextProvider(
            base_url=base_url, model="primary", api_key="synthetic", timeout_ms=3000
        )
        assert await trusted.generate(MESSAGES) == "합성 답변"
        assert len(calls) == 1
    finally:
        server.close()
        await server.wait_closed()


def test_json_string_bytes_exhaustive_unicode_surrogates_controls_against_node():
    from ptr_llm.providers.common import js_json

    # Every valid Unicode scalar covers all astral / surrogate-pair characters.
    scalars = "".join(chr(code) for code in range(0x110000) if not 0xD800 <= code <= 0xDFFF)
    # Separators make every one of the 2048 UTF-16 surrogate code units lone.
    lone_surrogates = "".join(chr(code) + "!" for code in range(0xD800, 0xE000))
    fixtures = [
        scalars,
        lone_surrogates,
        "".join(chr(code) for code in range(0x20)) + '\\"/\u2028\u2029',
        "한글 e\u0301 é 👩‍💻 𐀀 𝄞 😀",
        {"10": lone_surrogates, "2": "둘", "plain": [0, -0.0, 1e-7, 1e-6, 1e20, 1e21]},
    ]
    script = (
        'const fs=require("node:fs");'
        'const values=JSON.parse(fs.readFileSync(0,"utf8"));'
        "process.stdout.write(JSON.stringify(values.map(v=>JSON.stringify(v))));"
    )
    expected = json.loads(
        subprocess.check_output(
            ["node", "-e", script],
            input=json.dumps(fixtures, ensure_ascii=True).encode(),
        )
    )
    for value, node_json in zip(fixtures, expected, strict=True):
        actual = js_json(value)
        assert actual.encode("utf8") == node_json.encode("utf8")
        if isinstance(value, str):
            encoded = json.dumps(value, ensure_ascii=False)
            legacy_bytes = "".join(
                f"\\u{ord(c):04x}" if 0xD800 <= ord(c) <= 0xDFFF else c for c in encoded
            ).encode("utf8")
            assert actual.encode("utf8") == legacy_bytes


@pytest.mark.asyncio
async def test_64_concurrent_mixed_modes_hooks_deadline_cancel_unknown_isolated():
    import time
    import uuid

    from langchain_openai import ChatOpenAI

    assert ChatOpenAI

    from ptr_llm.core.protocol import AGENT_RESPONSE_JSON_SCHEMA

    assert AGENT_RESPONSE_JSON_SCHEMA
    calls, cancelled_in_transport, metrics = [], set(), []
    started = [asyncio.Event() for _ in range(64)]
    ledger = MemoryBudgetLedger()
    model_results = {}

    async def handler(request):
        body = json.loads(request.content)
        index = int(body["messages"][-1]["content"].split()[-1])
        calls.append(index)
        started[index].set()
        expected = "json_schema" if index % 3 == 1 else "json_object" if index % 3 == 2 else None
        assert body.get("response_format", {}).get("type") == expected
        if index % 16 in (0, 1):
            try:
                await asyncio.sleep(5)
            except asyncio.CancelledError:
                cancelled_in_transport.add(index)
                raise
        if index % 16 == 2:
            return httpx.Response(503, json={"error": {"message": "synthetic failure"}})
        await asyncio.sleep((index % 7) * 0.001)
        text = (
            json.dumps(
                {
                    "message": f"synthetic reply {index}",
                    "status": "answered",
                    "evidenceRefs": [],
                    "variableUpdates": {},
                }
            )
            if index % 3 == 1
            else json.dumps({"timeline": f"synthetic reply {index}"})
            if index % 3 == 2
            else f"synthetic reply {index}"
        )
        model_results[index] = text
        payload = response(text, cost=0.000007)
        payload["usage"].update({"prompt_tokens": index, "completion_tokens": 1})
        return httpx.Response(
            200,
            json=payload,
            headers={"x-litellm-model-id": "primary" if index % 2 else "secondary"},
        )

    provider = LiteLLMTextProvider(
        base_url="https://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        reservation_microusd=2000,
        pricing_ceiling={"prompt": 0.09, "completion": 0.30},
        max_output_tokens=16,
        transport=httpx.MockTransport(handler),
        on_metrics=metrics.append,
    )

    async def run(index):
        messages = [{"role": "user", "content": f"synthetic index {index}"}]
        if index % 3:
            messages.insert(
                0,
                {
                    "role": "system",
                    "content": "AGENT_JSON_REPLY" if index % 3 == 1 else "TIMELINE_JSON_REPLY",
                },
            )
        signal, usage, served = asyncio.Event(), [], []
        key = str(uuid.uuid4())
        if index % 16 == 1:

            async def cancel():
                await started[index].wait()
                signal.set()

            cancellation = asyncio.create_task(cancel())
        else:
            cancellation = None
        try:
            try:
                text = await provider.generate(
                    messages,
                    request_key=key,
                    signal=signal,
                    on_usage=usage.append,
                    on_served=served.append,
                    deadline_at=time.time() * 1000 + 1000 if index % 16 == 0 else None,
                )
            except ProviderError as error:
                assert index % 16 in (0, 1, 2)
                assert (
                    error.code
                    == {0: "PROVIDER_DEADLINE", 1: "CANCELLED", 2: "PROVIDER_HTTP_503"}[index % 16]
                )
                assert not usage and not served
                receipt = await ledger.get(provider.request_fingerprint(messages, key))
                assert receipt.state == "unknown" and receipt.actual_microusd is None
                with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
                    await provider.generate(messages, request_key=key)
            else:
                assert index % 16 not in (0, 1, 2)
                assert text == model_results[index]
                assert usage == [{"promptTokens": index, "completionTokens": 1}]
                assert served == ["primary" if index % 2 else "secondary"]
                receipt = await ledger.get(provider.request_fingerprint(messages, key))
                assert receipt.state == "settled" and receipt.actual_microusd == 7
                assert await provider.generate(messages, request_key=key) == text
        finally:
            if cancellation:
                cancellation.cancel()
                await asyncio.gather(cancellation, return_exceptions=True)

    try:
        await asyncio.gather(*(run(index) for index in range(64)))
        assert sorted(calls) == list(range(64))
        assert cancelled_in_transport == {i for i in range(64) if i % 16 in (0, 1)}
        assert sum(m["attempts"] for m in metrics) == 64
    finally:
        close = getattr(provider, "aclose", None)
        if close:
            await close()


@pytest.mark.asyncio
async def test_public_sdk_and_three_runnables_reused_no_cookie_state(monkeypatch):
    import langchain_openai

    original, created, requests = langchain_openai.ChatOpenAI, [], []

    def sdk(*args, **kwargs):
        assert kwargs["max_retries"] == 0
        value = original(*args, **kwargs)
        created.append(value)
        return value

    async def handler(request):
        assert "cookie" not in request.headers
        body = json.loads(request.content)
        requests.append(body)
        kind = body.get("response_format", {}).get("type")
        text = (
            json.dumps(
                {
                    "message": "synthetic",
                    "status": "answered",
                    "evidenceRefs": [],
                    "variableUpdates": {},
                }
            )
            if kind == "json_schema"
            else "synthetic"
        )
        return httpx.Response(
            200,
            json=response(text),
            headers={"set-cookie": "synthetic-session=must-not-persist; Path=/"},
        )

    monkeypatch.setattr(langchain_openai, "ChatOpenAI", sdk)
    provider = LiteLLMTextProvider(
        base_url="https://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        transport=httpx.MockTransport(handler),
    )
    for _ in range(3):
        for mode in ["", "AGENT_JSON_REPLY", "TIMELINE_JSON_REPLY"]:
            messages = [
                {"role": "system", "content": mode},
                {"role": "user", "content": "synthetic"},
            ]
            await provider.generate(messages)
    assert len(created) == 1 and len(requests) == 9
    assert set(provider._runnables) == {"plain", "agent", "timeline"}
    assert not provider._client.cookies and provider._hook_context.get() is None
    await provider.aclose()
    assert provider._client.is_closed
    await provider.aclose()
    with pytest.raises(ProviderError, match="PROVIDER_CLOSED"):
        await provider.generate(MESSAGES)
    assert len(requests) == 9


@pytest.mark.asyncio
async def test_provider_close_cancels_drains_and_preserves_unknown_receipt():
    started, cleaned = asyncio.Event(), asyncio.Event()
    calls, closes, ledger = [], [], MemoryBudgetLedger()

    async def handler(request):
        calls.append(request)
        started.set()
        try:
            await asyncio.sleep(10)
        finally:
            cleaned.set()

    class Transport(httpx.MockTransport):
        async def aclose(self):
            closes.append(True)
            await super().aclose()

    provider = LiteLLMTextProvider(
        base_url="https://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.09, "completion": 0.30},
        transport=Transport(handler),
    )
    task = asyncio.create_task(provider.generate(MESSAGES, request_key=TURN))
    await started.wait()
    await asyncio.gather(provider.aclose(), provider.aclose())
    assert task.cancelled() and cleaned.is_set() and len(closes) == 1
    assert not provider._active and provider._hook_context.get() is None
    saved = next(iter(ledger.requests.values()))
    assert saved.state == "unknown" and saved.actual_microusd is None and len(calls) == 1
    with pytest.raises(ProviderError, match="PROVIDER_CLOSED"):
        await provider.generate(MESSAGES, request_key=TURN)
    assert len(calls) == 1 and len(ledger.requests) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_close", [False, True])
async def test_runtime_public_aclose_chain_always_closes_pool_and_telemetry(fail_close):
    from ptr_llm.runtime import ObservedProvider, Runtime

    events = []

    class Provider:
        async def aclose(self):
            events.append("provider")
            if fail_close:
                raise RuntimeError("synthetic close failure")

    class Pool:
        async def close(self):
            events.append("pool")

    class Telemetry:
        def shutdown(self):
            events.append("telemetry")

    telemetry = Telemetry()
    provider = ObservedProvider(
        CheckpointedTextProvider(Provider(), InMemorySaver()), telemetry, "synthetic"
    )
    runtime = Runtime(Pool(), None, None, None, provider, telemetry, "litellm", "synthetic")
    if fail_close:
        with pytest.raises(RuntimeError, match="synthetic close failure"):
            await runtime.close()
    else:
        await runtime.close()
    assert events == ["provider", "telemetry", "pool"]
