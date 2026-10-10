"""Actual Nest/Python/PG/Redis synthetic integration, isolated from old research."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx
import psycopg

from persona_timeline_rag.split_migration import read_environment


async def smoke(
    roles: Path, output: Path, *, provider_env: dict[str, str] | None = None, browser: bool = False
):
    credentials = read_environment(roles)
    output.mkdir(mode=0o700, parents=True, exist_ok=True)
    queue = "split-smoke-" + secrets.token_hex(4)
    env = {
        "PATH": os.environ["PATH"],
        "HOME": os.environ["HOME"],
        "NODE_ENV": "production",
        "LANGSMITH_TRACING": "false",
        "LANGCHAIN_TRACING_V2": "false",
        "PTR_APP_DATABASE_URL": credentials["PTR_SPLIT_TEST_APP_DATABASE_URL"],
        "PTR_LLM_DATABASE_URL": credentials["PTR_SPLIT_TEST_LLM_DATABASE_URL"],
        "PTR_REDIS_URL": credentials["PTR_REDIS_URL"],
        "PTR_LLM_REDIS_URL": credentials["PTR_REDIS_URL"],
        "PTR_LLM_CONTROL_TOKEN": credentials["PTR_LLM_CONTROL_TOKEN"],
        "PTR_API_TOKEN": secrets.token_hex(24),
        "PTR_API_SYNTHETIC_TOKEN": secrets.token_hex(24),
        "PTR_LLM_SERVICE_MODE": "split",
        "PTR_API_PORT": "58441",
        "PTR_LLM_BACKEND_URL": "http://127.0.0.1:58441",
        "PTR_LLM_SERVICE_URL": "http://127.0.0.1:58442",
        "PTR_LLM_PORT": "58442",
        "PTR_TURN_QUEUE": queue,
        "PTR_LLM_QUEUE_NAME": queue,
        "PTR_EVENTS_NAMESPACE": queue,
        "PTR_LLM_PROVIDER": "fake",
        "PTR_QUEUE_MAX_DEPTH": "64",
        "PTR_LLM_CONCURRENCY": "4",
        "PTR_DB_POOL_MAX": "8",
        "PTR_LLM_LOCK_DURATION_MS": "1000",
        "PTR_LLM_STALLED_INTERVAL_MS": "500",
        "PTR_DISPATCH_INTERVAL_MS": "100",
        "PTR_DISPATCH_GRACE_MS": "200",
    }
    env.update(provider_env or {})
    if browser:
        env.update({"PTR_API_PORT": "56449", "PTR_LLM_BACKEND_URL": "http://127.0.0.1:56449"})
    api_env = {
        k: v
        for k, v in env.items()
        if not (
            k.startswith("LANGFUSE_")
            or k == "OPENROUTER_API_KEY"
            or k.startswith("PTR_LLM_")
            and k
            not in {
                "PTR_LLM_SERVICE_MODE",
                "PTR_LLM_SERVICE_URL",
                "PTR_LLM_CONTROL_TOKEN",
                "PTR_LLM_SEMANTIC_SEARCH",
            }
        )
    }
    worker_env = {
        k: v
        for k, v in env.items()
        if k
        not in {"PTR_APP_DATABASE_URL", "DATABASE_URL", "PTR_API_TOKEN", "PTR_API_SYNTHETIC_TOKEN"}
    }
    assert "PTR_APP_DATABASE_URL" not in worker_env and "PTR_LLM_DATABASE_URL" not in api_env
    children = []
    web_process = None
    logs = []
    gates = {}
    try:
        for command, label in [
            (["node", "--import", "tsx", "apps/api/src/main.ts"], "api"),
            ([sys.executable, "-m", "ptr_llm", "worker"], "worker"),
        ]:
            log = (output / (label + ".private.log")).open("wb")
            logs.append(log)
            os.chmod(log.name, 0o600)
            children.append(
                subprocess.Popen(
                    command,
                    env=api_env if label.startswith("api") else worker_env,
                    stdout=log,
                    stderr=log,
                )
            )
        async with httpx.AsyncClient(
            base_url="http://127.0.0.1:" + env["PTR_API_PORT"], timeout=35
        ) as client:

            async def request(path, body=None, owner="lt-split"):
                headers = {
                    "Authorization": "Bearer " + env["PTR_API_SYNTHETIC_TOKEN"],
                    "X-PTR-Owner": owner,
                }
                response = await client.request(
                    "GET" if body is None else "POST", "/api/" + path, headers=headers, json=body
                )
                return response

            for _ in range(160):
                if any(p.poll() is not None for p in children):
                    raise RuntimeError("SPLIT_PROCESS_EXITED")
                try:
                    a = await client.get("/api/health")
                    async with httpx.AsyncClient(timeout=2) as c:
                        b = await c.get("http://127.0.0.1:58442/health/ready")
                    if a.status_code == 200 and b.status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.1)
            else:
                raise RuntimeError("SPLIT_READINESS_TIMEOUT")
            gates["auth"] = (await client.get("/api/personas")).status_code == 403
            catalogue = await request("personas")
            gates["catalogue"] = catalogue.status_code == 200
            print("catalogue gate:", gates["catalogue"], flush=True)

            async def session(caption=False):
                response = await request(
                    "sessions",
                    {
                        "personId": "synthetic-split-person",
                        "retrievalMode": "lexical" if caption else "off",
                        "ragCondition": "caption" if caption else "off",
                        "executionProfile": "agent_loop",
                    },
                )
                if not response.is_success:
                    raise RuntimeError("SESSION_CREATE_FAILED_" + str(response.status_code))
                return response.json()["session"]["id"]

            async def send(s, key, text="안녕하세요. 가상의 이야기를 나눠요.", caption=False):
                body = {"clientRequestId": key, "text": text}
                if caption:
                    body.update(
                        {
                            "intent": "timeline",
                            "timeline": {"query": "파란책", "dateBasis": "posted", "limit": 3},
                        }
                    )
                response = await request("sessions/" + s + "/turns", body)
                if not response.is_success:
                    raise RuntimeError("TURN_CREATE_FAILED_" + str(response.status_code))
                return response.json()["turn"]

            async def terminal(turn):
                for _ in range(220):
                    response = await request("turns/" + turn["id"])
                    current = response.json()["turn"]
                    if current["state"] in ("completed", "failed", "cancelled"):
                        return current
                    await asyncio.sleep(0.05)
                raise RuntimeError("TURN_TERMINAL_TIMEOUT")

            s = await session()
            initial = await send(s, "initial")
            stream = await request("turns/" + initial["id"] + "/events")
            gates["sse"] = stream.status_code == 200 and "completed" in stream.text
            final = await terminal(initial)
            gates["completed"] = final["state"] == "completed" and bool(final.get("reply"))
            gates["output_guard"] = bool(final.get("reply")) and not any(
                x.startswith("GUARDRAILS_") for x in final["reply"].get("limitations", [])
            )
            gates["public_dto"] = all(
                '"' + key + '"' not in json.dumps(final)
                for key in ["agent", "serving", "sourceContext", "lockToken"]
            )
            gates["owner"] = (
                await request("turns/" + initial["id"], owner="lt-other")
            ).status_code == 404
            again = await send(s, "initial")
            gates["idempotency"] = again["id"] == initial["id"]
            conflict = await request(
                "sessions/" + s + "/turns", {"clientRequestId": "initial", "text": "다른 합성 입력"}
            )
            gates["idempotency_conflict"] = conflict.status_code == 409
            with psycopg.connect(env["PTR_APP_DATABASE_URL"]) as db:
                gates["assistant_unique"] = (
                    db.execute(
                        "SELECT count(*) FROM app.messages WHERE turn_id=%s AND role='assistant'",
                        (initial["id"],),
                    ).fetchone()[0]
                    == 1
                )
                grants = db.execute(
                    "SELECT result_hash FROM app.turn_execution_grants WHERE turn_id=%s",
                    (initial["id"],),
                ).fetchall()
                gates["durable_ack"] = bool(grants) and all(row[0] for row in grants)
                gates["outbox_removed"] = (
                    db.execute(
                        "SELECT count(*) FROM app.turn_outbox WHERE turn_id=%s", (initial["id"],)
                    ).fetchone()[0]
                    == 0
                )
            with psycopg.connect(env["PTR_LLM_DATABASE_URL"]) as db:
                gates["result_acknowledged"] = (
                    db.execute(
                        "SELECT count(*) FROM llm.result_receipts WHERE acknowledged_at IS NOT NULL"
                    ).fetchone()[0]
                    > 0
                )
                rows = db.execute("SELECT thread_id,checkpoint FROM llm.checkpoints").fetchall()
                raw = json.dumps([r[1] for r in rows], ensure_ascii=False)
                gates["call_only_checkpoints"] = bool(rows) and all(
                    r[0].startswith("python-call-v1:") for r in rows
                )
                gates["no_history_checkpoints"] = all(
                    '"' + key + '"' not in raw
                    for key in ["history", "persona", "messages", "context", "frame"]
                )
            caption = await send(await session(True), "caption", "파란책 기록을 알려줘", True)
            reply = await terminal(caption)
            gates["caption_grounding"] = reply["state"] == "completed" and any(
                e["sourceId"] == "synthetic-split-source"
                for e in reply.get("reply", {}).get("evidence", [])
            )
            cancel_session = await session()
            pause = children[1]
            pause.send_signal(signal.SIGSTOP)
            try:
                cancelled = await send(cancel_session, "cancel-pending")
                response = await request("turns/" + cancelled["id"] + "/cancel", {})
                gates["cancel_request"] = response.is_success
            finally:
                pause.send_signal(signal.SIGCONT)
            outcome = await terminal(cancelled)
            gates["cancel_terminal"] = outcome["state"] == "cancelled"
            with psycopg.connect(env["PTR_APP_DATABASE_URL"]) as db:
                gates["cancel_no_assistant"] = (
                    db.execute(
                        "SELECT count(*) FROM app.messages WHERE turn_id=%s AND role='assistant'",
                        (cancelled["id"],),
                    ).fetchone()[0]
                    == 0
                )
            # Backend auth/quota/artifact storage while Python does the draft model call.
            draft = await request("sessions/" + s + "/drafts", {"brief": "가상의 독서 포스트"})
            gates["draft_route"] = draft.status_code in (200, 201)
            recovery_session = await session()
            children[1].send_signal(signal.SIGSTOP)
            recovery_turn = await send(recovery_session, "owned-process-recovery")
        # Crash both owned application processes after accepted durable input;
        # same PostgreSQL/Redis state must finish after new processes start.
        for child in children[:2]:
            child.kill()
            child.wait(timeout=5)
        for command, label in [
            (["node", "--import", "tsx", "apps/api/src/main.ts"], "api-restarted"),
            ([sys.executable, "-m", "ptr_llm", "worker"], "worker-restarted"),
        ]:
            log = (output / (label + ".private.log")).open("wb")
            logs.append(log)
            os.chmod(log.name, 0o600)
            children.append(
                subprocess.Popen(
                    command,
                    env=api_env if label.startswith("api") else worker_env,
                    stdout=log,
                    stderr=log,
                )
            )
        async with httpx.AsyncClient(
            base_url="http://127.0.0.1:" + env["PTR_API_PORT"], timeout=35
        ) as client:
            for _ in range(180):
                try:
                    if (await client.get("/api/health")).status_code == 200:
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.1)
            recovered = await terminal(recovery_turn)
            gates["actual_backend_worker_crash_recovery"] = recovered["state"] == "completed"
        with psycopg.connect(env["PTR_APP_DATABASE_URL"]) as db:
            gates["recovery_single_assistant"] = (
                db.execute(
                    "SELECT count(*) FROM app.messages WHERE turn_id=%s AND role='assistant'",
                    (recovery_turn["id"],),
                ).fetchone()[0]
                == 1
            )
            gates["recovery_outbox_removed"] = (
                db.execute(
                    "SELECT count(*) FROM app.turn_outbox WHERE turn_id=%s", (recovery_turn["id"],)
                ).fetchone()[0]
                == 0
            )
        if browser:
            web_env = {
                "PATH": env["PATH"],
                "HOME": env["HOME"],
                "PTR_API_TOKEN": env["PTR_API_TOKEN"],
                "NODE_ENV": "development",
                "PTR_SYNTHETIC_UI": "1",
                "NEXT_TELEMETRY_DISABLED": "1",
                "PTR_UI_PASSWORD": "synthetic-ui-password-only",
                "PTR_SESSION_SECRET": secrets.token_hex(32),
            }
            log = (output / "web.private.log").open("wb")
            logs.append(log)
            os.chmod(log.name, 0o600)
            children.append(
                subprocess.Popen(
                    [
                        "pnpm",
                        "--filter",
                        "@ptr/web",
                        "exec",
                        "next",
                        "dev",
                        "--hostname",
                        "127.0.0.1",
                        "--port",
                        "56448",
                    ],
                    env=web_env,
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                )
            )
            web_process = children[-1]
            async with httpx.AsyncClient(timeout=2) as web:
                for _ in range(180):
                    try:
                        if (await web.get("http://127.0.0.1:56448/login")).status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.2)
                else:
                    raise RuntimeError("WEB_READINESS_TIMEOUT")
            script = Path("scripts/split-browser-smoke.mjs").read_text()
            result = await asyncio.to_thread(
                subprocess.run,
                ["node", "--input-type=module", "-e", script],
                env=web_env,
                capture_output=True,
                text=True,
                timeout=120,
            )
            if result.returncode:
                (output / "browser-failure.private.log").write_text(result.stderr)
                raise RuntimeError("REAL_BROWSER_FAILED")
            gates.update(json.loads(result.stdout))
        report = {"gates": gates, "passed": all(gates.values()), "timestamp": time.time()}
        path = output / "summary.json"
        path.write_text(json.dumps(report, indent=2))
        path.chmod(0o600)
        print(json.dumps(report, indent=2))
        return report
    finally:
        for p in reversed(children):
            if p.poll() is None:
                try:
                    p.send_signal(signal.SIGCONT)
                    if p is web_process:
                        os.killpg(p.pid, signal.SIGTERM)
                    else:
                        p.terminate()
                except ProcessLookupError:
                    continue
                try:
                    p.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    p.kill()
                    p.wait(timeout=5)
        for log in logs:
            log.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--roles-env", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--browser", action="store_true")
    arguments = parser.parse_args()
    try:
        result = asyncio.run(
            smoke(arguments.roles_env, arguments.output, browser=arguments.browser)
        )
        raise SystemExit(0 if result["passed"] else 1)
    except Exception as e:
        code = (
            str(e)
            if isinstance(e, RuntimeError) and str(e).replace("_", "").isalnum()
            else type(e).__name__
        )
        raise SystemExit("SPLIT_SMOKE_FAILED " + code) from None
