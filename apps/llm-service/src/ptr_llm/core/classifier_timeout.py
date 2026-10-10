"""Native classifier node SLA; abort and nonblocking transport cleanup stay explicit."""

import asyncio
from functools import lru_cache
from typing import Any, TypedDict

from langgraph.errors import NodeTimeoutError
from langgraph.graph import END, START, StateGraph
from langgraph.runtime import Runtime
from langgraph.types import TimeoutPolicy

from .langchain import private_ainvoke


class Classification(TypedDict, total=False):
    value: Any


class ClassifierContext(TypedDict):
    work: Any
    task: Any


def _consume(task: asyncio.Task) -> None:
    if not task.cancelled():
        task.exception()  # Retrieve late failures without logging provider bodies.


def _cancel(task: asyncio.Task | None) -> None:
    if task is not None and not task.done() and not task.cancelling():
        task.cancel()


@lru_cache(maxsize=32)
def classifier_graph(timeout_ms: int):
    builder = StateGraph(Classification, context_schema=ClassifierContext)

    async def classify(state, runtime: Runtime[ClassifierContext]):
        context = runtime.context
        task = asyncio.create_task(context["work"])
        context["task"] = task
        task.add_done_callback(_consume)
        try:
            # Shield lets the native node timer return without waiting for a
            # provider that suppresses cancellation or performs slow settlement.
            return {"value": await asyncio.shield(task)}
        finally:
            _cancel(task)

    builder.add_node(
        "classify",
        classify,
        timeout=TimeoutPolicy(run_timeout=timeout_ms / 1000),
        retry_policy=None,
    )
    builder.add_edge(START, "classify")
    builder.add_edge("classify", END)
    return builder.compile()  # No checkpoint, raw context, cache or replay.


async def bounded(work, timeout_ms, cancelled=None):
    context: ClassifierContext = {"work": work, "task": None}
    invocation = abort = None
    try:
        if cancelled is not None and cancelled.is_set():
            raise RuntimeError("aborted")
        if timeout_ms <= 0:
            raise TimeoutError()
        invocation = asyncio.create_task(
            private_ainvoke(classifier_graph(timeout_ms), {}, context=context)
        )
        abort = asyncio.create_task(cancelled.wait()) if cancelled is not None else None
        done, _ = await asyncio.wait(
            [invocation] + ([abort] if abort is not None else []),
            return_when=asyncio.FIRST_COMPLETED,
        )
        if abort is not None and abort in done:
            raise RuntimeError("aborted")
        try:
            return invocation.result()["value"]
        except NodeTimeoutError:
            raise TimeoutError() from None
    finally:
        # Absolute grant/lease policy remains upstream. No costly attempt is
        # retried and late transport results cannot become classifier answers.
        for task in (invocation, abort, context["task"]):
            _cancel(task)
        if context["task"] is None:
            close = getattr(work, "close", None)
            if close is not None:
                close()
        if invocation is not None:
            invocation.add_done_callback(_consume)
