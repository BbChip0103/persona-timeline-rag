"""Original evidence, scoped follow-ups and top-three retrieval; synthetic only."""

import asyncio
import copy
import json

import pytest
from core_domain_test import PERSONA, SOURCE, Personas, Provider, grant, noop, response

from ptr_llm.core.prompts import build_experiment_context
from ptr_llm.core.runtime import LLMEngine

SEED = "12345678-1234-1234-1234-123456789abc"


class Retrieval:
    def __init__(self, count=5):
        self.sources = [dict(copy.deepcopy(SOURCE), id=f"post-{i}") for i in range(count)]
        self.searches, self.summary_calls, self.resolves = [], [], []

    async def search(self, query, trusted, **options):
        self.searches.append((query, trusted, options))
        return self.sources

    async def summaries(self, sources, trusted, **options):
        self.summary_calls.append((sources, trusted, options))
        return {s["id"]: "2020, blue sky.\nPainting.\nClouds." for s in sources}

    async def resolve(self, refs, trusted, **options):
        self.resolves.append(refs)
        return self.sources


async def run(
    retrieval,
    *,
    text="Tell me about your sky post.",
    mode="semantic",
    responses=None,
    update=None,
    guard=noop,
    cancelled=None,
):
    provider = Provider(responses or [response("Nice sky!")])
    engine = LLMEngine(provider=provider, personas=Personas(), retrieval=retrieval)
    value = grant(text, retrievalMode=mode, ragCondition="caption")
    value["context"]["turn"]["id"] = SEED
    if update:
        update(value)
    result = await engine.handle(value, before_costly=guard, cancelled=cancelled or asyncio.Event())
    return result, provider


async def test_fence_cancel_and_deadline_before_evidence_cost():
    for reason in ("cancel", "deadline", "ownership"):
        retrieval = Retrieval()
        cancelled = asyncio.Event()

        def update(value):
            if reason == "deadline":
                value["deadlineAt"] = 0
            elif reason == "cancel":
                cancelled.set()

        async def guard():
            if reason == "ownership":
                raise RuntimeError("ownership lost")

        result, provider = await run(retrieval, update=update, guard=guard, cancelled=cancelled)
        assert result["kind"] == "failed"
        assert not provider.messages


def test_whole_post_byte_budget_is_preserved():
    sources = [dict(SOURCE, id=f"post-{i}") for i in range(5)]
    assert len(build_experiment_context(PERSONA, [], "sky?", sources)["sources"]) == 3
    context = build_experiment_context(PERSONA, [], "sky?", sources, max_sources=20)
    assert len(context["sources"]) == 5
    context = build_experiment_context(
        PERSONA, [], "sky?", [dict(s, caption="x" * 20000) for s in sources], max_sources=20
    )
    assert len(context["sources"]) < 5
    assert context["omittedSourceIds"]


@pytest.mark.parametrize("count", [1, 4])
async def test_pinned_followup_keeps_reuse_or_ambiguity_without_judge(count):
    retrieval = Retrieval(count)
    source = retrieval.sources[0]
    previous = {
        "grounding": "source_bound_quotes",
        "evidence": [
            {
                "sourceId": source["id"],
                "quote": "I painted a blue sky.",
                **{
                    key: source[key]
                    for key in [
                        "personId",
                        "sourceUrl",
                        "postedAt",
                        "eventDate",
                        "snapshot",
                        "hash",
                    ]
                },
            }
        ],
    }
    previous["evidence"] = [
        dict(previous["evidence"][0], sourceId=post["id"]) for post in retrieval.sources
    ]
    previous.update(
        sessionId="synthetic-session",
        personId=PERSONA["personId"],
        personaRevision=PERSONA["revision"],
        responseKind="timeline",
    )

    def update(value):
        value["context"]["previousReply"] = previous
        value["context"]["history"] = [
            {"role": "user", "content": "Tell me about your sky post.", "turnId": "past"},
            {"role": "assistant", "content": "Blue sky!", "turnId": "past"},
        ]

    result, provider = await run(retrieval, text="Tell me more about that post.", update=update)
    assert result["kind"] == "completed"
    if count > 1:
        assert result["reply"]["status"] == "needs_clarification"
        assert "AMBIGUOUS_SOURCE_REFERENCE" in result["reply"]["limitations"]
        assert not retrieval.resolves and not retrieval.searches and not provider.messages
        return
    assert retrieval.resolves
    assert not retrieval.searches
    assert not retrieval.summary_calls
    evidence = next(
        m["content"].split(" ", 1)[1]
        for m in provider.messages[0]
        if m["content"].startswith("UNTRUSTED_EVIDENCE_JSON_DATA ")
    )
    assert [post["sourceId"] for post in json.loads(evidence)] == [
        f"post-{i}" for i in range(min(count, 3))
    ]


async def test_date_only_query_real_adapter_never_embeds_empty_string(monkeypatch):
    from ptr_llm.repositories.sources import PostgresRetrieval

    embedded = []
    retrieval = Retrieval(1)

    async def embed(text, **options):
        assert text.strip()
        embedded.append(text)
        return [1] * 1536

    from types import SimpleNamespace

    from test_runtime_composition import URL

    from ptr_llm.repositories.summaries import PostgresSummaryRepository

    async def active(*args, **options):
        return {"run_id": "synthetic-pinned-run"}

    async def summaries(*args, **options):
        return {"post-0": "2020, blue sky.\nPainting.\nClouds."}

    monkeypatch.setattr(PostgresSummaryRepository, "active_run", active)
    monkeypatch.setattr(PostgresSummaryRepository, "get_summaries", summaries)

    class Sources:
        pool = SimpleNamespace(conninfo=URL)

        async def search_summary_children(self, query, trusted, vector, model, **options):
            return [
                {
                    "source_id": post["id"],
                    "summary": "2020, blue sky.\nPainting.\nClouds.",
                    "source_hash": post["hash"],
                    "snapshot": post["snapshot"],
                }
                for post in retrieval.sources
            ]

        async def load_summary_parents(self, keys, trusted, **options):
            return {
                post["id"]: {"source": post, "summary": "2020, blue sky.\nPainting.\nClouds."}
                for post in retrieval.sources
                if post["id"] in keys
            }

    adapter = PostgresRetrieval(
        Sources(), embed=embed, model_revision="synthetic-embedding", summary_index=True
    )
    adapter.summaries = retrieval.summaries

    def update(value):
        value["context"]["input"]["timeline"] = {"start": "2000-01-01", "end": "2030-01-01"}

    result, _ = await run(adapter, text="Which posts in those dates?", update=update)
    assert result["kind"] == "completed"
    assert embedded == ["Which posts in those dates?"]


@pytest.mark.parametrize("collision", [False, True])
async def test_atomic_pinned_capability_keeps_full_photos_and_blocks_parent_collision(collision):
    retrieval = Retrieval(1)
    source = retrieval.sources[0]
    annotations = [
        {
            "id": f"photo-{i}",
            "text": f"Visual description: Synthetic clouds {i}.",
            "revision": "current",
            "imageHash": f"image-{i}",
            "annotationHash": f"annotation-{i}",
            "humanReviewed": False,
            "model": "synthetic-image-model",
        }
        for i in range(2)
    ]
    source["imageAnnotations"] = annotations
    previous = {
        "grounding": "source_bound_quotes",
        "evidence": [
            {
                "sourceId": source["id"],
                "quote": "Synthetic old photo.",
                "annotationId": "photo-old",
                "annotationRevision": "old",
                "imageHash": "old-image",
                "annotationHash": "old-annotation",
                **{
                    key: source[key]
                    for key in [
                        "personId",
                        "sourceUrl",
                        "postedAt",
                        "eventDate",
                        "snapshot",
                        "hash",
                    ]
                },
            }
        ],
        "sessionId": "synthetic-session",
        "personId": PERSONA["personId"],
        "personaRevision": PERSONA["revision"],
        "responseKind": "timeline",
    }

    async def resolved(refs, trusted, **options):
        assert refs[0]["annotationRevision"] == "old"
        result = copy.deepcopy(source)
        if collision:
            result["hash"] = "foreign-parent-hash"
        return [result], {"post-0": "Summary of current full photos.\nPainting.\nClouds."}

    async def search(query, trusted, **options):
        retrieval.searches.append(query)
        return []

    retrieval.summary_index = True
    retrieval.resolve_with_summaries = resolved
    retrieval.search = search

    def update(value):
        value["context"]["session"]["ragCondition"] = "caption_image"
        value["context"]["previousReply"] = previous
        value["context"]["history"] = [
            {"role": "user", "content": "Tell me about your sky post.", "turnId": "past"}
        ]

    result, provider = await run(retrieval, text="Tell me more about that photo.", update=update)
    assert result["kind"] == "completed"
    card = next(
        m["content"]
        for m in provider.messages[0]
        if m["content"].startswith("UNTRUSTED_EVIDENCE_JSON_DATA ")
    )
    posts = json.loads(card.split(" ", 1)[1])
    if collision:
        assert posts == [] and retrieval.searches
    else:
        assert len(posts[0]["imageAnnotations"]) == 2
        assert not retrieval.summary_calls and not retrieval.searches
        assert not retrieval.summary_calls


async def test_revoked_ownership_prevents_query_embedding_before_atomic_retrieval():
    from ptr_llm.repositories.sources import PostgresRetrieval

    embedded = []

    async def embed(text, **options):
        embedded.append(text)
        return [1] * 1536

    class Sources:
        pass  # Missing pool is intentional: revoked grants never reach the adapter.

    retrieval = PostgresRetrieval(
        Sources(), embed=embed, model_revision="synthetic-embedding", summary_index=True
    )

    async def revoked():
        raise RuntimeError("ownership revoked")

    result, provider = await run(retrieval, guard=revoked)
    assert result["kind"] == "failed"
    assert not embedded and not provider.messages
