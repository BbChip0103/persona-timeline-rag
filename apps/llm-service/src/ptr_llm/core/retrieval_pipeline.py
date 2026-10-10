"""Native retrieve/compress pipeline; JEV's provider and evidence policy stay explicit."""

from collections.abc import Sequence
from typing import Any

from langchain_classic.retrievers.contextual_compression import ContextualCompressionRetriever
from langchain_core.callbacks import AsyncCallbackManagerForRetrieverRun
from langchain_core.documents import BaseDocumentCompressor, Document

from .errors import CoreError
from .langchain import PrivateAsyncRetriever


class ScopedSourceRetriever(PrivateAsyncRetriever):
    """Application-scoped source loader used by native contextual compression."""

    load: Any
    query: str

    def _get_relevant_documents(self, query: str, *, run_manager: Any) -> list[Document]:
        raise NotImplementedError("private async retrieval only")

    async def _aget_relevant_documents(
        self,
        query: str,
        *,
        run_manager: AsyncCallbackManagerForRetrieverRun,
    ) -> list[Document]:
        if query != self.query:
            raise CoreError("INVALID_INPUT")
        return await self.load()


class PrivateCompressionRetriever(PrivateAsyncRetriever, ContextualCompressionRetriever):
    """Native retrieve→compress algorithm without automatic raw-data callbacks."""


class JevDocumentCompressor(BaseDocumentCompressor):
    """Provider-specific integration: keep variable evidence count and original docs."""

    selector: Any
    seed: str
    signal: Any
    deadline_at: float
    before_costly: Any
    check: Any

    def compress_documents(
        self,
        documents: Sequence[Document],
        query: str,
        callbacks: Any = None,
    ) -> Sequence[Document]:
        raise NotImplementedError("private async evidence selection only")

    async def acompress_documents(
        self,
        documents: Sequence[Document],
        query: str,
        callbacks: Any = None,
    ) -> Sequence[Document]:
        self.check()
        if len(documents) > 20 or len({doc.metadata["source"]["id"] for doc in documents}) != len(
            documents
        ):
            raise CoreError("TURN_FAILED", "EVIDENCE_SELECTION_INVALID")
        candidates = [
            {
                "id": doc.metadata["source"]["id"],
                "summary": doc.metadata["summary"],
                "postedAt": doc.metadata["source"]["postedAt"],
                "eventDate": doc.metadata["source"]["eventDate"],
            }
            for doc in documents
        ]
        await self.before_costly()
        selected = await self.selector.select(
            {"query": query, "candidates": candidates, "seed": self.seed},
            signal=self.signal,
            deadline_at=self.deadline_at,
            before_costly=self.before_costly,
        )
        self.check()
        by_id = {doc.metadata["source"]["id"]: doc for doc in documents}
        if (
            not isinstance(selected, list)
            or any(not isinstance(sid, str) for sid in selected)
            or len(set(selected)) != len(selected)
            or set(selected) - set(by_id)
        ):
            raise CoreError("TURN_FAILED", "EVIDENCE_SELECTION_INVALID")
        return [by_id[sid] for sid in selected]


def source_documents(sources: list[dict[str, Any]], summaries: Any) -> list[Document]:
    if len(sources) > 20 or len({s["id"] for s in sources}) != len(sources):
        raise CoreError("TURN_FAILED", "EVIDENCE_SELECTION_INVALID")
    if not isinstance(summaries, dict) or set(summaries) != {s["id"] for s in sources}:
        raise CoreError("TURN_FAILED", "SUMMARY_UNAVAILABLE")
    return [
        Document(
            page_content=source["caption"],
            metadata={"source": source, "summary": summaries[source["id"]]},
        )
        for source in sources
    ]
