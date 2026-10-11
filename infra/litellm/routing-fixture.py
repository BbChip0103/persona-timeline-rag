#!/usr/bin/env python3
"""Authenticated bounded synthetic routing fixture. Never contacts another service."""

import hmac
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ENGINE = os.environ.get("PTR_ROUTING_FIXTURE_ENGINE", "engine-a")
KEY = os.environ.get("PTR_ROUTING_FIXTURE_KEY", "synthetic-only")
LOCK = threading.Lock()
STATE = {
    "delay_ms": 50,
    "metrics_delay_ms": 0,
    "stream_chunks": 1,
    "stream_interval_ms": 0,
    "cancelled": 0,
    "kv": 0.1,
    "waiting": 0,
    "submitted": 0,
    "success": 0,
    "failed": 0,
    "active": 0,
    "max_active": 0,
    "metrics_calls": 0,
    "metrics_active": 0,
    "budget_header_leaks": 0,
}
START = int(time.time())


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Do not log credentials, prompts, URLs, or outputs.

    def reply(self, status, payload, content_type="application/json"):
        data = json.dumps(payload).encode() if isinstance(payload, dict) else payload.encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def authorized(self):
        return hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + KEY)

    def do_GET(self):
        if self.path == "/health":
            return self.reply(200, {"status": "synthetic"})
        if not self.authorized():
            return self.reply(401, {"error": "synthetic_auth_required"})
        if self.path == "/counts":
            with LOCK:
                snapshot = dict(STATE)
            return self.reply(200, snapshot)
        if self.path == "/metrics":
            with LOCK:
                STATE["metrics_calls"] += 1
                STATE["metrics_active"] += 1
                snapshot = dict(STATE)
            try:
                time.sleep(snapshot["metrics_delay_ms"] / 1000)
                return self.reply(
                    200,
                    f"vllm:kv_cache_usage_perc {snapshot['kv']}\n"
                    f"vllm:num_requests_waiting {snapshot['waiting']}\n"
                    f"process_start_time_seconds {START}\n",
                    "text/plain",
                )
            finally:
                with LOCK:
                    STATE["metrics_active"] -= 1
        return self.reply(404, {"error": "not_found"})

    def do_POST(self):
        if self.headers.get("x-ptr-budget-authorization"):
            with LOCK:
                STATE["budget_header_leaks"] += 1
        if not self.authorized():
            return self.reply(401, {"error": "synthetic_auth_required"})
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 < length <= 65536:
            return self.reply(413, {"error": "bounded_input"})
        try:
            body = json.loads(self.rfile.read(length))
        except (ValueError, TypeError):
            return self.reply(400, {"error": "invalid_input"})
        if not isinstance(body, dict):
            return self.reply(400, {"error": "invalid_input"})
        if self.path == "/control":
            bounds = {
                "delay_ms": (0, 3000),
                "metrics_delay_ms": (0, 1500),
                "kv": (0, 1),
                "waiting": (0, 100),
                "stream_chunks": (1, 100),
                "stream_interval_ms": (0, 1000),
            }
            if any(
                name not in bounds
                or isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not bounds[name][0] <= value <= bounds[name][1]
                for name, value in body.items()
            ):
                return self.reply(400, {"error": "bounded_control"})
            with LOCK:
                candidate = dict(STATE, **body)
                if (
                    not isinstance(candidate["stream_chunks"], int)
                    or candidate["stream_chunks"] * candidate["stream_interval_ms"] > 50000
                ):
                    return self.reply(400, {"error": "bounded_stream_duration"})
                STATE.update(body)
            return self.reply(200, {"status": "synthetic_control_applied"})
        if self.path != "/v1/chat/completions" or not isinstance(body.get("messages"), list):
            return self.reply(400, {"error": "synthetic_chat_required"})
        fail = any(item.get("content") == "__FAIL_500__" for item in body["messages"])
        with LOCK:
            STATE["submitted"] += 1
            STATE["active"] += 1
            STATE["max_active"] = max(STATE["max_active"], STATE["active"])
            delay = STATE["delay_ms"]
            stream_chunks = STATE["stream_chunks"]
            stream_interval_ms = STATE["stream_interval_ms"]
        try:
            time.sleep(delay / 1000)
            if fail:
                with LOCK:
                    STATE["failed"] += 1
                return self.reply(
                    500,
                    {"error": {"message": "Synthetic ambiguous failure", "type": "server_error"}},
                )
            common = {"id": "chatcmpl-synthetic", "created": int(time.time()), "model": ENGINE}
            usage = {"prompt_tokens": 16, "completion_tokens": 12, "total_tokens": 28}
            if body.get("stream") and stream_chunks > 1:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Connection", "close")
                self.end_headers()

                def emit(delta, finish=None, final_usage=None):
                    event = dict(
                        common,
                        object="chat.completion.chunk",
                        choices=[{"index": 0, "delta": delta, "finish_reason": finish}],
                    )
                    if final_usage:
                        event["usage"] = final_usage
                    self.wfile.write(("data: " + json.dumps(event) + "\n\n").encode())
                    self.wfile.flush()

                try:
                    emit({"role": "assistant"})
                    for _ in range(stream_chunks):
                        time.sleep(stream_interval_ms / 1000)
                        emit({"content": "Synthetic routing reply " + ENGINE})
                    emit({}, "stop", usage)
                    self.wfile.write(b"data: [DONE]\n\n")
                    self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    with LOCK:
                        STATE["cancelled"] += 1
                    return
                with LOCK:
                    STATE["success"] += 1
                return
            with LOCK:
                STATE["success"] += 1
            if body.get("stream"):
                chunk = dict(
                    common,
                    object="chat.completion.chunk",
                    choices=[
                        {
                            "index": 0,
                            "delta": {
                                "role": "assistant",
                                "content": "Synthetic routing reply " + ENGINE,
                            },
                            "finish_reason": None,
                        }
                    ],
                )
                end = dict(
                    common,
                    object="chat.completion.chunk",
                    choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}],
                    usage=usage,
                )
                return self.reply(
                    200,
                    "data: "
                    + json.dumps(chunk)
                    + "\n\ndata: "
                    + json.dumps(end)
                    + "\n\ndata: [DONE]\n\n",
                    "text/event-stream",
                )
            return self.reply(
                200,
                dict(
                    common,
                    object="chat.completion",
                    choices=[
                        {
                            "index": 0,
                            "message": {
                                "role": "assistant",
                                "content": "Synthetic routing reply " + ENGINE,
                            },
                            "finish_reason": "stop",
                        }
                    ],
                    usage=usage,
                ),
            )
        finally:
            with LOCK:
                STATE["active"] -= 1


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
