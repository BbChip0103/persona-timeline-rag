"""Initialize only a freshly created, disposable ptr_split_test database."""

import json
from pathlib import Path

import psycopg

from persona_timeline_rag.split_migration import (
    LOCAL_SYNTHETIC_BOOTSTRAP_PROFILE,
    bootstrap_synthetic_split_database,
)

BASE = "postgresql://{role}:synthetic-acceptance-only@127.0.0.1:58432/ptr_split_test"
owner = BASE.format(role="ptr_split_owner")
with psycopg.connect(owner, autocommit=True) as db:
    assert db.execute("SELECT current_database(),current_user").fetchone() == (
        "ptr_split_test",
        "ptr_split_owner",
    )
    assert (
        db.execute(
            "SELECT count(*) FROM pg_tables "
            "WHERE schemaname NOT IN ('pg_catalog','information_schema')"
        ).fetchone()[0]
        == 0
    )
    for role in ("ptr_split_app", "ptr_split_llm"):
        db.execute(f"CREATE ROLE {role} LOGIN PASSWORD 'synthetic-acceptance-only'")

env = {
    f"PTR_SPLIT_TEST_{name}_DATABASE_URL": BASE.format(role=role)
    for name, role in (
        ("OWNER", "ptr_split_owner"),
        ("APP", "ptr_split_app"),
        ("LLM", "ptr_split_llm"),
    )
}
print(
    bootstrap_synthetic_split_database(
        env, sql_root=Path("supabase"), profile=LOCAL_SYNTHETIC_BOOTSTRAP_PROFILE
    ),
    flush=True,
)
with psycopg.connect(owner) as db:
    persona = db.execute("SELECT document FROM llm.persona_versions").fetchone()[0]
publication = Path("/evidence/personas.json")
publication.write_text(json.dumps({"database": "ptr_split_test", "personas": [persona]}) + "\n")
publication.chmod(0o600)
