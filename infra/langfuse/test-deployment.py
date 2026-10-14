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
    def test_redeploy_data_preflight_uses_snapshot_sources(self):
        runbook = (ROOT / "docs/operational-deployment.md").read_text()
        step = runbook.split("3. Prepare the new private configuration", 1)[1].split(
            "4. Apply `split/0005`", 1
        )[0]
        self.assertIn("data-dir --snapshot", step)
        self.assertIn("check-data-mounts", step)
        self.assertIn("config -q", step)
        for command in step.split("```sh")[1:]:
            shell = command.split("```", 1)[0]
            result = subprocess.run(
                ["bash", "-n"], input=shell, text=True, capture_output=True, timeout=10
            )
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_app_data_bind_sources_render_with_default_and_override(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            role_env = root / "role.env"
            role_env.write_text("SYNTHETIC_ONLY=1\n")
            custom = root / "private-data"
            for data_dir in (None, custom):
                env = {
                    "PATH": os.environ["PATH"],
                    "PTR_FRAMEWORK_APP_ENV_FILE": str(role_env),
                    "PTR_LLM_SERVICE_ENV_FILE": str(role_env),
                }
                if data_dir is not None:
                    env["PTR_OPERATIONAL_DATA_DIR"] = str(data_dir)
                result = subprocess.run(
                    ["docker", "compose", "-f", str(APP_COMPOSE), "config", "--format", "json",
                     "--no-env-resolution"], capture_output=True, text=True, check=True,
                    env=env, timeout=10,
                )
                services = json.loads(result.stdout)["services"]
                expected = data_dir or ROOT / "data"
                self.assertEqual(services["api"]["volumes"][0]["source"], str(expected / "generated"))
                self.assertEqual(services["worker"]["volumes"][0]["source"], str(expected))
                self.assertFalse(services["api"]["volumes"][0]["bind"]["create_host_path"])
                self.assertTrue(services["api"]["volumes"][0]["read_only"])
                self.assertFalse(services["worker"]["volumes"][0]["bind"]["create_host_path"])
                self.assertTrue(services["worker"]["volumes"][0]["read_only"])

    def test_compose_config_exposes_referenced_paths_without_env_values(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "op.env").write_text("PROJECT_NAME=synthetic\n")
            (root / "role.env").write_text("PRIVATE_SENTINEL=synthetic-hidden-value\n")
            (root / "site.yml").write_text("synthetic: true\n")
            (root / "compose.yml").write_text(
                "services:\n  api:\n    image: busybox:stable\n"
                "    env_file: ./role.env\n    configs: [site]\n"
                "configs:\n  site:\n    file: ./site.yml\n"
            )
            result = subprocess.run(
                ["docker", "compose", "--env-file", str(root / "op.env"),
                 "-f", str(root / "compose.yml"), "config", "--format", "json",
                 "--no-env-resolution"], check=True, capture_output=True,
                text=True, timeout=10,
            )
            config = json.loads(result.stdout)
            self.assertEqual(config["services"]["api"]["env_file"][0]["path"],
                             str(root / "role.env"))
            self.assertEqual(config["configs"]["site"]["file"], str(root / "site.yml"))
            self.assertNotIn("synthetic-hidden-value", result.stdout)

    def test_redeploy_preflight_checks_host_tools_before_step_one(self):
        runbook = (ROOT / "docs/operational-deployment.md").read_text()
        preflight = runbook.split("Before step 1, check", 1)[1].split("1. Preflight", 1)[0]
        command = preflight.split("```sh", 1)[1].split("```", 1)[0]
        for required in ("command -v python3", "command -v docker", "docker compose version --short"):
            self.assertIn(required, command)
        self.assertIn("(2, 24)", command)
        result = subprocess.run(["bash", "-n"], input=command, text=True,
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_redeploy_migration_uses_pinned_container_and_valid_shell(self):
        runbook = (ROOT / "docs/operational-deployment.md").read_text()
        step = runbook.split("4. Apply `split/0005`", 1)[1].split("5. Deploy the API", 1)[0]
        command = step.split("```sh", 1)[1].split("```", 1)[0]
        self.assertIn("postgres:17.6-alpine@sha256:ef257d85", command)
        self.assertEqual(command.count('docker run --rm --network host'), 2)
        self.assertEqual(command.count('--env-file "${OWNER_DB_ENV}"'), 2)
        self.assertIn('dst=/migration.sql,readonly', command)
        self.assertIn('app.generated_artifacts', command)
        self.assertIn('split/0005_generated_artifacts.sql', command)
        result = subprocess.run(["bash", "-n"], input=command, text=True,
                                capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

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
            self.assertEqual(
                [(mount["target"], mount["source"]) for mount in services["worker"]["volumes"]],
                [("/app/published-personas.private.json", str(published))],
            )
            self.assertTrue(services["api"]["volumes"][0]["read_only"])
            snapshot = root / "snapshot"
            snapshot.mkdir()
            (snapshot / "manifest.json").write_text(json.dumps({"data_mounts": [
                {"service": "api", "target": "/app/data/generated", "source": str(ROOT / "data" / "generated")},
                {"service": "worker", "target": "/app/published-personas.private.json", "source": str(published)},
            ]}))
            helper = ROOT / "scripts/operational-snapshot.py"
            def matches(config: dict) -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    [sys.executable, str(helper), "check-data-mounts", "--snapshot", str(snapshot),
                     "--rendered-config", "-"], input=json.dumps(config), text=True,
                    capture_output=True, timeout=10,
                )
            self.assertEqual(matches({"services": services}).stdout.strip(), "data_mounts_match=true")
            services["worker"]["volumes"].append({
                "type": "bind", "target": "/app/data", "source": str(ROOT / "data"),
            })
            self.assertNotEqual(matches({"services": services}).returncode, 0)
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
