#!/usr/bin/env python3
"""Synthetic-engine contract tests; no proxy substitutes and no external connections."""

import importlib.util
import json
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

    def call(self, source="fixture-source", stream=False, agent=True):
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
            {"role": "user", "content": "Synthetic question"},
        ]
        body = {
            "model": "ptr-synthetic",
            "messages": messages,
            "response_format": {"type": "json_schema"},
            "stream": stream,
        }
        req = urllib.request.Request(
            self.base + "/v1/chat/completions",
            data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=2) as response:
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
        with urllib.request.urlopen(self.base + "/counts", timeout=2) as response:
            counts = json.load(response)
        self.assertEqual(counts["effective_delay_ms"], 100)
        self.assertEqual(counts["prompt_tokens"], 16)
        self.assertEqual(counts["completion_tokens"], 12)
        self.assertNotIn("messages", counts)
        self.assertNotIn("authorization", counts)


if __name__ == "__main__":
    unittest.main()
