"""Synthetic reference agent loop prompt and caption/image binding regressions; no model calls."""

import asyncio
import copy

import pytest
from core_domain_test import SOURCE, Personas, Provider, Retrieval, grant, noop, response

from ptr_llm.core.runtime import LLMEngine


def source_with_image():
    source = copy.deepcopy(SOURCE)
    source["imageAnnotations"] = [
        {
            "id": "synthetic-image",
            "imageHash": "synthetic-image-hash",
            "annotationHash": "synthetic-annotation-hash",
            "revision": "v1",
            "text": "A blue sky above synthetic trees.",
            "model": "synthetic",
            "humanReviewed": False,
        }
    ]
    return source


async def run_reply(refs, condition="caption_image"):
    source = source_with_image()
    provider = Provider([response("That synthetic blue sky!", refs=refs)])
    result = await LLMEngine(
        provider=provider, personas=Personas(), retrieval=Retrieval([source])
    ).handle(
        grant("Tell me about your sky post.", retrievalMode="lexical", ragCondition=condition),
        before_costly=noop,
        cancelled=asyncio.Event(),
    )
    assert result["kind"] == "completed"
    assert len(provider.messages) == 1
    assert result["reply"]["agent"]["promptRevision"] == (
        "character-agent-context-v18-speech-register"
    )
    return result["reply"], provider.messages[0]


@pytest.mark.parametrize("condition", ["off", "caption", "caption_image"])
async def test_actual_agent_loop_prompt_teaches_caption_and_image_reference_origins(condition):
    _, messages = await run_reply([], condition)
    policy = messages[0]["content"]
    assert "AGENT_JSON_REPLY" in policy
    assert "Omit annotationId for caption quotes" in policy
    assert "exact parent sourceId and annotationId for AI image annotation quotes" in policy
    assert "Never attach an image annotationId to a caption quote" in policy
    assert "quote must come from that referenced annotation" in policy


@pytest.mark.parametrize("origin", ["caption", "image", "caption_with_image_id"])
async def test_actual_agent_loop_reply_keeps_origin_binding_fail_closed(origin):
    source = source_with_image()
    ref = {"sourceId": source["id"], "quote": "I painted a blue sky."}
    if origin != "caption":
        ref["annotationId"] = source["imageAnnotations"][0]["id"]
    if origin == "image":
        ref["quote"] = source["imageAnnotations"][0]["text"]
    reply, _ = await run_reply([ref])
    if origin == "caption_with_image_id":
        assert reply["grounding"] == "unverified_model"
        assert reply["evidence"] == []
        assert reply["claims"] == []
        assert "INVALID_MODEL_EVIDENCE" in reply["limitations"]
    else:
        assert reply["grounding"] == "source_bound_quotes"
        assert len(reply["evidence"]) == 1
        bound = reply["claims"][0]["evidenceRefs"][0]
        assert bound["sourceId"] == ref["sourceId"]
        assert bound.get("annotationId") == ref.get("annotationId")
        assert bound["quote"] == ref["quote"]
