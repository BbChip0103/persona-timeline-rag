#!/usr/bin/env python3
"""Real pinned Proxies, simulated OpenRouter; no Internet or research services."""

import asyncio
import copy
import importlib.util
import json
import os
import tempfile
import time
import uuid
from pathlib import Path

import httpx

from persona_timeline_rag.gateway_budget import HEADER, sign_request

spec = importlib.util.spec_from_file_location(
    "routing_smoke", Path(__file__).with_name("routing-smoke.py")
)
assert spec and spec.loader
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
KEY = "synthetic-budget-signing-secret-not-a-live-credential"


class CapacitySmoke(base.Smoke):
    def configure(self):
        super().configure()
        f = self.directory / "routing.synthetic.yaml"
        config = json.loads(f.read_text())
        for i, item in enumerate(config["model_list"]):
            item["model_info"]["id"] = ("primary", "secondary")[i]
        config["model_list"].append(
            {
                "model_name": "openrouter-primary",
                "litellm_params": {
                    "model": "openrouter/google/gemma-4-26b-a4b-it",
                    "api_base": "http://fake-engine-spillover:8000/v1",
                    "api_key": "synthetic-only",
                    "max_retries": 0,
                    "timeout": 25,
                    "extra_body": {
                        "provider": {
                            "allow_fallbacks": False,
                            "require_parameters": True,
                            "order": ["DeepInfra"],
                            "max_price": {"prompt": 0.1, "completion": 0.5},
                        }
                    },
                },
                "model_info": {"id": "openrouter-primary", "disable_background_health_check": True},
            }
        )
        base.private_json(f, config)
        f = self.directory / "compose.synthetic.json"
        compose = json.loads(f.read_text())
        self.paid_port = base.port()
        paid = copy.deepcopy(compose["services"]["fake-engine"])
        paid["environment"]["PTR_ROUTING_FIXTURE_ENGINE"] = "paid"
        paid["ports"] = [
            {
                "target": 8000,
                "published": str(self.paid_port),
                "host_ip": "127.0.0.1",
                "protocol": "tcp",
            }
        ]
        compose["services"]["fake-engine-spillover"] = paid
        for name in ("litellm", "litellm-second"):
            compose["services"][name]["environment"].update(
                {"PTR_ROUTING_CAPACITY_SPILLOVER": "1", "PTR_LLM_CAPACITY_SPILLOVER_KEY": KEY}
            )
        base.private_json(f, compose)
        self.paid = f"http://127.0.0.1:{self.paid_port}"

    async def paid_counts(self, client):
        return (await self.request(client, self.paid, "/counts", "synthetic-only")).json()

    async def signed(self, client, *, proxy=0, body=None, grant=None, authorize=True):
        body = body or {
            "model": "primary",
            "messages": [{"role": "user", "content": "Synthetic question"}],
            "max_completion_tokens": 64,
            "stream": False,
            "temperature": 0,
        }
        headers = {"Authorization": "Bearer " + self.env["PTR_LITELLM_MASTER_KEY"]}
        if authorize:
            headers[HEADER] = grant or sign_request(
                body, KEY, uuid.uuid4().hex * 2, int(time.time() * 1000) + 25000, 100000
            )
        return await client.post(
            self.proxies[proxy] + "/v1/chat/completions", headers=headers, json=body
        )

    async def verify(self):
        async with httpx.AsyncClient(timeout=35, trust_env=False) as c:
            for _ in range(180):
                try:
                    if all(
                        [
                            (await c.get(u + "/health/readiness")).status_code == 200
                            for u in self.proxies
                        ]
                    ):
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(1)
            else:
                raise AssertionError("READINESS_FAILED")
            r = await self.signed(c)
            assert r.status_code == 200, "SIGNED_LOCAL_REQUEST_FAILED"
            assert r.headers.get("x-litellm-model-id") in ("primary", "secondary")
            assert (await self.paid_counts(c))["submitted"] == 0
            self.checks.append("local_first_no_paid_request")
            for u in self.engines:
                await self.control(c, u, kv=0.99, waiting=4)
            await asyncio.sleep(1)
            before = sum(x["submitted"] for x in await self.counts(c))
            r = await self.signed(c, proxy=1)
            assert r.status_code == 200, "CAPACITY_PAID_REQUEST_FAILED"
            assert r.headers.get("x-litellm-model-id") == "openrouter-primary"
            assert r.json()["choices"][0]["message"]["content"] == "Synthetic routing reply paid"
            assert sum(x["submitted"] for x in await self.counts(c)) == before
            assert (await self.paid_counts(c))["submitted"] == 1
            self.checks.append("fresh_overload_paid_before_any_local_submission")
            assert (await self.signed(c, authorize=False)).status_code == 403
            body = {
                "model": "primary",
                "messages": [{"role": "user", "content": "Synthetic replay"}],
                "max_completion_tokens": 32,
            }
            grant = sign_request(body, KEY, "a" * 64, int(time.time() * 1000) + 25000, 100000)
            assert (await self.signed(c, body=body, grant=grant)).status_code == 200
            assert (await self.signed(c, proxy=1, body=body, grant=grant)).status_code == 409
            assert (
                await self.signed(c, body={**body, "model": "openrouter-primary"})
            ).status_code == 403
            assert (
                await self.signed(c, body={**body, "max_completion_tokens": 4096}, grant=grant)
            ).status_code == 403
            self.checks.append("unsigned_direct_paid_tamper_cross_proxy_replay_refused")

            # Fixture control uses failure flag, not transport resubmission.
            r = await self.signed(
                c, body={**body, "messages": [{"role": "user", "content": "__FAIL_500__"}]}
            )
            assert r.status_code >= 400, "SIMULATED_PAID_FAILURE_REQUIRED"
            assert (await self.paid_counts(c))["submitted"] == 3
            self.checks.append("paid_failure_single_attempt_no_local_or_paid_retry")
            await self.idle()
            assert (
                sum(x["budget_header_leaks"] for x in await self.counts(c))
                + (await self.paid_counts(c))["budget_header_leaks"]
                == 0
            )
            self.checks.append("budget_header_not_forwarded_upstream")

    async def run(self):
        try:
            self.configure()
            self.command(["up", "-d", "--wait", "--wait-timeout", "180"])
            await self.verify()
            status = "PASS"
        except BaseException:
            status = "FAIL"
            raise
        finally:
            self.command(["down", "--volumes", "--remove-orphans", "--timeout", "5"])
            self.output.close()
            summary = {
                "status": locals().get("status", "FAIL"),
                "checks": self.checks,
                "realProviderCalls": 0,
                "realModelCalls": 0,
                "isolatedSyntheticOnly": True,
            }
            base.private_json(self.directory / "summary.json", summary)
            print(json.dumps(summary))


if __name__ == "__main__":
    d = Path(tempfile.mkdtemp(prefix="ptr-capacity-smoke-"))
    os.chmod(d, 0o700)
    asyncio.run(CapacitySmoke(d).run())
