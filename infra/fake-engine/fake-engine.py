#!/usr/bin/env python3
"""Synthetic OpenAI chat fixture ONLY. Never a replacement for a real model server."""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_delay_ms = int(os.environ.get("PTR_SYNTHETIC_ENGINE_DELAY_MS", "100"))
if not 0 <= _delay_ms <= 1000:
    raise ValueError("Synthetic fixture delay out of bounds")
_max_stall_ms = 600000
_max_body_bytes = 262144
_lock = threading.Lock()
_counts = {
    "submitted": 0,
    "success": 0,
    "failed": 0,
    "timeout": 0,
    "stalled_generation": 0,
    "stalled_health": 0,
    "active": 0,
    "max_active": 0,
    "effective_delay_ms": _delay_ms,
    "prompt_tokens": 16,
    "completion_tokens": 12,
}
_requests = {}
_marker_requests = {}
_one_shot_stalls = set()

# Tests and probes intentionally exercise client timeouts; do not let those
# stalled fixture handlers delay process shutdown.
ThreadingHTTPServer.daemon_threads = True


def _bounded_ms(name, default=0):
    value = int(os.environ.get(name, str(default)))
    if not 0 <= value <= _max_stall_ms:
        raise ValueError(f"{name} out of bounds")
    return value


def _stall_modes():
    return {
        item.strip().lower()
        for item in os.environ.get("PTR_SYNTHETIC_ENGINE_STALL_MODE", "").split(",")
        if item.strip()
    }


def _request_id(body, headers):
    metadata = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
    request_id = (
        headers.get("x-request-id")
        or headers.get("x-openai-request-id")
        or metadata.get("request_id")
        or metadata.get("requestId")
    )
    if request_id:
        return str(request_id)[:128]
    return "unlabeled"


def _body_marker(body):
    try:
        for message in body.get("messages", []):
            content = str(message.get("content", ""))
            if "K4_ID:" in content:
                return content.split("K4_ID:", 1)[1].split()[0][:128]
    except (AttributeError, TypeError):
        pass
    return "unlabeled"


def _record_request(request_id, marker):
    entry = _requests.setdefault(request_id, {"count": 0})
    entry["count"] += 1
    marker_entry = _marker_requests.setdefault(marker, {})
    marker_entry[request_id] = marker_entry.get(request_id, 0) + 1


def _sleep_ms(ms):
    remaining = ms / 1000
    while remaining > 0:
        step = min(remaining, 1)
        time.sleep(step)
        remaining -= step


def _read_chunked_body(stream):
    body = bytearray()
    while True:
        size_line = stream.readline(64)
        if not size_line:
            raise ValueError("missing_chunk_size")
        size_text = size_line.split(b";", 1)[0].strip()
        size = int(size_text, 16)
        if size == 0:
            while True:
                trailer = stream.readline(8192)
                if trailer in (b"\r\n", b"\n", b""):
                    return bytes(body)
        if len(body) + size > _max_body_bytes:
            raise OverflowError("bounded_input")
        body.extend(stream.read(size))
        if stream.read(2) != b"\r\n":
            raise ValueError("invalid_chunk")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log prompt/raw output/authorization data.

    def reply(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        if self.path == "/health":
            if "health" in _stall_modes():
                with _lock:
                    _counts["stalled_health"] += 1
                _sleep_ms(_bounded_ms("PTR_SYNTHETIC_ENGINE_HEALTH_STALL_MS", 120000))
            return self.reply(200, {"status": "synthetic"})
        if self.path == "/counts":
            with _lock:
                counts = dict(_counts)
                counts["request_ids"] = sorted(_requests)
                counts["duplicates"] = {
                    key: int(value["count"])
                    for key, value in sorted(_requests.items())
                    if int(value["count"]) > 1
                }
                counts["marker_request_ids"] = {
                    marker: sorted(requests)
                    for marker, requests in sorted(_marker_requests.items())
                }
                counts["marker_duplicates"] = {
                    marker: {
                        key: int(value) for key, value in sorted(requests.items()) if int(value) > 1
                    }
                    for marker, requests in sorted(_marker_requests.items())
                    if any(int(value) > 1 for value in requests.values())
                }
            return self.reply(200, counts)
        return self.reply(404, {"error": "not_found"})

    def do_POST(self):
        self._submitted = False
        try:
            self.handle_chat()
        finally:
            if self._submitted:
                with _lock:
                    _counts["active"] -= 1

    def handle_chat(self):
        if self.path != "/v1/chat/completions":
            return self.reply(404, {"error": "not_found"})
        try:
            if self.headers.get("Content-Length") is not None:
                length = int(self.headers["Content-Length"])
                if length < 1 or length > _max_body_bytes:
                    return self.reply(413, {"error": "bounded_input"})
                raw_body = self.rfile.read(length)
            elif "chunked" in self.headers.get("Transfer-Encoding", "").lower():
                raw_body = _read_chunked_body(self.rfile)
                if len(raw_body) < 1:
                    return self.reply(413, {"error": "bounded_input"})
            else:
                return self.reply(411, {"error": "missing_content_length"})
        except (OverflowError, ValueError):
            return self.reply(413, {"error": "bounded_input"})
        try:
            body = json.loads(raw_body)
            text = " ".join(str(item.get("content", "")) for item in body["messages"])
        except (ValueError, KeyError, TypeError):
            return self.reply(400, {"error": "invalid_fixture_input"})
        request_id = _request_id(body, self.headers)
        marker = _body_marker(body)
        with _lock:
            _counts["submitted"] += 1
            _counts["active"] += 1
            _counts["max_active"] = max(_counts["active"], _counts["max_active"])
            _record_request(request_id, marker)
            one_shot_stall = (
                "__STALL_GENERATION_ONCE__" in text
                and marker != "unlabeled"
                and marker not in _one_shot_stalls
            )
            if one_shot_stall:
                _one_shot_stalls.add(marker)
            self._submitted = True
        if one_shot_stall or "__STALL_GENERATION__" in text or "generation" in _stall_modes():
            with _lock:
                _counts["stalled_generation"] += 1
            _sleep_ms(_bounded_ms("PTR_SYNTHETIC_ENGINE_GENERATION_STALL_MS", 120000))
        if "__FAIL_500__" in text:
            with _lock:
                _counts["failed"] += 1
            return self.reply(
                500, {"error": {"message": "Synthetic ambiguous failure", "type": "server_error"}}
            )
        if "__TIMEOUT__" in text:
            with _lock:
                _counts["timeout"] += 1
            time.sleep(7)
        time.sleep(_delay_ms / 1000)
        if "__LOCK_LOSS__" in text:
            time.sleep(3)
        structured = body.get("response_format", {}).get("type") in ("json_schema", "json_object")
        last_user = next(
            (
                str(item.get("content", ""))
                for item in reversed(body["messages"])
                if item.get("role") == "user"
                and not str(item.get("content", "")).startswith(("UNTRUSTED_", "TOOL_RESULT_"))
            ),
            "",
        )
        message = (
            "합성 엔진에서 보내는 짧은 답변이에요."
            if any("가" <= char <= "힣" for char in last_user)
            else "Synthetic reply from the isolated local engine."
        )
        references = []
        for item in body["messages"]:
            value = item.get("content", "")
            marker = "UNTRUSTED_EVIDENCE_JSON_DATA "
            if isinstance(value, str) and value.startswith(marker):
                try:
                    sources = json.loads(value[len(marker) :])
                    for source in sources[:3]:
                        source_id = source.get("sourceId", "")
                        quote = source.get("quoteCandidate", "")
                        if (
                            source_id.startswith(("synthetic-", "fixture-", "smoke-"))
                            and isinstance(quote, str)
                            and 0 < len(quote) <= 96
                        ):
                            references = [{"sourceId": source_id, "quote": quote}]
                            break
                except (ValueError, TypeError, AttributeError):
                    pass
            if references:
                break
        agent = "AGENT_JSON_REPLY" in text
        structured_reply = {
            "message" if agent else "answer": message,
            "status": "answered",
            "evidenceRefs": references,
        }
        if agent:
            structured_reply["variableUpdates"] = {}
        content = json.dumps(structured_reply) if structured else message
        with _lock:
            _counts["success"] += 1
        if body.get("stream"):
            ident = "chatcmpl-synthetic-" + str(time.time_ns())
            data = (
                "data: "
                + json.dumps(
                    {
                        "id": ident,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": "ptr-synthetic",
                        "choices": [
                            {
                                "index": 0,
                                "delta": {"role": "assistant", "content": content},
                                "finish_reason": None,
                            }
                        ],
                    }
                )
                + "\n\n"
            )
            data += (
                "data: "
                + json.dumps(
                    {
                        "id": ident,
                        "object": "chat.completion.chunk",
                        "created": int(time.time()),
                        "model": "ptr-synthetic",
                        "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                        "usage": {"prompt_tokens": 16, "completion_tokens": 12, "total_tokens": 28},
                    }
                )
                + "\n\ndata: [DONE]\n\n"
            )
            encoded = data.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            try:
                self.wfile.write(encoded)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        return self.reply(
            200,
            {
                "id": "chatcmpl-synthetic-" + str(time.time_ns()),
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "ptr-synthetic",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": content},
                    }
                ],
                "usage": {"prompt_tokens": 16, "completion_tokens": 12, "total_tokens": 28},
            },
        )


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
