"""Existing synthetic v7 policy is the migration's locked behavior."""

import json
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).parents[3]
FIXTURES = json.loads((ROOT / "apps/guardrails/tests/policy_fixtures.json").read_text())


@pytest.mark.parametrize("fixture", FIXTURES)
def test_frozen_reply_policy(fixture):
    from ptr_llm.core.guardrails import validate_output

    source = fixture["input"]
    assert validate_output(source["reply"], source) == (
        fixture["expected"] or {"content": source["reply"]}
    )


def test_inline_import_does_not_disable_application_tracing():
    before = {key: os.environ.get(key) for key in ("HOME", "OTEL_SDK_DISABLED")}
    from ptr_llm.core.guardrails import validate_input

    assert validate_input("hello", {"classification": "rules-only"}) == {
        "action": "none",
        "fired": [],
    }
    assert before == {key: os.environ.get(key) for key in before}


def test_inline_guard_never_opens_network_and_drops_request_history(monkeypatch):
    import socket

    from ptr_llm.core.guardrails import _get_guard, validate_output

    def forbidden(*args, **kwargs):
        raise AssertionError("network forbidden")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    assert (
        validate_output(
            "I am a real person.", {"utterance": "hello", "realPerson": True, "language": "en"}
        )["reason"]
        == "human_impersonation"
    )
    assert len(_get_guard("output").history) == 0


def test_security_patterns_keep_js_boundary_and_unicode_whitespace():
    from ptr_llm.core.safety import contains_credential, contains_internal_path

    assert contains_credential("한글sk-syntheticsecret")
    assert contains_credential("Bearer\u00a0syntheticsecret")
    assert contains_internal_path("한글C:\\Users\\synthetic")
