"""One selected synthetic-input live-model turn, using two independent images.

The caller owns the serving endpoint. This script owns only its new containers,
private envs and synthetic app records. No paid fallback or shared-service mutation.
"""

import argparse
import asyncio
import json
import os
import secrets
import subprocess
from pathlib import Path

import httpx
import psycopg

from persona_timeline_rag.split_migration import read_environment


async def run(
    roles: Path,
    serving: Path,
    output: Path,
    *,
    app_image: str = "ptr_app:split-final",
    llm_image: str = "ptr_llm:split-final",
):
    credentials = read_environment(roles)
    provider = read_environment(serving)
    output.mkdir(parents=True, mode=0o700, exist_ok=True)
    queue = "split-live-" + secrets.token_hex(4)
    control = credentials["PTR_LLM_CONTROL_TOKEN"]
    api = {
        "PTR_APP_DATABASE_URL": credentials["PTR_SPLIT_TEST_APP_DATABASE_URL"],
        "PTR_REDIS_URL": credentials["PTR_REDIS_URL"],
        "PTR_LLM_CONTROL_TOKEN": control,
        "PTR_LLM_SERVICE_MODE": "split",
        "PTR_LLM_SERVICE_URL": "http://127.0.0.1:58442",
        "PTR_API_PORT": "58441",
        "PTR_API_TOKEN": secrets.token_hex(24),
        "PTR_API_SYNTHETIC_TOKEN": secrets.token_hex(24),
        "PTR_TURN_QUEUE": queue,
        "PTR_EVENTS_NAMESPACE": queue,
        "PTR_CHAT_PROVIDER": "local",
        "PTR_MODEL": "ptr-synthetic",
        "PTR_DISPATCH_INTERVAL_MS": "100",
        "PTR_DISPATCH_GRACE_MS": "200",
    }
    llm = {
        "PTR_LLM_DATABASE_URL": credentials["PTR_SPLIT_TEST_LLM_DATABASE_URL"],
        "PTR_LLM_REDIS_URL": credentials["PTR_REDIS_URL"],
        "PTR_LLM_BACKEND_URL": "http://127.0.0.1:58441",
        "PTR_LLM_CONTROL_TOKEN": control,
        "PTR_LLM_QUEUE_NAME": queue,
        "PTR_LLM_PORT": "58442",
        "PTR_LLM_PROVIDER": "local",
        "PTR_LLM_LOCAL_BASE_URL": provider["PTR_LLM_LOCAL_BASE_URL"],
        "PTR_LLM_LOCAL_MODEL": provider["PTR_LLM_LOCAL_MODEL"],
        "PTR_LLM_LOCAL_API_KEY": provider.get("PTR_LLM_LOCAL_API_KEY", ""),
        "PTR_LLM_SPILLOVER": "off",
        "PTR_LLM_MAX_OUTPUT_TOKENS": "32",
        "PTR_LLM_CONCURRENCY": "1",
        "LANGFUSE_ENABLED": "false",
        "LANGSMITH_TRACING": "false",
        "LANGCHAIN_TRACING_V2": "false",
    }
    children, logs, names = [], [], []
    ownership = secrets.token_hex(16)
    try:
        for label, env, image in [
            ("api", api, app_image),
            ("worker", llm, llm_image),
        ]:
            private = output / (label + ".env")
            private.write_text("\n".join(k + "=" + v for k, v in env.items()) + "\n")
            private.chmod(0o600)
            log = (output / (label + ".private.log")).open("wb")
            os.chmod(log.name, 0o600)
            logs.append(log)
            name = queue + "-" + label
            names.append(name)
            children.append(
                subprocess.Popen(
                    [
                        "docker",
                        "run",
                        "--rm",
                        "--name",
                        name,
                        "--label",
                        "ptr.split-owner=" + ownership,
                        "--network",
                        "host",
                        "--env-file",
                        str(private),
                        image,
                    ],
                    stdout=log,
                    stderr=log,
                )
            )
        async with httpx.AsyncClient(base_url="http://127.0.0.1:58441", timeout=35) as client:
            for _ in range(240):
                if any(p.poll() is not None for p in children):
                    raise RuntimeError("OWNED_IMAGE_EXITED")
                try:
                    async with httpx.AsyncClient(timeout=2) as probe:
                        worker = await probe.get("http://127.0.0.1:58442/health/ready")
                    if (
                        worker.status_code == 200
                        and (await client.get("/api/health")).status_code == 200
                    ):
                        break
                except httpx.HTTPError:
                    pass
                await asyncio.sleep(0.1)
            else:
                raise RuntimeError("OWNED_READINESS_TIMEOUT")
            headers = {
                "Authorization": "Bearer " + api["PTR_API_SYNTHETIC_TOKEN"],
                "X-PTR-Owner": "lt-live-synthetic",
            }
            response = await client.post(
                "/api/sessions",
                headers=headers,
                json={
                    "personId": "synthetic-split-person",
                    "executionProfile": "legacy",
                    "retrievalMode": "off",
                    "ragCondition": "off",
                },
            )
            if not response.is_success:
                raise RuntimeError("LIVE_SESSION_FAILED")
            session = response.json()["session"]["id"]
            response = await client.post(
                "/api/sessions/" + session + "/turns",
                headers=headers,
                json={
                    "clientRequestId": "single-live-verification",
                    "text": "안녕하세요. 짧게 인사해 주세요.",
                },
            )
            if not response.is_success:
                raise RuntimeError("LIVE_ADMISSION_FAILED")
            turn = response.json()["turn"]["id"]
            for _ in range(500):
                final = (await client.get("/api/turns/" + turn, headers=headers)).json()["turn"]
                if final["state"] in {"completed", "failed", "cancelled"}:
                    break
                await asyncio.sleep(0.1)
            else:
                raise RuntimeError("LIVE_TERMINAL_TIMEOUT")
            gates = {
                "completed": final["state"] == "completed",
                "nonempty_reply": bool(final.get("reply", {}).get("content")),
                "public_boundary": all(
                    k not in final.get("reply", {}) for k in ["serving", "agent", "sourceContext"]
                ),
                "distinct_role_credentials": "PTR_APP_DATABASE_URL" not in llm
                and "PTR_LLM_DATABASE_URL" not in api,
            }
            with psycopg.connect(api["PTR_APP_DATABASE_URL"]) as db:
                gates["one_assistant"] = (
                    db.execute(
                        "SELECT count(*) FROM app.messages WHERE turn_id=%s AND role='assistant'",
                        (turn,),
                    ).fetchone()[0]
                    == 1
                )
                gates["one_generation"] = (
                    db.execute(
                        "SELECT count(*) FROM app.turn_execution_grants WHERE turn_id=%s "
                        "AND result_hash IS NOT NULL",
                        (turn,),
                    ).fetchone()[0]
                    == 1
                )
                gates["outbox_removed"] = (
                    db.execute(
                        "SELECT count(*) FROM app.turn_outbox WHERE turn_id=%s", (turn,)
                    ).fetchone()[0]
                    == 0
                )
            with psycopg.connect(llm["PTR_LLM_DATABASE_URL"]) as db:
                with psycopg.connect(api["PTR_APP_DATABASE_URL"]) as app_db:
                    execution = app_db.execute(
                        "SELECT execution_id FROM app.turn_execution_grants WHERE turn_id=%s",
                        (turn,),
                    ).fetchone()[0]
                acknowledged = False
                for _ in range(60):
                    acknowledged = (
                        db.execute(
                            "SELECT count(*) FROM llm.result_receipts WHERE execution_id=%s "
                            "AND acknowledged_at IS NOT NULL",
                            (execution,),
                        ).fetchone()[0]
                        == 1
                    )
                    if acknowledged:
                        break
                    db.commit()
                    await asyncio.sleep(0.05)
                gates["result_acknowledged"] = acknowledged
            report = {
                "passed": all(gates.values()),
                "gates": gates,
                "state": final["state"],
                "errorCode": final.get("errorCode"),
                "paidApiCalls": 0,
            }
            path = output / "summary.json"
            path.write_text(json.dumps(report, indent=2))
            path.chmod(0o600)
            print(json.dumps(report))
            return report
    finally:
        for name in reversed(names):
            owned = subprocess.run(
                [
                    "docker",
                    "inspect",
                    "--format",
                    '{{index .Config.Labels "ptr.split-owner"}}',
                    name,
                ],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if owned.returncode or owned.stdout.strip() != ownership:
                continue
            subprocess.run(
                ["docker", "stop", "--time", "35", name],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=45,
            )
        for process in children:
            process.wait(timeout=10)
        for log in logs:
            log.close()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--roles-env", type=Path, required=True)
    parser.add_argument("--serving-env", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--app-image", default="ptr_app:split-final")
    parser.add_argument("--llm-image", default="ptr_llm:split-final")
    return parser.parse_args(argv)


if __name__ == "__main__":
    args = parse_args()
    try:
        result = asyncio.run(
            run(
                args.roles_env,
                args.serving_env,
                args.output,
                app_image=args.app_image,
                llm_image=args.llm_image,
            )
        )
        raise SystemExit(0 if result["passed"] else 1)
    except Exception as error:
        raise SystemExit("LIVE_SPLIT_FAILED " + type(error).__name__) from None
