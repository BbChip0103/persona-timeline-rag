#!/usr/bin/env python3
"""Generate a NEW isolated historical benchmark env; never reads real configuration."""

import argparse
import os
import secrets
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", required=True)
args = parser.parse_args()
dbpwd, queuepwd = secrets.token_hex(32), secrets.token_hex(32)
fields = {
    "PTR_BASELINE_PROJECT": "ptr-fw-baseline-" + uuid.uuid4().hex[:12],
    "PTR_BASELINE_DB_PASSWORD": dbpwd,
    "PTR_BASELINE_QUEUE_PASSWORD": queuepwd,
    "BASELINE_DATABASE_URL": "postgresql://ptr_loadtester:"
    + dbpwd
    + "@127.0.0.1:57433/ptr_loadtest",
    "BASELINE_REDIS_URL": "redis://:" + queuepwd + "@127.0.0.1:57480",
}
fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as handle:
    handle.writelines(f"{key}={value}\n" for key, value in fields.items())
print("Created new isolated baseline env (credentials not printed)")
