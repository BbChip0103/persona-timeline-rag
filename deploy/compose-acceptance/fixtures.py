"""Synthetic HTTP fixtures; only listen inside the isolated container namespace."""

import importlib.util
import json
import os
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "kind_fixture", Path("/source/deploy/helm/ptr/files/fake-openrouter/fake-openrouter.py")
)
kind = importlib.util.module_from_spec(spec)
spec.loader.exec_module(kind)


class State:
    def __init__(self):
        self.lock = threading.Lock()
        self.reset()

    def reset(self, mode="ok"):
        self.mode = mode
        self.active = self.maximum = self.local = 0
        self.ids = {}
        if "engine" in globals():
            with engine._lock:
                assert engine._counts["active"] == 0
                for key in (
                    "submitted",
                    "success",
                    "failed",
                    "timeout",
                    "stalled_generation",
                    "stalled_health",
                    "max_active",
                ):
                    engine._counts[key] = 0
                engine._requests.clear()
                engine._marker_requests.clear()
                engine._one_shot_stalls.clear()


state = State()


class Paid(kind.Handler):
    def do_GET(self):
        if state.mode == "check-failure" and self.path == "/api/v1/key":
            self._reply(503, {"error": "synthetic_unavailable"})
        elif state.mode == "no-zdr" and self.path == "/api/v1/endpoints/zdr":
            self._reply(200, {"data": []})
        else:
            super().do_GET()

    def do_POST(self):
        if self.path != "/api/v1/chat/completions":
            self._reply(404, {})
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        marker = kind._request_id(body, self.headers)
        with state.lock:
            state.ids[marker] = state.ids.get(marker, 0) + 1
        if state.mode in ("500", "timeout"):
            if state.mode == "timeout":
                time.sleep(2)
            try:
                self._reply(500, {"error": "synthetic_post_submit_failure"})
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        self._reply(
            200,
            {
                "id": "chatcmpl-fake-openrouter-" + str(time.time_ns()),
                "object": "chat.completion",
                "created": int(time.time()),
                "model": body["model"],
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {"role": "assistant", "content": kind._structured_content(body)},
                    }
                ],
                "usage": kind._usage(),
            },
            kind._response_headers(marker),
        )


# Reuse the repository engine and its native stall/observability controls.
os.environ["PTR_SYNTHETIC_ENGINE_STALL_MODE"] = "generation"
os.environ["PTR_SYNTHETIC_ENGINE_GENERATION_STALL_MS"] = "2300"
os.environ["PTR_SYNTHETIC_ENGINE_DELAY_MS"] = "0"
engine_spec = importlib.util.spec_from_file_location(
    "engine_fixture", Path("/source/infra/fake-engine/fake-engine.py")
)
engine = importlib.util.module_from_spec(engine_spec)
engine_spec.loader.exec_module(engine)
Engine = engine.Handler


def start():
    servers = []
    for port, handler in ((18001, Engine), (18002, Paid)):
        server = ThreadingHTTPServer(("127.0.0.1", port), handler)
        server.daemon_threads = True
        threading.Thread(target=server.serve_forever, daemon=True).start()
        servers.append(server)
    return servers
