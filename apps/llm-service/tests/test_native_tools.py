"""Native ToolNode/StructuredTool dispatch stays scoped and callback-private."""

import asyncio
from contextvars import ContextVar
from functools import wraps

import pytest
from langchain_core.tools import StructuredTool
from langgraph.prebuilt import ToolNode

from ptr_llm.core.errors import CoreError


async def test_native_tool_dispatch_and_artifact(monkeypatch):
    from ptr_llm.core.tools import timeline_tool

    node_calls, tool_calls, searches = [], [], []
    node_original, tool_original = ToolNode._afunc, StructuredTool._arun

    @wraps(node_original)
    async def node(self, *args, **kwargs):
        node_calls.append(1)
        return await node_original(self, *args, **kwargs)

    @wraps(tool_original)
    async def tool(self, *args, **kwargs):
        tool_calls.append(1)
        return await tool_original(self, *args, **kwargs)

    monkeypatch.setattr(ToolNode, "_afunc", node)
    monkeypatch.setattr(StructuredTool, "_arun", tool)

    async def search(query):
        searches.append(query)
        return [{"id": "synthetic-source", "caption": "Synthetic private marker"}]

    found = await timeline_tool("synthetic query", search, lambda: None)
    assert found == [{"id": "synthetic-source", "caption": "Synthetic private marker"}]
    assert node_calls == tool_calls == [1] and searches == ["synthetic query"]


@pytest.mark.parametrize("query", [12, True, "", "x" * 501])
async def test_invalid_tool_arguments_never_search(query):
    from ptr_llm.core.tools import timeline_tool

    async def forbidden(*args):
        pytest.fail("invalid query cannot execute")

    with pytest.raises((CoreError, ValueError)):
        await timeline_tool(query, forbidden, lambda: None)


async def test_native_tool_scope_and_ambient_callbacks(monkeypatch):
    import httpx
    import requests
    from langchain_core.callbacks import BaseCallbackHandler
    from langchain_core.runnables.config import var_child_runnable_config
    from langchain_core.tracers.context import collect_runs
    from langsmith import tracing_context

    from ptr_llm.core.tools import timeline_tool

    def blocked(*args, **kwargs):
        raise AssertionError("Synthetic tool privacy probe must stay network-free")

    async def async_blocked(*args, **kwargs):
        return blocked(*args, **kwargs)

    monkeypatch.setattr(requests.Session, "send", blocked)
    monkeypatch.setattr(httpx.AsyncClient, "send", async_blocked)
    exported, calls = [], []

    class Handler(BaseCallbackHandler):
        def on_tool_start(self, *args, **kwargs):
            exported.append("start")

        def on_tool_end(self, *args, **kwargs):
            exported.append("end")

        def on_chain_start(self, *args, **kwargs):
            exported.append("chain")

    independent = ContextVar("application-trace", default=None)
    independent.set("synthetic-redacted-turn")

    async def search(query):
        assert independent.get() == "synthetic-redacted-turn"
        calls.append(query)
        await asyncio.sleep(0)
        return [{"id": query}]

    token = var_child_runnable_config.set(
        {"callbacks": [Handler()], "metadata": {"raw": "private"}}
    )
    try:
        with collect_runs() as traces, tracing_context(enabled=True):
            results = await asyncio.gather(
                *(timeline_tool(str(i), search, lambda: None) for i in range(5))
            )
            assert traces.traced_runs == []
        assert results == [[{"id": str(i)}] for i in range(5)]
        assert not exported and len(calls) == 5
        assert var_child_runnable_config.get()["metadata"] == {"raw": "private"}
    finally:
        var_child_runnable_config.reset(token)


async def test_escaped_surrogate_query_keeps_old_argument_contract():
    from ptr_llm.core.tools import timeline_tool

    calls = []

    async def search(query):
        calls.append(query)
        return []

    assert await timeline_tool("\ud800", search, lambda: None) == []
    assert calls == ["\ud800"]
