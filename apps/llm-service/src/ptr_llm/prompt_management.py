"""Startup-only pinned Langfuse policies; private prompt variables stay local."""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType, SimpleNamespace
from typing import Any, cast

import httpx
from langfuse import Langfuse
from langfuse.api.core.client_wrapper import SyncClientWrapper
from langfuse.api.core.request_options import RequestOptions
from langfuse.api.prompts.client import PromptsClient
from langfuse.model import TextPromptClient

from .billing import ProviderError

_POLICY_DIRECTORY = Path(__file__).parent / "core"
_LOCAL_POLICIES = {
    "experiment": json.loads((_POLICY_DIRECTORY / "prompt_policy.json").read_text()),
    "legacy": json.loads((_POLICY_DIRECTORY / "legacy_prompt_policy.json").read_text()),
}
# This generic, public policy bundle contains no persona, source or turn data.
LOCAL_POLICY_TEXT = json.dumps(
    _LOCAL_POLICIES, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False
)
LOCAL_POLICY_SHA256 = hashlib.sha256(LOCAL_POLICY_TEXT.encode()).hexdigest()


@dataclass(frozen=True)
class PromptManagementConfig:
    mode: str = "local"
    name: str | None = None
    version: int | None = None
    approved_sha256: str | None = None
    fetch_timeout_seconds: int = 1

    def validate(self) -> None:
        if self.mode == "local":
            return
        if (
            self.mode != "langfuse"
            or not self.name
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_./-]{0,99}", self.name)
            or type(self.version) is not int
            or not 1 <= self.version <= 1_000_000
            or self.approved_sha256 != LOCAL_POLICY_SHA256
            or type(self.fetch_timeout_seconds) is not int
            or not 1 <= self.fetch_timeout_seconds <= 2
        ):
            raise ProviderError("INVALID_RUNTIME_CONFIG")

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> PromptManagementConfig:
        if env.get("PTR_LLM_PROMPT_MANAGEMENT", "local") == "local":
            return cls()
        try:
            version = env.get("PTR_LLM_PROMPT_VERSION")
            config = cls(
                mode=env.get("PTR_LLM_PROMPT_MANAGEMENT", "local"),
                name=env.get("PTR_LLM_PROMPT_NAME"),
                version=int(version) if version is not None else None,
                approved_sha256=env.get("PTR_LLM_PROMPT_SHA256"),
                fetch_timeout_seconds=int(env.get("PTR_LLM_PROMPT_FETCH_TIMEOUT_SECONDS", "1")),
            )
        except ValueError:
            raise ProviderError("INVALID_RUNTIME_CONFIG") from None
        config.validate()
        return config


@dataclass(frozen=True)
class PromptSnapshot:
    experiment: Mapping[str, str] = field(repr=False)
    legacy: Mapping[str, str] = field(repr=False)
    source: str
    reason: str
    sha256: str = LOCAL_POLICY_SHA256
    name: str | None = None
    requested_version: int | None = None
    sdk_prompt: TextPromptClient | None = field(default=None, repr=False, compare=False)

    def metadata(self) -> dict[str, Any]:
        return {
            "promptSource": self.source,
            "promptReason": self.reason,
            "promptSha256": self.sha256,
            **({"promptName": self.name} if self.name else {}),
            **(
                {"promptRequestedVersion": self.requested_version}
                if self.requested_version is not None
                else {}
            ),
            **({"promptVersion": self.requested_version} if self.source == "langfuse" else {}),
        }


def _snapshot(
    config: PromptManagementConfig,
    reason: str,
    prompt: TextPromptClient | None = None,
) -> PromptSnapshot:
    policies = json.loads(prompt.prompt if prompt is not None else LOCAL_POLICY_TEXT)
    return PromptSnapshot(
        experiment=MappingProxyType(policies["experiment"]),
        legacy=MappingProxyType(policies["legacy"]),
        source="langfuse" if prompt is not None else "local",
        reason=reason,
        name=config.name,
        requested_version=config.version,
        sdk_prompt=prompt,
    )


LOCAL_PROMPT_SNAPSHOT = _snapshot(PromptManagementConfig(), "offline")
_CURRENT_PROMPT: ContextVar[PromptSnapshot] = ContextVar(
    "ptr_prompt_snapshot", default=LOCAL_PROMPT_SNAPSHOT
)
_APPLIED_PROMPT: ContextVar[PromptSnapshot | None] = ContextVar("ptr_applied_prompt", default=None)


def current_prompt_snapshot() -> PromptSnapshot:
    return _CURRENT_PROMPT.get()


def mark_prompt_applied(policy: str) -> None:
    # Association describes the generic policy bundle, never the assembled
    # persona/history/evidence/turn prompt. Draft-only/manual prompts do not mark it.
    snapshot = current_prompt_snapshot()
    experiment, legacy = snapshot.experiment, snapshot.legacy
    approved = (
        experiment["EXPERIMENT_POLICY"],
        experiment["EXPERIMENT_POLICY"].split("TIMELINE_JSON_REPLY:")[0]
        + experiment["recollectionVoice"]
        + experiment["protocol"],
        legacy["base"] + legacy["timeline"],
        legacy["base"] + legacy["smallTalk"],
    )
    _APPLIED_PROMPT.set(snapshot if policy in approved else None)


def applied_prompt(snapshot: PromptSnapshot) -> TextPromptClient | None:
    return snapshot.sdk_prompt if _APPLIED_PROMPT.get() is snapshot else None


@contextmanager
def prompt_scope(snapshot: PromptSnapshot) -> Iterator[None]:
    current_token = _CURRENT_PROMPT.set(snapshot)
    applied_token = _APPLIED_PROMPT.set(None)
    try:
        yield
    finally:
        _APPLIED_PROMPT.reset(applied_token)
        _CURRENT_PROMPT.reset(current_token)


@dataclass(frozen=True)
class _ApprovedEndpoint:
    base_url: str = field(repr=False)
    headers: Mapping[str, str] = field(repr=False)


def _approved_endpoint(client: Any) -> _ApprovedEndpoint:
    # SDK 4.17 bridge: copy values, not resources or a live shared transport.
    wrapper = client.api._client_wrapper
    return _ApprovedEndpoint(wrapper.get_base_url(), MappingProxyType(dict(wrapper.get_headers())))


class _NoPromptCache:
    """Native fetch-only facade never owns a refresh executor or shared cache."""

    def get(self, *_args: Any) -> None:
        return None

    def set(self, *_args: Any) -> None:
        pass

    def delete(self, *_args: Any) -> None:
        pass


class _ReadOnlyPrompts:
    def __init__(self, client: PromptsClient):
        self.client = client

    def get(self, name: str, **options: Any) -> Any:
        request_options = cast(
            RequestOptions, {**(options.pop("request_options", None) or {}), "max_retries": 0}
        )
        try:
            return self.client.get(name, **options, request_options=request_options)
        except Exception:
            # Native get_prompt logs its exception. Never let response bodies or
            # headers reach that logger (or our provenance) through this bridge.
            raise ProviderError("PROMPT_FETCH_FAILED") from None


def _read_only_sdk(endpoint: _ApprovedEndpoint, transport: httpx.Client) -> Any:
    wrapper = SyncClientWrapper(
        base_url=endpoint.base_url,
        headers=dict(endpoint.headers),
        timeout=transport.timeout.read,
        httpx_client=transport,
    )
    # Do not call Langfuse.__init__: it initializes shared singleton resources,
    # tracing/export and prompt-refresh workers. Reuse unchanged native get_prompt.
    facade: Any = object.__new__(Langfuse)
    facade._resources = SimpleNamespace(
        api=SimpleNamespace(prompts=_ReadOnlyPrompts(PromptsClient(client_wrapper=wrapper))),
        prompt_cache=_NoPromptCache(),
    )
    return facade


def _owned_http_client(timeout_seconds: int) -> httpx.Client:
    return httpx.Client(timeout=timeout_seconds, trust_env=False, follow_redirects=False)


def _fetch_prompt(config: PromptManagementConfig, endpoint: _ApprovedEndpoint) -> Any:
    # Cancellation can abandon to_thread, but cannot close this transport while
    # its request is running. Worker-only ownership closes it on eventual exit.
    with _owned_http_client(config.fetch_timeout_seconds) as transport:
        return _read_only_sdk(endpoint, transport).get_prompt(
            config.name,
            version=config.version,
            type="text",
            cache_ttl_seconds=0,
            max_retries=0,
            fetch_timeout_seconds=config.fetch_timeout_seconds,
        )


async def load_prompt_snapshot(config: PromptManagementConfig, client: Any) -> PromptSnapshot:
    """Prefetch once off-loop; the resulting runtime snapshot never refreshes."""
    config.validate()
    if config.mode == "local":
        return LOCAL_PROMPT_SNAPSHOT
    if client is None:
        return _snapshot(config, "client_disabled")
    try:
        endpoint = _approved_endpoint(client)
        # Avoid stale SDK cache entries initiating background refreshes. Our
        # immutable runtime snapshot is the cache, not the turn hot path.
        async with asyncio.timeout(config.fetch_timeout_seconds + 0.25):
            prompt = await asyncio.to_thread(_fetch_prompt, config, endpoint)
    except TimeoutError:
        return _snapshot(config, "fetch_timeout")
    except Exception:
        # No response body, exception text, or credentials in trace provenance.
        return _snapshot(config, "unavailable")
    if not isinstance(prompt, TextPromptClient):
        return _snapshot(config, "type_mismatch")
    if prompt.is_fallback:
        return _snapshot(config, "sdk_fallback")
    if prompt.name != config.name:
        return _snapshot(config, "name_mismatch")
    if type(prompt.version) is not int or prompt.version != config.version:
        return _snapshot(config, "version_mismatch")
    try:
        if (
            not isinstance(prompt.prompt, str)
            or hashlib.sha256(prompt.prompt.encode()).hexdigest() != config.approved_sha256
        ):
            return _snapshot(config, "content_mismatch")
        return _snapshot(config, "verified", prompt)
    except (UnicodeError, ValueError, TypeError):
        return _snapshot(config, "content_mismatch")
