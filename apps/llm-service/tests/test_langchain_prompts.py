"""Synthetic byte-parity contracts for native LangChain prompt assembly."""

import copy
import json
from pathlib import Path

import pytest
import regex

from ptr_llm.core.errors import CoreError
from ptr_llm.core.persona import dumps, render_persona_block, serialized_bytes
from ptr_llm.core.prompts import (
    EXPERIMENT_PROMPT_BYTE_LIMIT,
    POLICY,
    build_experiment_context,
    build_prompt,
    short_unique_quote,
    utf16_prefix,
)

PERSONA = {
    "id": "synthetic-persona",
    "revision": "synthetic-revision",
    "reviewStatus": "synthetic",
    "language": "ko",
    "identity": "가상 인물 {identity} {{literal}} 😁",
    "concept": "합성 예시만 사용",
    "style": ["{policy}는 문자"],
    "boundaries": ["사실로 인용하지 않음"],
    "exampleDialogues": [{"turns": [{"speaker": "user", "text": "{injection}"}]}],
}
HISTORY = [
    {"role": "user", "content": '{"query":"{history}"} 한글 😁', "ignored": "metadata"},
    {"role": "assistant", "content": "{{literal}} {policy!r} {missing}"},
]
TEXT = '{text.__class__} {text!r:>10} {{}} {% raw %} 한글 😁\n"quoted"'


def test_c2_all_active_policies_limit_emoji_and_markdown():
    line = "Use emoji only when it fits the persona style. Do not use lists or Markdown."
    assert line in POLICY["REPLY_VOICE_POLICY"]
    assert line in POLICY["EXPERIMENT_POLICY"]


def source(index, caption=None, annotations=()):
    return {
        "id": f"synthetic-source-{index}",
        "personId": "synthetic-person",
        "caption": caption or '{"caption":"{policy}"} 한글 😁. Next sentence!',
        "postedAt": "2026-10-01T00:00:00+00:00",
        "eventDate": None,
        "imageAnnotations": list(annotations),
    }


def annotation(index, text):
    return {"id": f"synthetic-image-{index}", "text": text}


def reference_experiment_messages(
    context, *, history=HISTORY, text=TEXT, policy=None, note=None, after_history=(), after_user=()
):
    """Independent pre-migration wire contract, not a LangChain serialization."""
    cards = []
    for item in context["sources"]:
        card = {
            "sourceId": item["id"],
            "personId": item["personId"],
            "caption": item["caption"],
            "postedAt": item["postedAt"],
            "eventDate": item["eventDate"],
            "quoteCandidate": short_unique_quote(item["caption"]),
        }
        if "imageAnnotations" in item:
            card["annotationOmittedCount"] = item.get("_omitted", 0)
            card["imageAnnotations"] = []
            for image in item["imageAnnotations"]:
                visual = regex.search(r"(?:^|\n)Visual description: ([^\n]+)", image["text"])
                card["imageAnnotations"].append(
                    {
                        "annotationId": image["id"],
                        "text": image["text"],
                        "quoteCandidate": short_unique_quote(
                            image["text"], visual[1] if visual else image["text"]
                        ),
                        "humanReviewed": False,
                        "origin": "ai_image_annotation",
                    }
                )
        cards.append(card)
    return (
        [{"role": "system", "content": policy or POLICY["EXPERIMENT_POLICY"]}]
        + render_persona_block(PERSONA)
        + [{"role": row["role"], "content": row["content"]} for row in history]
        + list(after_history)
        + [{"role": "user", "content": "UNTRUSTED_EVIDENCE_JSON_DATA " + dumps(cards)}]
        + ([{"role": "system", "content": note}] if note else [])
        + [{"role": "user", "content": text}]
        + list(after_user)
    )


@pytest.mark.parametrize("note", [None, "", "{policy} {{literal}} 한글 😁"])
@pytest.mark.parametrize("policy", [None, "", "Policy {missing} {{literal}}"])
@pytest.mark.parametrize("extensions", [False, True])
def test_experiment_complete_message_byte_parity(note, policy, extensions):
    after_history = [{"role": "system", "content": "STATE {state}"}] if extensions else []
    after_user = (
        [
            {"role": "assistant", "content": '{"function":"{function}"}'},
            {"role": "user", "content": "TOOLS {tool} 😁"},
        ]
        if extensions
        else []
    )
    sources = [
        source(1, annotations=[annotation(1, "Visual description: {visual} 😁\nJSON {data}")]),
        source(2),
    ]
    original = copy.deepcopy((PERSONA, HISTORY, sources, after_history, after_user))
    actual = build_experiment_context(
        PERSONA,
        HISTORY,
        TEXT,
        sources,
        policy=policy,
        policy_note=note,
        after_history=after_history,
        after_user=after_user,
    )
    expected = reference_experiment_messages(
        actual, policy=policy, note=note, after_history=after_history, after_user=after_user
    )
    assert dumps(actual["messages"]).encode() == dumps(expected).encode()
    assert actual["sources"] == sources
    assert actual["omittedAnnotations"] == 0
    assert actual["omittedSourceIds"] == []
    assert (PERSONA, HISTORY, sources, after_history, after_user) == original


@pytest.mark.parametrize("timeline", [False, True])
@pytest.mark.parametrize("note", [None, "", "Note {missing} 한글 😁"])
def test_legacy_complete_message_byte_parity(timeline, note):
    from ptr_llm.core import prompts

    policy = json.loads(Path(prompts.__file__).with_name("legacy_prompt_policy.json").read_text())
    definition = {
        key: PERSONA[key]
        for key in (
            "id",
            "revision",
            "reviewStatus",
            "language",
            "identity",
            "concept",
            "style",
            "boundaries",
        )
    }
    sources = [source(1), source(2, "First line {missing} 😁\nSecond line.")]
    expected = [
        {
            "role": "system",
            "content": policy["base"] + policy["timeline" if timeline else "smallTalk"],
        },
        {
            "role": "system",
            "content": "Persona definition (subordinate to policy): " + dumps(definition),
        },
    ] + [{"role": item["role"], "content": item["content"]} for item in HISTORY]
    if timeline:
        cards = []
        for item in sources:
            sentence = regex.search(r"^[\s\S]*?[.!?。！？](?=\s|$)|^[^\n]*\n", item["caption"])
            cards.append(
                {
                    "sourceId": item["id"],
                    "personId": item["personId"],
                    "caption": item["caption"],
                    "postedAt": item["postedAt"],
                    "eventDate": item["eventDate"],
                    "quoteCandidate": utf16_prefix(
                        sentence[0] if sentence else item["caption"], 160
                    ),
                }
            )
        expected.append({"role": "user", "content": "UNTRUSTED_EVIDENCE_JSON_DATA " + dumps(cards)})
    if note:
        expected.append({"role": "system", "content": note})
    expected.append({"role": "user", "content": TEXT})
    assert (
        dumps(build_prompt(PERSONA, HISTORY, TEXT, sources, timeline, note)).encode()
        == dumps(expected).encode()
    )


def test_whole_post_budget_order_deduplication_and_image_round_robin():
    sources = [
        source("oversize", "X" * 31000),
        source(1, annotations=[annotation("1a", "A" * 10000), annotation("1b", "B" * 10000)]),
        source(1, "Duplicate must not replace first"),
        source(2, annotations=[annotation("2a", "C" * 10000), annotation("2b", "D" * 10000)]),
        source(3),
        source(4),
    ]
    actual = build_experiment_context(PERSONA, HISTORY, TEXT, sources)
    assert [item["id"] for item in actual["sources"]] == [
        f"synthetic-source-{i}" for i in (1, 2, 3)
    ]
    assert [[image["id"] for image in item["imageAnnotations"]] for item in actual["sources"]] == [
        ["synthetic-image-1a"],
        ["synthetic-image-2a"],
        [],
    ]
    assert actual["omittedAnnotations"] == 2
    assert actual["omittedSourceIds"] == ["synthetic-source-oversize", "synthetic-source-4"]
    assert serialized_bytes(actual["messages"]) <= EXPERIMENT_PROMPT_BYTE_LIMIT
    reference = copy.deepcopy(actual)
    reference["sources"][0]["_omitted"] = 1
    reference["sources"][1]["_omitted"] = 1
    assert (
        dumps(actual["messages"]).encode()
        == dumps(reference_experiment_messages(reference)).encode()
    )


@pytest.mark.parametrize("limit", [1, 3, 20])
def test_maximum_sources_is_preserved(limit):
    actual = build_experiment_context(
        PERSONA, [], "short", [source(i) for i in range(21)], max_sources=limit
    )
    assert len(actual["sources"]) == limit
    assert len(actual["omittedSourceIds"]) == 21 - limit


@pytest.mark.parametrize("limit", [False, 0, 21, 1.0])
def test_invalid_source_limit_is_rejected(limit):
    with pytest.raises(CoreError, match="INVALID_INPUT"):
        build_experiment_context(PERSONA, [], "short", [], max_sources=limit)


def test_base_context_limit_is_rejected_before_including_sources():
    with pytest.raises(CoreError, match="CONTEXT_LIMIT"):
        build_experiment_context(PERSONA, HISTORY, "한" * 10000, [])


def test_extension_message_roles_fields_and_wire_key_order_remain_opaque():
    after_history = [{"label": "{literal}", "role": "system", "content": "", "extra": {"x": 1}}]
    after_user = [{"role": "tool", "content": "{literal}", "tool_call_id": "synthetic-call"}]
    actual = build_experiment_context(
        PERSONA, [], "", [], after_history=after_history, after_user=after_user
    )
    expected = reference_experiment_messages(
        actual, history=[], text="", after_history=after_history, after_user=after_user
    )
    assert dumps(actual["messages"]).encode() == dumps(expected).encode()


def test_exact_utf8_wire_byte_boundary():
    base = build_experiment_context(PERSONA, [], "", [], policy="Synthetic policy")
    room = EXPERIMENT_PROMPT_BYTE_LIMIT - serialized_bytes(base["messages"])
    accepted = build_experiment_context(PERSONA, [], "x" * room, [], policy="Synthetic policy")
    assert serialized_bytes(accepted["messages"]) == EXPERIMENT_PROMPT_BYTE_LIMIT
    with pytest.raises(CoreError, match="CONTEXT_LIMIT"):
        build_experiment_context(PERSONA, [], "x" * (room + 1), [], policy="Synthetic policy")


def test_native_cached_template_formats_only_final_budgeted_context(monkeypatch):
    from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

    formats = []
    placeholders = []
    original_format = ChatPromptTemplate.format_messages
    original_placeholder = MessagesPlaceholder.format_messages

    def format_messages(self, **values):
        formats.append(self)
        return original_format(self, **values)

    def placeholder_messages(self, **values):
        placeholders.append(self.variable_name)
        return original_placeholder(self, **values)

    def no_rebuild(*_args, **_kwargs):
        pytest.fail("Cached templates must not rebuild during prompt construction")

    monkeypatch.setattr(ChatPromptTemplate, "format_messages", format_messages)
    monkeypatch.setattr(ChatPromptTemplate, "from_messages", no_rebuild)
    monkeypatch.setattr(MessagesPlaceholder, "format_messages", placeholder_messages)
    sources = [source(i, annotations=[annotation(i, "image" * 2000)]) for i in range(20)]
    build_experiment_context(PERSONA, HISTORY, TEXT, sources, max_sources=20)
    assert len(formats) == 1
    assert placeholders == ["persona", "history", "after_history", "notes", "after_user"]
    build_prompt(PERSONA, HISTORY, TEXT, sources, True)
    assert len(formats) == 2
    assert formats[0] is formats[1]
    build_prompt(PERSONA, HISTORY, TEXT, [], False)
    assert len(formats) == 3
    assert formats[0] is not formats[-1]
    with pytest.raises(CoreError, match="CONTEXT_LIMIT"):
        build_experiment_context(PERSONA, HISTORY, "한" * 10000, [])
    assert len(formats) == 3
