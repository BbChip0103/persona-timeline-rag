"""Invocation-scoped, read-only LangChain bridges for the existing guarded schema."""

from __future__ import annotations

import asyncio
from collections.abc import Iterable, Iterator, Sequence
from typing import Any, Self

from langchain_classic.retrievers.multi_vector import MultiVectorRetriever
from langchain_core.documents import Document
from langchain_core.stores import BaseStore
from langchain_core.vectorstores import VectorStore, VectorStoreRetriever

from ptr_llm.core.errors import CoreError
from ptr_llm.core.langchain import PrivateAsyncRetriever, private_retrieve
from ptr_llm.providers.common import check_cancel

from .sources import PostgresSourceRepository, validate_source
from .summaries import validate_summary


class PrivateMultiVectorRetriever(PrivateAsyncRetriever, MultiVectorRetriever):
    """SDK multi-vector algorithm with the common private async boundary."""


class PrivateVectorStoreRetriever(PrivateAsyncRetriever, VectorStoreRetriever):
    """SDK single-vector algorithm with the common private async boundary."""


class ReadOnlyScopedVectorStore(VectorStore):
    """Request-local identity/date/evidence policy shared by SDK vector stores."""

    def __init__(
        self,
        sources: PostgresSourceRepository,
        query: dict[str, Any],
        trusted: dict[str, str],
        embed: Any,
        model_revision: str,
        signal: asyncio.Event | None,
        evidence_scope: str,
    ):
        self.sources = sources
        self.query, self.trusted = dict(query), dict(trusted)
        self.embed, self.model_revision = embed, model_revision
        self.signal, self.evidence_scope = signal, evidence_scope

    async def _query_vector(self, query: str, k: int, kwargs: dict[str, Any]) -> list[float]:
        check_cancel(self.signal)
        if (
            kwargs
            or query != self.query.get("query", "")
            or k != self.query["limit"]
            or self.evidence_scope not in ("caption", "caption_image")
        ):
            raise CoreError("INVALID_INPUT")
        vector = await self.embed(query, signal=self.signal, evidence_scope=self.evidence_scope)
        check_cancel(self.signal)
        return vector

    def similarity_search(self, query: str, k: int = 4, **kwargs: Any) -> list[Document]:
        raise NotImplementedError("async scoped similarity search only")

    @classmethod
    def from_texts(
        cls,
        texts: list[str],
        embedding: Any,
        metadatas: list[dict[str, Any]] | None = None,
        *,
        ids: list[str] | None = None,
        **kwargs: Any,
    ) -> Self:
        raise NotImplementedError("read-only vector index")

    async def aadd_texts(
        self,
        texts: Iterable[str],
        metadatas: list[dict[str, Any]] | None = None,
        *,
        ids: list[str] | None = None,
        **kwargs: Any,
    ) -> list[str]:
        raise NotImplementedError("read-only vector index")

    async def adelete(self, ids: list[str] | None = None, **kwargs: Any) -> bool | None:
        raise NotImplementedError("read-only vector index")

    async def amax_marginal_relevance_search(
        self, query: str, k: int = 4, fetch_k: int = 20, lambda_mult: float = 0.5, **kwargs: Any
    ) -> list[Document]:
        raise NotImplementedError("scoped cosine similarity only")

    async def asimilarity_search_with_score(
        self, query: str, k: int = 4, **kwargs: Any
    ) -> list[tuple[Document, float]]:
        raise NotImplementedError("scoped cosine similarity only")


class SummaryVectorStore(ReadOnlyScopedVectorStore):
    """Search summary children only, pinned to one complete immutable run."""

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
        super().__init__(sources, query, trusted, embed, model_revision, signal, evidence_scope)
        self.run_id = run_id
        self.bindings: dict[str, tuple[str, str]] = {}

    async def asimilarity_search(self, query: str, k: int = 4, **kwargs: Any) -> list[Document]:
        vector = await self._query_vector(query, k, kwargs)
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


class LegacyVectorStore(ReadOnlyScopedVectorStore):
    """Existing guarded caption/image SQL, dispatched by native SDK retriever."""

    async def asimilarity_search(self, query: str, k: int = 4, **kwargs: Any) -> list[Document]:
        vector = await self._query_vector(query, k, kwargs)
        sources = await self.sources.search_semantic(
            self.query,
            self.trusted,
            vector,
            self.model_revision,
            signal=self.signal,
            evidence_scope=self.evidence_scope,
        )
        check_cancel(self.signal)
        return [
            Document(page_content=source["caption"], metadata={"source": source})
            for source in sources
        ]


async def retrieve_legacy(
    sources: PostgresSourceRepository,
    query: dict[str, Any],
    trusted: dict[str, str],
    *,
    embed: Any,
    model_revision: str,
    signal: asyncio.Event | None,
    evidence_scope: str,
) -> list[dict[str, Any]]:
    vectorstore = LegacyVectorStore(
        sources, query, trusted, embed, model_revision, signal, evidence_scope
    )
    retriever = PrivateVectorStoreRetriever(
        vectorstore=vectorstore, search_kwargs={"k": query["limit"]}
    )
    documents = await private_retrieve(retriever, query.get("query", ""))
    return [document.metadata["source"] for document in documents]


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
    documents = await private_retrieve(retriever, query.get("query", ""))
    check_cancel(signal)
    found = [document.metadata["source"] for document in documents]
    summaries = {
        document.metadata["source"]["id"]: document.metadata["summary"] for document in documents
    }
    return found, summaries
