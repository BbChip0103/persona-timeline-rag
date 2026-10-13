"LLM-schema-only adapters; connection identity is not inferred from a safe URL."

from __future__ import annotations

import asyncio
import os
import re
from typing import Any
from urllib.parse import parse_qsl, urlsplit

from ptr_llm.billing import ProviderError

_POSTGRES_SSLMODES = {"require", "verify-ca", "verify-full"}


def _cluster_network() -> bool:
    return os.environ.get("PTR_NETWORK_MODE") == "cluster" and bool(
        os.environ.get("KUBERNETES_SERVICE_HOST")
    )


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


def _database_identity_url(parsed) -> str:
    if not parsed.username or parsed.password is None or not parsed.path or parsed.path == "/":
        raise ValueError
    return f"{_hostport_url(parsed).replace('://', f'://{parsed.username}@', 1)}{parsed.path}"


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


def _cluster_database_allowed(parsed) -> bool:
    try:
        identity = _database_identity_url(parsed)
    except ValueError:
        return False
    allowlist = {
        entry.strip()
        for entry in os.environ.get("PTR_LLM_DATABASE_URL_ALLOWLIST", "").split(",")
        if entry.strip()
    }
    return identity in allowlist


def assert_llm_database_url(url: str) -> None:
    try:
        parsed = urlsplit(url)
        base_allowed = parsed.scheme in ("postgres", "postgresql") and not parsed.fragment
        if _cluster_network():
            ssl_allowed = (
                _only_pg_sslmode(parsed.query)
                if not _svc_host(parsed.hostname)
                else not parsed.query or _only_pg_sslmode(parsed.query)
            )
            allowed = base_allowed and ssl_allowed and _cluster_database_allowed(parsed)
        else:
            allowed = (
                base_allowed
                and parsed.hostname in ("127.0.0.1", "localhost", "::1")
                and parsed.port == 58432
                and parsed.username in ("ptr_split_llm", "ptr_split_owner")
                and parsed.path in ("/ptr_split_test", "/ptr_split_research")
                and not parsed.query
            )
    except ValueError:
        allowed = False
    if not allowed:
        raise ProviderError("UNSAFE_DATABASE_URL")


def assert_llm_pool(pool: Any, database_url: str) -> None:
    assert_llm_database_url(database_url)
    kwargs = getattr(pool, "kwargs", {})
    if (
        getattr(pool, "conninfo", None) != database_url
        or set(kwargs) - {"autocommit", "prepare_threshold", "row_factory", "options"}
        or kwargs.get("options") not in (None, "-c search_path=llm,public")
    ):
        raise ProviderError("UNSAFE_DATABASE_POOL")


class LlmRepository:
    def __init__(self, pool: Any, database_url: str):
        assert_llm_pool(pool, database_url)
        self.pool = pool

    async def fetch(
        self,
        sql: str,
        values: list[Any] | tuple[Any, ...] = (),
        *,
        signal: asyncio.Event | None = None,
        connection: Any = None,
    ) -> list[dict[str, Any]]:
        from psycopg.rows import dict_row

        from ptr_llm.providers.common import check_cancel

        check_cancel(signal)
        # Only converts positional placeholders, never identifiers or interpolated values.
        indexes: list[int] = []

        def replace(match: re.Match[str]) -> str:
            indexes.append(int(match[1]) - 1)
            return "%s"

        statement = re.sub(r"\$(\d+)", replace, sql)
        parameters = tuple(values[i] for i in indexes) if indexes else tuple(values)

        async def execute(conn: Any) -> list[dict[str, Any]]:
            async with conn.cursor(row_factory=dict_row) as cur:
                await cur.execute(statement, parameters)
                rows = await cur.fetchall() if cur.description is not None else []
            check_cancel(signal)
            return rows

        if connection is not None:
            return await execute(connection)
        async with self.pool.connection() as conn:
            return await execute(conn)
