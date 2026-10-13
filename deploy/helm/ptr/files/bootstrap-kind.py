"""Bootstrap the synthetic split database inside kind."""

import argparse
from pathlib import Path

from persona_timeline_rag.split_migration import (
    KIND_SYNTHETIC_BOOTSTRAP_PROFILE,
    bootstrap_synthetic_split_database,
)

CURRENT_STAGE = "validation"


def read_roles_env(path: Path) -> dict[str, str]:
    env: dict[str, str] = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep:
            raise RuntimeError("INVALID_ROLES_ENV")
        env[key] = value
    return env


def set_stage(stage: str) -> None:
    global CURRENT_STAGE
    CURRENT_STAGE = stage


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--roles-env", type=Path, required=True)
    parser.add_argument("--sql-root", type=Path, required=True)
    args = parser.parse_args()
    print(
        bootstrap_synthetic_split_database(
            read_roles_env(args.roles_env),
            sql_root=args.sql_root,
            profile=KIND_SYNTHETIC_BOOTSTRAP_PROFILE,
            stage_callback=set_stage,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        code = getattr(exc, "sqlstate", None)
        print(
            f"Synthetic cluster bootstrap failed at {CURRENT_STAGE}: "
            f"{type(exc).__name__} {code or ''}"
        )
        raise SystemExit(1) from None
