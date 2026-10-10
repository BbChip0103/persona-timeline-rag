"""Trusted process configuration. Connection strings are never represented in logs."""

from __future__ import annotations

import math
import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import urlsplit


class ConfigurationError(ValueError):
    """Allowlisted, credential-free startup error."""


def _url(value: str, schemes: set[str], code: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ConfigurationError(code) from None
    if parsed.scheme not in schemes or not parsed.hostname or parsed.fragment or port == 0:
        raise ConfigurationError(code)
    return value


def _number(env: Mapping[str, str], name: str, default: float, low: float, high: float) -> float:
    try:
        value = float(env.get(name, str(default)))
    except ValueError:
        raise ConfigurationError("INVALID_NUMERIC_CONFIGURATION") from None
    if not math.isfinite(value) or not low <= value <= high:
        raise ConfigurationError("INVALID_NUMERIC_CONFIGURATION")
    return value


@dataclass(frozen=True)
class Settings:
    redis_url: str = field(repr=False)
    backend_url: str = field(repr=False)
    control_token: str = field(repr=False)
    database_url: str = field(repr=False)
    queue_name: str = "turns"
    queue_prefix: str = "ptr"
    concurrency: int = 4
    backend_timeout: float = 1.0
    status_interval: float = 0.5
    lock_duration_ms: int = 30000
    stalled_interval_ms: int = 30000
    max_stalled_count: int = 1
    host: str = "127.0.0.1"
    port: int = 58442

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Settings:
        env = os.environ if env is None else env
        redis_url = _url(
            env.get("PTR_LLM_REDIS_URL", "redis://127.0.0.1:6379/0"),
            {"redis", "rediss"},
            "INVALID_REDIS_URL",
        )
        backend_url = _url(
            env.get("PTR_LLM_BACKEND_URL", "http://127.0.0.1:56441"),
            {"http", "https"},
            "INVALID_BACKEND_URL",
        )
        backend = urlsplit(backend_url)
        if (
            backend.username is not None
            or backend.password is not None
            or "?" in backend_url
            or "#" in backend_url
            or backend.path not in {"", "/"}
        ):
            raise ConfigurationError("INVALID_BACKEND_URL")
        if backend.scheme == "http" and backend.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ConfigurationError("BACKEND_REQUIRES_HTTPS")
        db = _url(
            env.get("PTR_LLM_DATABASE_URL", ""), {"postgresql", "postgres"}, "INVALID_DATABASE_URL"
        )
        allowed = {"127.0.0.1", "localhost", "::1"}
        allowed.update(
            x.strip()
            for x in env.get("PTR_LLM_DATABASE_HOST_ALLOWLIST", "").split(",")
            if x.strip()
        )
        if urlsplit(db).hostname not in allowed:
            raise ConfigurationError("DATABASE_HOST_NOT_ALLOWED")
        token = env.get("PTR_LLM_CONTROL_TOKEN", env.get("PTR_LLM_INTERNAL_TOKEN", ""))
        if len(token) < 24 or len(token) > 512 or any(ord(c) < 33 or ord(c) > 126 for c in token):
            raise ConfigurationError("INVALID_CONTROL_TOKEN")
        name = env.get("PTR_LLM_QUEUE_NAME", "turns")
        prefix = env.get("PTR_LLM_QUEUE_PREFIX", "ptr")
        for value in (name, prefix):
            if (
                not value
                or len(value) > 128
                or any(
                    c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"
                    for c in value
                )
            ):
                raise ConfigurationError("INVALID_QUEUE_KEY")

        def integer(name: str, default: int, low: int, high: int) -> int:
            value = _number(env, name, default, low, high)
            if not value.is_integer():
                raise ConfigurationError("INVALID_NUMERIC_CONFIGURATION")
            return int(value)

        return cls(
            redis_url=redis_url,
            backend_url=backend_url.rstrip("/"),
            database_url=db,
            control_token=token,
            queue_name=name,
            queue_prefix=prefix,
            concurrency=integer("PTR_LLM_CONCURRENCY", 4, 1, 128),
            backend_timeout=_number(env, "PTR_LLM_BACKEND_TIMEOUT_SECONDS", 1, 0.05, 10),
            status_interval=_number(env, "PTR_LLM_STATUS_INTERVAL_SECONDS", 0.5, 0.05, 5),
            lock_duration_ms=integer("PTR_LLM_LOCK_DURATION_MS", 30000, 500, 300000),
            stalled_interval_ms=integer("PTR_LLM_STALLED_INTERVAL_MS", 30000, 100, 300000),
            max_stalled_count=integer("PTR_LLM_MAX_STALLED_COUNT", 1, 0, 10),
            host=env.get("PTR_LLM_HOST", "127.0.0.1"),
            port=integer("PTR_LLM_PORT", 58442, 1024, 65535),
        )
