"""Candidate process-owned static-import GC phase, never a per-turn/library policy.

Only dedicated synchronous worker entrypoints use this context. New Runtime,
client, pool, task and job objects are created after freezing and remain collectible.
A process must not already own a frozen generation. Memory/performance gates are
required before adopting this candidate; freezing mutable module caches is a risk.
"""

from __future__ import annotations

import asyncio
import gc
import importlib
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

# Supported deployment is CPython 3.13. Never override a host's GC policy.
_DEFAULT_THRESHOLDS = (2000, 10, 10)
STATIC_MODULES = (
    "ptr_llm.runtime",
    "ptr_llm.core.guardrails",
    "langgraph.graph",
    "langgraph.pregel.main",
    "langgraph.checkpoint.postgres.aio",
    "langchain_core.language_models.chat_models",
    "langchain_openai",
    "langchain_openai.chat_models.base",
    "openai",
    "openai.resources.chat.completions.completions",
    "openai.types.chat",
    "langfuse",
    "jsonschema",
)


def _has_guardrails_rc() -> bool:
    # Metadata only. The pinned SDK's normal first import checks this HOME path.
    # Do not let eager priming open an existing personal configuration file.
    return (Path.home() / ".guardrailsrc").exists()


def _load_wire_schema() -> None:
    from .control import _wire_module

    _wire_module()  # Public versioned schema/classes only, no request validation.


def prime_static_imports() -> bool:
    """Import static classes/schema only; never construct a service or change GC.

    Guardrails may check an absent .guardrailsrc during its existing cold import;
    the application overrides its RC before any validator/client is constructed.
    No HOME, environment, SDK or builtins are patched by this bootstrap.
    """
    if _has_guardrails_rc():
        return False
    for name in STATIC_MODULES:
        importlib.import_module(name)
    _load_wire_schema()
    return True


def _eligible() -> bool:
    return (
        sys.implementation.name == "cpython"
        and sys.version_info[:2] == (3, 13)
        and gc.isenabled()
        and gc.get_threshold() == _DEFAULT_THRESHOLDS
        and gc.get_freeze_count() == 0
    )


@contextmanager
def static_import_gc() -> Iterator[bool]:
    """Yield ownership; unfreeze only our generation after the owning loop closes."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        pass
    else:
        yield False
        return
    if not _eligible() or not prime_static_imports() or not _eligible():
        yield False
        return
    # Import-return temporaries have been dropped. No live service object exists.
    gc.collect()
    if not _eligible():
        yield False
        return
    gc.freeze()
    try:
        yield True
    finally:
        gc.unfreeze()
