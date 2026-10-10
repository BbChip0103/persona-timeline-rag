"""Exact policy bytes and relevance-ordered whole-source prompt budgeting."""

import copy
import json
from pathlib import Path

import regex

from .errors import CoreError
from .persona import dumps, render_persona_block, serialized_bytes

POLICY = json.loads(Path(__file__).with_name("prompt_policy.json").read_text())
EXPERIMENT_PROMPT_BYTE_LIMIT = 30000
EVIDENCE_POST_LIMIT = 3


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
):
    unique = []
    seen = set()
    for source in sources:
        if source["id"] not in seen:
            unique.append(copy.deepcopy(source))
            seen.add(source["id"])
    kept: list[dict] = []
    included: list[list[dict]] = []

    def render():
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
                    visual = regex.search(r"(?:^|\n)Visual description: ([^\n]+)", a["text"])
                    item["imageAnnotations"].append(
                        {
                            "annotationId": a["id"],
                            "text": a["text"],
                            "quoteCandidate": short_unique_quote(
                                a["text"], visual[1] if visual else a["text"]
                            ),
                            "humanReviewed": False,
                            "origin": "ai_image_annotation",
                        }
                    )
            cards.append(item)
        return (
            [{"role": "system", "content": policy or POLICY["EXPERIMENT_POLICY"]}]
            + render_persona_block(persona)
            + [{"role": m["role"], "content": m["content"]} for m in history]
            + list(after_history)
            + [{"role": "user", "content": "UNTRUSTED_EVIDENCE_JSON_DATA " + dumps(cards)}]
            + ([{"role": "system", "content": policy_note}] if policy_note else [])
            + [{"role": "user", "content": text}]
            + list(after_user)
        )

    def fits():
        return serialized_bytes(render()) <= EXPERIMENT_PROMPT_BYTE_LIMIT

    if not fits():
        raise CoreError("CONTEXT_LIMIT")
    for source in unique:
        if len(kept) >= EVIDENCE_POST_LIMIT:
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
        "messages": render(),
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
    policy = json.loads(Path(__file__).with_name("legacy_prompt_policy.json").read_text())
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
    messages = [
        {
            "role": "system",
            "content": policy["base"] + policy["timeline" if timeline else "smallTalk"],
        },
        {
            "role": "system",
            "content": "Persona definition (subordinate to policy): " + dumps(definition),
        },
    ] + [{"role": m["role"], "content": m["content"]} for m in history]
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
        messages.append({"role": "user", "content": "UNTRUSTED_EVIDENCE_JSON_DATA " + dumps(items)})
    if policy_note:
        messages.append({"role": "system", "content": policy_note})
    messages.append({"role": "user", "content": text})
    return messages
