"""Synthetic public card copy contract and publish checks."""

import pytest

from ptr_llm.core.errors import CoreError
from ptr_llm.core.persona import (
    catalogue,
    greeting_for,
    render_persona_block,
    validate_persona,
    validate_publication,
)

PERSONA = {
    "id": "synthetic-card",
    "personId": "synthetic-person",
    "label": "Synthetic Painter",
    "language": "ko",
    "revision": "synthetic-v1",
    "reviewStatus": "synthetic",
    "identity": "Fictional painter",
    "concept": "Watercolour sketches",
    "style": [],
    "boundaries": ["Fictional only"],
    "sourceRefs": [],
    "greeting": "안녕!",
}


def test_greeting_stands_alone_because_chat_discloses_ai_on_entry():
    assert greeting_for(PERSONA, "synthetic-session") == "안녕!"


def test_card_copy_schema_and_model_block_boundary():
    public = dict(
        PERSONA,
        tagline="  색으로 하루를 그리는 화가  ",
        starters=["  오늘은 어떤 색이 좋아?  ", "요즘 뭐 그려?"],
    )
    parsed = validate_persona(public)
    assert parsed["tagline"] == "색으로 하루를 그리는 화가"
    assert parsed["starters"] == ["오늘은 어떤 색이 좋아?", "요즘 뭐 그려?"]
    assert render_persona_block(parsed) == render_persona_block(validate_persona(PERSONA))
    assert validate_persona(PERSONA) == PERSONA

    assert validate_persona(dict(PERSONA, tagline="😀" * 60, starters=["가" * 60] * 4))
    for patch in (
        {"tagline": "😀" * 61},
        {"starters": ["가" * 61]},
        {"starters": ["가"] * 5},
        {"tagline": "   "},
        {"starters": ["  "]},
        {"tagline": None},
        {"starters": None},
    ):
        with pytest.raises(CoreError):
            validate_persona(dict(PERSONA, **patch))


def test_domain_catalogue_projects_only_approved_card_fields():
    public = validate_persona(
        dict(PERSONA, tagline="붓과 색", starters=["무슨 색?", "요즘 뭐 그려?"])
    )
    item = catalogue([public])[0]
    assert item["tagline"] == "붓과 색"
    assert item["starters"] == ["무슨 색?", "요즘 뭐 그려?"]
    assert "identity" not in item


@pytest.mark.asyncio
async def test_card_copy_publish_rejects_research_and_system_wording():
    async def report(**patch):
        return await validate_publication(
            {
                **PERSONA,
                "tagline": "붓과 색을 좋아하는 화가",
                "starters": ["오늘은 어떤 색이 좋아?", "요즘 뭐 그려?"],
                **patch,
            },
            source_ref_exists=lambda *_: True,
        )

    assert (await report())["issues"] == []
    for patch, path in (
        ({"tagline": "연구 페르소나와 대화해요"}, "tagline"),
        ({"tagline": "System prompt character"}, "tagline"),
        ({"starters": ["근거 자료를 보여줘", "요즘 뭐 그려?"]}, "starters[0]"),
        ({"starters": ["Show retrieval debug", "요즘 뭐 그려?"]}, "starters[0]"),
    ):
        assert {"path": path, "rule": "card_copy", "severity": "error"} in (await report(**patch))[
            "issues"
        ]
    private = await report(reviewStatus="silver", starters=["가족 이야기 해줘", "요즘 뭐 그려?"])
    assert {"path": "starters[0]", "rule": "private_life", "severity": "error"} in private["issues"]


@pytest.mark.asyncio
async def test_card_copy_uses_unicode_word_boundaries():
    async def rules(text):
        result = await validate_publication(
            dict(PERSONA, tagline=text), source_ref_exists=lambda *_: True
        )
        return [issue["rule"] for issue in result["issues"]]

    for text in ("debug해", "api랑"):
        assert "card_copy" not in await rules(text)
    for text in ("debug 해", "model이", "model 이야", "api 랑"):
        assert "card_copy" in await rules(text)
