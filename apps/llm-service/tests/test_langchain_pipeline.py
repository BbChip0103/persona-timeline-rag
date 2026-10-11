"""Native vector retrieval and private callback boundaries, synthetic only."""

import asyncio
from types import SimpleNamespace

import pytest
from langchain_core.vectorstores import VectorStoreRetriever
from test_post_summaries import POST, URL

from ptr_llm.billing import ProviderError
from ptr_llm.core.errors import CoreError
from ptr_llm.repositories.sources import PostgresRetrieval

QUERY = {
    "personId": POST["personId"],
    "query": "synthetic exhibition",
    "limit": 20,
    "dateBasis": "event",
    "timezone": "Asia/Seoul",
    "start": "2026-01-01",
    "end": "2026-01-03",
}


class LegacySources:
    pool = SimpleNamespace(conninfo=URL)

    def __init__(self):
        self.calls = []

    async def search_semantic(self, query, trusted, vector, model, **options):
        self.calls.append((dict(query), dict(trusted), vector, model, options))
        return [POST]


async def test_actual_vectorstore_retriever_handles_legacy_semantic(monkeypatch):
    sources, embedded, invoked = LegacySources(), [], []

    async def embed(text, **options):
        embedded.append((text, options))
        return [1] * 1536

    original = VectorStoreRetriever._aget_relevant_documents

    async def spy(self, *args, **options):
        invoked.append(self)
        return await original(self, *args, **options)

    monkeypatch.setattr(VectorStoreRetriever, "_aget_relevant_documents", spy)
    adapter = PostgresRetrieval(sources, embed=embed, model_revision="fake-embedding")
    found = await adapter.search(
        QUERY, {"personId": POST["personId"]}, mode="semantic", evidence_scope="caption_image"
    )
    assert found == [POST] and len(invoked) == len(embedded) == 1
    query, trusted, vector, revision, options = sources.calls[0]
    assert query == QUERY and trusted == {"personId": POST["personId"]}
    assert revision == "fake-embedding" and options["evidence_scope"] == "caption_image"
    assert options.get("summary_index", False) is False
    assert invoked[0].search_type == "similarity" and invoked[0].search_kwargs == {"k": 20}


@pytest.mark.parametrize("fault", ["foreign", "cancel", "scope"])
async def test_legacy_invalid_scope_is_prepaid(fault):
    sources, embedded = LegacySources(), []

    async def embed(*args, **kwargs):
        embedded.append(1)
        return [1] * 1536

    adapter = PostgresRetrieval(sources, embed=embed, model_revision="fake-embedding")
    signal = asyncio.Event()
    if fault == "cancel":
        signal.set()
    trusted = {"personId": "foreign" if fault == "foreign" else POST["personId"]}
    with pytest.raises(ProviderError if fault == "cancel" else CoreError):
        await adapter.search(
            QUERY,
            trusted,
            mode="semantic",
            signal=signal,
            evidence_scope="bad" if fault == "scope" else "caption",
        )
    assert not embedded and not sources.calls


async def test_legacy_retrieval_does_not_export_to_ambient_sdk_traces(monkeypatch, capsys):
    import httpx
    import requests
    from langchain_core import globals as lc_globals
    from langchain_core.tracers.context import collect_runs
    from langsmith import tracing_context

    network = []

    def block_send(*args, **kwargs):
        network.append(1)
        raise AssertionError("trace regression must be network-free")

    async def block_async_send(*args, **kwargs):
        return block_send(*args, **kwargs)

    monkeypatch.setattr(requests.Session, "send", block_send)
    monkeypatch.setattr(httpx.AsyncClient, "send", block_async_send)
    monkeypatch.setattr(lc_globals, "_debug", True)
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    sources = LegacySources()

    async def embed(*args, **kwargs):
        return [1] * 1536

    adapter = PostgresRetrieval(sources, embed=embed, model_revision="fake-embedding")
    # Exercise only new native boundaries, not an outer application graph with tracing enabled.
    with collect_runs() as collected, tracing_context(enabled=True):
        found = await adapter.search(QUERY, {"personId": POST["personId"]}, mode="semantic")
    assert found == [POST]
    assert not collected.traced_runs and not network
    assert "[retriever/" not in capsys.readouterr().out


async def test_internal_callback_config_accepts_only_empty_noop_manager():
    from langchain_core.callbacks import AsyncCallbackManager
    from langchain_core.callbacks.base import BaseCallbackHandler

    from ptr_llm.core.langchain import PrivateAsyncRetriever

    class ScopedSourceRetriever(PrivateAsyncRetriever):
        def _get_relevant_documents(self, query, *, run_manager):
            raise NotImplementedError("private async retrieval only")

        async def _aget_relevant_documents(self, query, *, run_manager):
            return await load()

    calls = []

    async def load():
        calls.append(1)
        return []

    retriever = ScopedSourceRetriever()
    manager = AsyncCallbackManager(handlers=[])
    assert await retriever.ainvoke("q", {"callbacks": manager}) == []
    for config in (
        {"callbacks": [BaseCallbackHandler()]},
        {"metadata": {"raw": "private"}},
        {"callbacks": AsyncCallbackManager(handlers=[BaseCallbackHandler()])},
        {"callbacks": manager, "tags": ["extra"]},
    ):
        with pytest.raises(CoreError, match="INVALID_INPUT"):
            await retriever.ainvoke("q", config)
    assert calls == [1]


async def test_legacy_provider_unknown_is_not_retried_or_searched():
    sources, attempts = LegacySources(), []

    async def embed(*args, **kwargs):
        attempts.append(1)
        raise ProviderError("REQUEST_UNRESOLVED_NO_RESUBMIT")

    adapter = PostgresRetrieval(sources, embed=embed, model_revision="fake-embedding")
    with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
        await adapter.search(QUERY, {"personId": POST["personId"]}, mode="semantic")
    assert attempts == [1] and not sources.calls
