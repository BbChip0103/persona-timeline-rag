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
V2_SCHEMA = ROOT / "contracts/llm/v2/schema.json"


def _enums(value, path=()):
    if isinstance(value, dict):
        if "enum" in value:
            yield "/".join(path), set(value["enum"])
        for key, child in value.items():
            if key != "enum":
                yield from _enums(child, (*path, key))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from _enums(child, (*path, str(index)))


def test_rollback_strips_every_v2_only_reply_key():
    v1 = json.loads(V1_SCHEMA.read_text(encoding="utf-8"))
    v2 = json.loads(V2_SCHEMA.read_text(encoding="utf-8"))
    only_v2 = set(v2["$defs"]["Reply"]["properties"]) - set(
        v1["$defs"]["Reply"]["properties"]
    )
    assert only_v2 == {"operatorMetadata", "operatorTrace"}
    sql = SQL.read_text(encoding="utf-8")
    for key in only_v2:
        assert f"#- '{{{key}}}'" in sql
        assert sql.count(f"'{key}'") >= 2  # WHERE and final check
    v1_variables = v1["$defs"]["Agent"]["properties"]["variables"]["properties"]
    v2_variables = v2["$defs"]["Agent"]["properties"]["variables"]["properties"]
    nested_only_v2 = set(v2_variables) - set(v1_variables)
    assert nested_only_v2 == {"speechLevel", "lastYearRecallUsed"}
    for key in nested_only_v2:
        assert f"#- '{{agent,variables,{key}}}'" in sql
        assert sql.count(f"'{key}'") >= 2  # WHERE and final check
    v1_guard = v1["$defs"]["Reply"]["properties"]["replyGuard"]
    v2_guard = v2["$defs"]["Reply"]["properties"]["replyGuard"]
    assert "replyGuard" not in v1["$defs"]["Reply"]["required"]
    assert set(v2_guard["properties"]["reason"]["enum"]) - set(
        v1_guard["properties"]["reason"]["enum"]
    ) == {"formatting"}
    assert "#- '{replyGuard}'" in sql
    assert sql.count("'{replyGuard,reason}'") >= 2  # WHERE and final check
    v1_enums = dict(_enums(v1))
    v2_only_values = {
        path: values - v1_enums.get(path, set())
        for path, values in _enums(v2)
        if values - v1_enums.get(path, set())
    }
    assert v2_only_values == {
        "$defs/Agent/properties/variables/properties/speechLevel": {"casual", "polite"},
        "$defs/Reply/properties/operatorTrace/properties/path": {
            "model", "fixed", "ask_back", "guard_replacement", "guard_edit",
            "fallback", "regeneration", "register_regeneration", "identity_variant",
            "voice_variant",
        },
        "$defs/Reply/properties/replyGuard/properties/reason": {"formatting"},
        "$defs/UserMemory/properties/kind": {
            "name", "like", "dislike", "recent_event", "other",
        },
        "$defs/UserMemoryOp/properties/kind": {
            "name", "like", "dislike", "recent_event", "other",
        },
    }


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
            os.getenv("PTR_ROLLBACK_TEST_ROLE", "postgres"),
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
@pytest.mark.parametrize("guard_reason", ["formatting", "meta_talk"])
def test_rollback_sql_restores_c2_previous_reply_schema(nested_variables, guard_reason):
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
        "replyGuard": {
            "revision": "synthetic-guard",
            "action": "edited",
            "reason": guard_reason,
        },
        "operatorTrace": {
            "path": "register_regeneration",
            "code": "SYNTHETIC_REGISTER",
            "repeatChecked": True,
            "previousAvailable": True,
        },
        "operatorMetadata": {
            "guardStage": "output_guard",
            "exceptionClass": "ValueError",
            "code": "GUARDRAILS_OUTPUT_UNAVAILABLE",
        },
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
    Draft202012Validator(
        json.loads(V2_SCHEMA.read_text(encoding="utf-8"))["$defs"]["Reply"]["properties"]["replyGuard"]
    ).validate(reply["replyGuard"])
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
SELECT 'PROOF:SESSION:' || document::text FROM app.sessions WHERE id='{uid}';
ROLLBACK;
"""
    rows = _psql(container, prelude + queries)
    assert len(rows) == 4
    before, cleaned, repeated = [json.loads(row.removeprefix("PROOF:")) for row in rows[:3]]
    assert before == reply
    assert cleaned == repeated
    validator.validate(cleaned)
    if guard_reason == "formatting":
        assert "replyGuard" not in cleaned
    else:
        assert cleaned["replyGuard"] == reply["replyGuard"]
    session_documents = [json.loads(row.removeprefix("PROOF:SESSION:")) for row in rows[3:]]
    assert len(session_documents) == 1
    assert all(session_validator.is_valid(document) for document in session_documents)
    assert all("userMemoryConsent" not in document for document in session_documents)
    assert cleaned["agent"]["variables"] == {
        "conversationTopic": "synthetic-topic",
        "tone": "neutral",
    }
    if nested_variables and guard_reason == "formatting":
        invalid_reason = f"""
DELETE FROM app.sessions WHERE id='{deleted_id}' AND deleted_at IS NOT NULL;
UPDATE app.turns
SET reply = jsonb_set(reply, '{{replyGuard,reason}}', '"future_reason"'::jsonb)
WHERE id='{turn_id}';
{SQL.read_text(encoding="utf-8")}
ROLLBACK;
"""
        with pytest.raises(subprocess.CalledProcessError) as invalid:
            _psql(container, prelude + invalid_reason)
        assert "ROLLBACK_V2_REPLY_KEYS_REMAIN" in invalid.value.stderr
