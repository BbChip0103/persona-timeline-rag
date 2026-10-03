import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "usage_recorder", Path(__file__).parents[1] / "scripts/record-codex-usage.py"
)
assert spec and spec.loader
recorder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(recorder)


class UsageRecorderTests(unittest.TestCase):
    def test_counts_usage_once_not_cumulative_and_respects_since(self):
        records = [
            {
                "type": "token_usage_record",
                "timestamp": "2026-10-02T10:00:00Z",
                "payload": {"response_id": "old", "usage": {"input_tokens": 99}},
            },
            {
                "type": "token_count",
                "timestamp": "2026-10-03T10:00:00Z",
                "payload": {"input_tokens": 100000},
            },
            {
                "type": "token_usage_record",
                "timestamp": "2026-10-03T10:00:00Z",
                "payload": {
                    "response_id": "new",
                    "usage": {
                        "input_tokens": 10,
                        "cached_input_tokens": 8,
                        "output_tokens": 3,
                        "reasoning_output_tokens": 1,
                        "total_tokens": 13,
                    },
                },
            },
        ]
        records.append(records[-1])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "usage.jsonl"
            path.write_text("\n".join(json.dumps(row) for row in records) + "\n{partial")
            result = recorder.tally(path, "2026-10-03T00:00:00Z")
        self.assertEqual(result["response_records"], 1)
        self.assertEqual(result["tokens"]["total_tokens"], 13)
        self.assertEqual(result["tokens"]["cached_input_tokens"], 8)
        self.assertEqual(result["tokens"]["reasoning_output_tokens"], 1)
