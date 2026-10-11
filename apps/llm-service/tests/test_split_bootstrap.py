"""Synthetic bootstrap must provision the native saver before testing runtime roles."""

import importlib.util
import sys
from pathlib import Path

import psycopg
import pytest

ROOT = Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location(
    "split_bootstrap", ROOT / "scripts/split-bootstrap.py"
)
assert SPEC and SPEC.loader
bootstrap = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bootstrap)


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
            raise psycopg.errors.InsufficientPrivilege("synthetic denial")
        return self

    def fetchone(self):
        if self.last_sql == "SELECT current_database(),current_user":
            return ("ptr_split_test", "ptr_split_owner")
        return ("existing" if self.populated else None,)


@pytest.fixture
def configured(monkeypatch):
    env, events = environment(), []
    monkeypatch.setattr(sys, "argv", ["split-bootstrap", "--roles-env", "synthetic-only.env"])
    monkeypatch.setattr(bootstrap, "read_environment", lambda _: env)
    monkeypatch.setattr(bootstrap, "partition", lambda db, path: events.append(path.name))

    async def setup(url):
        assert url == env["PTR_SPLIT_TEST_OWNER_DATABASE_URL"]
        events.append("native-saver-setup")

    # Require a real imported owner setup surface, not another TS saver wrapper.
    import ptr_llm.providers.checkpoints as checkpoints

    monkeypatch.setattr(checkpoints, "setup_call_checkpoints", setup)
    monkeypatch.setattr(
        bootstrap.psycopg,
        "connect",
        lambda url, **kwargs: Connection(events, owner="ptr_split_owner:" in url),
    )
    return env, events


def test_bootstrap_applies_split_upgrades_then_native_saver_before_runtime_probes(configured):
    _, events = configured
    bootstrap.main()
    partition_at = events.index("0001_owner_partition.sql")
    native_at = events.index("native-saver-setup")
    scope_at = next(i for i, sql in enumerate(events) if "split/0002_receipt_scope.sql" in sql)
    summary_at = next(i for i, sql in enumerate(events) if "split/0003_post_summaries.sql" in sql)
    budget_at = next(
        i for i, sql in enumerate(events) if "split/0004_cumulative_budget_cap.sql" in sql
    )
    runtime_at = next(
        i for i, sql in enumerate(events) if "SELECT COUNT(*) FROM app.sessions" in sql
    )
    assert partition_at < scope_at < summary_at < budget_at < native_at < runtime_at


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
    configured, monkeypatch, changed
):
    env, _ = configured
    env["PTR_SPLIT_TEST_APP_DATABASE_URL"] = changed
    monkeypatch.setattr(bootstrap.psycopg, "connect", lambda *a, **k: pytest.fail("DB opened"))
    with pytest.raises(RuntimeError, match="SYNTHETIC_RUNTIME_TARGET_REQUIRED"):
        bootstrap.main()


def test_bootstrap_refuses_existing_target_without_ddl_or_setup(configured, monkeypatch):
    _, events = configured
    monkeypatch.setattr(
        bootstrap.psycopg,
        "connect",
        lambda *a, **k: Connection(events, owner=True, populated=True),
    )
    with pytest.raises(RuntimeError, match="EMPTY_TARGET_REQUIRED"):
        bootstrap.main()
    assert len(events) == 2


def test_bootstrap_rejects_connected_owner_identity_before_ddl(configured, monkeypatch):
    _, events = configured

    class Foreign(Connection):
        def fetchone(self):
            return ("ptr_split_research", "ptr_split_owner")

    monkeypatch.setattr(bootstrap.psycopg, "connect", lambda *a, **k: Foreign(events, owner=True))
    with pytest.raises(RuntimeError, match="SYNTHETIC_OWNER_IDENTITY_REQUIRED"):
        bootstrap.main()
    assert events == ["SELECT current_database(),current_user"]
