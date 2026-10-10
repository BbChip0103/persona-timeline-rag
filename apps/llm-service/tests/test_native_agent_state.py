"""Typed native reducer channels retain the existing JSON-action wire contract."""

import asyncio

from core_cache_test import ConcurrentProvider
from core_domain_test import SOURCE, Personas, Retrieval, grant, noop
from langgraph.channels import BinaryOperatorAggregate

from ptr_llm.core.agent import _AGENT_GRAPH
from ptr_llm.core.runtime import LLMEngine


async def test_native_agent_channels_and_partial_updates():
    assert "run" not in _AGENT_GRAPH.channels
    for key in (
        "steps",
        "transcript",
        "called",
        "upstreams",
        "modelCalls",
        "toolCalls",
        "iteration",
    ):
        assert isinstance(_AGENT_GRAPH.channels[key], BinaryOperatorAggregate)
    engine = LLMEngine(
        provider=ConcurrentProvider(), personas=Personas(), retrieval=Retrieval([SOURCE])
    )
    request = grant("Tell me about your sky post.", retrievalMode="lexical", ragCondition="caption")
    request["context"]["turn"]["id"] = "synthetic-cache-tool-native"
    result = await engine.handle(request, before_costly=noop, cancelled=asyncio.Event())
    assert result["kind"] == "completed"
    agent = result["reply"]["agent"]
    assert agent["modelCalls"] == 3 and agent["toolCalls"] == 2
    assert [(s["phase"], s["iteration"]) for s in agent["steps"]] == [
        ("context", 0),
        ("model", 0),
        ("tool", 0),
        ("context", 1),
        ("model", 1),
        ("tool", 1),
        ("context", 2),
        ("model", 2),
        ("validation", 2),
    ]
