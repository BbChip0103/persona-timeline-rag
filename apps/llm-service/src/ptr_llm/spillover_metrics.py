"""Public, content-free worker spillover availability metric."""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge, generate_latest

_registry = CollectorRegistry()
_gauge = Gauge(
    "ptr_llm_spillover_available",
    "One when a verified spillover can reserve a maximal chat call",
    registry=_registry,
)
_capacity_retries = Counter(
    "ptr_llm_local_capacity_retries",
    "Local EPP capacity responses retried by the worker",
    registry=_registry,
)
_available = False


def set_available(available: bool) -> None:
    global _available
    _available = bool(available)
    _gauge.set(int(_available))


def record_capacity_retry() -> None:
    _capacity_retries.inc()


def render() -> bytes:
    return generate_latest(_registry)
