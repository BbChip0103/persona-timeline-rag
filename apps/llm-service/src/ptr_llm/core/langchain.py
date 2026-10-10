"""Private async SDK invocation: no raw-document auto callbacks or graph config."""

from typing import Any

from langchain_core.callbacks import AsyncCallbackManager, AsyncCallbackManagerForRetrieverRun
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from langchain_core.runnables.config import RunnableConfig, var_child_runnable_config

from .errors import CoreError


class PrivateAsyncRetriever(BaseRetriever):
    """Keep native retrieval algorithms, bypass the SDK's auto-tracing lifecycle.

    Native compression passes a child callback manager. Only its empty/no-op
    configuration is accepted, and it is never installed or used for export.
    Standard traced/streamed retrieval is not exposed by application adapters.
    """

    async def ainvoke(
        self,
        input: str,
        config: RunnableConfig | None = None,
        **kwargs: Any,
    ) -> list[Document]:
        if config:
            callbacks = config.get("callbacks")
            if (
                set(config) != {"callbacks"}
                or type(callbacks) is not AsyncCallbackManager
                or callbacks.handlers
                or callbacks.inheritable_handlers
                or callbacks.tags
                or callbacks.inheritable_tags
                or callbacks.metadata
                or callbacks.inheritable_metadata
            ):
                raise CoreError("INVALID_INPUT")
        if kwargs:
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


async def private_retrieve(retriever: BaseRetriever, query: str) -> list[Document]:
    # Leave independent redacted application OTel context intact.
    token = var_child_runnable_config.set(None)
    try:
        return await retriever.ainvoke(query)
    finally:
        var_child_runnable_config.reset(token)
