#!/usr/bin/env python3
"""Own, run and remove only immutable IDs in a disposable real-worker C4 stack."""

import json
import os
import subprocess
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def main():
    os.umask(0o077)
    project = "ptr-c4-" + uuid.uuid4().hex[:12]
    report = ROOT / "reports" / "compose-acceptance" / project
    report.mkdir(parents=True, mode=0o700)
    base = [
        "docker",
        "compose",
        "--project-name",
        project,
        "--env-file",
        "/dev/null",
        "-f",
        str(HERE / "compose.c4.yml"),
    ]
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith(("PTR_", "OPENROUTER", "LANGCHAIN", "LANGSMITH"))
    }
    env["PTR_C4_EVIDENCE_DIR"] = str(report)
    if "PTR_ACCEPTANCE_IMAGE" in os.environ:
        env["PTR_ACCEPTANCE_IMAGE"] = os.environ["PTR_ACCEPTANCE_IMAGE"]
    ids, networks = [], []

    def command(args, timeout=60, check=True):
        result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=timeout)
        if check and result.returncode:
            raise RuntimeError("command failed: " + args[0] + " (private log retained)")
        return result

    def record():
        ids[:] = sorted(set(ids) | set(command(base + ["ps", "-aq"]).stdout.split()))
        networks[:] = sorted(
            set(networks)
            | set(
                command(
                    [
                        "docker",
                        "network",
                        "ls",
                        "-q",
                        "--filter",
                        "label=com.docker.compose.project=" + project,
                    ]
                ).stdout.split()
            )
        )
        (report / "resources.json").write_text(
            json.dumps(
                {"project": project, "container_ids": ids, "network_ids": networks}, indent=2
            )
            + "\n"
        )

    def service(name):
        result = command(base + ["ps", "-aq", name]).stdout.strip()
        assert result in ids
        return result

    exit_code = 1
    try:
        startup = command(
            base + ["up", "-d", "--wait", "postgres", "redis"], timeout=90, check=False
        )
        (report / "startup.log").write_text(startup.stdout + startup.stderr)
        record()
        if startup.returncode:
            raise RuntimeError("isolated store startup failed")
        command(base + ["create", "bootstrap"])
        record()
        bootstrap = service("bootstrap")
        started = command(["docker", "start", "-a", bootstrap], timeout=100, check=False)
        (report / "bootstrap.log").write_text(started.stdout + started.stderr)
        if (
            command(
                ["docker", "inspect", "--format", "{{.State.ExitCode}}", bootstrap]
            ).stdout.strip()
            != "0"
        ):
            raise RuntimeError("synthetic split bootstrap failed")
        command(base + ["create", "api", "worker", "probe"])
        record()
        api, worker, probe = (service(name) for name in ("api", "worker", "probe"))
        command(["docker", "start", api])
        with (report / "probe.log").open("w") as log:
            process = subprocess.Popen(
                ["docker", "start", "-a", probe], env=env, stdout=log, stderr=subprocess.STDOUT
            )
            try:
                time.sleep(1)
                command(["docker", "start", worker])
                limit = time.monotonic() + 50
                while not (report / "in-flight").exists():
                    if process.poll() is not None or time.monotonic() >= limit:
                        raise RuntimeError("real worker did not enter local call")
                    time.sleep(0.05)
                owner = command(
                    [
                        "docker",
                        "inspect",
                        "--format",
                        '{{index .Config.Labels "com.docker.compose.project"}}',
                        worker,
                    ]
                ).stdout.strip()
                assert owner == project
                command(["docker", "kill", worker])
                (report / "killed").write_text("1\n")
                command(["docker", "start", worker])
                (report / "restarted").write_text("1\n")
                process.wait(timeout=180)
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
        exit_code = int(
            command(["docker", "inspect", "--format", "{{.State.ExitCode}}", probe]).stdout.strip()
        )
    except Exception as error:
        (report / "error.txt").write_text(type(error).__name__ + ": " + str(error) + "\n")
    finally:
        record()
        for name in ("api", "worker"):
            container = command(base + ["ps", "-aq", name]).stdout.strip()
            if container in ids:
                result = command(["docker", "logs", container], check=False)
                (report / (name + ".log")).write_text(result.stdout + result.stderr)
        cleanup = []
        for container in reversed(ids):
            try:
                inspected = command(
                    [
                        "docker",
                        "inspect",
                        "--type",
                        "container",
                        "--format",
                        '{{index .Config.Labels "com.docker.compose.project"}}',
                        container,
                    ],
                    check=False,
                )
                if inspected.returncode == 0:
                    assert inspected.stdout.strip() == project
                    command(["docker", "rm", "-f", "-v", container], check=False)
                absent = (
                    command(
                        ["docker", "inspect", "--type", "container", container], check=False
                    ).returncode
                    != 0
                )
            except Exception:
                absent = False
            cleanup.append({"container_id": container, "removed": absent})
        for network in networks:
            try:
                inspected = command(
                    [
                        "docker",
                        "network",
                        "inspect",
                        "--format",
                        '{{index .Labels "com.docker.compose.project"}}',
                        network,
                    ],
                    check=False,
                )
                if inspected.returncode == 0:
                    assert inspected.stdout.strip() == project
                    command(["docker", "network", "rm", network], check=False)
                absent = (
                    command(["docker", "network", "inspect", network], check=False).returncode != 0
                )
            except Exception:
                absent = False
            cleanup.append({"network_id": network, "removed": absent})
        try:
            remaining_containers = set(
                command(["docker", "ps", "-aq", "--no-trunc"]).stdout.split()
            )
            remaining_networks = set(
                command(["docker", "network", "ls", "-q", "--no-trunc"]).stdout.split()
            )
            for item in cleanup:
                identifier = item.get("container_id", item.get("network_id"))
                remaining = remaining_containers if "container_id" in item else remaining_networks
                item["removed"] = item["removed"] and (
                    not any(current.startswith(identifier) for current in remaining)
                )
        except Exception:
            for item in cleanup:
                item["removed"] = False
        (report / "cleanup.json").write_text(json.dumps(cleanup, indent=2) + "\n")
        if not all(item["removed"] for item in cleanup):
            exit_code = 1
        (report / "summary.json").write_text(
            json.dumps(
                {
                    "project": project,
                    "exit_code": exit_code,
                    "cleanup_complete": all(item["removed"] for item in cleanup),
                },
                indent=2,
            )
            + "\n"
        )
        for path in report.iterdir():
            path.chmod(0o600)
        print(
            json.dumps(
                {
                    "project": project,
                    "exit_code": exit_code,
                    "report": str(report),
                    "cleanup_complete": all(item["removed"] for item in cleanup),
                }
            )
        )
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
