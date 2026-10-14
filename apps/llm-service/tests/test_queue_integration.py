"""Opt-in destructive tests touch only a container created by this module.

PTR_LLM_QUEUE_INTEGRATION=1 pytest tests/test_queue_integration.py -q
"""

from __future__ import annotations

import asyncio
import json
import os
import signal
import socket
import subprocess
import sys
import time
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

import pytest
from bullmq import Queue, Worker
from test_worker_control import ControlFake, WorkerRunner, settings

from ptr_llm.worker import queue_connection_url

pytestmark = pytest.mark.skipif(
    os.environ.get("PTR_LLM_QUEUE_INTEGRATION") != "1", reason="isolated Docker integration opt-in"
)


def docker(*args: str) -> str:
    return subprocess.check_output(
        ["docker", *args], text=True, stderr=subprocess.DEVNULL, timeout=30
    ).strip()


@pytest.fixture(scope="module")
def owned_redis():
    name = "ptr-worker-test-" + uuid4().hex[:12]
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    docker(
        "run",
        "-d",
        "--name",
        name,
        "-p",
        f"127.0.0.1:{port}:6379",
        "redis:8.2-alpine",
        "redis-server",
        "--appendonly",
        "yes",
        "--appendfsync",
        "always",
        "--maxmemory-policy",
        "noeviction",
    )
    try:
        port = docker("port", name, "6379/tcp").rsplit(":", 1)[1]
        url = f"redis://127.0.0.1:{port}/0"
        for _ in range(50):
            try:
                if docker("exec", name, "redis-cli", "ping") == "PONG":
                    break
            except subprocess.CalledProcessError:
                pass
            time.sleep(0.1)
        else:
            raise AssertionError("OWNED_REDIS_STARTUP_TIMEOUT")
        yield name, url
    finally:
        docker("rm", "-f", name)


async def terminal(queue: Queue, job_id: str, state: str = "completed", timeout: float = 15):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        actual = await queue.getJobState(job_id)
        if actual == state:
            return await queue.getJob(job_id)
        if actual == "failed" and state != "failed":
            raise AssertionError("SYNTHETIC_QUEUE_FAILED")
        await asyncio.sleep(0.025)
    raise AssertionError("SYNTHETIC_QUEUE_TIMEOUT")


class Results:
    def __init__(self):
        self.values = {}
        self.acks = 0

    async def get_result(self, grant):
        return self.values.get(grant["executionId"])

    async def put_result(self, grant, result):
        self.values[grant["executionId"]] = result
        return result

    async def mark_result_ack(self, _):
        self.acks += 1


async def test_sigterm_drains_real_bullmq_job_before_ack(owned_redis, tmp_path):
    _, url = owned_redis
    prefix = "proof-" + uuid4().hex[:12]
    marker = tmp_path / "real-drain.log"
    queue = Queue("turns", {"connection": queue_connection_url(url), "prefix": prefix})
    child = Path(__file__).with_name("real_queue_drain_child.py")
    process = None
    turn_id = str(uuid4())
    job_id = f"t-{turn_id}-0"
    try:
        await queue.add(
            "turn",
            {"contractVersion": 1, "turnId": turn_id, "dispatchSeq": 0},
            {"jobId": job_id, "attempts": 1},
        )
        process = await asyncio.create_subprocess_exec(
            sys.executable, str(child), url, prefix, str(marker),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        until = time.monotonic() + 8
        while time.monotonic() < until:
            if marker.exists() and "started" in marker.read_text().splitlines():
                break
            assert process.returncode is None, "REAL_WORKER_EXITED_BEFORE_START"
            await asyncio.sleep(0.02)
        else:
            raise AssertionError("REAL_WORKER_DID_NOT_START")
        process.send_signal(signal.SIGTERM)
        assert await asyncio.wait_for(process.wait(), 10) == 0
        job = await terminal(queue, job_id, timeout=3)
        assert job.returnvalue == {"status": "committed"}
        assert marker.read_text().splitlines() == [
            "started", "sigterm", "completed", "acked", "closed"
        ]
    finally:
        if process is not None and process.returncode is None:
            process.kill()
            await asyncio.wait_for(process.wait(), 5)
        await queue.close()


async def test_two_python_workers_saturation_drain_and_backpressure(owned_redis):
    _, url = owned_redis
    prefix = "proof-" + uuid4().hex[:12]
    config = replace(settings(), redis_url=url, queue_prefix=prefix, concurrency=2)
    gate = asyncio.Event()
    started = asyncio.Event()
    active = maximum = calls = 0

    class SyntheticEngine:
        async def handle(self, _, *, before_costly, cancelled):
            nonlocal active, maximum, calls
            await before_costly()
            active += 1
            calls += 1
            maximum = max(maximum, active)
            if active == 4:
                started.set()
            try:
                await gate.wait()
                await asyncio.sleep(0.02)
                await before_costly()
                return {"kind": "failed", "errorCode": "TURN_FAILED"}
            finally:
                active -= 1

    stores = [Results(), Results()]
    runners = [WorkerRunner(config, ControlFake(), SyntheticEngine(), store) for store in stores]
    queue = Queue(config.queue_name, {"connection": queue_connection_url(url), "prefix": prefix})
    ids = []
    try:
        for runner in runners:
            await runner.start()
        for _ in range(120):
            turn_id = str(uuid4())
            job_id = f"t-{turn_id}-0"
            ids.append(job_id)
            await queue.add(
                "turn",
                {"contractVersion": 1, "turnId": turn_id, "dispatchSeq": 0},
                {"jobId": job_id, "attempts": 1},
            )
        await asyncio.wait_for(started.wait(), 5)
        assert maximum == active == 4
        assert (await queue.getJobCounts("wait"))["wait"] == 116
        gate.set()
        await asyncio.gather(*(terminal(queue, job_id) for job_id in ids))
        assert calls == 120
        assert sum(store.acks for store in stores) == 120
        assert maximum == 4
    finally:
        gate.set()
        for runner in runners:
            await runner.close()
        await queue.close()


async def test_redis_stop_restart_persists_waiting_jobs_and_consumer_recovers(owned_redis):
    name, url = owned_redis
    prefix = "proof-" + uuid4().hex[:12]
    queue = Queue("outage", {"connection": queue_connection_url(url), "prefix": prefix})
    worker = None
    calls = 0

    async def processor(job, token):
        nonlocal calls
        calls += 1
        return {"synthetic": True}

    try:
        for i in range(20):
            await queue.add("synthetic", {"index": i}, {"jobId": f"proof-{i}", "attempts": 1})
        worker = Worker(
            "outage",
            processor,
            {
                "connection": queue_connection_url(url),
                "prefix": prefix,
                "autorun": False,
                "runRetryDelay": 100,
            },
        )
        worker.on("error", lambda *args: None)
        docker("stop", "-t", "1", name)
        running = asyncio.create_task(worker.run())
        await asyncio.sleep(0.25)
        assert calls == 0
        docker("start", name)
        await asyncio.gather(*(terminal(queue, f"proof-{i}", timeout=25) for i in range(20)))
        assert calls == 20
        await worker.close()
        await asyncio.wait_for(running, 5)
        worker = None
    finally:
        if worker is not None:
            await worker.close(force=True)
        await queue.close()


async def test_own_worker_sigkill_recovers_and_maxstalled_exhausts(owned_redis, tmp_path):
    _, url = owned_redis
    prefix = "proof-" + uuid4().hex[:12]
    script = tmp_path / "synthetic_child.py"
    script.write_text("""import asyncio,json,sys
from bullmq import Worker
async def main():
 async def process(job,token):
  print(json.dumps({"active":job.id}),flush=True)
  await asyncio.sleep(60)
 w=Worker("stall",process,{"connection":sys.argv[1],"prefix":sys.argv[2],"lockDuration":500,"lockRenewTime":200,"stalledInterval":100,"maxStalledCount":1})
 w.on("error",lambda *args:None)
 await asyncio.sleep(60)
asyncio.run(main())
""")
    queue = Queue("stall", {"connection": queue_connection_url(url), "prefix": prefix})
    children = []
    recover = None
    try:
        await queue.add("synthetic", {}, {"jobId": "proof-stall", "attempts": 1})
        for _ in range(2):
            child = await asyncio.create_subprocess_exec(
                sys.executable,
                str(script),
                queue_connection_url(url),
                prefix,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL,
            )
            children.append(child)
            line = await asyncio.wait_for(child.stdout.readline(), 8)
            assert json.loads(line) == {"active": "proof-stall"}
            child.kill()
            await child.wait()
            await asyncio.sleep(0.65)
        recovered = 0

        async def impossible(job, token):
            nonlocal recovered
            recovered += 1
            return {}

        recover = Worker(
            "stall",
            impossible,
            {
                "connection": queue_connection_url(url),
                "prefix": prefix,
                "lockDuration": 500,
                "lockRenewTime": 200,
                "stalledInterval": 100,
                "maxStalledCount": 1,
            },
        )
        recover.on("error", lambda *args: None)
        failed = await terminal(queue, "proof-stall", "failed", timeout=8)
        assert failed.failedReason == "job stalled more than allowable limit"
        assert recovered == 0
    finally:
        for child in children:
            if child.returncode is None:
                child.kill()
                await child.wait()
        if recover is not None:
            await recover.close(force=True)
        await queue.close()


async def test_node_producer_python_consumer_cross_language_wire(owned_redis):
    _, url = owned_redis
    prefix = "proof-" + uuid4().hex[:12]
    config = replace(settings(), redis_url=url, queue_prefix=prefix, concurrency=1)

    class SyntheticEngine:
        async def handle(self, grant, *, before_costly, cancelled):
            await before_costly()
            assert grant["context"]["input"]["text"] == "합성 질문 🧪"
            return {"kind": "failed", "errorCode": "TURN_FAILED"}

    store = Results()
    runner = WorkerRunner(config, ControlFake(), SyntheticEngine(), store)
    queue = Queue(config.queue_name, {"connection": queue_connection_url(url), "prefix": prefix})
    turn_id = str(uuid4())
    job_id = f"t-{turn_id}-0"
    repo = Path(__file__).resolve().parents[3]
    node = """const {Queue}=require(process.argv[1]);const u=new URL(process.argv[2]);
(async()=>{const connection={host:u.hostname,port:Number(u.port)};
const q=new Queue('turns',{connection,prefix:process.argv[3]});
const data={contractVersion:1,turnId:process.argv[4],dispatchSeq:0};
await q.add('turn',data,{jobId:process.argv[5],attempts:1});await q.close()})();"""
    try:
        await runner.start()
        process = await asyncio.create_subprocess_exec(
            "node",
            "-e",
            node,
            str(repo / "packages/messaging/node_modules/bullmq"),
            url,
            prefix,
            turn_id,
            job_id,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        assert await asyncio.wait_for(process.wait(), 5) == 0
        result = await terminal(queue, job_id)
        assert result.returnvalue == {"status": "committed"}
        assert store.acks == 1
    finally:
        await runner.close()
        await queue.close()


async def test_real_lock_renewal_and_token_loss_stop_new_model_work(owned_redis):
    _, url = owned_redis
    prefix = "proof-" + uuid4().hex[:12]
    config = replace(
        settings(),
        redis_url=url,
        queue_prefix=prefix,
        concurrency=1,
        lock_duration_ms=500,
        stalled_interval_ms=100,
    )
    entered, proceed = asyncio.Event(), asyncio.Event()
    store = Results()

    class SyntheticEngine:
        calls = 0

        async def handle(self, _, *, before_costly, cancelled):
            await before_costly()
            self.calls += 1
            entered.set()
            await proceed.wait()
            await before_costly()
            self.calls += 1
            return {"kind": "failed", "errorCode": "TURN_FAILED"}

    engine = SyntheticEngine()
    runner = WorkerRunner(config, ControlFake(), engine, store)
    queue = Queue(config.queue_name, {"connection": queue_connection_url(url), "prefix": prefix})
    turn_id = str(uuid4())
    job_id = f"t-{turn_id}-0"
    renewals = []
    try:
        await runner.start()
        runner.worker.on("locksRenewed", lambda event: renewals.append(event))
        await queue.add(
            "turn",
            {"contractVersion": 1, "turnId": turn_id, "dispatchSeq": 0},
            {"jobId": job_id, "attempts": 1},
        )
        await asyncio.wait_for(entered.wait(), 3)
        await asyncio.sleep(1.1)
        assert len(renewals) >= 3
        assert engine.calls == 1
        await runner.worker.pause(do_not_wait_active=True)
        await runner.redis.delete(runner.lock_key(job_id))
        until = time.monotonic() + 3
        while runner._active and time.monotonic() < until:
            await asyncio.sleep(0.02)
        assert runner._active == 0
        assert engine.calls == 1
        assert store.acks == 0 and not store.values
    finally:
        proceed.set()
        await runner.close()
        await queue.close()
