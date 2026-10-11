#!/usr/bin/env python3
"""Pinned Proxy callback contracts; synthetic state and no network/model calls."""

import asyncio
import copy
import inspect
import os
import sys
import types
import unittest
from unittest.mock import patch

# Import-time singleton needs a shared salt, but does not connect to Redis.
os.environ.setdefault("LITELLM_SALT_KEY", "synthetic-routing-test-salt")

import httpx
import litellm
from fastapi import HTTPException
from litellm.litellm_core_utils.streaming_handler import CustomStreamWrapper
from litellm.proxy.utils import ProxyLogging
from litellm.router import CustomRoutingStrategyBase
from litellm.types.utils import Delta, ModelResponseStream, StreamingChoices
from ptr_routing import (
    DEADLINE,
    MODEL_GROUP,
    PREFILLED,
    REQUEST,
    TOKEN,
    RoutingCallback,
    Strategy,
    _native_filter_scope,
    reservation,
)

# The application venv intentionally lacks the Proxy's optional server packages.
# Stub only its router global; the Router and extension APIs remain real.
proxy_server = types.ModuleType("litellm.proxy.proxy_server")
proxy_server.llm_router = None


def engine(identity="first"):
    return {
        "model_name": MODEL_GROUP,
        "model_info": {"id": identity},
        "litellm_params": {
            "model": "openai/synthetic",
            "api_base": "http://127.0.0.1:9999/v1",
            "api_key": "synthetic",
        },
    }


class FakeState:
    def __init__(self):
        self.choice = "first"
        self.error = None
        self.selected = []
        self.active = set()
        self.release_calls = []
        self.finished = []
        self.prefill_calls = []
        self.prefilled_tokens = set()

    async def select(self, candidates, messages, output_tokens, token, *, options):
        self.selected.append((candidates, messages, output_tokens, token, options))
        if self.error:
            raise self.error
        if self.choice is not None:
            self.active.add(token)
        return self.choice

    async def release(self, token, *, success):
        self.release_calls.append((token, success))
        if token in self.active:
            self.active.remove(token)
            self.finished.append((token, success))

    async def prefilled(self, token):
        self.prefill_calls.append(token)
        if token in self.active:
            self.prefilled_tokens.add(token)


class FakeRouter:
    # Exercise the real installed attachment API, not a mock setter.
    set_custom_routing_strategy = litellm.Router.set_custom_routing_strategy

    def __init__(self):
        self.routing_strategy = "simple-shuffle"
        self.model_list = [engine(), engine("filtered-out")]
        self.healthy = [self.model_list[0]]
        self.native_calls = []
        self.healthy_calls = []
        self.precall_error = None
        self.precall_calls = []
        self.provider_delay = 0
        self.provider_cancelled = False

    async def _acompletion(self, model, messages, **kwargs):
        if model != MODEL_GROUP:
            self.native_calls.append(("provider-other", kwargs))
            return "native-provider-other-alias"
        await self.async_get_available_deployment(
            model=model, messages=messages, request_kwargs=kwargs
        )
        try:
            await asyncio.sleep(self.provider_delay)
        except asyncio.CancelledError:
            self.provider_cancelled = True
            raise
        return "synthetic-response"

    async def async_get_available_deployment(self, **kwargs):
        self.native_calls.append(("async", kwargs))
        return "native-other-alias"

    def get_available_deployment(self, **kwargs):
        self.native_calls.append(("sync", kwargs))
        return "native-sync-other-alias"

    async def async_get_healthy_deployments(self, **kwargs):
        self.healthy_calls.append(kwargs)
        return self.healthy

    async def _async_override_selector_pre_call_check(self, *args):
        self.precall_calls.append(args)
        if self.precall_error:
            raise self.precall_error

    def reset_selection(self):
        # Exactly what Router._reset_custom_routing_strategy removes.
        self.__dict__.pop("get_available_deployment", None)
        self.__dict__.pop("async_get_available_deployment", None)
        self.__dict__.pop("_acompletion", None)


class CallbackTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.proxy_module_patch = patch.dict(
            sys.modules, {"litellm.proxy.proxy_server": proxy_server}
        )
        self.proxy_module_patch.start()
        self.state = FakeState()
        self.callback = RoutingCallback(self.state)
        self.callback.queue_timeout = 0
        self.router = FakeRouter()
        self.poll_started = 0

        async def no_network_poll():
            self.poll_started += 1
            await asyncio.Event().wait()

        self.callback._poll = no_network_poll

    async def asyncTearDown(self):
        await self.callback.aclose()
        self.proxy_module_patch.stop()

    async def prehook(self, data, router=None, call_type="completion"):
        with patch.object(proxy_server, "llm_router", router or self.router):
            return await self.callback.async_pre_call_hook(None, None, data, call_type)

    async def select(self, data=None, model=MODEL_GROUP, **kwargs):
        data = data if data is not None else {}
        data.setdefault("metadata", {}).setdefault(DEADLINE, asyncio.get_running_loop().time() + 25)
        return await self.router.async_get_available_deployment(
            model=model,
            request_kwargs=data,
            messages=[{"role": "user", "content": "synthetic"}],
            **kwargs,
        )

    async def test_capacity_spillover_selects_paid_before_submission_only(self):
        await self.prehook({"model": MODEL_GROUP})
        self.callback.spillover = True
        self.state.choice = None
        selected = await self.select({"metadata": {"_ptr_budget_authorized": True}})
        self.assertEqual(selected, "native-other-alias")
        self.assertEqual(self.router.native_calls[0][1]["model"], "openrouter-primary")
        self.assertEqual(self.state.active, set())
        self.state.error = ConnectionError("synthetic-store")
        with self.assertRaises(HTTPException):
            await self.select({"metadata": {"_ptr_budget_authorized": True}})
        self.assertEqual(len(self.router.native_calls), 1)

    async def test_capacity_admission_requires_signed_body_and_consumes_nonce_once(self):
        import time

        from persona_timeline_rag.gateway_budget import HEADER, sign_request

        self.callback.spillover = True
        self.callback.budget_key = "synthetic-budget-key-at-least-32-characters"
        for i, deployment in enumerate(self.router.model_list):
            deployment["model_info"]["id"] = ("primary", "secondary")[i]
        self.router.model_list.append(
            {
                "model_name": "openrouter-primary",
                "model_info": {"id": "openrouter-primary"},
                "litellm_params": {
                    "model": "openrouter/synthetic",
                    "api_key": "synthetic",
                    "max_retries": 0,
                    "extra_body": {
                        "provider": {
                            "allow_fallbacks": False,
                            "require_parameters": True,
                            "order": ["DeepInfra"],
                            "max_price": {"prompt": 0.1, "completion": 0.5},
                        }
                    },
                },
            }
        )
        claimed = set()

        async def claim(nonce):
            if nonce in claimed:
                return False
            claimed.add(nonce)
            return True

        self.state.claim_budget = claim
        body = {
            "model": MODEL_GROUP,
            "messages": [{"role": "user", "content": "synthetic"}],
            "max_completion_tokens": 512,
        }

        def request():
            data = copy.deepcopy(body)
            data["proxy_server_request"] = {
                "url": "http://127.0.0.1/v1/chat/completions",
                "method": "POST",
                "headers": {
                    HEADER: sign_request(
                        body,
                        self.callback.budget_key,
                        "a" * 64,
                        int(time.time() * 1000) + 25000,
                        20000,
                    )
                },
            }
            return data

        approved = await self.prehook(request())
        self.assertTrue(approved["metadata"]["_ptr_budget_authorized"])
        self.assertNotIn(HEADER, approved["proxy_server_request"]["headers"])
        with self.assertRaises(HTTPException) as failure:
            await self.prehook(request())
        self.assertEqual(failure.exception.status_code, 409)
        with self.assertRaises(HTTPException):
            await self.prehook({"model": "openrouter-primary"})
        bad = request()
        bad["messages"] = []
        with self.assertRaises(HTTPException) as failure:
            await self.prehook(bad)
        self.assertEqual(failure.exception.status_code, 403)
        self.assertEqual(len(claimed), 1)

    async def test_real_strategy_attachment_and_same_router_reset_no_recursion(self):
        await self.prehook({"model": MODEL_GROUP})
        strategy = self.router.async_get_available_deployment.__self__
        self.assertIsInstance(strategy, Strategy)
        self.assertIsInstance(strategy, CustomRoutingStrategyBase)
        self.router.reset_selection()
        await self.prehook({"model": MODEL_GROUP})
        self.assertIs(self.router.async_get_available_deployment.__self__, strategy)
        self.assertIs(self.router._acompletion.__self__, strategy)
        self.assertEqual(await self.select(model="openrouter-primary"), "native-other-alias")
        self.assertEqual(len(self.router.native_calls), 1)
        await asyncio.sleep(0)
        self.assertEqual(self.poll_started, 1)

    async def test_replacement_router_gets_its_own_strategy(self):
        await self.prehook({"model": MODEL_GROUP})
        first = self.router.async_get_available_deployment.__self__
        replacement = FakeRouter()
        await self.prehook({"model": MODEL_GROUP}, replacement)
        self.assertIsNot(replacement.async_get_available_deployment.__self__, first)
        self.assertIs(replacement.async_get_available_deployment.__self__.router, replacement)
        self.assertIs(self.callback._router, replacement)

    async def test_only_native_filtered_deployments_are_ranked(self):
        await self.prehook({"model": MODEL_GROUP})
        data = {"max_completion_tokens": 37}
        self.assertIs(await self.select(data), self.router.healthy[0])
        self.assertEqual([item["id"] for item in self.state.selected[0][0]], ["first"])
        self.assertEqual(self.state.selected[0][2], 37)
        self.assertEqual(len(self.router.healthy_calls), 1)
        self.assertEqual(len(self.router.precall_calls), 1)
        self.assertEqual(self.router.native_calls, [])
        self.assertEqual(len(reservation(data)), 32)

    async def test_credit_wait_keeps_native_consumed_order_and_exclusions(self):
        await self.prehook({"model": MODEL_GROUP})
        self.callback.queue_timeout = 0.5
        observed = []
        native_select = self.state.select

        async def consuming_filter(**kwargs):
            data = kwargs["request_kwargs"]
            observed.append((data.pop("_target_order"), data.pop("_excluded_deployment_ids")))
            return self.router.healthy

        async def temporarily_full(*args, **kwargs):
            self.state.choice = None if not self.state.selected else "first"
            return await native_select(*args, **kwargs)

        self.router.async_get_healthy_deployments = consuming_filter
        self.state.select = temporarily_full
        data = {"_target_order": 2, "_excluded_deployment_ids": ["filtered-out"]}
        await self.select(data)
        self.assertEqual(observed, [(2, ["filtered-out"]), (2, ["filtered-out"])])
        self.assertEqual(data["_target_order"], 2)
        self.assertEqual(data["_excluded_deployment_ids"], ["filtered-out"])
        self.assertEqual(self.state.selected[0][3], self.state.selected[1][3])

    async def test_initial_and_nonstream_wall_guard_cancels_provider_and_releases(self):
        await self.prehook({"model": MODEL_GROUP})
        self.router.provider_delay = 1
        timeout_at = asyncio.timeout_at
        deadlines = []

        def shortened_deadline(value):
            deadlines.append(value)
            return timeout_at(asyncio.get_running_loop().time() + 0.02)

        with patch("ptr_routing.asyncio.timeout_at", shortened_deadline):
            with self.assertRaises(HTTPException) as failure:
                await self.router._acompletion(
                    model=MODEL_GROUP,
                    messages=[{"role": "user", "content": "synthetic"}],
                )
        self.assertEqual(failure.exception.status_code, 504)
        self.assertEqual(failure.exception.detail, "PTR_ROUTING_TOTAL_DEADLINE")
        self.assertTrue(self.router.provider_cancelled)
        self.assertEqual(self.state.active, set())
        self.assertEqual(len(self.state.finished), 1)
        self.assertFalse(self.state.finished[0][1])
        self.assertGreater(deadlines[0], asyncio.get_running_loop().time() + 24)

    async def test_other_alias_provider_call_keeps_native_path(self):
        await self.prehook({"model": MODEL_GROUP})
        self.assertEqual(
            await self.router._acompletion(model="other", messages=[]),
            "native-provider-other-alias",
        )
        self.assertEqual(self.state.selected, [])

    async def test_no_fit_rejects_without_native_random_or_other_alias(self):
        await self.prehook({"model": MODEL_GROUP})
        self.state.choice = None
        with self.assertRaises(HTTPException) as failure:
            await self.select()
        self.assertEqual(failure.exception.status_code, 503)
        self.assertEqual(failure.exception.detail, "PTR_ROUTING_NO_CREDIT")
        self.assertEqual(len(self.state.selected), 1)
        self.assertEqual(self.router.native_calls, [])
        self.assertEqual(self.state.active, set())

    async def test_native_precall_failure_releases_reserved_token(self):
        await self.prehook({"model": MODEL_GROUP})
        self.router.precall_error = RuntimeError("synthetic-precall")
        with self.assertRaisesRegex(RuntimeError, "synthetic-precall"):
            await self.select()
        self.assertEqual(self.state.active, set())
        self.assertEqual(len(self.state.finished), 1)
        self.assertFalse(self.state.finished[0][1])
        self.assertEqual(self.router.native_calls, [])

    async def test_native_precall_cancellation_releases_before_propagating(self):
        await self.prehook({"model": MODEL_GROUP})
        self.router.precall_error = asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.select()
        self.assertEqual(self.state.active, set())
        self.assertFalse(self.state.finished[0][1])

    async def test_native_filter_rejection_cannot_trigger_other_alias_fallback(self):
        await self.prehook({"model": MODEL_GROUP})

        async def reject(**kwargs):
            raise HTTPException(403, "synthetic-model-access-denied")

        self.router.async_get_healthy_deployments = reject
        with self.assertRaises(HTTPException) as failure:
            await self.select()
        self.assertEqual(failure.exception.status_code, 403)
        self.assertEqual(self.state.selected, [])
        self.assertEqual(self.router.native_calls, [])

    async def test_store_failure_is_closed_and_does_not_delegate(self):
        await self.prehook({"model": MODEL_GROUP})
        self.state.error = ConnectionError("synthetic-store")
        with self.assertRaises(HTTPException) as failure:
            await self.select()
        self.assertEqual(failure.exception.detail, "PTR_ROUTING_STORE_UNAVAILABLE")
        self.assertEqual(failure.exception.status_code, 503)
        self.assertEqual(self.router.native_calls, [])

    async def test_invalid_shared_state_is_not_bypassed(self):
        await self.prehook({"model": MODEL_GROUP})
        self.state.error = ValueError("synthetic-invalid-state")
        with self.assertRaises(HTTPException) as failure:
            await self.select()
        self.assertEqual(failure.exception.detail, "PTR_ROUTING_INVALID_STATE")
        self.assertEqual(self.router.native_calls, [])

    async def test_other_alias_delegates_and_primary_sync_rejects(self):
        await self.prehook({"model": MODEL_GROUP})
        self.assertEqual(await self.select(model="openrouter-primary"), "native-other-alias")
        self.assertEqual(
            self.router.get_available_deployment(model="other"), "native-sync-other-alias"
        )
        with self.assertRaises(HTTPException):
            self.router.get_available_deployment(model=MODEL_GROUP)
        self.assertEqual(self.state.selected, [])
        self.assertEqual(len(self.router.native_calls), 2)

    async def test_nested_tokens_success_failure_and_duplicates_are_idempotent(self):
        await self.prehook({"model": MODEL_GROUP})
        data = {}
        await self.select(data)
        token = reservation(data)
        nested = {"litellm_params": {"metadata": {TOKEN: token}}}
        self.assertEqual(reservation(nested), token)
        self.assertEqual(
            reservation({"litellm_params": {"litellm_metadata": {TOKEN: token}}}), token
        )
        response = types.SimpleNamespace(
            choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="synthetic"))]
        )
        self.assertIs(
            await self.callback.async_post_call_success_deployment_hook(
                nested, response, "completion"
            ),
            response,
        )
        await self.callback.async_post_call_success_hook(data, None, response)
        await self.callback.async_post_call_failure_deployment_hook(
            nested, RuntimeError(), "completion"
        )
        await self.callback.async_post_call_failure_hook(data, RuntimeError(), None)
        self.assertEqual(self.state.finished, [(token, True)])
        self.assertEqual(self.state.active, set())

        failed = {}
        await self.select(failed)
        failed_token = reservation(failed)
        await self.callback.async_post_call_failure_hook(failed, RuntimeError(), None)
        await self.callback.async_post_call_success_hook(failed, None, response)
        self.assertEqual(self.state.finished[-1], (failed_token, False))
        self.assertEqual(len(self.state.finished), 2)

    async def test_primary_retries_timeout_and_incoming_tokens_are_normalized(self):
        data = {
            "model": MODEL_GROUP,
            "num_retries": 20,
            "max_retries": 9,
            "timeout": 1000,
            "disable_fallbacks": False,
            "metadata": {TOKEN: "a" * 32, "safe": "synthetic"},
            "litellm_metadata": {TOKEN: "b" * 32, PREFILLED: True, DEADLINE: 999999999},
        }
        self.assertIs(await self.prehook(data), data)
        self.assertEqual(data["num_retries"], 0)
        self.assertEqual(data["max_retries"], 0)
        self.assertEqual(data["timeout"], 25)
        self.assertTrue(data["disable_fallbacks"])
        self.assertIsNone(reservation(data, reserved_only=True))
        self.assertNotEqual(data["metadata"][REQUEST], "a" * 32)
        self.assertEqual(len(reservation(data)), 32)
        self.assertNotIn(PREFILLED, data["litellm_metadata"])
        self.assertNotIn(DEADLINE, data["litellm_metadata"])
        self.assertEqual(data["metadata"]["safe"], "synthetic")

    async def test_pinned_proxy_async_completion_route_is_supported(self):
        data = {"model": MODEL_GROUP, "num_retries": 8}
        await self.prehook(data, call_type="acompletion")
        self.assertEqual(data["num_retries"], 0)
        self.assertTrue(data["disable_fallbacks"])
        self.assertEqual(self.router.async_get_available_deployment.__self__.owner, self.callback)

    async def test_nonprimary_sdk_retry_override_is_not_normalized(self):
        data = {"model": "openrouter-primary", "num_retries": 7, "max_retries": 9}
        await self.prehook(data, call_type="acompletion")
        self.assertEqual(data["num_retries"], 7)
        self.assertEqual(data["max_retries"], 9)
        self.assertEqual(self.state.selected, [])

    async def test_original_proxy_request_releases_copied_router_reservation(self):
        original = {"model": MODEL_GROUP, "stream": True}
        await self.prehook(original, call_type="acompletion")
        copied = copy.deepcopy(original)
        await self.select(copied)
        token = original["metadata"][REQUEST]
        self.assertNotIn(TOKEN, original["metadata"])
        self.assertEqual(copied["metadata"][TOKEN], token)
        self.assertEqual(self.state.selected[0][3], token)

        async def source():
            yield "synthetic-original-request"

        logging = object.__new__(ProxyLogging)
        with patch.object(litellm, "callbacks", [self.callback]):
            wrapped = logging.async_post_call_streaming_iterator_hook(
                response=source(),
                user_api_key_dict=types.SimpleNamespace(request_route=None),
                request_data=original,
            )
            self.assertEqual([item async for item in wrapped], ["synthetic-original-request"])
        self.assertEqual(self.state.finished, [(token, True)])
        self.assertEqual(self.state.active, set())

    async def test_proxy_iterator_resolved_string_prefills_typed_chunks_without_sdk_hook(self):
        original = {"model": MODEL_GROUP, "stream": True}
        await self.prehook(original, call_type="acompletion")
        await self.select(copy.deepcopy(original))
        token = reservation(original)
        chunks = [
            ModelResponseStream(choices=[StreamingChoices(delta=Delta(role="assistant"))]),
            ModelResponseStream(choices=[StreamingChoices(delta=Delta(content="synthetic"))]),
            ModelResponseStream(choices=[StreamingChoices(delta=Delta(content="-tail"))]),
        ]

        async def source():
            for chunk in chunks:
                yield chunk

        # Config resolution is a separate startup concern. Exercise the real
        # Proxy capability cache and iterator after resolving its string entry;
        # leave the global callback list string-only (SDK hooks cannot see it).
        logging = object.__new__(ProxyLogging)
        with (
            patch.object(litellm, "callbacks", ["ptr_routing.router"]),
            patch.dict(ProxyLogging._callback_capabilities_cache, {}, clear=True),
            patch(
                "litellm.litellm_core_utils.litellm_logging.get_custom_logger_compatible_class",
                return_value=self.callback,
            ) as resolve,
        ):
            sdk = CustomStreamWrapper(
                completion_stream=iter(()),
                model="openai/synthetic",
                custom_llm_provider="openai",
                logging_obj=types.SimpleNamespace(
                    model_call_details={"litellm_params": {"metadata": original["metadata"]}},
                    call_type="acompletion",
                ),
            )
            await sdk._call_post_streaming_deployment_hook(chunks[1])
            self.assertEqual(self.state.prefill_calls, [])
            wrapped = logging.async_post_call_streaming_iterator_hook(
                response=source(),
                user_api_key_dict=types.SimpleNamespace(request_route=None),
                request_data=original,
            )
            self.assertIs(await anext(wrapped), chunks[0])
            self.assertEqual(self.state.prefill_calls, [])
            self.assertEqual(self.state.active, {token})
            self.assertIs(await anext(wrapped), chunks[1])
            self.assertEqual(self.state.prefill_calls, [token])
            self.assertEqual(self.state.active, {token})
            self.assertIs(await anext(wrapped), chunks[2])
            self.assertEqual(self.state.prefill_calls, [token])
            with self.assertRaises(StopAsyncIteration):
                await anext(wrapped)
            resolve.assert_called_once_with("ptr_routing.router")
        self.assertEqual(self.state.finished, [(token, True)])
        self.assertEqual(self.state.active, set())

    async def test_proxy_iterator_prefill_then_upstream_failure_closes_and_releases(self):
        original = {"model": MODEL_GROUP, "stream": True}
        await self.prehook(original, call_type="acompletion")
        await self.select(copy.deepcopy(original))
        token = reservation(original)
        closed = asyncio.Event()
        chunk = ModelResponseStream(choices=[StreamingChoices(delta=Delta(content="synthetic"))])

        async def source():
            try:
                yield chunk
                raise RuntimeError("synthetic-upstream-failure")
            finally:
                closed.set()

        logging = object.__new__(ProxyLogging)
        with (
            patch.object(litellm, "callbacks", ["ptr_routing.router"]),
            patch.dict(ProxyLogging._callback_capabilities_cache, {}, clear=True),
            patch(
                "litellm.litellm_core_utils.litellm_logging.get_custom_logger_compatible_class",
                return_value=self.callback,
            ),
        ):
            wrapped = logging.async_post_call_streaming_iterator_hook(
                response=source(),
                user_api_key_dict=types.SimpleNamespace(request_route=None),
                request_data=original,
            )
            self.assertIs(await anext(wrapped), chunk)
            self.assertEqual(self.state.prefill_calls, [token])
            self.assertEqual(self.state.active, {token})
            with self.assertRaisesRegex(RuntimeError, "synthetic-upstream-failure"):
                await anext(wrapped)
        self.assertTrue(closed.is_set())
        self.assertEqual(self.state.finished, [(token, False)])
        self.assertEqual(self.state.active, set())

    async def test_real_proxy_iterator_enforces_original_deadline_despite_metadata_copy(self):
        original = {"model": MODEL_GROUP, "stream": True}
        await self.prehook(original, call_type="acompletion")
        original["metadata"][DEADLINE] = asyncio.get_running_loop().time() + 0.04
        copied = copy.deepcopy(original)
        await self.select(copied)
        token = original["metadata"][REQUEST]
        closed = asyncio.Event()
        received = []

        async def source():
            try:
                while True:
                    await asyncio.sleep(0.003)
                    yield "synthetic-drip"
            finally:
                closed.set()

        logging = object.__new__(ProxyLogging)
        with patch.object(litellm, "callbacks", [self.callback]):
            wrapped = logging.async_post_call_streaming_iterator_hook(
                response=source(),
                user_api_key_dict=types.SimpleNamespace(request_route=None),
                request_data=original,
            )
            with self.assertRaises(TimeoutError):
                async for chunk in wrapped:
                    received.append(chunk)
        self.assertNotIn(TOKEN, original["metadata"])
        self.assertGreater(len(received), 1)
        self.assertTrue(closed.is_set())
        self.assertEqual(self.state.finished, [(token, False)])
        self.assertEqual(self.state.active, set())

    async def test_keepalive_style_new_task_per_chunk_preserves_absolute_deadline(self):
        original = {"model": MODEL_GROUP, "stream": True}
        await self.prehook(original, call_type="acompletion")
        original["metadata"][DEADLINE] = asyncio.get_running_loop().time() + 0.04
        await self.select(copy.deepcopy(original))
        token = original["metadata"][REQUEST]
        closed = asyncio.Event()
        delivered = []
        actual_deadline_seen = []

        async def source():
            try:
                while True:
                    await asyncio.sleep(0.004)
                    yield "synthetic-new-task-chunk"
            finally:
                closed.set()

        wrapped = self.callback.async_post_call_streaming_iterator_hook(None, source(), original)

        async def advance_in_new_tasks():
            try:
                while True:
                    # Pinned Proxy keepalive handling uses a new Task for anext.
                    delivered.append(await asyncio.create_task(anext(wrapped)))
            except TimeoutError:
                actual_deadline_seen.append(True)
                raise

        with self.assertRaises(TimeoutError):
            await asyncio.wait_for(advance_in_new_tasks(), timeout=0.2)
        self.assertEqual(actual_deadline_seen, [True])
        self.assertGreater(len(delivered), 1)
        self.assertTrue(closed.is_set())
        self.assertEqual(self.state.finished, [(token, False)])
        self.assertEqual(self.state.active, set())

    async def test_already_expired_deadline_rejects_ready_buffered_stream(self):
        original = {"model": MODEL_GROUP, "stream": True}
        await self.prehook(original, call_type="acompletion")
        await self.select(copy.deepcopy(original))
        original["metadata"][DEADLINE] = asyncio.get_running_loop().time() - 1
        consumed = []

        async def source():
            for index in range(3):
                consumed.append(index)
                yield "synthetic-immediate-buffer"

        wrapped = self.callback.async_post_call_streaming_iterator_hook(None, source(), original)
        with self.assertRaises(TimeoutError):
            await anext(wrapped)
        self.assertEqual(consumed, [])

    async def test_downstream_backpressure_cannot_resume_ready_stream_past_deadline(self):
        original = {"model": MODEL_GROUP, "stream": True}
        await self.prehook(original, call_type="acompletion")
        await self.select(copy.deepcopy(original))
        original["metadata"][DEADLINE] = asyncio.get_running_loop().time() + 0.03
        consumed = []
        closed = asyncio.Event()

        async def source():
            try:
                consumed.append("first")
                yield "synthetic-first"
                consumed.append("second")
                yield "synthetic-buffered-second"
            finally:
                closed.set()

        wrapped = self.callback.async_post_call_streaming_iterator_hook(None, source(), original)
        self.assertEqual(await asyncio.create_task(anext(wrapped)), "synthetic-first")
        await asyncio.sleep(0.04)
        with self.assertRaises(TimeoutError):
            await asyncio.create_task(anext(wrapped))
        self.assertEqual(consumed, ["first"])
        self.assertTrue(closed.is_set())
        self.assertEqual(self.state.active, set())

    async def test_metrics_drip_body_has_total_deadline_closes_and_polls_again(self):
        self.callback.metrics_timeout = 0.02
        self.callback.options["telemetry_poll_s"] = 0.01
        self.router.model_list = [engine()]
        self.callback._router = self.router
        streams = []
        next_poll = asyncio.Event()
        real_client = httpx.AsyncClient

        class DripMetrics(httpx.AsyncByteStream):
            def __init__(self):
                self.closed = False

            async def __aiter__(self):
                while True:
                    await asyncio.sleep(0.003)
                    yield b"# synthetic-drip\n"

            async def aclose(self):
                self.closed = True

        def response(request):
            stream = DripMetrics()
            streams.append(stream)
            if len(streams) >= 2:
                next_poll.set()
            return httpx.Response(200, stream=stream)

        def mock_client(**kwargs):
            return real_client(transport=httpx.MockTransport(response), **kwargs)

        # This test exercises the actual implementation, not the no-IO setup stub.
        with patch("ptr_routing.httpx.AsyncClient", mock_client):
            task = asyncio.create_task(RoutingCallback._poll(self.callback))
            try:
                await asyncio.wait_for(next_poll.wait(), timeout=0.3)
                self.assertTrue(streams[0].closed)
            finally:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(all(stream.closed for stream in streams))

    async def test_bounded_call_preserves_pre_hook_request_and_earlier_deadline(self):
        original = {"model": MODEL_GROUP, "stream": False}
        await self.prehook(original, call_type="acompletion")
        original["metadata"][DEADLINE] = asyncio.get_running_loop().time() + 0.02
        self.router.provider_delay = 1
        with self.assertRaises(HTTPException) as failure:
            await self.router._acompletion(
                messages=[{"role": "user", "content": "synthetic"}],
                **copy.deepcopy(original),
            )
        self.assertEqual(failure.exception.status_code, 504)
        self.assertTrue(self.router.provider_cancelled)
        self.assertEqual(self.state.finished, [(original["metadata"][REQUEST], False)])

    async def test_strategy_public_signature_matches_installed_extension_base(self):
        for name in ("get_available_deployment", "async_get_available_deployment"):
            with self.subTest(method=name):
                base = inspect.signature(getattr(CustomRoutingStrategyBase, name))
                actual = inspect.signature(getattr(Strategy, name))
                self.assertEqual(tuple(actual.parameters), tuple(base.parameters))
                for parameter in base.parameters:
                    self.assertEqual(
                        actual.parameters[parameter].kind, base.parameters[parameter].kind
                    )
                    self.assertEqual(
                        actual.parameters[parameter].default, base.parameters[parameter].default
                    )

    async def test_nonprimary_pre_hook_does_not_force_primary_policy(self):
        data = {"model": "openrouter-primary", "timeout": 17, "metadata": {TOKEN: "a" * 32}}
        await self.prehook(data)
        self.assertNotIn("num_retries", data)
        self.assertNotIn("disable_fallbacks", data)
        self.assertEqual(data["timeout"], 17)
        self.assertIsNone(reservation(data))
        self.assertEqual(await self.select(model=data["model"]), "native-other-alias")
        self.assertEqual(self.state.selected, [])

    async def test_primary_malicious_overrides_and_nonchat_are_rejected(self):
        for name in (
            "api_base",
            "base_url",
            "api_key",
            "specific_deployment",
            "silent_model",
            "fallbacks",
            "context_window_fallbacks",
            "content_policy_fallbacks",
            "extra_body",
            "model_list",
            "routing_strategy",
        ):
            with self.subTest(name=name):
                with self.assertRaises(HTTPException) as failure:
                    await self.prehook({"model": MODEL_GROUP, name: "synthetic"})
                self.assertEqual(failure.exception.status_code, 400)
        with self.assertRaises(HTTPException):
            await self.prehook({"model": MODEL_GROUP}, call_type="embedding")
        self.assertEqual(self.state.selected, [])

    async def test_stream_initial_success_and_first_chunks_hold_reservation(self):
        await self.prehook({"model": MODEL_GROUP, "stream": True})
        data = {"stream": True}
        await self.select(data)
        token = reservation(data)
        response = types.SimpleNamespace(
            choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="synthetic"))]
        )
        await self.callback.async_post_call_success_deployment_hook(data, response, "completion")
        for _ in range(2):
            self.assertIs(
                await self.callback.async_post_call_streaming_deployment_hook(
                    data, response, "completion"
                ),
                response,
            )
        self.assertEqual(self.state.active, {token})
        self.assertEqual(self.state.finished, [])
        self.assertEqual(self.state.prefilled_tokens, {token})
        self.assertEqual(self.state.prefill_calls, [token])

    async def test_prefilled_once_marker_works_in_nested_logging_carrier(self):
        await self.prehook({"model": MODEL_GROUP, "stream": True})
        data = {}
        await self.select(data)
        token = reservation(data)
        nested = {"litellm_params": {"litellm_metadata": data["metadata"]}}
        chunk = types.SimpleNamespace(
            choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="synthetic"))]
        )
        for _ in range(3):
            await self.callback.async_post_call_streaming_deployment_hook(
                nested, chunk, "acompletion"
            )
        self.assertEqual(self.state.prefill_calls, [token])
        self.assertTrue(nested["litellm_params"]["litellm_metadata"][PREFILLED])

    async def test_request_only_original_proxy_metadata_prefills_once(self):
        original = {"model": MODEL_GROUP, "stream": True}
        await self.prehook(original, call_type="acompletion")
        copied = copy.deepcopy(original)
        await self.select(copied)
        token = reservation(original)
        self.assertNotIn(TOKEN, original["metadata"])
        self.assertEqual(copied["metadata"][TOKEN], token)
        chunk = types.SimpleNamespace(
            choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="synthetic"))]
        )
        for _ in range(3):
            await self.callback.async_post_call_streaming_deployment_hook(
                original, chunk, "acompletion"
            )
        self.assertEqual(self.state.prefill_calls, [token])
        self.assertTrue(original["metadata"][PREFILLED])
        self.assertEqual(self.state.active, {token})

    async def test_real_stream_wrapper_request_only_nested_metadata_prefills_once(self):
        original = {"model": MODEL_GROUP, "stream": True}
        await self.prehook(original, call_type="acompletion")
        await self.select(copy.deepcopy(original))
        token = reservation(original)
        logging_data = {"litellm_params": {"metadata": original["metadata"]}}
        self.assertNotIn(TOKEN, logging_data["litellm_params"]["metadata"])
        logging_obj = types.SimpleNamespace(
            model_call_details=logging_data, call_type="acompletion"
        )
        wrapper = CustomStreamWrapper(
            completion_stream=iter(()),
            model="openai/synthetic",
            logging_obj=logging_obj,
            custom_llm_provider="openai",
        )
        role = types.SimpleNamespace(
            choices=[types.SimpleNamespace(delta=types.SimpleNamespace(role="assistant"))]
        )
        chunk = types.SimpleNamespace(
            choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content="synthetic"))]
        )
        with patch.object(litellm, "callbacks", [self.callback]):
            self.assertIs(await wrapper._call_post_streaming_deployment_hook(role), role)
            self.assertEqual(self.state.prefill_calls, [])
            for _ in range(3):
                self.assertIs(await wrapper._call_post_streaming_deployment_hook(chunk), chunk)
        self.assertEqual(self.state.prefill_calls, [token])
        self.assertTrue(logging_data["litellm_params"]["metadata"][PREFILLED])
        self.assertEqual(self.state.active, {token})

    async def test_filter_scope_rejects_unwrapped_primary_and_preserves_other_alias(self):
        healthy = self.router.healthy
        with self.assertRaises(HTTPException) as failure:
            await self.callback.async_filter_deployments(MODEL_GROUP, healthy, [])
        self.assertEqual(failure.exception.detail, "PTR_ROUTING_SELECTOR_REQUIRED")
        self.assertIs(await self.callback.async_filter_deployments("other", healthy, []), healthy)
        self.assertEqual(self.state.selected, [])

    async def test_native_filter_scope_is_allowed_only_inside_strategy(self):
        await self.prehook({"model": MODEL_GROUP})

        async def native_filter(**kwargs):
            self.assertTrue(_native_filter_scope.get())
            return await self.callback.async_filter_deployments(
                kwargs["model"], self.router.healthy, kwargs["messages"]
            )

        self.router.async_get_healthy_deployments = native_filter
        self.assertIs(await self.select(), self.router.healthy[0])
        self.assertFalse(_native_filter_scope.get())

        async def failed_filter(**kwargs):
            self.assertTrue(_native_filter_scope.get())
            raise RuntimeError("synthetic-filter-failure")

        self.router.async_get_healthy_deployments = failed_filter
        with self.assertRaisesRegex(RuntimeError, "synthetic-filter-failure"):
            await self.select()
        self.assertFalse(_native_filter_scope.get())

    async def test_real_unwrapped_router_cannot_bypass_shared_admission(self):
        real = litellm.Router(model_list=[engine()], routing_strategy="simple-shuffle")
        with patch.object(litellm, "callbacks", [self.callback]):
            with self.assertRaises(HTTPException) as failure:
                await real.async_get_available_deployment(
                    model=MODEL_GROUP, messages=[], request_kwargs={}
                )
        self.assertEqual(failure.exception.detail, "PTR_ROUTING_SELECTOR_REQUIRED")
        self.assertEqual(self.state.selected, [])

    async def test_role_only_and_empty_stream_chunks_do_not_release_prefill(self):
        await self.prehook({"model": MODEL_GROUP, "stream": True})
        data = {"stream": True}
        await self.select(data)
        for delta in (
            types.SimpleNamespace(role="assistant"),
            types.SimpleNamespace(content="", tool_calls=[]),
        ):
            await self.callback.async_post_call_streaming_deployment_hook(
                data,
                types.SimpleNamespace(choices=[types.SimpleNamespace(delta=delta)]),
                "acompletion",
            )
        self.assertEqual(self.state.prefill_calls, [])
        self.assertEqual(self.state.active, {reservation(data)})

    async def test_continuous_stream_still_obeys_total_deadline_and_closes_upstream(self):
        await self.prehook({"model": MODEL_GROUP, "stream": True})
        data = {"stream": True}
        await self.select(data)
        token = reservation(data)
        data["metadata"][DEADLINE] = asyncio.get_running_loop().time() + 0.03
        closed = asyncio.Event()
        delivered = []

        async def dripping():
            try:
                while True:
                    await asyncio.sleep(0.003)
                    yield "synthetic-token"
            finally:
                closed.set()

        wrapped = self.callback.async_post_call_streaming_iterator_hook(None, dripping(), data)
        with self.assertRaises(TimeoutError):
            async for chunk in wrapped:
                delivered.append(chunk)
        self.assertGreater(len(delivered), 1)
        self.assertTrue(closed.is_set())
        self.assertEqual(self.state.finished, [(token, False)])
        self.assertEqual(self.state.active, set())

    async def test_reserved_stream_missing_deadline_closes_and_releases_false(self):
        await self.prehook({"model": MODEL_GROUP, "stream": True})
        data = {}
        await self.select(data)
        token = reservation(data)
        data["metadata"].pop(DEADLINE)
        closed = []

        class Source:
            def __aiter__(self):
                return self

            async def __anext__(self):
                raise AssertionError("missing deadline must reject before source consumption")

            async def aclose(self):
                closed.append(True)

        source = Source()
        wrapped = self.callback.async_post_call_streaming_iterator_hook(None, source, data)
        with self.assertRaises(HTTPException) as failure:
            await anext(wrapped)
        self.assertEqual(failure.exception.detail, "PTR_ROUTING_DEADLINE_REQUIRED")
        self.assertEqual(closed, [True])
        self.assertEqual(self.state.finished, [(token, False)])

    async def test_reserved_stream_nested_logging_deadline_is_supported(self):
        await self.prehook({"model": MODEL_GROUP, "stream": True})
        data = {}
        await self.select(data)
        token = reservation(data)
        nested = {"litellm_params": {"litellm_metadata": data["metadata"]}}

        async def source():
            yield "synthetic-nested-stream"

        wrapped = self.callback.async_post_call_streaming_iterator_hook(None, source(), nested)
        self.assertEqual([item async for item in wrapped], ["synthetic-nested-stream"])
        self.assertEqual(self.state.finished, [(token, True)])

    async def test_other_alias_stream_without_reservation_is_not_deadline_wrapped(self):
        async def source():
            yield "synthetic-native-other"

        wrapped = self.callback.async_post_call_streaming_iterator_hook(None, source(), {})
        self.assertEqual([item async for item in wrapped], ["synthetic-native-other"])
        self.assertEqual(self.state.release_calls, [])

    async def test_stream_iterator_completion_releases_success_once(self):
        await self.prehook({"model": MODEL_GROUP, "stream": True})
        data = {"stream": True}
        await self.select(data)
        token = reservation(data)

        async def chunks():
            yield "synthetic-first"
            yield "synthetic-last"

        wrapped = self.callback.async_post_call_streaming_iterator_hook(None, chunks(), data)
        self.assertEqual([item async for item in wrapped], ["synthetic-first", "synthetic-last"])
        await self.callback.async_log_success_event(
            {"litellm_params": {"metadata": data["metadata"]}}, None, None, None
        )
        self.assertEqual(self.state.finished, [(token, True)])
        self.assertEqual(self.state.active, set())

    async def test_stream_iterator_close_releases_failure_despite_late_success(self):
        await self.prehook({"model": MODEL_GROUP, "stream": True})
        data = {"stream": True}
        await self.select(data)
        token = reservation(data)

        async def chunks():
            yield "synthetic-first"
            yield "synthetic-last"

        source = chunks()
        wrapped = self.callback.async_post_call_streaming_iterator_hook(None, source, data)
        self.assertEqual(await anext(wrapped), "synthetic-first")
        await wrapped.aclose()
        await source.aclose()
        await self.callback.async_log_success_event(
            {"litellm_params": {"metadata": data["metadata"]}}, None, None, None
        )
        self.assertEqual(self.state.finished, [(token, False)])
        self.assertEqual(self.state.active, set())

    async def test_stream_iterator_cancellation_releases_failure(self):
        await self.prehook({"model": MODEL_GROUP, "stream": True})
        data = {"stream": True}
        await self.select(data)
        token = reservation(data)
        waiting = asyncio.Event()

        async def chunks():
            waiting.set()
            await asyncio.Event().wait()
            yield "unreachable"

        wrapped = self.callback.async_post_call_streaming_iterator_hook(None, chunks(), data)
        task = asyncio.create_task(anext(wrapped))
        await waiting.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.state.finished, [(token, False)])
        self.assertEqual(self.state.active, set())

    async def test_missing_router_and_incompatible_config_fail_closed(self):
        with patch.object(proxy_server, "llm_router", None):
            with self.assertRaises(HTTPException):
                await self.callback.async_pre_call_hook(
                    None, None, {"model": MODEL_GROUP}, "completion"
                )
        self.router.routing_strategy = "least-busy"
        with self.assertRaises(HTTPException) as failure:
            await self.prehook({"model": MODEL_GROUP})
        self.assertEqual(failure.exception.detail, "PTR_ROUTING_INCOMPATIBLE_ROUTER_CONFIG")

    async def test_resubmission_rejected_before_state_or_native_selection(self):
        await self.prehook({"model": MODEL_GROUP})
        with self.assertRaises(HTTPException) as failure:
            await self.select({"metadata": {TOKEN: "a" * 32}})
        self.assertEqual(failure.exception.status_code, 409)
        self.assertEqual(self.state.selected, [])
        self.assertEqual(self.router.healthy_calls, [])

    async def test_real_native_router_attachment_and_selection_only(self):
        real = litellm.Router(
            model_list=[engine()],
            routing_strategy="simple-shuffle",
            num_retries=0,
            max_fallbacks=0,
            fallbacks=[],
        )
        self.callback.attach(real)
        strategy = real.async_get_available_deployment.__self__
        self.assertIsInstance(strategy, CustomRoutingStrategyBase)
        selected = await real.async_get_available_deployment(
            model=MODEL_GROUP,
            request_kwargs={},
            messages=[{"role": "user", "content": "synthetic"}],
        )
        self.assertEqual(selected["model_info"]["id"], "first")
        real._reset_custom_routing_strategy()
        self.callback.attach(real)
        self.assertIs(real.async_get_available_deployment.__self__, strategy)

    async def test_real_native_router_groups_cannot_be_silently_bypassed(self):
        real = litellm.Router(
            model_list=[engine()],
            routing_strategy="simple-shuffle",
            routing_groups=[
                {
                    "group_name": "synthetic-group",
                    "models": [MODEL_GROUP],
                    "routing_strategy": "simple-shuffle",
                }
            ],
        )
        with self.assertRaises(HTTPException) as failure:
            self.callback.attach(real)
        self.assertEqual(failure.exception.detail, "PTR_ROUTING_INCOMPATIBLE_ROUTER_CONFIG")


if __name__ == "__main__":
    unittest.main()
