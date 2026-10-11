"""Exact policy bytes and relevance-ordered whole-source prompt budgeting."""

import copy
import json
from pathlib import Path

import regex
from langchain_core.messages import ChatMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder

from ..prompt_management import current_prompt_snapshot, mark_prompt_applied
from .errors import CoreError
from .persona import dumps, render_persona_block, serialized_bytes

POLICY = json.loads(Path(__file__).with_name("prompt_policy.json").read_text())
EXPERIMENT_PROMPT_BYTE_LIMIT = 30000
EVIDENCE_POST_LIMIT = 3


def _prompt_template(with_evidence):
    return ChatPromptTemplate.from_messages(
        [("system", "{policy}")]
        + [MessagesPlaceholder(name) for name in ("persona", "history", "after_history")]
        + ([("user", "UNTRUSTED_EVIDENCE_JSON_DATA {evidence_json}")] if with_evidence else [])
        + [MessagesPlaceholder("notes"), ("user", "{text}"), MessagesPlaceholder("after_user")]
    )


# Reuse layouts; policy, JSON, and untrusted text are values, never template source.
_EVIDENCE_PROMPT = _prompt_template(True)
_CHAT_PROMPT = _prompt_template(False)


def _format_messages(policy, persona, history, text, evidence_json=None, **extensions):
    originals = {}
    blocks: dict[str, list[ChatMessage]] = {}
    for name, rows in dict(
        persona=persona,
        history=history,
        after_history=extensions.get("after_history", ()),
        notes=extensions.get("notes", ()),
        after_user=extensions.get("after_user", ()),
    ).items():
        blocks[name] = []
        for row in rows:
            message = ChatMessage(role=row["role"], content=row["content"])
            blocks[name].append(message)
            originals[id(message)] = row
    template = _EVIDENCE_PROMPT if evidence_json is not None else _CHAT_PROMPT
    formatted = template.format_messages(
        policy=policy, text=text, evidence_json=evidence_json, **blocks
    )
    mark_prompt_applied(policy)
    # Placeholder messages remain opaque wire values: retain roles, key order and
    # extension fields instead of exporting SDK defaults/metadata to providers.
    return [
        originals[id(message)]
        if id(message) in originals
        else {"role": "user" if message.type == "human" else "system", "content": message.content}
        for message in formatted
    ]


def utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


def utf16_prefix(text, limit):
    used = 0
    out = []
    for char in text:
        units = 2 if ord(char) > 65535 else 1
        if used + units > limit:
            break
        used += units
        out.append(char)
    return "".join(out)


def short_unique_quote(text, preferred=None):
    quote = utf16_prefix(text if preferred is None else preferred, 96)
    start = text.find(quote)
    return quote if quote and start >= 0 and text.find(quote, start + 1) < 0 else ""


def image_quote_candidate(annotation):
    visual = regex.search(r"(?:^|\n)Visual description: ([^\n]+)", annotation["text"])
    return short_unique_quote(annotation["text"], visual[1] if visual else annotation["text"])


def build_experiment_context(
    persona,
    history,
    text,
    sources,
    *,
    policy=None,
    policy_note=None,
    after_history=(),
    after_user=(),
    max_sources=EVIDENCE_POST_LIMIT,
):
    if type(max_sources) is not int or not 1 <= max_sources <= 20:
        raise CoreError("INVALID_INPUT")
    unique = []
    seen = set()
    for source in sources:
        if source["id"] not in seen:
            unique.append(copy.deepcopy(source))
            seen.add(source["id"])
    kept: list[dict] = []
    included: list[list[dict]] = []
    policy_text = policy or current_prompt_snapshot().experiment["EXPERIMENT_POLICY"]
    persona_messages = render_persona_block(persona)
    history_messages = [{"role": m["role"], "content": m["content"]} for m in history]
    notes = [{"role": "system", "content": policy_note}] if policy_note else []

    def render(*, final=False):
        cards = []
        for index, s in enumerate(kept):
            item = {
                "sourceId": s["id"],
                "personId": s["personId"],
                "caption": s["caption"],
                "postedAt": s["postedAt"],
                "eventDate": s["eventDate"],
                "quoteCandidate": short_unique_quote(s["caption"]),
            }
            if "imageAnnotations" in s:
                item["annotationOmittedCount"] = len(s["imageAnnotations"]) - len(included[index])
                item["imageAnnotations"] = []
                for a in included[index]:
                    item["imageAnnotations"].append(
                        {
                            "annotationId": a["id"],
                            "text": a["text"],
                            "quoteCandidate": image_quote_candidate(a),
                            "humanReviewed": False,
                            "origin": "ai_image_annotation",
                        }
                    )
            cards.append(item)
        evidence_json = dumps(cards)
        if final:
            return _format_messages(
                policy_text,
                persona_messages,
                history_messages,
                text,
                evidence_json,
                notes=notes,
                after_history=after_history,
                after_user=after_user,
            )
        # The byte-budget loop stays wire-native; do not pay SDK conversion for
        # every trial source/image. Format the accepted final context only once.
        return (
            [{"role": "system", "content": policy_text}]
            + persona_messages
            + history_messages
            + list(after_history)
            + [{"role": "user", "content": "UNTRUSTED_EVIDENCE_JSON_DATA " + evidence_json}]
            + notes
            + [{"role": "user", "content": text}]
            + list(after_user)
        )

    def fits():
        return serialized_bytes(render()) <= EXPERIMENT_PROMPT_BYTE_LIMIT

    if not fits():
        raise CoreError("CONTEXT_LIMIT")
    for source in unique:
        if len(kept) >= max_sources:
            break
        kept.append(source)
        included.append([])
        if not fits():
            kept.pop()
            included.pop()
    rounds = max([len(s.get("imageAnnotations", [])) for s in kept], default=0)
    for offset in range(rounds):
        for index, s in enumerate(kept):
            annotations = s.get("imageAnnotations", [])
            if offset >= len(annotations):
                continue
            included[index].append(annotations[offset])
            if not fits():
                included[index].pop()
    kept_ids = {s["id"] for s in kept}
    return {
        "messages": render(final=True),
        "sources": [
            dict(s, **({"imageAnnotations": included[i]} if "imageAnnotations" in s else {}))
            for i, s in enumerate(kept)
        ],
        "omittedAnnotations": sum(
            int(len(s.get("imageAnnotations", [])) - len(included[i])) for i, s in enumerate(kept)
        ),
        "omittedSourceIds": [s["id"] for s in unique if s["id"] not in kept_ids],
    }


def build_prompt(persona, history, text, sources, timeline, policy_note=None):
    policy = current_prompt_snapshot().legacy
    definition = {
        k: persona[k]
        for k in [
            "id",
            "revision",
            "reviewStatus",
            "language",
            "identity",
            "concept",
            "style",
            "boundaries",
        ]
    }
    persona_messages = [
        {
            "role": "system",
            "content": "Persona definition (subordinate to policy): " + dumps(definition),
        },
    ]
    evidence_json = None
    if timeline:
        items = []
        for s in sources:
            sentence = regex.search(r"^[\s\S]*?[.!?。！？](?=\s|$)|^[^\n]*\n", s["caption"])
            items.append(
                {
                    "sourceId": s["id"],
                    "personId": s["personId"],
                    "caption": s["caption"],
                    "postedAt": s["postedAt"],
                    "eventDate": s["eventDate"],
                    "quoteCandidate": utf16_prefix(sentence[0] if sentence else s["caption"], 160),
                }
            )
        evidence_json = dumps(items)
    return _format_messages(
        policy["base"] + policy["timeline" if timeline else "smallTalk"],
        persona_messages,
        [{"role": m["role"], "content": m["content"]} for m in history],
        text,
        evidence_json,
        notes=[{"role": "system", "content": policy_note}] if policy_note else [],
    )
