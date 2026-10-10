"""Strict JSON-action schema shared with engine guided decoding."""

import json

from .errors import CoreError
from .prompts import utf16_length
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


def variables(value=None):
    value = {} if value is None else value
    if not isinstance(value, dict) or set(value) - {"conversationTopic", "tone"}:
        raise CoreError("INVALID_INPUT")
    topic = value.get("conversationTopic", "")
    tone = value.get("tone", "neutral")
    if (
        not isinstance(topic, str)
        or utf16_length(topic) > 200
        or tone not in ("neutral", "warm", "playful")
    ):
        raise CoreError("INVALID_INPUT")
    return {"conversationTopic": topic, "tone": tone}


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
