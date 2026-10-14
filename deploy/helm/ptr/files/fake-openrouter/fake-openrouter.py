#!/usr/bin/env python3
"""Kind-only OpenRouter-compatible fixture with request accounting."""

from __future__ import annotations

import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_lock = threading.Lock()
_requests: dict[str, dict[str, object]] = {}
_cost = float(os.environ.get("PTR_FAKE_OPENROUTER_COST", "0.000123"))
_emit_cost_header = os.environ.get("PTR_FAKE_OPENROUTER_EMIT_COST_HEADER", "1") != "0"
_key_limit = float(os.environ.get("PTR_FAKE_OPENROUTER_KEY_LIMIT", "1"))
_key_limit_reset = os.environ.get("PTR_FAKE_OPENROUTER_KEY_LIMIT_RESET") or None
_chat_model = os.environ.get("PTR_FAKE_OPENROUTER_CHAT_MODEL", "google/gemma-4-26b-a4b-it")
_embedding_model = os.environ.get("PTR_FAKE_OPENROUTER_EMBEDDING_MODEL", "openai/text-embedding-3-small")
_marker = re.compile(r"\bK4_ID:([A-Za-z0-9_.:-]{1,96})\b")
_pricing = {
    "prompt": "0.00000007",
    "completion": "0.00000034",
    "request": "0",
    "image": "0",
    "web_search": "0",
    "internal_reasoning": "0",
    "input_cache_read": "0",
    "input_cache_write": "0",
}
_embedding_pricing = {"prompt": "0.00000002", "completion": "0"}


def _json(status: int, payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()


def _request_id(body: dict[str, object], headers: object) -> str:
    metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
    request_id = (
        getattr(headers, "get")("x-request-id")
        or metadata.get("request_id")
        or metadata.get("trace_id")
    )
    if request_id:
        return str(request_id)[:128]
    for item in body.get("messages") or []:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if isinstance(content, str):
            match = _marker.search(content)
            if match:
                return match.group(1)
    return "missing-" + str(time.time_ns())


def _response_headers(request_id: str) -> dict[str, str]:
    headers = {"x-ptr-provider-request-id": request_id}
    if _emit_cost_header:
        headers["x-openrouter-response-cost"] = f"{_cost:.12f}"
    return headers


def _usage() -> dict[str, int | float]:
    usage: dict[str, int | float] = {
        "prompt_tokens": 16,
        "completion_tokens": 12,
        "total_tokens": 28,
    }
    if _emit_cost_header:
        usage["cost"] = _cost
    return usage


def _deepinfra_endpoint() -> dict[str, object]:
    return {
        "name": "DeepInfra",
        "provider_name": "DeepInfra",
        "tag": "deepinfra/fake-kind",
        "pricing": _pricing,
        "supported_parameters": ["structured_outputs", "provider"],
    }


def _model_catalog() -> dict[str, object]:
    return {
        "data": [
            {
                "id": _chat_model,
                "name": "Synthetic Gemma via DeepInfra",
                "pricing": _pricing,
                "supported_parameters": ["structured_outputs", "provider"],
                "endpoints": [_deepinfra_endpoint()],
            }
        ]
    }


def _embedding_catalog() -> dict[str, object]:
    return {
        "data": [
            {
                "id": _embedding_model,
                "name": "Synthetic embedding model",
                "pricing": _embedding_pricing,
            }
        ]
    }


def _resolve_ref(schema: dict[str, object], root: dict[str, object]) -> dict[str, object]:
    ref = schema.get("$ref")
    if not isinstance(ref, str) or not ref.startswith("#/$defs/"):
        return schema
    current: object = root.get("$defs")
    for part in ref.removeprefix("#/$defs/").split("/"):
        if not isinstance(current, dict):
            return {}
        current = current.get(part)
    return current if isinstance(current, dict) else {}


def _schema_value(schema: object, root: dict[str, object], depth: int = 0) -> object:
    if depth > 16 or not isinstance(schema, dict):
        return {}
    resolved = _resolve_ref(schema, root)
    if resolved is not schema:
        return _schema_value(resolved, root, depth + 1)
    if "const" in schema:
        return schema["const"]
    if isinstance(schema.get("enum"), list) and schema["enum"]:
        return schema["enum"][0]
    if "default" in schema:
        return schema["default"]
    for key in ("anyOf", "oneOf", "allOf"):
        variants = schema.get(key)
        if isinstance(variants, list) and variants:
            return _schema_value(variants[0], root, depth + 1)
    types = schema.get("type")
    type_names = types if isinstance(types, list) else [types]
    if "object" in type_names:
        properties = schema.get("properties")
        required = schema.get("required")
        if not isinstance(properties, dict):
            return {}
        names = required if isinstance(required, list) else []
        return {
            str(name): _schema_value(properties.get(name), root, depth + 1)
            for name in names
            if name in properties
        }
    if "array" in type_names:
        min_items = schema.get("minItems")
        count = min_items if isinstance(min_items, int) and min_items > 0 else 0
        item = schema.get("items")
        return [_schema_value(item, root, depth + 1) for _ in range(count)]
    if "integer" in type_names:
        return 1
    if "number" in type_names:
        return 1.0
    if "boolean" in type_names:
        return True
    return "Synthetic OpenRouter spillover reply."


def _structured_content(body: dict[str, object]) -> str:
    response_format = body.get("response_format")
    if not isinstance(response_format, dict):
        return "Synthetic OpenRouter spillover reply."
    if response_format.get("type") == "json_schema":
        json_schema = response_format.get("json_schema")
        schema = json_schema.get("schema") if isinstance(json_schema, dict) else None
        if isinstance(schema, dict):
            value = _schema_value(schema, schema)
            if (
                isinstance(value, dict)
                and isinstance(value.get("message"), str)
                and not value["message"].strip()
                and "function" not in value
            ):
                value["message"] = "Synthetic OpenRouter spillover reply."
            return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if response_format.get("type") == "json_object":
        agent = any(
            isinstance(item, dict)
            and item.get("role") == "system"
            and "AGENT_JSON_REPLY" in str(item.get("content", ""))
            for item in body.get("messages") or []
        )
        if agent:
            return json.dumps(
                {
                    "message": "Synthetic OpenRouter spillover reply.",
                    "status": "answered",
                    "evidenceRefs": [],
                    "variableUpdates": {},
                },
                ensure_ascii=False,
                separators=(",", ":"),
            )
        return json.dumps(
            {"status": "insufficient_evidence", "answer": "", "evidenceRefs": []},
            ensure_ascii=False,
            separators=(",", ":"),
        )
    return "Synthetic OpenRouter spillover reply."


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:
        pass

    def _reply(self, status: int, payload: object, headers: dict[str, str] | None = None) -> None:
        body = _json(status, payload)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._reply(200, {"status": "ok"})
            return
        if self.path == "/api/v1/models":
            self._reply(200, _model_catalog())
            return
        if self.path == f"/api/v1/models/{_chat_model}/endpoints":
            self._reply(200, {"data": {"id": _chat_model, "endpoints": [_deepinfra_endpoint()]}})
            return
        if self.path == "/api/v1/embeddings/models":
            self._reply(200, _embedding_catalog())
            return
        if self.path == "/api/v1/endpoints/zdr":
            self._reply(
                200,
                {"data": [{"model_id": _chat_model, "provider_name": "DeepInfra", "tag": "deepinfra/fake-kind"}]},
            )
            return
        if self.path == "/api/v1/key":
            self._reply(
                200,
                {"data": {"limit": _key_limit, "limit_remaining": _key_limit, "limit_reset": _key_limit_reset}},
            )
            return
        if self.path == "/counts":
            with _lock:
                self._reply(
                    200,
                    {
                        "submitted": sum(int(v["count"]) for v in _requests.values()),
                        "request_ids": sorted(_requests),
                        "duplicates": {
                            key: value["count"]
                            for key, value in sorted(_requests.items())
                            if int(value["count"]) > 1
                        },
                        "cost": _cost,
                        "cost_header": _emit_cost_header,
                    },
                )
            return
        self._reply(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/api/v1/chat/completions":
            self._reply(404, {"error": "not_found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 262144:
            self._reply(413, {"error": "bounded_input"})
            return
        try:
            body = json.loads(self.rfile.read(length))
        except ValueError:
            self._reply(400, {"error": "invalid_json"})
            return
        request_id = _request_id(body, self.headers)
        with _lock:
            entry = _requests.setdefault(
                request_id,
                {"model": str(body.get("model", ""))[:128], "count": 0, "cost": _cost},
            )
            entry["count"] = int(entry["count"]) + 1
            count = int(entry["count"])
        print(
            json.dumps(
                {"event": "fake_openrouter_request", "request_id": request_id, "count": count},
                separators=(",", ":"),
            ),
            flush=True,
        )
        self._reply(
            200,
            {
                "id": "chatcmpl-fake-openrouter-" + str(time.time_ns()),
                "object": "chat.completion",
                "created": int(time.time()),
                "model": body.get("model", "openrouter/fake"),
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": _structured_content(body),
                        },
                    }
                ],
                "usage": _usage(),
            },
            headers=_response_headers(str(request_id)),
        )


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
