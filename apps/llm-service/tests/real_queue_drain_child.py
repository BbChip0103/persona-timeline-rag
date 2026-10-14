"""Real BullMQ worker process for the isolated SIGTERM drain regression."""

from __future__ import annotations

import asyncio
import signal
import sys
from dataclasses import replace
from pathlib import Path

from test_worker_control import ControlFake, settings

from ptr_llm.worker import WorkerRunner


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


async def main() -> None:
    url, prefix, marker_name = sys.argv[1:]
    marker = Path(marker_name)

    def record(value: str) -> None:
        with marker.open("a", encoding="utf-8") as output:
            output.write(value + "\n")

    class SlowEngine:
        async def handle(self, _, *, before_costly, cancelled):
            await before_costly()
            record("started")
            await asyncio.sleep(1)
            if cancelled.is_set():
                record("guard_stopped_early")
            await before_costly()
            record("completed")
            return {"kind": "failed", "errorCode": "TURN_FAILED"}

    class RecordingResults(Results):
        async def mark_result_ack(self, grant):
            await super().mark_result_ack(grant)
            record("acked")

    runner = WorkerRunner(
        replace(settings(), redis_url=url, queue_prefix=prefix),
        ControlFake(),
        SlowEngine(),
        RecordingResults(),
    )
    stopping = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stopping.set)
    try:
        await runner.start()
        await stopping.wait()
        record("sigterm")
    finally:
        await runner.close()
        record("closed")


if __name__ == "__main__":
    asyncio.run(main())
