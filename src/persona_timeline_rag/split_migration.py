"""Non-destructive, snapshot-consistent research-to-split migration.

Use the LLM service environment (psycopg installed). Credentials only enter child
process environments; logs/manifests contain counts and hashes, never source rows.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
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
