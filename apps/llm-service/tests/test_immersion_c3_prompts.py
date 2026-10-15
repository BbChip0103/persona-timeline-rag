"""Synthetic contracts for natural recollection; no provider calls."""

import json

from test_langchain_prompts import PERSONA, source

from ptr_llm.core.prompts import POLICY, build_experiment_context


def test_relative_dates_use_turn_today_and_preserve_original_evidence():
    row = source(1)
    row["postedAt"] = "2023-01-03T00:00:00Z"
    row["eventDate"] = None
    state = [{"role": "system", "content": 'AGENT_STATE_JSON_DATA {"today":"2026-10-15"}'}]
    result = build_experiment_context(PERSONA, [], "기억나?", [row], after_history=state)
    wire = next(
        m["content"]
        for m in result["messages"]
        if m["content"].startswith("UNTRUSTED_EVIDENCE_JSON_DATA ")
    )
    card = json.loads(wire.split(" ", 1)[1])[0]
    assert card["postedAt"] == "약 3년 전 겨울"
    assert card["eventDate"] is None
    assert result["sources"][0]["postedAt"] == row["postedAt"]
    assert card["quoteCandidate"] == row["caption"]


def test_recollection_answer_is_separate_from_exact_quotes():
    policy = POLICY["REPLY_VOICE_POLICY"]
    for phrase in [
        "evidenceRefs only",
        "ISO",
        "게시물",
        "캡션",
        "올린 글",
        "사진 설명",
        "자료",
        "emotion",
        "two or three turns",
        "research",
        "interpretation",
    ]:
        assert phrase in policy
    assert "Copy relevant quoteCandidate unchanged in evidenceRefs only" in POLICY["protocol"]
    assert "labeling inferred intent as interpretation" not in POLICY["EXPERIMENT_POLICY"]
    assert "research AI simulation" not in POLICY["EXPERIMENT_POLICY"]
    assert "research AI simulation" not in POLICY["IDENTITY_PRIVACY_POLICY"]
    assert "research disclaimer" not in POLICY["recollectionVoice"]


async def test_agent_uses_service_speech_level_and_private_clock():
    from test_immersion_c1 import PERSONA as AGENT_PERSONA
    from test_immersion_c1 import Provider, response

    from ptr_llm.core.agent import run_character_agent

    row = source(1)
    row["postedAt"] = "2023-01-03T00:00:00Z"
    provider = Provider([response("합성 답변이에요.")])
    await run_character_agent(
        provider=provider,
        persona=AGENT_PERSONA,
        history=[],
        text="안녕",
        sources=[row],
        variables_state={"speechLevel": "polite"},
        created_at="2026-10-15T23:30:00Z",
        timezone_name="Asia/Seoul",
    )
    state = next(
        m["content"]
        for m in provider.messages[0]
        if m["content"].startswith("AGENT_STATE_JSON_DATA ")
    )
    assert '"speechLevel":"해요체"' in state
    assert state.index('"registerInstruction"') < state.index('"speechLevel"')
    assert '"registerExamples":["~해요.","~인가요?"]' in state
    assert 'Never mix registers in one reply.' in state
    assert '"today":"오늘"' in state
    assert "2026-10-16" not in state
    evidence = next(
        m["content"]
        for m in provider.messages[0]
        if m["content"].startswith("UNTRUSTED_EVIDENCE_JSON_DATA ")
    )
    assert "약 3년 전 겨울" in evidence
    assert "2023-01-03" not in evidence
