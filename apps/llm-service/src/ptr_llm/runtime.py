"""Python-only composition. No backend repository, session write or runtime DDL."""

from __future__ import annotations

import asyncio
import math
import os
from collections.abc import Mapping
from typing import Any

from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from .billing import PostgresBudgetLedger, ProviderError
from .config import Settings
from .core.runtime import LLMEngine
from .providers import (
    CheckpointedTextProvider,
    FakeTextProvider,
    JevEvidenceSelector,
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


def _integer(env: Mapping[str, str], key: str, default: int, low: int, high: int) -> int:
    try:
        result = int(env.get(key, str(default)))
    except ValueError:
        raise ProviderError("INVALID_RUNTIME_CONFIG") from None
    if not low <= result <= high:
        raise ProviderError("INVALID_RUNTIME_CONFIG")
    return result


class ObservedProvider:
    provider_name: str

    def __init__(self, provider: Any, telemetry: Telemetry, model: str):
        self.provider, self.telemetry, self.model = provider, telemetry, model

    def request_fingerprint(self, *args: Any, **kwargs: Any) -> str:
        return self.provider.request_fingerprint(*args, **kwargs)

    async def aclose(self) -> None:
        close = getattr(self.provider, "aclose", None)
        if close is not None:
            await close()

    async def generate(self, messages: Any, **options: Any) -> str:
        with self.telemetry.observation("model", as_type="generation", model=self.model) as span:
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

            return await self.provider.generate(messages, **dict(options, on_usage=usage))


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
    ):
        self.pool, self.personas, self.domain_engine = pool, personas, engine
        self.result_store, self.provider, self.telemetry = results, provider, telemetry
        self.provider_name, self.model = provider_name, model
        self.engine = self

    async def handle(self, grant: dict[str, Any], **options: Any) -> dict[str, Any]:
        # Domain engine owns the single root turn trace.
        return await self.domain_engine.handle(grant, **options)

    async def catalogue(self) -> list[dict[str, Any]]:
        from .core.persona import validate_persona

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
        personas = await self.personas.list()
        return [
            {key: persona[key] for key in fields if key in persona}
            for persona in (validate_persona(p) for p in personas)
        ]

    async def draft(self, body: dict[str, Any]) -> dict[str, Any]:
        # Use the configured domain engine, including the Jev fail-closed policy.
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
                await asyncio.to_thread(self.telemetry.shutdown)
            finally:
                await self.pool.close()


async def build_runtime(settings: Settings, env: Mapping[str, str] | None = None) -> Runtime:
    env = os.environ if env is None else env
    assert_llm_database_url(settings.database_url)
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
    telemetry = provider = None
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
        personas = PostgresPersonaRepository(pool, settings.database_url)
        sources = PostgresSourceRepository(pool, settings.database_url)
        results = ResultReceiptStore(pool, settings.database_url)
        ledger = PostgresBudgetLedger(pool, settings.database_url)
        provider_name = env.get("PTR_LLM_PROVIDER", "fake")
        tokens = _integer(env, "PTR_LLM_MAX_OUTPUT_TOKENS", 512, 1, 4096)
        timeout_ms = _integer(env, "PTR_LLM_MODEL_TIMEOUT_MS", 30000, 100, 300000)
        input_bytes = _integer(env, "PTR_LLM_INPUT_BYTES", 32768, 1, 1048576)
        selector_name = env.get("PTR_LLM_EVIDENCE_SELECTOR", "off")
        retrieval_index = env.get("PTR_LLM_RETRIEVAL_INDEX", "legacy")
        if (
            selector_name not in ("off", "jev")
            or retrieval_index not in ("legacy", "summary")
            or (selector_name == "jev") != (retrieval_index == "summary")
        ):
            raise ProviderError("INVALID_RUNTIME_CONFIG")
        try:
            evidence_threshold = float(env.get("PTR_LLM_EVIDENCE_THRESHOLD", "0.7"))
        except ValueError:
            raise ProviderError("INVALID_RUNTIME_CONFIG") from None
        if not math.isfinite(evidence_threshold) or not 0 < evidence_threshold <= 1:
            raise ProviderError("INVALID_RUNTIME_CONFIG")
        client = None
        need_openrouter = (
            provider_name == "openrouter"
            or env.get("PTR_LLM_INTENT_CLASSIFIER", "off") == "jev"
            or env.get("PTR_LLM_SAFETY_FILTER", "off") == "jev"
            or env.get("PTR_LLM_EMBEDDING_PROVIDER", "off") == "openrouter"
            or selector_name == "jev"
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
            if billable not in ("0", "1"):
                raise ProviderError("INVALID_RUNTIME_CONFIG")
            pricing = None
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
            provider = LiteLLMTextProvider(
                base_url=env.get("PTR_LLM_LITELLM_BASE_URL", ""),
                model=model,
                api_key=env.get("PTR_LLM_LITELLM_API_KEY", ""),
                max_output_tokens=tokens,
                timeout_ms=timeout_ms,
                input_bytes=input_bytes,
                ledger=ledger if billable == "1" else None,
                pricing_ceiling=pricing,
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
        provider = ObservedProvider(provider, telemetry, model)
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
        engine = LLMEngine(
            provider=provider,
            personas=personas,
            retrieval=retrieval,
            telemetry=telemetry,
            semantic_search=embedding is not None,
            evidence_selector=JevEvidenceSelector(client, threshold=evidence_threshold)
            if selector_name == "jev"
            else None,
            intent_classifier=JevIntentClassifier(client) if intent_name == "jev" else None,
            input_safety=JevInputSafetyClassifier(client) if safety_name == "jev" else None,
        )
        return Runtime(pool, personas, engine, results, provider, telemetry, provider_name, model)
    except BaseException:
        try:
            close = getattr(provider, "aclose", None)
            if close is not None:
                await close()
        finally:
            try:
                if telemetry is not None:
                    await asyncio.to_thread(telemetry.shutdown)
            finally:
                await pool.close()
        raise
