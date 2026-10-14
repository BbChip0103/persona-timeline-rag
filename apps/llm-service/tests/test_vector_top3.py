"""Top-three retrieval with independent JEV safety; synthetic and network-free."""

import asyncio
import copy
import json

import pytest
from core_domain_test import PERSONA, SOURCE, Personas, Provider, grant, noop, response

from ptr_llm.core.runtime import LLMEngine
from ptr_llm.providers.jev import JevInputSafetyClassifier


class RankedRetrieval:
    def __init__(self, count=5):
        self.sources = [dict(copy.deepcopy(SOURCE), id=f"post-{i}") for i in range(count)]
        self.searches = []

    async def search(self, query, trusted, **options):
        self.searches.append((copy.deepcopy(query), trusted, options))
        # Deliberately over-return to check the engine's scoped defensive cap.
        return self.sources


async def execute(
    retrieval,
    *,
    text="Tell me about your sky post.",
    update=None,
    mode="semantic",
    guard=noop,
    responses=None,
    safety=None,
):
    provider = Provider(responses or [response("Nice sky!")])
    engine = LLMEngine(
        provider=provider, personas=Personas(), retrieval=retrieval, input_safety=safety
    )
    value = grant(text, retrievalMode=mode, ragCondition="caption")
    if update:
        update(value)
    return await engine.handle(value, before_costly=guard, cancelled=asyncio.Event()), provider


def cards(provider):
    for message in provider.messages[-1]:
        if message["content"].startswith("UNTRUSTED_EVIDENCE_JSON_DATA "):
            return json.loads(message["content"].split(" ", 1)[1])
    raise AssertionError("expected original evidence cards")


@pytest.mark.parametrize("count", [0, 1, 2, 3, 4, 20])
async def test_vector_search_caps_at_three_and_keeps_rank_and_originals(count):
    retrieval = RankedRetrieval(count)
    result, provider = await execute(retrieval)
    assert result["kind"] == "completed"
    assert len(retrieval.searches) == 1
    assert retrieval.searches[0][0]["limit"] == 3
    assert retrieval.searches[0][1] == {"personId": PERSONA["personId"]}
    assert [c["sourceId"] for c in cards(provider)] == [f"post-{i}" for i in range(min(3, count))]
    assert all(c["caption"] == SOURCE["caption"] for c in cards(provider))


async def test_filters_precede_cap_without_reordering_eligible_sources():
    retrieval = RankedRetrieval(6)
    retrieval.sources[0]["personId"] = "foreign"
    retrieval.sources[1]["unsafe"] = True
    retrieval.sources[2]["postedAt"] = "1990-01-01T00:00:00Z"

    def update(value):
        value["context"]["input"]["timeline"] = {"start": "2000-01-01", "end": "2030-01-01"}

    result, provider = await execute(retrieval, update=update)
    assert result["kind"] == "completed"
    assert [c["sourceId"] for c in cards(provider)] == ["post-3", "post-4", "post-5"]


async def test_date_only_semantic_query_still_has_question_for_embedding():
    retrieval = RankedRetrieval(1)

    def update(value):
        value["context"]["input"]["timeline"] = {"start": "2000-01-01", "end": "2030-01-01"}

    text = "Which posts did you publish in those dates?"
    result, _ = await execute(retrieval, text=text, update=update)
    assert result["kind"] == "completed"
    assert retrieval.searches[0][0]["query"] == text


async def test_search_ownership_fence_precedes_query_embedding():
    retrieval = RankedRetrieval()

    async def revoked():
        raise RuntimeError("ownership revoked")

    result, provider = await execute(retrieval, guard=revoked)
    assert result["kind"] == "failed"
    assert not retrieval.searches and not provider.messages


async def test_tool_search_uses_same_three_cap_and_prompt_budget():
    retrieval = RankedRetrieval(20)
    result, provider = await execute(
        retrieval, responses=[response("", function="blue sky"), response("Nice sky!")]
    )
    assert result["kind"] == "completed"
    assert [q["limit"] for q, _, _ in retrieval.searches] == [3, 3]
    assert retrieval.searches[1][0]["query"] == "blue sky"
    assert len(cards(provider)) == 3


@pytest.mark.parametrize(
    "mode,text",
    [
        ("off", "Tell me about your sky post."),
        ("semantic", "Hello!"),
        ("semantic", "Imagine a fictional adventure."),
    ],
)
async def test_off_smalltalk_creative_make_no_search_call(mode, text):
    retrieval = RankedRetrieval()
    result, _ = await execute(retrieval, mode=mode, text=text)
    assert result["kind"] == "completed" and not retrieval.searches


async def test_actual_jev_guardrail_still_deflects_without_search():
    class DecisionClient:
        def __init__(self):
            self.calls = []

        async def decide(self, request, **options):
            self.calls.append(request)
            return {
                "answers": {
                    key: {"type": "noul", "noul": 1 if key == "private_info" else 0}
                    for key in request["questions"]
                }
            }

    client, retrieval = DecisionClient(), RankedRetrieval()
    result, _ = await execute(
        retrieval, text="Tell me about your sky post.", safety=JevInputSafetyClassifier(client)
    )
    assert result["kind"] == "completed"
    assert len(client.calls) == 1 and "private_info" in client.calls[0]["questions"]
    assert not retrieval.searches
    assert "candidates" not in client.calls[0]["state"]


@pytest.mark.parametrize("index", ["legacy", "summary"])
async def test_factory_has_no_search_judge_client_even_with_retired_flags(monkeypatch, index):
    from test_runtime_composition import FakePool, _settings

    from ptr_llm import runtime as module

    def forbidden(*args, **kwargs):
        raise AssertionError("retrieval selection must not construct an OpenRouter client")

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    monkeypatch.setattr(module, "OpenRouterClient", forbidden)
    runtime = await module.build_runtime(
        _settings(),
        {
            "PTR_LLM_RETRIEVAL_INDEX": index,
            "PTR_LLM_EVIDENCE_SELECTOR": "jev",
            "PTR_LLM_EVIDENCE_THRESHOLD": "nan",
        },
    )
    try:
        assert runtime.domain_engine.retrieval.summary_index is (index == "summary")
        assert runtime.domain_engine.input_safety is None
    finally:
        await runtime.close()


async def test_factory_keeps_jev_safety_and_intent_when_summary_selection_is_gone(monkeypatch):
    import httpx
    from test_runtime_composition import FakePool, _settings

    from ptr_llm import runtime as module
    from ptr_llm.providers.jev import JevIntentClassifier

    original_client = module.OpenRouterClient

    async def forbidden(request):
        raise AssertionError("factory composition must make no provider call")

    def client(**options):
        return original_client(**options, transport=httpx.MockTransport(forbidden))

    monkeypatch.setattr(module, "OpenRouterClient", client)
    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    runtime = await module.build_runtime(
        _settings(),
        {
            "PTR_NETWORK_MODE": "cluster",
            "KUBERNETES_SERVICE_HOST": "10.0.0.1",
            "PTR_LLM_RETRIEVAL_INDEX": "summary",
            "PTR_LLM_EVIDENCE_SELECTOR": "jev",
            "PTR_LLM_SAFETY_FILTER": "jev",
            "PTR_LLM_INTENT_CLASSIFIER": "jev",
            "OPENROUTER_API_KEY": "synthetic",
            "PTR_LLM_LIVE_ENABLED": "1",
            "PTR_LLM_ALLOW_EXTERNAL_DATA": "1",
        },
    )
    try:
        assert isinstance(runtime.domain_engine.input_safety, JevInputSafetyClassifier)
        assert isinstance(runtime.domain_engine.intent_classifier, JevIntentClassifier)
        assert not hasattr(runtime.domain_engine, "evidence_selector")
        assert runtime.domain_engine.retrieval.summary_index
    finally:
        await runtime.close()


async def test_cancellation_after_retrieval_stops_generation():
    retrieval, cancelled = RankedRetrieval(5), asyncio.Event()
    original = retrieval.search

    async def cancelling(*args, **options):
        found = await original(*args, **options)
        cancelled.set()
        return found

    retrieval.search = cancelling
    provider = Provider([response("Nice sky!")])
    engine = LLMEngine(provider=provider, personas=Personas(), retrieval=retrieval)
    result = await engine.handle(
        grant("Tell me about your sky post.", retrievalMode="semantic", ragCondition="caption"),
        before_costly=noop,
        cancelled=cancelled,
    )
    assert result == {"kind": "failed", "errorCode": "TURN_ABORTED"}
    assert not provider.messages


async def test_factory_unknown_index_still_rejected_and_pool_closed(monkeypatch):
    from test_runtime_composition import FakePool, _settings

    from ptr_llm import runtime as module
    from ptr_llm.billing import ProviderError

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    with pytest.raises(ProviderError, match="INVALID_RUNTIME_CONFIG"):
        await module.build_runtime(_settings(), {"PTR_LLM_RETRIEVAL_INDEX": "unknown"})
    assert FakePool.instances[-1].closed


async def test_engine_uses_native_summary_top_three_and_hydrates_ranked_originals(monkeypatch):
    from types import SimpleNamespace

    from langchain_classic.retrievers.multi_vector import MultiVectorRetriever
    from test_runtime_composition import URL

    from ptr_llm.repositories.sources import PostgresRetrieval
    from ptr_llm.repositories.summaries import PostgresSummaryRepository

    summary = "2020, blue sky.\nPainting.\nClouds."
    originals = {
        key: dict(copy.deepcopy(SOURCE), id=key) for key in ["third", "first", "fourth", "last"]
    }
    searches, hydration, embeddings, native = [], [], [], []

    async def active(self, model, **options):
        return {"run_id": "pinned-run"}

    async def forbidden(*args, **options):
        raise AssertionError("no extra summary lookup or selection after native retrieval")

    monkeypatch.setattr(PostgresSummaryRepository, "active_run", active)
    monkeypatch.setattr(PostgresSummaryRepository, "get_summaries", forbidden)
    original_retrieve = MultiVectorRetriever._aget_relevant_documents

    async def spy(self, *args, **options):
        native.append(self.search_kwargs)
        return await original_retrieve(self, *args, **options)

    monkeypatch.setattr(MultiVectorRetriever, "_aget_relevant_documents", spy)

    class Sources:
        pool = SimpleNamespace(conninfo=URL)

        async def search_summary_children(self, query, trusted, vector, model, **options):
            searches.append((copy.deepcopy(query), trusted, options))
            return [
                {
                    "source_id": source["id"],
                    "summary": summary,
                    "source_hash": source["hash"],
                    "snapshot": source["snapshot"],
                }
                for source in list(originals.values())[: query["limit"]]
            ]

        async def load_summary_parents(self, keys, trusted, **options):
            hydration.append((keys, trusted, options))
            return {key: {"source": originals[key], "summary": summary} for key in keys}

    async def embed(text, **options):
        embeddings.append(text)
        return [1] * 1536

    retrieval = PostgresRetrieval(
        Sources(), embed=embed, model_revision="synthetic-embedding", summary_index=True
    )
    result, provider = await execute(retrieval)
    assert result["kind"] == "completed"
    assert native == [{"k": 3}]
    assert len(embeddings) == len(searches) == len(hydration) == 1
    assert searches[0][0]["limit"] == 3
    assert searches[0][2]["summary_run_id"] == "pinned-run"
    assert hydration[0][0] == ["third", "first", "fourth"]
    assert [c["sourceId"] for c in cards(provider)] == ["third", "first", "fourth"]
    assert all(c["caption"] == SOURCE["caption"] for c in cards(provider))
