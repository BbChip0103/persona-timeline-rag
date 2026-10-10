"""Private stateless Guardrails REST boundary. Never log text or return validation internals."""

import hmac
import os
from typing import Annotated, Literal

# Set before importing Guardrails and its tracing dependencies.
os.environ["OTEL_SDK_DISABLED"] = "true"
os.environ["GUARDRAILS_TELEMETRY_ENABLED"] = "false"

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from policy import CATEGORIES, REVISION
from pydantic import BaseModel, ConfigDict, Field, field_validator
from validators import validate_input, validate_output


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Intent(StrictModel):
    label: Literal["timeline", "small_talk"]
    confidence: float = Field(ge=0, le=1)
    probabilities: dict[Literal["timeline", "small_talk"], float]

    @field_validator("probabilities")
    @classmethod
    def valid_probabilities(cls, value):
        if set(value) != {"timeline", "small_talk"} or any(
            not 0 <= score <= 1 for score in value.values()
        ):
            raise ValueError("invalid intent probabilities")
        return value


class InputMetadata(StrictModel):
    classification: Literal["jev", "rules-only"] = "jev"
    probabilities: dict[str, float]
    thresholds: dict[str, float]
    categories: list[str]
    intent: Intent | None = None

    @field_validator("probabilities", "thresholds")
    @classmethod
    def scores(cls, value):
        if any(key not in CATEGORIES or not 0 <= score <= 1 for key, score in value.items()):
            raise ValueError("invalid safety score")
        return value

    @field_validator("thresholds")
    @classmethod
    def complete_thresholds(cls, value):
        if set(value) != set(CATEGORIES):
            raise ValueError("seven thresholds required")
        return value

    @field_validator("categories")
    @classmethod
    def categories_covered(cls, value):
        if (
            not value
            or len(value) != len(set(value))
            or any(category not in CATEGORIES for category in value)
        ):
            raise ValueError("invalid category coverage")
        return value


class InputRequest(StrictModel):
    text: str = Field(max_length=8000)
    metadata: InputMetadata


class OutputMetadata(StrictModel):
    utterance: str = Field(max_length=8000)
    realPerson: bool
    language: str = Field(min_length=1, max_length=20)
    level: Literal["casual", "polite"] = "polite"


class OutputRequest(StrictModel):
    text: str = Field(max_length=64000)
    metadata: OutputMetadata


def create_app(token: str | None = None):
    token = token if token is not None else os.environ.get("GUARDRAILS_API_KEY")
    if not token or len(token) < 16:
        raise RuntimeError("GUARDRAILS_API_KEY must contain at least 16 characters")
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)

    def authenticate(authorization: Annotated[str | None, Header()] = None):
        if authorization is None or not hmac.compare_digest(authorization, "Bearer " + token):
            raise HTTPException(status_code=401, detail="unauthorized")

    @app.exception_handler(RequestValidationError)
    async def invalid_request(request, exception):
        # FastAPI's default 422 includes the rejected text/input. This boundary never echoes it.
        return JSONResponse(status_code=422, content={"detail": "invalid validation request"})

    @app.exception_handler(Exception)
    async def service_error(request, exception):
        return JSONResponse(status_code=503, content={"detail": "validation unavailable"})

    @app.get("/health")
    def health():
        return {
            "status": "ok",
            "framework": "guardrails-ai",
            "version": "0.11.0",
            "revision": REVISION,
        }

    @app.post("/validate/input", dependencies=[Depends(authenticate)])
    def input_validation(request: InputRequest):
        metadata = request.metadata.model_dump(exclude_none=True)
        if metadata["classification"] == "rules-only":
            if metadata["probabilities"]:
                raise HTTPException(status_code=422, detail="invalid rules-only assessment")
        elif set(metadata["probabilities"]) != set(metadata["categories"]):
            raise HTTPException(status_code=422, detail="incomplete safety coverage")
        decision = validate_input(request.text, metadata)
        return {
            "revision": REVISION,
            **decision,
            **({"intent": metadata["intent"]} if "intent" in metadata else {}),
        }

    @app.post("/validate/output", dependencies=[Depends(authenticate)])
    def output_validation(request: OutputRequest):
        return {
            "revision": REVISION,
            **validate_output(request.text, request.metadata.model_dump()),
        }

    return app
