"""Split retention contracts; all IDs and receipts here are fictional."""

import hashlib
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from ptr_llm.evaluation.langfuse import EvaluationMigration, migrate_dataset


def test_historical_import_keeps_original_top_level_retention_clock():
    client = Mock()
    migration = EvaluationMigration.model_validate(
        {
            "source": "synthetic",
            "revision": "old-v1",
            "cases": [
                {
                    "id": "old",
                    "input": "synthetic",
                    "historical": {
                        "originalRunAt": "2020-01-01T00:00:00Z",
                        "originalVersion": "old-v1",
                        "output": "synthetic archived output",
                    },
                }
            ],
        }
    )
    migrate_dataset(client, "synthetic-history", migration)
    metadata = client.create_dataset_item.call_args.kwargs["metadata"]
    assert metadata["originalRunAt"] == "2020-01-01T00:00:00Z"
    assert metadata["originalVersion"] == "old-v1"
    assert metadata["historicalArchive"]["notANewExecution"] is True


def test_thread_matching_never_guesses_or_uses_substring():
    from ptr_llm.retention import linked_thread_ids

    turn = "00000000-0000-4000-8000-000000000001"
    scope = hashlib.sha256(turn.encode()).hexdigest()
    fp = "a" * 64
    valid = [
        f"turn:{turn}",
        f"character:{turn}",
        f"model:{turn}:{fp}",
        f"python-call-v1:{scope}:{fp}",
    ]
    invalid = [
        f"turn:{turn}:other",
        f"python-call-v1:{scope}:oops",
        f"python-call-v1:{'b' * 64}:{fp}",
        f"model:{turn}:bad",
        "unlinked",
    ]
    assert linked_thread_ids(valid + invalid, [turn]) == sorted(valid)


def test_retention_arguments_are_bounded_and_timezone_aware():
    from ptr_llm.retention import RetentionOptions

    assert RetentionOptions(now=datetime(2026, 10, 11, tzinfo=UTC)).days == 90
    for kwargs in [
        {"days": 89},
        {"days": True},
        {"limit": 0},
        {"limit": 1001},
        {"now": datetime(2026, 10, 11)},
        {"apply": "true"},
    ]:
        with pytest.raises(ValueError):
            RetentionOptions(**kwargs).validate()


class FakeConnection:
    def __init__(self, *, role="ptr_split_owner", db="ptr_split_test"):
        self.role, self.db, self.calls = role, db, []
        self.committed = self.rolled_back = False

    @asynccontextmanager
    async def transaction(self):
        try:
            yield
        except BaseException:
            self.rolled_back = True
            raise
        else:
            self.committed = True

    async def execute(self, sql, parameters=()):
        self.calls.append((sql, parameters))
        rows = []
        if "current_database()" in sql:
            rows = [{"role": self.role, "db": self.db}]
        elif "to_regclass" in sql:
            rows = [{"present": True}]
        elif sql.startswith("SELECT t.id"):
            rows = [{"id": "00000000-0000-4000-8000-000000000001"}]
        elif sql.startswith("SELECT DISTINCT c.thread_id"):
            turn = "00000000-0000-4000-8000-000000000001"
            rows = [
                {
                    "thread_id": f"python-call-v1:{hashlib.sha256(turn.encode()).hexdigest()}:"
                    + "a" * 64
                }
            ]
        elif sql.startswith("SELECT r.execution_id") or sql.startswith("SELECT g.execution_id"):
            rows = [{"execution_id": "synthetic-execution"}]
        elif sql.startswith("SELECT r.key"):
            rows = [{"key": "synthetic-provider-key"}]
        elif sql.startswith("SELECT count(*) FILTER"):
            rows = [{"legacy_unscoped": 1, "missing_turn": 2, "unsupported_kind": 3}]
        elif sql.startswith("SELECT count(*)"):
            rows = [{"count": 4}]

        async def one():
            return rows[0] if rows else None

        async def all_rows():
            return rows

        return SimpleNamespace(fetchone=one, fetchall=all_rows, rowcount=1)


async def test_dry_run_only_enumerates_metadata_and_never_mutates():
    from ptr_llm.retention import RetentionOptions, retain_split_data

    connection = FakeConnection()
    result = await retain_split_data(connection, RetentionOptions())
    assert result["applied"] is False and connection.committed
    assert result["planned"]["checkpointThreads"] == 1
    assert all(value == 0 for value in result["deleted"].values())
    assert not any(sql.startswith(("DELETE", "UPDATE", "LOCK")) for sql, _ in connection.calls)
    assert not any("SELECT *" in sql or "SELECT result_json" in sql for sql, _ in connection.calls)
    assert "synthetic-execution" not in str(result)


@pytest.mark.parametrize("kwargs", [{"role": "ptr_split_llm"}, {"db": "other-project"}])
async def test_connected_owner_boundary_precedes_every_other_statement(kwargs):
    from ptr_llm.retention import retain_split_data

    connection = FakeConnection(**kwargs)
    with pytest.raises(ValueError, match="CONNECTED_OWNER"):
        await retain_split_data(connection)
    assert len(connection.calls) == 1 and connection.rolled_back


async def test_apply_requires_exact_database_and_rolls_back_before_mutation():
    from ptr_llm.retention import RetentionOptions, retain_split_data

    connection = FakeConnection()
    with pytest.raises(ValueError, match="CONFIRMATION"):
        await retain_split_data(connection, RetentionOptions(apply=True, confirm_database="wrong"))
    assert len(connection.calls) == 1 and connection.rolled_back


async def test_apply_preserves_paid_tombstones_and_protects_result_insert_race():
    from ptr_llm.retention import RetentionOptions, retain_split_data

    connection = FakeConnection()
    result = await retain_split_data(
        connection, RetentionOptions(apply=True, confirm_database="ptr_split_test")
    )
    assert result["deleted"]["providerReceipts"] == 1
    statements = [sql for sql, _ in connection.calls]
    assert any("FOR UPDATE OF t SKIP LOCKED" in sql for sql in statements)
    assert any("LOCK TABLE llm.result_receipts" in sql for sql in statements)
    update = next(sql for sql in statements if sql.startswith("UPDATE"))
    assert "response_json=NULL" in update and "response_scrubbed_at" in update
    assert "reserved_microusd=" not in update and "state=" not in update
    assert not any(sql.startswith("DELETE FROM llm.ptr_provider_requests") for sql in statements)


def test_maintenance_never_uses_runtime_or_ambient_database_url():
    from ptr_llm.billing import ProviderError
    from ptr_llm.retention import maintenance_url

    for env in [
        {"DATABASE_URL": "postgres://private"},
        {
            "PTR_LLM_MAINTENANCE_DATABASE_URL": "postgresql://ptr_split_llm:synthetic@127.0.0.1:58432/ptr_split_test"
        },
    ]:
        with pytest.raises((ValueError, ProviderError)):
            maintenance_url(env)


def test_retention_cli_is_explicit_dry_run_and_sanitizes_errors(monkeypatch, capsys):
    from ptr_llm import cli, retention

    selected = []

    async def fake_run(args):
        selected.append(args)
        return {"applied": args.apply, "planned": {"turns": 0}}

    monkeypatch.setattr(retention, "run_retention", fake_run)
    assert cli.main(["retention"]) == 0
    assert selected[-1].apply is False and selected[-1].days == 90
    assert cli.main(["retention", "--apply", "--confirm-database", "ptr_split_test"]) == 0
    assert selected[-1].apply is True and selected[-1].confirm_database == "ptr_split_test"

    async def private_failure(args):
        raise RuntimeError("synthetic-private-receipt-SECRET")

    monkeypatch.setattr(retention, "run_retention", private_failure)
    assert cli.main(["retention"]) == 1
    output = capsys.readouterr()
    assert "synthetic-private-receipt-SECRET" not in output.err + output.out


def test_checkpoint_setup_cli_never_uses_serving_credentials(monkeypatch, capsys):
    from ptr_llm import cli, retention
    from ptr_llm.providers import checkpoints

    selected = []

    async def setup(url):
        selected.append(url)

    monkeypatch.setattr(retention, "maintenance_url", lambda: "synthetic-owner-url")
    monkeypatch.setattr(checkpoints, "setup_call_checkpoints", setup)
    assert cli.main(["checkpoint-setup"]) == 0
    assert selected == ["synthetic-owner-url"]
    assert "synthetic-owner-url" not in capsys.readouterr().out
