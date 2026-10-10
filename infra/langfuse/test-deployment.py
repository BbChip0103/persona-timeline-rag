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


class DeploymentTests(unittest.TestCase):
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
