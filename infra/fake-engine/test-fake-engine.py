#!/usr/bin/env python3
"""Synthetic-engine contract tests; no proxy substitutes and no external connections."""

import importlib.util
import json
import os
import socket
import threading
import unittest
import urllib.request
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "synthetic_engine", Path(__file__).with_name("fake-engine.py")
)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class FixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = fixture.ThreadingHTTPServer(("127.0.0.1", 0), fixture.Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:" + str(cls.server.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def call(
        self,
        source="fixture-source",
        stream=False,
        agent=True,
        request_id=None,
        user=None,
        timeout=2,
    ):
        messages = [
            {"role": "system", "content": "AGENT_JSON_REPLY" if agent else "TIMELINE_JSON_REPLY"},
            {
                "role": "user",
                "content": "UNTRUSTED_EVIDENCE_JSON_DATA "
                + json.dumps(
                    [
                        {
                            "sourceId": source,
                            "quoteCandidate": "A synthetic scene.",
                            "caption": "A synthetic scene.",
                        }
                    ]
                ),
            },
            {"role": "user", "content": user or "Synthetic question"},
        ]
        body = {
            "model": "ptr-synthetic",
            "messages": messages,
            "response_format": {"type": "json_schema"},
            "stream": stream,
        }
        headers = {"Content-Type": "application/json"}
        if request_id:
            headers["X-Request-Id"] = request_id
        req = urllib.request.Request(
            self.base + "/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=timeout) as response:
            return response.read().decode()

    def test_json_and_sse_have_identical_content_and_usage(self):
        direct = json.loads(self.call())
        sse = self.call(stream=True)
        events = [
            json.loads(line[6:])
            for line in sse.splitlines()
            if line.startswith("data: ") and line != "data: [DONE]"
        ]
        self.assertEqual(
            events[0]["choices"][0]["delta"]["content"], direct["choices"][0]["message"]["content"]
        )
        self.assertEqual(events[-1]["usage"], direct["usage"])
        self.assertIn("data: [DONE]", sse)

    def test_grounded_agent_and_historical_timeline_shapes(self):
        agent = json.loads(json.loads(self.call())["choices"][0]["message"]["content"])
        self.assertEqual(
            agent["evidenceRefs"], [{"sourceId": "fixture-source", "quote": "A synthetic scene."}]
        )
        self.assertEqual(agent["variableUpdates"], {})
        timeline = json.loads(
            json.loads(self.call(agent=False))["choices"][0]["message"]["content"]
        )
        self.assertIn("answer", timeline)
        self.assertNotIn("message", timeline)
        self.assertNotIn("variableUpdates", timeline)

    def test_unapproved_source_prefix_never_echoed(self):
        result = json.loads(
            json.loads(self.call(source="real-person-post"))["choices"][0]["message"]["content"]
        )
        self.assertEqual(result["evidenceRefs"], [])
        self.assertNotIn("real-person-post", json.dumps(result))

    def test_counts_report_fixed_model_configuration_not_prompts(self):
        self.call(request_id="fixture-duplicate")
        self.call(request_id="fixture-duplicate")
        with urllib.request.urlopen(self.base + "/counts", timeout=2) as response:
            counts = json.load(response)
        self.assertEqual(counts["effective_delay_ms"], 100)
        self.assertEqual(counts["prompt_tokens"], 16)
        self.assertEqual(counts["completion_tokens"], 12)
        self.assertNotIn("messages", counts)
        self.assertNotIn("authorization", counts)
        self.assertIn("fixture-duplicate", counts["request_ids"])
        self.assertEqual(counts["duplicates"]["fixture-duplicate"], 2)

    def test_chunked_request_without_content_length_is_accepted(self):
        body = json.dumps(
            {
                "model": "ptr-synthetic",
                "messages": [
                    {"role": "system", "content": "TIMELINE_JSON_REPLY"},
                    {"role": "user", "content": "Synthetic chunked question"},
                ],
            }
        ).encode()
        chunks = [body[:17], body[17:]]
        request = [
            b"POST /v1/chat/completions HTTP/1.1\r\n",
            f"Host: 127.0.0.1:{self.server.server_port}\r\n".encode(),
            b"Content-Type: application/json\r\n",
            b"Transfer-Encoding: chunked\r\n",
            b"Connection: close\r\n\r\n",
        ]
        for chunk in chunks:
            request.extend([f"{len(chunk):x}\r\n".encode(), chunk, b"\r\n"])
        request.append(b"0\r\n\r\n")
        with socket.create_connection(("127.0.0.1", self.server.server_port), timeout=2) as sock:
            sock.sendall(b"".join(request))
            response = b""
            while True:
                part = sock.recv(8192)
                if not part:
                    break
                response += part
        self.assertTrue(response.startswith(b"HTTP/1.0 200 OK"), response[:80])

    def test_generation_stall_marker_leaves_health_ok(self):
        os.environ["PTR_SYNTHETIC_ENGINE_GENERATION_STALL_MS"] = "250"
        try:
            with self.assertRaises(TimeoutError):
                self.call(
                    user="__STALL_GENERATION__",
                    request_id="fixture-stall-generation",
                    timeout=0.05,
                )
            with urllib.request.urlopen(self.base + "/health", timeout=2) as response:
                self.assertEqual(response.status, 200)
            with urllib.request.urlopen(self.base + "/counts", timeout=2) as response:
                counts = json.load(response)
            self.assertGreaterEqual(counts["stalled_generation"], 1)
        finally:
            os.environ.pop("PTR_SYNTHETIC_ENGINE_GENERATION_STALL_MS", None)

    def test_generation_stall_once_only_delays_first_call_for_marker(self):
        os.environ["PTR_SYNTHETIC_ENGINE_GENERATION_STALL_MS"] = "250"
        marker = "K4_ID:fixture-once __STALL_GENERATION_ONCE__"
        try:
            with urllib.request.urlopen(self.base + "/counts", timeout=2) as response:
                before = json.load(response)["stalled_generation"]
            with self.assertRaises(TimeoutError):
                self.call(user=marker, request_id="fixture-once-first", timeout=0.05)
            self.call(user=marker, request_id="fixture-once-retry")
            with urllib.request.urlopen(self.base + "/counts", timeout=2) as response:
                counts = json.load(response)
            self.assertEqual(counts["stalled_generation"] - before, 1)
            self.assertEqual(
                counts["marker_request_ids"]["fixture-once"],
                ["fixture-once-first", "fixture-once-retry"],
            )
        finally:
            os.environ.pop("PTR_SYNTHETIC_ENGINE_GENERATION_STALL_MS", None)

    def test_health_stall_mode_is_opt_in(self):
        os.environ["PTR_SYNTHETIC_ENGINE_STALL_MODE"] = "health"
        os.environ["PTR_SYNTHETIC_ENGINE_HEALTH_STALL_MS"] = "250"
        try:
            with self.assertRaises(TimeoutError):
                urllib.request.urlopen(self.base + "/health", timeout=0.05)
            with urllib.request.urlopen(self.base + "/counts", timeout=2) as response:
                counts = json.load(response)
            self.assertGreaterEqual(counts["stalled_health"], 1)
        finally:
            os.environ.pop("PTR_SYNTHETIC_ENGINE_STALL_MODE", None)
            os.environ.pop("PTR_SYNTHETIC_ENGINE_HEALTH_STALL_MS", None)


if __name__ == "__main__":
    unittest.main()
