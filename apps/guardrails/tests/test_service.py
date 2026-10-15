# ruff: noqa: E402
# Standalone unittest path setup and telemetry environment must precede Guardrails imports.
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).parents[1]
sys.path.insert(0, str(ROOT))
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["GUARDRAILS_TELEMETRY_ENABLED"] = "false"

from fastapi.testclient import TestClient
from guardrails import Guard
from policy import CATEGORIES, reply_decision
from service import create_app
from validators import JevInput, PersonaOutput, validate_input, validate_output

TOKEN = "synthetic-test-token-only"
HEADERS = {"Authorization": "Bearer " + TOKEN}
THRESHOLDS = dict.fromkeys(CATEGORIES, 0.5) | {"self_harm": 0.2, "illegal_dangerous": 0.6}


class DomainPolicyTests(unittest.TestCase):
    def test_all_pinned_synthetic_fixtures(self):
        fixtures = json.loads((ROOT / "tests/policy_fixtures.json").read_text())
        for fixture in fixtures:
            source = fixture["input"]
            with self.subTest(source=source):
                self.assertEqual(reply_decision(source["reply"], source), fixture["expected"])

    def test_actual_guard_custom_validator_executes_all_fixtures(self):
        fixtures = json.loads((ROOT / "tests/policy_fixtures.json").read_text())
        for fixture in fixtures:
            source = fixture["input"]
            with self.subTest(source=source):
                actual = validate_output(source["reply"], source)
                expected = fixture["expected"] or {"content": source["reply"]}
                self.assertEqual(actual, expected)

    def test_priority_and_ties(self):
        metadata = {"probabilities": dict.fromkeys(CATEGORIES, 0.8), "thresholds": THRESHOLDS}
        self.assertEqual(validate_input("synthetic", metadata)["category"], "self_harm")
        metadata["probabilities"]["self_harm"] = 0
        self.assertEqual(validate_input("synthetic", metadata)["category"], "sexual")
        metadata["probabilities"] = {"prompt_injection": 0.9}
        self.assertEqual(validate_input("synthetic", metadata)["action"], "deflect")
        metadata["probabilities"] = {"self_harm": 0.19}
        self.assertEqual(validate_input("synthetic", metadata), {"action": "none", "fired": []})

    def test_no_socket_connection_during_validation_and_telemetry_disabled(self):
        from guardrails.settings import settings

        metadata = {"probabilities": {"self_harm": 0.8}, "thresholds": THRESHOLDS}
        with patch(
            "socket.socket.connect", side_effect=AssertionError("network forbidden")
        ) as connect:
            self.assertEqual(validate_input("synthetic", metadata)["action"], "support")
            validate_output(
                "I am a real person.", {"utterance": "hello", "realPerson": True, "language": "en"}
            )
            connect.assert_not_called()
        self.assertIs(settings.rc.enable_metrics, False)
        self.assertIs(settings.rc.use_remote_inferencing, False)
        self.assertFalse(settings.rc.token)

    def test_real_guard_types_not_a_replacement_framework(self):
        self.assertIsInstance(Guard(use_server=False).use(JevInput(on_fail="noop")), Guard)
        self.assertIsInstance(Guard(use_server=False).use(PersonaOutput(on_fail="fix")), Guard)


class HttpContractTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(create_app(TOKEN))

    def test_token_is_required_and_health_is_static(self):
        self.assertEqual(self.client.get("/health").json()["framework"], "guardrails-ai")
        response = self.client.post(
            "/validate/output", json={"text": "private-sentinel", "metadata": {}}
        )
        self.assertEqual(response.status_code, 401)
        self.assertNotIn("private-sentinel", response.text)
        with self.assertRaises(RuntimeError):
            create_app("")

    def test_output_contract_replaces_and_edits(self):
        metadata = {
            "utterance": "너 AI야?",
            "realPerson": True,
            "language": "ko",
            "level": "casual",
        }
        response = self.client.post(
            "/validate/output", headers=HEADERS, json={"text": "나 사람이야!", "metadata": metadata}
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["reason"], "human_impersonation")
        self.assertIn("AI", response.json()["content"])

    def test_output_accepts_bounded_previous_reply_and_turn_seed(self):
        previous = "에이, 그건 비밀이에요~ 대신 요즘 어떻게 지내세요?"
        metadata = {
            "utterance": "가족 있어?",
            "realPerson": True,
            "language": "ko",
            "previousAssistantText": previous,
            "turnId": "synthetic-turn-42",
        }
        response = self.client.post(
            "/validate/output",
            headers=HEADERS,
            json={"text": "글쎄", "metadata": metadata},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["reason"], "private_life")
        self.assertNotEqual(response.json()["content"], previous)
        for key, value in (("previousAssistantText", "x" * 64001), ("turnId", "x" * 129)):
            invalid = self.client.post(
                "/validate/output",
                headers=HEADERS,
                json={"text": "글쎄", "metadata": {**metadata, key: value}},
            )
            self.assertEqual(invalid.status_code, 422)
            self.assertNotIn(value, invalid.text)

    def test_input_contract_and_no_duplicate_jev_call(self):
        intent = {
            "label": "small_talk",
            "confidence": 0.8,
            "probabilities": {"timeline": 0.2, "small_talk": 0.8},
        }
        response = self.client.post(
            "/validate/input",
            headers=HEADERS,
            json={
                "text": "synthetic",
                "metadata": {
                    "probabilities": {"self_harm": 0.8},
                    "thresholds": THRESHOLDS,
                    "categories": ["self_harm"],
                    "intent": intent,
                },
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["action"], "support")
        self.assertEqual(response.json()["intent"], intent)

    def test_incomplete_jev_is_not_reported_as_safe(self):
        response = self.client.post(
            "/validate/input",
            headers=HEADERS,
            json={
                "text": "synthetic",
                "metadata": {
                    "probabilities": {},
                    "thresholds": THRESHOLDS,
                    "categories": ["self_harm"],
                },
            },
        )
        self.assertEqual(response.status_code, 422)

    def test_full_context_and_input_jev_on_output_are_rejected_without_echo(self):
        for extra in ({"ragContext": "private-rag-sentinel"}, {"probabilities": {"self_harm": 0}}):
            response = self.client.post(
                "/validate/output",
                headers=HEADERS,
                json={
                    "text": "synthetic",
                    "metadata": {
                        "utterance": "hello",
                        "realPerson": False,
                        "language": "en",
                        **extra,
                    },
                },
            )
            self.assertEqual(response.status_code, 422)
            self.assertNotIn("private-rag-sentinel", response.text)

    def test_explicit_rules_only_executes_real_guard_without_fake_jev_probabilities(self):
        metadata = {
            "classification": "rules-only",
            "probabilities": {},
            "thresholds": THRESHOLDS,
            "categories": list(CATEGORIES),
        }
        for text, expected in (
            ("Hello, how is painting?", "none"),
            ("Where do you live?", "refuse"),
            ("What's your phone number?", "refuse"),
        ):
            response = self.client.post(
                "/validate/input", headers=HEADERS, json={"text": text, "metadata": metadata}
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["action"], expected)
            self.assertNotIn("probabilities", response.json())

    def test_rules_only_does_not_accept_jev_probabilities_or_default_to_jev_when_empty(self):
        for metadata in (
            {
                "classification": "rules-only",
                "probabilities": {"self_harm": 0.8},
                "thresholds": THRESHOLDS,
                "categories": ["self_harm"],
            },
            {
                "classification": "jev",
                "probabilities": {},
                "thresholds": THRESHOLDS,
                "categories": list(CATEGORIES),
            },
        ):
            response = self.client.post(
                "/validate/input", headers=HEADERS, json={"text": "synthetic", "metadata": metadata}
            )
            self.assertEqual(response.status_code, 422)

    def test_nan_unknown_and_missing_thresholds_are_rejected(self):
        for thresholds in (
            dict.fromkeys(CATEGORIES, 2),
            {"self_harm": 0.2},
            THRESHOLDS | {"unknown": 0.5},
        ):
            response = self.client.post(
                "/validate/input",
                headers=HEADERS,
                json={
                    "text": "synthetic",
                    "metadata": {
                        "probabilities": {"self_harm": 0},
                        "thresholds": thresholds,
                        "categories": ["self_harm"],
                    },
                },
            )
            self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
