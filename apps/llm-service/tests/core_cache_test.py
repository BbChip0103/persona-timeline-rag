"""Compiled outer/agent graphs never capture a first request or persist cheap state."""

import asyncio
import copy
from collections import Counter
from contextlib import contextmanager
from contextvars import ContextVar

from core_domain_test import SOURCE, Personas, Retrieval, grant, noop, response
from langgraph.graph import StateGraph

from ptr_llm.core.runtime import LLMEngine


class Trace:
    def __init__(self):
        self.current = ContextVar("synthetic-cache-trace")
        self.events = []

    @contextmanager
    def turn(self, *, turn_id, **kwargs):
        token = self.current.set(turn_id)
        try:
            yield
        finally:
            self.current.reset(token)

    @contextmanager
    def observation(self, name, **kwargs):
        self.events.append((self.current.get(), name, kwargs.get("metadata", {})))
        yield


class ConcurrentProvider:
    def __init__(self, cancelled=None):
        self.calls = Counter()
        self.options = []
        self.cancelled = cancelled

    async def generate(self, messages, **options):
        key = options["request_key"]
        iteration = self.calls[key]
        self.calls[key] += 1
        self.options.append((key, options["deadline_at"], options["signal"]))
        await asyncio.sleep(0.002)
        if key == "synthetic-cache-cancel" and self.cancelled:
            self.cancelled.set()
        options["on_served"]("primary")
        if "tool" in key and iteration < 2:
            return response("", function=("blue sky" if iteration == 0 else "painted sky"))
        return response(
            "Hello from " + key + "!", updates={"conversationTopic": key, "tone": "warm"}
        )


async def test_shared_graph_concurrent_tools_cancel_trace_and_grant_isolation():
    cancelled = asyncio.Event()
    provider, telemetry, guards = ConcurrentProvider(cancelled), Trace(), Counter()
    engine = LLMEngine(
        provider=provider, personas=Personas(), retrieval=Retrieval([SOURCE]), telemetry=telemetry
    )
    originals = []

    async def run(i):
        key = "synthetic-cache-cancel" if i == 0 else "synthetic-cache-tool-" + str(i)
        g = grant("Tell me about your sky post.", retrievalMode="lexical", ragCondition="caption")
        g["context"]["turn"]["id"] = key
        g["context"]["session"]["id"] = "synthetic-session-" + str(i)
        g["deadlineAt"] += i
        untouched = copy.deepcopy(g)
        signal = cancelled if i == 0 else asyncio.Event()

        async def guard():
            guards[key] += 1

        result = await engine.handle(g, before_costly=guard, cancelled=signal)
        assert g == untouched
        originals.append((key, g["deadlineAt"], signal))
        return key, result

    results = dict(await asyncio.gather(*(run(i) for i in range(12))))
    assert results["synthetic-cache-cancel"] == {"kind": "failed", "errorCode": "TURN_ABORTED"}
    for key, result in results.items():
        if key == "synthetic-cache-cancel":
            continue
        assert result["kind"] == "completed"
        reply = result["reply"]
        assert reply["agent"]["modelCalls"] == 3 and reply["agent"]["toolCalls"] == 2
        assert reply["agent"]["variables"]["conversationTopic"] == key
        assert guards[key] == 3 and provider.calls[key] == 3
        stages = [(name, meta) for turn, name, meta in telemetry.events if turn == key]
        assert [meta["iteration"] for name, meta in stages if name == "agent-generate"] == [0, 1, 2]
        assert sum(name == "agent-tool" for name, _ in stages) == 2
        assert sum(name == "output_guard" for name, _ in stages) == 1
    for key, deadline, signal in provider.options:
        assert (key, deadline, signal) in originals


async def test_graphs_reuse_compilation_and_remain_without_saver(monkeypatch):
    provider = ConcurrentProvider()
    engine = LLMEngine(provider=provider, personas=Personas())
    # Warm the actual agent path before recording additional per-request compiles.
    assert (await engine.handle(grant(), before_costly=noop, cancelled=asyncio.Event()))[
        "kind"
    ] == ("completed")
    from ptr_llm.core.agent import _AGENT_GRAPH

    assert engine._turn_graph.checkpointer is None and _AGENT_GRAPH.checkpointer is None
    original = StateGraph.compile
    compiled = []

    def record(self, *args, **kwargs):
        graph = original(self, *args, **kwargs)
        assert graph.checkpointer is None
        compiled.append(graph)
        return graph

    monkeypatch.setattr(StateGraph, "compile", record)
    await asyncio.gather(
        *(engine.handle(grant(), before_costly=noop, cancelled=asyncio.Event()) for _ in range(4))
    )
    assert compiled == []
