"""Synthetic bootstrap must provision the native saver before testing runtime roles."""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "src"))

from persona_timeline_rag.split_migration import (  # noqa: E402
    KIND_SYNTHETIC_BOOTSTRAP_PROFILE,
    LOCAL_SYNTHETIC_BOOTSTRAP_PROFILE,
    bootstrap_synthetic_split_database,
)


class FakeInsufficientPrivilege(Exception):
    pass


class FakeDriver:
    class errors:
        InsufficientPrivilege = FakeInsufficientPrivilege


def environment():
    return {
        f"PTR_SPLIT_TEST_{role}_DATABASE_URL": f"postgresql://ptr_split_{role.lower()}:synthetic@127.0.0.1:58432/ptr_split_test"
        for role in ("OWNER", "APP", "LLM")
    }


class Connection:
    def __init__(self, events, *, owner, populated=False):
        self.events, self.owner, self.populated = events, owner, populated

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def execute(self, sql, values=None):
        self.last_sql = sql
        self.events.append(sql)
        if "forbidden" in sql or sql.startswith("SELECT * FROM"):
            raise FakeInsufficientPrivilege("synthetic denial")
        return self

    def fetchone(self):
        if self.last_sql == "SELECT current_database(),current_user":
            return ("ptr_split_test", "ptr_split_owner")
        return ("existing" if self.populated else None,)


@pytest.fixture
def configured(tmp_path):
    env, events = environment(), []
    sql_root = tmp_path / "supabase"
    (sql_root / "migrations").mkdir(parents=True)
    (sql_root / "split").mkdir()
    for directory, names in {
        "migrations": ["002.sql", "001.sql"],
        "split": ["0002_receipt_scope.sql", "0001_owner_partition.sql", "0003_post_summaries.sql"],
    }.items():
        for name in names:
            (sql_root / directory / name).write_text(f"-- {directory}/{name}\n")

    async def setup(url):
        assert url == env["PTR_SPLIT_TEST_OWNER_DATABASE_URL"]
        events.append("native-saver-setup")

    return env, events, sql_root, setup


def test_bootstrap_applies_split_upgrades_then_native_saver_before_runtime_probes(configured):
    env, events, sql_root, setup = configured
    bootstrap_synthetic_split_database(
        env,
        sql_root=sql_root,
        profile=LOCAL_SYNTHETIC_BOOTSTRAP_PROFILE,
        connect=lambda url, **kwargs: Connection(events, owner="ptr_split_owner:" in url),
        driver=FakeDriver,
        setup_checkpoints=setup,
        partition_fn=lambda db, path: events.append(path.name),
    )
    partition_at = events.index("0001_owner_partition.sql")
    native_at = events.index("native-saver-setup")
    migration_1_at = next(i for i, sql in enumerate(events) if "-- migrations/001.sql" in sql)
    migration_2_at = next(i for i, sql in enumerate(events) if "-- migrations/002.sql" in sql)
    scope_at = next(i for i, sql in enumerate(events) if "-- split/0002_receipt_scope.sql" in sql)
    summary_at = next(
        i for i, sql in enumerate(events) if "-- split/0003_post_summaries.sql" in sql
    )
    runtime_at = next(
        i for i, sql in enumerate(events) if "SELECT COUNT(*) FROM app.sessions" in sql
    )
    assert migration_1_at < migration_2_at < partition_at
    assert partition_at < scope_at < summary_at < native_at < runtime_at


@pytest.mark.parametrize(
    "changed",
    [
        "postgresql://ptr_split_app:synthetic@127.0.0.1:58432/ptr_split_research",
        "postgresql://ptr_split_owner:synthetic@127.0.0.1:58432/ptr_split_test",
        "postgresql://ptr_split_app:synthetic@unapproved.invalid:58432/ptr_split_test",
        "postgresql://ptr_split_app:synthetic@127.0.0.1:58433/ptr_split_test",
        "postgresql://ptr_split_app@127.0.0.1:58432/ptr_split_test",
    ],
)
def test_bootstrap_rejects_runtime_target_mismatch_before_owner_connection(
    configured, changed
):
    env, _, sql_root, setup = configured
    env["PTR_SPLIT_TEST_APP_DATABASE_URL"] = changed
    with pytest.raises(RuntimeError, match="SYNTHETIC_RUNTIME_TARGET_REQUIRED"):
        bootstrap_synthetic_split_database(
            env,
            sql_root=sql_root,
            profile=LOCAL_SYNTHETIC_BOOTSTRAP_PROFILE,
            connect=lambda *a, **k: pytest.fail("DB opened"),
            driver=FakeDriver,
            setup_checkpoints=setup,
        )


def test_bootstrap_refuses_existing_target_without_ddl_or_setup(configured):
    env, events, sql_root, setup = configured
    with pytest.raises(RuntimeError, match="EMPTY_TARGET_REQUIRED"):
        bootstrap_synthetic_split_database(
            env,
            sql_root=sql_root,
            profile=LOCAL_SYNTHETIC_BOOTSTRAP_PROFILE,
            connect=lambda *a, **k: Connection(events, owner=True, populated=True),
            driver=FakeDriver,
            setup_checkpoints=setup,
        )
    assert len(events) == 2


def test_bootstrap_rejects_connected_owner_identity_before_ddl(configured):
    env, events, sql_root, setup = configured

    class Foreign(Connection):
        def fetchone(self):
            return ("ptr_split_research", "ptr_split_owner")

    with pytest.raises(RuntimeError, match="SYNTHETIC_OWNER_IDENTITY_REQUIRED"):
        bootstrap_synthetic_split_database(
            env,
            sql_root=sql_root,
            profile=LOCAL_SYNTHETIC_BOOTSTRAP_PROFILE,
            connect=lambda *a, **k: Foreign(events, owner=True),
            driver=FakeDriver,
            setup_checkpoints=setup,
        )
    assert events == ["SELECT current_database(),current_user"]


def test_kind_profile_requires_the_pinned_service_target(configured):
    env, _, sql_root, setup = configured
    env["PTR_SPLIT_TEST_OWNER_DATABASE_URL"] = (
        "postgresql://ptr_split_owner:synthetic@ptr-postgres.ptr-data.svc:5432/ptr_split_test"
    )
    env["PTR_SPLIT_TEST_APP_DATABASE_URL"] = (
        "postgresql://ptr_split_app:synthetic@ptr-postgres.ptr-data.svc:5432/ptr_split_test"
    )
    env["PTR_SPLIT_TEST_LLM_DATABASE_URL"] = (
        "postgresql://ptr_split_llm:synthetic@other-service.ptr-data.svc:5432/ptr_split_test"
    )
    with pytest.raises(RuntimeError, match="SYNTHETIC_CLUSTER_TARGET_REQUIRED"):
        bootstrap_synthetic_split_database(
            env,
            sql_root=sql_root,
            profile=KIND_SYNTHETIC_BOOTSTRAP_PROFILE,
            connect=lambda *a, **k: pytest.fail("DB opened"),
            driver=FakeDriver,
            setup_checkpoints=setup,
        )
