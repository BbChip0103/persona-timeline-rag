"""Synthetic rollback proof against an isolated ptr_split_test container."""

import json
import os
import subprocess
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator

ROOT = Path(__file__).resolve().parents[1]
SQL = ROOT / "scripts/rollback-v2-reply.sql"
V1_SCHEMA = ROOT / "contracts/llm/v1/schema.json"


def _psql(container: str, statements: str) -> list[str]:
    result = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            container,
            "psql",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-A",
            "-t",
            "-U",
            "postgres",
            "-d",
            "ptr_split_test",
        ],
        input=statements,
        text=True,
        capture_output=True,
        timeout=20,
        check=True,
    )
    return [line for line in result.stdout.splitlines() if line.startswith("PROOF:")]


@pytest.mark.parametrize("nested_variables", [True, False])
def test_rollback_sql_restores_c2_previous_reply_schema(nested_variables):
    container = os.getenv("PTR_ROLLBACK_TEST_CONTAINER")
    if not container:
        pytest.skip(
            "set PTR_ROLLBACK_TEST_CONTAINER to a synthetic ptr_split_test Postgres container"
        )

    v1 = json.loads(V1_SCHEMA.read_text(encoding="utf-8"))
    validator = Draft202012Validator({**v1, "$ref": "#/$defs/Reply"})
    session_validator = Draft202012Validator({**v1, "$ref": "#/$defs/Session"})
    uid = "00000000-0000-4000-8000-000000000066"
    turn_id = "00000000-0000-4000-8000-000000000067"
    reply = {
        "sessionId": uid,
        "turnId": turn_id,
        "messageId": "00000000-0000-4000-8000-000000000068",
        "personId": "synthetic-person",
        "personaRevision": "synthetic-revision",
        "responseKind": "small_talk",
        "status": "answered",
        "content": "Synthetic reply.",
        "summaryUpdate": {"text": "Synthetic summary", "lastMessageId": "synthetic-message"},
        "userMemoryOps": [{"op": "add", "kind": "like", "text": "Synthetic tea"}],
        "claims": [],
        "evidence": [],
        "limitations": [],
        "agent": {
            "revision": "synthetic-agent",
            "promptRevision": "synthetic-prompt",
            "modelCalls": 0,
            "toolCalls": 0,
            "variables": {
                "conversationTopic": "synthetic-topic",
                "tone": "neutral",
                "speechLevel": "casual",
                "lastYearRecallUsed": True,
                "summary": "synthetic-summary",
                "userMemories": [],
                "userMemoryConsent": False,
                "summaryUpdate": "synthetic-update",
                "userMemoryOps": [],
            },
            "steps": [],
            "validator": "disabled",
        },
    }
    if not nested_variables:
        reply["agent"]["variables"] = {
            "conversationTopic": "synthetic-topic", "tone": "neutral"
        }
    assert not validator.is_valid(reply)
    session = {
        "id": uid,
        "ownerId": "synthetic-owner",
        "personId": "synthetic-person",
        "personaId": "synthetic-persona",
        "personaRevision": "synthetic-revision",
        "language": "en",
        "timezone": "UTC",
        "retrievalMode": "off",
        "createdAt": "2026-10-15T00:00:00Z",
        "userMemoryConsent": True,
    }
    deleted_id = "00000000-0000-4000-8000-000000000069"
    deleted_session = {**session, "id": deleted_id}
    prelude = f"""
BEGIN;
SET LOCAL statement_timeout = '10s';
INSERT INTO app.sessions(id,owner_id,person_id,persona_id,persona_revision,document,created_at)
VALUES (
  '{uid}','synthetic-owner','synthetic-person','synthetic-persona',
  'synthetic-revision','{json.dumps(session)}'::jsonb,now()
);
INSERT INTO app.sessions(
  id,owner_id,person_id,persona_id,persona_revision,document,created_at,deleted_at
)
VALUES ('{deleted_id}','synthetic-owner','synthetic-person','synthetic-persona',
  'synthetic-revision','{json.dumps(deleted_session)}'::jsonb,now(),now());
INSERT INTO app.turns(id,session_id,owner_id,client_request_id,user_text,sequence,state,reply)
VALUES (
  '{turn_id}','{uid}','synthetic-owner','synthetic-rollback',
  'Synthetic input',1,'completed','{json.dumps(reply)}'::jsonb
);
"""
    # The SQL updates only transaction-local synthetic data for this proof.
    with pytest.raises(subprocess.CalledProcessError) as blocked:
        _psql(container, prelude + SQL.read_text(encoding="utf-8") + "\nROLLBACK;\n")
    assert "ROLLBACK_DELETED_SESSIONS_REMAIN" in blocked.value.stderr
    queries = f"""
SELECT 'PROOF:' || reply::text FROM app.turns WHERE id='{turn_id}';
-- This synthetic purge represents the required split-retention pass before rollback.
DELETE FROM app.sessions WHERE id='{deleted_id}' AND deleted_at IS NOT NULL;
{SQL.read_text(encoding="utf-8")}
SELECT 'PROOF:' || reply::text FROM app.turns WHERE id='{turn_id}';
{SQL.read_text(encoding="utf-8")}
SELECT 'PROOF:' || reply::text FROM app.turns WHERE id='{turn_id}';
SELECT 'PROOF:SESSION:' || document::text FROM app.sessions;
ROLLBACK;
"""
    rows = _psql(container, prelude + queries)
    assert len(rows) == 4
    before, cleaned, repeated = [json.loads(row.removeprefix("PROOF:")) for row in rows[:3]]
    assert before == reply
    assert cleaned == repeated
    validator.validate(cleaned)
    session_documents = [json.loads(row.removeprefix("PROOF:SESSION:")) for row in rows[3:]]
    assert len(session_documents) == 1
    assert all(session_validator.is_valid(document) for document in session_documents)
    assert all("userMemoryConsent" not in document for document in session_documents)
    assert cleaned["agent"]["variables"] == {
        "conversationTopic": "synthetic-topic",
        "tone": "neutral",
    }
