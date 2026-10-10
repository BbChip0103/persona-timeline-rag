"""Invocation-scoped, read-only LangChain bridges for the existing guarded schema."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Iterator, Sequence
from typing import Any

from langchain_classic.retrievers.multi_vector import MultiVectorRetriever
from langchain_core.callbacks import AsyncCallbackManagerForRetrieverRun
from langchain_core.documents import Document
from langchain_core.runnables.config import RunnableConfig, var_child_runnable_config
from langchain_core.stores import BaseStore
from langchain_core.vectorstores import VectorStore

from ptr_llm.core.errors import CoreError
from ptr_llm.providers.common import check_cancel

from .sources import PostgresSourceRepository, validate_source
from .summaries import validate_summary


class PrivateMultiVectorRetriever(MultiVectorRetriever):
    """Use SDK retrieval, without auto-configured raw-document callback export.

    Even callbacks=[] inherits SDK global debug/tracing/configure hooks. Bypass
    that lifecycle, not the SDK's actual child search/dedup/parent orchestration.
    Only this internal async entry point is supported, not streaming or tracing.
    """

    async def ainvoke(
        self,
        input: str,
        config: RunnableConfig | None = None,
        **kwargs: Any,
    ) -> list[Document]:
        if config or kwargs:
            raise CoreError("INVALID_INPUT")
        return await self._aget_relevant_documents(
            input,
            run_manager=AsyncCallbackManagerForRetrieverRun.get_noop_manager(),
        )

    def invoke(
        self,
        input: str,
        config: RunnableConfig | None = None,
        **kwargs: Any,
    ) -> list[Document]:
        raise NotImplementedError("private async retrieval only")


class SummaryVectorStore(VectorStore):
    """Search summary children only; scope cannot be changed by SDK search kwargs."""

    def __init__(
        self,
        sources: PostgresSourceRepository,
        query: dict[str, Any],
        trusted: dict[str, str],
        embed: Any,
        model_revision: str,
        run_id: str,
        signal: asyncio.Event | None,
        evidence_scope: str,
    ):
        self.sources = sources
        self.query, self.trusted = dict(query), dict(trusted)
        self.embed, self.model_revision, self.run_id = embed, model_revision, run_id
        self.signal, self.evidence_scope = signal, evidence_scope
        self.bindings: dict[str, tuple[str, str]] = {}

    async def asimilarity_search(self, query: str, k: int = 4, **kwargs: Any) -> list[Document]:
        check_cancel(self.signal)
        if kwargs or query != self.query.get("query", "") or k != self.query["limit"]:
            raise CoreError("INVALID_INPUT")
        vector = await self.embed(query, signal=self.signal, evidence_scope=self.evidence_scope)
        check_cancel(self.signal)
        rows = await self.sources.search_summary_children(
            self.query,
            self.trusted,
            vector,
            self.model_revision,
            signal=self.signal,
            summary_run_id=self.run_id,
        )
        check_cancel(self.signal)
        documents = []
        for row in rows:
            if any(
                not isinstance(row.get(key), str) or not row[key].strip()
                for key in ("source_id", "summary", "source_hash", "snapshot")
            ):
                raise CoreError("SUMMARY_SOURCE_STALE")
            key, binding = row["source_id"], (row["source_hash"], row["snapshot"])
            if key in self.bindings and self.bindings[key] != binding:
                raise CoreError("SUMMARY_SOURCE_STALE")
            self.bindings[key] = binding
            documents.append(Document(page_content=row["summary"], metadata={"source_id": key}))
        return documents

    def similarity_search(self, query: str, k: int = 4, **kwargs: Any) -> list[Document]:
        raise NotImplementedError("async scoped summary search only")

    @classmethod
    def from_texts(
        cls,
        texts: list[str],
        embedding: Any,
        metadatas: list[dict[str, Any]] | None = None,
        *,
        ids: list[str] | None = None,
        **kwargs: Any,
    ) -> SummaryVectorStore:
        raise NotImplementedError("read-only summary index")

    async def aadd_texts(
        self,
        texts: Iterable[str],
        metadatas: list[dict[str, Any]] | None = None,
        *,
        ids: list[str] | None = None,
        **kwargs: Any,
    ) -> list[str]:
        raise NotImplementedError("read-only summary index")

    async def adelete(self, ids: list[str] | None = None, **kwargs: Any) -> bool | None:
        raise NotImplementedError("read-only summary index")

    async def amax_marginal_relevance_search(
        self, query: str, k: int = 4, fetch_k: int = 20, lambda_mult: float = 0.5, **kwargs: Any
    ) -> list[Document]:
        raise NotImplementedError("scoped cosine similarity only")

    async def asimilarity_search_with_score(
        self, query: str, k: int = 4, **kwargs: Any
    ) -> list[tuple[Document, float]]:
        raise NotImplementedError("scoped cosine similarity only")


class OriginalDocumentStore(BaseStore[str, Document]):
    """Hydrate exact pinned parents; never silently drop a missing or changed hit."""

    def __init__(self, children: SummaryVectorStore):
        self.children = children

    async def amget(self, keys: Sequence[str]) -> list[Document | None]:
        children = self.children
        check_cancel(children.signal)
        if len(keys) > 100 or any(key not in children.bindings for key in keys):
            raise CoreError("SUMMARY_SOURCE_STALE")
        if not keys:
            return []
        rows = await children.sources.load_summary_parents(
            list(keys),
            children.trusted,
            summary_run_id=children.run_id,
            signal=children.signal,
            evidence_scope=children.evidence_scope,
        )
        check_cancel(children.signal)
        if set(rows) != set(keys):
            raise CoreError("SUMMARY_SOURCE_STALE")
        documents: list[Document | None] = []
        for key in keys:
            try:
                post = validate_source(rows[key]["source"])
                summary = validate_summary(rows[key]["summary"])
            except (CoreError, KeyError, TypeError):
                raise CoreError("SUMMARY_SOURCE_STALE") from None
            if (
                post["id"] != key
                or post["personId"] != children.trusted["personId"]
                or post["unsafe"]
                or (post["hash"], post["snapshot"]) != children.bindings[key]
            ):
                raise CoreError("SUMMARY_SOURCE_STALE")
            documents.append(
                Document(
                    page_content=post["caption"], metadata={"source": post, "summary": summary}
                )
            )
        return documents

    def mget(self, keys: Sequence[str]) -> list[Document | None]:
        raise NotImplementedError("async scoped parent reads only")

    def mset(self, key_value_pairs: Sequence[tuple[str, Document]]) -> None:
        raise NotImplementedError("read-only parent store")

    async def amset(self, key_value_pairs: Sequence[tuple[str, Document]]) -> None:
        raise NotImplementedError("read-only parent store")

    def mdelete(self, keys: Sequence[str]) -> None:
        raise NotImplementedError("read-only parent store")

    async def amdelete(self, keys: Sequence[str]) -> None:
        raise NotImplementedError("read-only parent store")

    def yield_keys(self, *, prefix: str | None = None) -> Iterator[str]:
        raise NotImplementedError("scoped parent IDs required")


async def retrieve_originals(
    sources: PostgresSourceRepository,
    query: dict[str, Any],
    trusted: dict[str, str],
    *,
    embed: Any,
    model_revision: str,
    run_id: str,
    signal: asyncio.Event | None,
    evidence_scope: str,
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    children = SummaryVectorStore(
        sources, query, trusted, embed, model_revision, run_id, signal, evidence_scope
    )
    retriever = PrivateMultiVectorRetriever(
        vectorstore=children,
        docstore=OriginalDocumentStore(children),
        id_key="source_id",
        search_kwargs={"k": query["limit"]},
    )
    # Do not inherit outer LangGraph callbacks/checkpoint metadata or private state.
    # The application's separate OTel context is intentionally left intact.
    token = var_child_runnable_config.set(None)
    try:
        documents = await retriever.ainvoke(query.get("query", ""))
    finally:
        var_child_runnable_config.reset(token)
    check_cancel(signal)
    found = [document.metadata["source"] for document in documents]
    summaries = {
        document.metadata["source"]["id"]: document.metadata["summary"] for document in documents
    }
    return found, summaries
