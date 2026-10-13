"""Subprocess fixture for the real uvicorn SIGTERM path, with synthetic in-memory work."""

import asyncio
import os
from pathlib import Path
from types import SimpleNamespace

from test_worker_control import ControlFake, setup

from ptr_llm import __main__ as entry

marker = Path(os.environ["PTR_TEST_DRAIN_MARKER"])


def record(value: str) -> None:
    with marker.open("a", encoding="utf-8") as output:
        output.write(value + "\n")
        output.flush()


class SlowEngine:
    async def handle(self, _, *, before_costly, cancelled):
        await before_costly()
        record("started")
        await asyncio.sleep(1)
        await before_costly()
        assert not cancelled.is_set()
        record("completed")
        return {"kind": "failed", "errorCode": "TURN_FAILED"}


class SyntheticRunner:
    def __init__(self, _settings, control, _engine, _store):
        self.runner, self.job, self.control, _, self.store, _ = setup()
        self.runner.engine = SlowEngine()
        self.runner.control = control
        original_ack = self.store.mark_result_ack

        async def record_ack(grant):
            await original_ack(grant)
            record("acked")

        self.store.mark_result_ack = record_ack

    async def start(self):
        self.task = asyncio.create_task(self.runner.process(self.job, "synthetic-token"))
        self.runner.worker = SimpleNamespace(close=lambda: self.task)
        self.runner._worker_task = self.task

    async def close(self):
        await self.runner.close()
        assert self.task.result() == {"status": "committed"}
        assert self.store.acks == 1

    async def health(self):
        return True


class SyntheticControl(ControlFake):
    def __init__(self, *_args, **_kwargs):
        super().__init__()

    async def close(self):
        record("control_closed")


class SyntheticRuntime:
    engine = None
    result_store = None

    async def catalogue(self):
        return []

    async def draft(self, _body):
        return {}

    async def health(self):
        return True

    async def close(self):
        record("runtime_closed")


async def build_runtime(_settings):
    return SyntheticRuntime()


entry.Settings = SimpleNamespace(from_env=lambda: SimpleNamespace(
    backend_url="http://127.0.0.1:1", control_token="synthetic", backend_timeout=1,
    host="127.0.0.1", port=int(os.environ["PTR_TEST_DRAIN_PORT"]),
))
entry.ControlClient = SyntheticControl
entry.WorkerRunner = SyntheticRunner

import ptr_llm.runtime  # noqa: E402

ptr_llm.runtime.build_runtime = build_runtime
asyncio.run(entry.run(os.environ.get("PTR_TEST_DRAIN_MODE", "worker")))
