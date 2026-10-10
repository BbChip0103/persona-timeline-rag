#!/usr/bin/env python3
"""Real Langfuse v4 health/auth/blob-policy smoke in the explicit isolated stack."""

import argparse
import base64
import http.cookiejar
import json
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


def load_env(path):
    return dict(
        line.split("=", 1)
        for line in Path(path).read_text().splitlines()
        if line and not line.startswith("#")
    )


def get(url, credential=None):
    headers = (
        {"Authorization": "Basic " + base64.b64encode(credential.encode()).decode()}
        if credential
        else {}
    )
    try:
        with urllib.request.urlopen(
            urllib.request.Request(url, headers=headers), timeout=10
        ) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def run(env_path):
    env = load_env(env_path)
    assert env["PTR_FRAMEWORK_PROJECT"].startswith("ptr-fw-"), "Require isolated new project"
    base = "http://127.0.0.1:" + env["PTR_LANGFUSE_PORT"]
    assert base == env["LANGFUSE_BASE_URL"]
    assert get(base + "/api/public/health?failIfDatabaseUnavailable=true")[0] == 200
    assert get(base + "/api/public/ready")[0] == 200
    assert get(base + "/auth/sign-in")[0] == 200
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )
    with opener.open(base + "/api/auth/csrf", timeout=10) as response:
        csrf = json.load(response)["csrfToken"]
    body = urllib.parse.urlencode(
        {
            "email": env["PTR_LANGFUSE_USER_EMAIL"],
            "password": env["PTR_LANGFUSE_USER_PASSWORD"],
            "csrfToken": csrf,
            "callbackUrl": base,
            "json": "true",
        }
    ).encode()
    with opener.open(
        urllib.request.Request(
            base + "/api/auth/callback/credentials",
            data=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        ),
        timeout=10,
    ) as response:
        login = json.load(response)
        assert "error=" not in login.get("url", ""), "Operator login rejected"
    with opener.open(base + "/api/auth/session", timeout=10) as response:
        session = json.load(response)
        assert session.get("user", {}).get("email") == env["PTR_LANGFUSE_USER_EMAIL"], (
            "No authenticated operator session"
        )
    assert get(base + "/api/public/datasets", "invalid:invalid")[0] in (401, 403)
    credential = env["LANGFUSE_PUBLIC_KEY"] + ":" + env["LANGFUSE_SECRET_KEY"]
    assert get(base + "/api/public/datasets", credential)[0] == 200
    blob = "http://127.0.0.1:" + env["PTR_LANGFUSE_BLOB_PORT"]
    assert get(blob + "/minio/health/live")[0] == 200
    assert get(blob + "/ptr-langfuse/")[0] == 403, "Blob bucket must reject anonymous access"
    compose = [
        "docker",
        "compose",
        "--env-file",
        str(env_path),
        "-f",
        "infra/compose.framework.yml",
        "--profile",
        "observability",
    ]
    subprocess.run(
        compose
        + [
            "exec",
            "-T",
            "langfuse-worker",
            "node",
            "-e",
            "fetch('http://127.0.0.1:3030/api/health?failIfQueueConsumptionStuck=true').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))",
        ],
        check=True,
        capture_output=True,
    )
    # Secrets are expanded inside container only, and mc's credential output is suppressed.
    result = subprocess.run(
        compose
        + [
            "exec",
            "-T",
            "langfuse-blob",
            "sh",
            "-c",
            'mc alias set policy http://127.0.0.1:9000 "$MINIO_ROOT_USER" '
            '"$MINIO_ROOT_PASSWORD" >/dev/null && mc ilm export policy/ptr-langfuse',
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    policy = json.loads(result.stdout)
    rule = policy["Rules"][0]
    assert rule["Status"] == "Enabled"
    assert rule["Expiration"]["Days"] == 90
    assert rule["NoncurrentVersionExpiration"]["NoncurrentDays"] == 90
    print(
        "PASS real Langfuse v4: web DB-health/readiness, worker queue-health, UI auth, "
        "project-key auth, private blob and installed90d lifecycle"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", required=True, type=Path)
    run(parser.parse_args().env_file)
