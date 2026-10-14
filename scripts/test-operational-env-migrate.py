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
            with target.open("a") as file:
                file.write("# filled by operator in practice\n")
            content = target.read_text()
            for key in (
                "PTR_OPERATIONAL_BACKEND_IMAGE",
                "PTR_OPERATIONAL_WORKER_IMAGE",
                "PTR_FRAMEWORK_APP_ENV_FILE",
                "PTR_LLM_SERVICE_ENV_FILE",
                "PTR_OPERATIONAL_WEB_ENV_FILE",
            ):
                content = content.replace(f"{key}=\n", f"{key}=synthetic-filled\n")
            target.write_text(content)
            self.assertNotEqual(run("check", "compose", target).returncode, 0)
            for bad in ("relative/data", str(root / "missing"), str(source)):
                target.write_text(content.replace("PTR_OPERATIONAL_DATA_DIR=\n", f"PTR_OPERATIONAL_DATA_DIR={bad}\n"))
                self.assertNotEqual(run("check", "compose", target).returncode, 0)
            target.write_text(content.replace("PTR_OPERATIONAL_DATA_DIR=\n", f"PTR_OPERATIONAL_DATA_DIR={data}\n"))
            result = run("check", "compose", target)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn("synthetic-filled", result.stdout + result.stderr)
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
