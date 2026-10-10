"""Bounded deterministic history context and immutable pinned source references."""

import copy

import regex

from .policy import js_search
from .safety import contains_credential, is_creative

RETRIEVAL_CONTEXT_REVISION = "user-context-v2-pinned-source-context"


def is_follow_up(text):
    if js_search(
        (
            "\\b(?:instead|different|new topic|this week|right now)\\b|말고|다른\\s?(?:글|사"
            "진|주제|여행)|새로운|이번\\s?주|지금"
        ),
        text,
        regex.I,
    ):
        return False
    return bool(
        js_search(
            r"그때|그\s?(?:글|사진|그림|장면|여행|곳|수업)|거기|옆에|그럼|그거|그것|\b(?:that|those|then|there|it|its)\b",
            text,
            regex.I,
        )
    )


def is_post_memory(text):
    return bool(
        js_search(
            (
                "(?:올린|갔던|했던|봤던|예전)[^.!?\\n]{0,60}(?:글|거|사진)|(?:그|이)\\s?글|(?:그|예전|너의|당신의)"
                "[^.!?\\n]{0,30}기억나|\\b(?:post|posted)\\b|\\bremember\\b[^.!?\\n]{0,40}\\b(?:y"
                "our|that|the)\\b[^.!?\\n]{0,30}\\b(?:photo|trip|visit)\\b"
            ),
            text,
            regex.I,
        )
    )


def retrieval_context(history, text, explicit_timeline=False):
    recent = [m for m in history if m["role"] == "user" and m.get("turnId") is not None][-5:]
    follow = not explicit_timeline and is_follow_up(text) and bool(recent)
    chain: list[dict] = []
    if (
        follow
        or not explicit_timeline
        and js_search(r"\b(?:photo|picture|caption)\b|사진|이미지|캡션", text, regex.I)
    ):
        for message in reversed(recent):
            chain.insert(0, message)
            if not is_follow_up(message["content"]):
                break
    creative = not explicit_timeline and (
        is_creative(text)
        or any(is_creative(m["content"]) for m in chain)
        and not is_post_memory(text)
    )
    current = text[:500]
    selected: list[dict] = []
    segments: list[str] = []
    remaining = 500 - len(current)
    if follow and not creative:
        for message in reversed(chain):
            if remaining <= 1:
                break
            if contains_credential(message["content"]):
                continue
            segment = message["content"][: remaining - 1]
            segments.insert(0, segment)
            selected.insert(0, message)
            remaining -= len(segment) + 1
    return {
        "query": "\n".join(segments + [current]),
        "contextTurnIds": [m["turnId"] for m in selected],
        "followUp": follow,
        "creative": creative,
    }


def remember_source_context(sources, cited):
    references = copy.deepcopy(cited)
    parents = {r["sourceId"] for r in cited}
    for source in [s for s in sources if s["id"] in parents]:
        base = {
            "sourceId": source["id"],
            **{
                k: source[k]
                for k in ["personId", "sourceUrl", "postedAt", "eventDate", "snapshot", "hash"]
            },
        }
        if source["caption"] and not any(
            r["sourceId"] == source["id"] and not r.get("annotationId") for r in references
        ):
            references.append(dict(base, quote=source["caption"][:96], origin="source_caption"))
        for annotation in source.get("imageAnnotations", []):
            if len(references) >= 20:
                break
            if any(
                r["sourceId"] == source["id"] and r.get("annotationId") == annotation["id"]
                for r in references
            ):
                continue
            references.append(
                dict(
                    base,
                    quote=annotation["text"][:96],
                    origin="ai_image_annotation",
                    annotationId=annotation["id"],
                    imageHash=annotation["imageHash"],
                    annotationHash=annotation["annotationHash"],
                    annotationRevision=annotation["revision"],
                )
            )
    return references[:20]
