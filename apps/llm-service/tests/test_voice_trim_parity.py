from pathlib import Path

from ptr_llm.core.agent import trim_to_sentence


def test_248_character_reply_matches_shared_golden():
    message = "가" * 170 + ". " + "나" * 76
    golden = (
        Path(__file__).resolve().parents[3] / "contracts/voice-trim-248.synthetic.txt"
    ).read_text(encoding="utf-8")

    assert len(message) == 248
    assert golden == "가" * 170 + "."
    assert trim_to_sentence(message) == golden
