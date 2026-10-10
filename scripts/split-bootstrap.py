"""Initialize a NEW synthetic database; never run against the research source."""

import argparse
import hashlib
import json
from pathlib import Path

import psycopg

from persona_timeline_rag.split_migration import partition, read_environment, validate_target


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--roles-env", type=Path, required=True)
    args = parser.parse_args()
    env = read_environment(args.roles_env)
    url = env["PTR_SPLIT_TEST_OWNER_DATABASE_URL"]
    identity = validate_target(url)
    if identity["dbname"] != "ptr_split_test":
        raise RuntimeError("SYNTHETIC_TARGET_REQUIRED")
    with psycopg.connect(url, autocommit=True) as db:
        if db.execute("SELECT to_regclass('public.ptr_schema_migrations')").fetchone()[0]:
            raise RuntimeError("EMPTY_TARGET_REQUIRED")
        for path in sorted(Path("supabase/migrations").glob("*.sql")):
            db.execute(path.read_text())
        persona = {
            "id": "synthetic-split-persona",
            "personId": "synthetic-split-person",
            "label": "Synthetic Split",
            "language": "ko",
            "revision": "synthetic-v1",
            "reviewStatus": "synthetic",
            "identity": "A fictional synthetic test character, not a real person.",
            "concept": "Synthetic split regression",
            "style": ["brief polite Korean"],
            "boundaries": ["No private biography"],
            "sourceRefs": [],
            "greeting": "안녕하세요. 합성 캐릭터입니다.",
        }
        post = {
            "id": "synthetic-split-source",
            "personId": persona["personId"],
            "caption": "합성 파란책 기록: 가상의 파란 책을 읽었어요.",
            "postedAt": "2024-03-05T09:00:00Z",
            "eventDate": None,
            "sourceUrl": "https://example.com/synthetic/split/1",
            "hash": "synthetic-split-hash",
            "snapshot": "synthetic-v1",
            "unsafe": False,
        }

        def encode(x):
            return json.dumps(x, ensure_ascii=False, separators=(",", ":"))

        db.execute(
            "INSERT INTO personas VALUES(%s,%s,%s)",
            (persona["id"], persona["personId"], persona["revision"]),
        )
        document = encode(persona)
        db.execute(
            "INSERT INTO persona_versions(persona_id,revision,document,content_hash) "
            "VALUES(%s,%s,%s,%s)",
            (
                persona["id"],
                persona["revision"],
                document,
                hashlib.sha256(document.encode()).hexdigest(),
            ),
        )
        document = encode(post)
        db.execute(
            "INSERT INTO source_posts(id,person_id,posted_at,event_date,caption,unsafe,"
            "source_url,snapshot,source_hash,content_hash,origin,document) "
            "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)",
            (
                post["id"],
                post["personId"],
                post["postedAt"],
                None,
                post["caption"],
                False,
                post["sourceUrl"],
                post["snapshot"],
                post["hash"],
                hashlib.sha256(document.encode()).hexdigest(),
                "synthetic_fixture",
                document,
            ),
        )
        partition(db, Path("supabase/split/0001_owner_partition.sql"))
    for role, schema, other, own, foreign in [
        ("APP", "app", "llm", "sessions", "personas"),
        ("LLM", "llm", "app", "personas", "sessions"),
    ]:
        with psycopg.connect(env[f"PTR_SPLIT_TEST_{role}_DATABASE_URL"], autocommit=True) as db:
            db.execute(f"SELECT COUNT(*) FROM {schema}.{own}")
            for query in [
                f"SELECT * FROM {other}.{foreign}",
                f"CREATE TABLE {schema}.forbidden_ddl(id int)",
                "CREATE SCHEMA forbidden_schema",
            ]:
                try:
                    db.execute(query)
                except psycopg.errors.InsufficientPrivilege:
                    continue
                raise RuntimeError("RUNTIME_PERMISSION_BOUNDARY_FAILED")
    print("Synthetic bootstrap + 6 runtime permission denials PASS")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("Synthetic bootstrap failed (private details withheld)") from None
