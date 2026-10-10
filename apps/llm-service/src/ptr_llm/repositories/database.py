"LLM-schema-only adapters; connection identity is not inferred from a safe URL."

from __future__ import annotations

import asyncio
import re
from typing import Any
from urllib.parse import urlsplit

from ptr_llm.billing import ProviderError


def assert_llm_database_url(url: str) -> None:
    try:
        parsed = urlsplit(url)
        allowed = (
            parsed.scheme in ("postgres", "postgresql")
            and parsed.hostname in ("127.0.0.1", "localhost", "::1")
            and parsed.port == 58432
            and parsed.username in ("ptr_split_llm", "ptr_split_owner")
            and parsed.path in ("/ptr_split_test", "/ptr_split_research")
            and not parsed.query
            and not parsed.fragment
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
