from __future__ import annotations

import asyncio
import copy
import time
from types import SimpleNamespace
from uuid import uuid4

import httpx
import pytest

from ptr_llm.config import ConfigurationError, Settings
from ptr_llm.control import ControlClient, ControlRejected, ControlUnavailable
from ptr_llm.server import create_app
from ptr_llm.worker import ExecutionStopped, WorkerRunner, deadline_seconds


def settings(**values):
    return Settings(
        redis_url="redis://127.0.0.1:6379/0",
        backend_url="http://127.0.0.1:58441",
        control_token="synthetic-control-token",
        database_url="postgresql://llm:synthetic@localhost/research",
        status_interval=0.01,
        **values,
    )


def context(turn_id):
    session_id = str(uuid4())
    session = {
        "id": session_id,
        "ownerId": "synthetic",
        "personId": "synthetic-person",
        "personaId": "synthetic-persona",
        "personaRevision": "v1",
        "language": "ko",
        "timezone": "UTC",
        "retrievalMode": "off",
        "createdAt": "2026-10-11T00:00:00Z",
    }
    return {
        "turn": {
            "id": turn_id,
            "sessionId": session_id,
            "ownerId": "synthetic",
            "clientRequestId": "req-1",
            "userText": "합성 질문 🧪",
            "sequence": 1,
            "state": "pending",
            "createdAt": "2026-10-11T00:00:00Z",
        },
        "session": session,
        "input": {"sessionId": session_id, "clientRequestId": "req-1", "text": "합성 질문 🧪"},
        "history": [],
        "refusedTurnIds": [],
    }


class RedisFake:
    token = "synthetic-token"
    cap = None
    unavailable = False

    async def get(self, _):
        if self.unavailable:
            raise OSError("secret raw Redis URL")
        return self.token

    async def hget(self, *_):
        return self.cap


class Store:
    def __init__(self):
        self.result = None
        self.writes = 0
        self.acks = 0

    async def get_result(self, _):
        return copy.deepcopy(self.result)

    async def put_result(self, _, result):
        self.writes += 1
        self.result = copy.deepcopy(result)
        return copy.deepcopy(result)

    async def mark_result_ack(self, _):
        self.acks += 1


class ControlFake:
    def __init__(self):
        self.starts = []
        self.completions = []
        self.start_failures = 0
        self.ack_failures = 0
        self.status_value = "current"
        self.status_failure = False
        self.denial = None
        self.grant = None

    async def start(self, body):
        self.starts.append(copy.deepcopy(body))
        if self.start_failures:
            self.start_failures -= 1
            raise ControlUnavailable()
        if self.denial:
            return {"contractVersion": 2, "status": self.denial}
        self.grant = {
            "contractVersion": 2,
            "turnId": body["turnId"],
            "dispatchSeq": body["dispatchSeq"],
            "executionId": body["executionId"],
            "generation": 1,
            "deadlineAt": int((time.time() + 5) * 1000),
            "contextHash": "a" * 64,
            "context": context(body["turnId"]),
        }
        return {"contractVersion": 2, "status": "granted", "grant": self.grant}

    async def status(self, _):
        if self.status_failure:
            raise ControlUnavailable()
        return {"contractVersion": 2, "status": self.status_value}

    async def complete(self, binding, result):
        self.completions.append(copy.deepcopy({**binding, "result": result}))
        if self.ack_failures:
            self.ack_failures -= 1
            raise ControlUnavailable()
        return {
            "contractVersion": 2,
            "status": "alreadyApplied" if len(self.completions) > 1 else "applied",
        }

    async def close(self):
        pass


class Engine:
    def __init__(self):
        self.calls = 0

    async def handle(self, _, *, before_costly, cancelled):
        await before_costly()
        assert not cancelled.is_set()
        self.calls += 1
        return {"kind": "failed", "errorCode": "TURN_FAILED"}


def setup():
    turn_id = str(uuid4())
    job = SimpleNamespace(
        id=f"t-{turn_id}-0", data={"contractVersion": 2, "turnId": turn_id, "dispatchSeq": 0}
    )
    control, engine, store, redis = ControlFake(), Engine(), Store(), RedisFake()
    runner = WorkerRunner(settings(), control, engine, store, redis=redis)
    return runner, job, control, engine, store, redis


async def test_lost_start_ack_same_execution_id_and_one_model():
    runner, job, control, engine, store, _ = setup()
    control.start_failures = 1
    assert await runner.process(job, "synthetic-token") == {"status": "committed"}
    assert len(control.starts) == 2
    assert control.starts[0] == control.starts[1]
    assert engine.calls == store.writes == store.acks == 1


async def test_complete_ack_loss_reposts_immutable_payload_without_model_replay():
    runner, job, control, engine, store, _ = setup()
    control.ack_failures = 2
    assert await runner.process(job, "synthetic-token") == {"status": "committed"}
    assert len(control.completions) == 3
    assert all(body == control.completions[0] for body in control.completions)
    assert engine.calls == store.writes == store.acks == 1


@pytest.mark.parametrize("denial", ["lost", "cancelled"])
async def test_terminal_redelivery_no_model(denial):
    runner, job, control, engine, store, _ = setup()
    control.denial = denial
    assert await runner.process(job, "synthetic-token") == {"status": "obsolete"}
    assert engine.calls == store.writes == 0


async def test_first_status_failure_blocks_new_costly_submission():
    runner, job, control, engine, _, _ = setup()
    control.status_failure = True
    with pytest.raises(ControlUnavailable, match="CONTROL_UNAVAILABLE"):
        await runner.process(job, "synthetic-token")
    assert engine.calls == 0


@pytest.mark.parametrize("status", ["cancelled", "lost"])
async def test_backend_fence_cancel_blocks_costly(status):
    runner, job, control, engine, _, _ = setup()
    control.status_value = status
    with pytest.raises(ExecutionStopped):
        await runner.process(job, "synthetic-token")
    assert engine.calls == 0


async def test_local_token_loss_blocks_costly():
    runner, job, _, engine, _, redis = setup()
    redis.token = "new-owner-token"
    with pytest.raises(ExecutionStopped, match="EXECUTION_LOST"):
        await runner.process(job, "synthetic-token")
    assert engine.calls == 0


async def test_redis_outage_fail_closed_no_missing_job_inference():
    runner, job, _, engine, _, redis = setup()
    redis.unavailable = True
    with pytest.raises(ControlUnavailable, match="CONTROL_UNAVAILABLE"):
        await runner.process(job, "synthetic-token")
    assert engine.calls == 0


async def test_monitor_two_failures_cancels_inflight_without_next_submission():
    runner, job, control, _, store, _ = setup()

    class Slow:
        calls = 0

        async def handle(self, _, *, before_costly, cancelled):
            await before_costly()
            self.calls += 1
            control.status_failure = True
            await asyncio.sleep(2)
            await before_costly()

    runner.engine = Slow()
    with pytest.raises(ExecutionStopped, match="CONTROL_UNAVAILABLE"):
        await asyncio.wait_for(runner.process(job, "synthetic-token"), 1)
    assert runner.engine.calls == 1
    assert store.writes == 0


async def test_replay_same_grant_result_receipt_skips_engine():
    runner, job, _, engine, store, _ = setup()
    store.result = {"kind": "failed", "errorCode": "TURN_FAILED"}
    assert await runner.process(job, "synthetic-token") == {"status": "committed"}
    assert engine.calls == store.writes == 0
    assert store.acks == 1


async def test_unknown_worker_exception_sanitized():
    runner, job, _, _, _, _ = setup()

    class Unsafe:
        async def handle(self, *args, **kwargs):
            raise RuntimeError("provider key=SUPER_SECRET raw text")

    runner.engine = Unsafe()
    with pytest.raises(ExecutionStopped, match="^LLM_WORKER_FAILED$"):
        await runner.process(job, "synthetic-token")


async def test_global_capacity_fails_startup_without_mutating_queue():
    runner, _, _, _, _, redis = setup()
    redis.cap = "2"
    with pytest.raises(ExecutionStopped, match="GLOBAL_CONCURRENCY_UNSUPPORTED"):
        await runner.start()
    assert redis.cap == "2"
    assert not runner.ready


def test_deadline_is_safe_integer_ms_not_coerced():
    assert deadline_seconds({"deadlineAt": int((time.time() + 10) * 1000)}) > 9
    for value in [True, "123", float("nan"), 9007199254740992]:
        with pytest.raises(ControlRejected):
            deadline_seconds({"deadlineAt": value})


def test_config_host_is_loopback_or_explicit_container_allowlist_secrets_hidden():
    env = {
        "PTR_LLM_DATABASE_URL": "postgresql://llm:synthetic@localhost/research",
        "PTR_LLM_CONTROL_TOKEN": "synthetic-control-token-v1",
    }
    conf = Settings.from_env(env)
    assert conf.queue_name == "turns" and conf.queue_prefix == "ptr"
    assert "synthetic" not in repr(conf)
    with pytest.raises(ConfigurationError, match="DATABASE_HOST_NOT_ALLOWED"):
        Settings.from_env(
            {**env, "PTR_LLM_DATABASE_URL": "postgresql://llm:synthetic@external.example/research"}
        )
    conf = Settings.from_env(
        {
            **env,
            "PTR_LLM_DATABASE_URL": "postgresql://llm:synthetic@database/research",
            "PTR_LLM_DATABASE_HOST_ALLOWLIST": "database",
        }
    )
    assert conf.database_url


def test_worker_bind_host_accepts_explicit_pod_listener():
    env = {
        "PTR_LLM_DATABASE_URL": "postgresql://llm:synthetic@localhost/research",
        "PTR_LLM_CONTROL_TOKEN": "synthetic-control-token-v1",
    }
    assert Settings.from_env(env).host == "127.0.0.1"
    assert Settings.from_env({**env, "PTR_LLM_HOST": "0.0.0.0"}).host == "0.0.0.0"


@pytest.mark.parametrize("key_name", ["OPENROUTER_API_KEY", "PTR_OPENROUTER_API_KEY"])
def test_compose_worker_rejects_openrouter_key_names_before_startup(key_name):
    env = {
        "PTR_LLM_DATABASE_URL": "postgresql://llm:synthetic@localhost/research",
        "PTR_LLM_CONTROL_TOKEN": "synthetic-control-token-v1",
        key_name: "",
    }
    with pytest.raises(ConfigurationError, match="COMPOSE_OPENROUTER_KEYS_FORBIDDEN"):
        Settings.from_env(env)


@pytest.mark.parametrize(
    ("changes", "error"),
    [
        (
            {
                "PTR_LLM_REDIS_URL": "redis://:synthetic@redis.ptr-data.svc:6379/0",
                "PTR_LLM_REDIS_URL_ALLOWLIST": "redis://redis.ptr-data.svc:6379",
            },
            None,
        ),
        (
            {
                "PTR_LLM_REDIS_URL": "rediss://acl:synthetic@managed-redis.example.com:6380/0",
                "PTR_LLM_REDIS_URL_ALLOWLIST": "rediss://managed-redis.example.com:6380",
            },
            "REDIS_URL_NOT_ALLOWED",
        ),
        (
            {
                "PTR_LLM_REDIS_URL": "rediss://acl:synthetic@managed-redis.example.com:6380/0",
                "PTR_LLM_REDIS_URL_ALLOWLIST": "rediss://acl@managed-redis.example.com:6380",
            },
            None,
        ),
        (
            {
                "PTR_LLM_REDIS_URL": "redis://:synthetic@managed-redis.example.com:6380/0",
                "PTR_LLM_REDIS_URL_ALLOWLIST": "redis://managed-redis.example.com:6380",
            },
            "INVALID_REDIS_URL",
        ),
        (
            {
                "PTR_LLM_BACKEND_URL": "http://api.ptr-app.svc:3000",
                "PTR_LLM_BACKEND_URL_ALLOWLIST": "http://api.ptr-app.svc:3000",
            },
            None,
        ),
        (
            {
                "PTR_LLM_BACKEND_URL": "http://api.ptr-app.svc.cluster.local:3000",
                "PTR_LLM_BACKEND_URL_ALLOWLIST": "http://api.ptr-app.svc.cluster.local:3000",
            },
            None,
        ),
        (
            {
                "PTR_LLM_BACKEND_URL": "http://api.internal.example.com:3000",
                "PTR_LLM_BACKEND_URL_ALLOWLIST": "http://api.internal.example.com:3000",
            },
            "BACKEND_REQUIRES_HTTPS",
        ),
        (
            {
                "PTR_LLM_BACKEND_URL": "https://api.internal.example.com:443",
                "PTR_LLM_BACKEND_URL_ALLOWLIST": "https://api.internal.example.com:443",
            },
            None,
        ),
        (
            {"PTR_LLM_REDIS_URL": "redis://redis.ptr-data.svc:6379/0"},
            "INVALID_REDIS_URL",
        ),
        (
            {"PTR_LLM_REDIS_URL": "redis://:synthetic@redis.ptr-data.svc:6379/16"},
            "INVALID_REDIS_URL",
        ),
        (
            {"PTR_LLM_REDIS_URL": "redis://:synthetic@redis.ptr-data.svc:6379/0?family=6"},
            "INVALID_REDIS_URL",
        ),
        (
            {
                "PTR_LLM_REDIS_URL": "redis://user:synthetic@redis.ptr-data.svc:6379/0",
                "PTR_LLM_REDIS_URL_ALLOWLIST": "redis://user@redis.ptr-data.svc:6379",
            },
            None,
        ),
        (
            {
                "PTR_LLM_REDIS_URL": "redis://user:synthetic@redis.ptr-data.svc:6379/0",
                "PTR_LLM_REDIS_URL_ALLOWLIST": "redis://user:synthetic@redis.ptr-data.svc:6379",
            },
            "REDIS_URL_NOT_ALLOWED",
        ),
        (
            {
                "PTR_LLM_REDIS_URL": "redis://user:synthetic@redis.ptr-data.svc:6379/0",
                "PTR_LLM_REDIS_URL_ALLOWLIST": "redis://user@redis.ptr-data.svc:6379/0",
            },
            "REDIS_URL_NOT_ALLOWED",
        ),
        (
            {
                "PTR_LLM_DATABASE_URL": (
                    "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/"
                    "ptr_split_research"
                ),
                "PTR_LLM_DATABASE_URL_ALLOWLIST": (
                    "postgresql://ptr_split_llm@postgres.ptr-data.svc:5432/ptr_split_research"
                ),
            },
            None,
        ),
        (
            {
                "PTR_LLM_DATABASE_URL": (
                    "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/"
                    "ptr_split_research?sslmode=require"
                ),
                "PTR_LLM_DATABASE_URL_ALLOWLIST": (
                    "postgresql://ptr_split_llm@postgres.ptr-data.svc:5432/ptr_split_research"
                ),
            },
            None,
        ),
        (
            {
                "PTR_LLM_DATABASE_URL": (
                    "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/"
                    "ptr_split_research?sslmode=disable"
                ),
            },
            "INVALID_DATABASE_URL",
        ),
        (
            {
                "PTR_LLM_DATABASE_URL": (
                    "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/"
                    "ptr_split_research?connect_timeout=1"
                ),
                "PTR_LLM_DATABASE_URL_ALLOWLIST": (
                    "postgresql://ptr_split_llm@postgres.ptr-data.svc:5432/ptr_split_research"
                ),
            },
            "INVALID_DATABASE_URL",
        ),
        (
            {
                "PTR_LLM_DATABASE_URL": (
                    "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/"
                    "ptr_split_research?sslmode=require"
                ),
                "PTR_LLM_DATABASE_URL_ALLOWLIST": "",
            },
            "DATABASE_URL_NOT_ALLOWED",
        ),
    ],
)
def test_cluster_network_mode_requires_explicit_scheme_host_port_allowlists(changes, error):
    env = {
        "PTR_NETWORK_MODE": "cluster",
        "KUBERNETES_SERVICE_HOST": "10.0.0.1",
        "PTR_LLM_REDIS_URL": "redis://:synthetic@redis.ptr-data.svc:6379/0",
        "PTR_LLM_REDIS_URL_ALLOWLIST": "redis://redis.ptr-data.svc:6379",
        "PTR_LLM_BACKEND_URL": "http://api.ptr-app.svc:3000",
        "PTR_LLM_BACKEND_URL_ALLOWLIST": "http://api.ptr-app.svc:3000",
        "PTR_LLM_DATABASE_URL": (
            "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/"
            "ptr_split_research?sslmode=require"
        ),
        "PTR_LLM_DATABASE_URL_ALLOWLIST": (
            "postgresql://ptr_split_llm@postgres.ptr-data.svc:5432/ptr_split_research"
        ),
        "PTR_LLM_CONTROL_TOKEN": "synthetic-control-token-v1",
    }
    env.update(changes)
    if error:
        with pytest.raises(ConfigurationError, match=error):
            Settings.from_env(env)
    else:
        conf = Settings.from_env(env)
        assert conf.redis_url == env["PTR_LLM_REDIS_URL"]
        assert conf.backend_url == env["PTR_LLM_BACKEND_URL"].rstrip("/")
        assert conf.database_url == env["PTR_LLM_DATABASE_URL"]


def test_cluster_network_mode_requires_kubernetes_service_host():
    env = {
        "PTR_NETWORK_MODE": "cluster",
        "PTR_LLM_DATABASE_URL": (
            "postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/ptr_split_research"
        ),
        "PTR_LLM_DATABASE_URL_ALLOWLIST": (
            "postgresql://ptr_split_llm@postgres.ptr-data.svc:5432/ptr_split_research"
        ),
        "PTR_LLM_CONTROL_TOKEN": "synthetic-control-token-v1",
    }
    with pytest.raises(ConfigurationError, match="DATABASE_HOST_NOT_ALLOWED"):
        Settings.from_env(env)


async def test_control_transport_failure_does_not_echo_response_or_secret():
    async def responder(request):
        assert request.headers["Authorization"] == "Bearer synthetic-control-token"
        return httpx.Response(503, text="secret raw server body")

    async with httpx.AsyncClient(transport=httpx.MockTransport(responder)) as client:
        control = ControlClient("http://internal", "synthetic-control-token", client=client)
        with pytest.raises(ControlUnavailable, match="^CONTROL_UNAVAILABLE$"):
            await control.status(
                {
                    "contractVersion": 2,
                    "turnId": str(uuid4()),
                    "dispatchSeq": 0,
                    "executionId": str(uuid4()),
                    "generation": 1,
                    "jobId": "synthetic-job",
                    "lockToken": "synthetic-token",
                }
            )


async def test_internal_http_auth_and_sanitized_failure():
    async def catalogue():
        raise RuntimeError("real private data never returned")

    async def draft(_):
        return {}

    app = create_app(settings(), catalogue=catalogue, draft=draft)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://worker"
    ) as client:
        assert (await client.get("/health/live")).status_code == 200
        assert (await client.get("/internal/llm/personas")).status_code == 401
        reply = await client.get(
            "/internal/llm/personas", headers={"Authorization": "Bearer synthetic-control-token"}
        )
        assert reply.status_code == 503
        assert "private" not in reply.text


async def test_cooperative_signal_stops_inflight_without_durable_result():
    runner, job, _, _, store, _ = setup()
    entered = asyncio.Event()
    signal = asyncio.Event()

    class Slow:
        calls = 0

        async def handle(self, _, *, before_costly, cancelled):
            await before_costly()
            self.calls += 1
            entered.set()
            await asyncio.sleep(5)
            await before_costly()

    runner.engine = Slow()
    task = asyncio.create_task(runner.process(job, "synthetic-token", signal))
    await asyncio.wait_for(entered.wait(), 1)
    signal.set()
    with pytest.raises(ExecutionStopped, match="EXECUTION_CANCELLED"):
        await asyncio.wait_for(task, 1)
    assert runner.engine.calls == 1 and store.writes == 0


async def test_readiness_requires_llm_database_health_and_sanitizes_failure():
    async def catalogue():
        return []

    async def draft(_):
        return {}

    async def health():
        raise OSError("private connection details")

    app = create_app(settings(), catalogue=catalogue, draft=draft, health=health)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://worker"
    ) as client:
        result = await client.get("/health/ready")
        assert result.status_code == 503
        assert result.json() == {"status": "unavailable"}


async def test_monitor_expiry_reports_terminal_timeout_without_reexecution():
    runner, job, control, _, store, _ = setup()
    original_start = control.start

    async def start(body):
        response = await original_start(body)
        response["grant"]["deadlineAt"] = int((time.time() + 0.12) * 1000)
        return response

    control.start = start

    class Slow:
        calls = 0

        async def handle(self, _, *, before_costly, cancelled):
            await before_costly()
            self.calls += 1
            await asyncio.sleep(2)
            await before_costly()
            self.calls += 1

    runner.engine = Slow()
    assert await asyncio.wait_for(runner.process(job, "synthetic-token"), 1) == {
        "status": "committed"
    }
    assert runner.engine.calls == 1 and store.writes == store.acks == 1
    assert control.completions[0]["result"] == {"kind": "failed", "errorCode": "TURN_TIMEOUT"}


async def test_engine_expired_timeout_can_be_saved_and_completed_by_holder():
    runner, job, control, _, store, _ = setup()

    class TimeoutEngine:
        calls = 0

        async def handle(self, grant, *, before_costly, cancelled):
            await before_costly()
            self.calls += 1
            grant["deadlineAt"] = int((time.time() - 0.01) * 1000)
            return {"kind": "failed", "errorCode": "TURN_TIMEOUT"}

    runner.engine = TimeoutEngine()
    assert await runner.process(job, "synthetic-token") == {"status": "committed"}
    assert runner.engine.calls == 1 and store.writes == store.acks == 1
    assert control.completions[0]["result"]["errorCode"] == "TURN_TIMEOUT"


async def test_expired_grant_claim_reports_timeout_without_model_call():
    runner, job, control, engine, store, _ = setup()
    original_start = control.start

    async def start(body):
        response = await original_start(body)
        response["grant"]["deadlineAt"] = int((time.time() - 0.1) * 1000)
        return response

    control.start = start
    assert await runner.process(job, "synthetic-token") == {"status": "committed"}
    assert engine.calls == 0 and store.acks == 1
    assert control.completions[0]["result"]["errorCode"] == "TURN_TIMEOUT"


async def test_lost_status_crossing_deadline_timeout_only_for_actual_token_holder():
    runner, job, control, _, store, redis = setup()
    original_status = control.status
    checked = 0

    async def status(binding):
        nonlocal checked
        checked += 1
        if checked == 1:
            control.grant["deadlineAt"] = int((time.time() - 0.1) * 1000)
            return {"contractVersion": 2, "status": "lost"}
        return await original_status(binding)

    control.status = status

    class Crossing:
        calls = 0

        async def handle(self, _, *, before_costly, cancelled):
            try:
                await before_costly()
            except ExecutionStopped:
                return {"kind": "failed", "errorCode": "TURN_TIMEOUT"}
            self.calls += 1

    runner.engine = Crossing()
    assert await runner.process(job, "synthetic-token") == {"status": "committed"}
    assert runner.engine.calls == 0 and store.acks == 1


async def test_expired_failure_old_token_rejected_without_completion():
    runner, job, control, _, store, redis = setup()

    class Lost:
        async def handle(self, grant, *, before_costly, cancelled):
            grant["deadlineAt"] = int((time.time() - 0.1) * 1000)
            redis.token = "new-owner-token"
            return {"kind": "failed", "errorCode": "TURN_TIMEOUT"}

    runner.engine = Lost()
    with pytest.raises(ExecutionStopped, match="EXECUTION_LOST"):
        await runner.process(job, "synthetic-token")
    assert not control.completions and store.writes == 0


def completed_reply(grant):
    session = grant["context"]["session"]
    return {
        "kind": "completed",
        "reply": {
            "sessionId": session["id"],
            "turnId": grant["turnId"],
            "messageId": str(uuid4()),
            "personId": session["personId"],
            "personaRevision": session["personaRevision"],
            "responseKind": "small_talk",
            "status": "answered",
            "content": "합성 답변 🧪",
            "claims": [],
            "evidence": [],
            "limitations": [],
        },
    }


async def test_complete_ack_loss_crossing_deadline_retries_only_receipt():
    runner, job, control, _, store, _ = setup()

    class Success:
        calls = 0

        async def handle(self, grant, *, before_costly, cancelled):
            await before_costly()
            self.calls += 1
            return completed_reply(grant)

    runner.engine = Success()
    original_complete = control.complete

    async def complete(binding, result):
        if not control.completions:
            control.completions.append(copy.deepcopy({**binding, "result": result}))
            control.grant["deadlineAt"] = int((time.time() - 0.1) * 1000)
            raise ControlUnavailable()
        return await original_complete(binding, result)

    control.complete = complete
    assert await runner.process(job, "synthetic-token") == {"status": "committed"}
    assert runner.engine.calls == store.writes == store.acks == 1
    assert len(control.completions) == 2
    assert control.completions[0] == control.completions[1]
    assert control.completions[1]["result"]["kind"] == "completed"


async def test_engine_success_crossing_deadline_is_timeout_not_expired_success():
    runner, job, control, _, store, _ = setup()

    class ExpiredSuccess:
        async def handle(self, grant, *, before_costly, cancelled):
            await before_costly()
            result = completed_reply(grant)
            grant["deadlineAt"] = int((time.time() - 0.1) * 1000)
            return result

    runner.engine = ExpiredSuccess()
    assert await runner.process(job, "synthetic-token") == {"status": "committed"}
    assert store.acks == 1
    assert control.completions[0]["result"] == {"kind": "failed", "errorCode": "TURN_TIMEOUT"}


async def test_control_total_timeout_even_if_server_drips_chunks():
    class Drip(httpx.AsyncByteStream):
        async def __aiter__(self):
            for _ in range(100):
                await asyncio.sleep(0.02)
                yield b" "

    async def responder(_):
        return httpx.Response(200, stream=Drip())

    async with httpx.AsyncClient(transport=httpx.MockTransport(responder)) as client:
        control = ControlClient(
            "http://internal", "synthetic-control-token", timeout=0.05, client=client
        )
        binding = {
            "contractVersion": 2,
            "turnId": str(uuid4()),
            "dispatchSeq": 0,
            "executionId": str(uuid4()),
            "generation": 1,
            "jobId": "synthetic",
            "lockToken": "synthetic",
        }
        began = time.monotonic()
        with pytest.raises(ControlUnavailable):
            await control.status(binding)
        assert time.monotonic() - began < 0.3


def test_installed_service_uses_explicit_shared_contract_directory(monkeypatch):
    import json
    from pathlib import Path

    from ptr_llm.control import _wire_module, validate_wire

    directory = Path(__file__).resolve().parents[3] / "contracts/llm/v2"
    monkeypatch.setenv("PTR_LLM_CONTRACTS_DIR", str(directory))
    _wire_module.cache_clear()
    try:
        assert validate_wire(
            "Dispatch", {"contractVersion": 2, "turnId": str(uuid4()), "dispatchSeq": 0}
        )
        corpus = json.loads((directory / "corpus.json").read_text())
        for case in corpus:
            if case["valid"]:
                assert validate_wire(case["schema"], case["value"]) == case["value"]
            else:
                with pytest.raises(ControlRejected):
                    validate_wire(case["schema"], case["value"])
        local_result = next(
            case["value"]
            for case in corpus
            if case["name"] == "k8s_served_ids_are_valid_wire_results"
        )
        assert validate_wire("Result", local_result) == local_result
        monkeypatch.setenv("PTR_LLM_CONTRACTS_DIR", str(directory / "missing"))
        _wire_module.cache_clear()
        with pytest.raises(ControlRejected):
            validate_wire("Dispatch", {})
    finally:
        _wire_module.cache_clear()


def test_v2_wire_rejects_v1_peer_with_clear_version_code():
    from ptr_llm.control import ControlRejected, validate_wire

    body = {"contractVersion": 2, "turnId": str(uuid4()), "dispatchSeq": 0}
    assert validate_wire("Dispatch", body) == body
    with pytest.raises(ControlRejected, match="WIRE_VERSION_MISMATCH"):
        validate_wire("Dispatch", {**body, "contractVersion": 1})


async def test_control_client_rejects_v1_response_with_clear_version_code():
    async def responder(_):
        return httpx.Response(200, json={"contractVersion": 1, "status": "lost"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(responder)) as client:
        control = ControlClient("http://internal", "synthetic-control-token", client=client)
        body = {
            "contractVersion": 2,
            "turnId": str(uuid4()),
            "dispatchSeq": 0,
            "executionId": str(uuid4()),
            "jobId": "synthetic",
            "lockToken": "synthetic",
        }
        with pytest.raises(ControlRejected, match="WIRE_VERSION_MISMATCH"):
            await control.start(body)


def test_module_cli_preserves_failed_evaluation_exit(monkeypatch):
    import sys

    from ptr_llm import __main__, cli

    monkeypatch.setattr(sys, "argv", ["ptr-llm", "evaluate"])
    monkeypatch.setattr(cli, "main", lambda: 1)
    with pytest.raises(SystemExit) as error:
        __main__.main()
    assert error.value.code == 1


async def test_terminal_ack_transport_retry_is_bounded_and_keeps_receipt(monkeypatch):
    from ptr_llm import worker

    monkeypatch.setattr(worker, "ACK_RETRY_GRACE_SECONDS", 0.05)
    runner, job, control, engine, store, _ = setup()
    control.ack_failures = 1000
    began = time.monotonic()
    with pytest.raises(ControlUnavailable):
        await runner.process(job, "synthetic-token")
    assert time.monotonic() - began < 0.3
    assert engine.calls == store.writes == 1
    assert store.acks == 0 and store.result is not None


async def test_terminal_ack_retry_lost_token_blocks_old_writer():
    runner, job, control, engine, store, redis = setup()

    async def complete(binding, result):
        control.completions.append(copy.deepcopy({**binding, "result": result}))
        redis.token = "new-owner-token"
        raise ControlUnavailable()

    control.complete = complete
    with pytest.raises(ExecutionStopped, match="EXECUTION_LOST"):
        await runner.process(job, "synthetic-token")
    assert engine.calls == store.writes == len(control.completions) == 1
    assert store.acks == 0


async def test_post_receipt_expiry_backend_terminalizes_without_model_retry():
    runner, job, control, _, store, _ = setup()
    original_start, original_put = control.start, store.put_result

    async def start(body):
        response = await original_start(body)
        response["grant"]["deadlineAt"] = int((time.time() + 0.06) * 1000)
        return response

    control.start = start

    async def put_result(grant, result):
        await asyncio.sleep(0.08)
        return await original_put(grant, result)

    store.put_result = put_result

    class Success:
        calls = 0

        async def handle(self, grant, *, before_costly, cancelled):
            await before_costly()
            self.calls += 1
            return completed_reply(grant)

    runner.engine = Success()
    terminal_state = None

    async def complete(binding, result):
        nonlocal terminal_state
        assert result["kind"] == "completed"
        assert deadline_seconds(control.grant) <= 0
        control.completions.append(copy.deepcopy({**binding, "result": result}))
        # Backend transaction verifies fence+token, then atomically refuses
        # expired success, fails TURN_TIMEOUT and removes the outbox.
        terminal_state = "TURN_TIMEOUT"
        return {"contractVersion": 2, "status": "lost"}

    control.complete = complete
    assert await runner.process(job, "synthetic-token") == {"status": "obsolete"}
    assert terminal_state == "TURN_TIMEOUT"
    assert runner.engine.calls == store.writes == len(control.completions) == 1
    assert store.result["kind"] == "completed" and store.acks == 0


async def test_sdk_background_failure_consumed_and_readiness_stops_guard():
    runner, _, _, _, _, _ = setup()
    runner.ready = True
    guard = SimpleNamespace(stop=lambda reason: stopped.append(reason))
    stopped = []
    runner._guards["synthetic-job"] = guard

    async def fail():
        raise OSError("synthetic private Redis error")

    task = asyncio.create_task(fail())
    task.add_done_callback(runner._worker_done)
    await asyncio.sleep(0.01)
    assert not runner.ready
    assert stopped == ["CONTROL_UNAVAILABLE"]
    assert task.done() and task.exception() is not None


@pytest.mark.parametrize(
    "backend",
    [
        "http://user:password@127.0.0.1:56441",
        "http://@localhost:56441",
        "http://localhost:56441?query=1",
        "http://localhost:56441?",
        "http://localhost:56441#fragment",
        "http://localhost:56441#",
        "http://localhost:56441/internal",
        "https://service.example/internal",
    ],
)
def test_config_rejects_backend_credentials_query_fragment_path(backend):
    env = {
        "PTR_LLM_DATABASE_URL": "postgresql://llm:synthetic@localhost/research",
        "PTR_LLM_CONTROL_TOKEN": "synthetic-control-token-v1",
        "PTR_LLM_BACKEND_URL": backend,
    }
    with pytest.raises(ConfigurationError, match="INVALID_BACKEND_URL"):
        Settings.from_env(env)


@pytest.mark.parametrize("backend", ["http://service.example:56441", "http://192.0.2.1:56441"])
def test_config_requires_https_for_nonloopback_backend(backend):
    env = {
        "PTR_LLM_DATABASE_URL": "postgresql://llm:synthetic@localhost/research",
        "PTR_LLM_CONTROL_TOKEN": "synthetic-control-token-v1",
        "PTR_LLM_BACKEND_URL": backend,
    }
    with pytest.raises(ConfigurationError, match="BACKEND_REQUIRES_HTTPS"):
        Settings.from_env(env)


@pytest.mark.parametrize(
    "backend",
    [
        "http://localhost:56441/",
        "http://127.0.0.1:56441",
        "http://[::1]:56441",
        "https://service.example/",
    ],
)
def test_config_accepts_loopback_http_and_remote_https(backend):
    env = {
        "PTR_LLM_DATABASE_URL": "postgresql://llm:synthetic@localhost/research",
        "PTR_LLM_CONTROL_TOKEN": "synthetic-control-token-v1",
        "PTR_LLM_BACKEND_URL": backend,
    }
    conf = Settings.from_env(env)
    assert conf.backend_url == backend.rstrip("/")
    assert conf.host == "127.0.0.1"


@pytest.mark.parametrize("length", [23, 513])
def test_config_control_token_matches_backend_bounds(length):
    env = {
        "PTR_LLM_DATABASE_URL": "postgresql://llm:synthetic@localhost/research",
        "PTR_LLM_CONTROL_TOKEN": "x" * length,
    }
    with pytest.raises(ConfigurationError, match="INVALID_CONTROL_TOKEN"):
        Settings.from_env(env)


def test_config_default_backend_port_and_control_token_boundaries():
    for length in (24, 512):
        env = {
            "PTR_LLM_DATABASE_URL": "postgresql://llm:synthetic@localhost/research",
            "PTR_LLM_CONTROL_TOKEN": "x" * length,
        }
        assert Settings.from_env(env).backend_url == "http://127.0.0.1:56441"


async def test_success_receipt_does_not_add_post_model_status_rpc():
    runner, job, control, _, store, _ = setup()
    checked = 0
    original_status = control.status

    async def status(binding):
        nonlocal checked
        checked += 1
        return await original_status(binding)

    control.status = status

    class Success:
        calls = 0

        async def handle(self, grant, *, before_costly, cancelled):
            await before_costly()
            self.calls += 1
            return completed_reply(grant)

    runner.engine = Success()
    assert await runner.process(job, "synthetic-token") == {"status": "committed"}
    assert checked == 1
    assert runner.engine.calls == store.writes == store.acks == 1


async def test_cancellation_during_model_still_monitored_before_result():
    runner, job, control, _, store, _ = setup()

    class SlowSuccess:
        calls = 0

        async def handle(self, grant, *, before_costly, cancelled):
            await before_costly()
            self.calls += 1
            control.status_value = "cancelled"
            await asyncio.sleep(1)
            return completed_reply(grant)

    runner.engine = SlowSuccess()
    with pytest.raises(ExecutionStopped, match="EXECUTION_CANCELLED"):
        await asyncio.wait_for(runner.process(job, "synthetic-token"), 0.5)
    assert runner.engine.calls == 1 and store.writes == 0
    assert not control.completions


@pytest.mark.parametrize("timing", ["model_return", "after_receipt"])
async def test_completed_result_cancellation_backend_cas_no_publication_or_model_retry(timing):
    runner, job, control, _, store, _ = setup()
    cancelled = False

    class Success:
        calls = 0

        async def handle(self, grant, *, before_costly, cancelled):
            nonlocal backend_cancelled
            await before_costly()
            self.calls += 1
            if timing == "model_return":
                backend_cancelled = True
            return completed_reply(grant)

    backend_cancelled = cancelled
    runner.engine = Success()
    original_put = store.put_result

    async def put_result(grant, result):
        nonlocal backend_cancelled
        receipt = await original_put(grant, result)
        if timing == "after_receipt":
            backend_cancelled = True
        return receipt

    store.put_result = put_result

    async def complete(binding, result):
        assert backend_cancelled
        control.completions.append(copy.deepcopy({**binding, "result": result}))
        return {"contractVersion": 2, "status": "cancelled"}

    control.complete = complete
    assert await runner.process(job, "synthetic-token") == {"status": "obsolete"}
    assert runner.engine.calls == store.writes == len(control.completions) == 1
    assert store.acks == 0 and store.result["kind"] == "completed"
