"""Synthetic fixed-copy and conservative guard regressions for C3."""

import pytest
from test_persona_card_copy import PERSONA

from ptr_llm.core.persona import validate_publication
from ptr_llm.core.policy import VOICES, reply_decision


@pytest.mark.parametrize("key", ["ambiguous_reference", "event_timezone"])
def test_fixed_clarification_has_no_search_wording(key):
    forbidden = ("게시물", "글이나", "올린", "시간대", "posting", "post or", "time zone")
    for variants in VOICES[key].values():
        for text in variants:
            assert not any(word in text.casefold() for word in forbidden)


@pytest.mark.parametrize("reply", ["아파", "I got sick.", "I was ill.", "I have been sick."])
def test_health_forms_cannot_disclose_private_fact(reply):
    decision = reply_decision(reply, {"utterance": "안녕", "realPerson": True, "language": "ko"})
    assert decision and decision["reason"] == "private_life"


def test_orphan_connective_with_punctuation_is_removed():
    decision = reply_decision(
        "남친 있어. 해서! 축하해", {"utterance": "안녕", "realPerson": True, "language": "ko"}
    )
    assert decision and decision["content"] == "축하해"


def test_private_clause_does_not_discard_separate_user_care():
    decision = reply_decision(
        "요즘 아파서 조심하고 있어. 너도 조심해",
        {"utterance": "안녕", "realPerson": True, "language": "ko"},
    )
    assert decision and decision["content"] == "너도 조심해"


def test_split_private_keyword_leaves_no_predicate_fragment():
    decision = reply_decision(
        "결혼\n했어", {"utterance": "안녕", "realPerson": True, "language": "ko"}
    )
    assert decision and decision["reason"] == "private_life"
    assert "했어" not in decision["content"]
    assert decision["content"] in VOICES["neutral_redirect"]["polite"]


@pytest.mark.asyncio
@pytest.mark.parametrize("text", ["게시물 이야기", "캡션 같이 읽자", "자료 확인", "model이 답했어"])
async def test_card_copy_does_not_expose_search_wording(text):
    report = await validate_publication(
        dict(PERSONA, tagline=text), source_ref_exists=lambda *_: True
    )
    assert {"path": "tagline", "rule": "card_copy", "severity": "error"} in report["issues"]
