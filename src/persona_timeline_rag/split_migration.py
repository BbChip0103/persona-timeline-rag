"""Non-destructive, snapshot-consistent research-to-split migration.

Use the LLM service environment (psycopg installed). Credentials only enter child
process environments; logs/manifests contain counts and hashes, never source rows.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import inspect
import json
import os
import re
import subprocess
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit

APP_TABLES = ("sessions", "turns", "messages", "turn_outbox", "turn_leases")
LLM_TABLES = (
    "personas",
    "persona_versions",
    "source_posts",
    "source_vectors",
    "source_image_revisions",
    "source_image_annotations",
    "source_image_vectors",
    "ptr_provider_budget",
    "ptr_provider_requests",
)
LEGACY_CHECKPOINTS = (
    "checkpoints",
    "checkpoint_blobs",
    "checkpoint_writes",
    "checkpoint_migrations",
)


class MigrationError(Exception):
    """Sanitized failure, safe to display without a database URL."""


@dataclass(frozen=True)
class SplitBootstrapProfile:
    name: str
    allowed_hosts: frozenset[str]
    port: int
    database: str
    users: Mapping[str, str]
    target_error: str
    connect_attempts: int = 1
    retry_seconds: float = 0
    success_message: str = "Synthetic bootstrap + native saver + 6 runtime permission denials PASS"


LOCAL_SYNTHETIC_BOOTSTRAP_PROFILE = SplitBootstrapProfile(
    name="local",
    allowed_hosts=frozenset({"127.0.0.1"}),
    port=58432,
    database="ptr_split_test",
    users={
        "OWNER": "ptr_split_owner",
        "APP": "ptr_split_app",
        "LLM": "ptr_split_llm",
    },
    target_error="SYNTHETIC_RUNTIME_TARGET_REQUIRED",
)

KIND_SYNTHETIC_BOOTSTRAP_PROFILE = SplitBootstrapProfile(
    name="kind",
    allowed_hosts=frozenset(
        {"ptr-postgres.ptr-data.svc", "ptr-postgres.ptr-data.svc.cluster.local"}
    ),
    port=5432,
    database="ptr_split_test",
    users={
        "OWNER": "ptr_split_owner",
        "APP": "ptr_split_app",
        "LLM": "ptr_split_llm",
    },
    target_error="SYNTHETIC_CLUSTER_TARGET_REQUIRED",
    connect_attempts=60,
    retry_seconds=2,
    success_message=(
        "Synthetic cluster bootstrap + native saver + 6 runtime permission denials PASS"
    ),
)


def read_environment(path: Path) -> dict[str, str]:
    if not path.is_file() or path.stat().st_mode & 0o077:
        raise MigrationError("PRIVATE_ENV_REQUIRED")
    values: dict[str, str] = {}
    for line in path.read_text().splitlines():
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
        if match:
            values[match[1]] = match[2].strip("\"'")
    return values


def validate_target(raw: str, *, source: bool = False) -> dict[str, str]:
    try:
        url = urlsplit(raw)
        port = url.port
        database = url.path.removeprefix("/")
        user = unquote(url.username or "")
        valid_pair = (
            (database, user) == ("ptr_research", "ptr_researcher")
            if source
            else database in ("ptr_split_test", "ptr_split_research") and user == "ptr_split_owner"
        )
        if (
            url.scheme not in ("postgres", "postgresql")
            or url.hostname != "127.0.0.1"
            or port != (56432 if source else 58432)
            or not valid_pair
            or not url.password
            or url.query
            or url.fragment
        ):
            raise ValueError
        return {
            "host": "127.0.0.1",
            "port": str(port),
            "dbname": database,
            "user": user,
            "password": unquote(url.password),
        }
    except (ValueError, TypeError):
        raise MigrationError("ISOLATED_MIGRATION_TARGET_REQUIRED") from None


def _driver() -> Any:
    try:
        import psycopg

        return psycopg
    except ImportError:
        raise MigrationError("LLM_SERVICE_ENVIRONMENT_REQUIRED") from None


def _fingerprints(connection: Any, locations: dict[str, tuple[str, str]]) -> dict[str, Any]:
    from psycopg import sql

    result: dict[str, Any] = {}
    with connection.cursor() as cursor:
        for logical, (schema, table) in locations.items():
            cursor.execute("SELECT to_regclass(%s)", (f"{schema}.{table}",))
            if cursor.fetchone()[0] is None:
                continue
            cursor.execute(
                sql.SQL(
                    "SELECT COUNT(*), md5(COALESCE(string_agg(h,'' ORDER BY h),'')) "
                    "FROM (SELECT md5(row_to_json(t)::text) AS h FROM {} t) x"
                ).format(sql.Identifier(schema, table))
            )
            count, digest = cursor.fetchone()
            result[logical] = {"rows": count, "contentDigest": digest}
    return result


def _pg_tool(
    command: str, config: dict[str, str], *, arguments: list[str], output: Path | None = None
) -> None:
    """A pinned client container avoids depending on host PostgreSQL client versions."""
    env = {**os.environ, "PGPASSWORD": config["password"]}
    invocation = [
        "docker",
        "run",
        "--rm",
        "--network",
        "host",
        "--env",
        "PGPASSWORD",
        "pgvector/pgvector:0.8.1-pg15",
        command,
        "--host",
        config["host"],
        "--port",
        config["port"],
        "--username",
        config["user"],
        "--dbname",
        config["dbname"],
        *arguments,
    ]
    # Docker stdout is the archive only. Nothing private reaches console output.
    with output.open("wb") if output else open(os.devnull, "wb") as stream:
        proc = subprocess.run(
            invocation, env=env, stdout=stream, stderr=subprocess.PIPE, timeout=300, check=False
        )
    if proc.returncode:
        raise MigrationError("ARCHIVE_CLIENT_FAILED")
    if output:
        output.chmod(0o600)


def _restore(config: dict[str, str], archive: Path) -> None:
    env = {**os.environ, "PGPASSWORD": config["password"]}
    listing = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "--mount",
            f"type=bind,src={archive.resolve()},dst=/backup.dump,readonly",
            "pgvector/pgvector:0.8.1-pg15",
            "pg_restore",
            "--list",
            "/backup.dump",
        ],
        capture_output=True,
        timeout=30,
        check=False,
    )
    if listing.returncode:
        raise MigrationError("ARCHIVE_LIST_FAILED")
    # The target already has public and the vector extension. Omit only public
    # schema creation, not its tables, functions, constraints or sequences.
    entries = listing.stdout.decode().splitlines()
    selected = archive.with_suffix(".restore-list")
    selected.write_text(
        "\n".join(line for line in entries if not re.search(r"\bSCHEMA - public\b", line)) + "\n"
    )
    selected.chmod(0o600)
    cmd = [
        "docker",
        "run",
        "--rm",
        "--network",
        "host",
        "--env",
        "PGPASSWORD",
        "--mount",
        f"type=bind,src={selected.resolve()},dst=/restore-list,readonly",
        "--mount",
        f"type=bind,src={archive.resolve()},dst=/backup.dump,readonly",
        "pgvector/pgvector:0.8.1-pg15",
        "pg_restore",
        "--host",
        config["host"],
        "--port",
        config["port"],
        "--username",
        config["user"],
        "--dbname",
        config["dbname"],
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
        "--single-transaction",
        "--use-list=/restore-list",
        "/backup.dump",
    ]
    result = subprocess.run(cmd, env=env, capture_output=True, timeout=300, check=False)
    if result.returncode:
        raise MigrationError("RESTORE_FAILED")


def partition(connection: Any, sql_path: Path) -> None:
    """Only a new target without existing split schemas can be partitioned."""
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT current_database(),current_user,to_regnamespace('app'),to_regnamespace('llm')"
        )
        database, user, app, llm = cursor.fetchone()
        if database not in ("ptr_split_test", "ptr_split_research") or user != "ptr_split_owner":
            raise MigrationError("ISOLATED_MIGRATION_TARGET_REQUIRED")
        if app or llm:
            raise MigrationError("TARGET_ALREADY_PARTITIONED")
        cursor.execute(sql_path.read_text())


def _validate_synthetic_bootstrap_url(raw: str, role: str, profile: SplitBootstrapProfile) -> None:
    target = urlsplit(raw)
    if not (
        target.scheme in ("postgres", "postgresql")
        and target.hostname in profile.allowed_hosts
        and target.port == profile.port
        and target.path == f"/{profile.database}"
        and target.username == profile.users[role]
        and target.password
        and not target.query
        and not target.fragment
    ):
        raise RuntimeError(profile.target_error)


def _split_bootstrap_sql(sql_root: Path) -> tuple[list[Path], list[Path]]:
    migrations = sorted((sql_root / "migrations").glob("*.sql"))
    split_files = sorted((sql_root / "split").glob("*.sql"))
    if not migrations or not split_files or split_files[0].name != "0001_owner_partition.sql":
        raise RuntimeError("SPLIT_BOOTSTRAP_SQL_REQUIRED")
    return migrations, split_files


def _seed_synthetic_split_fixture(db: Any) -> None:
    persona = {
        "id": "synthetic-split-persona",
        "personId": "synthetic-split-person",
        "label": "파란책 이야기",
        "language": "ko",
        "revision": "synthetic-v1",
        "reviewStatus": "synthetic",
        "identity": "A warm conversational character.",
        "concept": "Quiet stories and books",
        "style": ["brief polite Korean"],
        "boundaries": ["No private biography"],
        "sourceRefs": [],
        "greeting": "안녕하세요. 오늘은 어떤 이야기를 나눌까요?",
    }
    post = {
        "id": "synthetic-split-source",
        "personId": persona["personId"],
        "caption": "파란책을 읽고 마음에 오래 남았어요.",
        "postedAt": "2024-03-05T09:00:00Z",
        "eventDate": None,
        "sourceUrl": "https://example.com/synthetic/split/1",
        "hash": "synthetic-split-hash",
        "snapshot": "synthetic-v1",
        "unsafe": False,
    }

    def encode(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))

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


def _default_setup_checkpoints(owner_url: str) -> Any:
    from ptr_llm.providers.checkpoints import setup_call_checkpoints

    return setup_call_checkpoints(owner_url)


async def _await_setup_result(result: Awaitable[Any]) -> Any:
    return await result


def bootstrap_synthetic_split_database(
    env: Mapping[str, str],
    *,
    sql_root: Path,
    profile: SplitBootstrapProfile,
    connect: Callable[..., Any] | None = None,
    driver: Any | None = None,
    setup_checkpoints: Callable[[str], Any] | None = None,
    partition_fn: Callable[[Any, Path], None] = partition,
    stage_callback: Callable[[str], None] | None = None,
) -> str:
    """Initialize the synthetic split database and verify runtime role boundaries."""
    driver = driver or _driver()
    connect = connect or driver.connect
    setup_checkpoints = setup_checkpoints or _default_setup_checkpoints

    for role in profile.users:
        _validate_synthetic_bootstrap_url(env[f"PTR_SPLIT_TEST_{role}_DATABASE_URL"], role, profile)

    migrations, split_files = _split_bootstrap_sql(sql_root)
    owner_url = env["PTR_SPLIT_TEST_OWNER_DATABASE_URL"]
    db = None
    last_error: Exception | None = None
    for _ in range(profile.connect_attempts):
        if stage_callback:
            stage_callback("database_connect")
        try:
            db = connect(owner_url, autocommit=True)
            break
        except driver.OperationalError as exc:
            last_error = exc
            if profile.retry_seconds:
                time.sleep(profile.retry_seconds)
    if db is None:
        raise RuntimeError("SYNTHETIC_POSTGRES_UNAVAILABLE") from last_error

    with db:
        if stage_callback:
            stage_callback("empty_target_check")
        if db.execute("SELECT current_database(),current_user").fetchone() != (
            profile.database,
            profile.users["OWNER"],
        ):
            raise RuntimeError("SYNTHETIC_OWNER_IDENTITY_REQUIRED")
        tables = db.execute(
            "SELECT COUNT(*) FROM pg_tables WHERE schemaname IN ('app','llm') "
            "OR (schemaname='public' AND tablename<>'spatial_ref_sys')"
        ).fetchone()
        if tables is None or tables[0]:
            raise RuntimeError("EMPTY_TARGET_REQUIRED")
        for path in migrations:
            if stage_callback:
                stage_callback(path.name)
            db.execute(path.read_text())
        _seed_synthetic_split_fixture(db)
        if stage_callback:
            stage_callback("owner_partition")
        partition_fn(db, split_files[0])
        for path in split_files[1:]:
            if stage_callback:
                stage_callback(path.name)
            db.execute(path.read_text())

    if stage_callback:
        stage_callback("native_checkpoints")
    setup_result = setup_checkpoints(owner_url)
    if inspect.isawaitable(setup_result):
        asyncio.run(_await_setup_result(setup_result))

    for role, schema, other, own, foreign in [
        ("APP", "app", "llm", "sessions", "personas"),
        ("LLM", "llm", "app", "personas", "sessions"),
    ]:
        if stage_callback:
            stage_callback(f"permission_{role.lower()}")
        with connect(env[f"PTR_SPLIT_TEST_{role}_DATABASE_URL"], autocommit=True) as db:
            db.execute(f"SELECT COUNT(*) FROM {schema}.{own}")
            for query in [
                f"SELECT * FROM {other}.{foreign}",
                f"CREATE TABLE {schema}.forbidden_ddl(id int)",
                "CREATE SCHEMA forbidden_schema",
            ]:
                try:
                    db.execute(query)
                except driver.errors.InsufficientPrivilege:
                    continue
                raise RuntimeError("RUNTIME_PERMISSION_BOUNDARY_FAILED")
    return profile.success_message


def migrate(source_url: str, target_url: str, directory: Path, sql_path: Path) -> dict[str, Any]:
    driver = _driver()
    source_config = validate_target(source_url, source=True)
    target_config = validate_target(target_url)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if directory.stat().st_mode & 0o077:
        raise MigrationError("PRIVATE_BACKUP_DIRECTORY_REQUIRED")
    archive = directory / "research-before-split.dump"
    if archive.exists():
        raise MigrationError("BACKUP_EXISTS_REFUSE_OVERWRITE")
    original_locations = {t: ("public", t) for t in (*APP_TABLES, *LLM_TABLES, *LEGACY_CHECKPOINTS)}
    split_locations = {t: ("app", t) for t in APP_TABLES}
    split_locations.update({t: ("llm", t) for t in LLM_TABLES})
    split_locations.update({t: ("llm", "legacy_ts_" + t) for t in LEGACY_CHECKPOINTS})
    with driver.connect(**target_config, autocommit=True) as target:
        with target.cursor() as cursor:
            cursor.execute(
                "SELECT COUNT(*) FROM pg_tables WHERE schemaname IN ('app','llm') "
                "OR (schemaname='public' AND tablename<>'spatial_ref_sys')"
            )
            if cursor.fetchone()[0]:
                raise MigrationError("EMPTY_NEW_TARGET_REQUIRED")
        with driver.connect(**source_config, autocommit=False) as source:
            with source.cursor() as cursor:
                cursor.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                cursor.execute("SELECT current_database(),current_user")
                if cursor.fetchone() != ("ptr_research", "ptr_researcher"):
                    raise MigrationError("SOURCE_IDENTITY_MISMATCH")
                cursor.execute(
                    "SELECT COUNT(*) FROM public.turns WHERE state NOT IN "
                    "('completed','failed','cancelled')"
                )
                if cursor.fetchone()[0]:
                    raise MigrationError("SOURCE_DRAIN_REQUIRED")
                cursor.execute("SELECT pg_export_snapshot()")
                snapshot = cursor.fetchone()[0]
            before = _fingerprints(source, original_locations)
            _pg_tool(
                "pg_dump",
                source_config,
                arguments=[
                    "--format=custom",
                    "--schema=public",
                    "--no-owner",
                    "--no-acl",
                    "--snapshot=" + snapshot,
                ],
                output=archive,
            )
            # Restore verifies the archive, not an independent second SQL copy.
            _restore(target_config, archive)
            restored = _fingerprints(target, original_locations)
            if before != restored:
                raise MigrationError("RESTORE_CONTENT_MISMATCH")
            partition(target, sql_path)
            after = _fingerprints(target, split_locations)
            if before != after:
                raise MigrationError("PARTITION_CONTENT_MISMATCH")
        # Only after exact restore/partition proof, add nullable runtime scope
        # columns missing in older archives; never rewrite historical ledger rows.
        scope_upgrade = sql_path.with_name("0002_receipt_scope.sql")
        if scope_upgrade.exists():
            target.execute(scope_upgrade.read_text())
        # Preserve the baseline/requests but impose the user's cumulative cap.
        # This explicit owner upgrade is never DDL in serving startup.
        budget_upgrade = sql_path.with_name("0004_cumulative_budget_cap.sql")
        if not budget_upgrade.is_file():
            raise MigrationError("CUMULATIVE_BUDGET_UPGRADE_REQUIRED")
        target.execute(budget_upgrade.read_text())
        # A new transaction detects source writes that raced after the exported snapshot.
        with driver.connect(**source_config) as source:
            source.execute("SET TRANSACTION READ ONLY")
            unchanged = before == _fingerprints(source, original_locations)
        if not unchanged:
            raise MigrationError("SOURCE_CHANGED_DURING_COPY")
    report = {
        "sourceUnchanged": True,
        "archiveRestoreVerified": True,
        "splitContentVerified": True,
        "tables": after,
        "archiveSha256": hashlib.sha256(archive.read_bytes()).hexdigest(),
        "extraApiCapMicrousd": 1_000_000,
        "runpodExcluded": True,
        "additiveReceiptScopeUpgrade": scope_upgrade.exists(),
        "cumulativeProviderCapMaximumMicrousd": 1_000_000,
        "additiveCumulativeBudgetUpgrade": True,
    }
    manifest = directory / "migration-summary.private.json"
    manifest.write_text(json.dumps(report, indent=2) + "\n")
    manifest.chmod(0o600)
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-env", type=Path, required=True)
    parser.add_argument("--target-env", type=Path, required=True)
    parser.add_argument("--target-key", default="PTR_SPLIT_RESEARCH_OWNER_DATABASE_URL")
    parser.add_argument("--private-output", type=Path, required=True)
    parser.add_argument(
        "--partition-sql", type=Path, default=Path("supabase/split/0001_owner_partition.sql")
    )
    args = parser.parse_args()
    try:
        source_env = read_environment(args.source_env)
        target_env = read_environment(args.target_env)
        report = migrate(
            source_env.get("DATABASE_URL", ""),
            target_env.get(args.target_key, ""),
            args.private_output,
            args.partition_sql,
        )
        print(
            json.dumps(
                {
                    "status": "verified",
                    "tables": len(report["tables"]),
                    "rows": sum(t["rows"] for t in report["tables"].values()),
                    "sourceUnchanged": True,
                }
            )
        )
        return 0
    except (MigrationError, OSError, KeyError, subprocess.SubprocessError):
        print("Research split migration failed; private values withheld.")
        return 1
    except Exception:
        # Driver exceptions may embed URLs, query rows or constraint values.
        print("Research split migration database check failed; private values withheld.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
