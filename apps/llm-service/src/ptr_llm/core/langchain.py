"""Private async SDK invocation: no raw-document auto callbacks or graph config."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

from langchain_core.callbacks import AsyncCallbackManager, AsyncCallbackManagerForRetrieverRun
from langchain_core.documents import Document
from langchain_core.retrievers import BaseRetriever
from langchain_core.runnables.config import RunnableConfig, var_child_runnable_config
from langchain_core.tracers import context as tracer_context
from langchain_core.utils.env import env_var_is_set
from langsmith import tracing_context

from ptr_llm.billing import ProviderError

from .errors import CoreError


@contextmanager
def private_sdk_scope() -> Iterator[None]:
    """Detach SDK callbacks per task, leaving redacted application OTel intact.

    The pinned SDK adds process-global debug/verbose and environment-created
    configure handlers even to empty callback managers. Those unsupported modes
    fail closed; never mutate their process-wide settings or registry. Runtime
    configuration must remain stable during a call. Recheck this private hook
    boundary when upgrading langchain-core/langgraph.
    """
    hooks = assert_private_sdk_configuration()
    variables = {
        id(variable): variable
        for variable in (
            tracer_context.tracing_v2_callback_var,
            tracer_context.run_collector_var,
            *(hook[0] for hook in hooks),
        )
    }
    tokens = [(variable, variable.set(None)) for variable in variables.values()]
    config_token = var_child_runnable_config.set(None)
    try:
        with tracing_context(enabled=False, parent=False, tags=[], metadata={}):
            yield
    finally:
        var_child_runnable_config.reset(config_token)
        for variable, token in reversed(tokens):
            variable.reset(token)


def assert_private_sdk_configuration() -> tuple[Any, ...]:
    """Reject unsupported raw logging before reserving a paid request."""
    from langchain_core.globals import get_debug, get_verbose

    hooks = tuple(tracer_context._configure_hooks)
    if get_debug() or get_verbose() or any(
        env_var is not None and handler_class is not None and env_var_is_set(env_var)
        for _, _, handler_class, env_var in hooks
    ):
        raise ProviderError("SDK_RAW_TRACING_FORBIDDEN")
    return hooks


async def private_ainvoke(
    runnable: Any, value: Any, config: RunnableConfig | None = None, **kwargs: Any
) -> Any:
    """Use native SDK algorithms without automatic raw-payload callbacks."""
    if config and config.get("callbacks"):
        raise ProviderError("SDK_RAW_TRACING_FORBIDDEN")
    with private_sdk_scope():
        return await runnable.ainvoke(value, config, **kwargs)


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
