"""Summary-only evidence decisions; synthetic data, no network or paid calls."""

import asyncio
import copy
import json
import time

import pytest
from core_domain_test import PERSONA, SOURCE, Personas, Provider, grant, noop, response

from ptr_llm.billing import ProviderError, provider_request_scope
from ptr_llm.core.prompts import build_experiment_context
from ptr_llm.core.runtime import LLMEngine
from ptr_llm.providers import jev

SEED = "12345678-1234-1234-1234-123456789abc"


def candidates(count=5):
    return [
        {
            "id": f"post-{i}",
            "summary": f"2020, a blue sky {i}.\nLandscape.\nClouds.",
            "postedAt": "2020-01-01T00:00:00Z",
            "eventDate": None,
        }
        for i in range(count)
    ]


class Client:
    def __init__(self, scores):
        self.scores, self.calls = scores, []

    async def decide(self, request, **options):
        self.calls.append((copy.deepcopy(request), options))
        return {
            "answers": {
                key: {"type": "noul", "noul": self.scores[i]}
                for i, key in enumerate(request["questions"])
            }
        }


@pytest.mark.parametrize(
    "scores,expected",
    [
        ([0.1] * 5, []),
        ([0.1, 0.8, 0.1, 0.1, 0.1], ["post-1"]),
        ([0.9, 0.8, 0.95, 0.8, 0.7], ["post-2", "post-0", "post-1", "post-3", "post-4"]),
    ],
)
async def test_selector_variable_count_and_stable_relevance_order(scores, expected):
    client = Client(scores)
    selector = jev.JevEvidenceSelector(client)
    found = await selector.select(
        {"query": "blue sky?", "candidates": candidates(), "seed": SEED},
        signal=asyncio.Event(),
        deadline_at=time.time() * 1000 + 1000,
    )
    assert found == expected
    assert len(client.calls) == 1
    request, options = client.calls[0]
    assert set(request["state"]) == {"query", "candidates", "promptRevision"}
    assert options["request_key"] == SEED
    assert provider_request_scope(options["request_key"], "decision") == {
        "kind": "decision",
        "turnId": SEED,
    }


@pytest.mark.parametrize(
    "bad",
    [
        None,
        {},
        {"foreign": {"type": "noul", "noul": 1}},
        {"candidate_0": {"type": "noul", "noul": float("nan")}},
    ],
)
async def test_selector_malformed_answers_fail_closed(bad):
    client = Client([1])

    async def malformed(*args, **kwargs):
        return {"answers": bad}

    client.decide = malformed
    with pytest.raises(ProviderError):
        await jev.JevEvidenceSelector(client).select(
            {"query": "sky?", "candidates": candidates(1), "seed": SEED}
        )


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


class Selector:
    def __init__(self, ids):
        self.ids, self.calls = ids, []

    async def select(self, data, **options):
        self.calls.append((data, options))
        return self.ids


async def run(
    retrieval,
    selector,
    *,
    text="Tell me about your sky post.",
    mode="semantic",
    responses=None,
    update=None,
    guard=noop,
    cancelled=None,
):
    provider = Provider(responses or [response("Nice sky!")])
    engine = LLMEngine(
        provider=provider, personas=Personas(), retrieval=retrieval, evidence_selector=selector
    )
    value = grant(text, retrievalMode=mode, ragCondition="caption")
    value["context"]["turn"]["id"] = SEED
    if update:
        update(value)
    result = await engine.handle(value, before_costly=guard, cancelled=cancelled or asyncio.Event())
    return result, provider


@pytest.mark.parametrize("ids", [[], ["post-1"], [f"post-{i}" for i in range(5)]])
async def test_runtime_only_selected_original_sources_and_no_three_cap(ids):
    retrieval, selector = Retrieval(), Selector(ids)
    result, provider = await run(retrieval, selector)
    assert result["kind"] == "completed"
    assert len(selector.calls) == 1
    assert set(selector.calls[0][0]) == {"query", "candidates", "seed"}
    assert all("caption" not in item for item in selector.calls[0][0]["candidates"])
    card = next(
        m["content"]
        for m in provider.messages[0]
        if m["content"].startswith("UNTRUSTED_EVIDENCE_JSON_DATA ")
    )
    assert [s["sourceId"] for s in json.loads(card.split(" ", 1)[1])] == ids
    assert retrieval.summary_calls[0][1] == {"personId": PERSONA["personId"]}
    assert retrieval.searches[0][0]["limit"] == 20


@pytest.mark.parametrize(
    "mode,text",
    [
        ("off", "Tell me about your sky post."),
        ("semantic", "Hello!"),
        ("semantic", "Imagine a fictional adventure."),
    ],
)
async def test_no_evidence_decision_for_off_smalltalk_or_creative(mode, text):
    selector, retrieval = Selector(["post-0"]), Retrieval()
    result, _ = await run(retrieval, selector, text=text, mode=mode)
    assert result["kind"] == "completed"
    assert not selector.calls
    assert not retrieval.summary_calls


@pytest.mark.parametrize("ids", [["foreign"], ["post-0", "post-0"], None])
async def test_runtime_foreign_duplicate_or_invalid_ids_never_fallback(ids):
    result, provider = await run(Retrieval(), Selector(ids))
    assert result["kind"] == "failed"
    assert not provider.messages


async def test_missing_summary_fail_closed_without_selector_call():
    retrieval, selector = Retrieval(), Selector(["post-0"])

    async def absent(*args, **kwargs):
        return {}

    retrieval.summaries = absent
    result, provider = await run(retrieval, selector)
    assert result["kind"] == "failed"
    assert not selector.calls and not provider.messages


async def test_fence_cancel_and_deadline_before_evidence_cost():
    for reason in ("cancel", "deadline", "ownership"):
        retrieval, selector = Retrieval(), Selector(["post-0"])
        cancelled = asyncio.Event()

        def update(value):
            if reason == "deadline":
                value["deadlineAt"] = 0
            elif reason == "cancel":
                cancelled.set()

        async def guard():
            if reason == "ownership":
                raise RuntimeError("ownership lost")

        result, provider = await run(
            retrieval, selector, update=update, guard=guard, cancelled=cancelled
        )
        assert result["kind"] == "failed"
        assert not selector.calls and not provider.messages


async def test_tool_search_cannot_bypass_selector():
    retrieval, selector = Retrieval(), Selector(["post-0"])
    result, _ = await run(
        retrieval, selector, responses=[response("", function="blue sky"), response("Nice sky!")]
    )
    assert result["kind"] == "completed"
    assert len(selector.calls) == 2
    assert selector.calls[1][0]["query"] == "blue sky"


def test_selector_source_limit_relaxes_only_cap_not_byte_budget():
    sources = [dict(SOURCE, id=f"post-{i}") for i in range(5)]
    assert len(build_experiment_context(PERSONA, [], "sky?", sources)["sources"]) == 3
    context = build_experiment_context(PERSONA, [], "sky?", sources, max_sources=20)
    assert len(context["sources"]) == 5
    context = build_experiment_context(
        PERSONA, [], "sky?", [dict(s, caption="x" * 20000) for s in sources], max_sources=20
    )
    assert len(context["sources"]) < 5
    assert context["omittedSourceIds"]


async def test_pinned_followup_is_selected_again():
    retrieval, selector = Retrieval(1), Selector(["post-0"])
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

    result, _ = await run(retrieval, selector, text="Tell me more about that post.", update=update)
    assert result["kind"] == "completed"
    assert retrieval.resolves
    assert not retrieval.searches
    assert len(selector.calls) == 1


async def test_date_only_query_preserves_question_for_selector():
    retrieval, selector = Retrieval(1), Selector([])

    def update(value):
        value["context"]["input"]["timeline"] = {"start": "2000-01-01", "end": "2030-01-01"}

    result, _ = await run(
        retrieval, selector, text="Which posts did you publish in those dates?", update=update
    )
    assert result["kind"] == "completed"
    assert selector.calls[0][0]["query"] == "Which posts did you publish in those dates?"


async def test_selector_failure_never_reaches_generation():
    selector = Selector([])

    async def fail(*args, **kwargs):
        raise ProviderError("REQUEST_UNRESOLVED_NO_RESUBMIT")

    selector.select = fail
    result, provider = await run(Retrieval(), selector)
    assert result == {"kind": "failed", "errorCode": "PROVIDER_REQUEST_UNRESOLVED"}
    assert not provider.messages


async def test_runtime_checks_cancellation_after_summary_resolution():
    retrieval, selector, cancelled = Retrieval(), Selector([]), asyncio.Event()
    original = retrieval.summaries

    async def cancelling(*args, **kwargs):
        summaries = await original(*args, **kwargs)
        cancelled.set()
        return summaries

    retrieval.summaries = cancelling
    result, provider = await run(retrieval, selector, cancelled=cancelled)
    assert result == {"kind": "failed", "errorCode": "TURN_ABORTED"}
    assert not selector.calls and not provider.messages


async def test_batched_selector_ledger_replay_content_key_and_turn_scope():
    import httpx

    from ptr_llm.billing import MemoryBudgetLedger
    from ptr_llm.providers import OpenRouterClient

    calls, ledger = [], MemoryBudgetLedger()

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
                "model": "typesafe/jev-1.13",
                "usage": {"cost": 0},
                "answers": {key: {"type": "noul", "noul": 0.9} for key in body["questions"]},
            },
        )

    client = OpenRouterClient(
        api_key="synthetic",
        ledger=ledger,
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(handler),
    )
    selector = jev.JevEvidenceSelector(client)
    data = {"query": "blue sky?", "candidates": candidates(1), "seed": SEED}
    assert await selector.select(data) == ["post-0"]
    assert await selector.select(data) == ["post-0"]
    assert len(calls) == 1
    changed = copy.deepcopy(data)
    changed["candidates"][0]["summary"] = "Changed synthetic summary."
    await selector.select(changed)
    assert len(calls) == 2 and len(ledger.requests) == 2
    assert all(
        req.scope == {"kind": "decision", "turnId": SEED} for req in ledger.requests.values()
    )


async def test_unknown_selector_request_never_resubmits():
    import httpx

    from ptr_llm.billing import MemoryBudgetLedger
    from ptr_llm.providers import OpenRouterClient

    calls, ledger = [], MemoryBudgetLedger()

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
        calls.append(request)
        raise httpx.ReadError("synthetic ambiguous submission")

    client = OpenRouterClient(
        api_key="synthetic",
        ledger=ledger,
        live_enabled=True,
        allow_external_data=True,
        transport=httpx.MockTransport(handler),
    )
    selector = jev.JevEvidenceSelector(client)
    data = {"query": "blue sky?", "candidates": candidates(1), "seed": SEED}
    with pytest.raises(ProviderError):
        await selector.select(data)
    with pytest.raises(ProviderError, match="REQUEST_UNRESOLVED_NO_RESUBMIT"):
        await selector.select(data)
    assert len(calls) == 1
    assert next(iter(ledger.requests.values())).state == "unknown"


@pytest.mark.parametrize(
    "env",
    [
        {"PTR_LLM_RETRIEVAL_INDEX": "summary"},
        {"PTR_LLM_EVIDENCE_SELECTOR": "jev"},
        {"PTR_LLM_EVIDENCE_THRESHOLD": "nan"},
        {"PTR_LLM_EVIDENCE_THRESHOLD": "0"},
        {"PTR_LLM_RETRIEVAL_INDEX": "unknown"},
    ],
)
async def test_factory_rejects_inconsistent_evidence_configuration(monkeypatch, env):
    from test_runtime_composition import FakePool, _settings

    from ptr_llm import runtime as module

    monkeypatch.setattr(module, "AsyncConnectionPool", FakePool)
    with pytest.raises(ProviderError, match="INVALID_RUNTIME_CONFIG"):
        await module.build_runtime(_settings(), env)
    assert FakePool.instances[-1].closed


async def test_safety_deflection_never_searches_or_selects():
    from core_domain_test import SafeClassifier

    class PrivateSafety(SafeClassifier):
        async def assess(self, data, **options):
            return {
                "safety": {
                    category: 1 if category == "private_info" else 0
                    for category in data["categories"]
                }
            }

    retrieval, selector, provider = Retrieval(), Selector([]), Provider([response("Hello!")])
    engine = LLMEngine(
        provider=provider,
        personas=Personas(),
        retrieval=retrieval,
        evidence_selector=selector,
        input_safety=PrivateSafety(),
    )
    result = await engine.handle(
        grant("Where are you staying right now?", retrievalMode="semantic", ragCondition="caption"),
        before_costly=noop,
        cancelled=asyncio.Event(),
    )
    assert result["kind"] == "completed"
    assert not selector.calls and not retrieval.searches


async def test_long_korean_summaries_are_batched_with_complete_envelope_limit():
    from ptr_llm.providers.common import js_json

    class AllClient(Client):
        input_bytes = 12000

        async def decide(self, request, **options):
            self.calls.append((copy.deepcopy(request), options))
            return {"answers": {key: {"type": "noul", "noul": 0.9} for key in request["questions"]}}

    client, checks = AllClient([]), []
    data = candidates(20)
    for candidate in data:
        candidate["summary"] = "\n".join(["가" * 300] * 3)

    async def guard():
        checks.append(True)

    selected = await jev.JevEvidenceSelector(client).select(
        {"query": "질문", "candidates": data, "seed": SEED}, before_costly=guard
    )
    assert selected == [item["id"] for item in data]
    assert len(client.calls) > 1 and len(checks) == len(client.calls)
    assert sum(len(request["state"]["candidates"]) for request, _ in client.calls) == 20
    for request, options in client.calls:
        body = {
            **request,
            "provider": {
                "data_collection": "deny",
                "zdr": True,
                "allow_fallbacks": False,
                "max_price": {"prompt": "0.05", "completion": "0", "request": "0"},
            },
        }
        assert len(js_json(body).encode()) <= client.input_bytes
        assert "before_costly" not in options


async def test_later_batch_ownership_failure_returns_no_partial_selection():
    client = Client([1])
    client.input_bytes = 3000
    guarded = 0

    async def guard():
        nonlocal guarded
        guarded += 1
        if guarded == 2:
            raise RuntimeError("ownership lost")

    data = candidates(2)
    for candidate in data:
        candidate["summary"] = "가" * 600
    with pytest.raises(RuntimeError, match="ownership lost"):
        await jev.JevEvidenceSelector(client).select(
            {"query": "query", "candidates": data, "seed": SEED}, before_costly=guard
        )
    assert len(client.calls) == 1


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

    result, _ = await run(adapter, Selector([]), text="Which posts in those dates?", update=update)
    assert result["kind"] == "completed"
    assert embedded == ["Which posts in those dates?"]


async def test_atomic_search_uses_preloaded_summary_not_changed_active_lookup():
    retrieval, selector = Retrieval(1), Selector(["post-0"])

    async def atomic(query, trusted, **options):
        return retrieval.sources, {"post-0": "Pinned run summary.\nPainting.\nClouds."}

    async def forbidden(*args, **options):
        raise AssertionError("Must not read a newly activated run")

    retrieval.search_with_summaries = atomic
    retrieval.search = forbidden
    retrieval.summaries = forbidden
    result, _ = await run(retrieval, selector)
    assert result["kind"] == "completed"
    assert selector.calls[0][0]["candidates"][0]["summary"].startswith("Pinned run summary")


@pytest.mark.parametrize("collision", [False, True])
async def test_atomic_pinned_capability_keeps_full_photos_and_blocks_parent_collision(collision):
    retrieval, selector = Retrieval(1), Selector(["post-0"])
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

    retrieval.resolve_with_summaries = resolved
    retrieval.search = search

    def update(value):
        value["context"]["session"]["ragCondition"] = "caption_image"
        value["context"]["previousReply"] = previous
        value["context"]["history"] = [
            {"role": "user", "content": "Tell me about your sky post.", "turnId": "past"}
        ]

    result, provider = await run(
        retrieval, selector, text="Tell me more about that photo.", update=update
    )
    assert result["kind"] == "completed"
    card = next(
        m["content"]
        for m in provider.messages[0]
        if m["content"].startswith("UNTRUSTED_EVIDENCE_JSON_DATA ")
    )
    posts = json.loads(card.split(" ", 1)[1])
    if collision:
        assert posts == [] and not selector.calls and retrieval.searches
    else:
        assert len(posts[0]["imageAnnotations"]) == 2
        assert len(selector.calls) == 1 and not retrieval.searches
        assert not retrieval.summary_calls


async def test_revoked_ownership_prevents_query_embedding_before_atomic_retrieval():
    from ptr_llm.repositories.sources import PostgresRetrieval

    embedded, selector = [], Selector([])

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

    result, provider = await run(retrieval, selector, guard=revoked)
    assert result["kind"] == "failed"
    assert not embedded and not selector.calls and not provider.messages
