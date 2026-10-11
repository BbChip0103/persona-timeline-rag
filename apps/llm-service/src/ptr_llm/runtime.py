"""Python-only composition. No backend repository, session write or runtime DDL."""

from __future__ import annotations

import asyncio
import copy
import json
import math
import os
import time
from collections.abc import Mapping
from contextvars import ContextVar
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .billing import PostgresBudgetLedger, ProviderError
from .config import Settings
from .core.errors import CoreError
from .core.persona import validate_persona
from .core.runtime import LLMEngine
from .prompt_management import (
    LOCAL_PROMPT_SNAPSHOT,
    PromptManagementConfig,
    PromptSnapshot,
    applied_prompt,
    load_prompt_snapshot,
    prompt_scope,
)
from .providers import (
    CheckpointedTextProvider,
    FakeTextProvider,
    JevInputSafetyClassifier,
    JevIntentClassifier,
    LiteLLMTextProvider,
    OpenRouterClient,
    OpenRouterEmbeddingProvider,
)
from .repositories import (
    PostgresPersonaRepository,
    PostgresRetrieval,
    PostgresSourceRepository,
    ResultReceiptStore,
    assert_llm_database_url,
)
from .telemetry import FrameworkTelemetry as Telemetry
from .telemetry import TelemetryConfig


def _load_publication(
    env: Mapping[str, str], database_url: str
) -> tuple[dict[str, Any], ...] | None:
    """Snapshot approved selection; never infer publication from imported DB variants."""
    database = urlsplit(database_url).path.removeprefix("/")

    def unique_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("ambiguous publication")
            result[key] = value
        return result

    def read(path: str, *, bound: bool = False, authored: bool = False) -> list[dict[str, Any]]:
        raw = json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=unique_keys)
        if bound or (authored and isinstance(raw, dict)):
            if (
                not isinstance(raw, dict)
                or set(raw) != {"database", "personas"}
                or raw["database"] != database
            ):
                raise ProviderError("PERSONA_UNAVAILABLE")
            raw = raw["personas"]
        if not isinstance(raw, list):
            raise ProviderError("PERSONA_UNAVAILABLE")
        cards = [validate_persona(item) for item in raw]
        if any(len({card[key] for card in cards}) != len(cards) for key in ("personId", "id")):
            raise ProviderError("PERSONA_UNAVAILABLE")
        return cards

    try:
        if "PTR_LLM_PUBLISHED_PERSONAS_FILE" in env:
            selected = read(env["PTR_LLM_PUBLISHED_PERSONAS_FILE"], bound=True)
        else:
            # Retain isolated fake fixtures without discovering private files.
            if env.get("PTR_LLM_PROVIDER", "fake") == "fake" and not any(
                key in env for key in ("PTR_PERSONAS_FILE", "PTR_AUTHORED_PERSONAS_FILE")
            ):
                return None
            generated = read(env.get("PTR_PERSONAS_FILE", "data/research/personas.json"))
            authored = (
                read(env["PTR_AUTHORED_PERSONAS_FILE"], authored=True)
                if "PTR_AUTHORED_PERSONAS_FILE" in env
                else []
            )
            overrides = {card["personId"]: card for card in authored}
            generated_people = {card["personId"] for card in generated}
            selected = [overrides.get(card["personId"], card) for card in generated]
            selected.extend(card for card in authored if card["personId"] not in generated_people)
        if len({card["id"] for card in selected}) != len(selected):
            raise ProviderError("PERSONA_UNAVAILABLE")
        return tuple(selected)
    except (OSError, ValueError, CoreError, TypeError):
        raise ProviderError("PERSONA_UNAVAILABLE") from None


def _published_cards(
    documents: list[dict[str, Any]], publication: tuple[dict[str, Any], ...] | None
) -> list[dict[str, Any]]:
    try:
        current = [validate_persona(document) for document in documents]
        if publication is None:
            return current
        by_id = {card["id"]: card for card in current}
        if len(by_id) != len(current):
            raise ProviderError("PERSONA_UNAVAILABLE")
        selected = []
        for approved in publication:
            canonical = by_id.get(approved["id"])
            # Full normalized document equality includes person, revision and content.
            if canonical != approved:
                raise ProviderError("PERSONA_UNAVAILABLE")
            selected.append(canonical)
        return selected
    except CoreError:
        raise ProviderError("PERSONA_UNAVAILABLE") from None


def _integer(env: Mapping[str, str], key: str, default: int, low: int, high: int) -> int:
    try:
        result = int(env.get(key, str(default)))
    except ValueError:
        raise ProviderError("INVALID_RUNTIME_CONFIG") from None
    if not low <= result <= high:
        raise ProviderError("INVALID_RUNTIME_CONFIG")
    return result


_generation_span: ContextVar[Any] = ContextVar("ptr_model_accounting_span", default=None)


def _count(value: Any) -> int | None:
    return value if type(value) is int and 0 <= value <= 9007199254740991 else None


def _observe_provider_metrics(metrics: dict[str, Any]) -> None:
    """Accounting only; never export request text, headers or upstream identities."""
    span = _generation_span.get()
    if span is None:
        return
    metadata: dict[str, Any] = {"accounting": "reported-receipt"}
    for key in ("attempts", "totalMs"):
        count = _count(metrics.get(key))
        if count is not None:
            metadata[key] = count
    cost = _count(metrics.get("costMicrousd"))
    span.update(
        metadata=metadata,
        **({"cost_details": {"total": cost / 1_000_000}} if cost is not None else {}),
    )


class ObservedDecisions:
    """Observe the existing ledgered Jev call, not another submission or retry."""

    def __init__(self, client: Any, telemetry: Telemetry):
        self.client, self.telemetry = client, telemetry

    async def decide(self, request: dict[str, Any], **options: Any) -> dict[str, Any]:
        from .providers.openrouter import DEFAULT_JEV_MODEL

        model = request.get("model")
        model = model if model == DEFAULT_JEV_MODEL else "unknown"
        with self.telemetry.observation("jev", as_type="generation", model=model) as span:
            started = time.perf_counter()
            try:
                result = await self.client.decide(request, **options)
                usage = result.get("usage")
                if isinstance(usage, dict):
                    counts = {
                        "input": _count(usage.get("input_tokens", usage.get("prompt_tokens"))),
                        "output": _count(
                            usage.get("output_tokens", usage.get("completion_tokens"))
                        ),
                    }
                    details = {k: v for k, v in counts.items() if v is not None}
                    cost = usage.get("cost")
                    updates: dict[str, Any] = {"usage_details": details} if details else {}
                    if (
                        isinstance(cost, (int, float))
                        and not isinstance(cost, bool)
                        and math.isfinite(cost)
                        and cost >= 0
                    ):
                        updates["cost_details"] = {"total": cost}
                    span.update(**updates)
                return result
            finally:
                span.update(
                    metadata={
                        "kind": "decision",
                        "accounting": "reported-receipt",
                        "totalMs": round((time.perf_counter() - started) * 1000),
                    }
                )


class ObservedProvider:
    provider_name: str

    def __init__(
        self,
        provider: Any,
        telemetry: Telemetry,
        model: str,
        *,
        prompts: PromptSnapshot = LOCAL_PROMPT_SNAPSHOT,
    ):
        self.provider, self.telemetry, self.model = provider, telemetry, model
        self.prompts = prompts

    def request_fingerprint(self, *args: Any, **kwargs: Any) -> str:
        return self.provider.request_fingerprint(*args, **kwargs)

    async def aclose(self) -> None:
        close = getattr(self.provider, "aclose", None)
        if close is not None:
            await close()

    async def generate(self, messages: Any, **options: Any) -> str:
        prompt = applied_prompt(self.prompts)
        with self.telemetry.observation(
            "model",
            as_type="generation",
            model=self.model,
            metadata=self.prompts.metadata(),
            **({"prompt": prompt} if prompt is not None else {}),
        ) as span:
            original = options.get("on_usage")

            def usage(value: dict[str, Any]) -> None:
                span.update(
                    usage_details={
                        "input": value.get("promptTokens"),
                        "output": value.get("completionTokens"),
                    }
                )
                if original:
                    original(value)

            token = _generation_span.set(span)
            try:
                call_options = dict(options, on_usage=usage)
                if isinstance(self.provider, OpenRouterClient):
                    original_cost = options.get("on_cost")

                    def cost(value: int | None) -> None:
                        actual = _count(value)
                        if actual is not None:
                            span.update(
                                metadata={"accounting": "reported-receipt"},
                                cost_details={"total": actual / 1_000_000},
                            )
                        if original_cost:
                            original_cost(value)

                    call_options["on_cost"] = cost
                return await self.provider.generate(messages, **call_options)
            finally:
                _generation_span.reset(token)


class Runtime:
    def __init__(
        self,
        pool: Any,
        personas: Any,
        engine: Any,
        results: Any,
        provider: Any,
        telemetry: Telemetry,
        provider_name: str,
        model: str,
        *,
        prompts: PromptSnapshot = LOCAL_PROMPT_SNAPSHOT,
        auxiliary_provider: Any = None,
        publication: tuple[dict[str, Any], ...] | None = None,
    ):
        self.pool, self.personas, self.domain_engine = pool, personas, engine
        self.result_store, self.provider, self.telemetry = results, provider, telemetry
        self.provider_name, self.model = provider_name, model
        self.prompts = prompts
        self.auxiliary_provider = auxiliary_provider
        self.publication = copy.deepcopy(publication)
        self.engine = self

    async def handle(self, grant: dict[str, Any], **options: Any) -> dict[str, Any]:
        # Domain engine owns the single root turn trace.
        with prompt_scope(self.prompts):
            return await self.domain_engine.handle(grant, **options)

    async def catalogue(self) -> list[dict[str, Any]]:
        fields = (
            "id",
            "personId",
            "label",
            "language",
            "revision",
            "reviewStatus",
            "greeting",
            "alternateGreetings",
        )
        # Only the approved public projection crosses the owner boundary.
        try:
            personas = await self.personas.list()
        except CoreError:
            raise ProviderError("PERSONA_UNAVAILABLE") from None
        return [
            {key: persona[key] for key in fields if key in persona}
            for persona in _published_cards(personas, self.publication)
        ]

    async def draft(self, body: dict[str, Any]) -> dict[str, Any]:
        # Use the configured domain engine, including the Jev fail-closed policy.
        with prompt_scope(self.prompts):
            return await self.domain_engine.draft(body)

    async def health(self) -> bool:
        try:
            async with asyncio.timeout(1), self.pool.connection() as connection:
                return (await (await connection.execute("SELECT 1")).fetchone())["?column?"] == 1
        except Exception:
            return False

    async def close(self) -> None:
        try:
            close = getattr(self.provider, "aclose", None)
            if close is not None:
                await close()
        finally:
            try:
                if self.auxiliary_provider is not None:
                    await self.auxiliary_provider.aclose()
            finally:
                try:
                    await asyncio.to_thread(self.telemetry.shutdown)
                finally:
                    await self.pool.close()


async def build_runtime(settings: Settings, env: Mapping[str, str] | None = None) -> Runtime:
    env = os.environ if env is None else env
    assert_llm_database_url(settings.database_url)
    prompt_config = PromptManagementConfig.from_env(env)
    # Paid proxy routes preserve the explicit live/data gates from the TS
    # runtime. Validate before opening a pool or constructing any provider.
    pricing = None
    if env.get("PTR_LLM_PROVIDER", "fake") == "litellm":
        billable = env.get("PTR_LLM_LITELLM_BILLABLE", "0")
        if billable not in ("0", "1"):
            raise ProviderError("INVALID_RUNTIME_CONFIG")
        if billable == "0" and env.get("PTR_LLM_MODEL", "primary") != "primary":
            raise ProviderError("UNAPPROVED_NONBILLABLE_ALIAS")
        if billable == "1":
            try:
                pricing = {
                    "prompt": float(env["PTR_LLM_PROMPT_USD_PER_M"]),
                    "completion": float(env["PTR_LLM_COMPLETION_USD_PER_M"]),
                }
            except (KeyError, ValueError):
                raise ProviderError("PRICING_UNVERIFIED") from None
            if not all(math.isfinite(v) and v >= 0 for v in pricing.values()):
                raise ProviderError("PRICING_UNVERIFIED")
            if (
                env.get("PTR_LLM_LIVE_ENABLED") != "1"
                or env.get("PTR_LLM_ALLOW_EXTERNAL_DATA") != "1"
            ):
                raise ProviderError("LIVE_NOT_ENABLED")
    if settings.database_url.split("://", 1)[1].split(":", 1)[0] != "ptr_split_llm":
        raise ProviderError("RUNTIME_REQUIRES_LLM_ROLE")
    pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]] = AsyncConnectionPool(
        conninfo=settings.database_url,
        open=False,
        min_size=1,
        max_size=_integer(env, "PTR_LLM_DB_POOL_MAX", 8, 1, 200),
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
            "options": "-c search_path=llm,public",
        },
    )
    telemetry = provider = client = None
    try:
        await pool.open(wait=True)
        telemetry = Telemetry(TelemetryConfig.from_env(env))
        async with pool.connection() as connection:
            cursor = await connection.execute(
                "SELECT current_user AS role, current_database() AS db, "
                "to_regclass('llm.personas') AS personas, "
                "to_regclass('llm.result_receipts') AS receipts, "
                "to_regclass('llm.checkpoints') AS checkpoints, "
                "(SELECT extra_cap_microusd FROM llm.ptr_provider_migration_budget "
                "WHERE id='python-split-45') AS cap"
            )
            identity = await cursor.fetchone()
            if (
                identity is None
                or identity["role"] != "ptr_split_llm"
                or identity["db"] not in ("ptr_split_test", "ptr_split_research")
                or not all(identity[k] for k in ("personas", "receipts", "checkpoints"))
                or identity["cap"] != 1_000_000
            ):
                raise ProviderError("RUNTIME_SCHEMA_NOT_READY")
        prompts = await load_prompt_snapshot(prompt_config, telemetry.client)
        personas = PostgresPersonaRepository(pool, settings.database_url)
        publication = _load_publication(env, settings.database_url)
        if publication:
            try:
                _published_cards(await personas.list(), publication)
            except CoreError:
                raise ProviderError("PERSONA_UNAVAILABLE") from None
        sources = PostgresSourceRepository(pool, settings.database_url)
        results = ResultReceiptStore(pool, settings.database_url)
        ledger = PostgresBudgetLedger(pool, settings.database_url)
        provider_name = env.get("PTR_LLM_PROVIDER", "fake")
        tokens = _integer(env, "PTR_LLM_MAX_OUTPUT_TOKENS", 512, 1, 4096)
        timeout_ms = _integer(env, "PTR_LLM_MODEL_TIMEOUT_MS", 30000, 100, 300000)
        input_bytes = _integer(
            env,
            "PTR_LLM_INPUT_BYTES",
            65536 if provider_name == "litellm" else 32768,
            1,
            1048576,
        )
        retrieval_index = env.get("PTR_LLM_RETRIEVAL_INDEX", "legacy")
        if retrieval_index not in ("legacy", "summary"):
            raise ProviderError("INVALID_RUNTIME_CONFIG")
        client = None
        need_openrouter = (
            provider_name == "openrouter"
            or env.get("PTR_LLM_INTENT_CLASSIFIER", "off") == "jev"
            or env.get("PTR_LLM_SAFETY_FILTER", "off") == "jev"
            or env.get("PTR_LLM_EMBEDDING_PROVIDER", "off") == "openrouter"
        )
        if need_openrouter:
            client = OpenRouterClient(
                api_key=env.get("OPENROUTER_API_KEY", ""),
                ledger=ledger,
                live_enabled=env.get("PTR_LLM_LIVE_ENABLED") == "1",
                allow_external_data=env.get("PTR_LLM_ALLOW_EXTERNAL_DATA") == "1",
                text_model=env.get("PTR_LLM_OPENROUTER_MODEL", "google/gemma-4-26b-a4b-it"),
                max_output_tokens=tokens,
                timeout_ms=timeout_ms,
                input_bytes=input_bytes,
            )
        if provider_name == "fake":
            model = "synthetic/fake-text-v1"
            provider = FakeTextProvider()
        elif provider_name == "litellm":
            model = env.get("PTR_LLM_MODEL", "primary")
            billable = env.get("PTR_LLM_LITELLM_BILLABLE", "0")
            provider = LiteLLMTextProvider(
                base_url=env.get("PTR_LLM_LITELLM_BASE_URL", ""),
                model=model,
                api_key=env.get("PTR_LLM_LITELLM_API_KEY", ""),
                max_output_tokens=tokens,
                timeout_ms=timeout_ms,
                input_bytes=input_bytes,
                ledger=ledger if billable == "1" else None,
                pricing_ceiling=pricing,
                on_metrics=_observe_provider_metrics,
                reservation_microusd=_integer(env, "PTR_LLM_MAX_CALL_MICROUSD", 100000, 1, 1000000),
            )
        elif provider_name == "openrouter" and client is not None:
            model, provider = client.model, client
        else:
            raise ProviderError("INVALID_RUNTIME_CONFIG")
        if not (
            provider_name == "openrouter"
            or provider_name == "litellm"
            and env.get("PTR_LLM_LITELLM_BILLABLE") == "1"
        ):
            provider = CheckpointedTextProvider(provider, AsyncPostgresSaver(pool))
        provider = ObservedProvider(provider, telemetry, model, prompts=prompts)
        provider.provider_name = provider_name
        embedding = None
        revision = env.get("PTR_LLM_EMBEDDING_MODEL_REVISION")
        if env.get("PTR_LLM_EMBEDDING_PROVIDER") == "openrouter" and client is not None:
            embedder = OpenRouterEmbeddingProvider(client)
            embedding = embedder.aembed_query
            revision = revision or "openai/text-embedding-3-small"
        retrieval = PostgresRetrieval(
            sources,
            embed=embedding,
            model_revision=revision,
            **({"summary_index": True} if retrieval_index == "summary" else {}),
        )
        intent_name, safety_name = (
            env.get("PTR_LLM_INTENT_CLASSIFIER", "off"),
            env.get("PTR_LLM_SAFETY_FILTER", "off"),
        )
        if intent_name not in ("off", "jev") or safety_name not in ("off", "jev"):
            raise ProviderError("INVALID_RUNTIME_CONFIG")
        from .core.routing import DEFAULT_SAFETY_THRESHOLDS

        safety_thresholds = dict(DEFAULT_SAFETY_THRESHOLDS)
        for category in safety_thresholds:
            key = f"PTR_LLM_SAFETY_THRESHOLD_{category.upper()}"
            try:
                threshold = float(env.get(key, str(safety_thresholds[category])))
            except ValueError:
                raise ProviderError("INVALID_RUNTIME_CONFIG") from None
            if not math.isfinite(threshold) or not 0 < threshold <= 1:
                raise ProviderError("INVALID_RUNTIME_CONFIG")
            safety_thresholds[category] = threshold
        try:
            min_confidence = float(env.get("PTR_LLM_JEV_MIN_CONFIDENCE", "0.6"))
        except ValueError:
            raise ProviderError("INVALID_RUNTIME_CONFIG") from None
        if not math.isfinite(min_confidence) or not 0 < min_confidence <= 1:
            raise ProviderError("INVALID_RUNTIME_CONFIG")
        decision_client = ObservedDecisions(client, telemetry) if client is not None else None
        engine = LLMEngine(
            provider=provider,
            personas=personas,
            retrieval=retrieval,
            telemetry=telemetry,
            semantic_search=embedding is not None,
            intent_classifier=JevIntentClassifier(decision_client)
            if intent_name == "jev"
            else None,
            input_safety=JevInputSafetyClassifier(decision_client)
            if safety_name == "jev"
            else None,
            safety_thresholds=safety_thresholds,
            min_intent_confidence=min_confidence,
            classifier_timeout_ms=_integer(env, "PTR_LLM_JEV_TIMEOUT_MS", 1500, 50, 10000),
            safety_timeout_ms=_integer(env, "PTR_LLM_SAFETY_TIMEOUT_MS", 2500, 50, 10000),
        )
        return Runtime(
            pool,
            personas,
            engine,
            results,
            provider,
            telemetry,
            provider_name,
            model,
            prompts=prompts,
            auxiliary_provider=client if provider_name != "openrouter" else None,
            publication=publication,
        )
    except BaseException:
        try:
            close = getattr(provider, "aclose", None)
            if close is not None:
                await close()
        finally:
            try:
                if client is not None:
                    await client.aclose()
            finally:
                try:
                    if telemetry is not None:
                        await asyncio.to_thread(telemetry.shutdown)
                finally:
                    await pool.close()
        raise
