#!/usr/bin/env python3
"""Real pinned dual-Proxy routing smoke; NEW isolated synthetic Compose stack only.

Run with the app Python venv (httpx available). Creates fresh private credentials,
uses no live provider, and always removes only its own project and volumes.
"""

import argparse
import asyncio
import copy
import hashlib
import hmac
import json
import os
import re
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "infra/compose.framework.yml"
AGGREGATE = """
local total=0; local prefixes=0; local telemetry=0; local uncached=0; local kv=0
for _,raw in ipairs(redis.call('HVALS',KEYS[1])) do
 local s=cjson.decode(raw);total=total+(s.n or 0);uncached=uncached+(s.u or 0);kv=kv+(s.kv or 0)
 for _ in pairs(s.prefix or {}) do prefixes=prefixes+1 end
 if s.telemetry then telemetry=telemetry+1 end
end
return {total,redis.call('HLEN',KEYS[2]),prefixes,telemetry,uncached,kv}
"""


def private_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as handle:
        json.dump(value, handle, indent=2)


def port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Smoke:
    def __init__(self, directory):
        self.directory = directory
        self.env_file = directory / "stack.env"
        subprocess.run(
            [
                "python3",
                str(ROOT / "infra/langfuse/init-framework-env.py"),
                "--output",
                str(self.env_file),
            ],
            check=True,
            capture_output=True,
        )
        self.env = dict(
            line.split("=", 1)
            for line in self.env_file.read_text().splitlines()
            if line and not line.startswith("#")
        )
        self.project = self.env["PTR_FRAMEWORK_PROJECT"]
        assert self.project.startswith("ptr-fw-")
        self.proxy2_port, self.engine2_port = port(), port()
        self.compose = [
            "docker",
            "compose",
            "--env-file",
            str(self.env_file),
            "-f",
            str(BASE),
            "--profile",
            "smoke",
        ]
        self.output = open(directory / "compose.private.log", "w")
        os.chmod(directory / "compose.private.log", 0o600)
        self.checks = []

    def command(self, args, capture=False):
        return subprocess.run(
            self.compose + args,
            cwd=ROOT,
            check=True,
            text=True,
            stdout=subprocess.PIPE if capture else self.output,
            stderr=subprocess.PIPE if capture else self.output,
        )

    def configure(self):
        models = []
        for ident, service, rate in [
            ("engine-a", "fake-engine", 100),
            ("engine-b", "fake-engine-b", 10000),
        ]:
            models.append(
                {
                    "model_name": "primary",
                    "litellm_params": {
                        "model": "openai/" + ident,
                        "api_base": f"http://{service}:8000/v1",
                        "api_key": "synthetic-only",
                        "max_retries": 0,
                        "timeout": 25,
                    },
                    "model_info": {
                        "id": ident,
                        "mode": "chat",
                        "input_cost_per_token": 0.000001,
                        "output_cost_per_token": 0.000001,
                        "disable_background_health_check": True,
                        "ptr_routing": {"max_seqs": 2, "prefill_rate": rate},
                    },
                }
            )
        config = {
            "model_list": models,
            "router_settings": {
                "num_retries": 0,
                "max_fallbacks": 0,
                "enable_weighted_failover": False,
                "fallbacks": [],
                "default_fallbacks": [],
                "context_window_fallbacks": [],
                "content_policy_fallbacks": [],
                "redis_host": "litellm-redis",
                "redis_port": 6379,
                "redis_password": "os.environ/PTR_LITELLM_REDIS_PASSWORD",
            },
            "litellm_settings": {
                "callbacks": ["ptr_routing.router"],
                "num_retries": 0,
                "request_timeout": 25,
                "set_verbose": False,
                "max_budget": 1.0,
                "budget_duration": "1d",
            },
            "general_settings": {
                "master_key": "os.environ/PTR_LITELLM_MASTER_KEY",
                "database_url": "os.environ/DATABASE_URL",
                "background_health_checks": False,
                "allow_requests_on_db_unavailable": False,
                "disable_error_logs": True,
            },
        }
        config_file = self.directory / "routing.synthetic.yaml"
        private_json(config_file, config)
        rendered = json.loads(self.command(["config", "--format", "json"], capture=True).stdout)
        proxy = copy.deepcopy(rendered["services"]["litellm"])
        fixture = copy.deepcopy(rendered["services"]["fake-engine"])
        fixture["environment"] = {
            "PTR_ROUTING_FIXTURE_ENGINE": "engine-a",
            "PTR_ROUTING_FIXTURE_KEY": "synthetic-only",
        }
        fixture["volumes"] = [
            {
                "type": "bind",
                "source": str(ROOT / "infra/litellm/routing-fixture.py"),
                "target": "/fixture/fake-engine.py",
                "read_only": True,
            }
        ]
        fixture2 = copy.deepcopy(fixture)
        fixture2["environment"]["PTR_ROUTING_FIXTURE_ENGINE"] = "engine-b"
        fixture2["ports"] = [
            {
                "target": 8000,
                "published": str(self.engine2_port),
                "host_ip": "127.0.0.1",
                "protocol": "tcp",
            }
        ]
        proxy["environment"].update(
            {
                "LITELLM_LOCAL_MODEL_COST_MAP": "True",
                "PTR_ROUTING_POLICY": "scored",
                "PTR_ROUTING_AFFINITY": "on",
                "PTR_ROUTING_AFFINITY_MIN_TOKENS": "256",
                "PTR_ROUTING_AFFINITY_SLACK": "10",
                "PTR_ROUTING_METRICS_INTERVAL_S": "0.2",
                "PTR_ROUTING_METRICS_TIMEOUT_S": "0.5",
                "PTR_ROUTING_QUEUE_TIMEOUT_S": "0",
            }
        )
        for volume in proxy["volumes"]:
            if volume["target"] == "/app/ptr-config.yaml":
                volume["source"] = str(config_file)
        proxy2 = copy.deepcopy(proxy)
        proxy2["environment"]["PTR_ROUTING_POLICY"] = "least_inflight"
        proxy2["ports"] = [
            {
                "target": 4000,
                "published": str(self.proxy2_port),
                "host_ip": "127.0.0.1",
                "protocol": "tcp",
            }
        ]
        # Fully rendered model preserves pinned services and base Compose profile,
        # with no external credentials. Only these six services are started.
        rendered["services"] = {
            "litellm": proxy,
            "litellm-second": proxy2,
            "fake-engine": fixture,
            "fake-engine-b": fixture2,
            "litellm-postgres": rendered["services"]["litellm-postgres"],
            "litellm-redis": rendered["services"]["litellm-redis"],
        }
        rendered.pop("x-service", None)
        rendered["networks"] = {
            "proxy": {"driver_opts": {"com.docker.network.bridge.enable_ip_masquerade": "false"}}
        }
        rendered["volumes"] = {
            name: rendered["volumes"][name] for name in ("litellm_postgres", "litellm_redis")
        }
        compose_file = self.directory / "compose.synthetic.json"
        private_json(compose_file, rendered)
        self.compose = [
            "docker",
            "compose",
            "--env-file",
            str(self.env_file),
            "-f",
            str(compose_file),
            "--profile",
            "smoke",
        ]
        self.proxies = [
            f"http://127.0.0.1:{self.env['PTR_LITELLM_PORT']}",
            f"http://127.0.0.1:{self.proxy2_port}",
        ]
        self.engines = [
            f"http://127.0.0.1:{self.env['PTR_FAKE_ENGINE_PORT']}",
            f"http://127.0.0.1:{self.engine2_port}",
        ]
        salt = self.env["PTR_LITELLM_SALT_KEY"].encode()
        tag = hmac.new(salt, b"namespace\0ptr-routing-v1", hashlib.sha256).hexdigest()[:24]
        self.state_keys = [f"ptr:routing:{{{tag}}}:{suffix}" for suffix in ("states", "leases")]

    def ledger(self):
        # Lua returns aggregate counters only; no Redis identifiers or payloads.
        result = self.command(
            [
                "exec",
                "-T",
                "litellm-redis",
                "sh",
                "-c",
                'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --raw EVAL "$1" 2 "$2" "$3"',
                "sh",
                AGGREGATE,
                *self.state_keys,
            ],
            capture=True,
        )
        return list(map(int, result.stdout.splitlines()))

    async def request(self, client, base, path, key=None, body=None):
        headers = {"Authorization": "Bearer " + key} if key else {}
        return await client.request(
            "POST" if body is not None else "GET", base + path, headers=headers, json=body
        )

    async def control(self, client, engine, **changes):
        assert (
            await self.request(client, engine, "/control", "synthetic-only", changes)
        ).status_code == 200

    async def counts(self, client):
        return [
            (await self.request(client, engine, "/counts", "synthetic-only")).json()
            for engine in self.engines
        ]

    async def chat(self, client, proxy=0, messages=None, key=None, **extra):
        response = await self.request(
            client,
            self.proxies[proxy],
            "/v1/chat/completions",
            key or self.key,
            {
                "model": "primary",
                "messages": messages or [{"role": "user", "content": "Synthetic query"}],
                "max_tokens": 32,
                **extra,
            },
        )
        if response.status_code != 200 and not response.headers.get("content-type", "").startswith(
            "text/event-stream"
        ):
            private_json(
                self.directory / f"failure-response-{time.time_ns()}.json", response.json()
            )
        return response

    @staticmethod
    def selected(response):
        assert response.status_code == 200, (
            f"Chat HTTP {response.status_code}; bounded codes="
            + str(re.findall(r"PTR_ROUTING_[A-Z_]+", response.text))
        )
        engine = response.json()["choices"][0]["message"]["content"].removeprefix(
            "Synthetic routing reply "
        )
        assert engine in ("engine-a", "engine-b"), "Synthetic engine response label missing"
        assert response.headers.get("x-litellm-model-id") == engine, (
            "Selected engine header differs from actual fixture"
        )
        return engine

    async def idle(self):
        for _ in range(40):
            if self.ledger()[:2] == [0, 0]:
                return
            await asyncio.sleep(0.1)
        raise AssertionError("Reservations not released by actual Proxy callbacks")

    async def active(self, client, total):
        for _ in range(100):
            counts = await self.counts(client)
            if sum(c["active"] for c in counts) == total:
                return counts
            await asyncio.sleep(0.01)
        raise AssertionError("Expected synthetic concurrency not reached")

    async def verify(self):
        self.key = self.env["PTR_LITELLM_MASTER_KEY"]
        async with httpx.AsyncClient(timeout=40, trust_env=False) as client:
            for _ in range(180):
                try:
                    if all(
                        [
                            (await self.request(client, base, "/health/readiness")).status_code
                            == 200
                            for base in self.proxies
                        ]
                    ):
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(1)
            else:
                raise AssertionError("Pinned Proxy readiness failed")
            before = sum(c["submitted"] for c in await self.counts(client))
            assert (
                await self.request(
                    client,
                    self.proxies[0],
                    "/v1/chat/completions",
                    body={
                        "model": "primary",
                        "messages": [{"role": "user", "content": "Synthetic auth"}],
                    },
                )
            ).status_code in (401, 403)
            assert sum(c["submitted"] for c in await self.counts(client)) == before
            status = await self.request(
                client,
                self.proxies[0],
                "/key/generate",
                self.key,
                {"models": ["primary"], "max_budget": 0.1, "key_alias": "synthetic-routing"},
            )
            assert status.status_code == 200
            virtual = status.json()["key"]
            self.selected(await self.chat(client, key=virtual))
            before_denied = sum(c["submitted"] for c in await self.counts(client))
            denied = await self.request(
                client,
                self.proxies[0],
                "/v1/chat/completions",
                virtual,
                {
                    "model": "not-allowed",
                    "messages": [{"role": "user", "content": "Synthetic deny"}],
                },
            )
            assert denied.status_code in (400, 401, 403)
            assert sum(c["submitted"] for c in await self.counts(client)) == before_denied, (
                "Disallowed model reached upstream"
            )
            await self.idle()
            self.checks.append("real_proxy_auth_allowed_model_and_success_release")
            streamed = await self.chat(
                client, key=virtual, stream=True, stream_options={"include_usage": True}
            )
            assert streamed.status_code == 200 and "data: [DONE]" in streamed.text
            events = [
                json.loads(line[6:])
                for line in streamed.text.splitlines()
                if line.startswith("data: ") and line != "data: [DONE]"
            ]
            assert events[-1]["usage"]["total_tokens"] == 28
            assert events[0]["choices"][0]["delta"]["content"].removeprefix(
                "Synthetic routing reply "
            ) in ("engine-a", "engine-b")
            assert streamed.headers.get("x-litellm-model-id") in ("engine-a", "engine-b")
            await self.idle()
            self.checks.append("actual_sse_completed_usage_credit_release")

            # No common cached prefix: scored can prefer busy calibrated fast
            # engine while least-inflight chooses the otherwise idle engine.
            for engine in self.engines:
                await self.control(client, engine, delay_ms=1200)
            busy = asyncio.create_task(
                self.chat(client, messages=[{"role": "user", "content": "z" * 400}])
            )
            first = await self.active(client, 1)
            assert first[1]["active"] == 1, "Scorer did not choose calibrated fast engine"
            scored = asyncio.create_task(
                self.chat(client, messages=[{"role": "user", "content": "q" * 400}])
            )
            await self.active(client, 2)
            least = asyncio.create_task(
                self.chat(client, proxy=1, messages=[{"role": "user", "content": "r" * 400}])
            )
            replies = await asyncio.gather(busy, scored, least)
            assert [self.selected(r) for r in replies] == ["engine-b", "engine-b", "engine-a"]
            await self.idle()
            self.checks.append("scored_differs_from_least_inflight_over_actual_http")
            for engine in self.engines:
                await self.control(client, engine, delay_ms=50)

            history = [
                {"role": "system", "content": "Synthetic shared system " * 20},
                {"role": "user", "content": "Synthetic stable history " * 200},
                {"role": "assistant", "content": "Synthetic earlier answer " * 20},
                {"role": "user", "content": "Synthetic first continuation"},
            ]
            warmed = self.selected(await self.chat(client, messages=history))
            await self.idle()
            assert warmed == "engine-b" and self.ledger()[2] > 0
            await self.control(client, self.engines[1], delay_ms=1200)
            blocker = asyncio.create_task(
                self.chat(client, messages=[{"role": "user", "content": "b" * 400}])
            )
            await self.active(client, 1)
            assert (await self.counts(client))[1]["active"] == 1
            repeat = copy.deepcopy(history)
            repeat[-1]["content"] = "Synthetic second continuation"
            sticky = asyncio.create_task(self.chat(client, proxy=1, messages=repeat))
            await self.active(client, 2)
            assert (await self.counts(client))[1]["active"] == 2, (
                "Affinity ignored warm busy engine"
            )
            assert self.selected(await sticky) == warmed
            self.selected(await blocker)
            await self.idle()
            self.checks.append("cache_affinity_beats_idle_engine_across_replicas")

            await self.control(client, self.engines[1], delay_ms=50, kv=0.99, waiting=5)
            await asyncio.sleep(1)
            assert self.selected(await self.chat(client)) == "engine-a"
            await self.idle()
            assert self.ledger()[3] == 2
            self.checks.append("authenticated_background_metrics_overload_filter")
            await self.control(client, self.engines[1], kv=0.1, waiting=0)
            await asyncio.sleep(1)

            before = sum(c["submitted"] for c in await self.counts(client))
            failed = await self.chat(
                client,
                messages=[{"role": "user", "content": "__FAIL_500__"}],
                num_retries=9,
                max_retries=9,
                disable_fallbacks=False,
            )
            assert failed.status_code >= 500
            assert sum(c["submitted"] for c in await self.counts(client)) == before + 1, (
                "Retry override caused resubmission"
            )
            await self.idle()
            self.checks.append(
                "ambiguous_500_single_submission_override_neutralized_failure_release"
            )

            for engine in self.engines:
                await self.control(client, engine, delay_ms=1500)
            holds = [
                asyncio.create_task(
                    self.chat(
                        client,
                        proxy=i % 2,
                        messages=[{"role": "user", "content": f"Synthetic concurrent {i}"}],
                    )
                )
                for i in range(4)
            ]
            occupied = await self.active(client, 4)
            assert [c["active"] for c in occupied] == [2, 2]
            assert self.ledger()[:2] == [4, 4]
            before = sum(c["submitted"] for c in occupied)
            saturated = await self.chat(client, proxy=1, num_retries=5)
            assert saturated.status_code >= 400
            assert sum(c["submitted"] for c in await self.counts(client)) == before
            for reply in await asyncio.gather(*holds):
                self.selected(reply)
            await self.idle()
            counts = await self.counts(client)
            assert all(c["max_active"] <= 2 for c in counts)
            self.checks.append("shared_max_seqs_two_proxies_saturation_no_upstream_no_fallback")

            for engine in self.engines:
                await self.control(client, engine, delay_ms=50, metrics_delay_ms=1200)
            for _ in range(100):
                if any(c["metrics_active"] for c in await self.counts(client)):
                    break
                await asyncio.sleep(0.01)
            else:
                raise AssertionError("Background metrics polling not observed")
            started = time.monotonic()
            self.selected(await self.chat(client))
            latency = time.monotonic() - started
            assert latency < 0.5, "Metrics timeout was on model request path"
            await self.idle()
            self.checks.append("metrics_poll_delay_not_on_request_path")
            for engine in self.engines:
                await self.control(client, engine, metrics_delay_ms=0)

            # Continuous upstream data must NOT extend the shared 35s lease.
            # Role-only first chunk does not mean prefill completed.
            for engine in self.engines:
                await self.control(
                    client, engine, delay_ms=0, stream_chunks=50, stream_interval_ms=1000
                )
            before_slow = sum(c["submitted"] for c in await self.counts(client))
            slow_started = time.monotonic()
            generated = 0
            role_credit = None
            generated_credit = None
            try:
                async with client.stream(
                    "POST",
                    self.proxies[0] + "/v1/chat/completions",
                    headers={"Authorization": "Bearer " + self.key},
                    json={
                        "model": "primary",
                        "messages": [
                            {"role": "user", "content": "Synthetic slow continuous stream"}
                        ],
                        "max_tokens": 64,
                        "stream": True,
                    },
                ) as response:
                    assert response.status_code == 200, "Slow stream initial status"
                    async for line in response.aiter_lines():
                        if not line.startswith("data: ") or line == "data: [DONE]":
                            continue
                        event = json.loads(line[6:])
                        choices = event.get("choices", [])
                        delta = choices[0].get("delta", {}) if choices else {}
                        if delta.get("role") and not delta.get("content") and role_credit is None:
                            role_credit = self.ledger()
                        if delta.get("content"):
                            generated += 1
                            if generated_credit is None:
                                generated_credit = self.ledger()
            except httpx.HTTPError:
                pass  # Expected: the Proxy truncates the stream at total deadline.
            slow_elapsed = time.monotonic() - slow_started
            private_json(
                self.directory / "stream-deadline.json",
                {
                    "elapsed_ms": round(slow_elapsed * 1000, 3),
                    "generated_chunks": generated,
                    "role_credit": role_credit,
                    "generated_credit": generated_credit,
                    "ledger_on_stream_end": self.ledger(),
                    "fixture_counts_on_stream_end": await self.counts(client),
                },
            )
            await self.idle()
            for _ in range(30):
                slow_counts = await self.counts(client)
                if sum(c["active"] for c in slow_counts) == 0:
                    break
                await asyncio.sleep(0.1)
            else:
                raise AssertionError("Timed-out upstream did not stop after socket close")
            assert time.monotonic() - slow_started < 35, (
                "Credit cleanup only happened at lease expiry"
            )
            assert sum(c["submitted"] for c in slow_counts) == before_slow + 1
            private_json(
                self.directory / "stream-cleanup.json",
                {
                    "elapsed_ms": round((time.monotonic() - slow_started) * 1000, 3),
                    "ledger_after_upstream_close": self.ledger(),
                    "fixture_counts_after_upstream_close": slow_counts,
                },
            )
            assert 24 <= slow_elapsed <= 29, "Slow stream escaped total 25s deadline"
            assert 0 < generated < 35, "Slow stream unexpectedly completed or never generated"
            assert role_credit and role_credit[:2] == [1, 1] and role_credit[4] > 0, (
                "Role-only chunk released prefill credits"
            )
            assert (
                generated_credit
                and generated_credit[:2] == [1, 1]
                and generated_credit[4] == 0
                and generated_credit[5] > 0
            ), "Generated content did not separately release prefill credits"
            self.checks.append(
                "actual_continuous_sse_total_deadline_prefill_separation_release_before_lease"
            )
            for engine in self.engines:
                await self.control(
                    client, engine, delay_ms=50, stream_chunks=1, stream_interval_ms=0
                )

            created = await self.request(
                client,
                self.proxies[0],
                "/key/generate",
                self.key,
                {
                    "models": ["primary"],
                    "max_budget": 0.000001,
                    "budget_duration": "1d",
                    "key_alias": "synthetic-budget",
                },
            )
            assert created.status_code == 200
            budget_key = created.json()["key"]
            self.selected(await self.chat(client, key=budget_key))
            for _ in range(40):
                await asyncio.sleep(1)
                info = await self.request(
                    client,
                    self.proxies[0],
                    "/key/info?key=" + hashlib.sha256(budget_key.encode()).hexdigest(),
                    self.key,
                )
                if (
                    info.status_code == 200
                    and info.json().get("info", {}).get("spend", 0) > 0.000001
                ):
                    break
            else:
                raise AssertionError("Synthetic spend did not persist")
            before = sum(c["submitted"] for c in await self.counts(client))
            denied = await self.chat(client, key=budget_key)
            assert 400 <= denied.status_code < 500 and "budget" in denied.text.lower()
            assert sum(c["submitted"] for c in await self.counts(client)) == before
            await self.idle()
            self.checks.append("unchanged_persisted_virtual_key_budget_gate")
            counts = await self.counts(client)
            return {
                "status": "PASS",
                "checks": self.checks,
                "synthetic_submissions": sum(c["submitted"] for c in counts),
                "max_active_per_engine": [c["max_active"] for c in counts],
                "final_ledger": self.ledger(),
                "slow_metrics_model_latency_ms": round(latency * 1000, 3),
                "continuous_stream_elapsed_ms": round(slow_elapsed * 1000, 3),
                "continuous_stream_generated_chunks": generated,
                "role_only_credit": role_credit,
                "generated_credit": generated_credit,
                "external_calls": 0,
                "actual_cost_usd": 0,
            }

    async def run(self):
        modules = (
            "ptr_routing.py",
            "routing_state.py",
            "routing_telemetry.py",
            "routing-fixture.py",
            "routing-smoke.py",
        )
        hashes = {
            name: hashlib.sha256((ROOT / "infra/litellm" / name).read_bytes()).hexdigest()
            for name in modules
        }
        summary = {"status": "FAIL", "checks": self.checks}
        try:
            self.configure()
            self.command(["up", "-d", "--wait", "--wait-timeout", "180"])
            self.versions = [
                self.command(
                    [
                        "exec",
                        "-T",
                        service,
                        "python",
                        "-c",
                        "import importlib.metadata;print(importlib.metadata.version('litellm'))",
                    ],
                    capture=True,
                ).stdout.strip()
                for service in ("litellm", "litellm-second")
            ]
            assert self.versions == ["1.104.2", "1.104.2"], "Unvalidated Proxy version"
            container_hashes = {}
            for service in ("litellm", "litellm-second", "fake-engine", "fake-engine-b"):
                paths = (
                    ["/app/ptr_routing.py", "/app/routing_state.py", "/app/routing_telemetry.py"]
                    if service.startswith("litellm")
                    else ["/fixture/fake-engine.py"]
                )
                code = (
                    "import hashlib,json;from pathlib import Path;"
                    "print(json.dumps({p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in "
                    + repr(paths)
                    + "}))"
                )
                container_hashes[service] = json.loads(
                    self.command(["exec", "-T", service, "python", "-c", code], capture=True).stdout
                )
                for path, digest in container_hashes[service].items():
                    host_name = (
                        "routing-fixture.py"
                        if service.startswith("fake-engine")
                        else Path(path).name
                    )
                    assert digest == hashes[host_name], (
                        "Mounted module differs from frozen host source"
                    )
            private_json(self.directory / "container-hashes.json", container_hashes)
            summary = await self.verify()
        except Exception as error:
            summary.update(
                error_type=type(error).__name__,
                error=str(error)
                if isinstance(error, AssertionError)
                else "Private diagnostic log retained",
            )
            raise
        finally:
            try:
                summary["proxy_versions"] = getattr(self, "versions", [])
                summary["module_sha256"] = hashes
                summary["module_sources_unchanged_during_run"] = all(
                    hashlib.sha256((ROOT / "infra/litellm" / name).read_bytes()).hexdigest()
                    == digest
                    for name, digest in hashes.items()
                )
                if (
                    summary["status"] == "PASS"
                    and not summary["module_sources_unchanged_during_run"]
                ):
                    summary["status"] = "INVALID_SOURCE_CHANGED"
                if "synthetic_submissions" not in summary and hasattr(self, "engines"):
                    try:
                        # No await in mandatory cleanup: cancellation cannot interrupt
                        # a diagnostic count read before the owned-project teardown.
                        code = (
                            "import json,urllib.request;r=urllib.request.Request("
                            "'http://127.0.0.1:8000/counts',headers={"
                            "'Authorization':'Bearer synthetic-only'});"
                            "print(urllib.request.urlopen(r,timeout=2).read().decode())"
                        )
                        counts = [
                            json.loads(
                                self.command(
                                    ["exec", "-T", service, "python", "-c", code], capture=True
                                ).stdout
                            )
                            for service in ("fake-engine", "fake-engine-b")
                        ]
                        summary["synthetic_submissions"] = sum(c["submitted"] for c in counts)
                        summary["final_fixture_active"] = sum(c["active"] for c in counts)
                    except (subprocess.SubprocessError, ValueError):
                        summary["synthetic_submissions"] = None
            finally:
                try:
                    subprocess.run(
                        self.compose + ["logs", "--no-color"],
                        stdout=self.output,
                        stderr=self.output,
                        check=False,
                    )
                    self.command(["down", "--volumes", "--remove-orphans", "--timeout", "5"])
                    left = subprocess.run(
                        [
                            "docker",
                            "ps",
                            "-aq",
                            "--filter",
                            "label=com.docker.compose.project=" + self.project,
                        ],
                        capture_output=True,
                        text=True,
                        check=True,
                    )
                    volumes = subprocess.run(
                        [
                            "docker",
                            "volume",
                            "ls",
                            "-q",
                            "--filter",
                            "label=com.docker.compose.project=" + self.project,
                        ],
                        capture_output=True,
                        text=True,
                        check=True,
                    )
                    summary["cleanup_owned_project_only"] = (
                        not left.stdout.strip() and not volumes.stdout.strip()
                    )
                    assert summary["cleanup_owned_project_only"]
                finally:
                    self.output.close()
                    private_json(self.directory / "summary.json", summary)
                    print(json.dumps(summary, sort_keys=True))
                    print("Private diagnostic directory:", self.directory)
                    if summary["status"] == "INVALID_SOURCE_CHANGED":
                        raise RuntimeError("Routing smoke invalidated by concurrent source changes")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path)
    args = parser.parse_args()
    directory = args.output_dir or Path(tempfile.mkdtemp(prefix="ptr-routing-smoke-"))
    if args.output_dir:
        directory.mkdir(mode=0o700, exist_ok=False)
    os.chmod(directory, 0o700)
    asyncio.run(Smoke(directory).run())


if __name__ == "__main__":
    main()
