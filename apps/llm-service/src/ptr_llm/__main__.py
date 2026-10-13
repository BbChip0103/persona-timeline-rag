"""Independent orchestration process; cleanly drain owned workers on shutdown."""

from __future__ import annotations

import asyncio
import signal
import sys
import threading
from contextlib import asynccontextmanager, contextmanager, nullcontext
from importlib.metadata import version
from typing import Any

import uvicorn

from .config import Settings
from .control import ControlClient
from .server import create_app
from .worker import WorkerRunner


def _assert_pinned_uvicorn() -> None:
    if version("uvicorn") != "0.54.0":
        raise RuntimeError("UVICORN_VERSION_UNSUPPORTED")


class _GracefulServer(uvicorn.Server):
    """Keep SIGTERM as a successful drain after uvicorn's lifespan shutdown."""

    @contextmanager
    def capture_signals(self):
        if threading.current_thread() is not threading.main_thread():
            yield
            return
        # This depends on uvicorn 0.54.0's private capture_signals behavior:
        # SIGTERM is re-raised after the app drains, changing exit 0 to 143.
        # _assert_pinned_uvicorn checks the installed distribution version.
        original = {
            sig: signal.signal(sig, self.handle_exit) for sig in uvicorn.server.HANDLED_SIGNALS
        }
        try:
            yield
        finally:
            for sig, handler in original.items():
                signal.signal(sig, handler)


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
    drained = False

    async def drain() -> None:
        nonlocal drained
        if drained:
            return
        drained = True
        if runner is not None:
            await runner.close()
        else:
            await control.close()
        closed: Any = runtime.close()
        if hasattr(closed, "__await__"):
            await closed

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            await drain()

    try:
        if runner is not None:
            await runner.start()
        app = create_app(
            settings,
            catalogue=runtime.catalogue,
            draft=runtime.draft,
            runner=runner,
            health=runtime.health,
            lifespan=lifespan,
        )
        server = _GracefulServer(
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
        await drain()


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
        _assert_pinned_uvicorn()
        with static_import_gc() if mode == "worker" else nullcontext():
            asyncio.run(run(mode))
    except KeyboardInterrupt:
        pass
    except Exception:
        raise SystemExit("LLM_SERVICE_STARTUP_FAILED") from None


if __name__ == "__main__":
    main()
