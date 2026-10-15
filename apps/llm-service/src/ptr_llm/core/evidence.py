"""Source ownership, date filters and exact UTF-16 quote binding; never entailment."""

import json
from datetime import date, datetime
from typing import Any, Literal, Self
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import regex
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .errors import CoreError
from .prompts import utf16_length
from .safety import contains_credential, contains_internal_path
from .texts import reply_text, voice_text


def validate_query(request, person_id):
    q = dict(request)
    if (
        set(q) - {"personId", "query", "start", "end", "dateBasis", "timezone", "limit"}
        or q.get("personId") != person_id
    ):
        raise CoreError("FORBIDDEN")
    if (
        q.get("dateBasis") not in ("posted", "event")
        or type(q.get("limit")) is not int
        or (not 1 <= q["limit"] <= 100)
    ):
        raise CoreError("INVALID_INPUT")
    try:
        ZoneInfo(q["timezone"])
        if ("start" in q) != ("end" in q):
            raise ValueError()
        if "start" in q:
            date.fromisoformat(q["start"])
            date.fromisoformat(q["end"])
            if q["start"] >= q["end"]:
                raise ValueError()
        if "query" in q:
            q["query"] = q["query"].strip()
            if not 1 <= len(q["query"]) <= 500:
                raise ValueError()
    except Exception:
        raise CoreError("INVALID_INPUT") from None
    return q


def filter_evidence(raw, request, person_id):
    q = validate_query(request, person_id)
    items = []
    for s in raw:
        try:
            if (
                not isinstance(s, dict)
                or s.get("personId") != person_id
                or s.get("unsafe") is not False
            ):
                continue
            if set(s) - {
                "id",
                "personId",
                "caption",
                "postedAt",
                "eventDate",
                "sourceUrl",
                "hash",
                "snapshot",
                "unsafe",
                "imageAnnotations",
            }:
                continue
            if not all(
                isinstance(s[k], str) and 1 <= len(s[k].strip()) <= 200
                for k in ["id", "personId", "hash", "snapshot"]
            ):
                continue
            if not isinstance(s["caption"], str) or urlparse(s["sourceUrl"]).scheme not in (
                "http",
                "https",
            ):
                continue
            timestamp = datetime.fromisoformat(s["postedAt"].replace("Z", "+00:00"))
            if timestamp.tzinfo is None:
                continue
            if s["eventDate"] is not None:
                date.fromisoformat(s["eventDate"])
            annotations = s.get("imageAnnotations", [])
            if len(annotations) > 100:
                continue
            if any(
                a.get("humanReviewed") is not False
                or not all(
                    isinstance(a.get(k), str) and a[k]
                    for k in [
                        "id",
                        "imageHash",
                        "annotationHash",
                        "revision",
                        "text",
                        "model",
                    ]
                )
                or len(a["text"]) > 16000
                for a in annotations
            ):
                continue
            if "start" in q:
                if q["dateBasis"] == "event" and q["timezone"] != "UTC":
                    continue
                day = (
                    timestamp.astimezone(ZoneInfo(q["timezone"])).date().isoformat()
                    if q["dateBasis"] == "posted"
                    else s["eventDate"]
                )
                if day is None or not q["start"] <= day < q["end"]:
                    continue
            items.append(s)
        except (KeyError, ValueError, TypeError):
            continue
    return items[: q["limit"]]


def formatted_quote(text, quote):
    if not isinstance(quote, str) or not quote.strip():
        return None
    start = text.find(quote)
    if start >= 0:
        if text.find(quote, start + 1) >= 0:
            return None
        return {
            "start": utf16_length(text[:start]),
            "end": utf16_length(text[: start + len(quote)]),
            "quote": quote,
            "canonicalized": False,
        }

    def normalize(t):
        return regex.sub("[ \\t\\r\\n]+", " ", t)

    needle = normalize(quote)
    units = []
    starts = []
    ends = []
    for match in regex.finditer("[ \\t\\r\\n]+|[^ \\t\\r\\n]", text):
        units.append(" " if match[0][0] in " \t\r\n" else match[0])
        starts.append(match.start())
        ends.append(match.end())
    normalized = "".join(units)
    match = normalized.find(needle)
    if match < 0 or normalized.find(needle, match + 1) >= 0:
        return None
    start = starts[match]
    end = ends[match + len(needle) - 1]
    return {
        "start": utf16_length(text[:start]),
        "end": utf16_length(text[:end]),
        "quote": text[start:end],
        "canonicalized": True,
    }


class _ModelReference(BaseModel):
    """Internal model selection shape, not a second backend wire contract."""

    model_config = ConfigDict(extra="forbid", strict=True)
    sourceId: str
    quote: str
    annotationId: Any = None  # Provenance/type policy stays in the binding layer.
    start: int | None = Field(default=None, ge=0)
    end: int | None = Field(default=None, gt=0)

    @field_validator("sourceId", "quote")
    @classmethod
    def nonempty(cls, value: str) -> str:
        # Native Rust string bounds impose an additional Unicode policy; plain
        # strict strings plus Python nonempty preserve the existing decoder.
        if not value:
            raise ValueError("reference-empty")
        return value

    @field_validator("start", "end", mode="before")
    @classmethod
    def offset_present(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("offset-null")
        return value

    @model_validator(mode="after")
    def paired_offsets(self) -> Self:
        if ("start" in self.model_fields_set) != ("end" in self.model_fields_set):
            raise ValueError("offset-pair")
        return self


class _ModelReply(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    status: Literal["answered", "insufficient_evidence", "needs_clarification", "out_of_scope"]
    answer: str
    evidenceRefs: list[_ModelReference] = Field(max_length=100)

    @field_validator("answer")
    @classmethod
    def utf16_bound(cls, value: str) -> str:
        if utf16_length(value) > 8000:
            raise ValueError("answer-limit")
        return value


def _parse(raw):
    # Keep the existing JSON decoder and original key ordering. Pydantic
    # validates structure only; ownership, quote offsets and provenance remain
    # fail-closed domain checks below, and shared wire schemas remain untouched.
    r = json.loads(raw)
    _ModelReply.model_validate(r)
    return r


def _bind(selections, sources, person_id, condition, canonicalize):
    evidence = []
    refs = []
    canonicalized = False
    for selection in selections:
        source = next(
            (
                s
                for s in sources
                if s["id"] == selection["sourceId"]
                and s["personId"] == person_id
                and (not s["unsafe"])
            ),
            None,
        )
        if (
            not source
            or contains_credential(selection["quote"])
            or contains_internal_path(selection["quote"])
        ):
            return None
        aid = selection.get("annotationId")
        annotation = (
            next((a for a in source.get("imageAnnotations", []) if a["id"] == aid), None)
            if aid
            else None
        )
        if aid and (
            condition != "caption_image"
            or not annotation
            or annotation["humanReviewed"] is not False
        ):
            return None
        text = annotation["text"] if annotation else source["caption"]
        if "start" in selection:
            rawtext = text.encode("utf-16-le")
            start = selection["start"]
            end = selection["end"]
            if start >= end or end > len(rawtext) // 2:
                return None
            try:
                bound = rawtext[start * 2 : end * 2].decode("utf-16-le")
            except UnicodeError:
                return None
            if bound != selection["quote"]:
                return None
            ref = dict(selection)
        else:
            if canonicalize:
                match = formatted_quote(text, selection["quote"])
            else:
                pos = text.find(selection["quote"])
                match = (
                    {
                        "start": utf16_length(text[:pos]),
                        "end": utf16_length(text[: pos + len(selection["quote"])]),
                        "quote": selection["quote"],
                        "canonicalized": False,
                    }
                    if pos >= 0 and text.find(selection["quote"], pos + 1) < 0
                    else None
                )
            if not match:
                return None
            canonicalized |= match.pop("canonicalized")
            ref = dict(selection, **match)
        refs.append(ref)
        card = {
            "sourceId": source["id"],
            "personId": person_id,
            **{k: source[k] for k in ["sourceUrl", "postedAt", "eventDate", "snapshot", "hash"]},
            "quote": ref["quote"],
        }
        if annotation:
            card.update(
                origin="ai_image_annotation",
                annotationId=annotation["id"],
                imageHash=annotation["imageHash"],
                annotationHash=annotation["annotationHash"],
                annotationRevision=annotation["revision"],
            )
        elif canonicalize:
            card["origin"] = "source_caption"
        evidence.append(card)
    return (refs, evidence, canonicalized)


def validate_experiment_reply(
    raw, sources, person_id, condition, language="ko", level="polite", previous="", seed=None
):
    fallback = {
        "status": "insufficient_evidence",
        "content": voice_text("service_retry", language, level, previous, seed),
        "claims": [],
        "evidence": [],
        "grounding": "unverified_model",
        "limitations": [
            "INVALID_MODEL_EVIDENCE",
            reply_text("limitation_semantic_unchecked", language),
        ],
    }
    try:
        r = _parse(raw)
    except Exception:
        return fallback
    if contains_credential(r["answer"]) or contains_internal_path(r["answer"]):
        raise CoreError("TURN_FAILED", "REPLY_REJECTED")
    answer = r["answer"].strip()
    unverified = dict(
        fallback,
        content=answer or fallback["content"],
        limitations=(["RETRIEVAL_OFF"] if condition == "off" else [])
        + [
            "INVALID_MODEL_EVIDENCE",
            "UNVERIFIED_MODEL_RESPONSE",
            reply_text("limitation_unverified_model", language),
            reply_text("limitation_semantic_unchecked", language),
        ],
    )
    if condition == "off" and r["evidenceRefs"]:
        return unverified
    bound = _bind(r["evidenceRefs"], sources, person_id, condition, True)
    if bound is None:
        return unverified
    refs, evidence, canonicalized = bound
    claims = [
        {
            "text": reply_text(
                "claim_image_annotation" if ref.get("annotationId") else "claim_caption", language
            )
            + ": "
            + ref["quote"],
            "evidenceRefs": [ref],
        }
        for ref in refs
    ]
    return {
        "status": r["status"] if answer else "insufficient_evidence",
        "content": answer or fallback["content"],
        "claims": claims,
        "evidence": evidence,
        "grounding": "source_bound_quotes" if evidence else "unverified_model",
        "limitations": (["RETRIEVAL_OFF"] if condition == "off" else [])
        + (["QUOTE_WHITESPACE_CANONICALIZED"] if canonicalized else [])
        + (
            [reply_text("limitation_quote_binding", language)]
            if evidence
            else ["UNVERIFIED_MODEL_RESPONSE", reply_text("limitation_unverified_model", language)]
        )
        + (
            [reply_text("limitation_ai_annotation", language)]
            if any(c.get("origin") == "ai_image_annotation" for c in evidence)
            else []
        )
        + [reply_text("limitation_posted_date", language)],
    }


def validate_source_bound_reply(raw, sources, person_id):
    fallback = {
        "status": "insufficient_evidence",
        "content": "자료에서 확인할 수 있는 근거가 부족해요.",
        "claims": [],
        "evidence": [],
        "limitations": ["생성된 인용을 검증하지 못했습니다."],
    }
    try:
        r = _parse(raw)
    except Exception:
        return fallback
    if r["status"] != "answered":
        return dict(
            fallback,
            status=r["status"],
            content={
                "insufficient_evidence": "자료에서 확인할 수 있는 근거가 부족해요.",
                "needs_clarification": "게시일과 활동일 중 어떤 날짜를 기준으로 볼까요?",
                "out_of_scope": "이 자료 범위에서는 확인할 수 없어요.",
            }[r["status"]],
            limitations=[],
        )
    if not r["evidenceRefs"] or any("annotationId" in ref for ref in r["evidenceRefs"]):
        return fallback
    bound = _bind(r["evidenceRefs"], sources, person_id, "caption", False)
    if bound is None:
        return fallback
    refs, evidence, _ = bound
    claims = [{"text": "캡션 원문: " + ref["quote"], "evidenceRefs": [ref]} for ref in refs]
    return {
        "status": "answered",
        "content": "\n".join(c["text"] for c in claims),
        "claims": claims,
        "evidence": evidence,
        "limitations": [
            "캡션의 진술이며 실제 활동일은 게시일과 다를 수 있습니다.",
            "원문 인용 일치 검사는 의미적 사실 검수와 다릅니다.",
        ],
    }
