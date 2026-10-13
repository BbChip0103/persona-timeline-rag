#!/usr/bin/env python3
"""K8s LiteLLM budget gate contracts; synthetic state and no provider calls."""

import copy
import os
import sys
import time
import types
import unittest
from unittest.mock import patch

from fastapi import HTTPException

from persona_timeline_rag.gateway_budget import HEADER, sign_request, sign_spillover_request

KEY = "synthetic-budget-gate-secret-at-least-32-bytes"
os.environ.setdefault("PTR_LLM_CAPACITY_SPILLOVER_KEY", KEY)

proxy_server = types.ModuleType("litellm.proxy.proxy_server")
proxy_server.llm_router = None
sys.modules["litellm.proxy.proxy_server"] = proxy_server

import ptr_budget_gate  # noqa: E402


class FakeNonceStore:
    def __init__(self):
        self.claims = []
        self.ttls = []
        self.claimed = set()
        self.error = None

    async def claim(self, nonce, ttl_seconds=35):
        self.claims.append(nonce)
        self.ttls.append(ttl_seconds)
        if self.error:
            raise self.error
        if nonce in self.claimed:
            return False
        self.claimed.add(nonce)
        return True

    async def claim_spillover(self, nonce, original_nonce, ttl_seconds=35):
        self.claims.append((nonce, original_nonce))
        self.ttls.append(ttl_seconds)
        if self.error:
            raise self.error
        if original_nonce not in self.claimed or nonce in self.claimed:
            return False
        self.claimed.add(nonce)
        return True


class FakeRouter:
    def __init__(self):
        self.model_list = [
            {
                "model_name": ptr_budget_gate.LOCAL_MODEL,
                "litellm_params": {
                    "model": "openai/ptr-local",
                    "api_base": "http://chat-primary-epp.ptr-inference.svc:8081/v1",
                    "api_key": "synthetic",
                    "max_retries": 0,
                },
                "model_info": {"id": ptr_budget_gate.LOCAL_ID, "mode": "chat"},
            },
            {
                "model_name": ptr_budget_gate.PAID_MODEL,
                "litellm_params": {
                    "model": "openrouter/synthetic",
                    "api_key": "synthetic",
                    "max_retries": 0,
                    "extra_body": {
                        "provider": {
                            "order": ["DeepInfra"],
                            "allow_fallbacks": False,
                            "require_parameters": True,
                            "max_price": {"prompt": 0.1, "completion": 0.5},
                        }
                    },
                },
                "model_info": {"id": ptr_budget_gate.PAID_MODEL, "mode": "chat"},
            },
        ]


def sign_data(data, nonce, *, spillover_for_nonce=None, expires_ms=None):
    expires_ms = expires_ms or int(time.time() * 1000) + 25000
    if spillover_for_nonce is not None:
        return sign_spillover_request(data, KEY, spillover_for_nonce, expires_ms, 20000)
    return sign_request(
        data,
        KEY,
        nonce,
        expires_ms,
        20000,
        spillover_for_nonce=spillover_for_nonce,
    )


class GateTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = FakeNonceStore()
        self.gate = ptr_budget_gate.BudgetGate(self.store)
        self.router = FakeRouter()
        self.router_patch = patch.object(proxy_server, "llm_router", self.router)
        self.router_patch.start()

    async def asyncTearDown(self):
        self.router_patch.stop()

    def request(
        self,
        model=ptr_budget_gate.LOCAL_MODEL,
        nonce="a" * 64,
        *,
        spillover_for_nonce=None,
    ):
        data = {
            "model": model,
            "messages": [{"role": "user", "content": "synthetic"}],
            "max_completion_tokens": 512,
        }
        data["proxy_server_request"] = {
            "url": "http://litellm.local/v1/chat/completions",
            "method": "POST",
            "headers": {HEADER: sign_data(data, nonce, spillover_for_nonce=spillover_for_nonce)},
        }
        data["extra_headers"] = {HEADER: "synthetic-leak"}
        return data

    async def prehook(self, data, call_type="completion"):
        return await self.gate.async_pre_call_hook(None, None, data, call_type)

    async def test_grant_hmac_and_expiry_are_verified(self):
        expired = self.request()
        expired["proxy_server_request"]["headers"][HEADER] = sign_data(
            {k: v for k, v in expired.items() if k != "proxy_server_request"},
            "b" * 64,
            expires_ms=int(time.time() * 1000) - 1,
        )
        with self.assertRaises(HTTPException) as failure:
            await self.prehook(expired)
        self.assertEqual(failure.exception.status_code, 403)
        tampered = self.request(nonce="c" * 64)
        tampered["max_completion_tokens"] = 1024
        with self.assertRaises(HTTPException) as failure:
            await self.prehook(tampered)
        self.assertEqual(failure.exception.status_code, 403)
        self.assertEqual(self.store.claims, [])

    async def test_nonce_is_single_use_for_35_seconds(self):
        await self.prehook(self.request())
        with self.assertRaises(HTTPException) as failure:
            await self.prehook(self.request())
        self.assertEqual(failure.exception.status_code, 409)
        self.assertEqual(self.store.claims, ["a" * 64, "a" * 64])
        self.assertEqual(self.store.ttls, [35, 35])

    async def test_direct_paid_alias_requires_spillover_grant_bound_to_original_nonce(self):
        with self.assertRaises(HTTPException) as direct:
            await self.prehook(self.request(ptr_budget_gate.PAID_MODEL, nonce="b" * 64))
        self.assertEqual(direct.exception.status_code, 403)
        with self.assertRaises(HTTPException) as missing_original:
            await self.prehook(
                self.request(
                    ptr_budget_gate.PAID_MODEL,
                    nonce="c" * 64,
                    spillover_for_nonce="a" * 64,
                )
            )
        self.assertEqual(missing_original.exception.status_code, 409)
        await self.prehook(self.request(nonce="a" * 64))
        approved = await self.prehook(
            self.request(
                ptr_budget_gate.PAID_MODEL,
                nonce="c" * 64,
                spillover_for_nonce="a" * 64,
            )
        )
        self.assertEqual(approved["metadata"][ptr_budget_gate.SPILLOVER], "a" * 64)
        with self.assertRaises(HTTPException) as replay:
            await self.prehook(
                self.request(
                    ptr_budget_gate.PAID_MODEL,
                    nonce="c" * 64,
                    spillover_for_nonce="a" * 64,
                )
            )
        self.assertEqual(replay.exception.status_code, 409)

    async def test_grant_header_is_stripped_before_upstream(self):
        approved = await self.prehook(self.request())
        self.assertNotIn(HEADER, approved["proxy_server_request"]["headers"])
        self.assertNotIn(HEADER, approved["extra_headers"])

    async def test_chat_endpoint_only(self):
        bad = self.request()
        bad["proxy_server_request"]["url"] = "http://litellm.local/v1/embeddings"
        with self.assertRaises(HTTPException) as failure:
            await self.prehook(bad)
        self.assertEqual(failure.exception.status_code, 403)
        with self.assertRaises(HTTPException) as async_failure:
            await self.prehook(self.request(nonce="b" * 64), "embedding")
        self.assertEqual(async_failure.exception.status_code, 403)

    async def test_default_denies_missing_or_unrecognized_model(self):
        for data in (
            {"proxy_server_request": {"url": "http://litellm.local/openrouter/anything"}},
            {
                "model": "openrouter/anthropic/claude-synthetic",
                "proxy_server_request": {
                    "url": "http://litellm.local/v1/chat/completions",
                    "method": "POST",
                    "headers": {},
                },
            },
            {
                "model": "not-allowed",
                "proxy_server_request": {
                    "url": "http://litellm.local/v1/chat/completions",
                    "method": "POST",
                    "headers": {},
                },
            },
        ):
            with self.subTest(data=data):
                with self.assertRaises(HTTPException) as failure:
                    await self.prehook(data)
                self.assertEqual(failure.exception.status_code, 403)

    async def test_unsigned_generation_override_is_rejected(self):
        bad = self.request()
        bad["tools"] = [{"type": "function", "function": {"name": "synthetic"}}]
        with self.assertRaises(HTTPException) as failure:
            await self.prehook(bad)
        self.assertEqual(failure.exception.status_code, 400)
        self.assertEqual(self.store.claims, [])

    async def test_api_base_and_key_overrides_are_rejected(self):
        for field in ("api_base", "base_url", "api_key", "headers"):
            bad = self.request(
                nonce={
                    "api_base": "b",
                    "base_url": "c",
                    "api_key": "d",
                    "headers": "e",
                }[field]
                * 64
            )
            bad[field] = "synthetic"
            with self.assertRaises(HTTPException) as failure:
                await self.prehook(bad)
            self.assertEqual(failure.exception.status_code, 400)
        self.assertEqual(self.store.claims, [])

    async def test_metadata_is_cleaned_before_authorization_marker(self):
        data = self.request()
        data["metadata"] = {
            ptr_budget_gate.BUDGET: False,
            ptr_budget_gate.SPILLOVER: "b" * 64,
            "_ptr_routing_request": "synthetic",
            "keep": "value",
        }
        approved = await self.prehook(data)
        self.assertEqual(approved["metadata"], {ptr_budget_gate.BUDGET: True, "keep": "value"})

    async def test_pinned_litellm_version_is_checked(self):
        with patch("ptr_budget_gate.importlib.metadata.version", return_value="1.104.1"):
            with self.assertRaisesRegex(RuntimeError, "VERSION"):
                ptr_budget_gate.BudgetGate(self.store)

    async def test_paid_alias_policy_is_checked(self):
        for mutation in [
            lambda paid: paid["litellm_params"].update({"model": "openai/not-openrouter"}),
            lambda paid: paid["litellm_params"].update({"max_retries": 1}),
            lambda paid: paid["litellm_params"]["extra_body"]["provider"].update(
                {"order": ["Other"]}
            ),
            lambda paid: paid["litellm_params"]["extra_body"]["provider"].update(
                {"allow_fallbacks": True}
            ),
            lambda paid: paid["litellm_params"]["extra_body"]["provider"]["max_price"].update(
                {"completion": 0.6}
            ),
        ]:
            self.router.model_list = copy.deepcopy(FakeRouter().model_list)
            mutation(self.router.model_list[1])
            with self.assertRaises(HTTPException) as failure:
                await self.prehook(self.request(nonce="e" * 64))
            self.assertEqual(failure.exception.status_code, 503)

    async def test_same_router_policy_mutation_is_rechecked(self):
        await self.prehook(self.request())
        self.router.model_list[1]["litellm_params"]["extra_body"]["provider"][
            "allow_fallbacks"
        ] = True
        with self.assertRaises(HTTPException) as failure:
            await self.prehook(self.request(nonce="f" * 64))
        self.assertEqual(failure.exception.status_code, 503)


if __name__ == "__main__":
    unittest.main()
