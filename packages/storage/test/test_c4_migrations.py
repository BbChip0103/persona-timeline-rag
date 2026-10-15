"""Opt-in, network-isolated PostgreSQL proof using synthetic rows only."""
# ruff: noqa: E501 -- SQL proof statements remain readable as executable SQL.

import os
import subprocess
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def command(*args, input=None):
    result = subprocess.run(args, input=input, text=True, capture_output=True, timeout=40)
    assert result.returncode == 0, result.stderr
    return result.stdout


@pytest.mark.skipif(
    os.getenv("PTR_C4_MIGRATION_PROOF") != "1", reason="explicit isolated Docker proof opt-in"
)
def test_c4_session_binding_migrations():
    container = "ptr-c4-synthetic-" + uuid.uuid4().hex[:12]
    container_id = command(
        "docker",
        "run",
        "-d",
        "--name",
        container,
        "--network",
        "none",
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "pgvector/pgvector:0.8.1-pg15",
    ).strip()
    print(f"C4_MIGRATION_CONTAINER_STARTED={container_id}")
    try:
        command(
            "docker",
            "exec",
            container,
            "bash",
            "-c",
            "for i in {1..100}; do pg_isready -h 127.0.0.1 -U postgres >/dev/null && exit 0; sleep 0.1; done; exit 1",
        )

        command("docker", "exec", container, "psql", "-U", "postgres", "-c",
                "CREATE ROLE ptr_split_owner SUPERUSER LOGIN; CREATE ROLE ptr_split_app LOGIN; CREATE ROLE ptr_split_llm LOGIN;")
        command("docker", "exec", container, "psql", "-U", "postgres", "-c",
                "CREATE DATABASE ptr_split_test OWNER ptr_split_owner")

        def sql(value, user="postgres"):
            return command(
                "docker",
                "exec",
                "-i",
                container,
                "psql",
                "-h",
                "127.0.0.1",
                "-X",
                "-v",
                "ON_ERROR_STOP=1",
                "-U",
                user,
                "-d",
                "ptr_split_test",
                input=value,
            )

        for migration in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            sql(migration.read_text())
        for schema in ("public", "app"):
            if schema == "app":
                sql((ROOT / "supabase/split/0001_owner_partition.sql").read_text())
                sql(
                    "DROP TRIGGER session_binding_immutable ON app.sessions; CREATE TRIGGER session_binding_immutable BEFORE UPDATE ON app.sessions FOR EACH ROW EXECUTE FUNCTION public.ptr_reject_source_mutation();"
                )
                sql((ROOT / "supabase/split/0006_conversation_memory.sql").read_text(),
                    user="ptr_split_owner")
            sql(f"""
SET search_path={schema},public;
INSERT INTO {"llm" if schema == "app" else "public"}.personas(id,person_id,current_revision) VALUES('synthetic-{schema}','synthetic-person','synthetic-v1');
INSERT INTO {"llm" if schema == "app" else "public"}.persona_versions(persona_id,revision,document,content_hash) VALUES('synthetic-{schema}','synthetic-v1','{{}}','synthetic-hash');
INSERT INTO sessions(id,owner_id,person_id,persona_id,persona_revision,document,created_at)
VALUES('synthetic-{schema}','synthetic-owner','synthetic-person','synthetic-{schema}','synthetic-v1',
 jsonb_build_object('id','synthetic-{schema}','ownerId','synthetic-owner','personId','synthetic-person','personaId','synthetic-{schema}','personaRevision','synthetic-v1'),now());
UPDATE sessions SET document=document||'{{"userMemoryConsent":true}}' WHERE id='synthetic-{schema}';
INSERT INTO messages(id,session_id,turn_id,role,content,created_at) VALUES('synthetic-message-{schema}','synthetic-{schema}',NULL,'assistant','synthetic greeting',now());
UPDATE sessions SET summary='synthetic summary',summary_last_message_id='synthetic-message-{schema}' WHERE id='synthetic-{schema}';
DO $$BEGIN
 BEGIN UPDATE sessions SET owner_id='synthetic-other' WHERE id='synthetic-{schema}'; RAISE EXCEPTION 'identity mutation accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='identity mutation accepted' THEN RAISE; END IF; END;
 BEGIN UPDATE sessions SET document=document||'{{"language":"en"}}' WHERE id='synthetic-{schema}'; RAISE EXCEPTION 'core document mutation accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM='core document mutation accepted' THEN RAISE; END IF; END;
END $$;
INSERT INTO user_memories(id,owner_id,persona_id,origin_session_id,kind,text)
VALUES('synthetic-memory-{schema}','synthetic-owner','synthetic-{schema}','synthetic-{schema}','like','synthetic skies');
UPDATE user_memories SET forgotten=true WHERE id='synthetic-memory-{schema}';
DO $$BEGIN IF (SELECT forgotten_at FROM user_memories WHERE id='synthetic-memory-{schema}') IS NULL THEN RAISE EXCEPTION 'forget timestamp absent'; END IF; END $$;
INSERT INTO user_memories(id,owner_id,persona_id,origin_session_id,kind,text)
SELECT 'synthetic-cap-{schema}-'||n,'synthetic-owner','synthetic-{schema}',
 'synthetic-{schema}','like','synthetic memory '||n FROM generate_series(1,30) n;
DO $$BEGIN
 BEGIN INSERT INTO user_memories(id,owner_id,persona_id,origin_session_id,kind,text)
  VALUES('synthetic-cap-rejected-{schema}','synthetic-owner','synthetic-{schema}',
  'synthetic-{schema}','like','synthetic over cap');
  RAISE EXCEPTION 'active cap accepted 31st memory';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='active cap accepted 31st memory' THEN RAISE; END IF;
 END;
END $$;
UPDATE user_memories SET forgotten=true WHERE id LIKE 'synthetic-cap-{schema}-%';
INSERT INTO user_memories(id,owner_id,persona_id,origin_session_id,kind,text)
VALUES('synthetic-cap-reused-{schema}','synthetic-owner','synthetic-{schema}',
 'synthetic-{schema}','like','synthetic freed capacity');
DO $$BEGIN
 BEGIN UPDATE user_memories SET forgotten=false WHERE id='synthetic-memory-{schema}';
 RAISE EXCEPTION 'forgotten restore accepted';
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='forgotten restore accepted' THEN RAISE; END IF; END;
END $$;
UPDATE user_memories SET forgotten_at=now()-interval '91 days' WHERE forgotten;
DELETE FROM user_memories WHERE forgotten AND forgotten_at<now()-interval '90 days';
DO $$BEGIN
 IF (SELECT count(*) FROM user_memories WHERE forgotten
     AND persona_id='synthetic-{schema}')<>0
  OR (SELECT count(*) FROM user_memories WHERE NOT forgotten
     AND persona_id='synthetic-{schema}')<>1 THEN
  RAISE EXCEPTION 'forgotten retention damaged active memory';
 END IF;
END $$;
UPDATE sessions SET summary=NULL,summary_last_message_id=NULL,deleted_at=now() WHERE id='synthetic-{schema}';
DO $$BEGIN IF NOT EXISTS(SELECT 1 FROM sessions WHERE id='synthetic-{schema}' AND deleted_at IS NOT NULL AND summary IS NULL) THEN RAISE EXCEPTION 'C4 mutable fields failed';END IF; END $$;
""")
    finally:
        command("docker", "rm", "-f", container)
        print(f"C4_MIGRATION_CONTAINER_REMOVED={container_id}")
