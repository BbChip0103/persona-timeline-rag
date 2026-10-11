"""Small, dependency-free helpers for background vLLM telemetry polling."""

import math
import re
from urllib.parse import urlsplit, urlunsplit

_NAME = re.compile(r"^[A-Za-z_:][A-Za-z0-9_:]*")
_FAMILIES = {
    "vllm:kv_cache_usage_perc": "kv",
    "vllm:gpu_cache_usage_perc": "kv",
    "vllm:num_requests_waiting": "waiting",
    "vllm:num_requests_running": "running",
    "process_start_time_seconds": "start",
}


def _sample_value(tail: str) -> float | None:
    """Read one Prometheus sample, respecting quoted and escaped label values."""
    if tail.startswith("{"):
        quoted = False
        index = 1
        while index < len(tail):
            char = tail[index]
            if quoted and char == "\\":
                index += 2
                continue
            if char == '"':
                quoted = not quoted
            elif char == "}" and not quoted:
                tail = tail[index + 1 :]
                break
            index += 1
        else:
            return None
    if not tail or not tail[0].isspace():
        return None
    fields = tail.split()
    if not fields:
        return None
    try:
        value = float(fields[0])
    except ValueError:
        return None
    return value if math.isfinite(value) else None


def _parse_metrics(text: str) -> tuple[float | None, float | None, float | None, float | None]:
    """Return KV maximum, waiting sum and unambiguous process start time.

    Invalid samples invalidate their entire metric family, not just that label
    set: a partial sum or maximum would understate engine pressure. Unknown
    families and timestamp/exemplar suffixes are ignored. No input is logged.
    """
    samples: dict[str, list[float]] = {"kv": [], "waiting": [], "start": [], "running": []}
    invalid: set[str] = set()
    for raw in text.splitlines():
        line = raw.strip()
        name = _NAME.match(line)
        if name is None:
            continue
        family = _FAMILIES.get(name.group())
        if family is None:
            continue
        value = _sample_value(line[name.end() :])
        if value is None or value < 0 or (family == "kv" and value > 1):
            invalid.add(family)
        else:
            samples[family].append(value)

    kv = max(samples["kv"]) if samples["kv"] and "kv" not in invalid else None
    waiting = None
    if samples["waiting"] and "waiting" not in invalid:
        try:
            total = math.fsum(samples["waiting"])
        except OverflowError:
            total = math.inf
        if math.isfinite(total):
            waiting = total
    starts = set(samples["start"])
    start = next(iter(starts)) if len(starts) == 1 and "start" not in invalid else None
    running = None
    if samples["running"] and "running" not in invalid:
        try:
            total = math.fsum(samples["running"])
        except OverflowError:
            total = math.inf
        if math.isfinite(total):
            running = total
    return kv, waiting, start, running


def parse_metrics(text: str) -> tuple[float | None, float | None, float | None]:
    return _parse_metrics(text)[:3]


def parse_capacity_metrics(
    text: str,
) -> tuple[float | None, float | None, float | None, float | None]:
    return _parse_metrics(text)


def metrics_url(api_base: str) -> str:
    """Use only the configured API origin for /metrics; never follow a path."""
    if any(char.isspace() or ord(char) < 32 or ord(char) == 127 for char in api_base):
        raise ValueError("INVALID_METRICS_ORIGIN")
    if "\\" in api_base:
        raise ValueError("INVALID_METRICS_ORIGIN")
    try:
        parsed = urlsplit(api_base)
        port = parsed.port
        valid = (
            parsed.scheme in {"http", "https"}
            and bool(parsed.hostname)
            and parsed.username is None
            and parsed.password is None
            and not parsed.query
            and not parsed.fragment
            and (port is None or port > 0)
        )
    except ValueError:
        raise ValueError("INVALID_METRICS_ORIGIN") from None
    if not valid:
        raise ValueError("INVALID_METRICS_ORIGIN")
    return urlunsplit((parsed.scheme, parsed.netloc, "/metrics", "", ""))
