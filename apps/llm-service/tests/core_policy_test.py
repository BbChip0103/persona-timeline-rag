"""Synthetic policy goldens pin the service and standalone guards."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[3]
FIXTURES = json.loads((ROOT / "apps/guardrails/tests/policy_fixtures.json").read_text())


@pytest.mark.parametrize("fixture", FIXTURES)
def test_frozen_reply_policy(fixture):
    from ptr_llm.core.guardrails import validate_output

    source = fixture["input"]
    assert validate_output(source["reply"], source) == (
        fixture["expected"] or {"content": source["reply"]}
    )


def test_python_policy_copies_match_on_every_shared_fixture():
    from ptr_llm.core.policy import VOICES, reply_decision

    path = ROOT / "apps/guardrails/policy.py"
    spec = importlib.util.spec_from_file_location("standalone_guard_policy", path)
    assert spec is not None and spec.loader is not None
    standalone = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(standalone)
    assert standalone.VOICES == VOICES
    for fixture in FIXTURES:
        source = fixture["input"]
        assert standalone.reply_decision(source["reply"], source) == reply_decision(
            source["reply"], source
        )


def test_private_noun_sources_are_the_private_keyword_union():
    from ptr_llm.core.policy import (
        _ADDITIONAL_PRIVATE,
        _BARE_PRIVATE,
        _PRIVATE_NOUNS,
        PATTERNS,
    )

    assert _PRIVATE_NOUNS == (
        _BARE_PRIVATE,
        _ADDITIONAL_PRIVATE,
        *PATTERNS["PRIVATE_REPLY"],
    )


@pytest.mark.parametrize(
    ("utterance", "reply"),
    [
        ("나 결혼해", "결혼식장 축하해"),
        ("나 결혼해", "결혼 축하해"),
    ],
)
def test_own_story_noun_echo_respects_korean_token_boundary(utterance, reply):
    from ptr_llm.core.policy import _private_noun_mentions, reply_decision

    assert ("결혼" in _private_noun_mentions(reply)) is (reply == "결혼 축하해")
    decision = reply_decision(
        reply, {"utterance": utterance, "realPerson": True, "language": "ko"}
    )
    assert decision is None


@pytest.mark.parametrize(
    "reply",
    [
        "엄마가 예뻤던 거 생각나서 속상하겠다",
        "엄마가 아팠던 것처럼 속상하겠다",
        "엄마가 걱정됐었던 것처럼 속상하겠다",
        "엄마가 좋았던 거 생각나서 속상하겠다",
        "엄마가 그랬던 거 생각나서 속상하겠다",
    ],
)
def test_own_story_experience_markers_are_blocked(reply):
    from ptr_llm.core.policy import reply_decision

    decision = reply_decision(
        reply, {"utterance": "나 엄마랑 싸웠어", "realPerson": True, "language": "ko"}
    )
    assert decision is not None and decision["reason"] == "private_life"


def test_head_policy_matrix_has_no_reply_disclosure_regression():
    """Compare the frozen pre-C1 head with the pre-§18 synthetic fixture set."""
    from ptr_llm.core.policy import reply_decision

    matrix = json.loads(Path(__file__).with_name("head_b008a3c_policy_matrix.json").read_text())
    digest = hashlib.sha256(
        json.dumps(
            [fixture["input"] for fixture in FIXTURES[:370]],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    assert matrix["head"] == "b008a3c"
    assert matrix["fixtureInputSha256"] == digest
    post370_digest = hashlib.sha256(
        json.dumps(
            [fixture["input"] for fixture in FIXTURES[370:446]],
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode()
    ).hexdigest()
    assert matrix["post370FixtureInputSha256"] == post370_digest
    assert len(matrix["priorBlockedGoldenIndices"]) == 195
    assert all(
        FIXTURES[index]["expected"] is not None for index in matrix["priorBlockedGoldenIndices"]
    )
    allowed = {
        index
        for index, fixture in enumerate(FIXTURES[:446])
        if reply_decision(fixture["input"]["reply"], fixture["input"]) is None
    }
    old_blocked = set(matrix["blockedIndices"] + matrix["post370BlockedIndices"])
    old_blocked_new_allowed = allowed.intersection(old_blocked)
    # These baseline private-keyword rows are user-directed wishes, not persona disclosures.
    safe_empathy_allowances = {330, 331, 332, 342}
    from ptr_llm.core.policy import _allowed_own_story_clause, _user_owns_private_statement

    assert all(
        _user_owns_private_statement(FIXTURES[index]["input"]["utterance"])
        and _allowed_own_story_clause(
            FIXTURES[index]["input"]["reply"], FIXTURES[index]["input"]["utterance"]
        )
        for index in safe_empathy_allowances
    )
    reply_regressions = (
        allowed.intersection(matrix["replyPrivateIndices"]) - safe_empathy_allowances
    )
    intended_own_story_allowances = {315, 316, 317, 330, 331, 332, 333, 342, 435, 437}
    old_allowed_new_blocked = set(range(446)) - old_blocked - allowed
    unsafe_disclosures = {
        index
        for index, fixture in enumerate(FIXTURES)
        if fixture["expected"] is not None
        and fixture["expected"]["reason"] == "private_life"
        and reply_decision(fixture["input"]["reply"], fixture["input"]) is None
    }
    print(
        f"C1_MATRIX: intended_own_story_allowances={len(old_blocked_new_allowed)} "
        f"ids={sorted(old_blocked_new_allowed)}; unsafe_disclosures={len(unsafe_disclosures)}; "
        f"old_allowed_new_blocked={len(old_allowed_new_blocked)} "
        f"ids={sorted(old_allowed_new_blocked)}"
    )
    assert len(reply_regressions) == 0
    assert not unsafe_disclosures
    assert old_blocked_new_allowed == intended_own_story_allowances


def test_post_matrix_fixtures_have_explicit_expectations():
    """The recorded head matrix covers only the first 370 synthetic cases."""
    assert len(FIXTURES) > 370
    assert all("expected" in fixture for fixture in FIXTURES[370:])


@pytest.mark.parametrize(
    ("utterance", "reply", "language", "expected"),
    [
        ("나 결혼해", "축하해! 그때 식장 예뻤어", "ko", "축하해!"),
        ("I fought with my mom", "Me too, yesterday.", "en", None),
        ("I fought with my mom", "Same here, ugh.", "en", None),
        ("I fought with my mom", "Same thing happened to me.", "en", None),
        ("I fought with my mom", "I hope this helps me", "en", None),
        ("I fought with my mom", "I hope ours works too", "en", None),
        ("I fought with my mom", "I hope they forgive us", "en", None),
        ("my mom is ill", "I hope your mom feels better", "en", "pass"),
        ("my mom is ill", "I'm sorry your mom is ill", "en", "pass"),
        ("나 결혼해", "축하해! 그때도 축하해 친구", "ko", "축하해!"),
    ],
)
def test_section16_own_story_allowlist(utterance, reply, language, expected):
    from ptr_llm.core.policy import VOICES, reply_decision

    decision = reply_decision(
        reply, {"utterance": utterance, "realPerson": True, "language": language}
    )
    if expected == "pass":
        assert decision is None
    elif expected is None:
        assert decision is not None and decision["reason"] == "private_life"
        assert decision["content"] in VOICES["empathy_ask"]["en"]
    else:
        assert decision == {"reason": "private_life", "content": expected, "edited": True}


@pytest.mark.parametrize(
    "utterance",
    [
        "아기 언제 낳았어?", "낳았어?", "너 파트너 있어?", "출산했어?",
        "신혼이야?", "Do you have a baby?", "partner?",
    ],
)
def test_section16_private_question_keywords(utterance):
    from ptr_llm.core.policy import reply_decision

    decision = reply_decision(
        "글쎄~", {"utterance": utterance, "realPerson": True, "language": "ko"}
    )
    assert decision is not None and decision["reason"] == "private_life"


def test_section17_goldens_keep_user_questions_and_remove_disclosures():
    from ptr_llm.core.policy import VOICES, reply_decision

    blocked = FIXTURES[424:435]
    allowed = FIXTURES[435:438]
    assert [row["input"]["reply"] for row in blocked] == [
        "나처럼 작년에 결혼한 거야?", "저처럼 봄에 하는 거예요?",
        "결혼 선배로서 축하해", "유부녀로서 축하해",
        "작년에 결혼한 입장에서 진심으로 축하해", "남편이랑 같이 축하해",
        "남편한테도 알려줄까?", "이혼 겪어본 사람으로서 속상하겠다",
        "작년에 헤어져 봐서 속상하겠다", "울 엄마도 그래서 속상하겠다",
        "Congrats from one newlywed to another!",
    ]
    assert [row["input"]["reply"] for row in allowed] == [
        "결혼식 언제야?", "신혼여행은 어디로 가?", "엄마랑 잘 풀렸으면 좋겠다",
    ]
    for row in blocked:
        source = row["input"]
        decision = reply_decision(source["reply"], source)
        assert decision is not None and decision["reason"] == "private_life"
        assert decision["content"] in VOICES["empathy_ask"][
            "en" if source["language"] == "en" else "polite"
        ]
    assert all(reply_decision(row["input"]["reply"], row["input"]) is None for row in allowed)


@pytest.mark.parametrize(
    "text",
    [
        "결혼", "남친", "여친", "남자친구", "여자친구", "연애", "이혼", "임신",
        "가족", "엄마", "아빠", "병원", "입원", "아프", "아팠", "사귀", "헤어",
        "boyfriend", "girlfriend", "married", "marriage", "divorce", "pregnant",
        "dating", "hospital", "hospitalized", "my mom", "my dad", "my family",
    ],
)
def test_section14_bare_private_vocabulary(text):
    from ptr_llm.core.policy import _BARE_PRIVATE

    assert _BARE_PRIVATE.search(text)


@pytest.mark.parametrize(
    "text",
    [
        "친구처럼", "건강한 피부", "home studio", "mother tongue", "친구", "건강",
        "health", "home", "mother",
    ],
)
def test_section14_excluded_bare_vocabulary(text):
    from ptr_llm.core.policy import _BARE_PRIVATE

    assert not _BARE_PRIVATE.search(text)


def test_inline_import_does_not_disable_application_tracing():
    before = {key: os.environ.get(key) for key in ("HOME", "OTEL_SDK_DISABLED")}
    from ptr_llm.core.guardrails import validate_input

    assert validate_input("hello", {"classification": "rules-only"}) == {
        "action": "none",
        "fired": [],
    }
    assert before == {key: os.environ.get(key) for key in before}


def test_inline_guard_never_opens_network_and_drops_request_history(monkeypatch):
    import socket

    from ptr_llm.core.guardrails import _get_guard, validate_output

    def forbidden(*args, **kwargs):
        raise AssertionError("network forbidden")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    assert (
        validate_output(
            "I am a real person.", {"utterance": "hello", "realPerson": True, "language": "en"}
        )["reason"]
        == "human_impersonation"
    )
    assert len(_get_guard("output").history) == 0


def test_security_patterns_keep_js_boundary_and_unicode_whitespace():
    from ptr_llm.core.safety import contains_credential, contains_internal_path

    assert contains_credential("한글sk-syntheticsecret")
    assert contains_credential("Bearer\u00a0syntheticsecret")
    assert contains_internal_path("한글C:\\Users\\synthetic")


@pytest.mark.parametrize(
    ("utterance", "self_story"),
    [
        ("나는 우리 엄마랑 싸웠어", True),
        ("나도 가족이 있어", True),
        ("난 결혼 얘기가 부담스러워", True),
        ("내가 병원 다녀왔어", True),
        ("내 가족 얘기야", True),
        ("나의 오빠는 그림을 그려", True),
        ("제가 오늘 병원에 갔어요", True),
        ("저는 부모님과 살아요", True),
        ("저도 남친 얘기를 하고 싶어요", True),
        ("제 엄마 이야기예요", True),
        ("저희 가족 이야기예요", True),
        ("오늘 병원 다녀왔어 내가", True),
        ("나 어제 친구랑 여행 갔어", True),
        ("my family is visiting", True),
        ("our parents are visiting", True),
        ("I visited my family", True),
        ("we visited the hospital", True),
        ("우리 엄마랑 싸웠어", False),
        ("우리 오빠 결혼했어?", False),
        ("가족 있어?", False),
        ("제주도 가족 있어?", False),
        ("내일 결혼했어?", False),
        ("나중에 결혼했어?", False),
        ("나왔어? 결혼했어?", False),
        ("저 사람 가족 있어?", False),
    ],
)
def test_token_bounded_user_self_markers(utterance, self_story):
    from ptr_llm.core.policy import has_user_self_marker

    assert has_user_self_marker(utterance) is self_story


@pytest.mark.parametrize(
    ("utterance", "reply", "expected_reason", "expected_text"),
    [
        ("우리 엄마랑 싸웠어", "엄마랑 잘 풀렸으면 좋겠다", None, None),
        ("오늘 병원 다녀왔어 내가", "병원 다녀오느라 힘들었겠다", None, None),
        ("나도 친구랑 싸웠어", "친구랑 잘 풀렸으면 좋겠다", None, None),
        ("내 가족 이야기야", "너도 마음이 복잡했겠다", None, None),
        ("결혼 얘기가 힘들어", "응, 작년에 결혼했어~", "private_life", None),
        ("우리 엄마랑 싸웠어", "우리 엄마도 그랬어~", "private_life", None),
        ("결혼 얘기가 힘들어", "너도 알잖아, 나 작년에 결혼했어", "private_life", None),
        ("나도 친구랑 싸웠어", "내 친구랑도 싸웠어~", "private_life", None),
        (
            "우리 엄마랑 싸웠어",
            "엄마랑 잘 풀렸으면 좋겠다. 나는 작년에 결혼했어.",
            "private_life",
            None,
        ),
        ("우리 엄마랑 싸웠어", "우리 엄마도 그랬어~ 너는 괜찮아?", "private_life", "너는 괜찮아?"),
        (
            "그때 얘기 더 해줘",
            "작년에 결혼했어. 그림은 요즘도 좋아해.",
            "private_life",
            "그림은 요즘도 좋아해.",
        ),
        (
            "그때 얘기 더 해줘",
            "병원에 다녀왔어. 도자기 얘기하자.",
            "private_life",
            "도자기 얘기하자.",
        ),
        ("나의 엄마 얘기야", "엄마가 걱정됐겠다", None, None),
        ("저희 가족 얘기예요", "가족과 함께한 시간이 소중했겠어요", "private_life", None),
        ("my mom is ill", "I hope your mom feels better", None, None),
        ("my husband is ill", "Your husband must be tired", "private_life", None),
    ],
)
def test_private_reply_sentence_policy(utterance, reply, expected_reason, expected_text):
    from ptr_llm.core.policy import reply_decision

    decision = reply_decision(reply, {"utterance": utterance, "realPerson": True, "language": "ko"})
    if expected_reason is None:
        assert decision is None
    else:
        assert decision is not None and decision["reason"] == expected_reason
        if expected_text is not None:
            assert decision["content"] == expected_text and decision["edited"] is True


def test_private_question_is_scoped_to_its_own_sentence():
    from ptr_llm.core.policy import reply_decision

    decision = reply_decision(
        "글쎄",
        {"utterance": "내 가족 얘기야. 가족 있어?", "realPerson": True, "language": "ko"},
    )
    assert decision is not None and decision["reason"] == "private_life"


def own_story_decline_rate():
    """Measure erroneous private declines after an own-story turn was fully trimmed."""
    from ptr_llm.core.policy import reply_decision

    stories = [
        ("우리 엄마랑 싸웠어", "엄마랑 잘 풀렸으면 좋겠다"),
        ("오늘 병원 다녀왔어 내가", "병원 다녀오느라 힘들었겠다"),
        ("나도 친구랑 싸웠어", "친구랑 잘 풀렸으면 좋겠다"),
        ("내 가족 이야기야", "가족도 마음이 복잡했겠다"),
        ("나의 엄마 얘기야", "엄마가 걱정됐겠다"),
        ("저희 가족 얘기예요", "가족과 함께한 시간이 소중했겠어요"),
        ("my mom is ill", "I hope the hospital visit went okay"),
        ("my husband is ill", "Your husband must be tired"),
        ("나 엄마랑 싸웠어", "나도 어제 그랬어 ㅠ"),
        ("나 결혼해", "나도 작년에 했어!"),
    ]
    declined = 0
    for utterance, reply in stories:
        decision = reply_decision(
            reply, {"utterance": utterance, "realPerson": True, "language": "ko"}
        )
        from ptr_llm.core.policy import VOICES

        if decision is not None:
            assert decision["reason"] == "private_life"
            declined += decision["content"] in VOICES["decline_private"]["polite"]
            assert decision["content"] in VOICES["empathy_ask"]["polite"]
    return declined, len(stories), declined / len(stories)


def test_own_story_decline_rate_is_reported():
    declined, total, rate = own_story_decline_rate()
    print(f"OVER_BLOCKING_RATE: {declined}/{total} = {rate:.4f}")
    assert declined == 0


def test_guard_replacement_avoids_previous_assistant_text():
    from ptr_llm.core.policy import reply_decision, voice

    first = voice("decline_private", "ko", "polite")
    metadata = {
        "utterance": "가족 있어?",
        "realPerson": True,
        "language": "ko",
        "previousAssistantText": first,
    }
    decision = reply_decision("글쎄", metadata)
    assert decision is not None
    assert decision["content"] != first
    assert decision["content"] == voice("decline_private", "ko", "polite", first)
    assert voice("decline_private", "ko", "polite", first, "turn-42") == voice(
        "decline_private", "ko", "polite", first, "turn-42"
    )


def test_empathy_replacement_avoids_previous_assistant_text():
    from ptr_llm.core.policy import reply_decision, voice

    first = voice("empathy_ask", "ko", "casual")
    metadata = {
        "utterance": "나 결혼해",
        "realPerson": True,
        "language": "ko",
        "level": "casual",
        "previousAssistantText": first,
        "turnId": "turn-14",
    }
    decision = reply_decision("축하해 결혼했어 작년에", metadata)
    assert decision is not None
    assert decision["content"] == voice("empathy_ask", "ko", "casual", first, "turn-14")
    assert decision["content"] != first


def test_private_reply_replacement_uses_private_decline_not_unknown_fallback():
    from ptr_llm.core.policy import reply_decision, voice

    decision = reply_decision(
        "응, 작년에 결혼했어~",
        {"utterance": "그때 이야기해줘", "realPerson": True, "language": "ko"},
    )
    assert decision == {
        "reason": "private_life",
        "content": voice("decline_private", "ko", "polite"),
    }


@pytest.mark.parametrize(
    ("utterance", "reply", "reason"),
    [
        ("학교는?", "그건 내가 가진 정보가 없네요.", "meta_talk"),
        ("안녕", "나 진짜 사람이야!", "human_impersonation"),
        ("안녕", "I don't actually have a past.", "background_denial"),
    ],
)
def test_guard_failures_use_service_retry_not_unknown_fallback(utterance, reply, reason):
    from ptr_llm.core.policy import reply_decision, voice

    assert reply_decision(
        reply, {"utterance": utterance, "realPerson": True, "language": "ko"}
    ) == {"reason": reason, "content": voice("service_retry", "ko", "polite")}
