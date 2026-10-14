#!/usr/bin/env python3
"""Fake OpenRouter fixture contracts; synthetic and no network calls."""

import importlib.util
import json
import os
import sys
import threading
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

MODULE = Path(__file__).with_name("fake-openrouter.py")


def load_fake_openrouter(*, emit_cost_header: str = "1"):
    name = "fake_openrouter_under_test"
    spec = importlib.util.spec_from_file_location(name, MODULE)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    with patch.dict(os.environ, {"PTR_FAKE_OPENROUTER_EMIT_COST_HEADER": emit_cost_header}):
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return module


class FakeOpenRouterTests(unittest.TestCase):
    def test_cost_header_emitted_by_default(self):
        fake = load_fake_openrouter()
        self.assertEqual(
            fake._response_headers("synthetic-id"),
            {
                "x-openrouter-response-cost": "0.000123000000",
                "x-ptr-provider-request-id": "synthetic-id",
            },
        )

    def test_cost_header_can_be_omitted(self):
        fake = load_fake_openrouter(emit_cost_header="0")
        self.assertEqual(
            fake._response_headers("synthetic-id"),
            {"x-ptr-provider-request-id": "synthetic-id"},
        )
        self.assertNotIn("cost", fake._usage())

    def test_json_schema_reply_passes_agent_shape(self):
        fake = load_fake_openrouter()
        content = fake._structured_content(
            {
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "agent_reply",
                        "strict": True,
                        "schema": {
                            "type": "object",
                            "additionalProperties": False,
                            "required": ["message", "status", "evidenceRefs", "variableUpdates"],
                            "properties": {
                                "message": {"type": "string", "maxLength": 400},
                                "status": {
                                    "type": "string",
                                    "enum": [
                                        "answered",
                                        "insufficient_evidence",
                                        "needs_clarification",
                                        "out_of_scope",
                                    ],
                                },
                                "evidenceRefs": {
                                    "type": "array",
                                    "maxItems": 2,
                                    "items": {"$ref": "#/$defs/evidenceRef"},
                                },
                                "variableUpdates": {
                                    "type": "object",
                                    "additionalProperties": False,
                                    "properties": {
                                        "tone": {
                                            "type": "string",
                                            "enum": ["neutral", "warm", "playful"],
                                        }
                                    },
                                },
                            },
                            "$defs": {
                                "evidenceRef": {
                                    "type": "object",
                                    "required": ["sourceId", "quote"],
                                    "properties": {
                                        "sourceId": {"type": "string", "minLength": 1},
                                        "quote": {"type": "string", "minLength": 1},
                                    },
                                }
                            },
                        },
                    },
                }
            }
        )
        self.assertEqual(
            json.loads(content),
            {
                "message": "Synthetic OpenRouter spillover reply.",
                "status": "answered",
                "evidenceRefs": [],
                "variableUpdates": {},
            },
        )

    def test_json_object_reply_uses_timeline_shape_by_default(self):
        fake = load_fake_openrouter()
        content = fake._structured_content({"response_format": {"type": "json_object"}})
        self.assertEqual(
            json.loads(content),
            {"status": "insufficient_evidence", "answer": "", "evidenceRefs": []},
        )

    def test_json_object_reply_uses_agent_shape_for_agent_prompt(self):
        fake = load_fake_openrouter()
        content = fake._structured_content(
            {
                "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": "AGENT_JSON_REPLY"}],
            }
        )
        self.assertEqual(
            json.loads(content),
            {
                "message": "Synthetic OpenRouter spillover reply.",
                "status": "answered",
                "evidenceRefs": [],
                "variableUpdates": {},
            },
        )

    def test_direct_openrouter_api_paths_are_served_under_api_v1(self):
        fake = load_fake_openrouter()
        server = fake.ThreadingHTTPServer(("127.0.0.1", 0), fake.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        try:
            for path in (
                "/api/v1/models",
                "/api/v1/models/google/gemma-4-26b-a4b-it/endpoints",
                "/api/v1/embeddings/models",
                "/api/v1/endpoints/zdr",
                "/api/v1/key",
            ):
                with urllib.request.urlopen(base + path, timeout=2) as response:
                    payload = json.load(response)
                self.assertIn("data", payload)
                if path == "/api/v1/models":
                    self.assertIn("structured_outputs", payload["data"][0]["supported_parameters"])
            body = json.dumps({"model": "google/gemma-4-26b-a4b-it", "messages": []}).encode()
            request = urllib.request.Request(
                base + "/api/v1/chat/completions",
                data=body,
                headers={"Content-Type": "application/json"},
            )
            with urllib.request.urlopen(request, timeout=2) as response:
                payload = json.load(response)
            self.assertTrue(payload["id"].startswith("chatcmpl-fake-openrouter-"))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == "__main__":
    unittest.main()
