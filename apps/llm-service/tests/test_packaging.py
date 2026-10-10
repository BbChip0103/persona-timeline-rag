"""Ownership/deployment boundaries stay reviewable and regression-locked."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def test_worker_image_is_independent_and_private_data_not_copied():
    dockerfile = (ROOT / "apps/llm-service/Dockerfile").read_text()
    assert "COPY apps/llm-service/src" in dockerfile
    assert "COPY src/persona_timeline_rag" in dockerfile
    assert "node:" not in dockerfile and "pnpm" not in dockerfile
    for excluded in ["data", "reports", ".env", "accounts"]:
        assert f"COPY {excluded}" not in dockerfile
    assert "USER 900:2000" in dockerfile
    assert "COPY --chmod=0755 contracts ./contracts" in dockerfile
    assert "PTR_LLM_CONTRACTS_DIR=/app/contracts/llm/v1" in dockerfile
    backend = (ROOT / "Dockerfile").read_text()
    assert "COPY . ." not in backend
    assert "COPY apps/llm-service" not in backend


def test_compose_worker_separate_secret_boundary():
    compose = (ROOT / "infra/compose.app.yml").read_text()
    worker = compose.split("  worker:\n", 1)[1].split("  web:\n", 1)[0]
    assert "PTR_LLM_SERVICE_ENV_FILE" in worker
    assert "PTR_FRAMEWORK_APP_ENV_FILE" not in worker
    assert "<<: *role" not in worker
    assert "[python, -m, ptr_llm, worker]" in worker
    assert "health/ready" in worker


def test_nested_venv_and_secret_shapes_excluded():
    ignored = (ROOT / ".dockerignore").read_text().splitlines()
    assert "**/.venv" in ignored
    assert "**/.env*" in ignored
    assert "data" in ignored and "reports" in ignored
