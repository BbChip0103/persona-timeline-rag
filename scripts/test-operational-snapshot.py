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
TEST_TMP = Path("/var/tmp") if Path("/var/tmp").is_dir() else Path.home()


def run(*args: Path | str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *(str(arg) for arg in args)],
        text=True,
        capture_output=True,
        check=False,
        env=env,
        timeout=30,
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
    def tempdir(self):
        return tempfile.TemporaryDirectory(dir=TEST_TMP)

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

    def fake_docker(
        self, folder: Path, fixture: Path, mismatch: bool = False,
        mismatch_service: str = "api",
    ) -> dict[str, str]:
        rows = json.loads(fixture.read_text())
        hashes = {
            row["Config"]["Labels"]["com.docker.compose.service"]: row["Config"]["Labels"][
                "com.docker.compose.config-hash"
            ]
            for row in rows
        }
        if mismatch:
            hashes[mismatch_service] = "f" * 64
        bin_dir = folder / "bin"
        bin_dir.mkdir()
        executable = bin_dir / "docker"
        groups: dict[str, dict[str, object]] = {}
        for row in rows:
            row_labels = row["Config"]["Labels"]
            directory = row_labels["com.docker.compose.project.working_dir"]
            env_path = row_labels["com.docker.compose.project.environment_file"]
            if not Path(env_path).is_absolute():
                env_path = str(Path(directory) / env_path)
            group = groups.setdefault(
                directory,
                {
                    "env": env_path,
                    "files": row_labels["com.docker.compose.project.config_files"].split(","),
                    "services": [],
                },
            )
            group["services"].append(row_labels["com.docker.compose.service"])
        executable.write_text(
            "#!/usr/bin/env python3\nimport os,sys\n"
            f"groups = {groups!r}\n"
            "group = groups[os.getcwd()]\n"
            "assert sys.argv[1:3] == ['compose', '--env-file']\n"
            "assert sys.argv[3] == group['env']\n"
            "assert sys.argv[4:6] == ['-p', 'ptr-op']\n"
            "assert sys.argv[6:6+2*len(group['files'])] == "
            "[part for file in group['files'] for part in ('-f', file)]\n"
            "assert sys.argv[6+2*len(group['files']):8+2*len(group['files'])] == "
            "['config', '--hash']\n"
            "assert len(sys.argv) == 9+2*len(group['files'])\n"
            "services = sys.argv[-1].split(',')\n"
            f"hashes = {hashes!r}\n"
            "assert services == sorted(group['services'])\n"
            "for service in services: print(service, hashes[service])\n"
        )
        executable.chmod(0o755)
        return {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}"}

    def write_two_group_fixture(self, folder: Path) -> tuple[Path, Path, Path]:
        first, fixture = self.write_fixture(folder)
        second = folder / "spillover"
        shared_env = folder / "private" / "compose.env"
        shared_env.parent.mkdir()
        shared_env.write_text("OP_SECRET=hidden\n", encoding="utf-8")
        (second / "infra" / "split").mkdir(parents=True)
        (second / "private").mkdir()
        for relative in (
            "infra/compose.app.yml",
            "infra/split/compose.operational.yml",
            "infra/split/site.yml",
        ):
            target = second / relative
            target.write_text("services: {}\n", encoding="utf-8")
        for service in ("worker", "model-gateway"):
            (second / "private" / f"{service}.env").write_text("SECRET=hidden\n")
        rows = json.loads(fixture.read_text())
        for row in rows:
            service = row["Config"]["Labels"]["com.docker.compose.service"]
            if service in ("worker", "model-gateway"):
                other = inspect_row(service, "ptr-op", "owner-nonce", second)
                row["Config"]["Labels"] = other["Config"]["Labels"]
                row["Mounts"] = other["Mounts"]
            row["Config"]["Labels"]["com.docker.compose.project.environment_file"] = str(
                shared_env
            )
        fixture.write_text(json.dumps(rows))
        return first, second, fixture

    def test_capture_records_owned_sources_and_restores_from_snapshot_tool(self) -> None:
        with self.tempdir() as raw:
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
            self.assertEqual(len(manifest["compose_groups"]), 1)
            self.assertEqual(manifest["compose_groups"][0]["services"], sorted(SERVICES))
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
        with self.tempdir() as raw:
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

    def test_two_groups_refuse_missing_service(self) -> None:
        with self.tempdir() as raw:
            folder = Path(raw)
            _, _, fixture = self.write_two_group_fixture(folder)
            rows = json.loads(fixture.read_text())
            fixture.write_text(json.dumps([
                row for row in rows
                if row["Config"]["Labels"]["com.docker.compose.service"] != "worker"
            ]))
            result = run(
                "capture", "--project", "ptr-op", "--owner", "owner-nonce",
                "--output", folder / "snapshot", "--inspect-fixture", fixture,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("missing expected services: worker", result.stderr)

    def test_capture_refuses_snapshot_inside_working_dir(self) -> None:
        with self.tempdir() as raw:
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
        with self.tempdir() as raw:
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
        with self.tempdir() as raw:
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
        with self.tempdir() as raw:
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
        with self.tempdir() as raw:
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
        with self.tempdir() as raw:
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

    def test_two_groups_capture_hashes_and_restore_dry_run(self) -> None:
        with self.tempdir() as raw:
            folder = Path(raw)
            first, second, fixture = self.write_two_group_fixture(folder)
            fixture.write_text(json.dumps(list(reversed(json.loads(fixture.read_text())))))
            snapshot = folder / "snapshot"
            result = run(
                "capture", "--project", "ptr-op", "--owner", "owner-nonce",
                "--output", snapshot, "--inspect-fixture", fixture,
                env=self.fake_docker(folder, fixture),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads((snapshot / "manifest.json").read_text())
            self.assertEqual(len(manifest["compose_groups"]), 2)
            self.assertEqual(
                {group["git"] for group in manifest["compose_groups"]}, {"none"}
            )
            self.assertIn(
                "rollback_order=api,model-gateway-db,model-gateway-redis,web"
                " | model-gateway,worker",
                result.stdout,
            )
            self.assertEqual(
                manifest["compose_groups"][0]["services"],
                ["api", "model-gateway-db", "model-gateway-redis", "web"],
            )
            self.assertEqual(
                {tuple(group["services"]) for group in manifest["compose_groups"]},
                {
                    ("api", "model-gateway-db", "model-gateway-redis", "web"),
                    ("model-gateway", "worker"),
                },
            )
            self.assertEqual(
                {group["working_dir"] for group in manifest["compose_groups"]},
                {str(first), str(second)},
            )
            self.assertEqual(
                {group["compose_env_file"] for group in manifest["compose_groups"]},
                {str(folder / "private" / "compose.env")},
            )
            self.assertTrue(
                (snapshot / "root" / str(folder / "private" / "compose.env").lstrip("/")).is_file()
            )
            dry = run("restore", "--snapshot", snapshot, "--dry-run")
            self.assertEqual(dry.returncode, 0, dry.stderr)
            self.assertIn(str(first / "infra" / "compose.app.yml"), dry.stdout)
            self.assertIn(str(second / "infra" / "compose.app.yml"), dry.stdout)
            self.assertNotIn("hidden", dry.stdout + dry.stderr)

    def test_two_groups_refuse_hash_mismatch_in_spillover(self) -> None:
        with self.tempdir() as raw:
            folder = Path(raw)
            _, _, fixture = self.write_two_group_fixture(folder)
            result = run(
                "capture", "--project", "ptr-op", "--owner", "owner-nonce",
                "--output", folder / "snapshot", "--inspect-fixture", fixture,
                env=self.fake_docker(folder, fixture, mismatch=True, mismatch_service="worker"),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("captured files do not match", result.stderr)

    def test_two_groups_refuse_dirty_spillover_checkout(self) -> None:
        with self.tempdir() as raw:
            folder = Path(raw)
            _, second, fixture = self.write_two_group_fixture(folder)
            subprocess.run(["git", "init", "-q", str(second)], check=True, timeout=10)
            result = run(
                "capture", "--project", "ptr-op", "--owner", "owner-nonce",
                "--output", folder / "snapshot", "--inspect-fixture", fixture,
                env=self.fake_docker(folder, fixture),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("uncommitted changes", result.stderr)

    def test_two_groups_record_clean_git_revision_per_group(self) -> None:
        with self.tempdir() as raw:
            folder = Path(raw)
            first, second, fixture = self.write_two_group_fixture(folder)
            subprocess.run(["git", "init", "-q", str(second)], check=True, timeout=10)
            subprocess.run(["git", "-C", str(second), "add", "."], check=True, timeout=10)
            subprocess.run(
                ["git", "-C", str(second), "-c", "user.name=Test", "-c",
                 "user.email=test@example.invalid", "commit", "-qm", "synthetic fixture"],
                check=True, timeout=10,
            )
            revision = subprocess.run(
                ["git", "-C", str(second), "rev-parse", "HEAD"],
                check=True, text=True, capture_output=True, timeout=10,
            ).stdout.strip()
            snapshot = folder / "snapshot"
            result = run(
                "capture", "--project", "ptr-op", "--owner", "owner-nonce",
                "--output", snapshot, "--inspect-fixture", fixture,
                env=self.fake_docker(folder, fixture),
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            groups = json.loads((snapshot / "manifest.json").read_text())["compose_groups"]
            self.assertEqual(
                {group["working_dir"]: group["git"] for group in groups},
                {str(first): "none", str(second): f"clean@{revision}"},
            )

    def test_capture_refuses_output_under_tmp(self) -> None:
        with self.tempdir() as raw, tempfile.TemporaryDirectory(dir="/tmp") as tmp_raw:
            folder = Path(raw)
            _, fixture = self.write_fixture(folder)
            snapshot = Path(tmp_raw) / "snapshot"
            result = run(
                "capture", "--project", "ptr-op", "--owner", "owner-nonce",
                "--output", snapshot, "--inspect-fixture", fixture,
                env=self.fake_docker(folder, fixture),
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("/tmp", result.stderr)
            self.assertFalse(snapshot.exists())

    def test_tag_images_uses_recorded_id_and_tag(self) -> None:
        with self.tempdir() as raw:
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
