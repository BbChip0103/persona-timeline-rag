"""Independent orchestration process; cleanly drain owned workers on shutdown."""

from __future__ import annotations

import asyncio
import sys
from contextlib import nullcontext
from typing import Any

import uvicorn

from .config import Settings
from .control import ControlClient
from .server import create_app
from .worker import WorkerRunner


async def run(mode: str = "worker") -> None:
    from .runtime import build_runtime

    settings = Settings.from_env()
    runtime = await build_runtime(settings)
    control = ControlClient(
        settings.backend_url, settings.control_token, timeout=settings.backend_timeout
    )
    runner = (
        WorkerRunner(settings, control, runtime.engine, runtime.result_store)
        if mode == "worker"
        else None
    )
    try:
        if runner is not None:
            await runner.start()
        app = create_app(
            settings,
            catalogue=runtime.catalogue,
            draft=runtime.draft,
            runner=runner,
            health=runtime.health,
        )
        server = uvicorn.Server(
            uvicorn.Config(
                app,
                host=settings.host,
                port=settings.port,
                log_level="warning",
                access_log=False,
                server_header=False,
            )
        )
        await server.serve()
    finally:
        if runner is not None:
            await runner.close()
        else:
            await control.close()
        closed: Any = runtime.close()
        if hasattr(closed, "__await__"):
            await closed


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else "worker"
    if mode not in {"worker", "serve"}:
        from .cli import main as cli_main

        raise SystemExit(cli_main())
    run_process(mode)


def run_process(mode: str) -> None:
    """Dedicated synchronous process boundary shared by module and CLI routes."""
    from .bootstrap import static_import_gc

    try:
        with static_import_gc() if mode == "worker" else nullcontext():
            asyncio.run(run(mode))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("LLM_SERVICE_STARTUP_FAILED") from None


if __name__ == "__main__":
    main()
