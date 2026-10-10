#!/usr/bin/env python3
"""Synthetic OpenAI chat fixture ONLY. Never a replacement for real LiteLLM or vLLM."""

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

_delay_ms = int(os.environ.get("PTR_SYNTHETIC_ENGINE_DELAY_MS", "100"))
if not 0 <= _delay_ms <= 1000:
    raise ValueError("Synthetic fixture delay out of bounds")
_lock = threading.Lock()
_counts = {
    "submitted": 0,
    "success": 0,
    "failed": 0,
    "timeout": 0,
    "active": 0,
    "max_active": 0,
    "effective_delay_ms": _delay_ms,
    "prompt_tokens": 16,
    "completion_tokens": 12,
}


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
            return self.reply(200, {"status": "synthetic"})
        if self.path == "/counts":
            with _lock:
                counts = dict(_counts)
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
        length = int(self.headers.get("Content-Length", "0"))
        if length < 1 or length > 262144:
            return self.reply(413, {"error": "bounded_input"})
        try:
            body = json.loads(self.rfile.read(length))
            text = " ".join(str(item.get("content", "")) for item in body["messages"])
        except (ValueError, KeyError, TypeError):
            return self.reply(400, {"error": "invalid_fixture_input"})
        with _lock:
            _counts["submitted"] += 1
            _counts["active"] += 1
            _counts["max_active"] = max(_counts["active"], _counts["max_active"])
            self._submitted = True
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
