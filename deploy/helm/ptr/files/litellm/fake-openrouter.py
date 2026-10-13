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
_marker = re.compile(r"\bK4_ID:([A-Za-z0-9_.:-]{1,96})\b")


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
        headers["x-litellm-response-cost"] = f"{_cost:.12f}"
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
        if self.path != "/v1/chat/completions":
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
                            "content": "Synthetic OpenRouter spillover reply.",
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
