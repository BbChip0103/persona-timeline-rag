"""Synthetic contract tests for the private operational env transition."""

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("operational-env-migrate.py")


def run(*args: Path | str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *(str(arg) for arg in args)],
        text=True,
        capture_output=True,
        check=False,
        timeout=10,
    )


class OperationalEnvMigrationTests(unittest.TestCase):
    def test_explicit_spillover_carries_only_named_key_and_checks_worker(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, gateway, target = (root / name for name in ("old", "gateway", "new"))
            source.write_text("PTR_LLM_PROVIDER=litellm\nOPENROUTER_API_KEY=old\n")
            gateway.write_text(
                "PTR_OPENROUTER_API_KEY=synthetic-gateway-secret\nOTHER_SECRET=hidden\n"
            )
            result = run(
                "prepare",
                "worker",
                source,
                target,
                "--spillover-openrouter",
                "--openrouter-source",
                gateway,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("synthetic-gateway-secret", result.stdout + result.stderr)
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            content = target.read_text()
            self.assertIn("OPENROUTER_API_KEY=synthetic-gateway-secret\n", content)
            self.assertIn("PTR_LLM_SPILLOVER=openrouter\n", content)
            self.assertIn("PTR_LLM_LIVE_ENABLED=1\n", content)
            self.assertIn("PTR_LLM_ALLOW_EXTERNAL_DATA=1\n", content)
            self.assertNotIn("OTHER_SECRET", content)
            self.assertNotIn("PTR_OPENROUTER_API_KEY=", content)
            self.assertNotEqual(run("check", "worker", target).returncode, 0)
            for key in ("PTR_LLM_LOCAL_BASE_URL", "PTR_LLM_LOCAL_MODEL", "PTR_LLM_LOCAL_API_KEY"):
                content = content.replace(f"{key}=\n", f"{key}=synthetic-filled\n")
            target.write_text(content)
            self.assertEqual(run("check", "worker", target).returncode, 0)
            for key in ("PTR_LLM_LIVE_ENABLED", "PTR_LLM_ALLOW_EXTERNAL_DATA"):
                target.write_text(content.replace(f"{key}=1", f"{key}=0"))
                self.assertNotEqual(run("check", "worker", target).returncode, 0)
            target.write_text(content)
            target.write_text(content.replace("PTR_LLM_LOCAL_SLOTS=8", "PTR_LLM_LOCAL_SLOTS="))
            self.assertNotEqual(run("check", "worker", target).returncode, 0)
            self.assertNotEqual(
                run(
                    "prepare", "worker", source, root / "invalid", "--spillover-openrouter"
                ).returncode,
                0,
            )

    def test_compose_checks_worker_spillover_and_fixture_flag(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            data = root / "data"
            data.mkdir(mode=0o700)
            (data / "research").mkdir()
            (data / "generated").mkdir()
            worker = root / "worker"
            backend = root / "backend"
            backend.write_text("PTR_PAID_SPILLOVER=1\n")
            backend.chmod(0o600)
            compose = root / "compose"
            worker.write_text(
                "PTR_LLM_SPILLOVER=openrouter\nPTR_LLM_LOCAL_SLOTS=2\n"
                "PTR_LLM_CONCURRENCY=2\nPTR_LLM_OPENROUTER_KEY_MAX_LIMIT_USD=1\n"
                "OPENROUTER_API_KEY=synthetic-private\n"
                "PTR_LLM_LIVE_ENABLED=1\nPTR_LLM_ALLOW_EXTERNAL_DATA=1\n"
            )
            worker.chmod(0o600)
            compose.write_text(
                f"PTR_OPERATIONAL_DATA_DIR={data}\n"
                f"PTR_LLM_SERVICE_ENV_FILE={worker}\n"
                "PTR_OPERATIONAL_PROJECT=synthetic\nPTR_OPERATIONAL_OWNER=synthetic\n"
                "PTR_OPERATIONAL_PUBLISHED_PERSONAS_FILE=/synthetic\n"
                "PTR_OPERATIONAL_BACKEND_IMAGE=synthetic\nPTR_OPERATIONAL_WORKER_IMAGE=synthetic\n"
                f"PTR_FRAMEWORK_APP_ENV_FILE={backend}\n"
                "PTR_OPERATIONAL_WEB_ENV_FILE=/synthetic\n"
                "PTR_LLM_LOCAL_SLOTS=2\nPTR_LLM_CONCURRENCY=2\n"
            )
            compose.chmod(0o600)
            result = run("check", "compose", compose)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("concurrency", result.stdout.lower())
            self.assertNotIn("synthetic-private", result.stdout + result.stderr)
            backend.write_text("PTR_PAID_SPILLOVER=0\n")
            self.assertNotEqual(run("check", "compose", compose).returncode, 0)
            backend.write_text("PTR_PAID_SPILLOVER=true\n")
            self.assertNotEqual(run("check", "compose", compose).returncode, 0)
            backend.write_text("PTR_PAID_SPILLOVER=1\n")
            for key in ("PTR_LLM_LIVE_ENABLED", "PTR_LLM_ALLOW_EXTERNAL_DATA"):
                original = worker.read_text()
                worker.write_text(original.replace(f"{key}=1", f"{key}=0"))
                self.assertNotEqual(run("check", "compose", compose).returncode, 0)
                worker.write_text(original)
            worker.write_text(
                worker.read_text().replace("OPENROUTER_API_KEY=synthetic-private\n", "")
            )
            self.assertNotEqual(run("check", "compose", compose).returncode, 0)
            worker.write_text(
                worker.read_text() + "OPENROUTER_API_KEY=synthetic-private\n"
                "PTR_LLM_SYNTHETIC_PROVIDER_FIXTURE=1\n"
            )
            self.assertNotEqual(run("check", "compose", compose).returncode, 0)

    def test_worker_transform_checks_filled_env_and_strips_paid_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "worker.old", root / "worker.new"
            removed = (
                "PTR_LLM_LITELLM_API_KEY",
                "PTR_OPENROUTER_API_KEY",
                "OPENROUTER_API_KEY",
                "PTR_LLM_CAPACITY_SPILLOVER_KEY",
                "PTR_LLM_PROMPT_USD_PER_M",
                "PTR_LLM_COMPLETION_USD_PER_M",
                "PTR_LLM_MAX_CALL_MICROUSD",
            )
            source.write_text(
                "PRESERVED_SECRET=synthetic-private\nPTR_LLM_PROVIDER=litellm\n"
                "PTR_LLM_EMBEDDING_PROVIDER=openrouter\n"
                "PTR_LLM_INTENT_CLASSIFIER=jev\nPTR_LLM_SAFETY_FILTER=jev\n"
                + "".join(f"{key}=hidden\n" for key in removed)
            )
            result = run("prepare", "worker", source, target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("synthetic-private", result.stdout + result.stderr)
            self.assertNotIn("hidden", result.stdout + result.stderr)
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o600)
            output = target.read_text()
            self.assertIn("PRESERVED_SECRET=synthetic-private", output)
            for key in removed:
                self.assertNotIn(key + "=", output)
            for key in (
                "PTR_LLM_EMBEDDING_PROVIDER",
                "PTR_LLM_INTENT_CLASSIFIER",
                "PTR_LLM_SAFETY_FILTER",
            ):
                self.assertIn(f"{key}=off\n", output)
            self.assertNotEqual(run("check", "worker", target).returncode, 0)
            for key in ("PTR_LLM_LOCAL_BASE_URL", "PTR_LLM_LOCAL_MODEL", "PTR_LLM_LOCAL_API_KEY"):
                output = output.replace(f"{key}=\n", f"{key}=synthetic-filled\n")
            target.write_text(output)
            result = run("check", "worker", target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("synthetic-filled", result.stdout + result.stderr)
            self.assertNotEqual(run("prepare", "worker", source, target).returncode, 0)
            self.assertEqual(target.read_text(), output)
            target.write_text(
                output.replace("PTR_LLM_SAFETY_FILTER=off", "PTR_LLM_SAFETY_FILTER=jev")
            )
            self.assertNotEqual(run("check", "worker", target).returncode, 0)

    def test_backend_transform_keeps_other_keys_private(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "backend.old", root / "backend.new"
            source.write_text(
                "PRESERVED_SECRET=synthetic-private\nPTR_CHAT_PROVIDER=litellm\n"
                "PTR_LITELLM_API_KEY=hidden\n"
            )
            result = run("prepare", "backend", source, target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("synthetic-private", result.stdout + result.stderr)
            self.assertNotIn("hidden", result.stdout + result.stderr)
            self.assertEqual(os.stat(target).st_mode & 0o777, 0o600)
            self.assertIn("PRESERVED_SECRET=synthetic-private", target.read_text())
            self.assertIn("PTR_CHAT_PROVIDER=local", target.read_text())
            self.assertNotIn("PTR_LITELLM_API_KEY=", target.read_text())
            self.assertNotEqual(run("check", "backend", target).returncode, 0)

    def test_compose_transform_and_key_only_check(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, target = root / "compose.old", root / "compose.new"
            source.write_text(
                "PTR_OPERATIONAL_PROJECT=synthetic\nPTR_OPERATIONAL_OWNER=synthetic-owner\n"
                "PTR_OPERATIONAL_PUBLISHED_PERSONAS_FILE=/private/published\n"
                "PTR_OPERATIONAL_GATEWAY_PORT=synthetic-secret\n"
                "PTR_OPERATIONAL_BACKEND_IMAGE=old-image\n"
            )
            self.assertEqual(run("prepare", "compose", source, target).returncode, 0)
            self.assertNotIn("PTR_OPERATIONAL_GATEWAY_PORT=", target.read_text())
            self.assertNotIn("synthetic-secret", target.read_text())
            self.assertIn("PTR_OPERATIONAL_DATA_DIR=\n", target.read_text())
            data = root / "data"
            data.mkdir(mode=0o700)
            (data / "research").mkdir()
            (data / "generated").mkdir()
            worker = root / "worker.env"
            worker.write_text("PTR_LLM_SPILLOVER=off\n")
            worker.chmod(0o600)
            backend = root / "backend.env"
            backend.write_text("PTR_PAID_SPILLOVER=0\n")
            backend.chmod(0o600)
            with target.open("a") as file:
                file.write("# filled by operator in practice\n")
            content = target.read_text()
            for key in (
                "PTR_OPERATIONAL_BACKEND_IMAGE",
                "PTR_OPERATIONAL_WORKER_IMAGE",
                "PTR_FRAMEWORK_APP_ENV_FILE",
                "PTR_OPERATIONAL_WEB_ENV_FILE",
            ):
                content = content.replace(f"{key}=\n", f"{key}=synthetic-filled\n")
            content = content.replace(
                "PTR_LLM_SERVICE_ENV_FILE=\n", f"PTR_LLM_SERVICE_ENV_FILE={worker}\n"
            )
            content = content.replace(
                "PTR_FRAMEWORK_APP_ENV_FILE=synthetic-filled\n",
                f"PTR_FRAMEWORK_APP_ENV_FILE={backend}\n",
            )
            target.write_text(content)
            self.assertNotEqual(run("check", "compose", target).returncode, 0)
            for bad in ("relative/data", str(root / "missing"), str(source)):
                target.write_text(
                    content.replace(
                        "PTR_OPERATIONAL_DATA_DIR=\n", f"PTR_OPERATIONAL_DATA_DIR={bad}\n"
                    )
                )
                self.assertNotEqual(run("check", "compose", target).returncode, 0)
            target.write_text(
                content.replace("PTR_OPERATIONAL_DATA_DIR=\n", f"PTR_OPERATIONAL_DATA_DIR={data}\n")
            )
            result = run("check", "compose", target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("synthetic-filled", result.stdout + result.stderr)
            backend.write_text("PTR_PAID_SPILLOVER=1\n")
            self.assertNotEqual(run("check", "compose", target).returncode, 0)
            backend.write_text("PTR_PAID_SPILLOVER=2\n")
            self.assertNotEqual(run("check", "compose", target).returncode, 0)
            backend.write_text("PTR_PAID_SPILLOVER=0\n")
            worker.write_text("PTR_LLM_SPILLOVER=off\nPTR_LLM_LIVE_ENABLED=1\nPTR_LLM_ALLOW_EXTERNAL_DATA=1\n")
            warning = run("check", "compose", target)
            self.assertEqual(warning.returncode, 0, warning.stderr)
            self.assertIn("warning: PTR_LLM_LIVE_ENABLED=true", warning.stdout)
            self.assertIn("warning: PTR_LLM_ALLOW_EXTERNAL_DATA=true", warning.stdout)
            data.chmod(0o755)
            self.assertNotEqual(run("check", "compose", target).returncode, 0)
            data.chmod(0o700)
            (data / "generated").rmdir()
            self.assertNotEqual(run("check", "compose", target).returncode, 0)
            (data / "generated").mkdir()
            with target.open("a") as file:
                file.write("OPENROUTER_API_KEY=synthetic-hidden\n")
            result = run("check", "compose", target)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn("synthetic-hidden", result.stdout + result.stderr)
            target.chmod(0o644)
            self.assertNotEqual(run("check", "compose", target).returncode, 0)


if __name__ == "__main__":
    unittest.main()
