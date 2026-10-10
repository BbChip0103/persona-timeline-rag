"""Bounded internal HTTP surface; backend remains owner of public API and artifacts."""

from __future__ import annotations

import asyncio
import hmac
import json
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from .config import Settings
from .control import ControlRejected, validate_wire
from .worker import WorkerRunner, deadline_seconds


def create_app(
    settings: Settings,
    *,
    catalogue: Callable[[], Awaitable[list[dict[str, Any]]]],
    draft: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]],
    runner: WorkerRunner | None = None,
    health: Callable[[], Awaitable[bool]] | None = None,
) -> FastAPI:
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    async def authenticate(request: Request) -> None:
        actual = request.headers.get("Authorization", "")
        if not hmac.compare_digest(
            actual.encode("utf-8"), f"Bearer {settings.control_token}".encode()
        ):
            raise HTTPException(status_code=401, detail="UNAUTHORIZED")

    @app.get("/health/live")
    async def live() -> dict[str, str]:
        return {"status": "alive"}

    @app.get("/health/ready")
    async def ready() -> JSONResponse:
        okay = runner is None or await runner.health()
        if okay and health is not None:
            try:
                okay = bool(await asyncio.wait_for(health(), timeout=settings.backend_timeout))
            except Exception:
                okay = False
        return JSONResponse(
            {"status": "ready" if okay else "unavailable"}, status_code=200 if okay else 503
        )

    @app.get("/internal/llm/personas", dependencies=[Depends(authenticate)])
    async def personas() -> dict[str, Any]:
        try:
            result = {"contractVersion": 1, "personas": await catalogue()}
            return validate_wire("CatalogueResponse", result)
        except Exception:
            raise HTTPException(status_code=503, detail="CATALOGUE_UNAVAILABLE") from None

    @app.post("/internal/llm/draft", dependencies=[Depends(authenticate)])
    async def make_draft(request: Request) -> dict[str, Any]:
        raw = bytearray()
        async for chunk in request.stream():
            raw.extend(chunk)
            if len(raw) > 65536:
                raise HTTPException(status_code=413, detail="DRAFT_TOO_LARGE")
        try:
            body = validate_wire("DraftRequest", json.loads(raw))
            remaining = deadline_seconds(body)
            if remaining <= 0 or remaining > 30:
                raise ControlRejected()
            result = await asyncio.wait_for(draft(body), timeout=remaining)
            return validate_wire("DraftResponse", result)
        except TimeoutError:
            raise HTTPException(status_code=504, detail="DRAFT_TIMEOUT") from None
        except (ValueError, ControlRejected):
            raise HTTPException(status_code=400, detail="INVALID_DRAFT_REQUEST") from None
        except Exception:
            raise HTTPException(status_code=503, detail="DRAFT_UNAVAILABLE") from None

    return app
