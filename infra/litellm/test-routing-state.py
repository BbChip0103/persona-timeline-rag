"""Synthetic unit/Lua tests; Redis tests require an explicitly isolated URL."""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import unittest
import uuid
from pathlib import Path
from urllib.parse import urlparse

spec = importlib.util.spec_from_file_location(
    "routing_state", Path(__file__).with_name("routing_state.py")
)
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
RoutingState = module.RoutingState
SALT = "synthetic-shared-routing-salt"
MESSAGES = [{"role": "user", "content": "synthetic question"}]


class NoRedis:
    async def eval(self, *args):
        raise AssertionError("validation must precede Redis")


class EstimateTests(unittest.IsolatedAsyncioTestCase):
    def test_utf8_salted_chain_and_privacy(self):
        state = RoutingState(NoRedis(), salt=SALT)
        messages = [
            {"role": "system", "content": "synthetic policy"},
            {"role": "assistant", "content": "가나다"},
            {"role": "user", "content": "new turn"},
        ]
        estimate = state._estimate(messages)
        self.assertEqual(estimate["tokens"], module.math.ceil((16 + 9 + 8) / 3.9))
        self.assertEqual(len(estimate["chain"]), 2)
        self.assertNotIn("synthetic policy", json.dumps(estimate))
        other = RoutingState(NoRedis(), salt="different-synthetic-routing-salt")
        self.assertNotEqual(estimate["chain"], other._estimate(messages)["chain"])

    def test_boundaries_and_bounded_chain(self):
        state = RoutingState(NoRedis(), salt=SALT)
        a = [{"role": "system", "content": "a\0b"}, {"role": "user", "content": "c"}]
        b = [{"role": "system", "content": "a"}, {"role": "user", "content": "b\0c"}]
        self.assertNotEqual(state._estimate(a)["chain"], state._estimate(b)["chain"])
        self.assertEqual(
            len(state._estimate([{"role": "assistant", "content": "x"}] * 80 + MESSAGES)["chain"]),
            64,
        )
        self.assertEqual(len({k.split("{")[1].split("}")[0] for k in state.keys}), 1)

    def test_message_mapping_utf8_and_aggregate_bounds(self):
        state = RoutingState(NoRedis(), salt=SALT)
        for invalid in (
            [None],
            ["not a mapping"],
            [{"role": 7, "content": "x"}],
            [{"role": "user", "content": "\ud800"}],
            [{"role": "x" * 65, "content": "x"}],
        ):
            with self.subTest(case=type(invalid[0]).__name__), self.assertRaises(ValueError):
                state._estimate(invalid)
        valid = [{"role": "user", "content": "a" * 65536}]
        self.assertGreater(state._estimate(valid)["tokens"], 0)
        overflow = [
            {"role": "system", "content": "가" * 10923},
            {"role": "user", "content": "나" * 10923},
        ]
        with self.assertRaises(ValueError):
            state._estimate(overflow)
        with self.assertRaises(ValueError):
            state._estimate(valid + [{"role": "user", "content": "b"}])

    async def test_bounded_numeric_inputs(self):
        state = RoutingState(NoRedis(), salt=SALT)
        candidate = {"id": "a", "identity": "epoch1"}
        for change in (
            {"max_seqs": 0.5},
            {"max_seqs": 2.0},
            {"max_seqs": 65537},
            {"max_seqs": True},
            {"kv_capacity": 1e13},
            {"prefill_rate": 10**1000},
            {"weight": 1e-300},
        ):
            with self.subTest(field=next(iter(change))), self.assertRaises(ValueError):
                await state.select([dict(candidate, **change)], MESSAGES, 1, "r")
        for value in (32769, 0, True, 1.5, 10**1000):
            with self.assertRaises(ValueError):
                await state.select([candidate], MESSAGES, value, "r")
        with self.assertRaises(ValueError):
            await state.select([None], MESSAGES, 1, "r")
        with self.assertRaises(ValueError):
            await state.select([candidate], MESSAGES, 1, "r", {"slack": 10**1000})
        with self.assertRaises(ValueError):
            await state.select([candidate], MESSAGES, 1, "r", "not mapping")

    async def test_validation(self):
        with self.assertRaises(ValueError):
            RoutingState(NoRedis(), salt="short")
        state = RoutingState(NoRedis(), salt=SALT)
        candidate = {"id": "a", "identity": "epoch1"}
        for change in ({"weight": -1}, {"max_seqs": float("nan")}, {"prefill_rate": 0}):
            with self.assertRaises(ValueError):
                await state.select([dict(candidate, **change)], MESSAGES, 1, "r")
        with self.assertRaises(ValueError):
            await state.select([candidate], MESSAGES, 1, "r", {"policy": "unknown"})
        with self.assertRaises(ValueError):
            await state.select([candidate], MESSAGES, 1, "r", {"slack": -1})
        with self.assertRaises(ValueError):
            await state.select([candidate], [{"role": "user", "content": []}], 1, "r")


@unittest.skipUnless(
    os.environ.get("PTR_ROUTING_TEST_REDIS_URL"), "requires explicitly isolated synthetic Redis"
)
class RedisTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        import redis.asyncio

        url = os.environ["PTR_ROUTING_TEST_REDIS_URL"]
        if urlparse(url).hostname not in ("127.0.0.1", "localhost", "::1"):
            self.fail("test Redis must use loopback")
        self.redis = redis.asyncio.from_url(url)
        namespace = "synthetic-test-" + uuid.uuid4().hex
        self.state = RoutingState(self.redis, namespace=namespace, salt=SALT)
        self.peer = RoutingState(self.redis, namespace=namespace, salt=SALT)
        self.a = {"id": "synthetic-a", "identity": "synthetic-a-epoch1", "max_seqs": 2}
        self.b = {"id": "synthetic-b", "identity": "synthetic-b-epoch1", "max_seqs": 2}

    async def asyncTearDown(self):
        await self.redis.delete(*self.state.keys)
        await self.redis.aclose()

    async def server(self, candidate):
        raw = await self.redis.hget(
            self.state.keys[0], self.state._hash("candidate", candidate["id"])
        )
        return json.loads(raw)

    async def put_server(self, candidate, value):
        await self.redis.hset(
            self.state.keys[0], self.state._hash("candidate", candidate["id"]), json.dumps(value)
        )

    async def test_atomic_credit_across_replicas_and_idempotence(self):
        picks = await asyncio.gather(
            *(
                (self.state if i % 2 else self.peer).select(
                    [self.a], MESSAGES, 10, f"synthetic-request-{i}"
                )
                for i in range(40)
            )
        )
        self.assertEqual(sum(p is not None for p in picks), 2)
        ids = [i for i, p in enumerate(picks) if p]
        self.assertEqual(
            await self.peer.select([self.a], MESSAGES, 10, f"synthetic-request-{ids[0]}"),
            self.a["id"],
        )
        self.assertEqual((await self.server(self.a))["n"], 2)
        await self.peer.release(f"synthetic-request-{ids[0]}", True)
        await self.state.release(f"synthetic-request-{ids[0]}", True)
        self.assertEqual((await self.server(self.a))["n"], 1)
        self.assertIsNotNone(await self.state.select([self.a], MESSAGES, 10, "synthetic-next"))

    async def test_lease_expiry_releases_all_credit(self):
        candidate = dict(self.a, max_seqs=1)
        self.assertIsNotNone(
            await self.state.select([candidate], MESSAGES, 10, "expires", {"lease_s": 0.01})
        )
        await asyncio.sleep(0.03)
        self.assertIsNotNone(await self.peer.select([candidate], MESSAGES, 10, "after"))
        s = await self.server(candidate)
        self.assertEqual(s["n"], 1)
        self.assertEqual(s["kv"], module.math.ceil(len("synthetic question") / 3.9) + 10)
        await self.state.release("expires", True)
        self.assertEqual((await self.server(candidate))["n"], 1)

    async def test_scored_and_least_inflight(self):
        weighted = dict(self.b, weight=10)
        self.assertEqual(
            await self.state.select(
                [self.a, weighted], MESSAGES, 10, "score", {"policy": "scored", "affinity": False}
            ),
            self.b["id"],
        )
        self.assertEqual(
            await self.peer.select(
                [self.a, weighted],
                MESSAGES,
                10,
                "least",
                {"policy": "least_inflight", "affinity": False},
            ),
            self.a["id"],
        )

    async def test_kv_idle_exception_and_calibrated_prefill_gate(self):
        candidate = dict(self.a, kv_capacity=10)
        self.assertIsNotNone(await self.state.select([candidate], MESSAGES, 100, "large"))
        self.assertIsNone(await self.state.select([candidate], MESSAGES, 100, "second"))
        await self.state.release("large", False)
        candidate = dict(self.a, prefill_rate=1)
        self.assertIsNotNone(await self.state.select([candidate], MESSAGES, 1, "prefill"))
        self.assertIsNone(await self.state.select([candidate], MESSAGES, 1, "gated"))

    async def test_external_running_sequence_capacity_blocks_before_wait_queue(self):
        await self.state.update_telemetry(self.a["id"], 0.1, 0, 100, running=self.a["max_seqs"])
        self.assertIsNone(
            await self.state.select(
                [self.a], MESSAGES, 1, "external-full", options={"allow_overloaded_idle": False}
            )
        )

    async def test_paid_spillover_does_not_admit_overloaded_idle_engine(self):
        await self.state.update_telemetry(self.a["id"], 0.96, 4, 100)
        self.assertIsNone(
            await self.state.select(
                [self.a], MESSAGES, 1, "paid-first", options={"allow_overloaded_idle": False}
            )
        )
        self.assertEqual((await self.server(self.a))["n"], 0)
        self.assertTrue(await self.state.claim_budget("synthetic-budget-nonce"))
        self.assertFalse(await self.peer.claim_budget("synthetic-budget-nonce"))

    async def test_telemetry_filter_fallback_stale_and_malformed(self):
        await self.state.update_telemetry(self.a["id"], 0.96, 0, 100)
        self.assertEqual(
            await self.state.select([self.a, self.b], MESSAGES, 1, "healthy"), self.b["id"]
        )
        await self.state.update_telemetry(self.b["id"], 0.2, 3, 100)
        # Both are blocked: one globally idle engine may take a request.
        self.assertEqual(
            await self.state.select([self.a, self.b], MESSAGES, 1, "fallback"), self.a["id"]
        )
        self.assertIsNone(await self.peer.select([self.a, self.b], MESSAGES, 1, "blocked"))
        await self.state.release("healthy", True)
        await self.state.release("fallback", True)
        s = await self.server(self.a)
        s["telemetry"]["seen"] = 0
        await self.put_server(self.a, s)
        self.assertIsNotNone(await self.state.select([self.a], MESSAGES, 1, "stale"))
        await self.state.update_telemetry(self.b["id"], float("nan"), "invalid", None)
        self.assertIsNotNone(await self.state.select([self.b], MESSAGES, 1, "malformed"))

    async def test_affinity_success_failure_identity_and_restart(self):
        messages = [
            {"role": "system", "content": "synthetic policy"},
            {"role": "system", "content": "synthetic persona " * 100},
            *MESSAGES,
        ]
        a, b = dict(self.a, max_seqs=32), dict(self.b, max_seqs=32)
        await self.state.select([a], messages, 1, "train")
        await self.state.release("train", True)
        await self.state.select([a], MESSAGES, 1, "busy")
        self.assertEqual(await self.peer.select([a, b], messages, 1, "sticky"), a["id"])
        self.assertEqual(
            await self.state.select([a, b], messages, 1, "no-affinity", {"affinity": False}),
            b["id"],
        )
        await self.state.release("sticky", False)
        self.assertEqual((await self.server(a))["prefix"], {})
        await self.state.select([a], messages, 1, "retrain")
        await self.state.release("retrain", True)
        await self.state.update_telemetry(a["id"], 0.1, 0, 100)
        await self.state.update_telemetry(a["id"], 0.1, 0, 200)
        self.assertTrue((await self.server(a))["prefix"])
        await self.state.update_telemetry(a["id"], 0.1, 0, 200)
        self.assertEqual((await self.server(a))["prefix"], {})
        await self.state.select([a], messages, 1, "before-clear")
        await self.state.clear_prefix(a["id"])
        await self.state.release("before-clear", True)
        self.assertEqual((await self.server(a))["prefix"], {})
        changed = dict(a, identity="synthetic-a-epoch2")
        await self.state.select([changed], MESSAGES, 1, "new-epoch")
        await self.state.release("busy", False)
        self.assertEqual((await self.server(a))["n"], 1)

    async def test_prefilled_two_phase_credit_and_failure(self):
        messages = [
            {"role": "system", "content": "policy"},
            {"role": "system", "content": "persona " * 200},
            *MESSAGES,
        ]
        await self.state.select([self.a], messages, 12, "stream")
        before = await self.server(self.a)
        self.assertGreater(before["u"], 0)
        await self.peer.prefilled("stream")
        await self.state.prefilled("stream")
        during = await self.server(self.a)
        self.assertEqual(during["u"], 0)
        self.assertEqual(during["n"], 1)
        self.assertEqual(during["kv"], before["kv"])
        self.assertTrue(during["prefix"])
        await self.state.release("stream", False)
        after = await self.server(self.a)
        self.assertEqual((after["n"], after["u"], after["kv"]), (0, 0, 0))
        self.assertEqual(after["prefix"], {})

    async def test_blocked_retry_learns_policy_once(self):
        candidate = dict(self.a, max_seqs=1)
        await self.state.select([candidate], MESSAGES, 1, "busy")
        messages = [{"role": "system", "content": "synthetic policy"}, *MESSAGES]
        for _ in range(20):
            self.assertIsNone(await self.peer.select([candidate], messages, 1, "queued"))
        policy = json.loads(await self.redis.get(self.state.keys[3]))
        self.assertEqual(next(iter(policy["variants"].values()))["count"], 1)

    async def test_telemetry_identity_race_and_missing_start(self):
        await self.state.update_telemetry(self.a["id"], 0.1, 0, 100, identity=self.a["identity"])
        await self.state.select([self.a], MESSAGES, 1, "old")
        await self.state.release("old", True)
        changed = dict(self.a, identity="synthetic-replacement")
        await self.state.select([changed], MESSAGES, 1, "new")
        await self.state.update_telemetry(self.a["id"], 0.99, 30, 100, identity=self.a["identity"])
        self.assertNotIn("telemetry", await self.server(self.a))
        await self.state.update_telemetry(self.a["id"], 0.1, 0, 200, identity=changed["identity"])
        await self.state.update_telemetry(self.a["id"], 0.1, 0, None, identity=changed["identity"])
        before = await self.server(self.a)
        await self.state.update_telemetry(self.a["id"], 0.1, 0, None, identity=changed["identity"])
        self.assertEqual(before["cache_epoch"], (await self.server(self.a))["cache_epoch"])

    async def test_ambiguous_restart_disarms_then_rearms(self):
        await self.state.update_telemetry(self.a["id"], 0.1, 0, 100)
        await self.state.select([self.a], MESSAGES, 1, "init")
        await self.state.release("init", True)
        await self.state.update_telemetry(self.a["id"], 0.1, 0, 50)
        self.assertTrue((await self.server(self.a))["disabled"])
        for _ in range(29):
            await self.peer.update_telemetry(self.a["id"], 0.1, 0, 50)
        s = await self.server(self.a)
        self.assertFalse(s["disabled"])
        self.assertEqual(s["start"], 50)
        await self.state.update_telemetry(self.a["id"], 0.1, 0, 60)
        self.assertEqual((await self.server(self.a))["start"], 50)
        await self.state.update_telemetry(self.a["id"], 0.1, 0, 60)
        self.assertEqual((await self.server(self.a))["start"], 60)

    async def test_prefix_only_reduces_prefill_not_kv_and_privacy(self):
        messages = [
            {"role": "system", "content": "policy"},
            {"role": "system", "content": "persona " * 200},
            *MESSAGES,
        ]
        await self.state.select([self.a], messages, 12, "train-secret")
        await self.state.release("train-secret", True)
        await self.state.select([self.a], messages, 12, "request-secret")
        s = await self.server(self.a)
        estimate = self.state._estimate(messages)
        self.assertEqual(s["kv"], estimate["tokens"] - estimate["first_tokens"] + 12)
        self.assertLess(s["u"], s["kv"] - 12)
        values = []
        for key in self.state.keys[:2]:
            values.extend((await self.redis.hgetall(key)).values())
        text = b" ".join(values).decode()
        for forbidden in (
            "train-secret",
            "request-secret",
            "persona ",
            self.a["id"],
            self.a["identity"],
        ):
            self.assertNotIn(forbidden, text)

    async def test_prefix_ttl_lru_and_dominant_policy_bounds(self):
        await self.state.select([self.a], MESSAGES, 1, "seed")
        await self.state.release("seed", True)
        s = await self.server(self.a)
        s["prefix"] = {
            f"synthetic-hash-{i}": {"seen": 9999999999 + i, "own": 1} for i in range(4100)
        }
        s["prefix"]["expired"] = {"seen": 0, "own": 1}
        await self.put_server(self.a, s)
        await self.state.select([self.a], MESSAGES, 1, "prune")
        s = await self.server(self.a)
        self.assertEqual(len(s["prefix"]), 4096)
        self.assertNotIn("expired", s["prefix"])
        await self.state.release("prune", True)
        for i in range(20):
            await self.state.select(
                [self.a],
                [{"role": "system", "content": f"synthetic policy {i}"}, *MESSAGES],
                1,
                f"variant-{i}",
            )
            await self.state.release(f"variant-{i}", True)
        p = json.loads(await self.redis.get(self.state.keys[3]))
        self.assertEqual(len(p["variants"]), 16)


if __name__ == "__main__":
    unittest.main()
