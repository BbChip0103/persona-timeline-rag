#!/usr/bin/env python3
"""Create NEW isolated deployment credentials. Never reads or changes an existing env."""

import argparse
import os
import secrets
import socket
import uuid
from pathlib import Path


def free_ports(count):
    sockets = []
    try:
        for _ in range(count):
            sock = socket.socket()
            sock.bind(("127.0.0.1", 0))
            sockets.append(sock)
        return [sock.getsockname()[1] for sock in sockets]
    finally:
        for sock in sockets:
            sock.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    project = "ptr-fw-" + uuid.uuid4().hex[:12]
    proxy, langfuse, blob, guardrails, engine = free_ports(5)

    def token():
        return secrets.token_hex(32)

    fields = {
        "PTR_FRAMEWORK_PROJECT": project,
        "PTR_LITELLM_PORT": str(proxy),
        "PTR_LANGFUSE_PORT": str(langfuse),
        "PTR_LANGFUSE_BLOB_PORT": str(blob),
        "PTR_GUARDRAILS_PORT": str(guardrails),
        "PTR_FAKE_ENGINE_PORT": str(engine),
        "PTR_LITELLM_MASTER_KEY": "sk-" + token(),
        "PTR_LITELLM_SALT_KEY": "sk-" + token(),
        "PTR_LITELLM_DB_PASSWORD": token(),
        "PTR_FRAMEWORK_BOOTSTRAP_PASSWORD": token(),
        "PTR_FRAMEWORK_TEST_DB_PASSWORD": token(),
        "PTR_FRAMEWORK_QUEUE_PASSWORD": token(),
        "PTR_LITELLM_REDIS_PASSWORD": token(),
        "PTR_LANGFUSE_DB_PASSWORD": token(),
        "PTR_LANGFUSE_CLICKHOUSE_PASSWORD": token(),
        "PTR_LANGFUSE_REDIS_PASSWORD": token(),
        "PTR_LANGFUSE_BLOB_USER": "ptr-" + secrets.token_hex(12),
        "PTR_LANGFUSE_BLOB_PASSWORD": token(),
        "PTR_LANGFUSE_SALT": token(),
        "PTR_LANGFUSE_ENCRYPTION_KEY": token(),
        "PTR_LANGFUSE_NEXTAUTH_SECRET": token(),
        "PTR_LANGFUSE_USER_EMAIL": "operator@" + project + ".invalid",
        "PTR_LANGFUSE_USER_PASSWORD": token(),
        "PTR_LANGFUSE_ORG_ID": "org-" + uuid.uuid4().hex,
        "PTR_LANGFUSE_PROJECT_ID": "project-" + uuid.uuid4().hex,
        "LANGFUSE_PUBLIC_KEY": "pk-lf-" + uuid.uuid4().hex,
        "LANGFUSE_SECRET_KEY": "sk-lf-" + token(),
        "LANGFUSE_BASE_URL": "http://127.0.0.1:" + str(langfuse),
        "PTR_GUARDRAILS_TOKEN": token(),
        "PTR_LITELLM_CONFIG": "./litellm/config.synthetic.yaml",
        # No other project or provider configuration is copied into this file.
        "PTR_VLLM_MODEL": "openai/approved-vllm-model",
        "PTR_VLLM_BASE_URL": "http://127.0.0.1:1/v1",
        "PTR_VLLM_API_KEY": "",
        "PTR_VLLM_SECONDARY_MODEL": "",
        "PTR_VLLM_SECONDARY_BASE_URL": "",
        "PTR_VLLM_SECONDARY_API_KEY": "",
        "PTR_OPENROUTER_MODEL": "openrouter/approved-model",
        "OPENROUTER_API_KEY": "",
    }
    path = Path(args.output)
    # Exclusive creation is intentional: rerunning cannot rotate a database's secrets.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as handle:
        handle.write("# Generated isolated configuration. Do not commit.\n")
        handle.writelines(f"{key}={value}\n" for key, value in fields.items())
    print(f"Created new isolated configuration: {path}")


if __name__ == "__main__":
    main()
