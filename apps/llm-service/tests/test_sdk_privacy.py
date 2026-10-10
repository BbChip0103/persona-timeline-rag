"""SDK callback/cache boundaries: synthetic payloads and mock transport only."""

import asyncio
from contextvars import ContextVar

import httpx
import pytest
import requests
from langchain_core.callbacks.base import BaseCallbackHandler
from langchain_core.runnables.config import var_child_runnable_config
from langchain_core.tracers.context import collect_runs, register_configure_hook
from langgraph.checkpoint.memory import InMemorySaver
from langsmith import Client as LangSmithClient
from langsmith import tracing_context
from test_evidence_selection import Retrieval, Selector, run
from test_providers_billing import response

from ptr_llm.providers import CheckpointedTextProvider, FakeTextProvider, LiteLLMTextProvider

SENTINEL = "SDK_SYNTHETIC_PRIVATE_SENTINEL"
HOOK = ContextVar("ptr_synthetic_privacy_hook", default=None)
register_configure_hook(HOOK, inheritable=True)


class Recorder(BaseCallbackHandler):
    def __init__(self):
        self.exports = []

    def on_chain_start(self, serialized, inputs, **kwargs):
        self.exports.append(inputs)

    def on_chain_end(self, outputs, **kwargs):
        self.exports.append(outputs)

    def on_chat_model_start(self, serialized, messages, **kwargs):
        self.exports.append(messages)

    def on_llm_end(self, result, **kwargs):
        self.exports.append(result)


class BlockedTraceSession(requests.Session):
    def __init__(self):
        super().__init__()
        self.attempts = []

    def send(self, request, **kwargs):
        self.attempts.append(request.url)
        raise AssertionError("synthetic privacy probes cannot export traces")


@pytest.mark.parametrize("kind", ["plain", "agent", "timeline", "turn", "receipt"])
async def test_all_native_sdk_entrypoints_keep_ambient_callbacks_private(kind, monkeypatch):
    monkeypatch.setenv("LANGSMITH_API_KEY", "")
    monkeypatch.setenv("LANGCHAIN_API_KEY", "")
    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    recorder = Recorder()
    token = HOOK.set(recorder)
    inherited = {"callbacks": [recorder], "metadata": {"private": SENTINEL}}
    config_token = var_child_runnable_config.set(inherited)
    calls = []

    async def transport(request):
        calls.append(request)
        answer = (
            '{"message":"synthetic reply","status":"answered",'
            '"evidenceRefs":[],"variableUpdates":{}}'
            if kind == "agent"
            else "synthetic reply"
        )
        return httpx.Response(200, json=response(answer))

    provider = LiteLLMTextProvider(
        base_url="http://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        transport=httpx.MockTransport(transport),
    )
    trace_session = BlockedTraceSession()
    trace_client = LangSmithClient(
        api_url="http://synthetic.invalid",
        api_key="synthetic",
        session=trace_session,
        info={"version": "synthetic"},
        auto_batch_tracing=False,
    )
    try:
        with collect_runs() as runs, tracing_context(enabled=True, client=trace_client):
            if kind == "turn":
                result, raw = await run(Retrieval(1), Selector(["post-0"]))
                assert result["kind"] == "completed" and len(raw.messages) == 1
            elif kind == "receipt":
                raw = FakeTextProvider()
                wrapped = CheckpointedTextProvider(raw, InMemorySaver())
                messages = [{"role": "user", "content": SENTINEL}]
                first = await wrapped.generate(messages, request_key="synthetic-key")
                assert await wrapped.generate(messages, request_key="synthetic-key") == first
                assert raw.calls == 1
            else:
                marker = {"agent": "AGENT_JSON_REPLY", "timeline": "TIMELINE_JSON_REPLY"}.get(
                    kind, "synthetic policy"
                )
                await provider.generate(
                    [
                        {"role": "system", "content": marker + SENTINEL},
                        {"role": "user", "content": SENTINEL},
                    ]
                )
                assert len(calls) == 1
        assert recorder.exports == [] and runs.traced_runs == []
        trace_client.flush()
        assert trace_session.attempts == []
        assert HOOK.get() is recorder and var_child_runnable_config.get() is inherited
    finally:
        trace_client.close()
        await provider.aclose()
        var_child_runnable_config.reset(config_token)
        HOOK.reset(token)


@pytest.mark.parametrize("global_setting", ["_debug", "_verbose", "env_hook"])
async def test_unsupported_global_raw_logging_is_prepaid_fail_closed(
    global_setting, monkeypatch, capsys
):
    from langchain_core import globals as sdk_globals

    from ptr_llm.billing import MemoryBudgetLedger, ProviderError

    created, network = [], []

    class EnvRecorder(Recorder):
        def __init__(self):
            created.append(True)
            super().__init__()

    if global_setting == "env_hook":
        register_configure_hook(
            ContextVar("ptr_synthetic_env_hook", default=None),
            inheritable=True,
            handle_class=EnvRecorder,
            env_var="PTR_SYNTHETIC_RAW_CALLBACK",
        )
        monkeypatch.setenv("PTR_SYNTHETIC_RAW_CALLBACK", "1")
    else:
        monkeypatch.setattr(sdk_globals, global_setting, True)

    async def transport(request):
        network.append(request)
        raise AssertionError("unsupported SDK logging cannot submit")

    ledger = MemoryBudgetLedger()
    provider = LiteLLMTextProvider(
        base_url="http://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        ledger=ledger,
        pricing_ceiling={"prompt": 0.5, "completion": 3.0},
        transport=httpx.MockTransport(transport),
    )
    try:
        with pytest.raises(ProviderError, match="SDK_RAW_TRACING_FORBIDDEN"):
            await provider.generate([{"role": "user", "content": SENTINEL}])
        assert not network and not created and not ledger.requests
        assert SENTINEL not in capsys.readouterr().out
    finally:
        await provider.aclose()


async def test_native_chat_sdk_never_reads_or_writes_ambient_second_cache(monkeypatch):
    from langchain_core import globals as sdk_globals
    from langchain_core.caches import BaseCache

    class AmbientCache(BaseCache):
        def __init__(self):
            self.calls = []

        def lookup(self, prompt, llm_string):
            self.calls.append(("lookup", prompt))
            return None

        def update(self, prompt, llm_string, return_val):
            self.calls.append(("update", prompt))

        def clear(self, **kwargs):
            self.calls.append(("clear", None))

    cache = AmbientCache()
    monkeypatch.setattr(sdk_globals, "_llm_cache", cache)

    async def transport(request):
        return httpx.Response(200, json=response("synthetic reply"))

    provider = LiteLLMTextProvider(
        base_url="http://synthetic.invalid/v1",
        model="primary",
        api_key="synthetic",
        transport=httpx.MockTransport(transport),
    )
    try:
        assert await provider.generate([{"role": "user", "content": SENTINEL}])
        assert cache.calls == [] and provider._sdk.cache is False
    finally:
        await provider.aclose()


@pytest.mark.parametrize("failure", ["cancel", "error", "success"])
async def test_private_scope_restores_context_on_every_exit_and_keeps_otel(failure):
    from langchain_core.runnables import RunnableLambda
    from opentelemetry import trace

    from ptr_llm.core.langchain import private_ainvoke

    recorder = Recorder()
    token = HOOK.set(recorder)
    inherited = {"callbacks": [recorder], "metadata": {"private": SENTINEL}}
    config_token = var_child_runnable_config.set(inherited)
    entered, proceed = asyncio.Event(), asyncio.Event()
    span = trace.NonRecordingSpan(trace.SpanContext(123, 456, False))

    async def native(value):
        assert trace.get_current_span() is span
        assert HOOK.get() is None
        entered.set()
        await proceed.wait()
        if failure == "error":
            raise ValueError("synthetic failure")
        return value

    async def invoke():
        try:
            return await private_ainvoke(RunnableLambda(native), SENTINEL)
        finally:
            assert HOOK.get() is recorder
            assert var_child_runnable_config.get() is inherited
            assert trace.get_current_span() is span

    try:
        with trace.use_span(span):
            task = asyncio.create_task(invoke())
            await entered.wait()
            # An unrelated concurrent normal SDK call still retains its callbacks.
            assert await RunnableLambda(lambda value: value).ainvoke("public synthetic")
            before = len(recorder.exports)
            if failure == "cancel":
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
            else:
                proceed.set()
                if failure == "error":
                    with pytest.raises(ValueError, match="synthetic failure"):
                        await task
                else:
                    assert await task == SENTINEL
            assert len(recorder.exports) == before
            assert SENTINEL not in repr(recorder.exports)
            assert before > 0
    finally:
        var_child_runnable_config.reset(config_token)
        HOOK.reset(token)


@pytest.mark.parametrize(
    "role,db",
    [
        ("wrong_owner", "ptr_split_test"),
        ("ptr_split_owner", "wrong_db"),
        ("ptr_split_owner", "ptr_split_test"),
    ],
)
async def test_checkpoint_setup_checks_connected_identity_before_ddl(monkeypatch, role, db):
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from psycopg import AsyncConnection

    from ptr_llm.billing import ProviderError
    from ptr_llm.providers.checkpoints import setup_call_checkpoints

    statements = []

    class Connection:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return None

        async def execute(self, sql):
            statements.append(sql)
            return self

        async def fetchone(self):
            return {"role": role, "db": db}

    async def connect(*args, **kwargs):
        return Connection()

    async def setup(self):
        statements.append("DDL")

    monkeypatch.setattr(AsyncConnection, "connect", connect)
    monkeypatch.setattr(AsyncPostgresSaver, "setup", setup)
    url = "postgresql://ptr_split_owner:synthetic@127.0.0.1:58432/ptr_split_test"
    if (role, db) != ("ptr_split_owner", "ptr_split_test"):
        with pytest.raises(ProviderError, match="CHECKPOINT_SETUP_REQUIRES_OWNER"):
            await setup_call_checkpoints(url)
        assert len(statements) == 1 and statements[0].startswith("SELECT current_user")
    else:
        await setup_call_checkpoints(url)
        assert statements[-2:] == ["SET search_path TO llm,public", "DDL"]
