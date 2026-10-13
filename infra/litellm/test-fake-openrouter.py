#!/usr/bin/env python3
"""Fake OpenRouter fixture contracts; synthetic and no network calls."""

import importlib.util
import os
import sys
import unittest
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
                "x-litellm-response-cost": "0.000123000000",
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


if __name__ == "__main__":
    unittest.main()
