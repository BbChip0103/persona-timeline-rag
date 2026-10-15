"""Drive one real queued turn across a killed worker, then check every submitted turn."""

import asyncio
import importlib.util
import json
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from threading import Thread

import httpx
import psycopg
from redis.asyncio import Redis

EVIDENCE = Path("/evidence")
APP = "postgresql://ptr_split_app:synthetic-acceptance-only@127.0.0.1:58432/ptr_split_test"
TOKEN = "synthetic-test-token-for-c4-only-123456789"
SLOT_KEY = "ptr:llm:local-slots"
ENGINE_SPEC = importlib.util.spec_from_file_location(
    "c4_engine", Path("/source/infra/fake-engine/fake-engine.py")
)
engine = importlib.util.module_from_spec(ENGINE_SPEC)
ENGINE_SPEC.loader.exec_module(engine)


async def until(check, seconds=30):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        result = await check()
        if result:
            return result
        await asyncio.sleep(0.05)
    raise AssertionError("C4_TIMEOUT")


async def main():
    server = ThreadingHTTPServer(("127.0.0.1", 18001), engine.Handler)
    server.daemon_threads = True
    Thread(target=server.serve_forever, daemon=True).start()
    redis = Redis.from_url("redis://:synthetic-acceptance-only@127.0.0.1:58479/0")
    try:
        async with httpx.AsyncClient(base_url="http://127.0.0.1:56441", timeout=5) as client:
            headers = {"Authorization": "Bearer " + TOKEN, "X-PTR-Owner": "lt-c4"}

            async def request(method, path, body=None):
                response = await client.request(method, "/api/" + path, headers=headers, json=body)
                response.raise_for_status()
                return response.json()

            async def ready():
                try:
                    api = await client.get("/api/health")
                    worker = await client.get("http://127.0.0.1:58442/health/ready")
                    return api.status_code == worker.status_code == 200
                except httpx.HTTPError:
                    return False

            await until(ready, 45)
            submitted = []

            async def submit(key, *, stall=False):
                session = (
                    await request(
                        "POST",
                        "sessions",
                        {
                            "personId": "synthetic-split-person",
                            "retrievalMode": "off",
                            "ragCondition": "off",
                            "executionProfile": "agent_loop",
                        },
                    )
                )["session"]["id"]
                turn = (
                    await request(
                        "POST",
                        f"sessions/{session}/turns",
                        {
                            "clientRequestId": key,
                            "text": "가상의 파란 하늘 이야기를 들려줘요."
                            + (" K4_ID:c4-first __STALL_GENERATION_ONCE__" if stall else ""),
                        },
                    )
                )["turn"]
                submitted.append(turn["id"])
                return turn["id"]

            async def terminal(turn_id):
                result = await request("GET", f"turns/{turn_id}")
                turn = result["turn"]
                return turn if turn["state"] in ("completed", "failed", "cancelled") else None

            first = await submit("killed-in-flight", stall=True)

            async def in_flight():
                with engine._lock:
                    return engine._counts["active"] >= 1

            await until(in_flight, 10)
            with psycopg.connect(APP) as db:
                deadline = db.execute(
                    "SELECT deadline_at FROM app.turn_execution_grants WHERE turn_id=%s",
                    (first,),
                ).fetchone()[0]
            EVIDENCE.joinpath("in-flight").write_text("1\n")
            await until(lambda: asyncio.sleep(0, result=EVIDENCE.joinpath("killed").exists()), 10)
            leases = await redis.zrange(SLOT_KEY, 0, -1, withscores=True)
            assert len(leases) == 1, "LEASE_NOT_HELD_AT_KILL"
            killed_lease = leases[0][0]
            lease_expires_ms = leases[0][1] * 1000
            EVIDENCE.joinpath("lease.json").write_text(
                json.dumps(
                    {
                        "deadline_ms": int(deadline),
                        "lease_expiry_lag_ms": round(lease_expires_ms - deadline),
                    }
                )
                + "\n"
            )

            observed = {}

            async def watch_recovery():
                end = time.monotonic() + 45
                while time.monotonic() < end:
                    now = time.time() * 1000
                    with psycopg.connect(APP) as db:
                        seq, attempts = db.execute(
                            "SELECT dispatch_seq,attempts FROM app.turns WHERE id=%s", (first,)
                        ).fetchone()
                    old_lease = await redis.zscore(SLOT_KEY, killed_lease)
                    with engine._lock:
                        first_calls = sum(engine._marker_requests.get("c4-first", {}).values())
                    if seq >= 1 and "repair_at_ms" not in observed:
                        observed["repair_at_ms"] = now
                        observed["repair_old_lease_held"] = (
                            old_lease is not None and now < lease_expires_ms
                        )
                    if attempts >= 2 and "retry_claim_at_ms" not in observed:
                        observed["retry_claim_at_ms"] = now
                        observed["retry_claim_old_lease_held"] = (
                            old_lease is not None and now < lease_expires_ms
                        )
                    if old_lease is None and "reclaimed_at_ms" not in observed:
                        observed["reclaimed_at_ms"] = now
                    if first_calls >= 2 and "retry_engine_at_ms" not in observed:
                        observed["retry_engine_at_ms"] = now
                        observed["retry_engine_old_lease_held"] = old_lease is not None
                    if all(
                        key in observed
                        for key in (
                            "repair_at_ms",
                            "retry_claim_at_ms",
                            "reclaimed_at_ms",
                            "retry_engine_at_ms",
                        )
                    ):
                        return
                    await asyncio.sleep(0.02)
                raise AssertionError("RECOVERY_OBSERVATION_TIMEOUT")

            watcher = asyncio.create_task(watch_recovery())
            await until(
                lambda: asyncio.sleep(0, result=EVIDENCE.joinpath("restarted").exists()), 20
            )
            await until(ready, 45)
            await until(lambda: asyncio.sleep(0, result=observed.get("retry_claim_at_ms")), 35)
            assert observed["repair_old_lease_held"], "REPAIR_AFTER_LEASE_EXPIRY"
            assert observed["retry_claim_old_lease_held"], "RETRY_CLAIM_AFTER_LEASE_EXPIRY"
            for index in range(4):
                await submit(f"queued-after-crash-{index}")
            await watcher
            reclaimed_at = observed["reclaimed_at_ms"]
            EVIDENCE.joinpath("recovery-observed.json").write_text(json.dumps(observed) + "\n")
            assert lease_expires_ms <= deadline + 2000, "SLOT_EXPIRY_LATE"
            assert reclaimed_at <= deadline + 2000, "SLOT_RECLAIM_LATE"
            assert not observed["retry_engine_old_lease_held"], "RETRY_BYPASSED_HELD_SLOT"
            assert observed["retry_engine_at_ms"] >= lease_expires_ms, "RETRY_ACQUIRED_TOO_EARLY"

            first_result = await until(lambda: terminal(first), 50)
            EVIDENCE.joinpath("first.json").write_text(
                json.dumps(
                    {"state": first_result["state"], "errorCode": first_result.get("errorCode")}
                )
                + "\n"
            )
            assert first_result["state"] == "completed", "RETRIED_TURN_NOT_COMPLETED"
            assert first_result.get("errorCode") is None, "RETRIED_TURN_ERROR"
            for turn_id in submitted[1:]:
                outcome = await until(lambda turn_id=turn_id: terminal(turn_id), 65)
                assert outcome["state"] == "completed", "QUEUED_TURN_NOT_COMPLETED"
                assert outcome.get("errorCode") is None, "QUEUED_TURN_ERROR"

            async def queue_idle():
                return (
                    await redis.llen("ptr:c4-turns:active") == 0
                    and await redis.llen("ptr:c4-turns:wait") == 0
                    and await redis.zcard("ptr:c4-turns:delayed") == 0
                )

            await until(queue_idle, 30)
            with psycopg.connect(APP) as db:
                rows = db.execute(
                    "SELECT t.id,t.state,t.error_code,t.attempts,t.dispatch_seq,"
                    "count(m.id) FILTER (WHERE m.role='assistant') "
                    "FROM app.turns t LEFT JOIN app.messages m ON m.turn_id=t.id "
                    "WHERE t.id=ANY(%s) GROUP BY t.id",
                    (submitted,),
                ).fetchall()
                outbox = db.execute("SELECT count(*) FROM app.turn_outbox").fetchone()[0]
            with psycopg.connect(APP.replace("ptr_split_app", "ptr_split_owner")) as db:
                paid_ledger_present = db.execute(
                    "SELECT to_regclass('public.ptr_provider_requests') IS NOT NULL"
                ).fetchone()[0]
                paid_submissions = (
                    db.execute("SELECT count(*) FROM public.ptr_provider_requests").fetchone()[0]
                    if paid_ledger_present
                    else 0
                )
            by_id = {
                turn_id: (state, code, attempts, seq, assistants)
                for turn_id, state, code, attempts, seq, assistants in rows
            }
            assert len(rows) == len(submitted) == len(by_id), "LOST_OR_DUPLICATE_TURN"
            assert by_id[first] == ("completed", None, 2, 1, 1), "RETRIED_TURN_ACCOUNTING"
            assert all(
                by_id.get(turn_id) == ("completed", None, 1, 0, 1) for turn_id in submitted[1:]
            ), "QUEUED_TURN_ACCOUNTING"
            assert outbox == 0, "STUCK_OUTBOX"
            assert paid_submissions == 0, "PAID_CALL_RESUBMITTED"

            async def engine_idle():
                with engine._lock:
                    return engine._counts["active"] == 0

            await until(engine_idle, 20)
            with engine._lock:
                local_submissions = engine._counts["submitted"]
                local_successes = engine._counts["success"]
                stalled_generations = engine._counts["stalled_generation"]
                first_calls = sum(engine._marker_requests.get("c4-first", {}).values())
            assert local_submissions == 6, "UNEXPECTED_LOCAL_SUBMISSIONS"
            assert local_successes == 6, "LOCAL_CALLS_NOT_SUCCESSFUL"
            assert stalled_generations == 1, "STALL_NOT_ISOLATED"
            assert first_calls == 2, "FIRST_TURN_NOT_RETRIED_ONCE"
            result = {
                "case": "C4",
                "worker_container_killed": True,
                "deadline_ms": int(deadline),
                "lease_expiry_lag_ms": round(lease_expires_ms - deadline),
                "reclaimed_lag_ms": round(reclaimed_at - deadline),
                "reclaimed_within_deadline_plus_2s": True,
                "repair_dispatch_seq": by_id[first][3],
                "retry_attempts": by_id[first][2],
                "retry_claim_old_lease_held": observed["retry_claim_old_lease_held"],
                "retry_engine_old_lease_held": observed["retry_engine_old_lease_held"],
                "retry_slot_path": "waited_for_old_lease_expiry",
                "retry_slot_wait_ms": round(
                    observed["retry_engine_at_ms"] - observed["retry_claim_at_ms"]
                ),
                "submitted": len(submitted),
                "terminal": len(rows),
                "completed": sum(row[1] == "completed" for row in rows),
                "failed": sum(row[1] == "failed" for row in rows),
                "error_codes": {
                    code: sum(row[2] == code for row in rows)
                    for code in sorted({row[2] for row in rows if row[2]})
                },
                "outbox": outbox,
                "paid_submissions": paid_submissions,
                "paid_ledger_present": paid_ledger_present,
                "fake_local_submissions": local_submissions,
                "fake_local_successes": local_successes,
                "fake_stalled_generations": stalled_generations,
                "fake_first_turn_calls": first_calls,
                "first_assistant_messages": by_id[first][4],
                "first_state": first_result["state"],
                "first_error": first_result.get("errorCode"),
            }
            EVIDENCE.joinpath("c4.json").write_text(json.dumps(result, indent=2) + "\n")
            print(json.dumps(result), flush=True)
    finally:
        await redis.aclose()
        server.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
