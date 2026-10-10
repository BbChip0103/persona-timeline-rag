#!/usr/bin/env python3
"""Verify the REAL proxy with a local fixture; reads only the explicit isolated env."""

import argparse
import hashlib
import json
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path


def load_env(path):
    return dict(
        line.split("=", 1)
        for line in Path(path).read_text().splitlines()
        if line and not line.startswith("#")
    )


def request(base, path, key=None, body=None):
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(
        base + path, data=json.dumps(body).encode() if body is not None else None, headers=headers
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def run(env_path):
    env = load_env(env_path)
    assert env["PTR_FRAMEWORK_PROJECT"].startswith("ptr-fw-"), "Require isolated generated stack"
    assert env["PTR_LITELLM_CONFIG"] == "./litellm/config.synthetic.yaml", (
        "Never call a live provider in this smoke"
    )
    base = "http://127.0.0.1:" + env["PTR_LITELLM_PORT"]
    compose = [
        "docker",
        "compose",
        "--env-file",
        str(env_path),
        "-f",
        "infra/compose.framework.yml",
        "--profile",
        "smoke",
    ]

    def counts():
        result = subprocess.run(
            compose
            + [
                "exec",
                "-T",
                "fake-engine",
                "python",
                "-c",
                "import urllib.request;print(urllib.request.urlopen('http://127.0.0.1:8000/counts').read().decode())",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)

    def chat(key, message):
        return request(
            base,
            "/v1/chat/completions",
            key,
            {
                "model": "primary",
                "messages": [{"role": "user", "content": message}],
                "max_tokens": 32,
            },
        )

    assert request(base, "/health/readiness")[0] == 200
    before = counts()["submitted"]
    assert chat(None, "Synthetic auth check")[0] in (401, 403)
    assert counts()["submitted"] == before, "Unauthenticated request reached upstream"
    master = env["PTR_LITELLM_MASTER_KEY"]
    status, payload = chat(master, "Synthetic success")
    assert status == 200, f"Proxy success status {status}"
    assert payload["choices"][0]["message"]["content"].startswith("Synthetic reply")
    assert payload["usage"]["total_tokens"] == 28
    assert counts()["submitted"] == before + 1
    before = counts()["submitted"]
    assert chat(master, "__FAIL_500__")[0] >= 500
    assert counts()["submitted"] == before + 1, "Ambiguous upstream error was retried"
    before = counts()["submitted"]
    assert chat(master, "__TIMEOUT__")[0] >= 400
    assert counts()["submitted"] == before + 1, "Timeout was retried/fallen back"
    status, virtual = request(
        base,
        "/key/generate",
        master,
        {
            "models": ["primary"],
            "max_budget": 0.000001,
            "budget_duration": "1d",
            "rpm_limit": 120,
            "tpm_limit": 32000,
            "key_alias": "synthetic-budget-smoke-" + str(time.time_ns()),
        },
    )
    assert status == 200 and virtual.get("key"), f"Virtual key creation failed ({status})"
    assert chat(virtual["key"], "Synthetic budget accounting")[0] == 200
    # Spend update is asynchronous: wait boundedly until the persisted key's spend exceeds budget.
    for _ in range(30):
        time.sleep(1)
        status, info = request(
            base, "/key/info?key=" + hashlib.sha256(virtual["key"].encode()).hexdigest(), master
        )
        if status == 200 and info.get("info", {}).get("spend", 0) > 0.000001:
            break
    else:
        raise AssertionError("Proxy did not persist synthetic cost to virtual-key budget")
    before = counts()["submitted"]
    status, failure = chat(virtual["key"], "Must not reach upstream after budget")
    assert 400 <= status < 500 and "budget" in json.dumps(failure).lower(), (
        f"Budget did not reject ({status})"
    )
    assert counts()["submitted"] == before, "Over-budget request reached upstream"
    print(
        "PASS real LiteLLM: readiness, auth, usage, 500/timeout single submission, "
        "persisted virtual-key budget"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    run(parser.parse_args().env_file)
