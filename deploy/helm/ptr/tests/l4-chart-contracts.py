#!/usr/bin/env python3
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[4]
CHART = ROOT / "deploy" / "helm" / "ptr"
PROD_VALUES = CHART / "values-prod.yaml"


def render(*args: str) -> list[dict]:
    result = subprocess.run(
        ["timeout", "60s", "helm", "template", "ptr", str(CHART), *args],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(result.stderr)
    return [doc for doc in yaml.safe_load_all(result.stdout) if isinstance(doc, dict)]


def named(docs: list[dict], kind: str, name: str) -> dict:
    matches = [
        doc
        for doc in docs
        if doc.get("kind") == kind and doc.get("metadata", {}).get("name") == name
    ]
    if len(matches) != 1:
        raise AssertionError(f"expected one {kind}/{name}, got {len(matches)}")
    return matches[0]


def container_env(docs: list[dict], deployment: str, container: str) -> dict[str, dict]:
    pod_spec = named(docs, "Deployment", deployment)["spec"]["template"]["spec"]
    containers = {
        item["name"]: item
        for item in pod_spec["containers"]
    }
    return {item["name"]: item for item in containers[container].get("env", [])}


def policies(docs: list[dict], prefix: str) -> list[dict]:
    return [
        doc
        for doc in docs
        if doc.get("kind") == "NetworkPolicy"
        and doc.get("metadata", {}).get("name", "").startswith(prefix)
    ]


def assert_spillover_env() -> None:
    on = render("--values", str(PROD_VALUES), "--set", "llm.spillover=openrouter")
    off = render("--values", str(PROD_VALUES), "--set", "llm.spillover=off")
    assert container_env(on, "ptr-api", "api")["PTR_PAID_SPILLOVER"]["value"] == "1"
    assert container_env(off, "ptr-api", "api")["PTR_PAID_SPILLOVER"]["value"] == "0"
    assert "PTR_PAID_SPILLOVER" not in container_env(on, "ptr-worker", "worker")
    assert "PTR_PAID_SPILLOVER" not in container_env(off, "ptr-worker", "worker")
    assert "OPENROUTER_API_KEY" in container_env(on, "ptr-worker", "worker")
    assert "OPENROUTER_API_KEY" not in container_env(off, "ptr-worker", "worker")


def assert_worker_timeout_and_key_limit() -> None:
    docs = render("--values", str(PROD_VALUES))
    worker_env = container_env(docs, "ptr-worker", "worker")
    assert worker_env["PTR_LLM_MODEL_TIMEOUT_MS"]["value"] == "25000"
    assert worker_env["PTR_LLM_OPENROUTER_KEY_MAX_LIMIT_USD"]["value"] == "1"
    values = yaml.safe_load(PROD_VALUES.read_text(encoding="utf-8"))
    assert values["llm"]["openrouter"]["keyMaxLimitUsd"] == "1"


def assert_egress_shapes() -> None:
    prod_on = render("--values", str(PROD_VALUES), "--set", "llm.spillover=openrouter")
    prod_off = render("--values", str(PROD_VALUES), "--set", "llm.spillover=off")
    epp = named(prod_on, "NetworkPolicy", "ptr-worker-to-epp")
    assert epp["spec"]["egress"] == [
        {
            "to": [
                {
                    "namespaceSelector": {
                        "matchLabels": {"kubernetes.io/metadata.name": "ptr-inference"}
                    },
                    "podSelector": {"matchLabels": {"llm-d-router-standalone": "chat-primary-epp"}},
                }
            ],
            "ports": [{"protocol": "TCP", "port": 8081}],
        }
    ]
    openrouter = policies(prod_on, "ptr-worker-to-openrouter-")
    assert openrouter, "prod spillover must render OpenRouter egress policies"
    for policy in openrouter:
        egress = policy["spec"]["egress"]
        assert len(egress) == 1
        assert egress[0]["ports"] == [{"protocol": "TCP", "port": 443}]
        targets = egress[0]["to"]
        assert len(targets) == 1 and set(targets[0]) == {"ipBlock"}
    assert policies(prod_off, "ptr-worker-to-openrouter-") == []


def main() -> int:
    assert_spillover_env()
    assert_worker_timeout_and_key_limit()
    assert_egress_shapes()
    return 0


if __name__ == "__main__":
    sys.exit(main())
