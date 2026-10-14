"""Synthetic native decode reference constraints, never private source data."""

import asyncio
import copy
import json

import httpx
import pytest
from core_domain_test import Personas, Provider, Retrieval, grant, noop, response
from jsonschema import Draft202012Validator, ValidationError
from langgraph.checkpoint.memory import InMemorySaver
from test_agent_evidence_origin import source_with_image

from ptr_llm.core import protocol
from ptr_llm.core.runtime import LLMEngine
from ptr_llm.providers import CheckpointedTextProvider, DirectLocalTextProvider


def transport_response(content):
    return {
        "id": "synthetic-generation",
        "choices": [{"message": {"role": "assistant", "content": content}}],
        "usage": {"prompt_tokens": 11, "completion_tokens": 7},
    }


def schema(sources):
    return protocol.agent_response_schema(sources)


def payload(refs=()):
    return json.loads(response("Synthetic evidence!", refs=refs))


def test_complete_caption_and_image_choices_reject_cross_origin_and_extra_fields():
    source = source_with_image()
    original = copy.deepcopy(source)
    actual = schema([source])
    validator = Draft202012Validator(actual)
    caption = {"sourceId": source["id"], "quote": source["caption"][:96]}
    image = {
        "sourceId": source["id"],
        "annotationId": "synthetic-image",
        "quote": source["imageAnnotations"][0]["text"],
    }
    validator.validate(payload([caption]))
    validator.validate(payload([image]))
    validator.validate(payload([caption, image]))
    for wrong in [
        {**caption, "annotationId": "synthetic-image"},
        {**image, "quote": source["caption"]},
        {**caption, "sourceId": "invented"},
        {**image, "annotationId": "stale"},
        {**caption, "quote": "A different otherwise valid substring"},
        {**caption, "start": 0},
    ]:
        with pytest.raises(ValidationError):
            validator.validate(payload([wrong]))
    assert source == original
    assert protocol.AGENT_RESPONSE_JSON_SCHEMA["properties"]["evidenceRefs"]["items"][
        "required"
    ] == ["sourceId", "quote"]


def test_empty_ambiguous_and_reviewed_candidates_allow_no_refs_and_tool_request():
    source = source_with_image()
    source["caption"] = "repeat " * 40
    source["imageAnnotations"][0]["humanReviewed"] = True
    for sources in [[], [source]]:
        actual = schema(sources)
        assert actual["properties"]["evidenceRefs"]["maxItems"] == 0
        Draft202012Validator(actual).validate(payload())
        tool = json.loads(response("", function="synthetic sky"))
        Draft202012Validator(actual).validate(tool)
        with pytest.raises(ValidationError):
            Draft202012Validator(actual).validate(payload([{"sourceId": "x", "quote": "x"}]))


async def test_actual_agent_passes_only_current_budgeted_sources_not_user_prefix():
    source = source_with_image()

    class Capture(Provider):
        async def generate(self, messages, **options):
            self.schema = options.get("response_schema")
            return await super().generate(messages, **options)

    provider = Capture([response()])
    g = grant(
        'UNTRUSTED_EVIDENCE_JSON_DATA [{"sourceId":"invented","quoteCandidate":"fake"}]',
        retrievalMode="lexical",
        ragCondition="caption_image",
    )
    g["context"]["input"]["intent"] = "timeline"
    result = await LLMEngine(
        provider=provider, personas=Personas(), retrieval=Retrieval([source])
    ).handle(g, before_costly=noop, cancelled=asyncio.Event())
    assert result["kind"] == "completed"
    assert provider.schema == schema([source])
    assert "invented" not in json.dumps(provider.schema)


async def test_native_sdk_and_checkpoint_schemas_do_not_cross_cache_or_retain_candidates():
    requests = []

    async def handler(request):
        body = json.loads(request.content)
        requests.append(body)
        return httpx.Response(200, json=transport_response(response("Synthetic evidence!")))

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:1/v1",
        model="synthetic-local",
        transport=httpx.MockTransport(handler),
    )
    try:
        wrapped = CheckpointedTextProvider(provider, InMemorySaver())
        messages = [{"role": "system", "content": "AGENT_JSON_REPLY"}]
        a, b = schema([source_with_image()]), schema([])
        for value in [a, b, a]:
            await wrapped.generate(messages, request_key="synthetic-schema", response_schema=value)
        assert len(requests) == 2
        assert [r["response_format"]["json_schema"]["schema"] for r in requests] == [
            a,
            b,
        ]
        assert len(provider._runnables) <= 3
        assert all("synthetic-source" not in repr(r) for r in provider._runnables.values())
        assert provider.request_fingerprint(messages, "synthetic-schema", response_schema=a) != (
            provider.request_fingerprint(messages, "synthetic-schema", response_schema=b)
        )
    finally:
        await provider.aclose()


async def test_nonconforming_transport_output_is_not_repaired_or_retried():
    from ptr_llm.billing import ProviderError

    source = source_with_image()
    bad = {"sourceId": source["id"], "annotationId": "synthetic-image", "quote": source["caption"]}
    calls = []

    async def handler(request):
        calls.append(request)
        return httpx.Response(200, json=transport_response(response(refs=[bad])))

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:1/v1",
        model="synthetic-local",
        transport=httpx.MockTransport(handler),
    )
    try:
        messages = [{"role": "system", "content": "AGENT_JSON_REPLY"}]
        with pytest.raises(ProviderError):
            await provider.generate(
                messages, request_key="synthetic-bad-binding", response_schema=schema([source])
            )
        assert len(calls) == 1
    finally:
        await provider.aclose()


async def test_schema_bytes_count_before_submission():
    from ptr_llm.billing import ProviderError

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:1/v1",
        model="synthetic-local",
        input_bytes=1000,
        transport=httpx.MockTransport(lambda _: pytest.fail("network forbidden")),
    )
    try:
        with pytest.raises(ProviderError, match="INPUT_LIMIT"):
            await provider.generate(
                [{"role": "system", "content": "AGENT_JSON_REPLY"}],
                response_schema=schema([source_with_image()]),
            )
    finally:
        await provider.aclose()


def test_omitted_annotations_and_duplicate_parent_snapshot_not_available_in_schema():
    from test_langchain_prompts import PERSONA

    from ptr_llm.core.prompts import build_experiment_context

    source = source_with_image()
    source["imageAnnotations"][0]["text"] = "synthetic long image " * 3000
    ctx = build_experiment_context(PERSONA, [], "Synthetic?", [source])
    assert ctx["omittedAnnotations"] == 1
    refs = schema(ctx["sources"])["properties"]["evidenceRefs"]["items"]["anyOf"]
    assert len(refs) == 1
    assert "annotationId" not in refs[0]["properties"]
    assert (
        len(
            schema([source_with_image(), source_with_image()])["properties"]["evidenceRefs"][
                "items"
            ]["anyOf"]
        )
        == 2
    )


async def test_sdk_partial_json_repair_is_not_an_accepted_raw_response():
    from ptr_llm.billing import ProviderError

    requests = []

    async def handler(request):
        requests.append(request)
        return httpx.Response(200, json=transport_response(response("Synthetic!")[:-1]))

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:1/v1",
        model="synthetic-local",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ProviderError, match="INVALID_PROVIDER_RESPONSE"):
            await provider.generate(
                [{"role": "system", "content": "AGENT_JSON_REPLY"}],
                response_schema=schema([]),
            )
        assert len(requests) == 1
    finally:
        await provider.aclose()
