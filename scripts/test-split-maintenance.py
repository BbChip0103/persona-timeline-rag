"""Synthetic private config/process fixtures only; never a production maintenance run."""

import importlib.util
import json
import os
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "split_maintenance", Path(__file__).with_name("split-maintenance.py")
)
module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(module)


@pytest.fixture
def config(tmp_path):
    os.chmod(tmp_path, 0o700)
    state = tmp_path / "state"
    state.mkdir(mode=0o700)
    value = {
        "database": "ptr_split_test",
        "stateDir": str(state),
        "timeoutSeconds": 90,
        "env": {
            "PTR_LLM_MAINTENANCE_DATABASE_URL": "postgresql://ptr_split_owner:synthetic@127.0.0.1:58432/ptr_split_test"
        },
        "daily": {"apply": False, "limit": 100},
        "weekly": {"apply": False, "sinceDays": 7},
    }
    path = tmp_path / "maintenance.json"
    path.write_text(json.dumps(value))
    path.chmod(0o600)
    return path, value


def test_dry_run_weekly_never_reads_source_or_creates_review(config):
    path, _ = config
    calls = []
    result = module.run(path, "weekly", execute=lambda *args: calls.append(args))
    assert result["applied"] is False and result["executed"] == 0 and calls == []


def test_daily_uses_only_explicit_owner_env_and_exact_confirmation(config, monkeypatch):
    path, value = config
    value["daily"]["apply"] = True
    path.write_text(json.dumps(value))
    monkeypatch.setenv("OPENROUTER_API_KEY", "never-forward")
    monkeypatch.setenv("DATABASE_URL", "never-forward")
    calls = []

    def execute(argv, env, timeout):
        calls.append((argv, env, timeout))
        return {
            "planned": {"turns": 0},
            "deleted": {"checkpointRows": 0},
            "deferred": {"legacy_unscoped": 4},
        }

    result = module.run(path, "daily", scheduled=True, execute=execute)
    assert result["applied"] is True
    argv, env, timeout = calls[0]
    assert argv[-3:] == ["--apply", "--confirm-database", "ptr_split_test"]
    assert "OPENROUTER_API_KEY" not in env and "DATABASE_URL" not in env
    assert "PTR_LLM_MAINTENANCE_DATABASE_URL" in env and 0 < timeout <= 90
    assert "synthetic" not in json.dumps(result)


@pytest.mark.parametrize(
    "change", ["mode", "symlink", "runtime-env", "role", "wrong-db", "central-without-approval"]
)
def test_unsafe_configuration_fails_before_execution(config, change):
    path, value = config
    if change == "mode":
        path.chmod(0o644)
    elif change == "symlink":
        actual = path.with_suffix(".actual")
        path.rename(actual)
        path.symlink_to(actual)
    else:
        if change == "runtime-env":
            value["env"]["PTR_LLM_DATABASE_URL"] = "blocked"
        if change == "role":
            value["env"]["PTR_LLM_MAINTENANCE_DATABASE_URL"] = value["env"][
                "PTR_LLM_MAINTENANCE_DATABASE_URL"
            ].replace("ptr_split_owner", "ptr_split_llm")
        if change == "wrong-db":
            value["database"] = "ptr_split_research"
        if change == "central-without-approval":
            value["centralReview"] = {"apply": True, "queueId": "queue", "projectId": "project"}
        path.write_text(json.dumps(value))
    calls = []
    with pytest.raises(ValueError):
        module.run(path, "daily", execute=lambda *args: calls.append(args))
    assert calls == []


def test_lock_blocks_overlap_and_status_only_returns_counts(config):
    path, value = config
    import fcntl

    with open(Path(value["stateDir"]) / "maintenance.lock", "w") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(ValueError, match="MAINTENANCE_BUSY"):
            module.run(path, "daily")
    module.run(path, "weekly")
    status = module.run(path, "status")
    assert status["operation"] == "weekly" and status["executed"] == 0


def test_child_timeout_kills_group_and_hides_private_output():
    import sys
    import time

    start = time.monotonic()
    with pytest.raises(ValueError, match="MAINTENANCE_CHILD_FAILED"):
        module.execute(
            [sys.executable, "-c", "import time; print('private'); time.sleep(5)"], {}, 0.05
        )
    assert time.monotonic() - start < 2


def test_output_flood_is_bounded_and_count_deferrals_survive():
    import sys
    import time

    start = time.monotonic()
    with pytest.raises(ValueError, match="MAINTENANCE_CHILD_FAILED"):
        module.execute(
            [
                sys.executable,
                "-c",
                "import os; os.write(1,b'x'*4000000); import time; time.sleep(10)",
            ],
            {},
            2,
        )
    assert time.monotonic() - start < 2
    assert module.counts(
        {
            "deferred": {
                "legacy_unscoped": 4,
                "missing_turn": 2,
                "unsupported_kind": 1,
                "private": "secret",
            }
        }
    ) == {"deferred": {"legacy_unscoped": 4, "missing_turn": 2, "unsupported_kind": 1}}


def test_whole_job_deadline_decreases_between_children(config):
    path, value = config
    value["langfuseRetention"] = {
        "from": "2020-01-01T00:00:00Z",
        "projectId": "project",
        "queueIds": [],
    }
    path.write_text(json.dumps(value))
    times = []

    def execute(argv, env, timeout):
        import time

        times.append(timeout)
        time.sleep(0.01)
        return {}

    module.run(path, "daily", execute=execute)
    assert len(times) == 2 and times[1] < times[0] <= 90


def test_status_nested_content_is_filtered(config):
    path, value = config
    module.run(path, "weekly")
    status = Path(value["stateDir"]) / "status.json"
    data = json.loads(status.read_text())
    data["counts"] = {
        "private": {"raw": "secret"},
        "split": {"deferred": {"private": "secret", "legacy_unscoped": 1}},
    }
    status.write_text(json.dumps(data))
    assert "secret" not in json.dumps(module.run(path, "status"))


def test_central_export_requires_applying_daily_cleanup(config):
    path, value = config
    value["env"].update(
        {
            "PTR_PRODUCTION_REVIEW_APPROVAL": "approved-redacted-final-turn-review",
            "PTR_PRODUCTION_REVIEW_SALT": "a" * 64,
        }
    )
    value["centralReview"] = {"apply": True, "queueId": "queue", "projectId": "project"}
    value["langfuseRetention"] = {
        "from": "2020-01-01T00:00:00Z",
        "queueIds": ["queue"],
        "projectId": "project",
    }
    path.write_text(json.dumps(value))
    with pytest.raises(ValueError, match="MAINTENANCE_REVIEW_APPROVAL_REQUIRED"):
        module.run(path, "weekly", apply=True, execute=lambda *_: pytest.fail("must not run"))


def test_timeout_kills_grandchild_after_wrapper_leader_exits(tmp_path):
    import sys
    import time

    marker = tmp_path / "owned-grandchild-marker"
    child = (
        "import time; from pathlib import Path; time.sleep(.3); "
        f"Path({str(marker)!r}).write_text('synthetic')"
    )
    parent = f"import subprocess,sys; subprocess.Popen([sys.executable,'-c',{child!r}])"
    with pytest.raises(ValueError, match="MAINTENANCE_CHILD_FAILED"):
        module.execute([sys.executable, "-c", parent], {}, 0.08)
    time.sleep(0.35)
    assert not marker.exists()


def test_scheduled_weekly_requests_explicit_empty_counts_not_human_approval(config):
    path, value = config
    value["weekly"]["apply"] = True
    path.write_text(json.dumps(value))
    calls = []

    def execute(argv, env, timeout):
        calls.append(argv)
        return {"rows": 0, "population": 0, "dbSkipped": True, "emptySample": True}

    result = module.run(path, "weekly", scheduled=True, execute=execute)
    assert "--allow-empty" in calls[0]
    assert result["counts"]["localReview"]["emptySample"] is True
    assert result["counts"]["localReview"]["rows"] == 0


@pytest.fixture
def k8s_env(monkeypatch):
    for key in list(os.environ):
        if key.startswith("PTR_MAINTENANCE") or key.startswith("PTR_PRODUCTION_REVIEW"):
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv(
        "PTR_LLM_MAINTENANCE_DATABASE_URL",
        "postgresql://ptr_split_owner:synthetic@ptr-postgres.ptr-data.svc:5432/ptr_split_test",
    )
    monkeypatch.setenv("PTR_MAINTENANCE_SYNTHETIC_ONLY", "1")
    monkeypatch.setenv("PTR_MAINTENANCE_TIMEOUT_SECONDS", "90")
    monkeypatch.setenv("PTR_NETWORK_MODE", "cluster")
    monkeypatch.setenv("KUBERNETES_SERVICE_HOST", "10.96.0.1")
    monkeypatch.setenv(
        "PTR_LLM_DATABASE_URL_ALLOWLIST",
        "postgresql://ptr_split_owner@ptr-postgres.ptr-data.svc:5432/ptr_split_test",
    )
    monkeypatch.setenv(
        "PTR_CLUSTER_DATABASE_URL_ALLOWLIST", "postgresql://ptr-postgres.ptr-data.svc:5432"
    )
    monkeypatch.setenv("PTR_CLUSTER_DATABASE_IDENTITIES", "ptr_split_test:ptr_split_owner")


def test_k8s_split_retention_uses_env_secret_and_no_status_or_flock(k8s_env, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("PTR_MAINTENANCE_APPLY", "1")
    calls = []

    def execute(argv, env, timeout):
        calls.append((argv, env, timeout))
        return {"planned": {"turns": 0}, "deleted": {"checkpointRows": 0}}

    result = module.run_k8s("daily-split-retention", execute=execute)
    assert result["ok"] is True and result["executed"] == 1
    argv, env, timeout = calls[0]
    assert argv == [
        "ptr-llm",
        "retention",
        "--days",
        "90",
        "--limit",
        "100",
        "--apply",
        "--confirm-database",
        "ptr_split_test",
    ]
    assert env["PTR_LLM_MAINTENANCE_DATABASE_URL"].startswith("postgresql://ptr_split_owner:")
    assert env["PTR_NETWORK_MODE"] == "cluster"
    assert env["PTR_LLM_DATABASE_URL_ALLOWLIST"].startswith("postgresql://ptr_split_owner@")
    assert env["PTR_CLUSTER_DATABASE_IDENTITIES"] == "ptr_split_test:ptr_split_owner"
    assert env["KUBERNETES_SERVICE_HOST"] == "10.96.0.1"
    assert timeout == 90
    assert not (tmp_path / "status.json").exists()
    assert not (tmp_path / "maintenance.lock").exists()


def test_k8s_daily_framework_retention_skips_without_langfuse_scope(k8s_env, monkeypatch):
    calls = []
    monkeypatch.delenv("PTR_MAINTENANCE_SYNTHETIC_ONLY", raising=False)
    result = module.run_k8s(
        "daily-framework-retention",
        execute=lambda *args: calls.append(args),
    )
    assert result == {
        "operation": "daily-framework-retention",
        "applied": False,
        "executed": 0,
        "ok": True,
        "counts": {},
    }
    assert calls == []


def test_k8s_synthetic_daily_framework_retention_executes_local_ts_dry_run(k8s_env):
    calls = []

    def execute(argv, env, timeout):
        calls.append(argv)
        return {"traceIds": [], "queueItems": [], "datasetItems": []}

    result = module.run_k8s("daily-framework-retention", execute=execute)
    assert result["executed"] == 1
    assert result["counts"]["langfuseReview"] == {
        "traceIdsCount": 0,
        "queueItemsCount": 0,
        "datasetItemsCount": 0,
    }
    assert calls[0] == [
        "node",
        "--import",
        "tsx",
        "scripts/framework-retention.ts",
        "--synthetic-empty",
    ]


def test_k8s_daily_framework_retention_uses_ts_backend_command(k8s_env, monkeypatch):
    monkeypatch.delenv("PTR_MAINTENANCE_SYNTHETIC_ONLY", raising=False)
    monkeypatch.setenv("PTR_MAINTENANCE_LANGFUSE_FROM", "2020-01-01T00:00:00Z")
    monkeypatch.setenv("PTR_MAINTENANCE_LANGFUSE_QUEUE_IDS", "queue-a,queue-b")
    calls = []

    def execute(argv, env, timeout):
        calls.append(argv)
        return {"traceIds": [], "queueItems": []}

    result = module.run_k8s("daily-framework-retention", execute=execute)
    assert result["counts"]["langfuseReview"] == {"traceIdsCount": 0, "queueItemsCount": 0}
    assert calls[0][:4] == ["node", "--import", "tsx", "scripts/framework-retention.ts"]
    assert calls[0].count("--queue") == 2


def test_k8s_weekly_review_sample_only_runs_when_explicit_apply(k8s_env, monkeypatch):
    calls = []
    monkeypatch.delenv("PTR_MAINTENANCE_SYNTHETIC_ONLY", raising=False)
    assert module.run_k8s("weekly-review-sample", execute=lambda *args: calls.append(args))["executed"] == 0
    monkeypatch.setenv("PTR_MAINTENANCE_APPLY", "1")

    def execute(argv, env, timeout):
        calls.append(argv)
        return {"emptySample": True, "rows": 0}

    result = module.run_k8s(
        "weekly-review-sample",
        execute=execute,
        now=module.datetime(2026, 10, 14, tzinfo=module.UTC),
    )
    assert result["counts"]["localReview"] == {"emptySample": True, "rows": 0}
    assert calls[-1] == [
        "node",
        "--import",
        "tsx",
        "scripts/review-sample.ts",
        "--since",
        "7d",
        "--seed",
        "20261014",
        "--prune",
        "--allow-empty",
    ]


def test_k8s_synthetic_weekly_review_sample_executes_empty_dry_run(k8s_env, monkeypatch):
    calls = []

    def execute(argv, env, timeout):
        calls.append(argv)
        return {"emptySample": True, "rows": 0}

    result = module.run_k8s(
        "weekly-review-sample",
        execute=execute,
        now=module.datetime(2026, 10, 14, tzinfo=module.UTC),
    )
    assert result["executed"] == 1
    assert result["counts"]["localReview"]["emptySample"] is True
    assert calls[0] == [
        "node",
        "--import",
        "tsx",
        "scripts/review-sample.ts",
        "--since",
        "7d",
        "--seed",
        "20261014",
        "--prune",
        "--allow-empty",
    ]


def test_k8s_synthetic_production_review_uses_ephemeral_status_dir(k8s_env, tmp_path, monkeypatch):
    state = tmp_path / "review-state"
    monkeypatch.setenv("PTR_MAINTENANCE_REVIEW_STATE_DIR", str(state))
    calls = []

    def execute(argv, env, timeout):
        calls.append(argv)
        return {"journals": 0, "unknown": 0, "queued": 0, "locked": 0}

    result = module.run_k8s("weekly-production-review", execute=execute)
    assert result["executed"] == 1
    assert result["counts"]["centralReview"] == {
        "journals": 0,
        "unknown": 0,
        "queued": 0,
        "locked": 0,
    }
    assert calls[0] == [
        "node",
        "--import",
        "tsx",
        "scripts/production-review.ts",
        "--status",
        "--state-dir",
        str(state),
    ]
    assert state.is_dir()
    assert (state.stat().st_mode & 0o077) == 0


def test_k8s_rejects_non_synthetic_target_when_required(k8s_env, monkeypatch):
    monkeypatch.setenv(
        "PTR_LLM_MAINTENANCE_DATABASE_URL",
        "postgresql://ptr_split_owner:synthetic@ptr-postgres.ptr-data.svc:5432/ptr_split_research",
    )
    with pytest.raises(ValueError, match="MAINTENANCE_SYNTHETIC_SCOPE_REQUIRED"):
        module.run_k8s("daily-split-retention", execute=lambda *_: {})


def test_k8s_rejects_synthetic_named_external_target_when_required(k8s_env, monkeypatch):
    monkeypatch.setenv(
        "PTR_LLM_MAINTENANCE_DATABASE_URL",
        "postgresql://ptr_split_owner:synthetic@postgres.example.invalid:5432/ptr_split_test",
    )
    with pytest.raises(ValueError, match="MAINTENANCE_SYNTHETIC_SCOPE_REQUIRED"):
        module.run_k8s("daily-split-retention", execute=lambda *_: {})


def test_k8s_rejects_host_operations(k8s_env):
    with pytest.raises(ValueError, match="MAINTENANCE_OPERATION_INVALID"):
        module.run_k8s("daily", execute=lambda *_: {})
