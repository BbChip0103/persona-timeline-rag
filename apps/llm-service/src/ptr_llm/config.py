"""Trusted process configuration. Connection strings are never represented in logs."""

from __future__ import annotations

import math
import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, urlsplit


class ConfigurationError(ValueError):
    """Allowlisted, credential-free startup error."""


_LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}
_POSTGRES_SSLMODES = {"require", "verify-ca", "verify-full"}
_OPENROUTER_ENV_KEYS = ("OPENROUTER_API_KEY", "PTR_OPENROUTER_API_KEY")


def _url(value: str, schemes: set[str], code: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        raise ConfigurationError(code) from None
    if parsed.scheme not in schemes or not parsed.hostname or parsed.fragment or port == 0:
        raise ConfigurationError(code)
    return value


def _cluster_network(env: Mapping[str, str]) -> bool:
    return env.get("PTR_NETWORK_MODE") == "cluster" and bool(env.get("KUBERNETES_SERVICE_HOST"))


def _compose_openrouter_key_present(env: Mapping[str, str]) -> bool:
    return any(name in env for name in _OPENROUTER_ENV_KEYS)


def _svc_host(hostname: str | None) -> bool:
    host = (hostname or "").lower()
    return host.endswith(".svc") or host.endswith(".svc.cluster.local")


def _hostport_url(parsed) -> str:
    if parsed.port is None:
        raise ValueError
    host = (parsed.hostname or "").lower()
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    return f"{parsed.scheme}://{host}:{parsed.port}"


def _redis_identity_url(parsed) -> str:
    base = _hostport_url(parsed)
    if parsed.username:
        return base.replace("://", f"://{parsed.username}@", 1)
    return base


def _database_identity_url(parsed) -> str:
    if not parsed.username or parsed.password is None or not parsed.path or parsed.path == "/":
        raise ValueError
    return f"{_hostport_url(parsed).replace('://', f'://{parsed.username}@', 1)}{parsed.path}"


def _allowlist(env: Mapping[str, str], name: str) -> set[str]:
    return {entry.strip() for entry in env.get(name, "").split(",") if entry.strip()}


def _only_pg_sslmode(query: str) -> bool:
    if not query:
        return False
    try:
        pairs = parse_qsl(query, strict_parsing=True, keep_blank_values=False)
    except ValueError:
        return False
    return (
        len(pairs) == 1
        and pairs[0][0] == "sslmode"
        and pairs[0][1] in _POSTGRES_SSLMODES
    )


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
        cluster_network = _cluster_network(env)
        if (
            not cluster_network
            and _compose_openrouter_key_present(env)
            and not (
                env.get("PTR_LLM_SPILLOVER") == "openrouter"
                and env.get("PTR_LLM_LOCAL_SLOTS") is not None
            )
        ):
            raise ConfigurationError("COMPOSE_OPENROUTER_KEYS_FORBIDDEN")
        if cluster_network:
            try:
                redis_parsed = urlsplit(redis_url)
                redis_id = _redis_identity_url(redis_parsed)
            except ValueError:
                raise ConfigurationError("INVALID_REDIS_URL") from None
            if (
                not redis_parsed.password
                or not re.fullmatch(r"/(?:[0-9]|1[0-5])", redis_parsed.path)
                or redis_parsed.query
                or redis_parsed.fragment
            ):
                raise ConfigurationError("INVALID_REDIS_URL")
            if redis_parsed.scheme == "redis" and not _svc_host(redis_parsed.hostname):
                raise ConfigurationError("INVALID_REDIS_URL")
            redis_allowlist = set()
            for entry in _allowlist(env, "PTR_LLM_REDIS_URL_ALLOWLIST"):
                try:
                    allowed = urlsplit(entry)
                    if (
                        allowed.scheme in {"redis", "rediss"}
                        and allowed.password is None
                        and allowed.path in {"", "/"}
                        and not allowed.query
                        and not allowed.fragment
                        and allowed.port is not None
                    ):
                        redis_allowlist.add(_redis_identity_url(allowed))
                except ValueError:
                    pass
            if redis_id not in redis_allowlist:
                raise ConfigurationError("REDIS_URL_NOT_ALLOWED")
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
        if cluster_network:
            try:
                backend_id = _hostport_url(backend)
            except ValueError:
                raise ConfigurationError("INVALID_BACKEND_URL") from None
            if backend_id not in _allowlist(env, "PTR_LLM_BACKEND_URL_ALLOWLIST"):
                raise ConfigurationError("BACKEND_URL_NOT_ALLOWED")
            if backend.scheme == "http" and not _svc_host(backend.hostname):
                raise ConfigurationError("BACKEND_REQUIRES_HTTPS")
        elif backend.scheme == "http" and backend.hostname not in _LOOPBACK_HOSTS:
            raise ConfigurationError("BACKEND_REQUIRES_HTTPS")
        db = _url(
            env.get("PTR_LLM_DATABASE_URL", ""), {"postgresql", "postgres"}, "INVALID_DATABASE_URL"
        )
        db_parsed = urlsplit(db)
        if cluster_network:
            if (
                not _svc_host(db_parsed.hostname)
                and not _only_pg_sslmode(db_parsed.query)
            ) or (
                _svc_host(db_parsed.hostname)
                and db_parsed.query
                and not _only_pg_sslmode(db_parsed.query)
            ):
                raise ConfigurationError("INVALID_DATABASE_URL")
            try:
                db_id = _database_identity_url(db_parsed)
            except ValueError:
                raise ConfigurationError("INVALID_DATABASE_URL") from None
            if db_id not in _allowlist(env, "PTR_LLM_DATABASE_URL_ALLOWLIST"):
                raise ConfigurationError("DATABASE_URL_NOT_ALLOWED")
        else:
            allowed_hosts = set(_LOOPBACK_HOSTS)
            allowed_hosts.update(
                x.strip()
                for x in env.get("PTR_LLM_DATABASE_HOST_ALLOWLIST", "").split(",")
                if x.strip()
            )
            if db_parsed.hostname not in allowed_hosts:
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
