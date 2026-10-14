"""Local-concurrency BullMQ consumer with backend fencing and durable commit ACK.

The queue lease and PostgreSQL fence are separate authorities. This module never
claims upstream exactly-once; providers own stable paid-call ambiguity protection.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any, Protocol
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from uuid import uuid4

from bullmq import Worker
from redis.asyncio import Redis
from redis.asyncio.retry import Retry
from redis.backoff import ExponentialBackoff

from .config import Settings
from .control import ControlClient, ControlRejected, ControlUnavailable, validate_wire


def queue_connection_url(url: str) -> str:
    # redis-py 8 defaults socket_timeout=5 while BullMQ uses 5s idle blocks
    # (up to 10s for delayed markers). Equality makes the socket time out and
    # retry forever before receiving Redis' nil response. This is transport
    # configuration, not a private SDK patch. Guard commands stay bounded.
    parsed = urlsplit(url)
    query = [
        (k, v)
        for k, v in parse_qsl(parsed.query)
        if k not in {"socket_timeout", "socket_connect_timeout"}
    ]
    query.extend([("socket_timeout", "15"), ("socket_connect_timeout", "5")])
    return urlunsplit(parsed._replace(query=urlencode(query)))


ACK_RETRY_GRACE_SECONDS = 5.0


class ExecutionStopped(RuntimeError):
    def __init__(self, code: str = "EXECUTION_LOST") -> None:
        super().__init__(code)


class ResultStore(Protocol):
    async def get_result(self, grant: dict[str, Any]) -> dict[str, Any] | None: ...
    async def put_result(self, grant: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]: ...
    async def mark_result_ack(self, grant: dict[str, Any]) -> None: ...


class Engine(Protocol):
    async def handle(
        self,
        grant: dict[str, Any],
        *,
        before_costly: Callable[[], Awaitable[None]],
        cancelled: asyncio.Event,
    ) -> dict[str, Any]: ...


def deadline_seconds(grant: dict[str, Any]) -> float:
    value = grant.get("deadlineAt")
    if type(value) is not int or not 0 <= value <= 9007199254740991:
        raise ControlRejected()
    return value / 1000 - time.time()


def _dispatch(value: Any) -> dict[str, Any]:
    return validate_wire("Dispatch", value)


class ExecutionGuard:
    """Every costly submission needs a fresh affirmative lease + backend check."""

    def __init__(self, runner: WorkerRunner, binding: dict[str, Any], grant: dict[str, Any]):
        self.runner, self.binding, self.grant = runner, binding, grant
        self.cancelled = asyncio.Event()
        self.reason = "EXECUTION_LOST"

    def stop(self, reason: str) -> None:
        self.reason = reason
        self.cancelled.set()

    async def ownership(self) -> None:
        """Actual token ownership, independent of permission to start model work."""
        try:
            actual = await asyncio.wait_for(
                self.runner.redis.get(self.runner.lock_key(self.binding["jobId"])),
                self.runner.settings.backend_timeout,
            )
            if isinstance(actual, bytes):
                actual = actual.decode("ascii")
        except Exception:
            raise ControlUnavailable() from None
        if actual != self.binding["lockToken"]:
            self.stop("EXECUTION_LOST")
            raise ExecutionStopped(self.reason)

    async def lease(self, *, terminal_delivery: bool = False) -> None:
        if self.cancelled.is_set() and not (
            terminal_delivery and self.reason == "EXECUTION_TIMEOUT"
        ):
            raise ExecutionStopped(self.reason)
        # An expired old owner must remain LOST, not be relabelled TIMEOUT.
        await self.ownership()
        if not terminal_delivery and deadline_seconds(self.grant) <= 0:
            self.stop("EXECUTION_TIMEOUT")
            raise ExecutionStopped(self.reason)

    async def before_costly(self) -> None:
        await self.lease()
        response = await self.runner.control.status(self.binding)
        if response["status"] != "current":
            reason = (
                "EXECUTION_CANCELLED" if response["status"] == "cancelled" else "EXECUTION_LOST"
            )
            if response["status"] == "lost" and deadline_seconds(self.grant) <= 0:
                await self.ownership()
                reason = "EXECUTION_TIMEOUT"
            self.stop(reason)
            raise ExecutionStopped(self.reason)
        # The status RPC may have spent the remaining deadline/lease. Never use
        # a grant which expired during that check as permission to submit.
        await self.lease()

    async def monitor(self) -> None:
        failures = 0
        while not self.cancelled.is_set():
            await asyncio.sleep(self.runner.settings.status_interval)
            try:
                await self.before_costly()
                failures = 0
            except (ControlUnavailable, ControlRejected):
                failures += 1
                if failures >= 2:
                    self.stop("CONTROL_UNAVAILABLE")
            except ExecutionStopped:
                return


class WorkerRunner:
    def __init__(
        self,
        settings: Settings,
        control: ControlClient,
        engine: Engine,
        result_store: ResultStore,
        *,
        redis: Any = None,
    ):
        self.settings, self.control, self.engine, self.result_store = (
            settings,
            control,
            engine,
            result_store,
        )
        self.redis = redis or Redis.from_url(
            settings.redis_url,
            decode_responses=True,
            socket_timeout=settings.backend_timeout,
            socket_connect_timeout=settings.backend_timeout,
        )
        self._owns_redis = redis is None
        self.worker: Worker | None = None
        self._worker_task: asyncio.Task | None = None
        self.ready = False
        self._active = 0
        self._guards: dict[str, ExecutionGuard] = {}

    def lock_key(self, job_id: str) -> str:
        return f"{self.settings.queue_prefix}:{self.settings.queue_name}:{job_id}:lock"

    async def start(self) -> None:
        # Pinned Python binding has a proven global-cap liveness failure. Do not
        # mutate/remove an operator's cap or silently invent a capacity layer.
        cap = await self.redis.hget(
            f"{self.settings.queue_prefix}:{self.settings.queue_name}:meta", "concurrency"
        )
        if cap is not None:
            raise ExecutionStopped("GLOBAL_CONCURRENCY_UNSUPPORTED")
        self.worker = Worker(
            self.settings.queue_name,
            self.process,
            {
                "autorun": False,
                "connection": queue_connection_url(self.settings.redis_url),
                "prefix": self.settings.queue_prefix,
                "concurrency": self.settings.concurrency,
                "lockDuration": self.settings.lock_duration_ms,
                "lockRenewTime": self.settings.lock_duration_ms // 2,
                "stalledInterval": self.settings.stalled_interval_ms,
                "maxStalledCount": self.settings.max_stalled_count,
                "runRetryDelay": 1000,
            },
        )
        # Never log SDK errors: Redis URLs, lock tokens and response bodies can
        # appear in them. Readiness is tested against Redis independently.
        for client in (self.worker.client, self.worker.bclient):
            client.set_retry(Retry(ExponentialBackoff(cap=1, base=0.1), 2))
        self.worker.on("error", lambda *args: None)
        self.worker.on("lockRenewalFailed", self._lock_renewal_failed)
        self._worker_task = asyncio.create_task(self.worker.run())
        self._worker_task.add_done_callback(self._worker_done)
        self.ready = True

    def _worker_done(self, task: asyncio.Task) -> None:
        # BullMQ's run loop can finish while close() still waits for active jobs.
        # Readiness was already cleared by close() in that case; their guards
        # must remain live until the jobs finish and ACK.
        unexpected_exit = self.ready
        self.ready = False
        if not task.cancelled():
            task.exception()  # consume without logging private Redis exception text
        if unexpected_exit:
            for guard in tuple(self._guards.values()):
                guard.stop("CONTROL_UNAVAILABLE")

    def _lock_renewal_failed(self, job_ids: list[str]) -> None:
        for job_id in job_ids:
            guard = self._guards.get(job_id)
            if guard is not None:
                guard.stop("EXECUTION_LOST")

    async def health(self) -> bool:
        if not self.ready:
            return False
        try:
            return bool(await asyncio.wait_for(self.redis.ping(), self.settings.backend_timeout))
        except Exception:
            return False

    async def close(self) -> None:
        self.ready = False
        if self.worker is not None:
            await self.worker.close()
        if self._worker_task is not None:
            await asyncio.gather(self._worker_task, return_exceptions=True)
        if self._owns_redis:
            await self.redis.aclose()
        await self.control.close()

    async def _claim(self, dispatch: dict[str, Any], job_id: str, token: str) -> dict[str, Any]:
        # One executionId per lock acquisition, reused on transport retries.
        body = {**dispatch, "jobId": job_id, "lockToken": token, "executionId": str(uuid4())}
        for attempt in range(3):
            try:
                result = await self.control.start(body)
                if (
                    result.get("status") == "granted"
                    and result["grant"].get("executionId") != body["executionId"]
                ):
                    raise ControlRejected()
                return result
            except ControlUnavailable:
                if attempt == 2:
                    raise
                await asyncio.sleep(0.05 * (attempt + 1))
        raise ControlUnavailable()

    async def process(self, job: Any, token: str, signal: Any = None) -> dict[str, Any]:
        try:
            dispatch = _dispatch(job.data)
            expected_id = f"t-{dispatch['turnId']}-{dispatch['dispatchSeq']}"
            if job.id != expected_id or not isinstance(token, str) or not token:
                raise ControlRejected()
            claim = await self._claim(dispatch, job.id, token)
            if claim["status"] != "granted":
                return {"status": "obsolete"}
            grant = validate_wire("Grant", claim["grant"])
            if any(grant.get(k) != dispatch[k] for k in dispatch):
                raise ControlRejected()
            if (
                not isinstance(grant.get("executionId"), str)
                or type(grant.get("generation")) is not int
            ):
                raise ControlRejected()
            binding = {
                **dispatch,
                "executionId": grant["executionId"],
                "generation": grant["generation"],
                "jobId": job.id,
                "lockToken": token,
            }
            guard = ExecutionGuard(self, binding, grant)
            self._active += 1
            self._guards[job.id] = guard
            try:
                return await self._execute(guard, grant, binding, signal)
            finally:
                self._active -= 1
                self._guards.pop(job.id, None)
        except (ControlUnavailable, ControlRejected, ExecutionStopped):
            raise
        except asyncio.CancelledError:
            raise
        except Exception:
            # SDK stores exception text/stack. Do not persist provider/control
            # raw exceptions or configuration in queue failure reasons.
            raise ExecutionStopped("LLM_WORKER_FAILED") from None

    async def _receipt_io(
        self,
        guard: ExecutionGuard,
        work: Callable[[], Awaitable[Any]],
        *,
        terminal_delivery: bool = False,
        committed: bool = False,
    ) -> Any:
        """Bound receipt DB waits and watch cancellation/ownership throughout.

        A current holder can read/repost an immutable receipt after its model
        deadline to recover a lost commit ACK. That exception never permits a
        fresh model call; all receipt operations still have a bounded I/O budget.
        """

        async def check() -> None:
            if committed:
                # Complete already proved authoritative commit; status is now
                # terminal, not 'current'. This is only bookkeeping, not a model.
                await guard.ownership()
                return
            await guard.lease(terminal_delivery=terminal_delivery)
            status = await self.control.status(guard.binding)
            if status["status"] == "cancelled":
                guard.stop("EXECUTION_CANCELLED")
                raise ExecutionStopped(guard.reason)
            if status["status"] != "current" and not (
                terminal_delivery and deadline_seconds(guard.grant) <= 0
            ):
                guard.stop("EXECUTION_LOST")
                raise ExecutionStopped(guard.reason)
            await guard.lease(terminal_delivery=terminal_delivery)

        # Avoid a redundant status RPC on ordinary fast receipt operations.
        # The watcher below is the backstop for a stalled DB operation; the
        # authoritative Complete CAS still checks cancellation and deadline.
        await guard.lease(terminal_delivery=terminal_delivery)
        remaining = deadline_seconds(guard.grant)
        budget = self.settings.backend_timeout
        if not terminal_delivery and remaining > 0:
            budget = min(budget, remaining)
        elif not terminal_delivery:
            guard.stop("EXECUTION_TIMEOUT")
            raise ExecutionStopped(guard.reason)

        async def watch() -> None:
            while True:
                await asyncio.sleep(self.settings.status_interval)
                await check()

        async def execute() -> Any:
            return await work()

        operation = asyncio.create_task(execute())
        monitor = asyncio.create_task(watch())
        try:
            async with asyncio.timeout(budget):
                done, _ = await asyncio.wait(
                    {operation, monitor}, return_when=asyncio.FIRST_COMPLETED
                )
                if monitor in done:
                    await monitor
                return await operation
        except TimeoutError:
            if deadline_seconds(guard.grant) <= 0 and not terminal_delivery:
                guard.stop("EXECUTION_TIMEOUT")
                raise ExecutionStopped(guard.reason) from None
            raise ControlUnavailable() from None
        finally:
            operation.cancel()
            monitor.cancel()
            await asyncio.gather(operation, monitor, return_exceptions=True)

    async def _execute(
        self, guard: ExecutionGuard, grant: dict[str, Any], binding: dict[str, Any], signal: Any
    ) -> dict[str, Any]:
        result = await self._receipt_io(
            guard, lambda: self.result_store.get_result(grant), terminal_delivery=True
        )
        if result is None:
            if deadline_seconds(grant) <= 0:
                # Claim ACK itself may arrive late. Never restart a model just
                # to report the valid holder's already-expired execution.
                guard.stop("EXECUTION_TIMEOUT")
                result = {"kind": "failed", "errorCode": "TURN_TIMEOUT"}
            else:
                result = await self._run_engine(guard, grant, signal)
            result = validate_wire("Result", result)
            if result["kind"] == "completed":
                try:
                    # No new model submission occurs here. Fresh ownership,
                    # cancellation signal and local deadline still gate receipt
                    # persistence; Complete performs the authoritative backend
                    # fence/cancellation/deadline CAS without a redundant status RPC.
                    await guard.lease()
                except ExecutionStopped as error:
                    if str(error) != "EXECUTION_TIMEOUT":
                        raise
                    result = {"kind": "failed", "errorCode": "TURN_TIMEOUT"}
            # Failed terminal reporting is not a costly submission. Deadline
            # expiry stops new models, not the current holder's failure CAS.
            # Cancellation/lost token/control uncertainty still fail closed.
            await guard.lease(terminal_delivery=result["kind"] == "failed")
            result = await self._receipt_io(
                guard,
                lambda: self.result_store.put_result(grant, result),
                terminal_delivery=True,
            )
        result = validate_wire("Result", result)
        # A committed success may have lost its ACK as the deadline elapsed.
        # Retry only the exact durable payload, for bounded transport time;
        # backend idempotency precedes its expired-success rejection.
        retry_until = time.monotonic() + ACK_RETRY_GRACE_SECONDS
        while time.monotonic() < retry_until:
            await guard.lease(terminal_delivery=True)
            try:
                ack = await self.control.complete(binding, result)
            except ControlUnavailable:
                await asyncio.sleep(min(0.1, max(0, retry_until - time.monotonic())))
                continue
            if ack["status"] in {"applied", "alreadyApplied"}:
                await self._receipt_io(
                    guard,
                    lambda: self.result_store.mark_result_ack(grant),
                    terminal_delivery=True,
                    committed=True,
                )
                return {"status": "committed"}
            if ack["status"] in {"lost", "cancelled"}:
                return {"status": "obsolete"}
            raise ControlRejected()
        raise ControlUnavailable()

    async def _run_engine(
        self, guard: ExecutionGuard, grant: dict[str, Any], signal: Any
    ) -> dict[str, Any]:
        monitor = asyncio.create_task(guard.monitor())
        execution = asyncio.create_task(
            self.engine.handle(
                grant,
                before_costly=guard.before_costly,
                cancelled=guard.cancelled,
            )
        )
        stopped = asyncio.create_task(guard.cancelled.wait())
        signal_task = asyncio.create_task(signal.wait()) if signal is not None else None
        waiters = {execution, stopped}
        if signal_task is not None:
            waiters.add(signal_task)
        try:
            done, _ = await asyncio.wait(waiters, return_when=asyncio.FIRST_COMPLETED)
            if execution not in done or guard.cancelled.is_set():
                guard.stop("EXECUTION_CANCELLED" if signal_task in done else guard.reason)
                execution.cancel()
                await asyncio.gather(execution, return_exceptions=True)
                if guard.reason == "EXECUTION_TIMEOUT":
                    await guard.lease(terminal_delivery=True)
                    return {"kind": "failed", "errorCode": "TURN_TIMEOUT"}
                raise ExecutionStopped(guard.reason)
            return await execution
        finally:
            for task in (monitor, stopped, signal_task):
                if task is not None:
                    task.cancel()
            await asyncio.gather(
                *(t for t in (monitor, stopped, signal_task) if t is not None),
                return_exceptions=True,
            )
            if not execution.done():
                execution.cancel()
                await asyncio.gather(execution, return_exceptions=True)
