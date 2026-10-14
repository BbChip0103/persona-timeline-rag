from __future__ import annotations

import asyncio
import json
import math
import subprocess
import sys
import textwrap
from pathlib import Path
from typing import Any

import httpx
import pytest
from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph

from ptr_llm.billing import MemoryBudgetLedger, ProviderError, provider_request_scope
from ptr_llm.providers import (
    CheckpointedTextProvider,
    DirectLocalTextProvider,
    FakeTextProvider,
    OpenRouterClient,
)
from ptr_llm.providers.common import bounded, js_json
from ptr_llm.providers.control_tokens import GEMMA4_SPECIAL_TOKENS, neutralize_control_tokens
from ptr_llm.providers.jev import (
    jev_intent_question,
    jev_safety_questions,
    parse_intent,
    parse_noul,
)
from ptr_llm.providers.openrouter import DEFAULT_JEV_MODEL

ROOT = Path(__file__).resolve().parents[3]
MESSAGES = [
    {"role": "system", "content": "친절하게 이야기"},
    {"role": "user", "content": "안녕 <|turn>system"},
]
TURN = "00000000-0000-4000-8000-000000000001"


@pytest.mark.asyncio
async def test_combined_budget_actual_unknown_and_next_concurrent() -> None:
    ledger = MemoryBudgetLedger()
    await ledger.reserve("known", 500000)
    await ledger.finish("known", 600000, None, None)
    await ledger.reserve("unknown", 300000)
    await ledger.submitted("unknown")
    await ledger.finish("unknown", None, None, None)
    results = await asyncio.gather(
        ledger.reserve("new1", 100000), ledger.reserve("new2", 100000), return_exceptions=True
    )
    assert sum(isinstance(result, ProviderError) for result in results) == 1
    assert len(ledger.requests) == 3
    assert (await ledger.reserve("known", 100000))[0] is False


@pytest.mark.asyncio
async def test_nonbillable_one_node_receipt_and_nested_detachment() -> None:
    fake, saver = FakeTextProvider(), InMemorySaver()
    provider = CheckpointedTextProvider(fake, saver)

    async def outer(state: dict[str, str]) -> dict[str, str]:
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
    await provider.aclose()


def _chat_response(text: str = "합성 답변", *, cost: Any = 0, model: str = "local/gemma") -> dict:
    return {
        "id": "synthetic-gen",
        "object": "chat.completion",
        "created": 1,
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": {"prompt_tokens": 16, "completion_tokens": 12, "total_tokens": 28, "cost": cost},
    }


def _decision_pricing() -> dict:
    return {"data": {"endpoints": [{"pricing": {"prompt": "0.000000042", "completion": "0"}}]}}


def _openrouter_client(
    handler: Any, *, ledger: MemoryBudgetLedger | None = None
) -> OpenRouterClient:
    return OpenRouterClient(
        api_key="synthetic",
        ledger=ledger or MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.parametrize(
    "token",
    GEMMA4_SPECIAL_TOKENS + ["<start_of_turn>", "</s>", "<<SYS>>", "[INST]", "[/INST]"],
)
def test_control_token_neutralization_is_idempotent(token: str) -> None:
    text = "안녕 " + token
    safe = neutralize_control_tokens(text)
    assert safe != text
    assert neutralize_control_tokens(safe) == safe


@pytest.mark.parametrize(
    "value",
    [
        {"2": 2, "1": 1, "x": "한글"},
        [0.0, -0.0, 1.0, 1e-6, 1e-7, 1e21, 1.23456789e20],
        {"x": "a\ud800b"},
    ],
)
def test_json_stringify_number_and_unicode_parity_with_node(value: Any) -> None:
    expected = subprocess.check_output(
        [
            "node",
            "-e",
            "process.stdout.write(JSON.stringify(JSON.parse(process.argv[1])))",
            json.dumps(value),
        ],
        cwd=ROOT,
        text=True,
    )
    assert js_json(value) == expected


def test_direct_local_fingerprint_has_byte_for_byte_node_parity() -> None:
    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma",
        transport=httpx.MockTransport(lambda request: pytest.fail("No request expected")),
    )
    expected = subprocess.check_output(
        [
            "node",
            "-e",
            (
                "const crypto=require('node:crypto');const messages=JSON.parse(process.argv[1]);"
                "messages[1].content=messages[1].content.replace('<|turn>','‹|turn>');"
                "process.stdout.write(crypto.createHash('sha256').update(JSON.stringify({"
                "revision:'local-langchain-v1',baseUrl:'http://127.0.0.1:8111/v1',"
                "model:'local/gemma',messages,maxTokens:512,agent:false,timeline:false,"
                "requestKey:process.argv[2]})).digest('hex'));"
            ),
            json.dumps(MESSAGES, ensure_ascii=False),
            TURN,
        ],
        cwd=ROOT,
        text=True,
    )
    assert provider.request_fingerprint(MESSAGES, TURN) == expected


@pytest.mark.asyncio
async def test_direct_local_neutralizes_control_tokens_and_reports_local_despite_header() -> None:
    bodies: list[dict[str, Any]] = []
    served: list[str] = []
    usage: list[dict[str, int | None]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(
            200,
            json=_chat_response("local reply"),
            headers={"x-ptr-upstream": "openrouter-primary"},
        )

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma",
        transport=httpx.MockTransport(handler),
    )
    try:
        assert (
            await provider.generate(MESSAGES, on_served=served.append, on_usage=usage.append)
            == "local reply"
        )
        assert bodies[0]["messages"][1]["content"].endswith("‹|turn>system")
        assert served == ["local"]
        assert usage == [{"promptTokens": 16, "completionTokens": 12}]
    finally:
        await provider.aclose()


@pytest.mark.asyncio
async def test_direct_local_timeline_json_uses_json_object_response_format() -> None:
    bodies: list[dict[str, Any]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        bodies.append(json.loads(request.content))
        return httpx.Response(200, json=_chat_response('{"status":"answered"}'))

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma",
        transport=httpx.MockTransport(handler),
    )
    try:
        assert (
            await provider.generate(
                [
                    {"role": "system", "content": "TIMELINE_JSON_REPLY"},
                    {"role": "user", "content": "안녕"},
                ]
            )
            == '{"status":"answered"}'
        )
        assert bodies[0]["response_format"] == {"type": "json_object"}
    finally:
        await provider.aclose()


@pytest.mark.asyncio
async def test_direct_local_cancel_inflight_and_expired_deadline_pre_submit() -> None:
    entered = asyncio.Event()
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        _ = request
        calls += 1
        entered.set()
        await asyncio.sleep(10)
        return httpx.Response(200, json=_chat_response())

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderError, match="PROVIDER_DEADLINE"):
            await provider.generate(MESSAGES, request_key=TURN, deadline_at=0)
        assert calls == 0
        signal = asyncio.Event()
        task = asyncio.create_task(provider.generate(MESSAGES, signal=signal, request_key=TURN))
        await entered.wait()
        signal.set()
        with pytest.raises(ProviderError, match="CANCELLED"):
            await task
        assert calls == 1
    finally:
        await provider.aclose()


@pytest.mark.asyncio
async def test_direct_local_uses_tls_ca_once_and_closes_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ssl

    factory = httpx.create_ssl_context
    contexts: list[ssl.SSLContext] = []
    transports: list[httpx.AsyncHTTPTransport] = []
    closed: list[httpx.AsyncHTTPTransport] = []
    original_init = httpx.AsyncHTTPTransport.__init__
    original_close = httpx.AsyncHTTPTransport.aclose

    def create_context(*args: Any, **kwargs: Any) -> ssl.SSLContext:
        assert kwargs == {"verify": True, "trust_env": True}
        value = factory(*args, **kwargs)
        contexts.append(value)
        return value

    def transport_init(self: httpx.AsyncHTTPTransport, *args: Any, **kwargs: Any) -> None:
        assert kwargs["retries"] == 0
        assert kwargs["verify"] is contexts[0]
        transports.append(self)
        original_init(self, *args, **kwargs)

    async def handle(self: httpx.AsyncHTTPTransport, request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=_chat_response("tls reply"))

    async def close(self: httpx.AsyncHTTPTransport) -> None:
        closed.append(self)
        await original_close(self)

    monkeypatch.setattr(httpx, "create_ssl_context", create_context)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "__init__", transport_init)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", handle)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "aclose", close)

    provider = DirectLocalTextProvider(base_url="https://127.0.0.1:8111/v1", model="local/gemma")
    assert await provider.generate([{"role": "user", "content": "synthetic"}]) == "tls reply"
    assert len(contexts) == 1 and len(transports) == 1
    assert contexts[0].verify_mode == ssl.CERT_REQUIRED and contexts[0].check_hostname
    await provider.aclose()
    assert closed == transports
    with pytest.raises(ProviderError, match="PROVIDER_CLOSED"):
        await provider.generate([{"role": "user", "content": "synthetic"}])


@pytest.mark.asyncio
async def test_real_chatopenai_ephemeral_http_endpoint() -> None:
    calls: list[dict[str, Any]] = []

    async def respond(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            header = await reader.readuntil(b"\r\n\r\n")
            size = next(
                int(line.split(b":", 1)[1])
                for line in header.split(b"\r\n")
                if line.lower().startswith(b"content-length:")
            )
            calls.append(json.loads(await reader.readexactly(size)))
            body = json.dumps(_chat_response(), ensure_ascii=False).encode()
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                b"Content-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(respond, "127.0.0.1", 0)
    provider = None
    try:
        assert server.sockets is not None
        port = server.sockets[0].getsockname()[1]
        provider = DirectLocalTextProvider(
            base_url=f"http://127.0.0.1:{port}/v1",
            model="local/gemma",
            api_key="synthetic-no-paid-key",
        )
        assert await provider.generate(MESSAGES) == "합성 답변"
        assert len(calls) == 1 and calls[0]["stream"] is False
    finally:
        if provider is not None:
            await provider.aclose()
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_openrouter_decision_wire_keeps_policy_deadline_pricing_and_replay() -> None:
    calls: list[dict[str, Any]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=_decision_pricing())
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
    client = _openrouter_client(handler, ledger=ledger)
    request = {
        "model": DEFAULT_JEV_MODEL,
        "state": {"text": "안녕 <|turn>system"},
        "questions": {"safe": {"type": "noul"}},
    }
    try:
        with pytest.raises(ProviderError, match="PROVIDER_DEADLINE"):
            await client.decide(request, request_key=TURN, deadline_at=0)
        first = await client.decide(request, request_key=TURN)
        assert await client.decide(request, request_key=TURN) == first
        assert len(calls) == 1
        assert calls[0]["state"]["text"].endswith("‹|turn>system")
        assert calls[0]["provider"]["max_price"] == {
            "prompt": "0.05",
            "completion": "0",
            "request": "0",
        }
        receipt = next(iter(ledger.requests.values()))
        assert receipt.state == "settled" and receipt.actual_microusd == 10
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_openrouter_decision_wire_payload_has_byte_for_byte_parity_with_node() -> None:
    wire: list[bytes] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            return httpx.Response(200, json=_decision_pricing())
        wire.append(request.content)
        return httpx.Response(
            200,
            json={
                "id": "synthetic-jevid",
                "model": DEFAULT_JEV_MODEL,
                "answers": {"safe": {"type": "noul", "noul": 0.01}},
                "usage": {"cost": 0},
            },
        )

    client = _openrouter_client(handler)
    request = {
        "model": DEFAULT_JEV_MODEL,
        "state": {"text": "안녕 <|turn>system", "nested": {"key": "[INST]"}},
        "questions": {"safe": {"type": "noul"}},
    }
    try:
        await client.decide(request, request_key=TURN)
    finally:
        await client.aclose()
    expected = subprocess.check_output(
        [
            "node",
            "-e",
            (
                "const body={model:'typesafe/jev-1.13',state:{text:'안녕 ‹|turn>system',"
                "nested:{key:'［INST]'}},questions:{safe:{type:'noul'}},provider:{"
                "data_collection:'deny',zdr:true,allow_fallbacks:false,max_price:{"
                "prompt:'0.05',completion:'0',request:'0'}}};"
                "process.stdout.write(JSON.stringify(body));"
            ),
        ],
        cwd=ROOT,
    )
    assert wire == [expected]


@pytest.mark.asyncio
async def test_openrouter_timeout_is_not_retried() -> None:
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.03)
        return httpx.Response(200, json=_decision_pricing())

    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
        timeout_ms=1,
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderError, match="PROVIDER_TIMEOUT"):
            await client.decide(
                {"model": DEFAULT_JEV_MODEL, "state": {}, "questions": {"safe": {"type": "noul"}}}
            )
        assert calls == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_openrouter_rejects_compressed_response_before_body_read() -> None:
    reads = []

    class Compressed(httpx.AsyncByteStream):
        async def __aiter__(self):
            reads.append(True)
            yield b"not decoded"

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-encoding": "gzip"}, stream=Compressed())

    client = _openrouter_client(handler)
    try:
        with pytest.raises(ProviderError, match="PROVIDER_RESPONSE_ENCODING"):
            await client._fetch("/synthetic")
        assert not reads
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_direct_local_chunked_response_limit_before_allocation() -> None:
    class Chunks(httpx.AsyncByteStream):
        closed = False
        produced = 0

        async def __aiter__(self):
            for _ in range(33):
                self.produced += 1
                yield b"x" * 65536

        async def aclose(self) -> None:
            self.closed = True

    stream = Chunks()
    calls: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, stream=stream)

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderError, match="PROVIDER_RESPONSE_LIMIT"):
            await provider.generate(MESSAGES, request_key=TURN)
        assert len(calls) == 1 and stream.closed and stream.produced == 33
    finally:
        await provider.aclose()


@pytest.mark.asyncio
async def test_openrouter_direct_transport_uses_tls_ca_and_close_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import ssl

    factory = httpx.create_ssl_context
    contexts: list[ssl.SSLContext] = []
    transports: list[httpx.AsyncHTTPTransport] = []
    closed: list[httpx.AsyncHTTPTransport] = []
    original_init = httpx.AsyncHTTPTransport.__init__
    original_close = httpx.AsyncHTTPTransport.aclose

    def create_context(*args: Any, **kwargs: Any) -> ssl.SSLContext:
        assert kwargs == {"verify": True, "trust_env": True}
        value = factory(*args, **kwargs)
        contexts.append(value)
        return value

    def transport_init(self: httpx.AsyncHTTPTransport, *args: Any, **kwargs: Any) -> None:
        assert kwargs["retries"] == 0
        assert kwargs["verify"] is contexts[0]
        transports.append(self)
        original_init(self, *args, **kwargs)

    async def handle(self: httpx.AsyncHTTPTransport, request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": {"limit": 1, "limit_reset": None}})

    async def close(self: httpx.AsyncHTTPTransport) -> None:
        closed.append(self)
        await original_close(self)

    monkeypatch.setattr(httpx, "create_ssl_context", create_context)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "__init__", transport_init)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", handle)
    monkeypatch.setattr(httpx.AsyncHTTPTransport, "aclose", close)

    client = OpenRouterClient(
        api_key="synthetic",
        ledger=MemoryBudgetLedger(),
        live_enabled=True,
        allow_external_data=True,
    )
    assert await client.verify_key_limit(2) is True
    assert len(contexts) == 1 and len(transports) == 1
    assert contexts[0].verify_mode == ssl.CERT_REQUIRED and contexts[0].check_hostname
    await client.aclose()
    assert closed == transports
    with pytest.raises(ProviderError, match="PROVIDER_CLOSED"):
        await client.verify_key_limit(2)


@pytest.mark.asyncio
async def test_real_sdk_tls_rejects_untrusted_then_accepts_explicit_ca(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
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
        timeout=10,
    )
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(certificate, key)
    calls: list[dict[str, Any]] = []

    async def respond(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            header = await reader.readuntil(b"\r\n\r\n")
            size = next(
                int(line.split(b":", 1)[1])
                for line in header.split(b"\r\n")
                if line.lower().startswith(b"content-length:")
            )
            calls.append(json.loads(await reader.readexactly(size)))
            body = json.dumps(_chat_response()).encode()
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
    untrusted = trusted = None
    try:
        assert server.sockets is not None
        base_url = f"https://127.0.0.1:{server.sockets[0].getsockname()[1]}/v1"
        untrusted = DirectLocalTextProvider(
            base_url=base_url, model="local/gemma", api_key="synthetic", timeout_ms=3000
        )
        with pytest.raises(ProviderError, match="PROVIDER_TRANSPORT"):
            await untrusted.generate(MESSAGES)
        assert not calls
        monkeypatch.setenv("SSL_CERT_FILE", str(certificate))
        trusted = DirectLocalTextProvider(
            base_url=base_url, model="local/gemma", api_key="synthetic", timeout_ms=3000
        )
        assert await trusted.generate(MESSAGES) == "합성 답변"
        assert len(calls) == 1
    finally:
        if untrusted is not None:
            await untrusted.aclose()
        if trusted is not None:
            await trusted.aclose()
        server.close()
        await server.wait_closed()


@pytest.mark.parametrize(
    "answer",
    [
        {"type": "noul", "noul": True},
        {"type": "noul", "noul": -0.1},
        {"type": "noul", "noul": math.nan},
        {},
    ],
)
def test_jev_rejects_malformed_noul_payload(answer: Any) -> None:
    with pytest.raises(ProviderError):
        parse_noul(answer)


def test_jev_intent_payload_scope_and_validation() -> None:
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


def test_frozen_jev_questions_against_typescript() -> None:
    output = subprocess.check_output(
        [
            str(ROOT / "node_modules/.bin/tsx"),
            "-e",
            (
                "import {jevIntentQuestion,jevSafetyQuestions} "
                "from './packages/providers/src/jev.ts';"
                "console.log(JSON.stringify({intent:jevIntentQuestion('synthetic-seed'),"
                "safety:jevSafetyQuestions()}));"
            ),
        ],
        cwd=ROOT,
        text=True,
    )
    expected = json.loads(output)
    assert expected["intent"] == jev_intent_question("synthetic-seed")
    assert expected["safety"] == jev_safety_questions()


def test_zero_timeout_does_not_start_coroutine() -> None:
    calls: list[str] = []

    async def work() -> None:
        calls.append("called")

    async def run() -> None:
        with pytest.raises(ProviderError, match="PROVIDER_DEADLINE"):
            await bounded(work(), timeout=0, timeout_code="PROVIDER_DEADLINE")

    asyncio.run(run())
    assert not calls


def test_json_string_bytes_exhaustive_unicode_surrogates_controls_against_node() -> None:
    scalars = "".join(chr(code) for code in range(0x110000) if not 0xD800 <= code <= 0xDFFF)
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
            timeout=10,
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
async def test_direct_local_provider_close_cancels_drains_and_rejects_new_work() -> None:
    started, cleaned = asyncio.Event(), asyncio.Event()
    calls: list[httpx.Request] = []
    closes: list[bool] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        started.set()
        try:
            await asyncio.sleep(10)
        finally:
            cleaned.set()
        return httpx.Response(200, json=_chat_response())

    class Transport(httpx.MockTransport):
        async def aclose(self) -> None:
            closes.append(True)
            await super().aclose()

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="local/gemma",
        transport=Transport(handler),
    )
    task = asyncio.create_task(provider.generate(MESSAGES, request_key=TURN))
    await started.wait()
    await asyncio.gather(provider.aclose(), provider.aclose())
    assert task.cancelled() and cleaned.is_set() and len(closes) == 1
    assert not provider._active and provider._hook_context.get() is None
    with pytest.raises(ProviderError, match="PROVIDER_CLOSED"):
        await provider.generate(MESSAGES, request_key=TURN)
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_close", [False, True])
async def test_runtime_public_close_chain_always_closes_pool_and_telemetry(
    fail_close: bool,
) -> None:
    from ptr_llm.runtime import Runtime

    events: list[str] = []

    class Provider:
        async def aclose(self) -> None:
            events.append("provider")
            if fail_close:
                raise RuntimeError("synthetic close failure")

    class Pool:
        async def close(self) -> None:
            events.append("pool")

    class Telemetry:
        def shutdown(self) -> None:
            events.append("telemetry")

    runtime = Runtime(Pool(), None, None, None, Provider(), Telemetry(), "local", "synthetic")
    if fail_close:
        with pytest.raises(RuntimeError, match="synthetic close failure"):
            await runtime.close()
    else:
        await runtime.close()
    assert events == ["provider", "telemetry", "pool"]


def test_litellm_is_not_imported_by_worker_bootstrap_or_guardrails_validation() -> None:
    script = textwrap.dedent(
        """
        import sys
        from ptr_llm.bootstrap import prime_static_imports

        assert prime_static_imports() in (True, False)
        assert "litellm" not in sys.modules

        from ptr_llm.core.guardrails import validate_input

        assert validate_input("hello", {"classification": "rules-only"}) == {
            "action": "none",
            "fired": [],
        }
        assert "litellm" not in sys.modules
        """
    )
    subprocess.run([sys.executable, "-c", script], cwd=ROOT / "apps/llm-service", check=True)
