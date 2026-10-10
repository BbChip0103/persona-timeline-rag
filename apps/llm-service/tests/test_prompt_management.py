"""Pinned, generic-only Langfuse policy fetches with network-free SDK fixtures."""

import asyncio
import importlib
import json
import threading
from contextlib import contextmanager
from dataclasses import FrozenInstanceError, replace
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock

import httpx
import pytest
from langfuse import Langfuse
from langfuse.api.client import LangfuseAPI
from langfuse.api.prompts.types.prompt import Prompt_Text
from langfuse.model import TextPromptClient

from ptr_llm.billing import ProviderError
from ptr_llm.core.prompts import build_experiment_context, build_prompt
from ptr_llm.prompt_management import (
    LOCAL_POLICY_SHA256,
    LOCAL_POLICY_TEXT,
    PromptManagementConfig,
    applied_prompt,
    current_prompt_snapshot,
    load_prompt_snapshot,
    prompt_scope,
)
from ptr_llm.runtime import ObservedProvider, Runtime
from ptr_llm.telemetry import FrameworkTelemetry, TelemetryConfig

PERSONA = {
    "id": "synthetic",
    "revision": "synthetic-v1",
    "reviewStatus": "synthetic",
    "language": "ko",
    "identity": "Synthetic {identity} 😁",
    "concept": "fictional",
    "style": ["{style}"],
    "boundaries": ["not factual"],
}
PRIVATE_TEXT = "synthetic-private-content {untrusted}"


@pytest.fixture(autouse=True)
def unit_sdk_mock_bridge(monkeypatch):
    """Unit-only SDK mocks; actual transport tests below use the real bridge."""
    import ptr_llm.prompt_management as module

    approved, sdk = module._approved_endpoint, module._read_only_sdk
    monkeypatch.setattr(
        module,
        "_approved_endpoint",
        lambda client: client if isinstance(client, Mock) else approved(client),
    )
    monkeypatch.setattr(
        module,
        "_read_only_sdk",
        lambda endpoint, transport: (
            endpoint if isinstance(endpoint, Mock) else sdk(endpoint, transport)
        ),
    )


def config(**changes):
    return replace(
        PromptManagementConfig(
            mode="langfuse",
            name="generic-policy",
            version=7,
            approved_sha256=LOCAL_POLICY_SHA256,
            fetch_timeout_seconds=1,
        ),
        **changes,
    )


def sdk_prompt(**changes):
    return TextPromptClient(
        Prompt_Text(
            **{
                "name": "generic-policy",
                "version": 7,
                "prompt": LOCAL_POLICY_TEXT,
                "config": {},
                "labels": [],
                "tags": [],
                **changes,
            }
        )
    )


async def managed(client=None):
    client = client or Mock(spec=Langfuse)
    client.get_prompt.return_value = sdk_prompt()
    return await load_prompt_snapshot(config(), client), client


async def test_local_default_offline_and_explicit_mapping_do_not_fetch(monkeypatch):
    monkeypatch.setenv("PTR_LLM_PROMPT_MANAGEMENT", "langfuse")
    client = Mock(spec=Langfuse)
    snapshot = await load_prompt_snapshot(PromptManagementConfig.from_env({}), client)
    assert snapshot.source == "local"
    assert snapshot.reason == "offline"
    assert snapshot.sha256 == LOCAL_POLICY_SHA256
    client.get_prompt.assert_not_called()


async def test_native_sdk_fetch_is_exact_pinned_bounded_and_startup_only():
    main_thread = threading.get_ident()
    threads = []
    client = Mock(spec=Langfuse)
    prompt = sdk_prompt()

    def fetch(*args, **kwargs):
        threads.append(threading.get_ident())
        return prompt

    client.get_prompt.side_effect = fetch
    snapshot = await load_prompt_snapshot(config(), client)
    client.get_prompt.assert_called_once_with(
        "generic-policy",
        version=7,
        type="text",
        cache_ttl_seconds=0,
        max_retries=0,
        fetch_timeout_seconds=1,
    )
    assert threads != [main_thread]
    assert snapshot.sdk_prompt is prompt
    assert snapshot.source == "langfuse" and snapshot.reason == "verified"
    assert snapshot.sha256 == LOCAL_POLICY_SHA256
    for _ in range(3):
        with prompt_scope(snapshot):
            build_experiment_context(PERSONA, [], PRIVATE_TEXT, [])
            build_prompt(PERSONA, [], PRIVATE_TEXT, [], False)
    assert client.get_prompt.call_count == 1


async def test_snapshot_configuration_and_policy_are_immutable():
    snapshot, _ = await managed()
    with pytest.raises(FrozenInstanceError):
        snapshot.source = "local"
    with pytest.raises(TypeError):
        snapshot.experiment["EXPERIMENT_POLICY"] = "changed"


@pytest.mark.parametrize(
    "changes,reason",
    [
        ({"prompt": LOCAL_POLICY_TEXT + " "}, "content_mismatch"),
        ({"prompt": PRIVATE_TEXT}, "content_mismatch"),
        ({"prompt": "\ud800"}, "content_mismatch"),
        ({"version": 8}, "version_mismatch"),
        ({"name": "other-policy"}, "name_mismatch"),
    ],
)
async def test_remote_mismatch_falls_back_exactly_with_safe_provenance(changes, reason):
    client = Mock(spec=Langfuse)
    client.get_prompt.return_value = sdk_prompt(**changes)
    snapshot = await load_prompt_snapshot(config(), client)
    assert snapshot.source == "local" and snapshot.reason == reason
    assert snapshot.sdk_prompt is None
    assert "promptVersion" not in snapshot.metadata()
    assert snapshot.metadata()["promptRequestedVersion"] == 7
    assert snapshot.experiment == json.loads(LOCAL_POLICY_TEXT)["experiment"]
    assert PRIVATE_TEXT not in json.dumps(snapshot.metadata())
    with prompt_scope(snapshot):
        actual = build_experiment_context(PERSONA, [], PRIVATE_TEXT, [])
    assert actual == build_experiment_context(PERSONA, [], PRIVATE_TEXT, [])


async def test_sdk_fallback_is_not_mislabeled_as_managed():
    client = Mock(spec=Langfuse)
    prompt = sdk_prompt()
    prompt.is_fallback = True
    client.get_prompt.return_value = prompt
    snapshot = await load_prompt_snapshot(config(), client)
    assert snapshot.reason == "sdk_fallback" and snapshot.sdk_prompt is None


async def test_unavailable_client_and_fetch_exception_are_explicit_safe_local_fallbacks():
    snapshot = await load_prompt_snapshot(config(), None)
    assert snapshot.reason == "client_disabled"
    client = Mock(spec=Langfuse)
    client.get_prompt.side_effect = RuntimeError(PRIVATE_TEXT)
    snapshot = await load_prompt_snapshot(config(), client)
    assert snapshot.reason == "unavailable" and snapshot.source == "local"
    assert PRIVATE_TEXT not in repr(snapshot) + json.dumps(snapshot.metadata())
    client.get_prompt.assert_called_once()


@pytest.mark.parametrize(
    "env",
    [
        {"PTR_LLM_PROMPT_MANAGEMENT": "latest"},
        {"PTR_LLM_PROMPT_MANAGEMENT": "langfuse"},
        {
            "PTR_LLM_PROMPT_MANAGEMENT": "langfuse",
            "PTR_LLM_PROMPT_NAME": "generic-policy",
            "PTR_LLM_PROMPT_VERSION": "0",
            "PTR_LLM_PROMPT_SHA256": LOCAL_POLICY_SHA256,
        },
        {
            "PTR_LLM_PROMPT_MANAGEMENT": "langfuse",
            "PTR_LLM_PROMPT_NAME": "generic-policy",
            "PTR_LLM_PROMPT_VERSION": "7",
            "PTR_LLM_PROMPT_SHA256": "0" * 64,
        },
        {
            "PTR_LLM_PROMPT_MANAGEMENT": "langfuse",
            "PTR_LLM_PROMPT_NAME": "generic-policy",
            "PTR_LLM_PROMPT_VERSION": "7",
            "PTR_LLM_PROMPT_SHA256": LOCAL_POLICY_SHA256,
            "PTR_LLM_PROMPT_FETCH_TIMEOUT_SECONDS": "30",
        },
    ],
)
def test_unpinned_or_unapproved_configuration_fails_closed(env):
    with pytest.raises(ProviderError, match="INVALID_RUNTIME_CONFIG"):
        PromptManagementConfig.from_env(env)


async def test_nested_and_concurrent_scopes_do_not_leak_between_runtimes():
    remote, _ = await managed()
    local = await load_prompt_snapshot(PromptManagementConfig(), None)
    original = current_prompt_snapshot()

    async def run(snapshot):
        with prompt_scope(snapshot):
            await asyncio.sleep(0)
            assert current_prompt_snapshot() is snapshot
            with prompt_scope(local):
                assert current_prompt_snapshot() is local
            assert current_prompt_snapshot() is snapshot
            return current_prompt_snapshot().source

    assert await asyncio.gather(run(remote), run(local)) == ["langfuse", "local"]
    assert current_prompt_snapshot() is original


async def test_generation_native_prompt_association_exports_no_raw_variables_or_messages():
    snapshot, client = await managed()
    telemetry = FrameworkTelemetry(TelemetryConfig(capture_content=False))
    span = Mock()
    starts = []

    @contextmanager
    def observation(**values):
        starts.append(values)
        yield span

    client.start_as_current_observation.side_effect = observation
    telemetry.client = client
    provider = Mock()

    async def generate(messages, **options):
        options["on_usage"]({"promptTokens": 3, "completionTokens": 2})
        return PRIVATE_TEXT

    provider.generate = generate
    observed = ObservedProvider(provider, telemetry, "synthetic-model", prompts=snapshot)
    with prompt_scope(snapshot):
        messages = build_experiment_context(PERSONA, [], PRIVATE_TEXT, [])["messages"]
        assert await observed.generate(messages) == PRIVATE_TEXT
    assert starts[0]["prompt"] is snapshot.sdk_prompt
    assert starts[0]["metadata"]["promptVersion"] == 7
    assert starts[0]["metadata"]["promptSource"] == "langfuse"
    assert "input" not in starts[0] and "output" not in starts[0]
    assert PRIVATE_TEXT not in repr(starts) + repr(span.update.call_args_list)
    assert client.get_prompt.call_count == 1
    from langfuse._client.attributes import create_generation_attributes

    attributes = create_generation_attributes(
        prompt=snapshot.sdk_prompt, metadata=snapshot.metadata(), model="synthetic-model"
    )
    assert LOCAL_POLICY_TEXT not in json.dumps(attributes)
    assert PRIVATE_TEXT not in json.dumps(attributes)
    assert 7 in attributes.values() and "generic-policy" in attributes.values()


async def test_scoped_runtime_errors_drafts_and_unmanaged_generation_do_not_leak_association():
    snapshot, _ = await managed()
    original = current_prompt_snapshot()

    class Engine:
        async def handle(self, grant, **options):
            assert current_prompt_snapshot() is snapshot
            raise RuntimeError("synthetic-error")

        async def draft(self, body):
            assert current_prompt_snapshot() is snapshot
            return {"synthetic": True}

    runtime = Runtime(None, None, Engine(), None, None, None, "fake", "synthetic", prompts=snapshot)
    with pytest.raises(RuntimeError, match="synthetic-error"):
        await runtime.handle({})
    assert await runtime.draft({}) == {"synthetic": True}
    assert current_prompt_snapshot() is original
    telemetry = Mock()
    span = Mock()

    @contextmanager
    def observation(*args, **kwargs):
        assert "prompt" not in kwargs
        yield span

    telemetry.observation.side_effect = observation

    class Provider:
        async def generate(self, messages, **options):
            return "synthetic"

    with prompt_scope(snapshot):
        assert (
            await ObservedProvider(Provider(), telemetry, "synthetic", prompts=snapshot).generate(
                []
            )
            == "synthetic"
        )


async def test_factory_prefetches_using_existing_telemetry_client_and_retains_local_default(
    monkeypatch,
):
    from ptr_llm import runtime as module

    fixtures = importlib.import_module("test_runtime_composition")
    client = Mock(spec=Langfuse)
    client.get_prompt.return_value = sdk_prompt()
    telemetry = FrameworkTelemetry(TelemetryConfig())
    telemetry.client = client
    monkeypatch.setattr(module, "AsyncConnectionPool", fixtures.FakePool)
    monkeypatch.setattr(module, "Telemetry", lambda _config: telemetry)
    built = await module.build_runtime(
        fixtures._settings(),
        {
            "PTR_LLM_PROMPT_MANAGEMENT": "langfuse",
            "PTR_LLM_PROMPT_NAME": "generic-policy",
            "PTR_LLM_PROMPT_VERSION": "7",
            "PTR_LLM_PROMPT_SHA256": LOCAL_POLICY_SHA256,
        },
    )
    assert built.prompts.source == "langfuse"
    assert built.provider.prompts is built.prompts
    client.get_prompt.assert_called_once()
    await built.close()


def actual_sdk_client():
    shared = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: pytest.fail("Shared telemetry transport must not be used")
        )
    )
    api = LangfuseAPI(
        base_url="https://synthetic.invalid",
        httpx_client=shared,
        username="synthetic-user",
        password="synthetic-password",
        headers={"X-Approved-Client": "synthetic"},
    )
    client: Any = object.__new__(Langfuse)
    cache = Mock()
    client._resources = SimpleNamespace(api=api, prompt_cache=cache)
    return client, shared, cache


def prompt_response(prompt=LOCAL_POLICY_TEXT):
    return {
        "type": "text",
        "name": "generic-policy",
        "version": 7,
        "prompt": prompt,
        "config": {},
        "labels": [],
        "tags": [],
    }


@pytest.mark.parametrize("status", [200, 408, 409, 429, 500, 503])
async def test_actual_fern_transport_is_single_read_no_retry_refresh_or_raw_error(
    status,
    monkeypatch,
    caplog,
):
    import ptr_llm.prompt_management as module

    client, shared, cache = actual_sdk_client()
    headers_before = client.api._client_wrapper.get_headers()
    reads, owned = [], []

    def handler(request):
        reads.append(request)
        assert request.method == "GET"
        assert request.url.params["version"] == "7"
        assert request.url.params.get("label") is None
        assert request.url.host == "synthetic.invalid"
        assert request.headers["X-Approved-Client"] == "synthetic"
        assert request.headers["Authorization"] == headers_before["Authorization"]
        assert request.extensions["timeout"]["read"] == 1
        return httpx.Response(
            status, json=prompt_response() if status == 200 else {"error": PRIVATE_TEXT}
        )

    def owned_client(timeout):
        transport = httpx.Client(timeout=timeout, transport=httpx.MockTransport(handler))
        owned.append(transport)
        return transport

    monkeypatch.setattr(module, "_owned_http_client", owned_client)
    try:
        snapshot = await load_prompt_snapshot(config(), client)
        assert len(reads) == 1
        assert snapshot.reason == ("verified" if status == 200 else "unavailable")
        assert owned[0].is_closed and not shared.is_closed
        cache.assert_not_called()
        cache.get.assert_not_called()
        assert client.api._client_wrapper.get_headers() == headers_before
        assert client.api._client_wrapper.httpx_client.httpx_client is shared
        assert PRIVATE_TEXT not in caplog.text
    finally:
        shared.close()


async def test_actual_sdk_surrogate_response_uses_exact_local_fallback(monkeypatch):
    import ptr_llm.prompt_management as module

    client, shared, _ = actual_sdk_client()
    reads = []

    def handler(request):
        reads.append(request)
        return httpx.Response(
            200,
            content=json.dumps(prompt_response("\ud800"), ensure_ascii=True).encode(),
            headers={"content-type": "application/json"},
        )

    monkeypatch.setattr(
        module,
        "_owned_http_client",
        lambda timeout: httpx.Client(timeout=timeout, transport=httpx.MockTransport(handler)),
    )
    try:
        snapshot = await load_prompt_snapshot(config(), client)
        assert len(reads) == 1
        assert snapshot.reason == "content_mismatch" and snapshot.sdk_prompt is None
        assert snapshot.experiment == json.loads(LOCAL_POLICY_TEXT)["experiment"]
    finally:
        shared.close()


@pytest.mark.parametrize("finish", ["cancel", "timeout"])
async def test_real_worker_owns_transport_until_late_exit_after_shared_shutdown(
    finish, monkeypatch
):
    import ptr_llm.prompt_management as module

    client, shared, _ = actual_sdk_client()
    entered, release, closed = threading.Event(), threading.Event(), threading.Event()
    reads = []

    def handler(request):
        reads.append(request)
        entered.set()
        assert release.wait(5), "test must release blocked owned transport"
        assert not closed.is_set()
        return httpx.Response(200, json=prompt_response())

    class BlockingTransport(httpx.MockTransport):
        def close(self):
            closed.set()
            super().close()

    owned = httpx.Client(timeout=1, transport=BlockingTransport(handler))
    monkeypatch.setattr(module, "_owned_http_client", lambda _timeout: owned)
    task = asyncio.create_task(load_prompt_snapshot(config(), client))
    try:
        assert await asyncio.to_thread(entered.wait, 1)
        if finish == "cancel":
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            assert (await task).reason == "fetch_timeout"
        # A factory shutdown may now close shared telemetry resources. The live
        # worker uses copied headers/endpoint and a separate owned HTTP client.
        shared.close()
        assert not closed.is_set() and not owned.is_closed
        assert len(reads) == 1
    finally:
        release.set()
        assert await asyncio.to_thread(closed.wait, 2)
        assert owned.is_closed
        shared.close()


async def test_startup_timeout_is_bounded_and_cancellation_is_not_swallowed(monkeypatch):
    import ptr_llm.prompt_management as module

    entered = asyncio.Event()

    async def suspended_fetch(*args, **kwargs):
        entered.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(module.asyncio, "to_thread", suspended_fetch)
    snapshot = await load_prompt_snapshot(config(), Mock(spec=Langfuse))
    assert snapshot.reason == "fetch_timeout" and snapshot.sdk_prompt is None
    entered.clear()
    task = asyncio.create_task(load_prompt_snapshot(config(), Mock(spec=Langfuse)))
    await entered.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_non_text_prompt_falls_back_without_association():
    client = Mock(spec=Langfuse)
    client.get_prompt.return_value = object()
    snapshot = await load_prompt_snapshot(config(), client)
    assert snapshot.reason == "type_mismatch"
    assert snapshot.sdk_prompt is None


async def test_custom_policy_clears_prior_managed_association_and_known_agent_policy_links():
    snapshot, _ = await managed()
    with prompt_scope(snapshot):
        build_experiment_context(PERSONA, [], PRIVATE_TEXT, [])
        assert applied_prompt(snapshot) is snapshot.sdk_prompt
        build_experiment_context(PERSONA, [], PRIVATE_TEXT, [], policy="Synthetic custom policy")
        assert applied_prompt(snapshot) is None
        policy = snapshot.experiment
        agent_policy = (
            policy["EXPERIMENT_POLICY"].split("TIMELINE_JSON_REPLY:")[0]
            + policy["recollectionVoice"]
            + policy["protocol"]
        )
        build_experiment_context(PERSONA, [], PRIVATE_TEXT, [], policy=agent_policy)
        assert applied_prompt(snapshot) is snapshot.sdk_prompt


async def test_invalid_prompt_configuration_is_rejected_before_pool_or_telemetry(monkeypatch):
    from ptr_llm import runtime as module

    fixtures = importlib.import_module("test_runtime_composition")
    pool, telemetry = Mock(), Mock()
    monkeypatch.setattr(module, "AsyncConnectionPool", pool)
    monkeypatch.setattr(module, "Telemetry", telemetry)
    with pytest.raises(ProviderError, match="INVALID_RUNTIME_CONFIG"):
        await module.build_runtime(fixtures._settings(), {"PTR_LLM_PROMPT_MANAGEMENT": "langfuse"})
    pool.assert_not_called()
    telemetry.assert_not_called()
