# Independent Python image: no Node runtime, packages or backend/application secrets.
FROM python:3.13.5-slim-bookworm@sha256:4c2cf9917bd1cbacc5e9b07320025bdb7cdf2df7b0ceaccb55e9dd7e30987419 AS builder
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 UV_NO_PROGRESS=1
RUN pip install --no-cache-dir uv==0.10.2
WORKDIR /app
COPY pyproject.toml ./
COPY src/persona_timeline_rag ./src/persona_timeline_rag
COPY apps/llm-service/pyproject.toml apps/llm-service/uv.lock ./apps/llm-service/
COPY apps/llm-service/src ./apps/llm-service/src
RUN uv sync --project apps/llm-service --locked --no-dev --no-editable

FROM python:3.13.5-slim-bookworm@sha256:4c2cf9917bd1cbacc5e9b07320025bdb7cdf2df7b0ceaccb55e9dd7e30987419
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/app/apps/llm-service/.venv/bin:$PATH \
    PTR_LLM_CONTRACTS_DIR=/app/contracts/llm/v2 \
    HOME=/tmp \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    UV_CACHE_DIR=/tmp/uv-cache \
    PYTHONPYCACHEPREFIX=/tmp/pycache
WORKDIR /app
COPY --from=builder /app/apps/llm-service/.venv ./apps/llm-service/.venv
COPY --chmod=0755 contracts ./contracts
COPY --chmod=0755 scripts/split-maintenance.py ./scripts/
USER 900:2000
CMD ["python", "-m", "ptr_llm", "worker"]
