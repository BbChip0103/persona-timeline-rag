"""Summarize Goal2 engine x precision benchmark results (vllm bench serve JSON + GPU samples).

Usage: python3 scripts/summarize_engine_bench.py <run-dir> [<gpu-csv-dir>]
<run-dir> holds one directory per serve target (vllm-e4b, sglang-e4b, ...), each with
<workload>_c<N>.json, phases.log, vram_after_load_mib.txt and quality.json.
Prints Markdown tables and writes <run-dir>/summary.json. Pure stdlib.
"""
from __future__ import annotations

import csv
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

RESULT = re.compile(r"^(chat|prefix|long)_c(\d+)\.json$")
PHASE = re.compile(r"^([\d.]+) (\w+) c=(\d+) (start|end)")


def load_phases(path: Path) -> dict[tuple[str, int], tuple[float, float]]:
    """(workload, concurrency) -> (start_epoch, end_epoch)."""
    starts: dict[tuple[str, int], float] = {}
    windows: dict[tuple[str, int], tuple[float, float]] = {}
    if not path.exists():
        return windows
    for line in path.read_text().splitlines():
        match = PHASE.match(line)
        if not match:
            continue
        key = (match.group(2), int(match.group(3)))
        if match.group(4) == "start":
            starts[key] = float(match.group(1))
        elif key in starts:
            windows[key] = (starts[key], float(match.group(1)))
    return windows


def load_gpu(path: Path | None) -> list[dict[str, float]]:
    """nvidia-smi CSV (timestamps are the pod's UTC clock) -> rows with epoch seconds."""
    if path is None or not path.exists():
        return []
    rows = []
    with path.open() as handle:
        reader = csv.reader(handle)
        next(reader, None)
        for raw in reader:
            if len(raw) < 8:
                continue
            try:
                stamp = datetime.strptime(raw[0].strip(), "%Y/%m/%d %H:%M:%S.%f").replace(tzinfo=timezone.utc)
                rows.append({"t": stamp.timestamp(), "util": float(raw[1]), "mem_util": float(raw[2]),
                             "power": float(raw[3]), "sm_mhz": float(raw[4]), "vram_mib": float(raw[6])})
            except ValueError:
                continue
    return rows


def gpu_window(rows: list[dict[str, float]], window: tuple[float, float] | None) -> dict[str, float] | None:
    if not window:
        return None
    inside = [row for row in rows if window[0] <= row["t"] <= window[1]]
    if not inside:
        return None
    mean = lambda key: round(sum(row[key] for row in inside) / len(inside), 1)  # noqa: E731
    return {"gpu_util": mean("util"), "mem_bw_util": mean("mem_util"), "power_w": mean("power"),
            "sm_mhz": mean("sm_mhz"), "samples": len(inside)}


def summarize_target(directory: Path, gpu_csv: Path | None) -> dict:
    phases = load_phases(directory / "phases.log")
    gpu_rows = load_gpu(gpu_csv)
    runs = []
    for path in sorted(directory.glob("*.json")):
        match = RESULT.match(path.name)
        if not match:
            continue
        data = json.loads(path.read_text())
        workload, concurrency = match.group(1), int(match.group(2))
        runs.append({
            "workload": workload, "concurrency": concurrency,
            "completed": data.get("completed"), "failed": data.get("failed"),
            "req_per_s": round(data["request_throughput"], 2), "out_tok_per_s": round(data["output_throughput"], 1),
            "ttft_p50_ms": round(data["p50_ttft_ms"], 1), "ttft_p95_ms": round(data["p95_ttft_ms"], 1),
            "tpot_p50_ms": round(data["p50_tpot_ms"], 2), "tpot_p95_ms": round(data["p95_tpot_ms"], 2),
            "e2e_p50_ms": round(data["p50_e2el_ms"], 1), "e2e_p95_ms": round(data["p95_e2el_ms"], 1),
            "gpu": gpu_window(gpu_rows, phases.get((workload, concurrency))),
        })
    runs.sort(key=lambda run: (run["workload"], run["concurrency"]))
    vram = directory / "vram_after_load_mib.txt"
    quality = directory / "quality.json"
    return {
        "target": directory.name,
        "vram_after_load_mib": int(vram.read_text().strip()) if vram.exists() else None,
        "quality": json.loads(quality.read_text())["summary"] if quality.exists() else None,
        "failed_to_start": "server_failed" in (directory / "phases.log").read_text() if (directory / "phases.log").exists() else True,
        "runs": runs,
    }


def markdown(summaries: list[dict]) -> str:
    lines = []
    for workload in ("chat", "prefix", "long"):
        lines += [f"\n### {workload}", "",
                  "| target | c | req/s | out tok/s | TTFT p50/p95 ms | TPOT p50/p95 ms | e2e p95 ms | GPU % | mem-BW % | W |",
                  "|---|---:|---:|---:|---|---|---:|---:|---:|---:|"]
        for summary in summaries:
            for run in summary["runs"]:
                if run["workload"] != workload:
                    continue
                gpu = run["gpu"] or {}
                lines.append(f"| {summary['target']} | {run['concurrency']} | {run['req_per_s']} | {run['out_tok_per_s']} | "
                             f"{run['ttft_p50_ms']}/{run['ttft_p95_ms']} | {run['tpot_p50_ms']}/{run['tpot_p95_ms']} | "
                             f"{run['e2e_p95_ms']} | {gpu.get('gpu_util', '-')} | {gpu.get('mem_bw_util', '-')} | {gpu.get('power_w', '-')} |")
    lines += ["", "| target | VRAM after load MiB | quality strict JSON / n | Korean ratio | failed to start |", "|---|---:|---|---:|---|"]
    for summary in summaries:
        quality = summary["quality"] or {}
        lines.append(f"| {summary['target']} | {summary['vram_after_load_mib']} | {quality.get('strict_json', '-')}/{quality.get('n', '-')} | "
                     f"{quality.get('mean_korean_ratio', '-')} | {summary['failed_to_start']} |")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    run_dir = Path(argv[1])
    gpu_dir = Path(argv[2]) if len(argv) > 2 else run_dir
    summaries = []
    for directory in sorted(path for path in run_dir.iterdir() if path.is_dir()):
        csvs = sorted(gpu_dir.glob(f"gpu-*-{directory.name}.csv"))
        summaries.append(summarize_target(directory, csvs[-1] if csvs else None))
    (run_dir / "summary.json").write_text(json.dumps(summaries, ensure_ascii=False, indent=1))
    print(markdown(summaries))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
