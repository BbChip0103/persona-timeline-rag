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


@pytest.mark.parametrize("spillover", ["off", "openrouter", None])
def test_live_worker_spillover_must_be_off(tmp_path, spillover):
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
    else:
        assert module.read_worker_model_config(worker_env) == {
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
    assert all(not module.FIXTURE_WORDS.search(text) for _, text in module.SCENARIOS)
    assert module.classifier_accuracy()["accuracy"] >= 0.95
    assert module.classify("안녕!") == "casual"
    assert module.classify("안녕하세요.") == "polite"


def test_speech_classifier_uses_prior_complete_sentence_for_elliptical_ending():
    module = gate()
    assert module.classify("좋아요. 어땠어요? 그날은?") == "polite"
    assert module.classify("좋아! 어땠어? 오늘 하루?") == "casual"
    assert module.classify("정말 재밌었어? 나도 보고 싶었는데.") == "casual"
    assert module.classify("그건 정말 즐거워!") == "casual"


@pytest.mark.parametrize("reply", ["음… 그거 기억이 가물가물해.", "어? 그게 언제였더라~",
    "아, 그때 참 좋더라고.", "헉, 편지 써?", "오! 그랬더라."])
def test_leading_interjections_and_casual_endings(reply):
    assert gate().classify(reply) == "casual"


@pytest.mark.parametrize("reply", ["음…", "어?", "아,", "헉", "오!"])
def test_interjection_alone_remains_unknown(reply):
    assert gate().classify(reply) == "unknown"


@pytest.mark.parametrize(("reply", "expected"), [
    ("좋아요. 나도 보고 싶었는데.", "mixed"),
    ("도와주셔서 고마워!", "mixed"),
    ("그렇게 해주셔서 좋아.", "mixed"),
])
def test_register_negatives_remain_failures(reply, expected):
    assert gate().classify(reply) == expected


@pytest.mark.parametrize(("reply", "expected"), [
    ("좋아요. 그런데 너는 어때?", "mixed"),
    ("응, 좋아. 더 말씀해 주세요.", "mixed"),
    ("도와주셔서 고마워!", "mixed"),
    ("그렇게 해주셔서 좋아.", "mixed"),
    ("그렇게 하세요.", "polite"),
    ("좋아요. 나도 보고 싶었는데.", "mixed"),
    ("좋아요. 오늘 하루?", "polite"),
])
def test_speech_classifier_detects_mixed_sentences_and_honorific_slips(reply, expected):
    assert gate().classify(reply) == expected


def test_mixed_register_is_a_speech_mismatch_even_if_last_sentence_matches():
    module = gate()
    rows = [{"persona": "synthetic", "level": "casual", "index": 0,
             "kind": "small_talk", "user": "안녕?",
             "reply": {"content": "좋아요. 너는 어때?"}}]
    result = module.evaluate(rows, 0, module.classifier_accuracy(), True)
    assert result["metrics"]["speech_consistency"]["value"] == 0
    assert len(result["failing_examples"]["speech_consistency"]) == 1


def test_rejudge_preserves_raw_metrics_and_revalidates_classifier(tmp_path, monkeypatch, capsys):
    import json
    import sys

    module = gate()
    monkeypatch.setattr(module, "ROOT", tmp_path)
    folder = tmp_path / "reports" / "immersion-gate"
    folder.mkdir(parents=True)
    path = folder / "synthetic.private.json"
    original = {"value": 0.25, "threshold": ">=0.95", "pass": False}
    path.write_text(json.dumps({
        "stack": {"database": "ptr_split_test"},
        "turns": [{"persona": "synthetic", "level": "casual", "index": i,
                   "kind": "small_talk", "user": "안녕?", "reply": {"content": "안녕!"}}
                  for i in range(80)],
        "metrics": {"speech_consistency": original},
        "classifier_validation": {"accuracy": 0, "errors": ["stale"]},
    }))
    path.chmod(0o600)
    monkeypatch.setattr(sys, "argv", ["immersion-gate.py", "--rejudge", str(path)])
    module.run()
    report = json.loads(path.read_text())
    printed = json.loads(capsys.readouterr().out)
    assert report["classifier_validation"] == module.classifier_accuracy()
    assert report["raw_metrics"]["speech_consistency"] == original
    assert printed["raw_metrics"] == report["raw_metrics"]
    assert printed["rejudged_metrics"] == report["metrics"]


def test_fixture_words_in_replies_fail_judge():
    module = gate()
    rows = [{"persona": "gate-person", "level": "casual", "index": index,
             "kind": "small_talk", "user": "요즘 뭐 해?",
             "reply": {"content": "가상 이야기야." if index == 0 else "오늘은 쉬고 있어~"}}
            for index in range(80)]
    result = module.evaluate(rows, 0, module.classifier_accuracy(), True)
    assert result["metrics"]["fixture_words_in_replies"]["value"] == 1
    assert not result["metrics"]["fixture_words_in_replies"]["pass"]


def test_published_gate_cards_and_timelines_hide_fixture_markers(tmp_path, monkeypatch):
    import json

    module = gate()
    documents = []
    queries = []
    class Database:
        def __enter__(self): return self
        def __exit__(self, *_): return None
        def execute(self, query, params=()):
            queries.append(query)
            assert query.count("%s") == len(params)
            if query.startswith("INSERT INTO llm.persona_versions"):
                documents.append(json.loads(params[2]))
            if query.startswith("INSERT INTO llm.source_posts"):
                documents.append(json.loads(params[-1]))
            return self
        def fetchall(self):
            return [(card,) for card in documents if "reviewStatus" in card]
    monkeypatch.setattr(module.psycopg, "connect", lambda *_args, **_kwargs: Database())
    published = module.personas("postgresql://local", tmp_path)
    cards = json.loads(published.read_text())["personas"]
    assert len(cards) == 2
    assert all(card["reviewStatus"] == "silver" for card in cards)
    assert all(not module.FIXTURE_WORDS.search(json.dumps(item, ensure_ascii=False))
               for item in documents)
    assert not any(query.startswith("DELETE") for query in queries)
    assert any("WHERE p.id IN" in query for query in queries)


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
