"""Synthetic C1 character-chat regressions; no provider or network calls."""

import asyncio
import json

import pytest
from core_domain_test import PERSONA, SOURCE, Personas, Provider, Retrieval, grant, noop, response

from ptr_llm.core.agent import run_character_agent
from ptr_llm.core.policy import VOICES
from ptr_llm.core.prompts import POLICY
from ptr_llm.core.runtime import LLMEngine
from ptr_llm.core.texts import utterance_language, voice_text


def test_voice_variants_are_deterministic_and_never_repeat_previous():
    for key in ("fallback", "decline_private", "memory_ask_back", "service_retry"):
        first = voice_text(key, "ko", "casual", seed="synthetic-turn")
        assert first == voice_text(key, "ko", "casual", seed="synthetic-turn")
        assert voice_text(key, "ko", "casual", previous=first, seed="synthetic-turn") != first


def test_prompt_rejects_invented_current_activity_and_persona_news_opinions():
    policy = POLICY["IDENTITY_PRIVACY_POLICY"]
    assert "Never state current activities or current location as fact" in policy
    assert "a posting date is not an activity date" in policy
    assert "do not present an opinion as the persona's own" in policy


@pytest.mark.parametrize(
    ("text", "fallback", "expected"),
    [
        ("오늘 어땠어? omg", "ko", "ko"),
        ("lol", "ko", "ko"),
        ("Thanks!", "ko", "ko"),
        ("I went to the park and met a friend today", "ko", "en"),
        ("그림 너무 좋아요 Thanks!", "en", "ko"),
    ],
)
def test_language_pinning_single_turn(text, fallback, expected):
    assert utterance_language(text, fallback) == expected


def test_language_switches_after_two_mixed_turns_but_not_one():
    korean_first = [{"role": "user", "content": "오늘 그림 어때?"}]
    mixed = "I liked the 그림"
    assert utterance_language(mixed, "ko", korean_first) == "ko"
    assert utterance_language(
        mixed, "ko", [*korean_first, {"role": "user", "content": mixed}]
    ) == "en"
    assert utterance_language("This looks really lovely today", "ko", korean_first) == "en"
    assert utterance_language("nice!", "ko", korean_first) == "ko"
    assert utterance_language("really", "ko", korean_first) == "ko"


@pytest.mark.parametrize(
    "text",
    [
        "나 어제 친구랑 여행 갔어",
        "그 그림 분위기 좋다",
        "나중에 얘기해줄게",
        "내가 오늘 그림 그렸어?",
        "나는 어제 바빴어?",
        "오늘 병원 다녀왔어 내가",
        "제가 만든 그림 어때요?",
        "my friend visited yesterday?",
        "I took a trip yesterday?",
        "저희 집 고양이 예쁘지?",
        "나도 그때 갔어?",
    ],
)
def test_user_story_does_not_ask_back(text):
    from ptr_llm.core.runtime import should_ask_back

    assert not should_ask_back("timeline", "caption", text, [])


@pytest.mark.parametrize("text", ["그때 언제였어?", "그날 뭐 했어?", "When was that?", "어디 갔니"])
def test_unbound_timeline_question_asks_back(text):
    from ptr_llm.core.runtime import should_ask_back

    assert should_ask_back("timeline", "caption", text, [])
    assert not should_ask_back("small_talk", "caption", text, [])
    assert not should_ask_back("timeline", "off", text, [])
    assert not should_ask_back("timeline", "caption", text, [{"sourceId": "synthetic"}])


@pytest.mark.parametrize(
    "text",
    [
        "난 몰라 너 언제 갔어?",
        "난 몰라.너 언제 갔어?",
        "내일 어디 가?",
        "다음에 어디 가?",
        "어디 갈 거야?",
        "어디 갈래?",
        "여행 갔었어",
    ],
)
def test_ask_back_question_sentence_and_time_boundary(text):
    from ptr_llm.core.runtime import should_ask_back

    expected = text in {"난 몰라 너 언제 갔어?", "난 몰라.너 언제 갔어?"}
    assert should_ask_back("timeline", "caption", text, []) is expected


async def test_agent_date_anchor_and_tool_limit_returns_retry():
    provider = Provider([response("", function="sky")])
    result = await run_character_agent(
        provider=provider,
        persona=PERSONA,
        history=[],
        text="What about your sky post?",
        sources=[SOURCE],
        search=lambda query: [],
        max_tool_rounds=0,
        created_at="2026-10-15T23:30:00Z",
        timezone_name="Asia/Seoul",
        request_key="synthetic-turn",
    )
    assert (
        result["response"]["message"]
        in json.loads(
            __import__("pathlib")
            .Path(__file__)
            .parents[1]
            .joinpath("src/ptr_llm/core/voice_texts.json")
            .read_text()
        )["service_retry"]["en"]
    )
    assert result["serviceLimitation"] == "TOOL_LIMIT"
    state = next(
        m["content"]
        for m in provider.messages[0]
        if m["content"].startswith("AGENT_STATE_JSON_DATA")
    )
    assert '"today":"2026-10-16"' in state
    assert '"sinceLastUserMessage"' in state


async def test_repeated_tool_request_returns_retry_without_second_search():
    provider = Provider([response("", function="same sky"), response("", function="same sky")])
    searches = []

    async def search(query):
        searches.append(query)
        return []

    result = await run_character_agent(
        provider=provider,
        persona=PERSONA,
        history=[],
        text="What about the sky?",
        sources=[],
        search=search,
        request_key="synthetic-repeat",
    )
    assert result["serviceLimitation"] == "TOOL_REPEATED"
    assert result["response"]["message"] == voice_text(
        "service_retry", "en", "polite", seed="synthetic-repeat"
    )
    assert searches == ["same sky"]


async def test_invalid_agent_json_is_service_retry():
    provider = Provider(["{malformed"])
    result = await run_character_agent(
        provider=provider,
        persona=PERSONA,
        history=[],
        text="Hello",
        sources=[],
        request_key="synthetic-invalid",
    )
    assert result["serviceLimitation"] == "AGENT_REPLY_INVALID"
    assert result["response"]["message"] == voice_text(
        "service_retry", "en", "polite", seed="synthetic-invalid"
    )


async def test_runtime_pins_session_language_for_short_interjection():
    provider = Provider([response("좋아!")])
    value = grant("lol", language="ko")
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        value, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    state = next(
        m["content"]
        for m in provider.messages[0]
        if m["content"].startswith("AGENT_STATE_JSON_DATA")
    )
    assert '"replyLanguage":"Korean"' in state


async def test_invalid_experiment_json_keeps_service_retry_not_ask_back():
    provider = Provider(["{malformed"])
    value = grant(
        "When was that?",
        retrievalMode="lexical",
        ragCondition="caption",
        executionProfile="experiment",
    )
    result = await LLMEngine(provider=provider, personas=Personas(), retrieval=Retrieval()).handle(
        value, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["content"] in VOICES["service_retry"]["en"]
    assert "MEMORY_ASK_BACK" not in result["reply"]["limitations"]


async def test_unbound_question_asks_back_then_broadens_after_two():
    provider = Provider(
        [
            response("I remember visiting a plaza."),
            response("I remember visiting a plaza."),
            response("I remember visiting a plaza."),
        ]
    )
    engine = LLMEngine(provider=provider, personas=Personas(), retrieval=Retrieval())
    history = []
    for index in range(3):
        value = grant("When was that?", retrievalMode="lexical", ragCondition="caption")
        value["context"]["turn"]["id"] = f"synthetic-{index}"
        value["context"]["history"] = history
        result = await engine.handle(value, before_costly=noop, cancelled=asyncio.Event())
        assert result["kind"] == "completed"
        content = result["reply"]["content"]
        variants = json.loads(
            __import__("pathlib")
            .Path(__file__)
            .parents[1]
            .joinpath("src/ptr_llm/core/voice_texts.json")
            .read_text()
        )
        key = "memory_topic_broaden" if index == 2 else "memory_ask_back"
        assert content in variants[key]["en"]
        history.extend(
            [
                {"role": "user", "content": "When was that?", "turnId": f"synthetic-{index}"},
                {"role": "assistant", "content": content, "turnId": f"synthetic-{index}"},
            ]
        )
