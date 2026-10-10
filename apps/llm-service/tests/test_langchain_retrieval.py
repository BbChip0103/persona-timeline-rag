"""Genuine SDK retrieval orchestration, using synthetic read-only backends."""

import asyncio
from types import SimpleNamespace

import pytest
from langchain_classic.retrievers.multi_vector import MultiVectorRetriever
from langchain_core.runnables.config import var_child_runnable_config
from test_post_summaries import POST, URL

from ptr_llm.billing import ProviderError
from ptr_llm.core.errors import CoreError
from ptr_llm.repositories.sources import PostgresRetrieval
from ptr_llm.repositories.summaries import PostgresSummaryRepository

SUMMARY = "2026년 1월 2일.\n합성 전시 방문.\n파란 그림."
QUERY = {
    "personId": POST["personId"],
    "query": "전시",
    "dateBasis": "posted",
    "timezone": "Asia/Seoul",
    "limit": 20,
}


class Sources:
    pool = SimpleNamespace(conninfo=URL)

    def __init__(self):
        self.children = [self.child("b"), self.child("a"), self.child("b")]
        self.parents = {
            key: {"source": {**POST, "id": key}, "summary": SUMMARY} for key in ("a", "b")
        }
        self.calls = []
        self.pause = None

    @staticmethod
    def child(key):
        return {
            "source_id": key,
            "summary": SUMMARY,
            "source_hash": POST["hash"],
            "snapshot": POST["snapshot"],
        }

    async def search_summary_children(self, query, trusted, vector, model, **options):
        self.calls.append(("search", dict(query), dict(trusted), options))
        if self.pause:
            await self.pause()
        return self.children

    async def load_summary_parents(self, keys, trusted, **options):
        self.calls.append(("parents", list(keys), dict(trusted), options))
        return {key: self.parents[key] for key in keys if key in self.parents}


@pytest.fixture
def setup(monkeypatch):
    active_calls, embeds = [], []

    async def active(self, model, **options):
        active_calls.append(model)
        return {"run_id": "pinned-run"}

    async def embed(text, **options):
        embeds.append((text, options))
        return [1] * 1536

    monkeypatch.setattr(PostgresSummaryRepository, "active_run", active)
    sources = Sources()
    adapter = PostgresRetrieval(sources, embed=embed, model_revision="embed", summary_index=True)
    return sources, adapter, active_calls, embeds


async def test_actual_sdk_deduplicates_and_hydrates_ranked_originals(setup, monkeypatch):
    sources, adapter, active, embeds = setup
    calls = []
    original = MultiVectorRetriever._aget_relevant_documents

    async def invoke(self, *args, **kwargs):
        calls.append(self)
        assert var_child_runnable_config.get() is None
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(MultiVectorRetriever, "_aget_relevant_documents", invoke)
    token = var_child_runnable_config.set({"metadata": {"private": "outer"}})
    try:
        found, summaries = await adapter.search_with_summaries(
            QUERY, {"personId": POST["personId"]}
        )
        assert var_child_runnable_config.get() == {"metadata": {"private": "outer"}}
    finally:
        var_child_runnable_config.reset(token)
    assert len(calls) == 1
    assert [s["id"] for s in found] == ["b", "a"]
    assert all(s["caption"] == POST["caption"] and "summary" not in s for s in found)
    assert summaries == {"b": SUMMARY, "a": SUMMARY}
    assert sources.calls[1][1] == ["b", "a"]
    assert active == ["embed"] and len(embeds) == 1
    assert all(c[-1]["summary_run_id"] == "pinned-run" for c in sources.calls)
    assert sources.calls[0][1] == QUERY


@pytest.mark.parametrize("fault", ["missing", "person", "hash", "snapshot", "unsafe", "summary"])
async def test_parent_failures_never_return_partial_evidence(setup, fault):
    sources, adapter, _, _ = setup
    if fault == "missing":
        del sources.parents["a"]
    elif fault == "summary":
        sources.parents["a"]["summary"] = ""
    else:
        sources.parents["a"]["source"][{"person": "personId"}.get(fault, fault)] = (
            True if fault == "unsafe" else "changed"
        )
    with pytest.raises(CoreError, match="SUMMARY_SOURCE_STALE"):
        await adapter.search_with_summaries(QUERY, {"personId": POST["personId"]})


async def test_summary_search_api_pins_before_embedding(setup, monkeypatch):
    _, adapter, _, embeds = setup

    async def unavailable(*args, **kwargs):
        raise CoreError("SUMMARY_INDEX_UNAVAILABLE")

    monkeypatch.setattr(PostgresSummaryRepository, "active_run", unavailable)
    with pytest.raises(CoreError, match="SUMMARY_INDEX_UNAVAILABLE"):
        await adapter.search(QUERY, {"personId": POST["personId"]}, mode="semantic")
    assert not embeds


@pytest.mark.parametrize("fault", ["foreign", "cancel", "scope"])
async def test_invalid_scope_and_cancel_are_prepaid(setup, fault):
    _, adapter, active, embeds = setup
    signal = asyncio.Event()
    trusted = {"personId": POST["personId"]}
    scope = "caption"
    if fault == "foreign":
        trusted["personId"] = "other"
    elif fault == "cancel":
        signal.set()
    else:
        scope = "other"
    with pytest.raises(ProviderError if fault == "cancel" else CoreError):
        await adapter.search_with_summaries(QUERY, trusted, signal=signal, evidence_scope=scope)
    assert not active and not embeds


async def test_cancel_between_child_and_parent_prevents_hydration(setup):
    sources, adapter, _, _ = setup
    signal = asyncio.Event()

    async def pause():
        signal.set()

    sources.pause = pause
    with pytest.raises(ProviderError, match="CANCELLED"):
        await adapter.search_with_summaries(QUERY, {"personId": POST["personId"]}, signal=signal)
    assert len(sources.calls) == 1


async def test_concurrent_invocations_have_independent_person_and_pinned_run(setup, monkeypatch):
    sources, adapter, _, _ = setup
    reached, release = asyncio.Event(), asyncio.Event()
    stores, runs, calls = [], iter(["run-a", "run-b"]), []
    original = MultiVectorRetriever._aget_relevant_documents

    async def active(*args, **kwargs):
        return {"run_id": next(runs)}

    async def children(query, trusted, vector, model, **options):
        person = trusted["personId"]
        calls.append((person, options["summary_run_id"], query["timezone"]))
        return [{**sources.child(person), "source_hash": "hash-" + person}]

    async def parents(keys, trusted, **options):
        person, run = trusted["personId"], options["summary_run_id"]
        calls.append((person, run, "parent"))
        return {
            person: {
                "source": {**POST, "id": person, "personId": person, "hash": "hash-" + person},
                "summary": run + "\nSynthetic event.\nSynthetic image.",
            }
        }

    async def invoke(self, *args, **kwargs):
        stores.append((self.vectorstore, self.docstore))
        if len(stores) == 1:
            reached.set()
            await release.wait()
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(PostgresSummaryRepository, "active_run", active)
    monkeypatch.setattr(sources, "search_summary_children", children)
    monkeypatch.setattr(sources, "load_summary_parents", parents)
    monkeypatch.setattr(MultiVectorRetriever, "_aget_relevant_documents", invoke)
    first = asyncio.create_task(
        adapter.search_with_summaries({**QUERY, "personId": "person-a"}, {"personId": "person-a"})
    )
    await asyncio.wait_for(reached.wait(), timeout=5)
    try:
        second = await adapter.search_with_summaries(
            {**QUERY, "personId": "person-b", "timezone": "UTC"}, {"personId": "person-b"}
        )
    finally:
        release.set()
    first_result = await first
    assert first_result[0][0]["personId"] == "person-a"
    assert second[0][0]["personId"] == "person-b"
    assert first_result[1]["person-a"].startswith("run-a")
    assert second[1]["person-b"].startswith("run-b")
    assert stores[0][0] is not stores[1][0] and stores[0][1] is not stores[1][1]
    assert calls == [
        ("person-b", "run-b", "UTC"),
        ("person-b", "run-b", "parent"),
        ("person-a", "run-a", "Asia/Seoul"),
        ("person-a", "run-a", "parent"),
    ]


async def test_sdk_global_and_context_callbacks_never_receive_raw_documents(setup, monkeypatch):
    from contextvars import ContextVar

    from langchain_core.callbacks.base import BaseCallbackHandler
    from langchain_core.tracers.context import collect_runs, register_configure_hook
    from langsmith import tracing_context

    _, adapter, _, _ = setup
    exports = []

    class Capture(BaseCallbackHandler):
        def on_retriever_start(self, *args, **kwargs):
            exports.append((args, kwargs))

        def on_retriever_end(self, *args, **kwargs):
            exports.append((args, kwargs))

    capture = ContextVar("synthetic-capture", default=None)
    register_configure_hook(capture, True)
    token = capture.set(Capture())
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    try:
        with collect_runs() as runs, tracing_context(enabled=True):
            found, _ = await adapter.search_with_summaries(QUERY, {"personId": POST["personId"]})
        assert len(found) == 2 and not runs.traced_runs and not exports
    finally:
        capture.reset(token)


async def test_read_only_adapters_and_unsupported_modes(setup, monkeypatch):
    from ptr_llm.repositories.langchain_retrieval import PrivateMultiVectorRetriever

    _, adapter, _, embeds = setup
    original = MultiVectorRetriever._aget_relevant_documents

    async def inspect(self, *args, **kwargs):
        vector, parents = self.vectorstore, self.docstore
        for operation in (
            lambda: vector.similarity_search("x"),
            lambda: vector.from_texts([], None),
            lambda: parents.mget([]),
            lambda: parents.mset([]),
            lambda: parents.mdelete([]),
            lambda: parents.yield_keys(),
            lambda: self.invoke("x"),
        ):
            with pytest.raises(NotImplementedError):
                operation()
        for operation in (
            vector.aadd_texts([]),
            vector.adelete([]),
            vector.amax_marginal_relevance_search("x"),
            vector.asimilarity_search_with_score("x"),
            parents.amset([]),
            parents.amdelete([]),
        ):
            with pytest.raises(NotImplementedError):
                await operation
        with pytest.raises(CoreError, match="INVALID_INPUT"):
            await vector.asimilarity_search("x", k=20, filter={"personId": "other"})
        assert isinstance(self, PrivateMultiVectorRetriever)
        return await original(self, *args, **kwargs)

    monkeypatch.setattr(MultiVectorRetriever, "_aget_relevant_documents", inspect)
    await adapter.search_with_summaries(QUERY, {"personId": POST["personId"]})
    assert len(embeds) == 1


async def test_provider_failure_is_not_retried_or_hydrated(setup):
    sources, adapter, _, _ = setup
    calls = []

    async def fail(*args, **kwargs):
        calls.append(1)
        raise ProviderError("RECEIPT_UNKNOWN")

    adapter.embed = fail
    with pytest.raises(ProviderError, match="RECEIPT_UNKNOWN"):
        await adapter.search_with_summaries(QUERY, {"personId": POST["personId"]})
    assert calls == [1] and not sources.calls


async def test_empty_hits_need_no_parent_query(setup):
    sources, adapter, _, embeds = setup
    sources.children = []
    assert await adapter.search_with_summaries(QUERY, {"personId": POST["personId"]}) == ([], {})
    assert len(embeds) == len(sources.calls) == 1


async def test_caller_scope_mutation_during_run_lookup_cannot_change_request(setup, monkeypatch):
    sources, adapter, _, _ = setup
    query, trusted = dict(QUERY), {"personId": POST["personId"]}

    async def active(*args, **kwargs):
        query["personId"] = trusted["personId"] = "changed-by-caller"
        query["limit"] = 1
        return {"run_id": "pinned-run"}

    monkeypatch.setattr(PostgresSummaryRepository, "active_run", active)
    found, _ = await adapter.search_with_summaries(query, trusted)
    assert len(found) == 2
    assert sources.calls[0][1] == QUERY
    assert sources.calls[0][2] == {"personId": POST["personId"]}
