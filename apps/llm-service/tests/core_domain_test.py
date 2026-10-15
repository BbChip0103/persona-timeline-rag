"""Synthetic goldens computed from existing TypeScript domain before migration."""

import asyncio
import copy
import json
import logging
import time
from pathlib import Path

import pytest

from ptr_llm.billing import ProviderError
from ptr_llm.control import ControlRejected, ControlUnavailable, validate_wire
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
from ptr_llm.core.policy import VOICES
from ptr_llm.core.prompts import build_experiment_context
from ptr_llm.core.protocol import parse_agent_response, variables
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


async def test_output_guard_failure_records_only_class_code_and_stage(monkeypatch, caplog):
    from ptr_llm.core import runtime

    def fail(_reply, _metadata):
        raise ValueError("synthetic-private-content-must-not-log")

    monkeypatch.setattr(runtime, "validate_output", fail)
    engine = LLMEngine(provider=Provider([response("Hello there.")]), personas=Personas())
    result = await engine.handle(
        grant(), before_costly=lambda: asyncio.sleep(0), cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    reply = result["reply"]
    assert reply["content"] == "Hello there."
    assert "GUARDRAILS_OUTPUT_RECOVERED" in reply["limitations"]
    assert reply["operatorMetadata"] == {
        "guardStage": "output_guard",
        "exceptionClass": "ValueError",
        "code": "GUARDRAILS_OUTPUT_UNAVAILABLE",
    }
    assert "exception_class=ValueError" in caplog.text
    assert "guard_stage=output_guard" in caplog.text
    assert "synthetic-private-content-must-not-log" not in caplog.text


async def test_repeated_reply_regenerates_once_with_distinct_local_key():
    class LocalProvider(Provider):
        provider_name = "local"

        def __init__(self):
            super().__init__([response("Hello, there!"), response("A new fictional thought.")])
            self.keys = []

        async def generate(self, messages, **kwargs):
            self.keys.append(kwargs["request_key"])
            return await super().generate(messages, **kwargs)

        async def generate_local_only(self, messages, **kwargs):
            return await self.generate(messages, **kwargs)

    provider = LocalProvider()
    request = grant()
    request["context"]["history"] = [
        {"role": "user", "content": "Hi!", "turnId": "synthetic-previous"},
        {"role": "assistant", "content": "Hello there.", "turnId": "synthetic-previous"},
    ]
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        request, before_costly=lambda: asyncio.sleep(0), cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["content"] == "A new fictional thought."
    assert provider.keys == ["synthetic-turn", "synthetic-turn:regen"]


async def test_repeated_reply_near_deadline_uses_service_retry_without_regeneration():
    class LocalProvider(Provider):
        provider_name = "local"

        def __init__(self):
            super().__init__([response("Hello there.")])
            self.keys = []

        async def generate(self, messages, **kwargs):
            self.keys.append(kwargs["request_key"])
            return await super().generate(messages, **kwargs)

    provider = LocalProvider()
    request = grant()
    request["deadlineAt"] = int(time.time() * 1000) + 4500
    request["context"]["history"] = [
        {"role": "assistant", "content": "Hello there!", "turnId": "synthetic-previous"}
    ]
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        request, before_costly=lambda: asyncio.sleep(0), cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["content"] != "Hello there."
    assert result["reply"]["limitations"] == ["REPEATED_ASSISTANT_REPLY"]
    assert provider.keys == ["synthetic-turn"]


async def test_same_identity_question_twice_discloses_ai_in_distinct_words():
    persona = copy.deepcopy(PERSONA)
    persona["language"] = "ko"
    persona["style"] = ["반말"]

    class KoreanPersonas:
        async def get(self, *_):
            return copy.deepcopy(persona)

    original = "응, 나는 AI야. 그래도 같이 이야기하자!"
    provider = Provider([response(original), response(original)])
    engine = LLMEngine(provider=provider, personas=KoreanPersonas())
    first = await engine.handle(grant("너 AI야?", language="ko"), before_costly=noop,
                                cancelled=asyncio.Event())
    assert first["kind"] == "completed"
    second_request = grant("너 AI야?", language="ko")
    second_request["context"]["turn"]["id"] = "synthetic-turn-2"
    second_request["context"]["history"] = [
        {"role": "user", "content": "너 AI야?", "turnId": "synthetic-turn"},
        {"role": "assistant", "content": first["reply"]["content"], "turnId": "synthetic-turn"},
    ]
    second = await engine.handle(second_request, before_costly=noop,
                                 cancelled=asyncio.Event())
    assert second["kind"] == "completed"
    assert "AI" in second["reply"]["content"]
    assert second["reply"]["content"] != first["reply"]["content"]
    assert second["reply"]["operatorTrace"]["repeatChecked"] is True
    assert second["reply"]["operatorTrace"]["previousAvailable"] is True
    assert second["reply"]["operatorTrace"]["path"] == "identity_variant"
    wire_reply = next(row["value"] for row in json.loads(
        (Path(__file__).resolve().parents[3] / "contracts/llm/v2/corpus.json").read_text()
    ) if row["name"] == "valid_reply")
    wire_reply["operatorTrace"] = second["reply"]["operatorTrace"]
    result = validate_wire("Result", {"kind": "completed", "reply": wire_reply})
    assert result["reply"] == wire_reply


async def test_repeat_check_uses_last_assistant_even_when_prompt_history_excludes_it():
    original = "A fictional answer."
    request = grant("Hi again!")
    request["context"]["history"] = [
        {"role": "assistant", "content": original, "turnId": "synthetic-refused"}
    ]
    request["context"]["refusedTurnIds"] = ["synthetic-refused"]
    result = await LLMEngine(provider=Provider([response(original)]), personas=Personas()).handle(
        request, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["content"] != original
    assert result["reply"]["operatorTrace"]["previousAvailable"] is True


async def test_guard_identity_replacement_compares_with_previous_assistant():
    previous = VOICES["identity"]["casual"][0]
    request = korean_grant(previous=previous, speech_level="casual")
    request["context"]["input"]["text"] = "너 AI야?"
    engine = LLMEngine(provider=Provider([response("응, 안녕!")]), personas=Personas())
    result = await engine.handle(
        request, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert "AI" in result["reply"]["content"]
    assert result["reply"]["content"] != previous
    assert result["reply"]["operatorTrace"] == {
        "path": "guard_replacement", "code": "REPLY_GUARD_MISSING_AI_DISCLOSURE",
        "repeatChecked": True, "previousAvailable": True,
    }


async def test_input_guard_fallback_compares_with_previous_assistant(monkeypatch):
    from ptr_llm.core import runtime

    monkeypatch.setattr(runtime, "validate_input", lambda *_: (_ for _ in ()).throw(ValueError()))
    previous = VOICES["service_retry"]["en"][0]
    request = grant("Hello?")
    request["context"]["history"] = [
        {"role": "assistant", "content": previous, "turnId": "synthetic-previous"}
    ]
    result = await LLMEngine(provider=Provider([]), personas=Personas()).handle(
        request, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["content"] != previous
    assert result["reply"]["operatorTrace"] == {
        "path": "fallback", "code": "GUARDRAILS_INPUT_UNAVAILABLE",
        "repeatChecked": True, "previousAvailable": True,
    }


class RegisterProvider(Provider):
    def __init__(self, original, regenerated):
        super().__init__([response(original)])
        self.regenerated = response(regenerated)
        self.primary_keys = []
        self.local_keys = []

    async def generate(self, messages, **kwargs):
        self.primary_keys.append(kwargs["request_key"])
        return await super().generate(messages, **kwargs)

    async def generate_local_only(self, messages, **kwargs):
        self.local_keys.append(kwargs["request_key"])
        kwargs.get("on_served", lambda _: None)("local")
        return self.regenerated


def korean_grant(*, deadline_ms=30000, previous=None, speech_level=None):
    request = grant("가상 그림 이야기하자", language="ko")
    request["deadlineAt"] = int(time.time() * 1000) + deadline_ms
    if previous is not None:
        reply = {"sessionId": "synthetic-session", "personId": PERSONA["personId"],
                 "personaRevision": PERSONA["revision"], "agent": {"variables": {}}}
        if speech_level:
            reply["agent"]["variables"]["speechLevel"] = speech_level
        request["context"]["previousReply"] = reply
        request["context"]["history"] = [
            {"role": "assistant", "content": previous, "turnId": "synthetic-previous"}
        ]
    return request


@pytest.mark.parametrize(("original", "regenerated", "expected"), [
    ("같이 해요.", "같이 해.", "같이 해."),
    ("같이 해요.", "다시 해요.", "같이 해요."),
])
async def test_register_regeneration_is_local_once_and_keeps_original_on_second_mismatch(
    original, regenerated, expected
):
    provider = RegisterProvider(original, regenerated)
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        korean_grant(previous="전에 그렸어.", speech_level="casual"),
        before_costly=noop, cancelled=asyncio.Event(),
    )
    assert result["kind"] == "completed"
    assert result["reply"]["content"] == expected
    assert provider.primary_keys == ["synthetic-turn"]
    assert provider.local_keys == ["synthetic-turn:register"]


async def test_register_deadline_and_unknown_skip_regeneration():
    for original, remaining in [("같이 해요.", 4500), ("그림", 30000)]:
        provider = RegisterProvider(original, "같이 해.")
        result = await LLMEngine(provider=provider, personas=Personas()).handle(
            korean_grant(deadline_ms=remaining, previous="전에 그렸어.", speech_level="casual"),
            before_costly=noop, cancelled=asyncio.Event(),
        )
        assert result["kind"] == "completed"
        assert result["reply"]["content"] == original
        assert provider.local_keys == []


async def test_repeat_regeneration_has_priority_over_register_regeneration():
    provider = RegisterProvider("같이 해요.", "같이 해.")
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        korean_grant(previous="같이 해요!", speech_level="casual"),
        before_costly=noop, cancelled=asyncio.Event(),
    )
    assert result["kind"] == "completed"
    assert result["reply"]["content"] == "같이 해."
    assert provider.local_keys == ["synthetic-turn:regen"]


@pytest.mark.parametrize(("previous", "expected"), [
    ("전에 그렸어.", "같이 해요."),
    ("같이 해요!", None),
])
async def test_cosmetic_regeneration_timeout_completes_with_safe_original(
    previous, expected
):
    class TimeoutProvider(RegisterProvider):
        async def generate_local_only(self, messages, **kwargs):
            self.local_keys.append(kwargs["request_key"])
            assert kwargs["deadline_at"] <= request["deadlineAt"] - 2000
            raise TimeoutError("synthetic cosmetic timeout")

    provider = TimeoutProvider("같이 해요.", "unused")
    request = korean_grant(previous=previous, speech_level="casual")
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        request, before_costly=noop, cancelled=asyncio.Event(),
    )
    assert result["kind"] == "completed"
    if expected is None:
        assert result["reply"]["content"] in VOICES["service_retry"]["casual"]
        assert result["reply"]["content"] != previous
    else:
        assert result["reply"]["content"] == expected
    assert provider.local_keys == [
        "synthetic-turn:regen" if expected is None else "synthetic-turn:register"
    ]


async def test_regeneration_wait_for_expires_before_turn_deadline():
    class SlowProvider(RegisterProvider):
        async def generate_local_only(self, messages, **kwargs):
            self.local_keys.append(kwargs["request_key"])
            await asyncio.sleep(10)
            return self.regenerated

    provider = SlowProvider("같이 해요.", "같이 해.")
    request = korean_grant(deadline_ms=6500, previous="전에 그렸어.", speech_level="casual")
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        request, before_costly=noop, cancelled=asyncio.Event(),
    )
    assert result["kind"] == "completed"
    assert result["reply"]["content"] == "같이 해요."
    assert provider.local_keys == ["synthetic-turn:register"]


async def test_regeneration_without_rag_reuses_primary_biography_validation():
    class LocalProvider(Provider):
        def __init__(self):
            super().__init__([response("Hello there.")])

        async def generate_local_only(self, messages, **kwargs):
            return response("I grew up in a small town.")

    request = grant()
    request["context"]["session"].pop("ragCondition")
    request["context"]["history"] = [
        {"role": "assistant", "content": "Hello there!", "turnId": "synthetic-previous"}
    ]
    result = await LLMEngine(provider=LocalProvider(), personas=Personas()).handle(
        request, before_costly=noop, cancelled=asyncio.Event(),
    )
    primary_request = grant()
    primary_request["context"]["session"].pop("ragCondition")
    primary = await LLMEngine(
        provider=Provider([response("I grew up in a small town.")]), personas=Personas()
    ).handle(primary_request, before_costly=noop, cancelled=asyncio.Event())
    assert result["kind"] == "completed"
    assert primary["kind"] == "completed"
    assert result["reply"]["content"] == primary["reply"]["content"]
    assert result["reply"]["status"] == primary["reply"]["status"]
    assert result["reply"]["limitations"] == primary["reply"]["limitations"]
    assert "BIOGRAPHY_HEURISTIC_GUARD" in result["reply"]["limitations"]


def test_voice_policy_forbids_verbatim_previous_reply():
    from ptr_llm.core.prompts import POLICY

    assert "Never repeat your previous message verbatim." in POLICY["REPLY_VOICE_POLICY"]


async def noop():
    pass


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("말 편하게 해", "casual"),
        ("반말해", "casual"),
        ("존댓말 해 줘", "polite"),
        ("Speak casually", "casual"),
        ("Please speak informally", "casual"),
        ("Please use polite speech", "polite"),
        ("Please speak politely", "polite"),
        ("반말해 줘", "casual"),
        ("존댓말 해 주세요", "polite"),
        ("please speak casually", "casual"),
        ("걔가 나한테 반말해서 짜증나", None),
        ("그 사람한테 존댓말 해요", None),
        ("반말 해서 미안", None),
        ("왜 존댓말 해요?", None),
        ("don't speak casually", None),
        ("I never use formal language", None),
        ("he told me to speak casually", None),
    ],
)
def test_speech_request_rule(text, expected):
    from ptr_llm.core.runtime import requested_speech_level

    assert requested_speech_level(text) == expected


def test_only_runtime_can_set_speech_level():
    assert variables({"speechLevel": "casual"})["speechLevel"] == "casual"
    raw = response("응", updates={"speechLevel": "polite"})
    assert "speechLevel" not in parse_agent_response(raw)["variableUpdates"]


def test_persisted_speech_level_passes_strict_wire_contract():
    from ptr_llm.control import validate_wire

    agent = {
        "revision": "synthetic",
        "promptRevision": "synthetic",
        "modelCalls": 1,
        "toolCalls": 0,
        "variables": {"conversationTopic": "", "tone": "neutral", "speechLevel": "casual"},
        "steps": [],
        "validator": "disabled",
    }
    assert validate_wire("Agent", agent) == agent


async def test_speech_request_persists_on_non_answered_turn():
    raw = json.dumps({
        "message": "응, 편하게 얘기하자.",
        "status": "needs_clarification",
        "evidenceRefs": [],
        "variableUpdates": {"speechLevel": "polite"},
    })
    provider = Provider([raw, response("응, 계속 얘기하자.")])
    engine = LLMEngine(provider=provider, personas=Personas())
    first = await engine.handle(
        grant("말 편하게 해"), before_costly=noop, cancelled=asyncio.Event()
    )
    assert first["kind"] == "completed"
    assert first["reply"]["agent"]["variables"]["speechLevel"] == "casual"
    second_grant = grant("계속 이야기해")
    second_grant["context"]["previousReply"] = first["reply"]
    second = await engine.handle(second_grant, before_costly=noop, cancelled=asyncio.Event())
    assert second["kind"] == "completed"
    assert second["reply"]["agent"]["variables"]["speechLevel"] == "casual"
    state = next(
        m["content"] for m in provider.messages[1]
        if m["content"].startswith("AGENT_STATE_JSON_DATA ")
    )
    assert json.loads(state.split(" ", 1)[1])["speechLevel"] == "반말"


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


async def test_repeated_tool_returns_service_retry_without_model_retry():
    provider = Provider([response("", function="same"), response("", function="same")])
    result = await LLMEngine(provider=provider, personas=Personas(), retrieval=Retrieval()).handle(
        grant("remember your photo?", retrievalMode="lexical", ragCondition="caption"),
        before_costly=noop,
        cancelled=asyncio.Event(),
    )
    assert result["kind"] == "completed"
    assert "TOOL_REPEATED" in result["reply"]["limitations"]
    assert result["reply"]["content"] in VOICES["service_retry"]["en"]
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


async def test_event_date_query_uses_session_timezone_without_fixed_clarification():
    provider = Provider([response("I'm not sure which day that was.")])
    retrieval = Retrieval()
    g = grant(
        "the event", retrievalMode="lexical", ragCondition="caption", timezone="America/New_York"
    )
    g["context"]["input"]["timeline"] = {
        "start": "2026-03-08",
        "end": "2026-03-09",
        "dateBasis": "event",
        "timezone": "UTC",
    }
    result = await LLMEngine(provider=provider, personas=Personas(), retrieval=retrieval).handle(
        g, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert "EVENT_TIMEZONE_UNAVAILABLE" not in result["reply"]["limitations"]
    assert retrieval.searches[0]["timezone"] == "America/New_York"
    assert provider.messages


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
        "contractVersion": 2,
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
