"""Synthetic C4 consent, extraction and isolated local summary regressions."""

import asyncio
import json
import time

import httpx
import pytest
from langgraph.checkpoint.memory import InMemorySaver

from ptr_llm.core.memory import memory_messages, memory_ops, seasonal_recall_eligible, summarize
from ptr_llm.providers import CheckpointedTextProvider, DirectLocalTextProvider
from ptr_llm.runtime import ObservedProvider
from ptr_llm.telemetry import FrameworkTelemetry, TelemetryConfig


def test_memory_requires_consent_and_verbatim_safe_span():
    operations = [dict(op="add", kind="like", text="blue skies")]
    assert memory_ops(operations, "I like blue skies", False, []) == []
    assert memory_ops(operations, "I like blue skies", True, []) == operations
    assert memory_ops(operations, "I like green trees", True, []) == []
    assert memory_ops([dict(op="add", kind="like", text="sky")], "sky", True, []) == []
    assert (
        memory_ops(
            [dict(op="add", kind="like", text="blue skies")],
            "I have cancer; blue skies",
            True,
            [],
        )
        == []
    )
    assert (
        memory_ops(operations, "blue skies", True, [dict(text="blue skies", forgotten=True)]) == []
    )


@pytest.mark.parametrize(
    "text",
    [
        "my diabetes",
        "나는 기독교",
        "my exact address",
        "010-1234-5678",
        "나는 미성년자",
        "my bank account",
        "I vote liberal",
        "I am bisexual",
        "나는 임신 중이야",
        "나는 천식이 있어",
        "나는 무신론자야",
    ],
)
def test_sensitive_memory_is_rejected(text):
    assert memory_ops([dict(op="add", kind="other", text=text)], text, True, []) == []


def test_memory_prompt_excludes_forgotten_and_consent_off():
    memories = [
        dict(text="blue skies", kind="like"),
        dict(text="green trees", kind="like", forgotten=True),
    ]
    assert memory_messages(dict(userMemoryConsent=False, userMemories=memories)) == []
    rendered = str(memory_messages(dict(userMemoryConsent=True, userMemories=memories)))
    assert "USER_MEMORY" in rendered and "blue skies" in rendered and "green trees" not in rendered


def test_new_session_opener_uses_only_prior_user_utterance_with_consent():
    context = dict(
        userMemoryConsent=True,
        userMemories=[],
        turn=dict(sequence=1),
        previousSessionUserSaid="I like blue skies",
    )
    rendered = str(memory_messages(context))
    assert "USER_MEMORY" in rendered and "I like blue skies" in rendered
    assert "previous conversation" in rendered
    context["userMemoryConsent"] = False
    assert "I like blue skies" not in str(memory_messages(context))
    context["userMemoryConsent"] = True
    context["previousSessionUserSaid"] = "I have cancer"
    assert "I have cancer" not in str(memory_messages(context))


class Local:
    def __init__(self):
        self.calls = []

    async def generate_local_only(self, messages, **kwargs):
        self.calls.append((messages, kwargs))
        return json.dumps(dict(text="We talked about blue skies."))


def test_last_year_candidate_does_not_displace_explicit_other_date_results():
    assert seasonal_recall_eligible("요즘 무슨 일 있었어?", {"query": "요즘"})
    assert seasonal_recall_eligible("작년 이맘때 뭐 했어?", {"start": "2020-01-01"})
    assert not seasonal_recall_eligible("2022년 3월에는 뭐 했어?", {"query": "2022년 3월"})
    assert not seasonal_recall_eligible("2022년에 뭐 했어?", {"start": "2022-01-01"})


@pytest.mark.asyncio
async def test_production_wrapper_chain_runs_local_summary_without_paid_spillover():
    class Paid:
        async def generate(self, *_args, **_kwargs):
            pytest.fail("summary reached paid spillover")

    raw = DirectLocalTextProvider(
        base_url="http://127.0.0.1:18080/v1",
        model="synthetic-local",
        paid_spillover=Paid(),
    )
    calls = []

    async def fake_local(messages, **options):
        calls.append((messages, options))
        assert options["local_only"] is True
        options["on_usage"]({"promptTokens": 1, "completionTokens": 1})
        return json.dumps({"text": "Synthetic conversation summary."})

    raw.generate = fake_local
    wrapped = ObservedProvider(
        CheckpointedTextProvider(raw, InMemorySaver()),
        FrameworkTelemetry(TelemetryConfig(capture_content=False)),
        "synthetic-local",
    )
    history = [dict(id=str(i), role="user", content="synthetic sky") for i in range(20)]
    context = {"history": history}
    result = await summarize(
        wrapped, context, "synthetic-turn", time.time() * 1000 + 8000, asyncio.Event()
    )
    assert result == {"text": "Synthetic conversation summary.", "lastMessageId": "19"}
    assert len(calls) == 1
    assert calls[0][1]["request_key"] == "synthetic-turn:summary"
    assert (
        await summarize(
            wrapped, context, "synthetic-turn", time.time() * 1000 + 8000, asyncio.Event()
        )
        == result
    )
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_saturated_local_summary_cannot_spill_through_production_wrappers():
    paid_calls = []
    local_calls = []

    class Paid:
        async def generate(self, *_args, **_kwargs):
            paid_calls.append(True)
            pytest.fail("summary reached paid spillover")

    def saturated(request):
        local_calls.append(request.url.path)
        return httpx.Response(
            429,
            headers={"x-llm-d-request-dropped-reason": "rejected-saturated"},
            json={"error": "synthetic saturation"},
        )

    raw = DirectLocalTextProvider(
        base_url="http://127.0.0.1:18080/v1",
        model="synthetic-local",
        transport=httpx.MockTransport(saturated),
        paid_spillover=Paid(),
        spillover_min_remaining_ms=0,
    )
    raw.spillover_enabled = True
    wrapped = ObservedProvider(
        CheckpointedTextProvider(raw, InMemorySaver()),
        FrameworkTelemetry(TelemetryConfig(capture_content=False)),
        "synthetic-local",
    )
    context = {"history": [dict(id=str(i), role="user", content="synthetic") for i in range(20)]}
    try:
        assert (
            await summarize(
                wrapped, context, "synthetic-turn", time.time() * 1000 + 8000, asyncio.Event()
            )
            is None
        )
        assert local_calls == ["/v1/chat/completions"]
        assert paid_calls == []
    finally:
        await raw.aclose()


@pytest.mark.asyncio
async def test_summary_gates_and_separate_request_key():
    provider = Local()
    context = dict(history=[dict(id=str(i), role="user", content="blue skies") for i in range(20)])
    greeting = dict(id="greeting", role="assistant", turnId=None, content="hello")
    nineteen = dict(
        history=[greeting]
        + [
            dict(id=str(i), role="user", turnId="synthetic-turn", content="blue skies")
            for i in range(19)
        ]
    )
    assert (
        await summarize(provider, nineteen, "turn", time.time() * 1000 + 8000, asyncio.Event())
        is None
    )
    assert (
        await summarize(provider, context, "turn", time.time() * 1000 + 6000, asyncio.Event())
        is None
    )
    assert not provider.calls
    result = await summarize(provider, context, "turn", time.time() * 1000 + 8000, asyncio.Event())
    assert result == dict(text="We talked about blue skies.", lastMessageId="19")
    assert provider.calls[0][1]["request_key"] == "turn:summary"
    assert (
        await summarize(
            provider,
            dict(history=context["history"][:19]),
            "turn",
            time.time() * 1000 + 8000,
            asyncio.Event(),
        )
        is None
    )


@pytest.mark.asyncio
async def test_summary_redacts_escaped_forgotten_values_before_json_serialization():
    provider = Local()
    forgotten = 'synthetic "do-not-repeat"\n'
    context = dict(
        history=[dict(id=str(i), role="user", content=forgotten) for i in range(20)],
        userMemories=[dict(text=forgotten, forgotten=True)],
    )
    assert await summarize(provider, context, "turn", time.time() * 1000 + 8000, asyncio.Event())
    assert "do-not-repeat" not in str(provider.calls[0][0])


@pytest.mark.asyncio
async def test_summary_never_falls_back_and_trusts_server_verified_suffix():
    class Paid:
        async def generate(self, *_args, **_kwargs):
            pytest.fail("summary cannot call generic/paid generate")

    context = dict(history=[dict(id=str(i), role="user", content="blue skies") for i in range(20)])
    assert (
        await summarize(Paid(), context, "turn", time.time() * 1000 + 8000, asyncio.Event()) is None
    )
    context["summary"] = dict(text="prior", lastMessageId="missing")
    provider = Local()
    assert await summarize(provider, context, "turn", time.time() * 1000 + 8000, asyncio.Event())
    assert len(provider.calls) == 1


@pytest.mark.asyncio
async def test_summary_gap_builds_fresh_summary_from_current_window():
    provider = Local()
    context = dict(
        summaryGap=True,
        history=[dict(id=str(i), role="user", content="synthetic") for i in range(40)],
    )
    assert await summarize(
        provider, {**context, "history": context["history"][:19]},
        "turn", time.time() * 1000 + 8000, asyncio.Event()
    ) is None
    assert await summarize(
        provider, context, "turn", time.time() * 1000 + 6000, asyncio.Event()
    ) is None
    assert provider.calls == []
    assert await summarize(
        provider, context, "turn", time.time() * 1000 + 8000, asyncio.Event()
    ) == {"text": "We talked about blue skies.", "lastMessageId": "39"}
    assert len(provider.calls) == 1
    assert json.loads(provider.calls[0][0][1]["content"])["summary"] is None


@pytest.mark.asyncio
async def test_summary_timeout_and_failure_do_not_escape(monkeypatch):
    import ptr_llm.core.memory as module

    original = asyncio.timeout
    monkeypatch.setattr(module.asyncio, "timeout", lambda seconds: original(0.01))

    class Slow:
        async def generate_local_only(self, *_args, **_kwargs):
            await asyncio.sleep(1)

    context = dict(history=[dict(id=str(i), role="user", content="blue skies") for i in range(20)])
    assert (
        await summarize(Slow(), context, "turn", time.time() * 1000 + 8000, asyncio.Event()) is None
    )


@pytest.mark.parametrize(
    "text",
    [
        "반말 하지 마",
        "존댓말 해 줘도",
        "반말 해 줘서",
        "반말 해라고",
        "반말 해 주세요?",
        "그가 나한테 반말 해",
        "don't talk casually",
        "she said: speak casually",
    ],
)
def test_speech_requests_are_direct_imperatives_only(text):
    from ptr_llm.core.runtime import requested_speech_level

    assert requested_speech_level(text) is None


@pytest.mark.parametrize("text", ["말 놓자", "talk casually with me"])
def test_direct_casual_speech_requests(text):
    from ptr_llm.core.runtime import requested_speech_level

    assert requested_speech_level(text) == "casual"


@pytest.mark.asyncio
async def test_agent_memory_schema_and_persistence_are_consent_bound():
    from core_domain_test import Personas, Provider, grant, noop, response

    from ptr_llm.core.runtime import LLMEngine

    op = dict(op="add", kind="like", text="blue skies")
    for consent in (False, True):
        provider = Provider([response("Lovely!", updates=dict(userMemory=[op]))])
        request = grant("I like blue skies")
        request["context"].update(userMemoryConsent=consent, userMemories=[])
        result = await LLMEngine(provider=provider, personas=Personas()).handle(
            request, before_costly=noop, cancelled=asyncio.Event()
        )
        assert result["kind"] == "completed"
        assert result.get("userMemoryOps", []) == ([op] if consent else [])
        assert "userMemory" not in result["reply"]["agent"]["variables"]


def test_last_year_query_uses_server_month_and_two_candidates():
    from ptr_llm.core.memory import last_year_query

    query = last_year_query("2026-01-01T00:30:00Z", "America/Los_Angeles", "person", "sky")
    assert query == dict(
        personId="person",
        query="sky",
        start="2024-12-01",
        end="2025-01-01",
        dateBasis="posted",
        timezone="America/Los_Angeles",
        limit=2,
    )


def test_last_year_recall_requires_bound_candidate_and_once_flag():
    from ptr_llm.core.memory import recall_allowed

    assert recall_allowed("작년 이맘때 하늘 참 좋았지!", [dict(sourceId="old")], {"old"}, False)
    assert not recall_allowed("작년 이맘때 하늘 참 좋았지!", [], {"old"}, False)
    assert not recall_allowed("작년 이맘때 하늘 참 좋았지!", [dict(sourceId="new")], {"old"}, False)
    assert not recall_allowed("작년 이맘때 하늘 참 좋았지!", [dict(sourceId="old")], {"old"}, True)


@pytest.mark.asyncio
async def test_local_only_summary_capacity_never_calls_paid_spillover():
    import httpx

    from ptr_llm.billing import ProviderError
    from ptr_llm.providers.local import DirectLocalTextProvider

    class Paid:
        async def generate(self, *_args, **_kwargs):
            pytest.fail("local-only summary called paid provider")

    async def handler(_request):
        return httpx.Response(
            429,
            headers={"x-llm-d-request-dropped-reason": "rejected-saturated"},
            json={"error": "synthetic"},
        )

    provider = DirectLocalTextProvider(
        base_url="http://127.0.0.1:8111/v1",
        model="synthetic",
        transport=httpx.MockTransport(handler),
        paid_spillover=Paid(),
        spillover_min_remaining_ms=0,
    )
    provider.spillover_enabled = True
    try:
        with pytest.raises(ProviderError):
            await provider.generate_local_only(
                [dict(role="user", content="synthetic")],
                request_key="turn:summary",
                deadline_at=time.time() * 1000 + 1000,
            )
    finally:
        await provider.aclose()


@pytest.mark.asyncio
async def test_runtime_summary_is_separate_completed_result_metadata():
    from core_domain_test import Personas, Provider, grant, noop, response

    from ptr_llm.core.runtime import LLMEngine

    class WithSummary(Provider, Local):
        def __init__(self):
            Provider.__init__(self, [response("Lovely!")])
            Local.__init__(self)

    provider = WithSummary()
    request = grant("Hello")
    request["context"]["history"] = [
        dict(id=str(i), role="user", content="blue skies") for i in range(24)
    ]
    result = await LLMEngine(provider=provider, personas=Personas()).handle(
        request, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert result["summaryUpdate"]["lastMessageId"] == "23"
    assert "summaryUpdate" not in result["reply"]


@pytest.mark.asyncio
async def test_runtime_prior_year_candidates_and_once_per_conversation():
    from core_domain_test import SOURCE, Personas, Provider, Retrieval, grant, noop, response

    from ptr_llm.core.runtime import LLMEngine

    source = dict(SOURCE, postedAt="2025-10-10T12:00:00Z")
    retrieval = Retrieval([source])
    provider = Provider(
        [
            response(
                "This time last year, lovely!",
                refs=[dict(sourceId=source["id"], quote=source["caption"][:30])],
            )
        ]
    )
    request = grant(
        "Tell me about your old sky post", retrievalMode="lexical", ragCondition="caption"
    )
    request["context"]["turn"]["createdAt"] = "2026-10-15T12:00:00Z"
    result = await LLMEngine(provider=provider, personas=Personas(), retrieval=retrieval).handle(
        request, before_costly=noop, cancelled=asyncio.Event()
    )
    assert result["kind"] == "completed"
    assert any(q.get("start") == "2025-10-01" and q["limit"] == 2 for q in retrieval.searches)
    assert result["reply"]["agent"]["variables"]["lastYearRecallUsed"] is True
    request["context"]["previousReply"] = result["reply"]
    retrieval.searches.clear()
    provider.responses.append(
        response(
            "This time last year, lovely!",
            refs=[dict(sourceId=source["id"], quote=source["caption"][:30])],
        )
    )
    again = await LLMEngine(provider=provider, personas=Personas(), retrieval=retrieval).handle(
        request, before_costly=noop, cancelled=asyncio.Event()
    )
    assert again["kind"] == "completed"
    assert "This time last year" not in again["reply"]["content"]
    assert not any(q.get("start") == "2025-10-01" for q in retrieval.searches)
