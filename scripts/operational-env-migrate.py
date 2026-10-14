#!/usr/bin/env python3
"""Prepare and check private direct-path env files without displaying values."""

import argparse
import os
import re
import stat
from pathlib import Path

KEY = re.compile(r"^(?:export[ \t]+)?([A-Za-z_][A-Za-z_0-9]*)=(.*)$")
OPENROUTER = {"OPENROUTER_API_KEY", "PTR_OPENROUTER_API_KEY"}
GATEWAY_PREFIXES = ("PTR_GATEWAY_", "PTR_LITELLM_", "PTR_LLM_LITELLM_", "PTR_LLM_GATEWAY_")
LOCAL_KEYS = {
    "PTR_LLM_PROVIDER": "local",
    "PTR_LLM_LOCAL_BASE_URL": "",
    "PTR_LLM_LOCAL_MODEL": "",
    "PTR_LLM_LOCAL_API_KEY": "",
    "PTR_LLM_LOCAL_AUTH_REQUIRED": "1",
    "PTR_LLM_SPILLOVER": "off",
    "PTR_LLM_EMBEDDING_PROVIDER": "off",
    "PTR_LLM_INTENT_CLASSIFIER": "off",
    "PTR_LLM_SAFETY_FILTER": "off",
}
BACKEND_KEYS = {"PTR_CHAT_PROVIDER": "local", "PTR_MODEL": ""}
COMPOSE_KEYS = {
    "PTR_OPERATIONAL_BACKEND_IMAGE": "",
    "PTR_OPERATIONAL_WORKER_IMAGE": "",
    "PTR_FRAMEWORK_APP_ENV_FILE": "",
    "PTR_LLM_SERVICE_ENV_FILE": "",
    "PTR_OPERATIONAL_WEB_ENV_FILE": "",
}
REQUIRED = {
    "worker": set(LOCAL_KEYS),
    "backend": set(BACKEND_KEYS),
    "compose": set(COMPOSE_KEYS)
    | {
        "PTR_OPERATIONAL_PROJECT",
        "PTR_OPERATIONAL_OWNER",
        "PTR_OPERATIONAL_PUBLISHED_PERSONAS_FILE",
    },
}


def forbidden(key: str, kind: str) -> bool:
    if key in OPENROUTER or key.startswith(GATEWAY_PREFIXES):
        return True
    if kind == "worker":
        return key in {
            "PTR_LLM_CAPACITY_SPILLOVER_KEY",
            "PTR_LLM_PROMPT_USD_PER_M",
            "PTR_LLM_COMPLETION_USD_PER_M",
            "PTR_LLM_MAX_CALL_MICROUSD",
        }
    return kind == "compose" and key.startswith("PTR_OPERATIONAL_GATEWAY_")


def read_lines(path: Path) -> list[str]:
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("input must be a regular file")
    return path.read_text(encoding="utf-8").splitlines()


def prepare(kind: str, source: Path, output: Path) -> None:
    lines = read_lines(source)
    replacements = {"worker": LOCAL_KEYS, "backend": BACKEND_KEYS, "compose": COMPOSE_KEYS}[kind]
    kept = []
    for line in lines:
        match = KEY.match(line)
        if match and (match[1] in replacements or forbidden(match[1], kind)):
            continue
        kept.append(line)
    contents = "\n".join(kept + [f"{key}={value}" for key, value in replacements.items()]) + "\n"
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            file.write(contents)
    except BaseException:
        output.unlink()
        raise
    print("prepared keys: " + ", ".join(replacements))


def check(kind: str, path: Path) -> None:
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError("input must have mode 0600")
    values: dict[str, str] = {}
    duplicates = []
    banned = []
    for line in read_lines(path):
        match = KEY.match(line)
        if not match:
            continue
        key, value = match.groups()
        if key in values:
            duplicates.append(key)
        values[key] = value
        if forbidden(key, kind):
            banned.append(key)
    missing = sorted(key for key in REQUIRED[kind] if not values.get(key))
    fixed = {
        "worker": {
            "PTR_LLM_PROVIDER": "local",
            "PTR_LLM_LOCAL_AUTH_REQUIRED": "1",
            "PTR_LLM_SPILLOVER": "off",
            "PTR_LLM_EMBEDDING_PROVIDER": "off",
            "PTR_LLM_INTENT_CLASSIFIER": "off",
            "PTR_LLM_SAFETY_FILTER": "off",
        },
        "backend": {"PTR_CHAT_PROVIDER": "local"},
        "compose": {},
    }[kind]
    wrong = sorted(key for key, expected in fixed.items() if values.get(key) != expected)
    if missing or duplicates or banned or wrong:
        raise ValueError(
            "invalid keys; missing: "
            + ", ".join(missing)
            + "; duplicate: "
            + ", ".join(sorted(set(duplicates)))
            + "; forbidden: "
            + ", ".join(sorted(set(banned)))
            + "; wrong fixed value: "
            + ", ".join(wrong)
        )
    print("checked keys: " + ", ".join(sorted(REQUIRED[kind])))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "check"))
    parser.add_argument("kind", choices=("worker", "backend", "compose"))
    parser.add_argument("input", type=Path)
    parser.add_argument("output", nargs="?", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "prepare":
            if args.output is None:
                parser.error("prepare requires an output path")
            prepare(args.kind, args.input, args.output)
        else:
            if args.output is not None:
                parser.error("check accepts only an input path")
            check(args.kind, args.input)
    except (OSError, UnicodeError, ValueError) as exc:
        parser.exit(1, f"env migration failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
