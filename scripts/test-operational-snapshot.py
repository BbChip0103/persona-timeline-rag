"""Synthetic tests for the operational rollback snapshot helper."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("operational-snapshot.py")
SERVICES = ("api", "web", "worker", "model-gateway", "model-gateway-db", "model-gateway-redis")


def run(*args: Path | str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *(str(arg) for arg in args)],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )


def inspect_row(service: str, project: str, owner: str, root: Path) -> dict[str, object]:
    digest = f"{abs(hash(service)):064x}"[-64:]
    config_files = ",".join(
        str(root / path)
        for path in (
            "infra/compose.app.yml",
            "infra/split/compose.operational.yml",
            "infra/split/site.yml",
        )
    )
    labels = {
        "com.docker.compose.project": project,
        "com.docker.compose.service": service,
        "ptr.operational.owner": owner,
        "com.docker.compose.project.config_files": config_files,
        "com.docker.compose.project.working_dir": str(root),
        "com.docker.compose.project.environment_file": str(root / "private" / "op.env"),
        "com.docker.compose.config-hash": digest,
    }
    return {
        "Id": f"container-{service}",
        "Name": f"/{project}-{service}-1",
        "Image": f"sha256:{digest}",
        "State": {"Running": True},
        "Config": {"Image": f"example/{service}:deployed", "Labels": labels},
        "Mounts": [
            {
                "Type": "bind",
                "Source": str(root / "private" / f"{service}.env"),
                "Destination": "/app/published-personas.private.json",
            },
            {"Type": "volume", "Source": str(root.parent / "docker-volume-should-not-be-copied")},
        ],
    }


class OperationalSnapshotTests(unittest.TestCase):
    def write_fixture(self, folder: Path, owner: str = "owner-nonce") -> tuple[Path, Path]:
        project = "ptr-op"
        deployed = folder / "deployed"
        (deployed / "infra" / "split").mkdir(parents=True)
        (deployed / "private").mkdir()
        (deployed / "private" / "op.env").write_text("OP_SECRET=hidden\n")
        (deployed / "mounted-code" / "gateway").mkdir(parents=True)
        (deployed / "mounted-code" / "empty").mkdir()
        (deployed / "mounted-code" / "empty").chmod(0o755)
        (folder / "docker-volume-should-not-be-copied").mkdir()
        (folder / "docker-volume-should-not-be-copied" / "volume.txt").write_text("skip me\n")
        (deployed / "infra" / "compose.app.yml").write_text("services: {}\n", encoding="utf-8")
        (deployed / "infra" / "split" / "compose.operational.yml").write_text(
            "services: {}\n", encoding="utf-8"
        )
        (deployed / "infra" / "split" / "site.yml").write_text("services: {}\n", encoding="utf-8")
        (deployed / "mounted-code" / "gateway" / "router.py").write_text(
            "ROUTER = 'synthetic-private'\n", encoding="utf-8"
        )
        (deployed / "mounted-code" / "gateway" / "router-link.py").symlink_to("router.py")
        (deployed / "data" / "generated").mkdir(parents=True)
        (deployed / "data" / "generated" / "draft.json").write_text('{"draft":true}\n')
        for service in SERVICES:
            (deployed / "private" / f"{service}.env").write_text(
                f"SECRET_{service}=hidden\n", encoding="utf-8"
            )
            (deployed / "private" / f"{service}.env").chmod(0o600)
        fixture = folder / "inspect.json"
        rows = [inspect_row(service, project, owner, deployed) for service in SERVICES]
        rows[3]["Config"]["Image"] = "example/gateway:stable@sha256:" + "a" * 64
        rows[0]["Mounts"].append(
            {
                "Type": "bind",
                "Source": str(deployed / "data" / "generated"),
                "Destination": "/app/data/generated",
            }
        )
        fixture.write_text(
            json.dumps(rows),
            encoding="utf-8",
        )
        return deployed, fixture

    def fake_docker(self, folder: Path, fixture: Path, mismatch: bool = False) -> dict[str, str]:
        rows = json.loads(fixture.read_text())
        hashes = {
            row["Config"]["Labels"]["com.docker.compose.service"]: row["Config"]["Labels"][
                "com.docker.compose.config-hash"
            ]
            for row in rows
        }
        if mismatch:
            hashes["api"] = "f" * 64
        bin_dir = folder / "bin"
        bin_dir.mkdir()
        executable = bin_dir / "docker"
        env_path = rows[0]["Config"]["Labels"]["com.docker.compose.project.environment_file"]
        if not Path(env_path).is_absolute():
            env_path = str(
                Path(rows[0]["Config"]["Labels"]["com.docker.compose.project.working_dir"])
                / env_path
            )
        hash_lines = "".join(f"{service} {digest}\n" for service, digest in hashes.items())
        executable.write_text(
            "#!/usr/bin/env python3\nimport sys\n"
            "assert sys.argv[1:3] == ['compose', '--env-file']\n"
            f"assert sys.argv[3] == {env_path!r}\n"
            "assert sys.argv[4:6] == ['-p', 'ptr-op']\n"
            "assert sys.argv[-3:] == ['config', '--hash', '*']\n"
            f"print({hash_lines!r}, end='')\n"
        )
        executable.chmod(0o755)
        return {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}

    def test_capture_records_owned_sources_and_restores_from_snapshot_tool(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            deployed, fixture = self.write_fixture(folder)
            extra = folder / "private-compose.env"
            extra.write_text("EXTRA_SECRET=hidden\n", encoding="utf-8")
            extra.chmod(0o600)
            snapshot = folder / "snapshot"
            result = run(
                "capture",
                "--project",
                "ptr-op",
                "--owner",
                "owner-nonce",
                "--output",
                snapshot,
                "--inspect-fixture",
                fixture,
                "--extra-path",
                extra,
                env=self.fake_docker(folder, fixture),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("hidden", result.stdout + result.stderr)
            self.assertNotIn("synthetic-private", result.stdout + result.stderr)
            self.assertEqual(os.stat(snapshot).st_mode & 0o777, 0o700)
            manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(sorted(manifest["expected_services"]), sorted(SERVICES))
            self.assertEqual({row["service"] for row in manifest["services"]}, set(SERVICES))
            self.assertTrue(all(len(row["config_hash"]) == 64 for row in manifest["services"]))
            self.assertEqual(manifest["extra_paths"], [str(extra)])
            self.assertEqual(len(manifest["compose_config_files"]), 3)
            self.assertEqual(manifest["compose_env_file"], str(deployed / "private" / "op.env"))
            self.assertNotIn("deployed_git_revision", manifest)
            self.assertFalse(any("data/generated" in row["source"] for row in manifest["files"]))
            self.assertFalse(any("/data" in row["source"] for row in manifest["directories"]))
            self.assertTrue((snapshot / "tools" / "operational-snapshot.py").is_file())
            rollback_images = (snapshot / "rollback-images.yml").read_text(encoding="utf-8")
            for service in SERVICES:
                self.assertIn(f"  {service}:", rollback_images)
            self.assertIn("ptr-rollback/ptr-op-api:", rollback_images)
            self.assertNotIn('image: "sha256:', rollback_images)
            self.assertTrue(any("@sha256:" in row["config_image"] for row in manifest["services"]))
            self.assertFalse(
                (
                    snapshot
                    / "root"
                    / str(folder / "docker-volume-should-not-be-copied").lstrip("/")
                ).exists()
            )
            self.assertTrue(
                (snapshot / "root" / str(deployed / "mounted-code" / "empty").lstrip("/")).is_dir()
            )
            self.assertTrue(
                (
                    snapshot
                    / "root"
                    / str(deployed / "mounted-code" / "gateway" / "router-link.py").lstrip("/")
                ).is_symlink()
            )
            self.assertTrue(
                all((snapshot / row["snapshot"]).is_file() for row in manifest["files"])
            )
            self.assertTrue(
                all(
                    (os.stat(snapshot / row["snapshot"]).st_mode & 0o777) == 0o600
                    for row in manifest["files"]
                )
            )

            target = deployed / "mounted-code" / "gateway" / "router.py"
            target.write_text("BROKEN = True\n", encoding="utf-8")
            (deployed / "data" / "generated" / "draft.json").write_text('{"draft":"new"}\n')
            (deployed / "infra" / "split" / "site.yml").unlink()
            extra.unlink()
            (deployed / "mounted-code" / "empty").rmdir()
            (deployed / "mounted-code" / "gateway" / "router-link.py").unlink()
            parent_mode = os.stat(target.parent).st_mode & 0o777
            copied_tool = snapshot / "tools" / "operational-snapshot.py"
            dry = subprocess.run(
                [
                    sys.executable,
                    str(copied_tool),
                    "restore",
                    "--snapshot",
                    str(snapshot),
                    "--dry-run",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertIn("would_restore=", dry.stdout)
            applied = subprocess.run(
                [
                    sys.executable,
                    str(copied_tool),
                    "restore",
                    "--snapshot",
                    str(snapshot),
                    "--apply",
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(applied.returncode, 0, applied.stderr)
            self.assertEqual(target.read_text(encoding="utf-8"), "ROUTER = 'synthetic-private'\n")
            self.assertEqual(
                (deployed / "infra" / "split" / "site.yml").read_text(), "services: {}\n"
            )
            self.assertEqual(extra.read_text(), "EXTRA_SECRET=hidden\n")
            self.assertEqual(
                (deployed / "data" / "generated" / "draft.json").read_text(),
                '{"draft":"new"}\n',
            )
            self.assertTrue((deployed / "mounted-code" / "empty").is_dir())
            self.assertEqual(os.stat(deployed / "mounted-code" / "empty").st_mode & 0o777, 0o755)
            self.assertEqual(
                os.readlink(deployed / "mounted-code" / "gateway" / "router-link.py"), "router.py"
            )
            self.assertEqual(os.stat(target.parent).st_mode & 0o777, parent_mode)

    def test_capture_refuses_owner_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            _, fixture = self.write_fixture(folder, owner="other-owner")
            result = run(
                "capture",
                "--project",
                "ptr-op",
                "--owner",
                "owner-nonce",
                "--output",
                folder / "snapshot",
                "--inspect-fixture",
                fixture,
                env=self.fake_docker(folder, fixture),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("owner label mismatch", result.stderr)

    def test_capture_refuses_snapshot_inside_working_dir(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            deployed, fixture = self.write_fixture(folder)
            result = run(
                "capture",
                "--project",
                "ptr-op",
                "--owner",
                "owner-nonce",
                "--output",
                deployed / "snapshot",
                "--inspect-fixture",
                fixture,
                env=self.fake_docker(folder, fixture),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("must not be inside captured source", result.stderr)

    def test_capture_refuses_mismatched_compose_hash(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            _, fixture = self.write_fixture(folder)
            result = run(
                "capture",
                "--project",
                "ptr-op",
                "--owner",
                "owner-nonce",
                "--output",
                folder / "snapshot",
                "--inspect-fixture",
                fixture,
                env=self.fake_docker(folder, fixture, mismatch=True),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(
                "captured files do not match the deployed config; "
                "check out the deployed revision and re-run",
                result.stderr,
            )

    def test_capture_refuses_unclassified_bind_mount(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            _, fixture = self.write_fixture(folder)
            rows = json.loads(fixture.read_text())
            rows[0]["Mounts"].append(
                {"Type": "bind", "Source": str(folder / "unknown"), "Destination": "/unclassified"}
            )
            fixture.write_text(json.dumps(rows))
            result = run(
                "capture",
                "--project",
                "ptr-op",
                "--owner",
                "owner-nonce",
                "--output",
                folder / "snapshot",
                "--inspect-fixture",
                fixture,
                env=self.fake_docker(folder, fixture),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("unclassified bind mount target", result.stderr)

    def test_capture_includes_legacy_gateway_config_mount(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            _, fixture = self.write_fixture(folder)
            config = folder / "gateway-config.yaml"
            config.write_text("synthetic: true\n")
            rows = json.loads(fixture.read_text())
            rows[0]["Mounts"].append(
                {"Type": "bind", "Source": str(config), "Destination": "/app/ptr-config.yaml"}
            )
            fixture.write_text(json.dumps(rows))
            snapshot = folder / "snapshot"
            result = run(
                "capture",
                "--project",
                "ptr-op",
                "--owner",
                "owner-nonce",
                "--output",
                snapshot,
                "--inspect-fixture",
                fixture,
                env=self.fake_docker(folder, fixture),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((snapshot / "manifest.json").read_text())
            self.assertTrue(any(row["source"] == str(config) for row in manifest["files"]))

    def test_capture_refuses_dirty_checkout(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            deployed, fixture = self.write_fixture(folder)
            subprocess.run(["git", "init", "-q", str(deployed)], check=True, timeout=10)
            result = run(
                "capture",
                "--project",
                "ptr-op",
                "--owner",
                "owner-nonce",
                "--output",
                folder / "snapshot",
                "--inspect-fixture",
                fixture,
                env=self.fake_docker(folder, fixture),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("uncommitted changes", result.stderr)

    def test_capture_resolves_relative_labeled_env_path_from_workdir(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            deployed, fixture = self.write_fixture(folder)
            rows = json.loads(fixture.read_text())
            for row in rows:
                row["Config"]["Labels"]["com.docker.compose.project.environment_file"] = (
                    "private/op.env"
                )
            fixture.write_text(json.dumps(rows))
            snapshot = folder / "snapshot"
            result = run(
                "capture",
                "--project",
                "ptr-op",
                "--owner",
                "owner-nonce",
                "--output",
                snapshot,
                "--inspect-fixture",
                fixture,
                env=self.fake_docker(folder, fixture),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((snapshot / "manifest.json").read_text())
            self.assertEqual(manifest["compose_env_file"], str(deployed / "private" / "op.env"))

    def test_tag_images_uses_recorded_id_and_tag(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            folder = Path(raw)
            _, fixture = self.write_fixture(folder)
            env = self.fake_docker(folder, fixture)
            snapshot = folder / "snapshot"
            captured = run(
                "capture",
                "--project",
                "ptr-op",
                "--owner",
                "owner-nonce",
                "--output",
                snapshot,
                "--inspect-fixture",
                fixture,
                env=env,
            )
            self.assertEqual(captured.returncode, 0, captured.stderr)
            calls = folder / "tag-calls.jsonl"
            (folder / "bin" / "docker").write_text(
                "#!/usr/bin/env python3\nimport json,sys\n"
                f"with open({str(calls)!r}, 'a') as f: f.write(json.dumps(sys.argv[1:])+'\\n')\n"
            )
            tagged = run("tag-images", "--snapshot", snapshot, env=env)
            self.assertEqual(tagged.returncode, 0, tagged.stderr)
            manifest = json.loads((snapshot / "manifest.json").read_text())
            actual = [json.loads(line) for line in calls.read_text().splitlines()]
            expected = [
                ["image", "tag", row["image"], row["rollback_tag"]] for row in manifest["services"]
            ]
            self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
