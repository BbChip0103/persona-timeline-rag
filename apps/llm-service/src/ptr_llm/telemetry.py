"""Explicit self-hosted Langfuse v4 tracing; privacy filtering is always enabled."""

from __future__ import annotations

import hashlib
import json
import math
import os
import re
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

_SENSITIVE = re.compile(
    r"authorization|cookie|secret|api[_-]?key|password|credential|access[_-]?token|"
    r"raw[_-]?(?:source|image|evidence)|private[_-]?evidence",
    re.I,
)


def redact_telemetry(value: Any, depth: int = 0) -> Any:
    if depth > 8:
        return "[DEPTH_LIMIT]"
    if isinstance(value, str):
        if value.lstrip().startswith(("{", "[")) and len(value) <= 1048576:
            try:
                return json.dumps(
                    redact_telemetry(json.loads(value), depth + 1), ensure_ascii=False
                )
            except (ValueError, RecursionError):
                pass
        value = re.sub(
            r"Bearer\s+\S+|sk-[\w-]{8,}|pk-lf-[\w-]+", "[REDACTED]", value[:16384], flags=re.I
        )
        value = re.sub(r"[^\s@]{1,128}@[^\s@]{1,128}\.[A-Za-z]{2,}", "[EMAIL]", value)
        value = re.sub(r"data:[^;]+;base64,[A-Za-z0-9+/=]+", "[MEDIA]", value)
        return re.sub(r"\b(?:\+?\d[\d ()-]{7,}\d)\b", "[PHONE]", value)[:16384]
    if isinstance(value, dict):
        return {
            str(k): "[REDACTED]" if _SENSITIVE.search(str(k)) else redact_telemetry(v, depth + 1)
            for k, v in list(value.items())[:64]
        }
    if isinstance(value, (tuple, list)):
        return [redact_telemetry(v, depth + 1) for v in value[:64]]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value if value is None or isinstance(value, (bool, int, float)) else None


def pseudonymous_id(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()[:32]


@dataclass(frozen=True)
class TelemetryConfig:
    enabled: bool = False
    base_url: str | None = None
    public_key: str | None = field(default=None, repr=False)
    secret_key: str | None = field(default=None, repr=False)
    environment: str = "synthetic"
    release: str = "python-development"
    capture_content: bool = False
    allow_local_http: bool = False

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> TelemetryConfig:
        env = os.environ if env is None else env
        return cls(
            enabled=env.get("LANGFUSE_ENABLED", "false") == "true",
            base_url=env.get("LANGFUSE_BASE_URL"),
            public_key=env.get("LANGFUSE_PUBLIC_KEY"),
            secret_key=env.get("LANGFUSE_SECRET_KEY"),
            environment=env.get("LANGFUSE_TRACING_ENVIRONMENT", "synthetic"),
            release=env.get("FRAMEWORK_RELEASE", "python-development"),
            capture_content=env.get("LANGFUSE_CAPTURE_CONTENT", "false") == "true",
            allow_local_http=env.get("LANGFUSE_ALLOW_LOCAL_HTTP", "false") == "true",
        )

    def validate(self) -> None:
        if not self.enabled:
            return
        if not self.base_url or not self.public_key or not self.secret_key:
            raise ValueError("Langfuse endpoint and credentials required")
        parsed = urlsplit(self.base_url)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("Invalid Langfuse endpoint")
        local = parsed.hostname in {"127.0.0.1", "localhost", "::1", "langfuse-web"}
        if parsed.scheme != "https" and not (
            parsed.scheme == "http" and local and self.allow_local_http
        ):
            raise ValueError("Explicit local HTTP or TLS required")
        if not parsed.hostname or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,39}", self.environment):
            raise ValueError("Invalid Langfuse environment")
        if self.environment.startswith("langfuse") or not 1 <= len(self.release) <= 200:
            raise ValueError("Invalid Langfuse release")


class _NoObservation:
    trace_id: str | None = None

    def update(self, **kwargs: Any) -> None:
        pass


class _Observation:
    def __init__(self, observation: Any, capture_content: bool) -> None:
        self.observation = observation
        self.capture_content = capture_content

    @property
    def trace_id(self) -> str | None:
        return self.observation.trace_id

    def update(self, **kwargs: Any) -> None:
        if not self.capture_content:
            kwargs.pop("input", None)
            kwargs.pop("output", None)
        self.observation.update(**kwargs)


class FrameworkTelemetry:
    def __init__(self, config: TelemetryConfig | None = None) -> None:
        self.config = config or TelemetryConfig.from_env()
        self.config.validate()
        self.client: Any = None
        self.provider: Any = None
        if self.config.enabled:
            from langfuse import Langfuse
            from opentelemetry.sdk.trace import TracerProvider

            self.provider = TracerProvider()
            self.client = Langfuse(
                base_url=self.config.base_url,
                public_key=self.config.public_key,
                secret_key=self.config.secret_key,
                environment=self.config.environment,
                release=self.config.release,
                timeout=2,
                flush_at=64,
                flush_interval=1,
                mask=lambda **kwargs: redact_telemetry(kwargs.get("data")),
                additional_headers={"x-langfuse-ingestion-version": "4"},
                tracer_provider=self.provider,
                should_export_span=lambda span: span.instrumentation_scope is not None
                and span.instrumentation_scope.name == "langfuse-sdk",
            )

    @contextmanager
    def observation(self, name: str, as_type: str = "span", **kwargs: Any) -> Iterator[Any]:
        if self.client is None:
            yield _NoObservation()
            return
        if not self.config.capture_content:
            kwargs.pop("input", None)
            kwargs.pop("output", None)
        error: BaseException | None = None
        with self.client.start_as_current_observation(
            name=name, as_type=as_type, **kwargs
        ) as observation:
            try:
                yield _Observation(observation, self.config.capture_content)
            except BaseException as caught:
                # Do not let SDK auto-record the original provider exception/body.
                observation.update(level="ERROR", status_message="OPERATION_FAILED")
                error = caught
        if error is not None:
            raise error

    @contextmanager
    def turn(
        self,
        turn_id: str,
        session_id: str = "",
        user_id: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> Iterator[Any]:
        if self.client is None:
            yield _NoObservation()
            return
        from langfuse import propagate_attributes

        with propagate_attributes(
            session_id=pseudonymous_id(session_id), user_id=pseudonymous_id(user_id)
        ):
            with self.observation(
                "turn", metadata={**(metadata or {}), "turnId": pseudonymous_id(turn_id)}
            ) as observation:
                yield observation

    def flush(self) -> bool:
        # SDK flush can swallow exporter failures: experiment callers must additionally
        # use native v3 score readback. force_flush's bool proves the bounded drain only.
        return self.provider.force_flush(timeout_millis=5000) if self.provider else True

    def shutdown(self) -> bool:
        ok = self.flush()
        if self.client:
            self.client.shutdown()
        return ok
