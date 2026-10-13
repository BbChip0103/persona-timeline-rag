#!/usr/bin/env python3
"""Offline tests for secret generation, isolation and lifecycle policy."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INIT = ROOT / "infra/langfuse/init-framework-env.py"
COMPOSE = ROOT / "infra/compose.framework.yml"
SPLIT_COMPOSE = ROOT / "infra/split/compose.operational.yml"
APP_COMPOSE = ROOT / "infra/compose.app.yml"


class DeploymentTests(unittest.TestCase):
    def test_openrouter_key_is_mapped_only_into_framework_gateway(self):
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder) / "new.env"
            subprocess.run(
                ["python", str(INIT), "--output", str(env)], check=True, capture_output=True
            )
            env.write_text(
                env.read_text().replace(
                    "OPENROUTER_API_KEY=\n", "OPENROUTER_API_KEY=synthetic-compose-sentinel\n"
                )
            )
            result = subprocess.run(
                ["docker", "compose", "--env-file", str(env), "-f", str(COMPOSE),
                 "--profile", "smoke", "config", "--format", "json"],
                check=True, capture_output=True, text=True, env={"PATH": os.environ["PATH"]},
            )
            services = json.loads(result.stdout)["services"]
            self.assertEqual(
                services["litellm"]["environment"]["PTR_OPENROUTER_API_KEY"],
                "synthetic-compose-sentinel",
            )
            self.assertNotIn("OPENROUTER_API_KEY", services["litellm"]["environment"])
            for name, service in services.items():
                if name != "litellm":
                    self.assertNotIn("PTR_OPENROUTER_API_KEY", service.get("environment", {}))
                    self.assertNotIn("OPENROUTER_API_KEY", service.get("environment", {}))

    def test_openrouter_key_is_mapped_only_into_split_gateway(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            role_env = root / "role.env"
            role_env.write_text("SYNTHETIC_PLACEHOLDER=1\n")
            published = root / "published.json"
            published.write_text("{}\n")
            compose_env = root / "compose.env"
            compose_env.write_text("\n".join([
                "PTR_OPERATIONAL_PROJECT=synthetic-split",
                "PTR_OPERATIONAL_OWNER=synthetic-owner",
                "PTR_OPERATIONAL_BACKEND_IMAGE=synthetic-backend:local",
                "PTR_OPERATIONAL_WORKER_IMAGE=synthetic-worker:local",
                "PTR_OPERATIONAL_GATEWAY_PORT=36435",
                "PTR_OPERATIONAL_GATEWAY_DB_PORT=58433",
                "PTR_OPERATIONAL_GATEWAY_REDIS_PORT=58480",
                "OPENROUTER_API_KEY=synthetic-compose-sentinel",
                *[f"{key}={role_env}" for key in (
                    "PTR_FRAMEWORK_APP_ENV_FILE", "PTR_LLM_SERVICE_ENV_FILE",
                    "PTR_OPERATIONAL_WEB_ENV_FILE", "PTR_OPERATIONAL_GATEWAY_ENV_FILE",
                    "PTR_OPERATIONAL_GATEWAY_DB_ENV_FILE", "PTR_OPERATIONAL_GATEWAY_REDIS_ENV_FILE",
                )],
                f"PTR_OPERATIONAL_PUBLISHED_PERSONAS_FILE={published}",
                f"PTR_OPERATIONAL_GATEWAY_CONFIG={ROOT / 'infra/litellm/config.live.yaml'}",
            ]) + "\n")
            result = subprocess.run(
                ["docker", "compose", "--env-file", str(compose_env), "-f", str(APP_COMPOSE),
                 "-f", str(SPLIT_COMPOSE), "config", "--format", "json"],
                check=True, capture_output=True, text=True, env={"PATH": os.environ["PATH"]},
            )
            services = json.loads(result.stdout)["services"]
            self.assertEqual(
                services["model-gateway"]["environment"]["PTR_OPENROUTER_API_KEY"],
                "synthetic-compose-sentinel",
            )
            self.assertNotIn("OPENROUTER_API_KEY", services["model-gateway"]["environment"])
            for name, service in services.items():
                if name != "model-gateway":
                    self.assertNotIn("PTR_OPENROUTER_API_KEY", service.get("environment", {}))
                    self.assertNotIn("OPENROUTER_API_KEY", service.get("environment", {}))

    def test_generated_secrets_unique_private_and_never_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            env = Path(folder) / "new.env"
            subprocess.run(
                ["python", str(INIT), "--output", str(env)], check=True, capture_output=True
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
            self.assertEqual(fields["OPENROUTER_API_KEY"], "")
            result = subprocess.run(
                ["python", str(INIT), "--output", str(env)], capture_output=True
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
                ["python", str(INIT), "--output", str(env)], check=True, capture_output=True
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
