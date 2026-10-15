"""Strict JSON-action schema shared with engine guided decoding."""

import copy
import json
from typing import Any

from .errors import CoreError
from .prompts import image_quote_candidate, short_unique_quote, utf16_length
from .safety import contains_credential

AGENT_MESSAGE_MAX_CODE_POINTS = 400
AGENT_RESPONSE_JSON_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["message", "status", "evidenceRefs", "variableUpdates"],
    "properties": {
        "message": {"type": "string", "maxLength": 400},
        "status": {
            "type": "string",
            "enum": ["answered", "insufficient_evidence", "needs_clarification", "out_of_scope"],
        },
        "evidenceRefs": {
            "type": "array",
            "maxItems": 2,
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["sourceId", "quote"],
                "properties": {
                    "sourceId": {"type": "string", "minLength": 1, "maxLength": 200},
                    "annotationId": {"type": "string", "minLength": 1, "maxLength": 200},
                    "quote": {"type": "string", "minLength": 1, "maxLength": 96},
                },
            },
        },
        "reasoning": {"type": "string", "maxLength": 160},
        "variableUpdates": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "conversationTopic": {"type": "string", "maxLength": 200},
                "tone": {"type": "string", "enum": ["neutral", "warm", "playful"]},
            },
        },
        "function": {
            "type": "object",
            "additionalProperties": False,
            "required": ["name", "arguments"],
            "properties": {
                "name": {"type": "string", "enum": ["timeline_search"]},
                "arguments": {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["query"],
                    "properties": {"query": {"type": "string", "minLength": 1, "maxLength": 500}},
                },
            },
        },
    },
}


def agent_response_schema(sources):
    """Finite complete references from the trusted, budgeted context, never message prefixes.

    Native decoding selects a full reference instead of recombining identifiers and
    quote text. Historical parsing and the final exact provenance validator stay intact.
    """
    schema: dict[str, Any] = copy.deepcopy(AGENT_RESPONSE_JSON_SCHEMA)
    choices = []
    seen = set()
    for source in sources:
        if source.get("unsafe"):
            continue
        candidates = [{"sourceId": source["id"], "quote": short_unique_quote(source["caption"])}]
        candidates.extend(
            {"sourceId": source["id"], "annotationId": a["id"], "quote": image_quote_candidate(a)}
            for a in source.get("imageAnnotations", [])
            if a.get("humanReviewed") is False
        )
        for ref in candidates:
            if not ref["quote"] or any(
                utf16_length(v) > (96 if k == "quote" else 200) for k, v in ref.items()
            ):
                continue
            key = tuple(ref.items())
            if key not in seen:
                seen.add(key)
                choices.append(
                    {
                        "type": "object",
                        "additionalProperties": False,
                        "required": list(ref),
                        "properties": {k: {"type": "string", "const": v} for k, v in ref.items()},
                    }
                )
    field = schema["properties"]["evidenceRefs"]
    if choices:
        field["items"] = {"anyOf": choices}
    else:
        field["maxItems"] = 0
    return schema


def variables(value=None):
    value = {} if value is None else value
    if not isinstance(value, dict) or set(value) - {"conversationTopic", "tone", "speechLevel"}:
        raise CoreError("INVALID_INPUT")
    topic = value.get("conversationTopic", "")
    tone = value.get("tone", "neutral")
    if (
        not isinstance(topic, str)
        or utf16_length(topic) > 200
        or tone not in ("neutral", "warm", "playful")
        or value.get("speechLevel", "polite") not in ("casual", "polite")
    ):
        raise CoreError("INVALID_INPUT")
    result = {"conversationTopic": topic, "tone": tone}
    if "speechLevel" in value:
        result["speechLevel"] = value["speechLevel"]
    return result


def _credential(value):
    if isinstance(value, str):
        return contains_credential(value)
    if isinstance(value, list):
        return any(_credential(item) for item in value)
    if isinstance(value, dict):
        return any(_credential(key) or _credential(item) for key, item in value.items())
    return False


def parse_agent_response(raw):
    try:
        if not isinstance(raw, str) or len(raw.encode("utf8")) > 65536 or contains_credential(raw):
            raise ValueError()
        value = json.loads(raw)
        if _credential(value) or not isinstance(value, dict):
            raise ValueError()
        # A model may echo ONLY these two service-owned state keys; never permit other fields.
        updates = value.setdefault("variableUpdates", {})
        if isinstance(updates, dict):
            updates.pop("replyLanguage", None)
            updates.pop("speechLevel", None)
        from jsonschema import Draft202012Validator

        Draft202012Validator(AGENT_RESPONSE_JSON_SCHEMA).validate(value)
        for ref in value["evidenceRefs"]:
            if (
                utf16_length(ref["sourceId"]) > 200
                or utf16_length(ref["quote"]) > 96
                or ("annotationId" in ref and utf16_length(ref["annotationId"]) > 200)
            ):
                raise ValueError()
        if "reasoning" in value and utf16_length(value["reasoning"]) > 160:
            raise ValueError()
        if "conversationTopic" in updates and utf16_length(updates["conversationTopic"]) > 200:
            raise ValueError()
        if "function" in value:
            query = value["function"]["arguments"]["query"].strip()
            if (
                not query
                or len(query) > 500
                or value["message"]
                or value["evidenceRefs"]
                or updates
            ):
                raise ValueError()
            value["function"]["arguments"]["query"] = query
        elif not value["message"].strip():
            raise ValueError()
        return value
    except Exception:
        raise CoreError("TURN_FAILED") from None
