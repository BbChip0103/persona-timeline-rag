#!/usr/bin/env python3
"""Own resources by recorded immutable ID; retain only private synthetic run evidence."""

import datetime
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent


def main():
    os.umask(0o077)
    project = "ptr-cacc-" + uuid.uuid4().hex[:12]
    report = ROOT / "reports" / "compose-acceptance" / project
    report.mkdir(parents=True, mode=0o700)
    ids = []
    networks = []
    base = [
        "docker",
        "compose",
        "--project-name",
        project,
        "--env-file",
        "/dev/null",
        "-f",
        str(HERE / "compose.yml"),
    ]
    env = {
        k: v
        for k, v in os.environ.items()
        if not k.startswith(("PTR_", "OPENROUTER", "LANGCHAIN", "LANGSMITH"))
    }
    if "PTR_ACCEPTANCE_IMAGE" in os.environ:
        env["PTR_ACCEPTANCE_IMAGE"] = os.environ["PTR_ACCEPTANCE_IMAGE"]

    def command(args, timeout=240, check=True):
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
            json.dumps(dict(project=project, container_ids=ids, network_ids=networks), indent=2)
            + "\n"
        )

    result_code = 1
    try:
        command([sys.executable, str(HERE / "test_contract.py")])
        startup = command(base + ["up", "-d", "--wait", "postgres", "redis"], check=False)
        (report / "startup.log").write_text(startup.stdout + startup.stderr)
        record()
        if startup.returncode:
            raise RuntimeError("isolated store startup failed")
        command(base + ["create", "runner"])
        record()
        runner = command(base + ["ps", "-aq", "runner"]).stdout.strip()
        assert runner in ids
        run = command(["docker", "start", "-a", runner], timeout=220, check=False)
        (report / "run.log").write_text(run.stdout + run.stderr)
        status = command(["docker", "inspect", "--format", "{{.State.ExitCode}}", runner]).stdout
        result_code = int(status.strip())
    except Exception as error:
        (report / "error.txt").write_text(type(error).__name__ + ": " + str(error) + "\n")
    finally:
        # Only UUID project resources may enter the deletion set, and every deletion uses IDs.
        record()
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
            result_code = 1
        (report / "summary.json").write_text(
            json.dumps(
                dict(
                    project=project,
                    utc=datetime.datetime.now(datetime.UTC).isoformat(),
                    exit_code=result_code,
                    containers=len(ids),
                    cleanup_complete=all(i["removed"] for i in cleanup),
                ),
                indent=2,
            )
            + "\n"
        )
        for path in report.iterdir():
            path.chmod(0o600)
        print(
            json.dumps(
                dict(
                    project=project,
                    exit_code=result_code,
                    report=str(report),
                    cleanup_complete=all(i["removed"] for i in cleanup),
                )
            )
        )
    return result_code


if __name__ == "__main__":
    raise SystemExit(main())
