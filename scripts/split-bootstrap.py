"""Initialize a NEW synthetic database; never run against the research source."""

import argparse
from dataclasses import replace
from pathlib import Path
from urllib.parse import urlsplit

from persona_timeline_rag.split_migration import (
    LOCAL_SYNTHETIC_BOOTSTRAP_PROFILE,
    SplitBootstrapProfile,
    bootstrap_synthetic_split_database,
    read_environment,
)


def local_profile(env: dict[str, str]) -> SplitBootstrapProfile:
    target = urlsplit(env["PTR_SPLIT_TEST_OWNER_DATABASE_URL"])
    if not (
        target.scheme in ("postgres", "postgresql")
        and target.hostname == "127.0.0.1"
        and target.port == 58432
        and target.path == "/ptr_split_test"
        and target.username == "ptr_split_owner"
        and target.password
        and not target.query
        and not target.fragment
    ):
        raise RuntimeError("SYNTHETIC_RUNTIME_TARGET_REQUIRED")
    return replace(LOCAL_SYNTHETIC_BOOTSTRAP_PROFILE, port=target.port)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--roles-env", type=Path, required=True)
    args = parser.parse_args()
    env = read_environment(args.roles_env)
    print(
        bootstrap_synthetic_split_database(
            env,
            sql_root=Path("supabase"),
            profile=local_profile(env),
        )
    )


if __name__ == "__main__":
    try:
        main()
    except Exception:
        raise SystemExit("Synthetic bootstrap failed (private details withheld)") from None
