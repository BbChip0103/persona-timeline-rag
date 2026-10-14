#!/usr/bin/env python3
"""Offline tests for secret generation, isolation and lifecycle policy."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INIT = ROOT / "infra/langfuse/init-framework-env.py"
COMPOSE = ROOT / "infra/compose.framework.yml"
SPLIT_COMPOSE = ROOT / "infra/split/compose.operational.yml"
APP_COMPOSE = ROOT / "infra/compose.app.yml"


class DeploymentTests(unittest.TestCase):
    def test_framework_smoke_has_only_the_direct_fake_engine(self):
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder) / "new.env"
            subprocess.run(
                [sys.executable, str(INIT), "--output", str(env)], check=True, capture_output=True
            )
            result = subprocess.run(
                ["docker", "compose", "--env-file", str(env), "-f", str(COMPOSE),
                 "--profile", "smoke", "config", "--format", "json"],
                check=True, capture_output=True, text=True, env={"PATH": os.environ["PATH"]},
            )
            services = json.loads(result.stdout)["services"]
            self.assertIn("fake-engine", services)
            self.assertFalse(any("litellm" in name for name in services))
            for name, service in services.items():
                self.assertNotIn("PTR_OPENROUTER_API_KEY", service.get("environment", {}), name)
                self.assertNotIn("OPENROUTER_API_KEY", service.get("environment", {}), name)

    def test_split_worker_uses_local_model_without_paid_key_or_gateway(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            app_env = root / "app.env"
            app_env.write_text("PTR_CHAT_PROVIDER=local\nPTR_MODEL=synthetic-vllm\n")
            worker_env = root / "worker.env"
            worker_env.write_text(
                "PTR_LLM_PROVIDER=local\n"
                "PTR_LLM_LOCAL_BASE_URL=http://127.0.0.1:58000/v1\n"
                "PTR_LLM_LOCAL_MODEL=synthetic-vllm\n"
                "PTR_LLM_LOCAL_API_KEY=synthetic-local-key\n"
                "PTR_LLM_SPILLOVER=off\n"
            )
            web_env = root / "web.env"
            web_env.write_text("SYNTHETIC_PLACEHOLDER=1\n")
            published = root / "published.json"
            published.write_text("{}\n")
            compose_env = root / "compose.env"
            compose_env.write_text("\n".join([
                "PTR_OPERATIONAL_PROJECT=synthetic-split",
                "PTR_OPERATIONAL_OWNER=synthetic-owner",
                "PTR_OPERATIONAL_BACKEND_IMAGE=synthetic-backend:local",
                "PTR_OPERATIONAL_WORKER_IMAGE=synthetic-worker:local",
                "OPENROUTER_API_KEY=synthetic-compose-sentinel",
                f"PTR_FRAMEWORK_APP_ENV_FILE={app_env}",
                f"PTR_LLM_SERVICE_ENV_FILE={worker_env}",
                f"PTR_OPERATIONAL_WEB_ENV_FILE={web_env}",
                f"PTR_OPERATIONAL_PUBLISHED_PERSONAS_FILE={published}",
            ]) + "\n")
            result = subprocess.run(
                ["docker", "compose", "--env-file", str(compose_env), "-f", str(APP_COMPOSE),
                 "-f", str(SPLIT_COMPOSE), "config", "--format", "json"],
                check=True, capture_output=True, text=True, env={"PATH": os.environ["PATH"]},
            )
            services = json.loads(result.stdout)["services"]
            self.assertEqual(set(services), {"api", "web", "worker"})
            self.assertEqual(services["worker"]["environment"]["PTR_LLM_PROVIDER"], "local")
            self.assertEqual(services["worker"]["environment"]["PTR_LLM_SPILLOVER"], "off")
            self.assertEqual(services["worker"]["environment"]["PTR_LLM_LOCAL_MODEL"], "synthetic-vllm")
            self.assertNotIn("PTR_LITELLM_BILLABLE", services["api"]["environment"])
            for name, service in services.items():
                self.assertNotIn("PTR_OPENROUTER_API_KEY", service.get("environment", {}), name)
                self.assertNotIn("OPENROUTER_API_KEY", service.get("environment", {}), name)

    def test_generated_secrets_unique_private_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder) / "new.env"
            subprocess.run(
                [sys.executable, str(INIT), "--output", str(env)], check=True, capture_output=True
            )
            before = env.read_bytes()
            self.assertEqual(os.stat(env).st_mode & 0o777, 0o600)
            fields = dict(
                line.split("=", 1)
                for line in env.read_text().splitlines()
                if line and not line.startswith("#")
            )
            passwords = [
                value
                for key, value in fields.items()
                if "PASSWORD" in key or "SECRET" in key or "SALT" in key
            ]
            self.assertEqual(len(passwords), len(set(passwords)))
            self.assertTrue(all(len(value) >= 32 for value in passwords))
            self.assertTrue(fields["PTR_FRAMEWORK_PROJECT"].startswith("ptr-fw-"))
            self.assertNotIn("OPENROUTER_API_KEY", fields)
            result = subprocess.run(
                [sys.executable, str(INIT), "--output", str(env)], capture_output=True
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(env.read_bytes(), before)

    def test_isolated_compose_real_images_no_shared_storage(self):
        source = COMPOSE.read_text()
        self.assertNotIn("container_name:", source)
        self.assertNotIn("network_mode: host", source)
        self.assertNotIn(".env.local", source)
        self.assertNotIn("/data/research", source)
        self.assertNotIn("LANGFUSE_INIT_PROJECT_RETENTION:", source)
        images = [line.strip() for line in source.splitlines() if line.strip().startswith("image:")]
        self.assertTrue(images)
        self.assertTrue(all("@sha256:" in line for line in images))
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder) / "new.env"
            subprocess.run(
                [sys.executable, str(INIT), "--output", str(env)], check=True, capture_output=True
            )
            subprocess.run(
                [
                    "docker",
                    "compose",
                    "--env-file",
                    str(env),
                    "-f",
                    str(COMPOSE),
                    "--profile",
                    "smoke",
                    "--profile",
                    "observability",
                    "--profile",
                    "guardrails",
                    "--profile",
                    "runtime-test",
                    "config",
                    "-q",
                ],
                check=True,
                capture_output=True,
            )
            empty = Path(folder) / "empty.env"
            empty.write_text("")
            result = subprocess.run(
                ["docker", "compose", "--env-file", str(empty), "-f", str(COMPOSE), "config", "-q"],
                capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)

    def test_all_blob_copies_have_90_day_policy(self):
        policy = json.loads((ROOT / "infra/langfuse/blob-lifecycle.json").read_text())
        rule = policy["Rules"][0]
        self.assertEqual(rule["Status"], "Enabled")
        self.assertEqual(rule["Filter"]["Prefix"], "")
        self.assertEqual(rule["Expiration"]["Days"], 90)
        self.assertEqual(rule["NoncurrentVersionExpiration"]["NoncurrentDays"], 90)
        self.assertEqual(rule["AbortIncompleteMultipartUpload"]["DaysAfterInitiation"], 1)


if __name__ == "__main__":
    unittest.main()
