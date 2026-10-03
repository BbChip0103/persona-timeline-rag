"""Read local Codex accounting only; never export prompts, secrets or thread IDs."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sqlite3
from pathlib import Path

FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)


def tally(path: Path, since: str | None = None, seen: set[str] | None = None) -> dict[str, object]:
    totals = {key: 0 for key in FIELDS}
    records = 0
    first = last = None
    seen = set() if seen is None else seen
    lower_bound = dt.datetime.fromisoformat(since.replace("Z", "+00:00")) if since else None
    with path.open() as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue  # An active writer may have left a partial final line.
            if event.get("type") != "token_usage_record":
                continue  # token_count is cumulative: NEVER sum it again.
            timestamp = event.get("timestamp", "")
            if (
                lower_bound
                and dt.datetime.fromisoformat(timestamp.replace("Z", "+00:00")) < lower_bound
            ):
                continue
            payload = event.get("payload", {})
            marker = str(
                payload.get("response_id") or f"{payload.get('thread_id')}:{event.get('ordinal')}"
            )
            if marker in seen:
                continue
            seen.add(marker)
            usage = payload.get("usage", {})
            if not isinstance(usage, dict):
                continue
            for key in FIELDS:
                value = usage.get(key, 0)
                if isinstance(value, int) and value >= 0:
                    totals[key] += value
            records += 1
            first = timestamp if first is None else first
            last = timestamp
    return {
        "tokens": totals,
        "response_records": records,
        "first_usage_at": first,
        "last_usage_at": last,
    }


def snapshot(home: Path, root: str, since: str | None) -> dict[str, object]:
    databases = sorted(home.glob("state_*.sqlite"))
    if not databases:
        raise RuntimeError("No local accounting database")
    connection = sqlite3.connect(f"file:{databases[-1]}?mode=ro", uri=True)
    rows = connection.execute("SELECT id,rollout_path,model FROM threads").fetchall()
    edges = connection.execute(
        "SELECT parent_thread_id,child_thread_id FROM thread_spawn_edges"
    ).fetchall()
    selected = {root}
    while True:
        children = {child for parent, child in edges if parent in selected}
        if children <= selected:
            break
        selected.update(children)
    summaries = []
    total = {field: 0 for field in FIELDS}
    unavailable = 0
    seen: set[str] = set()
    for thread_id, rollout, model in rows:
        if thread_id not in selected:
            continue
        try:
            result = tally(Path(rollout), since, seen)
        except OSError:
            unavailable += 1
            continue
        if result["response_records"] == 0:
            continue
        for field in FIELDS:
            total[field] += result["tokens"][field]
        summaries.append(
            {"lane": "leader" if thread_id == root else "child", "model": model, **result}
        )
    connection.close()
    return {
        "sampled_at": dt.datetime.now(dt.UTC).isoformat(),
        "scope_since_utc": since,
        "scope": "leader plus descendant usage records in time window",
        "source": "local Codex token_usage_record; cumulative events excluded",
        "tokens": total,
        "lanes": summaries,
        "unavailable_rollouts": unavailable,
        "uncached_input_tokens": max(
            0,
            total["input_tokens"]
            - total["cached_input_tokens"]
            - total["cache_write_input_tokens"],
        ),
        "codex_dollar_cost": None,
        "notes": [
            "Cached tokens are part of input, not extra tokens.",
            "Reasoning output is a subset of output, not added again.",
            "This is an in-progress snapshot, excluding its own unfinished response.",
            "Time-window attribution includes context replay, not only newly written text.",
            "No claim about invoice cost or active human management time.",
        ],
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default="2026-10-03T10:08:25.014Z")
    parser.add_argument("--output", default="reports/effort/codex-usage.json")
    args = parser.parse_args()
    home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
    thread = os.environ.get("CODEX_THREAD_ID")
    if not thread:
        raise SystemExit("CODEX_THREAD_ID unavailable; do not invent usage")
    report = snapshot(home, thread, args.since)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    os.chmod(output, 0o600)
    print(
        json.dumps(
            {
                "sampled_at": report["sampled_at"],
                "tokens": report["tokens"],
                "uncached_input_tokens": report["uncached_input_tokens"],
                "lanes": len(report["lanes"]),
                "output": str(output),
            }
        )
    )


if __name__ == "__main__":
    main()
