#!/usr/bin/env python3
"""Issue a constrained application key; never pass LiteLLM master credentials to the app."""

import argparse
import json
import math
import os
import urllib.request
from pathlib import Path

from smoke import load_env

ALLOWED_CHAT_ROUTES = ["/v1/chat/completions", "/chat/completions"]

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--env-file", required=True, type=Path)
parser.add_argument("--output", required=True, type=Path)
parser.add_argument("--budget-usd", required=True, type=float)
parser.add_argument("--rpm", required=True, type=int)
parser.add_argument("--tpm", required=True, type=int)
parser.add_argument("--model", action="append", required=True)
args = parser.parse_args()
if not math.isfinite(args.budget_usd) or args.budget_usd <= 0 or args.rpm <= 0 or args.tpm <= 0:
    parser.error("Budget and rate limits must be positive")
# Check destination first: don't mint an inaccessible key then overwrite old app credentials.
fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    env = load_env(args.env_file)
    req = urllib.request.Request(
        "http://127.0.0.1:" + env["PTR_LITELLM_PORT"] + "/key/generate",
        data=json.dumps(
            {
                "models": args.model,
                "max_budget": args.budget_usd,
                "budget_duration": "1d",
                "rpm_limit": args.rpm,
                "tpm_limit": args.tpm,
                "key_alias": "ptr-application",
                "allowed_routes": ALLOWED_CHAT_ROUTES,
            }
        ).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + env["PTR_LITELLM_MASTER_KEY"],
        },
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        key = json.load(response)["key"]
    with os.fdopen(fd, "w") as handle:
        handle.write("PTR_LITELLM_API_KEY=" + key + "\n")
except BaseException:
    try:
        os.close(fd)
    except OSError:
        pass
    args.output.unlink(missing_ok=True)
    raise
print("Created constrained app-key file (value not printed)")
