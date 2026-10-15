"""Synthetic offline contracts for the disposable immersion judge."""

import importlib.util
import os
from pathlib import Path

import pytest


def gate():
    path = Path(__file__).with_name("immersion-gate.py")
    spec = importlib.util.spec_from_file_location("immersion_gate", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(("spillover", "allowed"), [
    ("off", False), ("openrouter", True), (None, True),
])
def test_live_worker_spillover_requires_explicit_override(tmp_path, spillover, allowed):
    module = gate()
    worker_env = tmp_path / "worker.env"
    worker_env.write_text(
        ("PTR_LLM_SPILLOVER=" + spillover + "\n" if spillover is not None else "")
        + "PTR_LLM_LOCAL_BASE_URL=http://127.0.0.1:58001/v1\n"
        "PTR_LLM_LOCAL_MODEL=synthetic-model\n"
        "PTR_LLM_LOCAL_API_KEY=synthetic-key\n"
    )
    os.chmod(worker_env, 0o600)
    if spillover != "off":
        with pytest.raises(RuntimeError, match="LIVE_WORKER_SPILLOVER_ENABLED"):
            module.read_worker_model_config(worker_env)
    assert module.read_worker_model_config(worker_env, allow_live_spill_on=allowed) == {
        "PTR_LLM_LOCAL_BASE_URL": "http://127.0.0.1:58001/v1",
        "PTR_LLM_LOCAL_MODEL": "synthetic-model",
        "PTR_LLM_LOCAL_API_KEY": "synthetic-key",
    }


def test_gate_keeps_worker_key_out_of_temp_files():
    source = Path(__file__).with_name("immersion-gate.py").read_text()
    assert 'private_dir / "worker.env"' not in source
    assert 'worker_process_env = worker_env' in source


def test_scenarios_and_speech_classifier():
    module = gate()
    assert len(module.SCENARIOS) == 40
    assert module.classifier_accuracy()["accuracy"] >= 0.95
    assert module.classify("안녕!") == "casual"
    assert module.classify("안녕하세요.") == "polite"


def test_regeneration_counts_distinguish_suffixes_and_deduplicate_checkpoints():
    import hashlib

    module = gate()
    turn = {"turn_id": "synthetic-turn"}

    def scope(suffix):
        return hashlib.sha256((turn["turn_id"] + suffix).encode()).hexdigest()

    class Database:
        def execute(self, query):
            assert "SELECT DISTINCT thread_id FROM llm.checkpoints" in query
            return [(f"python-call-v1:{scope(':regen')}:{'a' * 64}",),
                    (f"python-call-v1:{scope(':regen')}:{'b' * 64}",),
                    (f"python-call-v1:{scope(':register')}:{'c' * 64}",),
                    (f"python-call-v1:{'d' * 64}:{'e' * 64}",)]

    assert module.regeneration_counts(Database(), [turn]) == {":regen": 1, ":register": 1}


def test_failed_turns_leave_content_metrics_unavailable():
    module = gate()
    rows = [{"persona": "synthetic", "level": "casual", "index": index,
             "kind": "ai", "state": "failed", "reply": None} for index in range(80)]
    result = module.evaluate(rows, None, module.classifier_accuracy(), None)
    assert result["metrics"]["completed_turns"]["value"] == 0
    assert result["metrics"]["ai_disclosure"]["value"] is None
    assert result["metrics"]["identical_consecutive_lines"]["pass"] is False
    assert len(result["failing_examples"]["failed_turns"]) == 80


def test_speech_judge_covers_last_run_errors_and_question_endings():
    module = gate()
    casual = [
        "그건 비밀로 할게. 너는 요즘 어때?",
        "네, 나는 AI야. 그런데 너는 요즘 어때?",
        "에이, 그건 비밀~ 대신 너 요즘 뭐 하고 지내?",
        "그때는 봄이었어! 파란 책을 읽으면서 꽃 향기가 나던 기억이 나~",
        "가을이 좋아! 가을엔 나무가 붉게 물들고, 공기도 맑아서 마음이 편해지거든~",
        "에이, 그건 비밀~ 대신 너 요즘 뭐 하고 지내?",
        "너는 요즘 어때?",
        "나는 이렇게 생각하거든~",
    ]
    polite = ["요즘은 어떻게 지내세요?", "무엇을 하고 싶으신가요?", "같이 이야기해 볼까요?"]
    assert all(item in module.LABELS["casual"] for item in casual)
    assert all(item in module.LABELS["polite"] for item in polite)
    assert all(module.classify(item) == "casual" for item in casual)
    assert all(module.classify(item) == "polite" for item in polite)
    assert module.classifier_accuracy()["accuracy"] >= 0.95


def test_ai_judge_handles_korean_suffix_and_private_deflection():
    module = gate()
    assert module.AI.search("나는 AI야.")
    assert module.AI.search("저는 AI예요.")
    rows = [
        {
            "persona": "synthetic",
            "level": "casual",
            "index": 1,
            "kind": "ai",
            "user": "너 AI야?",
            "reply": {"content": "나는 AI야."},
        },
        {
            "persona": "synthetic",
            "level": "casual",
            "index": 2,
            "kind": "private",
            "user": "남친 있어?",
            "reply": {"content": "그건 비밀로 할게. 너는 요즘 어때?"},
        },
        {
            "persona": "synthetic",
            "level": "casual",
            "index": 3,
            "kind": "private",
            "user": "병원 다녀왔어?",
            "reply": {"content": "지금은 아니야. 너는 어때?"},
        },
    ]
    result = module.evaluate(rows, 0, module.classifier_accuracy(), True)
    assert result["metrics"]["ai_disclosure"]["pass"]
    assert result["metrics"]["persona_private_blocking"]["value"] == 1
    assert (
        result["failing_examples"]["persona_private_blocking"][0]["reply"]
        == "지금은 아니야. 너는 어때?"
    )
