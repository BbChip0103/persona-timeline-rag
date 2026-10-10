"""Native embedding orchestration stays inside the metered async boundary."""

import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest
from langchain_openai import OpenAIEmbeddings

from ptr_llm.billing import MemoryBudgetLedger, ProviderError
from ptr_llm.providers.common import check_cancel, js_json
from ptr_llm.providers.openrouter import (
    EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL,
    OpenRouterClient,
    OpenRouterEmbeddingProvider,
)


class MeteredClient:
    input_bytes = 32768

    def __init__(self):
        self.calls = []

    async def embed(self, inputs, *, signal=None):
        self.calls.append((inputs, signal))
        return [[float(i + 1)] * EMBEDDING_DIMENSIONS for i in range(len(inputs))]


def sdk_spies(monkeypatch):
    calls = []
    query, documents = OpenAIEmbeddings.aembed_query, OpenAIEmbeddings.aembed_documents

    async def query_spy(self, *args, **kwargs):
        calls.append("query")
        return await query(self, *args, **kwargs)

    async def documents_spy(self, *args, **kwargs):
        calls.append("documents")
        return await documents(self, *args, **kwargs)

    monkeypatch.setattr(OpenAIEmbeddings, "aembed_query", query_spy)
    monkeypatch.setattr(OpenAIEmbeddings, "aembed_documents", documents_spy)
    return calls


async def test_native_query_delegates_to_native_documents(monkeypatch):
    calls = sdk_spies(monkeypatch)
    client = MeteredClient()
    provider = OpenRouterEmbeddingProvider(client)
    signal = asyncio.Event()
    vector = await provider.aembed_query("합성 질문", signal=signal, evidence_scope="caption_image")
    assert calls == ["query", "documents"]
    assert vector == [1.0] * EMBEDDING_DIMENSIONS
    assert client.calls == [(["합성 질문"], signal)]


async def test_public_batch_uses_native_documents_once(monkeypatch):
    calls = sdk_spies(monkeypatch)
    client = MeteredClient()
    vectors = await OpenRouterEmbeddingProvider(client).embed(["첫 합성문", "둘 합성문"])
    assert calls == ["documents"]
    assert vectors == [[1.0] * EMBEDDING_DIMENSIONS, [2.0] * EMBEDDING_DIMENSIONS]
    assert client.calls == [(["첫 합성문", "둘 합성문"], None)]


@pytest.mark.parametrize("inputs", [None, "text", [], [""], [" \n"], [1], ["x"] * 33])
async def test_invalid_batch_fails_before_sdk_or_metered_client(monkeypatch, inputs):
    calls = sdk_spies(monkeypatch)
    client = MeteredClient()
    with pytest.raises(ProviderError, match="INVALID_INPUT"):
        await OpenRouterEmbeddingProvider(client).embed(inputs)
    assert calls == [] and client.calls == []


async def test_full_serialized_batch_limit_precedes_sdk(monkeypatch):
    calls = sdk_spies(monkeypatch)
    client = MeteredClient()
    texts = ["🐜" * 10, "한글" * 10]
    client.input_bytes = len(js_json(texts).encode()) - 1
    with pytest.raises(ProviderError, match="INPUT_LIMIT"):
        await OpenRouterEmbeddingProvider(client).embed(texts)
    assert calls == [] and client.calls == []


async def test_exact_batch_byte_limit_and_32_documents_allow_one_call():
    client = MeteredClient()
    texts = ["합성"] * 32
    client.input_bytes = len(js_json(texts).encode())
    assert len(await OpenRouterEmbeddingProvider(client).embed(texts)) == 32
    assert client.calls == [(texts, None)]


@pytest.mark.parametrize("method,value", [("embed", ["합성"]), ("aembed_query", "합성")])
async def test_precancelled_request_never_enters_sdk(monkeypatch, method, value):
    calls = sdk_spies(monkeypatch)
    client = MeteredClient()
    signal = asyncio.Event()
    signal.set()
    with pytest.raises(ProviderError, match="CANCELLED"):
        await getattr(OpenRouterEmbeddingProvider(client), method)(value, signal=signal)
    assert calls == [] and client.calls == []


async def test_concurrent_invocations_have_isolated_signals_and_cleanup():
    client = MeteredClient()
    original = client.embed
    entered, release = asyncio.Event(), asyncio.Event()

    async def delayed(inputs, *, signal=None):
        if inputs == ["first"]:
            entered.set()
            await release.wait()
        return await original(inputs, signal=signal)

    client.embed = delayed
    provider = OpenRouterEmbeddingProvider(client)
    first_signal, second_signal = asyncio.Event(), asyncio.Event()
    first = asyncio.create_task(provider.aembed_query("first", signal=first_signal))
    await entered.wait()
    await provider.aembed_query("second", signal=second_signal)
    release.set()
    await first
    await provider.aembed_query("third")
    assert client.calls == [
        (["second"], second_signal),
        (["first"], first_signal),
        (["third"], None),
    ]


async def test_provider_failure_is_not_retried_and_scope_resets():
    client = MeteredClient()
    original = client.embed
    client.embed = AsyncMock(side_effect=ProviderError("PROVIDER_TRANSPORT"))
    provider = OpenRouterEmbeddingProvider(client)
    with pytest.raises(ProviderError, match="PROVIDER_TRANSPORT"):
        await provider.aembed_query("synthetic", signal=asyncio.Event())
    assert client.embed.await_count == 1
    client.embed = original
    await provider.aembed_query("next")
    assert client.calls == [(["next"], None)]


def test_sdk_configuration_creates_no_external_clients(monkeypatch):
    import openai

    def forbidden(*args, **kwargs):
        raise AssertionError("SDK must not construct an independent client")

    monkeypatch.setattr(openai, "OpenAI", forbidden)
    monkeypatch.setattr(openai, "AsyncOpenAI", forbidden)
    provider = OpenRouterEmbeddingProvider(MeteredClient())
    sdk = provider._embeddings
    assert isinstance(sdk, OpenAIEmbeddings)
    assert sdk.model == EMBEDDING_MODEL and sdk.dimensions == EMBEDDING_DIMENSIONS
    assert sdk.chunk_size == 32 and sdk.max_retries == 0
    assert sdk.check_embedding_ctx_length is False
    assert sdk._invocation_params["encoding_format"] == "float"
    assert sdk.http_client is None and sdk.http_async_client is None
    with pytest.raises(ProviderError, match="ASYNC_EMBEDDINGS_REQUIRED"):
        sdk.embed_query("synthetic")


async def test_existing_transport_validation_orders_response_before_sdk(monkeypatch):
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=None,
        live_enabled=True,
        allow_external_data=True,
        transport=object(),
    )

    async def request(body, operation, reservation, **kwargs):
        assert body["dimensions"] == EMBEDDING_DIMENSIONS
        assert body["encoding_format"] == "float"
        assert operation == "embeddings"
        return {
            "model": EMBEDDING_MODEL,
            "data": [
                {"index": 1, "embedding": [2.0] * EMBEDDING_DIMENSIONS},
                {"index": 0, "embedding": [1.0] * EMBEDDING_DIMENSIONS},
            ],
        }

    monkeypatch.setattr(client, "_request", request)
    vectors = await OpenRouterEmbeddingProvider(client).embed(["a", "b"])
    assert vectors == [[1.0] * EMBEDDING_DIMENSIONS, [2.0] * EMBEDDING_DIMENSIONS]


@pytest.mark.parametrize("error", ["model", "dimensions", "duplicate", "nonfinite"])
async def test_existing_transport_rejects_invalid_vectors(monkeypatch, error):
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=None,
        live_enabled=True,
        allow_external_data=True,
        transport=object(),
    )
    data = [{"index": i, "embedding": [float(i + 1)] * EMBEDDING_DIMENSIONS} for i in range(2)]
    model = EMBEDDING_MODEL
    if error == "model":
        model = "wrong"
    elif error == "dimensions":
        data[0]["embedding"] = [1.0]
    elif error == "duplicate":
        data[1]["index"] = 0
    else:
        data[0]["embedding"][0] = float("nan")
    monkeypatch.setattr(client, "_request", AsyncMock(return_value={"model": model, "data": data}))
    with pytest.raises(ProviderError, match="INVALID_EMBEDDINGS"):
        await OpenRouterEmbeddingProvider(client).embed(["a", "b"])
    assert client._request.await_count == 1


@pytest.mark.parametrize("text", [None, 1, "", " \n"])
async def test_invalid_query_never_enters_sdk(monkeypatch, text):
    calls = sdk_spies(monkeypatch)
    client = MeteredClient()
    with pytest.raises(ProviderError, match="INVALID_INPUT"):
        await OpenRouterEmbeddingProvider(client).aembed_query(text)
    assert calls == [] and client.calls == []


async def test_long_raw_text_never_tokenized_split_or_normalized(monkeypatch):
    def forbidden(*args, **kwargs):
        raise AssertionError("SDK tokenizer must not run")

    monkeypatch.setattr(OpenAIEmbeddings, "_tokenize", forbidden)
    client = MeteredClient()
    text = "x " * 10000
    vector = await OpenRouterEmbeddingProvider(client).aembed_query(text)
    assert client.calls == [([text], None)]
    assert vector == [1.0] * EMBEDDING_DIMENSIONS


async def test_cancelling_one_invocation_does_not_cancel_another():
    client = MeteredClient()
    original = client.embed
    entered, release = asyncio.Event(), asyncio.Event()

    async def delayed(inputs, *, signal=None):
        if inputs == ["first"]:
            entered.set()
            await release.wait()
        check_cancel(signal)
        return await original(inputs, signal=signal)

    client.embed = delayed
    provider = OpenRouterEmbeddingProvider(client)
    first_signal, second_signal = asyncio.Event(), asyncio.Event()
    first = asyncio.create_task(provider.aembed_query("first", signal=first_signal))
    await entered.wait()
    first_signal.set()
    await provider.aembed_query("second", signal=second_signal)
    release.set()
    with pytest.raises(ProviderError, match="CANCELLED"):
        await first
    await provider.aembed_query("third")
    assert client.calls == [(["second"], second_signal), (["third"], None)]


async def test_task_cancellation_does_not_leak_invocation_scope():
    client = MeteredClient()
    original = client.embed
    entered = asyncio.Event()

    async def delayed(inputs, *, signal=None):
        entered.set()
        await asyncio.Event().wait()

    client.embed = delayed
    provider = OpenRouterEmbeddingProvider(client)
    task = asyncio.create_task(provider.aembed_query("first", signal=asyncio.Event()))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    client.embed = original
    await provider.aembed_query("next")
    assert client.calls == [(["next"], None)]


async def test_native_query_retains_metered_body_receipt_and_deduplication():
    requests = []

    def transport(request):
        body = json.loads(request.content)
        requests.append(body)
        assert request.url.path == "/api/v1/embeddings"
        return httpx.Response(
            200,
            json={
                "id": "synthetic-embedding-receipt",
                "model": EMBEDDING_MODEL,
                "data": [{"index": 0, "embedding": [1.0] * EMBEDDING_DIMENSIONS}],
                "usage": {"cost": 0.000001},
            },
        )

    ledger = MemoryBudgetLedger()
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=ledger,
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(transport),
    )
    client._text_verified = True  # Synthetic pricing fixture; no external catalogue lookup.
    provider = OpenRouterEmbeddingProvider(client)
    assert await provider.aembed_query("synthetic") == [1.0] * EMBEDDING_DIMENSIONS
    assert await provider.aembed_query("synthetic") == [1.0] * EMBEDDING_DIMENSIONS
    assert len(requests) == len(ledger.requests) == 1
    assert requests[0] == {
        "model": EMBEDDING_MODEL,
        "input": ["synthetic"],
        "encoding_format": "float",
        "dimensions": EMBEDDING_DIMENSIONS,
        "provider": client._provider(True),
    }
    receipt = next(iter(ledger.requests.values()))
    assert receipt.state == "settled" and receipt.actual_microusd == 1
    assert receipt.generation_id == "synthetic-embedding-receipt"


async def test_native_query_unknown_metered_submission_never_retries_or_resubmits():
    requests = []

    def transport(request):
        requests.append(request)
        raise httpx.ReadError("synthetic transport ambiguity")

    ledger = MemoryBudgetLedger()
    client = OpenRouterClient(
        api_key="synthetic",
        ledger=ledger,
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(transport),
    )
    client._text_verified = True
    provider = OpenRouterEmbeddingProvider(client)
    with pytest.raises(ProviderError, match="PROVIDER_TRANSPORT"):
        await provider.aembed_query("synthetic")
    with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
        await provider.aembed_query("synthetic")
    assert len(requests) == len(ledger.requests) == 1
    assert next(iter(ledger.requests.values())).state == "unknown"
