"A detached, one-node LangGraph saves only a costly model receipt, never outer turns."

from __future__ import annotations

import asyncio
import hashlib
import weakref
from dataclasses import dataclass
from typing import Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime

from ptr_llm.billing import ProviderError

from .common import check_cancel, checked_text, fingerprint


class CallState(TypedDict, total=False):
    fingerprint: str
    receipt: dict[str, Any] | None


@dataclass(frozen=True)
class CallContext:
    """Ephemeral invocation parameters, excluded from checkpoint channels."""

    fingerprint: str
    messages: list[dict[str, str]]
    request_key: str | None
    signal: asyncio.Event | None
    options: dict[str, Any]


_LOCKS: weakref.WeakValueDictionary[str, asyncio.Lock] = weakref.WeakValueDictionary()


class CheckpointedTextProvider:
    def __init__(self, provider: Any, checkpointer: Any):
        self.provider, self.checkpointer = provider, checkpointer
        builder = StateGraph(CallState, context_schema=CallContext)
        builder.add_node("model_call", self._call)
        builder.add_edge(START, "model_call")
        builder.add_edge("model_call", END)
        self._graph = builder.compile(checkpointer=checkpointer)

    async def _call(self, state: CallState, runtime: Runtime[CallContext]) -> CallState:
        context = runtime.context
        if state.get("fingerprint") != context.fingerprint:
            raise ProviderError("CHECKPOINT_MISMATCH")
        usage, upstream = {"promptTokens": None, "completionTokens": None}, None

        def used(value: Any) -> None:
            nonlocal usage
            usage = value

        def served(value: str) -> None:
            nonlocal upstream
            upstream = value

        text = await self.provider.generate(
            context.messages,
            request_key=context.request_key,
            signal=context.signal,
            on_usage=used,
            on_served=served,
            **context.options,
        )
        check_cancel(context.signal)
        return {
            "receipt": {"text": checked_text(text), "usage": usage, "upstream": upstream},
            "fingerprint": context.fingerprint,
        }

    async def aclose(self) -> None:
        close = getattr(self.provider, "aclose", None)
        if close is not None:
            await close()

    def request_fingerprint(
        self, messages: list[dict[str, str]], request_key: str | None = None
    ) -> str:
        method = getattr(self.provider, "request_fingerprint", None)
        return (
            method(messages, request_key)
            if method
            else fingerprint(
                {"revision": "python-fake-call-v1", "messages": messages, "requestKey": request_key}
            )
        )

    async def generate(
        self,
        messages: list[dict[str, str]],
        *,
        request_key: str | None = None,
        signal: asyncio.Event | None = None,
        on_usage: Any = None,
        on_served: Any = None,
        **options: Any,
    ) -> str:
        from langchain_core.runnables.config import RunnableConfig, var_child_runnable_config

        check_cancel(signal)
        fp = self.request_fingerprint(messages, request_key)
        scope = hashlib.sha256((request_key or "").encode()).hexdigest()
        thread_id = f"python-call-v1:{scope}:{fp}"
        config: RunnableConfig = {"configurable": {"thread_id": thread_id, "checkpoint_ns": ""}}

        # Runtime context belongs to this invocation only, including on resume;
        # the shared compiled graph never captures a request/grant/cancel signal.
        context = CallContext(fp, messages, request_key, signal, options)
        graph = self._graph
        lock = _LOCKS.setdefault(thread_id, asyncio.Lock())
        # Only LC's ambient graph config is detached; independent OTel context remains intact.
        token = var_child_runnable_config.set(None)
        try:
            async with lock:
                saved = await graph.aget_state(config)
                values = saved.values or {}
                if values and values.get("fingerprint") != fp:
                    raise ProviderError("CHECKPOINT_MISMATCH")
                receipt = values.get("receipt")
                if receipt is None:
                    initial: CallState | None = (
                        None if values else {"fingerprint": fp, "receipt": None}
                    )
                    # Only the detached call exit is saved; its final receipt write
                    # is awaited before success. Nonbillable mid-call crashes may rerun.
                    # Existing pending sync/exit calls resume without another start.
                    from ptr_llm.core.langchain import private_ainvoke

                    result = await private_ainvoke(
                        graph,
                        initial,
                        config,
                        context=context,
                        durability="exit",
                    )
                    receipt = result.get("receipt")
                if not isinstance(receipt, dict) or not isinstance(receipt.get("usage"), dict):
                    raise ProviderError("INVALID_PROVIDER_RESPONSE")
                text = checked_text(receipt.get("text"))
                check_cancel(signal)
                if on_usage:
                    on_usage(receipt["usage"])
                if on_served and isinstance(receipt.get("upstream"), str):
                    on_served(receipt["upstream"])
                return text
        finally:
            var_child_runnable_config.reset(token)


async def setup_call_checkpoints(owner_database_url: str) -> None:
    """Migration-owner CLI only: never called implicitly by worker boot."""
    from urllib.parse import urlsplit

    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from psycopg import AsyncConnection
    from psycopg.rows import dict_row

    from ptr_llm.repositories.database import assert_llm_database_url

    assert_llm_database_url(owner_database_url)
    if urlsplit(owner_database_url).username != "ptr_split_owner":
        raise ProviderError("CHECKPOINT_SETUP_REQUIRES_OWNER")
    async with await AsyncConnection.connect(
        owner_database_url, autocommit=True, prepare_threshold=0, row_factory=dict_row
    ) as conn:
        identity = await (
            await conn.execute("SELECT current_user AS role,current_database() AS db")
        ).fetchone()
        if (
            identity is None
            or identity["role"] != "ptr_split_owner"
            or identity["db"] != urlsplit(owner_database_url).path.lstrip("/")
        ):
            raise ProviderError("CHECKPOINT_SETUP_REQUIRES_OWNER")
        await conn.execute("SET search_path TO llm,public")
        await AsyncPostgresSaver(conn).setup()
