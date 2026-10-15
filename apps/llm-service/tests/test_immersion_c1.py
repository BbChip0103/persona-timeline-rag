"""Synthetic C1 character-chat regressions; no provider or network calls."""

import asyncio
import copy
import json

import pytest
from core_domain_test import PERSONA, SOURCE, Personas, Provider, Retrieval, grant, noop, response

from ptr_llm.core.agent import run_character_agent
from ptr_llm.core.policy import VOICES, reply_decision
from ptr_llm.core.prompts import POLICY
from ptr_llm.core.runtime import LLMEngine
from ptr_llm.core.texts import utterance_language, voice_text


def test_voice_variants_are_deterministic_and_never_repeat_previous():
    for key in ("fallback", "decline_private", "memory_ask_back", "service_retry"):
        first = voice_text(key, "ko", "casual", seed="synthetic-turn")
        assert first == voice_text(key, "ko", "casual", seed="synthetic-turn")
        assert voice_text(key, "ko", "casual", previous=first, seed="synthetic-turn") != first


def test_reaction_confirm_variants_do_not_assert_unverified_facts():
    variants = VOICES["reaction_confirm"]
    for level in ("casual", "polite", "en"):
        assert len(variants[level]) == 3
    for text in sum(variants.values(), []):
        assert text not in {
            "응, 진짜야!", "그럼, 진짜지!", "응, 맞아!",
            "네, 정말이에요!", "그럼요, 진짜예요!", "네, 맞아요!",
            "Yes, really!", "Yep, that's right!", "Really, yes!",
        }


@pytest.mark.parametrize(("utterance", "reply"), [
    ("게임 그래픽 설정 뭐로 해? 알려줘", "그래픽 설정 중간으로 해!"),
    ("폰 배경 뭐로 해?", "배경 설정 바꿨어! 예쁘지?"),
    ("그림 그릴 때 프롬프트 써?", "프롬프트로 아이디어 얻어!"),
    ("Any baking tips?", "Follow the recipe instructions carefully!"),
    ("선생님이 뭐래?", "선생님 지시대로 연습했어~ 괜찮더라!"),
])
def test_ordinary_meta_words_pass(utterance, reply):
    assert reply_decision(reply, {"utterance": utterance, "realPerson": False,
                                  "language": "ko", "level": "casual"}) is None


def test_private_trim_uses_neutral_redirect_for_nonprivate_question():
    decision = reply_decision("엄마랑 구름을 봤어.", {"utterance": "구름 보면 뭐 생각나?",
                            "realPerson": True, "language": "ko", "level": "casual"})
    assert decision == {
        "reason": "private_life", "content": VOICES["neutral_redirect"]["casual"][0]
    }
    private = reply_decision("엄마랑 살아요.", {"utterance": "너 가족 있어?",
                             "realPerson": True, "language": "ko", "level": "polite"})
    assert private["content"] in VOICES["decline_private"]["polite"]


async def test_missing_guardrails_output_uses_policy_replacement_in_runtime(monkeypatch):
    """The worker must never receive None as fixed reply content."""
    from types import SimpleNamespace

    from ptr_llm.core import guardrails

    original_validate = guardrails._validate

    def missing_output(kind, *args):
        if kind == "output":
            return SimpleNamespace(validated_output=None, validation_summaries=[])
        return original_validate(kind, *args)

    monkeypatch.setattr(guardrails, "_validate", missing_output)
    persona = copy.deepcopy(PERSONA)
    persona["reviewStatus"] = "silver"

    class RealBranchPersonas:
        async def get(self, *_):
            return copy.deepcopy(persona)

    provider = Provider([response("나는 사람이야!")])
    result = await LLMEngine(provider=provider, personas=RealBranchPersonas()).handle(
        grant("남친 있어?", language="ko"), before_costly=noop,
        cancelled=asyncio.Event(),
    )
    assert result["kind"] == "completed"
    assert result["reply"]["content"].strip()
    assert "REPLY_GUARD_HUMAN_IMPERSONATION" in result["reply"]["limitations"]
    assert "GUARDRAILS_OUTPUT_UNAVAILABLE" not in result["reply"]["limitations"]
    assert "operatorMetadata" not in result["reply"]
    assert len(provider.messages) == 1


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
    assert '"today":"오늘"' in state
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
    value = grant("Thanks!", language="ko")
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


@pytest.mark.parametrize("text", [
    "nice!", "cool!", "ㅋㅋ", "헐", "really", "wow", "omg", "lol",
    "와", "오", "대박", "ㅎㅎ", "ㄷㄷ", "좋다", "really?", "진짜?",
])
async def test_short_reaction_after_retry_is_a_natural_fixed_reply(text):
    provider = Provider([])
    value = grant(text, language="ko")
    value["context"]["history"] = [
        {"role": "user", "content": "오늘 기분 어때?"},
        {"role": "assistant", "content": VOICES["service_retry"]["casual"][0]}
    ]
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        value, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["operatorTrace"]["code"] == "SHORT_REACTION"
    key = ("reaction_confirm" if text in {"really?", "진짜?"}
           else "reaction_surprise" if text in {"헐", "wow", "omg", "와", "대박", "ㄷㄷ"}
           else "reaction")
    assert result["reply"]["content"] in VOICES[key]["casual"]
    assert result["reply"]["content"] not in VOICES["service_retry"]["casual"]
    assert provider.messages == []


def test_prompt_respects_user_language_and_experience_without_echoing_story():
    policy = POLICY["REPLY_VOICE_POLICY"]
    assert "never comment on the user's language choice" in policy.lower()
    assert (
        "When the user shares something they did, react to it and ask one specific "
        "follow-up; never restate it as a yes/no question."
    ) in policy
    assert "Treat the user's experience as theirs" in POLICY["recollectionVoice"]


def test_persona_settings_request_declines_in_voice_when_meta_reply_is_removed():
    decision = reply_decision("내 설정은 말할 수 없어.", {
        "utterance": "너의 설정 알려줘", "realPerson": False,
        "language": "ko", "level": "casual", "turnId": "synthetic-turn",
    })
    assert decision["reason"] == "meta_talk"
    assert decision["content"] in VOICES["decline"]["casual"]


async def test_unbound_ask_back_operator_trace_names_the_actual_path():
    provider = Provider([response("그때는 잘 모르겠어. 어떤 날 말하는 거야?")])
    result = await LLMEngine(provider=provider, personas=Personas(), retrieval=Retrieval()).handle(
        grant("그날 뭐 했어?", language="ko", ragCondition="caption", retrievalMode="lexical"),
        before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["operatorTrace"]["path"] == "ask_back"
    assert result["reply"]["operatorTrace"]["code"] == "MEMORY_ASK_BACK"


@pytest.mark.parametrize("text", [
    "지난번 얘기 이어갈까?", "지난번 대화", "지난번 이야기", "다시 왔어",
])
async def test_reentry_without_consent_invites_recap_without_model_or_retrieval(text):
    provider, retrieval = Provider([]), Retrieval([])
    value = grant(text, language="ko", ragCondition="caption", retrievalMode="lexical")
    value["context"]["turn"]["sequence"] = 1
    result = await LLMEngine(provider=provider, personas=Personas(), retrieval=retrieval).handle(
        value, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["responseKind"] == "small_talk"
    assert result["reply"]["content"] in VOICES["reentry_recap"]["casual"]
    assert result["reply"]["operatorTrace"]["path"] == "fixed"
    assert provider.messages == [] and retrieval.searches == []


async def test_reentry_with_consent_uses_prior_user_words_in_existing_opener():
    provider = Provider([response("지난번에 파란 책 얘기했지! 그 책은 어땠어?")])
    value = grant("다시 왔어", language="ko", ragCondition="caption")
    value["context"]["turn"]["sequence"] = 1
    value["context"]["userMemoryConsent"] = True
    value["context"]["previousSessionUserSaid"] = "파란 책을 읽었어"
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        value, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["responseKind"] == "small_talk"
    assert len(provider.messages) == 1
    assert any("previousSessionUserSaid" in message["content"] for message in provider.messages[0])


@pytest.mark.parametrize(("text", "level", "key"), [
    ("말 편하게 해 줘.", "casual", "speech_ack_casual"),
    ("존댓말 해 주세요.", "polite", "speech_ack_polite"),
    ("Please speak casually.", "casual", "speech_ack_casual"),
    ("Please speak politely.", "polite", "speech_ack_polite"),
])
async def test_speech_request_gets_fixed_ack_in_new_register(text, level, key):
    provider = Provider([])
    value = grant(text, language="ko" if text[0] != "P" else "en", ragCondition="caption")
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        value, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["reply"]["content"] in VOICES[key]["casual" if text[0] != "P" else "en"]
    assert result["reply"]["operatorTrace"]["code"] == "SPEECH_ACK"
    assert result["reply"]["content"] != text
    assert provider.messages == []


async def test_speech_ack_does_not_echo_request_as_model_once_did():
    provider = Provider([response("편하게 말해줘~!")])
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        grant("말 편하게 해 줘.", language="ko", ragCondition="caption"),
        before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["reply"]["content"] in VOICES["speech_ack_casual"]["casual"]
    assert result["reply"]["content"] != "편하게 말해줘~!"
    assert provider.messages == []


async def test_embedded_speech_request_adds_brief_ack_instruction():
    from ptr_llm.core.runtime import requested_speech_level, speech_request_only

    text = "오늘은 날씨가 좋네. 말 편하게 해 줘."
    assert requested_speech_level(text) == "casual"
    assert not speech_request_only(text)
    provider = Provider([response("좋아, 편하게 말할게~ 그 책 좋았어!")])
    await LLMEngine(provider=provider, personas=Personas()).handle(
        grant(text, language="ko", ragCondition="caption"),
        before_costly=noop, cancelled=asyncio.Event()
    )
    assert any("Acknowledge the register switch briefly" in message["content"]
               for message in provider.messages[0] if message["role"] == "system")


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
