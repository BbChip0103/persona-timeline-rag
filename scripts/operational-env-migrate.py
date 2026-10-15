#!/usr/bin/env python3
"""Prepare and check private direct-path env files without displaying values."""

import argparse
import math
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
    "PTR_LLM_LIVE_ENABLED": "0",
    "PTR_LLM_ALLOW_EXTERNAL_DATA": "0",
    "PTR_LLM_LOCAL_SLOTS": "8",
    "PTR_LLM_SPILLOVER_WAIT_MS": "2000",
    "PTR_LLM_CONCURRENCY": "10",
    "PTR_LLM_OPENROUTER_KEY_MAX_LIMIT_USD": "1",
    "PTR_LLM_EMBEDDING_PROVIDER": "off",
    "PTR_LLM_INTENT_CLASSIFIER": "off",
    "PTR_LLM_SAFETY_FILTER": "off",
}
BACKEND_KEYS = {"PTR_CHAT_PROVIDER": "local", "PTR_MODEL": ""}
COMPOSE_KEYS = {
    "PTR_OPERATIONAL_DATA_DIR": "",
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


def forbidden(key: str, kind: str, spillover: bool = False) -> bool:
    if key == "PTR_LLM_SYNTHETIC_PROVIDER_FIXTURE":
        return True
    if key in OPENROUTER or key.startswith(GATEWAY_PREFIXES):
        if kind == "worker" and spillover and key == "OPENROUTER_API_KEY":
            return False
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


def _openrouter_key(source: Path) -> str:
    found = []
    for line in read_lines(source):
        match = KEY.match(line)
        if match and match[1] in OPENROUTER:
            found.append(match[2])
    if len(found) != 1 or not found[0].strip():
        raise ValueError("OpenRouter source must contain exactly one nonempty named key")
    return found[0]


def prepare(
    kind: str,
    source: Path,
    output: Path,
    *,
    spillover_openrouter: bool = False,
    openrouter_source: Path | None = None,
) -> None:
    if spillover_openrouter != (openrouter_source is not None) or (
        spillover_openrouter and kind != "worker"
    ):
        raise ValueError("OpenRouter source and spillover flag require worker prepare together")
    lines = read_lines(source)
    replacements = dict(
        {"worker": LOCAL_KEYS, "backend": BACKEND_KEYS, "compose": COMPOSE_KEYS}[kind]
    )
    if spillover_openrouter:
        replacements["PTR_LLM_SPILLOVER"] = "openrouter"
        replacements["PTR_LLM_LIVE_ENABLED"] = "1"
        replacements["PTR_LLM_ALLOW_EXTERNAL_DATA"] = "1"
        replacements["OPENROUTER_API_KEY"] = _openrouter_key(openrouter_source)
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
    print(
        "prepared keys: "
        + ", ".join(replacements)
        + f"; spillover_enabled={str(spillover_openrouter).lower()}"
    )


def _values(kind: str, path: Path) -> dict[str, str]:
    if stat.S_IMODE(path.stat().st_mode) != 0o600:
        raise ValueError("input must have mode 0600")
    values: dict[str, str] = {}
    duplicates = []
    for line in read_lines(path):
        match = KEY.match(line)
        if not match:
            continue
        key, value = match.groups()
        if key in values:
            duplicates.append(key)
        values[key] = value
    spillover = kind == "worker" and values.get("PTR_LLM_SPILLOVER") == "openrouter"
    banned = sorted(key for key in values if forbidden(key, kind, spillover))
    if duplicates or banned:
        raise ValueError(
            "invalid keys; duplicate: "
            + ", ".join(sorted(set(duplicates)))
            + "; forbidden: "
            + ", ".join(banned)
        )
    return values


def _check_spillover(values: dict[str, str]) -> None:
    enabled = values.get("PTR_LLM_SPILLOVER") == "openrouter"
    if values.get("PTR_LLM_SPILLOVER", "off") not in {"off", "openrouter"}:
        raise ValueError("invalid PTR_LLM_SPILLOVER")
    if enabled:
        for key in ("PTR_LLM_LIVE_ENABLED", "PTR_LLM_ALLOW_EXTERNAL_DATA"):
            if values.get(key) != "1":
                raise ValueError(key + " must be 1 for spillover")
        missing = sorted(
            key
            for key in (
                "PTR_LLM_LOCAL_SLOTS",
                "OPENROUTER_API_KEY",
                "PTR_LLM_OPENROUTER_KEY_MAX_LIMIT_USD",
            )
            if not values.get(key)
        )
        if missing:
            raise ValueError("missing spillover keys: " + ", ".join(missing))
        try:
            limit = float(values["PTR_LLM_OPENROUTER_KEY_MAX_LIMIT_USD"])
        except ValueError:
            raise ValueError("invalid PTR_LLM_OPENROUTER_KEY_MAX_LIMIT_USD") from None
        if not math.isfinite(limit) or not 0 < limit <= 1:
            raise ValueError("invalid PTR_LLM_OPENROUTER_KEY_MAX_LIMIT_USD")
    try:
        slots = int(values.get("PTR_LLM_LOCAL_SLOTS", "8"))
        concurrency = int(values.get("PTR_LLM_CONCURRENCY", "10"))
        wait_ms = int(values.get("PTR_LLM_SPILLOVER_WAIT_MS", "2000"))
    except ValueError:
        raise ValueError("invalid slot, concurrency or wait setting") from None
    if not (1 <= slots <= 256 and 1 <= concurrency <= 128 and 100 <= wait_ms <= 10000):
        raise ValueError("invalid slot, concurrency or wait setting")
    if enabled and concurrency <= slots:
        print("warning: PTR_LLM_CONCURRENCY <= PTR_LLM_LOCAL_SLOTS")
    if not enabled:
        for key in ("PTR_LLM_LIVE_ENABLED", "PTR_LLM_ALLOW_EXTERNAL_DATA"):
            if values.get(key) == "1":
                print(f"warning: {key}=true while spillover_enabled=false")
    key_present = bool(values.get("OPENROUTER_API_KEY"))
    print(
        f"spillover_enabled={str(enabled).lower()};",
        f"openrouter_key_present={str(key_present).lower()}",
    )


def check(kind: str, path: Path) -> None:
    values = _values(kind, path)
    missing = sorted(key for key in REQUIRED[kind] if not values.get(key))
    fixed = {
        "worker": {
            "PTR_LLM_PROVIDER": "local",
            "PTR_LLM_LOCAL_AUTH_REQUIRED": "1",
            "PTR_LLM_EMBEDDING_PROVIDER": "off",
            "PTR_LLM_INTENT_CLASSIFIER": "off",
            "PTR_LLM_SAFETY_FILTER": "off",
        },
        "backend": {"PTR_CHAT_PROVIDER": "local"},
        "compose": {},
    }[kind]
    wrong = sorted(key for key, expected in fixed.items() if values.get(key) != expected)
    if missing or wrong:
        raise ValueError(
            "invalid keys; missing: "
            + ", ".join(missing)
            + "; wrong fixed value: "
            + ", ".join(wrong)
        )
    if kind == "worker":
        _check_spillover(values)
    if kind == "compose" and "PTR_OPERATIONAL_DATA_DIR" not in missing:
        data = Path(values["PTR_OPERATIONAL_DATA_DIR"])
        if not data.is_absolute():
            raise ValueError("PTR_OPERATIONAL_DATA_DIR must be absolute")
        details = data.lstat()
        if not stat.S_ISDIR(details.st_mode):
            raise ValueError("PTR_OPERATIONAL_DATA_DIR must be a directory")
        if details.st_uid != os.getuid() or stat.S_IMODE(details.st_mode) != 0o700:
            raise ValueError(
                "PTR_OPERATIONAL_DATA_DIR must be owned by the current user with mode 0700"
            )
        if not (data / "research").is_dir() or not (data / "generated").is_dir():
            raise ValueError("PTR_OPERATIONAL_DATA_DIR requires research and generated directories")
        worker = Path(values["PTR_LLM_SERVICE_ENV_FILE"])
        if not worker.is_absolute():
            raise ValueError("PTR_LLM_SERVICE_ENV_FILE must be absolute")
        worker_values = _values("worker", worker)
        _check_spillover(worker_values)
        backend = Path(values["PTR_FRAMEWORK_APP_ENV_FILE"])
        if not backend.is_absolute():
            raise ValueError("PTR_FRAMEWORK_APP_ENV_FILE must be absolute")
        backend_values = _values("backend", backend)
        spillover_enabled = worker_values.get("PTR_LLM_SPILLOVER") == "openrouter"
        if backend_values.get("PTR_PAID_SPILLOVER") != ("1" if spillover_enabled else "0"):
            raise ValueError("PTR_PAID_SPILLOVER must match PTR_LLM_SPILLOVER")
        print(f"PTR_PAID_SPILLOVER={str(spillover_enabled).lower()}")
        for key, default in (
            ("PTR_LLM_LOCAL_SLOTS", "8"),
            ("PTR_LLM_CONCURRENCY", "10"),
            ("PTR_LLM_SPILLOVER_WAIT_MS", "2000"),
        ):
            effective = os.environ.get(key, values.get(key, default))
            if worker_values.get(key, default) != effective:
                raise ValueError(key + " must match the effective Compose setting")
    print("checked keys: " + ", ".join(sorted(REQUIRED[kind])))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "check"))
    parser.add_argument("kind", choices=("worker", "backend", "compose"))
    parser.add_argument("input", type=Path)
    parser.add_argument("output", nargs="?", type=Path)
    parser.add_argument("--spillover-openrouter", action="store_true")
    parser.add_argument("--openrouter-source", type=Path)
    args = parser.parse_args()
    try:
        if args.action == "prepare":
            if args.output is None:
                parser.error("prepare requires an output path")
            prepare(
                args.kind,
                args.input,
                args.output,
                spillover_openrouter=args.spillover_openrouter,
                openrouter_source=args.openrouter_source,
            )
        else:
            if (
                args.output is not None
                or args.spillover_openrouter
                or args.openrouter_source is not None
            ):
                parser.error("check accepts only an input path")
            check(args.kind, args.input)
    except (OSError, UnicodeError, ValueError) as exc:
        parser.exit(1, f"env migration failed: {exc}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
