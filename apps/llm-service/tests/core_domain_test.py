"""Synthetic goldens computed from existing TypeScript domain before migration."""

import asyncio
import copy
import json
import logging
import time
from pathlib import Path

import pytest

from ptr_llm.billing import ProviderError
from ptr_llm.control import ControlRejected, ControlUnavailable
from ptr_llm.core.context import retrieval_context
from ptr_llm.core.errors import CoreError
from ptr_llm.core.evidence import filter_evidence, formatted_quote, validate_experiment_reply
from ptr_llm.core.persona import (
    greeting_for,
    match_lore,
    persona_revision,
    render_persona_block,
    validate_persona,
    validate_publication,
)
from ptr_llm.core.prompts import build_experiment_context
from ptr_llm.core.routing import safety_windows
from ptr_llm.core.runtime import LLMEngine
from ptr_llm.worker import ExecutionStopped

GOLDENS = json.loads(Path(__file__).with_name("core_domain_golden.json").read_text())
PERSONA = next(c["input"] for c in GOLDENS if c["kind"] == "persona")
SOURCE = next(c["source"] for c in GOLDENS if c["kind"] == "evidence")


@pytest.mark.parametrize("case", GOLDENS, ids=lambda c: c["kind"])
async def test_typescript_domain_goldens(case):
    kind = case["kind"]
    if kind == "persona":
        assert render_persona_block(validate_persona(case["input"])) == case["render"]
        assert persona_revision(case["input"]) == case["revision"]
        return
    if kind == "lore":
        actual = match_lore(case["persona"], case["current"], case["previous"])
    elif kind == "context":
        actual = retrieval_context(case["history"], case["text"])
    elif kind == "evidence":
        actual = validate_experiment_reply(
            case["raw"], [case["source"]], "synthetic-a", case["condition"], "en", "polite"
        )
    elif kind == "windows":
        actual = safety_windows(case["text"])
    elif kind == "prompt":
        actual = build_experiment_context(
            case["persona"], case["history"], case["text"], case["sources"]
        )
    elif kind == "publish":
        actual = await validate_publication(case["persona"], source_ref_exists=lambda *_: True)
    elif kind == "greeting":
        actual = greeting_for(case["persona"], case["sessionId"])
    else:
        raise AssertionError(kind)
    assert actual == case["expected"]


class Personas:
    async def get(self, *_):
        return copy.deepcopy(PERSONA)


class Provider:
    def __init__(self, responses):
        self.responses = list(responses)
        self.messages = []

    async def generate(self, messages, **kwargs):
        self.messages.append(copy.deepcopy(messages))
        kwargs.get("on_served", lambda _: None)("primary")
        return self.responses.pop(0)


class FailingProvider:
    async def generate(self, *_args, **_kwargs):
        raise ProviderError("RESERVATION_BELOW_MAXIMUM_COST")


class Retrieval:
    def __init__(self, sources=()):
        self.sources = list(sources)
        self.searches = []
        self.resolutions = 0

    async def search(self, query, trusted, **kwargs):
        self.searches.append(query)
        return copy.deepcopy(self.sources)

    async def resolve(self, refs, trusted, **kwargs):
        self.resolutions += 1
        return copy.deepcopy(self.sources)


def response(message="Hi!", refs=(), function=None, updates=None):
    value = {
        "message": message,
        "status": "answered",
        "evidenceRefs": list(refs),
        "variableUpdates": updates or {},
    }
    if function:
        value["function"] = {"name": "timeline_search", "arguments": {"query": function}}
    return json.dumps(value)


def grant(text="Hi!", **session_updates):
    session = {
        "id": "synthetic-session",
        "ownerId": "synthetic-owner",
        "personId": PERSONA["personId"],
        "personaId": PERSONA["id"],
        "personaRevision": PERSONA["revision"],
        "language": "en",
        "timezone": "UTC",
        "retrievalMode": "off",
        "ragCondition": "off",
        "executionProfile": "agent_loop",
        **session_updates,
    }
    return {
        "deadlineAt": int(time.time() * 1000) + 30000,
        "context": {
            "session": session,
            "turn": {"id": "synthetic-turn"},
            "input": {"text": text},
            "history": [],
            "refusedTurnIds": [],
        },
    }


async def noop():
    pass


async def test_native_graph_tool_loop_state_and_fenced_each_call():
    provider = Provider(
        [
            response("", function="blue sky"),
            response(
                "That blue sky!",
                refs=[{"sourceId": SOURCE["id"], "quote": "I painted a blue sky."}],
                updates={"tone": "warm"},
            ),
        ]
    )
    retrieval = Retrieval([SOURCE])
    checks = []

    async def guard():
        checks.append(True)

    result = await LLMEngine(provider=provider, personas=Personas(), retrieval=retrieval).handle(
        grant("Tell me about your sky post.", retrievalMode="lexical", ragCondition="caption"),
        before_costly=guard,
        cancelled=asyncio.Event(),
    )
    assert result["kind"] == "completed"
    reply = result["reply"]
    assert reply["agent"]["modelCalls"] == 2
    assert reply["agent"]["toolCalls"] == 1
    assert reply["agent"]["variables"]["tone"] == "warm"
    assert reply["grounding"] == "source_bound_quotes"
    assert len(checks) == 2
    assert len(retrieval.searches) == 2
    assert any("TOOL_RESULT_JSON_DATA" in m["content"] for m in provider.messages[1])
    assert reply["claims"][0]["evidenceRefs"][0]["start"] == 3


async def test_rag_off_never_retrieves_and_invalid_evidence_stays_unverified():
    provider = Provider(
        [
            response(
                "Synthetic fun!",
                refs=[{"sourceId": SOURCE["id"], "quote": "I painted a blue sky."}],
            )
        ]
    )
    retrieval = Retrieval([SOURCE])
    result = await LLMEngine(provider=provider, personas=Personas(), retrieval=retrieval).handle(
        grant("Tell me your past post."), before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["evidence"] == []
    assert not retrieval.searches
    assert "INVALID_MODEL_EVIDENCE" in result["reply"]["limitations"]


async def test_refused_history_is_removed_and_guard_runs_again_on_attempt():
    provider = Provider([response("Hello!"), response("Hello!")])
    engine = LLMEngine(provider=provider, personas=Personas(), input_safety=SafeClassifier())
    g = grant()
    g["context"]["history"] = [
        {"role": "user", "content": "synthetic refused", "turnId": "refused"},
        {"role": "assistant", "content": "declined", "turnId": "refused"},
    ]
    g["context"]["refusedTurnIds"] = ["refused"]
    for _ in range(2):
        assert (await engine.handle(g, before_costly=noop, cancelled=asyncio.Event()))[
            "kind"
        ] == "completed"
    assert not any(
        "synthetic refused" in m["content"] for batch in provider.messages for m in batch
    )


class SafeClassifier:
    name = "synthetic-safe"

    async def assess(self, data, **kwargs):
        return {"safety": {c: 0 for c in data["categories"]}}


async def test_invalid_reply_fallback_and_human_impersonation_guard():
    for raw, limitation in [
        ("not json", "AGENT_REPLY_INVALID"),
        (response("I am a real person."), "REPLY_GUARD_HUMAN_IMPERSONATION"),
    ]:
        result = await LLMEngine(provider=Provider([raw]), personas=Personas()).handle(
            grant(), before_costly=noop, cancelled=asyncio.Event()
        )
        assert result["kind"] == "completed"
        assert limitation in result["reply"]["limitations"]
        assert result["reply"]["evidence"] == []


async def test_repeated_tool_rejected_without_model_retry():
    provider = Provider([response("", function="same"), response("", function="same")])
    result = await LLMEngine(provider=provider, personas=Personas(), retrieval=Retrieval()).handle(
        grant("remember your photo?", retrievalMode="lexical", ragCondition="caption"),
        before_costly=noop,
        cancelled=asyncio.Event(),
    )
    assert result == {"kind": "failed", "errorCode": "TURN_FAILED"}
    assert len(provider.messages) == 2


async def test_reservation_below_minimum_cost_maps_to_provider_budget_exceeded():
    result = await LLMEngine(provider=FailingProvider(), personas=Personas()).handle(
        grant(), before_costly=noop, cancelled=asyncio.Event()
    )
    assert result == {"kind": "failed", "errorCode": "PROVIDER_BUDGET_EXCEEDED"}


@pytest.mark.parametrize(
    "error",
    [ControlUnavailable(), ControlRejected(), ExecutionStopped("EXECUTION_LOST")],
    ids=lambda error: error.__class__.__name__,
)
async def test_control_errors_escape_before_costly_without_provider_submission(error):
    provider = Provider([response()])

    async def lost_control():
        raise error

    with pytest.raises(error.__class__):
        await LLMEngine(provider=provider, personas=Personas()).handle(
            grant(), before_costly=lost_control, cancelled=asyncio.Event()
        )
    assert not provider.messages


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (
            ProviderError("BUDGET_EXCEEDED"),
            {
                "error_code": "PROVIDER_BUDGET_EXCEEDED",
                "exception_class": "ProviderError",
                "provider_code": "BUDGET_EXCEEDED",
                "core_reason": "UNSPECIFIED",
            },
        ),
        (
            CoreError("TURN_FAILED", "REPLY_REJECTED"),
            {
                "error_code": "TURN_FAILED",
                "exception_class": "CoreError",
                "provider_code": "UNSPECIFIED",
                "core_reason": "REPLY_REJECTED",
            },
        ),
        (
            RuntimeError("private upstream content"),
            {
                "error_code": "TURN_FAILED",
                "exception_class": "RuntimeError",
                "provider_code": "UNSPECIFIED",
                "core_reason": "UNSPECIFIED",
            },
        ),
    ],
    ids=lambda case: case.__class__.__name__ if isinstance(case, Exception) else case["error_code"],
)
async def test_failure_logging_uses_fixed_classification_without_exception_text(
    caplog, error, expected
):
    class BrokenProvider:
        async def generate(self, *_args, **_kwargs):
            raise error

    caplog.set_level(logging.INFO, logger="ptr_llm.core.runtime")
    result = await LLMEngine(provider=BrokenProvider(), personas=Personas()).handle(
        grant(), before_costly=noop, cancelled=asyncio.Event()
    )
    assert result == {"kind": "failed", "errorCode": expected["error_code"]}

    records = [
        record for record in caplog.records if record.message.startswith("turn_failed_classified")
    ]
    assert len(records) == 1
    record = records[0]
    assert record.error_code == expected["error_code"]
    assert record.exception_class == expected["exception_class"]
    assert record.provider_code == expected["provider_code"]
    assert record.core_reason == expected["core_reason"]
    assert f"error_code={expected['error_code']}" in record.message
    assert f"exception_class={expected['exception_class']}" in record.message
    assert "private upstream content" not in caplog.text


async def test_fence_failure_blocks_provider_submission():
    provider = Provider([response()])

    async def lost():
        raise CoreError("TURN_FAILED", "TURN_ABORTED")

    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        grant(), before_costly=lost, cancelled=asyncio.Event()
    )
    assert result["kind"] == "failed"
    assert not provider.messages


async def test_date_timezone_request_clarifies_without_model():
    provider = Provider([])
    g = grant("the event", retrievalMode="lexical", ragCondition="caption")
    g["context"]["input"]["timeline"] = {
        "start": "2026-03-08",
        "end": "2026-03-09",
        "dateBasis": "event",
        "timezone": "America/New_York",
    }
    result = await LLMEngine(provider=provider, personas=Personas(), retrieval=Retrieval()).handle(
        g, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["reply"]["status"] == "needs_clarification"
    assert not provider.messages


def test_dst_calendar_filter_and_utf16_whitespace_binding():
    q = {
        "personId": "synthetic-a",
        "dateBasis": "posted",
        "timezone": "America/New_York",
        "start": "2026-03-08",
        "end": "2026-03-09",
        "limit": 20,
    }
    assert filter_evidence([SOURCE], q, "synthetic-a") == [SOURCE]
    assert formatted_quote("😀 a\n b", "a b") == {
        "start": 3,
        "end": 7,
        "quote": "a\n b",
        "canonicalized": True,
    }
    assert formatted_quote("aaa", "aa") is None


async def test_publication_fail_closed_without_licensed_sources():
    report = await validate_publication(PERSONA)
    assert not report["ok"]
    assert any(i["rule"] == "source_lookup_failed" for i in report["issues"])


ROUTING_GOLDENS = json.loads(Path(__file__).with_name("core_routing_golden.json").read_text())


@pytest.mark.parametrize("case", ROUTING_GOLDENS, ids=lambda c: c["text"])
def test_full_original_routing_matrix(case):
    from itertools import product

    from ptr_llm.core.routing import intent_signals, needs_classifier, rule_intent

    actual = []
    for explicit, explicit_timeline, rag, previous in product(
        [None, "small_talk", "timeline", "clarification", "unsupported"],
        [False, True],
        [None, "off", "caption", "caption_image"],
        [False, True],
    ):
        context = retrieval_context(case["history"], case["text"], explicit_timeline)
        signals = intent_signals(
            case["text"],
            context,
            explicit_intent=explicit,
            explicit_timeline=explicit_timeline,
            rag_condition=rag,
            previous_timeline=previous,
        )
        actual.append([rule_intent(signals), needs_classifier(signals)])
    assert actual == case["expected"]


async def test_draft_content_and_input_refusal_remain_backend_artifact_free():
    engine = LLMEngine(provider=Provider(["Fictional blue sky sketch."]), personas=Personas())
    request = {
        "contractVersion": 1,
        "session": grant()["context"]["session"],
        "brief": "A fictional sky sketch",
        "requestKey": "draft:synthetic-key",
        "deadlineAt": int(time.time() * 1000) + 30000,
    }
    result = await engine.draft(request)
    assert result["content"] == "Fictional blue sky sketch."
    assert "artifact" not in result
    request["brief"] = "what is your home address?"
    result = await engine.draft(request)
    assert result["notice"]["status"] == "out_of_scope"


def test_utf16_protocol_limits_and_service_field_echo():
    from ptr_llm.core.protocol import parse_agent_response

    raw = response("Fine!", updates={"replyLanguage": "Korean", "speechLevel": "반말"})
    assert parse_agent_response(raw)["variableUpdates"] == {}
    with pytest.raises(CoreError):
        parse_agent_response(response("Fine!", refs=[{"sourceId": "s", "quote": "😀" * 49}]))
    with pytest.raises(CoreError):
        validate_persona(dict(PERSONA, lore=None))


async def test_combined_classifier_no_answer_does_not_resubmit():
    class Intent:
        name = "synthetic-combined"

        def __init__(self):
            self.calls = 0

        async def classify(self, *_, **__):
            self.calls += 1
            raise AssertionError("must not resubmit")

    class Safety(SafeClassifier):
        async def assess(self, data, **kwargs):
            return {"safety": {c: 0 for c in data["categories"]}}

    intent = Intent()
    result = await LLMEngine(
        provider=Provider([response("Hello!")]),
        personas=Personas(),
        intent_classifier=intent,
        input_safety=Safety(),
    ).handle(
        grant("Hello!", retrievalMode="lexical", ragCondition="caption"),
        before_costly=noop,
        cancelled=asyncio.Event(),
    )
    assert result["kind"] == "completed"
    assert intent.calls == 0
    assert result["reply"]["intentRouting"]["fallbackReason"] == "no_answer"


@pytest.mark.parametrize(
    "latest_actions", [("support", "deflect"), ("refuse", "support"), ("deflect", "refuse")]
)
async def test_lore_latest_two_window_does_not_resurrect_older_safe_turn(latest_actions):
    """TS slices the last two eligible prompt users before checking safety metadata."""
    persona = copy.deepcopy(PERSONA)
    persona["lore"] = [
        {
            "id": "lore-synthetic-window",
            "keys": ["starflowers"],
            "content": "A fictional starflowers motif.",
            "sourceRefs": ["synthetic-ref"],
        }
    ]

    class LorePersonas:
        async def get(self, *_):
            return copy.deepcopy(persona)

    g = grant("Hello!")
    g["context"]["history"] = [
        {"role": "user", "turnId": "synthetic-old-safe", "content": "starflowers"},
        {"role": "assistant", "turnId": "synthetic-old-safe", "content": "A motif."},
        *[
            {"role": "user", "turnId": "synthetic-" + action, "content": "Hello again!"}
            for action in latest_actions
        ],
    ]
    g["context"]["loreExcludedTurnIds"] = ["synthetic-" + action for action in latest_actions]
    provider = Provider([response("Hello!")])
    result = await LLMEngine(provider=provider, personas=LorePersonas()).handle(
        g, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["personaContext"]["loreIds"] == []
    assert all(not m["content"].startswith("LORE_JSON_DATA ") for m in provider.messages[0])
