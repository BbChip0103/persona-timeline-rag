#!/usr/bin/env python3
"""Owner-only host maintenance, never imported by app/worker. Stdlib, counts-only output."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import selectors
import signal
import stat
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
ENV_KEYS = {
    "PTR_LLM_MAINTENANCE_DATABASE_URL",
    "LANGFUSE_BASE_URL",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LANGFUSE_ALLOW_LOCAL_HTTP",
    "FRAMEWORK_RELEASE",
    "PTR_PRODUCTION_REVIEW_SALT",
    "PTR_PRODUCTION_REVIEW_APPROVAL",
}
K8S_OPERATIONS = {
    "daily-split-retention",
    "daily-framework-retention",
    "weekly-review-sample",
    "weekly-production-review",
}


def private(path: Path, *, directory=False):
    info = path.lstat()
    valid = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if not valid or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError("MAINTENANCE_PRIVATE_PATH_REQUIRED")
    return info


def load(path: Path):
    if private(path).st_size > 65536:
        raise ValueError("MAINTENANCE_CONFIG_LIMIT")
    private(path.parent, directory=True)
    config = json.loads(path.read_text())
    if set(config) - {
        "database",
        "stateDir",
        "timeoutSeconds",
        "env",
        "daily",
        "weekly",
        "langfuseRetention",
        "centralReview",
    }:
        raise ValueError("MAINTENANCE_CONFIG_INVALID")
    env = config.get("env", {})
    if (
        not isinstance(env, dict)
        or set(env) - ENV_KEYS
        or any(not isinstance(v, str) or "\x00" in v or "\n" in v for v in env.values())
    ):
        raise ValueError("MAINTENANCE_ENV_INVALID")
    parsed = urlsplit(env.get("PTR_LLM_MAINTENANCE_DATABASE_URL", ""))
    if (
        parsed.scheme not in {"postgres", "postgresql"}
        or parsed.hostname != "127.0.0.1"
        or parsed.port != 58432
        or parsed.username != "ptr_split_owner"
        or not parsed.password
        or parsed.query
        or parsed.fragment
        or config.get("database") not in {"ptr_split_test", "ptr_split_research"}
        or parsed.path != "/" + config["database"]
    ):
        raise ValueError("MAINTENANCE_OWNER_SCOPE_INVALID")
    state_dir = Path(config["stateDir"])
    if not state_dir.is_absolute():
        raise ValueError("MAINTENANCE_STATE_INVALID")
    private(state_dir, directory=True)
    timeout = config.get("timeoutSeconds", 90)
    if type(timeout) is not int or not 30 <= timeout <= 300:
        raise ValueError("MAINTENANCE_TIMEOUT_INVALID")
    for operation in ("daily", "weekly"):
        settings = config.get(operation, {})
        if type(settings.get("apply", False)) is not bool or set(settings) - (
            {"apply", "limit"} if operation == "daily" else {"apply", "sinceDays"}
        ):
            raise ValueError("MAINTENANCE_OPERATION_INVALID")
    limit = config.get("daily", {}).get("limit", 100)
    since = config.get("weekly", {}).get("sinceDays", 7)
    if (
        type(limit) is not int
        or not 1 <= limit <= 1000
        or type(since) is not int
        or not 1 <= since <= 7
    ):
        raise ValueError("MAINTENANCE_LIMIT_INVALID")
    lf = config.get("langfuseRetention")
    if lf is not None:
        if (
            set(lf) - {"from", "projectId", "queueIds"}
            or not lf.get("from")
            or not lf.get("projectId")
            or not isinstance(lf.get("queueIds", []), list)
            or not all(isinstance(q, str) and q for q in lf.get("queueIds", []))
        ):
            raise ValueError("MAINTENANCE_LANGFUSE_SCOPE_INVALID")
    central = config.get("centralReview")
    if central is not None:
        if (
            set(central) - {"apply", "queueId", "projectId"}
            or type(central.get("apply", False)) is not bool
            or not central.get("queueId")
            or not central.get("projectId")
        ):
            raise ValueError("MAINTENANCE_REVIEW_SCOPE_INVALID")
        if central.get("apply") and (
            config.get("daily", {}).get("apply") is not True
            or env.get("PTR_PRODUCTION_REVIEW_APPROVAL") != "approved-redacted-final-turn-review"
            or len(env.get("PTR_PRODUCTION_REVIEW_SALT", "")) != 64
            or lf is None
            or central["projectId"] != lf["projectId"]
            or central["queueId"] not in lf.get("queueIds", [])
        ):
            raise ValueError("MAINTENANCE_REVIEW_APPROVAL_REQUIRED")
    return config


def execute(argv, env, timeout):
    process = subprocess.Popen(
        argv,
        cwd=ROOT,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    output = bytearray()
    deadline = time.monotonic() + timeout
    assert process.stdout is not None
    os.set_blocking(process.stdout.fileno(), False)
    try:
        with selectors.DefaultSelector() as selector:
            selector.register(process.stdout, selectors.EVENT_READ)
            while selector.get_map():
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise ValueError("MAINTENANCE_CHILD_FAILED")
                for key, _ in selector.select(min(0.1, remaining)):
                    chunk = os.read(key.fd, min(65536, 2 * 1024 * 1024 + 1 - len(output)))
                    if not chunk:
                        selector.unregister(key.fileobj)
                        continue
                    output.extend(chunk)
                    if len(output) > 2 * 1024 * 1024:
                        raise ValueError("MAINTENANCE_CHILD_FAILED")
        process.wait(timeout=max(0.001, deadline - time.monotonic()))
        if process.returncode:
            raise ValueError("MAINTENANCE_CHILD_FAILED")
        return json.loads(output)
    except (ValueError, UnicodeError, subprocess.TimeoutExpired):
        raise ValueError("MAINTENANCE_CHILD_FAILED") from None
    finally:
        # The wrapper leader may exit while its pnpm/uv grandchildren still own
        # stdout or export work. Kill the entire owned group, not just the leader.
        try:
            os.killpg(process.pid, signal.SIGTERM)
            grace = time.monotonic() + 0.2
            while time.monotonic() < grace:
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.01)
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        except ProcessLookupError:
            pass
        try:
            process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            pass
        process.stdout.close()


def invoke(argv, env, timeout, *, execute=execute):
    return counts(execute(argv, env, timeout))


def maintenance_database(env: dict[str, str], *, synthetic_only: bool) -> str:
    url = env.get("PTR_LLM_MAINTENANCE_DATABASE_URL") or env.get("PTR_MAINTENANCE_DATABASE_URL", "")
    parsed = urlsplit(url)
    database = parsed.path.lstrip("/")
    if (
        parsed.scheme not in {"postgres", "postgresql"}
        or parsed.username != "ptr_split_owner"
        or database not in {"ptr_split_test", "ptr_split_research"}
    ):
        raise ValueError("MAINTENANCE_OWNER_SCOPE_INVALID")
    if synthetic_only and (
        database != "ptr_split_test"
        or parsed.hostname != "ptr-postgres.ptr-data.svc"
        or parsed.port != 5432
    ):
        raise ValueError("MAINTENANCE_SYNTHETIC_SCOPE_REQUIRED")
    return database


def truthy(value: str | None) -> bool:
    return value in {"1", "true", "TRUE", "yes", "YES"}


def ensure_private_dir(path: str) -> None:
    directory = Path(path)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    private(directory, directory=True)


def k8s_env() -> dict[str, str]:
    env = {k: os.environ[k] for k in ("PATH", "HOME", "LANG", "USER") if k in os.environ}
    for key in (
        "PTR_LLM_MAINTENANCE_DATABASE_URL",
        "PTR_MAINTENANCE_DATABASE_URL",
        "PTR_MAINTENANCE_DAILY_LIMIT",
        "PTR_MAINTENANCE_WEEKLY_SINCE_DAYS",
        "PTR_MAINTENANCE_TIMEOUT_SECONDS",
        "PTR_MAINTENANCE_APPLY",
        "PTR_MAINTENANCE_SYNTHETIC_ONLY",
        "PTR_NETWORK_MODE",
        "PTR_LLM_DATABASE_URL_ALLOWLIST",
        "PTR_CLUSTER_DATABASE_URL_ALLOWLIST",
        "PTR_CLUSTER_DATABASE_IDENTITIES",
        "KUBERNETES_SERVICE_HOST",
        "PTR_MAINTENANCE_LANGFUSE_FROM",
        "PTR_MAINTENANCE_LANGFUSE_PROJECT_ID",
        "PTR_MAINTENANCE_LANGFUSE_QUEUE_IDS",
        "PTR_MAINTENANCE_REVIEW_QUEUE_ID",
        "PTR_MAINTENANCE_REVIEW_STATE_DIR",
        "PTR_PRODUCTION_REVIEW_APPROVAL",
        "PTR_PRODUCTION_REVIEW_SALT",
        "LANGFUSE_BASE_URL",
        "LANGFUSE_PUBLIC_KEY",
        "LANGFUSE_SECRET_KEY",
        "LANGFUSE_ALLOW_LOCAL_HTTP",
    ):
        if key in os.environ:
            env[key] = os.environ[key]
    env.update({"LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false"})
    if "PTR_LLM_MAINTENANCE_DATABASE_URL" not in env and "PTR_MAINTENANCE_DATABASE_URL" in env:
        env["PTR_LLM_MAINTENANCE_DATABASE_URL"] = env["PTR_MAINTENANCE_DATABASE_URL"]
    return env


def run_k8s(operation: str, *, execute=execute, now: datetime | None = None):
    if operation not in K8S_OPERATIONS:
        raise ValueError("MAINTENANCE_OPERATION_INVALID")
    env = k8s_env()
    synthetic_only = truthy(env.get("PTR_MAINTENANCE_SYNTHETIC_ONLY"))
    database = maintenance_database(env, synthetic_only=synthetic_only)
    timeout = int(env.get("PTR_MAINTENANCE_TIMEOUT_SECONDS", "300"))
    if not 30 <= timeout <= 300:
        raise ValueError("MAINTENANCE_TIMEOUT_INVALID")
    apply = truthy(env.get("PTR_MAINTENANCE_APPLY"))
    step_counts: dict[str, dict[str, object]] = {}
    executed_count = 0
    result = {
        "operation": operation,
        "applied": apply,
        "executed": 0,
        "ok": False,
        "counts": step_counts,
    }

    def call(name: str, argv: list[str]):
        nonlocal executed_count
        step_counts[name] = invoke(argv, env, timeout, execute=execute)
        executed_count += 1

    if operation == "daily-split-retention":
        limit = env.get("PTR_MAINTENANCE_DAILY_LIMIT", "100")
        if not limit.isdigit() or not 1 <= int(limit) <= 1000:
            raise ValueError("MAINTENANCE_LIMIT_INVALID")
        argv = ["ptr-llm", "retention", "--days", "90", "--limit", limit]
        if apply:
            argv += ["--apply", "--confirm-database", database]
        call("split", argv)
    elif operation == "daily-framework-retention":
        start = env.get("PTR_MAINTENANCE_LANGFUSE_FROM")
        if synthetic_only:
            call(
                "langfuseReview",
                ["node", "--import", "tsx", "scripts/framework-retention.ts", "--synthetic-empty"],
            )
        elif start:
            argv = [
                "node",
                "--import",
                "tsx",
                "scripts/framework-retention.ts",
                "--environment",
                "production-review",
                "--from",
                start,
            ]
            for queue in filter(None, env.get("PTR_MAINTENANCE_LANGFUSE_QUEUE_IDS", "").split(",")):
                argv += ["--queue", queue]
            if apply:
                project = env.get("PTR_MAINTENANCE_LANGFUSE_PROJECT_ID", "")
                if not project:
                    raise ValueError("MAINTENANCE_REVIEW_APPROVAL_REQUIRED")
                argv += ["--apply", "--confirm-project", project]
            call("langfuseReview", argv)
    elif operation == "weekly-review-sample":
        if apply or synthetic_only:
            since_days = env.get("PTR_MAINTENANCE_WEEKLY_SINCE_DAYS", "7")
            if not since_days.isdigit() or not 1 <= int(since_days) <= 7:
                raise ValueError("MAINTENANCE_LIMIT_INVALID")
            seed = str(int((now or datetime.now(UTC)).strftime("%Y%m%d")))
            call(
                "localReview",
                [
                    "node",
                    "--import",
                    "tsx",
                    "scripts/review-sample.ts",
                    "--since",
                    since_days + "d",
                    "--seed",
                    seed,
                    "--prune",
                    "--allow-empty",
                ],
            )
    elif operation == "weekly-production-review":
        review_queue = env.get("PTR_MAINTENANCE_REVIEW_QUEUE_ID")
        state_dir = env.get("PTR_MAINTENANCE_REVIEW_STATE_DIR")
        if synthetic_only:
            if not state_dir:
                raise ValueError("MAINTENANCE_REVIEW_SCOPE_INVALID")
            ensure_private_dir(state_dir)
            call(
                "centralReview",
                [
                    "node",
                    "--import",
                    "tsx",
                    "scripts/production-review.ts",
                    "--status",
                    "--state-dir",
                    state_dir,
                ],
            )
        elif state_dir:
            ensure_private_dir(state_dir)
        if apply and review_queue and state_dir:
            if env.get("PTR_PRODUCTION_REVIEW_APPROVAL") != "approved-redacted-final-turn-review":
                raise ValueError("MAINTENANCE_REVIEW_APPROVAL_REQUIRED")
            seed = str(int((now or datetime.now(UTC)).strftime("%Y%m%d")))
            since_days = env.get("PTR_MAINTENANCE_WEEKLY_SINCE_DAYS", "7")
            argv = [
                "node",
                "--import",
                "tsx",
                "scripts/production-review.ts",
                "--since",
                since_days + "d",
                "--seed",
                seed,
                "--queue",
                review_queue,
                "--state-dir",
                state_dir,
                "--apply",
            ]
            review_project = env.get("PTR_MAINTENANCE_LANGFUSE_PROJECT_ID")
            if review_project:
                argv += ["--confirm-project", review_project]
            call("centralReview", argv)
    result["executed"] = executed_count
    result["ok"] = True
    return result


def counts(value):
    """Allow numeric counters/flags only; IDs/credentials/payloads never enter logs/status."""
    if not isinstance(value, dict):
        raise ValueError("MAINTENANCE_COUNTS_INVALID")
    allowed = {
        "planned",
        "deleted",
        "deferred",
        "turns",
        "checkpointThreads",
        "resultReceipts",
        "grantSnapshots",
        "providerReceipts",
        "checkpointRows",
        "rows",
        "db",
        "s8",
        "personas",
        "population",
        "s8Population",
        "strata",
        "pruned",
        "dbSkipped",
        "emptySample",
        "exported",
        "queued",
        "existing",
        "applied",
        "legacy_unscoped",
        "missing_turn",
        "unsupported_kind",
        "legacyUnscopedReceipts",
        "missingTurnReceipts",
        "unsupportedReceiptKinds",
        "orphanResultReceipts",
        "unselectedCheckpointThreads",
        "deletionSubmitted",
        "historicalDatasetErasureVerified",
        "journals",
        "unknown",
        "queued",
        "locked",
    }
    result = {
        k: counts(v) if isinstance(v, dict) else v
        for k, v in value.items()
        if k in allowed and (type(v) in {int, bool} or isinstance(v, dict))
    }
    for key in ("traceIds", "queueItems", "datasetItems"):
        if isinstance(value.get(key), list):
            result[key + "Count"] = len(value[key])
    return result


def run(path: Path, operation: str, *, apply=False, scheduled=False, execute=execute):
    config = load(path)
    state = Path(config["stateDir"])
    status_file = state / "status.json"
    if operation == "status":
        if not status_file.exists():
            return {"configured": True, "executed": 0}
        private(status_file)
        value = json.loads(status_file.read_text())
        if (
            value.get("operation") not in {"daily", "weekly"}
            or any(type(value.get(k)) is not bool for k in ("applied", "ok"))
            or any(type(value.get(k)) is not int or value[k] < 0 for k in ("executed", "elapsedMs"))
        ):
            raise ValueError("MAINTENANCE_STATUS_INVALID")
        result = {k: value[k] for k in ("operation", "applied", "ok", "executed", "elapsedMs")}
        for key in ("startedAt", "finishedAt"):
            result[key] = datetime.fromisoformat(value[key]).isoformat()
        result["counts"] = {
            k: counts(v)
            for k, v in value.get("counts", {}).items()
            if k in {"split", "langfuseReview", "localReview", "centralReview"}
        }
        return result
    if operation not in {"daily", "weekly"}:
        raise ValueError("MAINTENANCE_OPERATION_INVALID")
    flags = os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW
    lock_path = state / "maintenance.lock"
    with os.fdopen(os.open(lock_path, flags, 0o600), "r+") as lock:
        private(lock_path)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("MAINTENANCE_BUSY") from None
        started = time.monotonic()
        mutate = apply or (scheduled and config.get(operation, {}).get("apply", False))
        result = {
            "operation": operation,
            "startedAt": datetime.now(UTC).isoformat(),
            "applied": bool(mutate),
            "executed": 0,
            "ok": False,
            "counts": {},
        }
        env = {k: os.environ[k] for k in ("PATH", "HOME", "LANG", "USER") if k in os.environ}
        env.update(config["env"])
        env.update({"LANGSMITH_TRACING": "false", "LANGCHAIN_TRACING_V2": "false"})
        timeout = config.get("timeoutSeconds", 90)

        def invoke(name, argv):
            remaining = timeout - (time.monotonic() - started)
            if remaining <= 0:
                raise ValueError("MAINTENANCE_JOB_DEADLINE")
            result["counts"][name] = counts(execute(argv, env, remaining))
            result["executed"] += 1

        try:
            if operation == "daily":
                argv = [
                    "uv",
                    "run",
                    "--no-sync",
                    "--project",
                    "apps/llm-service",
                    "ptr-llm",
                    "retention",
                    "--days",
                    "90",
                    "--limit",
                    str(config.get("daily", {}).get("limit", 100)),
                ]
                if mutate:
                    argv += ["--apply", "--confirm-database", config["database"]]
                invoke("split", argv)
                if config.get("langfuseRetention"):
                    lf = config["langfuseRetention"]
                    argv = [
                        "pnpm",
                        "exec",
                        "tsx",
                        "scripts/framework-retention.ts",
                        "--environment",
                        "production-review",
                        "--from",
                        lf["from"],
                    ]
                    for queue in lf.get("queueIds", []):
                        argv += ["--queue", queue]
                    if mutate:
                        argv += ["--apply", "--confirm-project", lf["projectId"]]
                    invoke("langfuseReview", argv)
            elif mutate:
                seed = str(int(datetime.now(UTC).strftime("%Y%m%d")))
                since = str(config.get("weekly", {}).get("sinceDays", 7)) + "d"
                invoke(
                    "localReview",
                    [
                        "pnpm",
                        "exec",
                        "tsx",
                        "scripts/review-sample.ts",
                        "--since",
                        since,
                        "--seed",
                        seed,
                        "--prune",
                        "--allow-empty",
                    ],
                )
                central = config.get("centralReview")
                if central and central.get("apply"):
                    review_state = state / "central-review"
                    review_state.mkdir(mode=0o700, exist_ok=True)
                    private(review_state, directory=True)
                    invoke(
                        "centralReview",
                        [
                            "pnpm",
                            "exec",
                            "tsx",
                            "scripts/production-review.ts",
                            "--since",
                            since,
                            "--seed",
                            seed,
                            "--queue",
                            central["queueId"],
                            "--state-dir",
                            str(review_state),
                            "--apply",
                            "--confirm-project",
                            central["projectId"],
                        ],
                    )
            result["ok"] = True
            return result
        finally:
            result.update(
                {
                    "finishedAt": datetime.now(UTC).isoformat(),
                    "elapsedMs": round((time.monotonic() - started) * 1000),
                }
            )
            temporary = state / "status.pending.json"
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "w") as stream:
                json.dump(result, stream)
                stream.flush()
                os.fsync(stream.fileno())
            private(temporary)
            temporary.replace(status_file)
            directory_fd = os.open(state, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path)
    parser.add_argument(
        "--operation",
        choices=["daily", "weekly", "status", *sorted(K8S_OPERATIONS)],
        required=True,
    )
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--scheduled", action="store_true")
    parser.add_argument("--k8s", action="store_true")
    args = parser.parse_args()
    try:
        if args.k8s:
            print(json.dumps(run_k8s(args.operation)))
        else:
            if args.config is None:
                raise ValueError("MAINTENANCE_CONFIG_REQUIRED")
            print(
                json.dumps(
                    run(args.config, args.operation, apply=args.apply, scheduled=args.scheduled)
                )
            )
        return 0
    except Exception:
        print(json.dumps({"ok": False, "error": "MAINTENANCE_FAILED_PRIVATE_DETAILS_WITHHELD"}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
