# ruff: noqa: E402
import json
import os
import sys
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["GUARDRAILS_TELEMETRY_ENABLED"] = "false"

from fastapi.testclient import TestClient
from policy import CATEGORIES
from service import create_app
from validators import RulesInput, _get_guard, validate_input, validate_output

THRESHOLDS = dict.fromkeys(CATEGORIES, 0.5)
META = {
    "classification": "rules-only",
    "probabilities": {},
    "thresholds": THRESHOLDS,
    "categories": list(CATEGORIES),
}
OUTPUT = {"utterance": "hello", "realPerson": False, "language": "en", "level": "polite"}


class GuardLifecycleTests(unittest.TestCase):
    def test_thread_reuses_real_guard_with_empty_history_and_no_raw_metadata(self):
        guard = _get_guard("rules")
        for index in range(20):
            text = f"SYNTHETIC_RAW_SENTINEL_{index}"
            self.assertEqual(
                validate_input(text, {**META, "utterance": "SYNTHETIC_META_SENTINEL"}),
                {"action": "none", "fired": []},
            )
            self.assertIs(_get_guard("rules"), guard)
            self.assertEqual(list(guard.history), [])
            self.assertNotIn("SYNTHETIC_RAW_SENTINEL", repr(guard.__dict__))
            self.assertNotIn("SYNTHETIC_META_SENTINEL", repr(guard.__dict__))
            for validator in guard._validators:
                self.assertNotIn("SYNTHETIC_RAW_SENTINEL", repr(validator.__dict__))
                self.assertNotIn("SYNTHETIC_META_SENTINEL", repr(validator.__dict__))

    def test_output_guard_keeps_neither_raw_reply_nor_raw_utterance(self):
        guard = _get_guard("output")
        for reply in ("SYNTHETIC_REPLY_SENTINEL", "I am a real person. SYNTHETIC_REPLY_SENTINEL"):
            validate_output(reply, {**OUTPUT, "utterance": "SYNTHETIC_UTTERANCE_SENTINEL"})
            self.assertEqual(list(guard.history), [])
            self.assertNotIn("SYNTHETIC_REPLY_SENTINEL", repr(guard.__dict__))
            self.assertNotIn("SYNTHETIC_UTTERANCE_SENTINEL", repr(guard.__dict__))
            for validator in guard._validators:
                self.assertNotIn("SYNTHETIC_REPLY_SENTINEL", repr(validator.__dict__))
                self.assertNotIn("SYNTHETIC_UTTERANCE_SENTINEL", repr(validator.__dict__))

    def test_metadata_decision_does_not_leak_between_calls_or_validator_kinds(self):
        support = {"probabilities": {"self_harm": 0.9}, "thresholds": THRESHOLDS}
        safe = {"probabilities": {"self_harm": 0}, "thresholds": THRESHOLDS}
        for _ in range(10):
            self.assertEqual(validate_input("synthetic", support)["action"], "support")
            self.assertEqual(validate_input("synthetic", safe), {"action": "none", "fired": []})
            self.assertEqual(validate_input("Where do you live?", META)["action"], "refuse")
            self.assertEqual(validate_input("hello", META)["action"], "none")
            self.assertEqual(
                validate_output("I am a real person.", OUTPUT)["reason"], "human_impersonation"
            )
            self.assertEqual(
                validate_output("A fictional painting.", OUTPUT),
                {"content": "A fictional painting."},
            )
        for kind in ("rules", "jev", "output"):
            self.assertEqual(list(_get_guard(kind).history), [])

    def test_exception_clears_raw_history_and_discards_tainted_guard(self):
        guard = _get_guard("rules")
        with patch.object(
            RulesInput, "_validate", side_effect=RuntimeError("SYNTHETIC_EXCEPTION_SENTINEL")
        ):
            with self.assertRaises(RuntimeError):
                validate_input("SYNTHETIC_FAILED_INPUT_SENTINEL", META)
        self.assertEqual(list(guard.history), [])
        self.assertNotIn("SYNTHETIC_FAILED_INPUT_SENTINEL", repr(guard.__dict__))
        self.assertIsNot(_get_guard("rules"), guard)
        self.assertEqual(validate_input("hello", META)["action"], "none")

    def test_parallel_threads_each_have_distinct_guards_and_all_315_results_match(self):
        fixtures = json.loads((ROOT / "tests/policy_fixtures.json").read_text())
        barrier = threading.Barrier(4)

        def run(_):
            guard = _get_guard("output")
            barrier.wait(timeout=20)
            for _ in range(2):
                for fixture in fixtures:
                    source = fixture["input"]
                    actual = validate_output(source["reply"], source)
                    expected = fixture["expected"] or {"content": source["reply"]}
                    self.assertEqual(actual, expected)
                    self.assertEqual(list(guard.history), [])
            return guard

        with ThreadPoolExecutor(max_workers=4) as pool:
            guards = list(pool.map(run, range(4)))
        self.assertEqual(len({id(guard) for guard in guards}), 4)
        self.assertEqual(len({id(guard._validators[0]) for guard in guards}), 4)
        self.assertTrue(all(not guard.history for guard in guards))

    def test_parallel_http_requests_preserve_decisions_without_shared_history(self):
        app = create_app("synthetic-lifecycle-token")
        headers = {"Authorization": "Bearer synthetic-lifecycle-token"}

        def run(index):
            # Independent clients share only the app; sync endpoints run on worker threads.
            with TestClient(app) as client:
                response = client.post(
                    "/validate/input",
                    headers=headers,
                    json={"text": "Where do you live?" if index % 2 else "hello", "metadata": META},
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["action"], "refuse" if index % 2 else "none")
                response = client.post(
                    "/validate/output",
                    headers=headers,
                    json={
                        "text": "I am a real person." if index % 2 else "A fictional painting.",
                        "metadata": OUTPUT,
                    },
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual("reason" in response.json(), bool(index % 2))

        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(run, range(24)))


if __name__ == "__main__":
    unittest.main()
