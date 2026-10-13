import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROUTER = ROOT / "deploy/helm/ptr-router"


def render(profile: str, *extra: str) -> str:
    return subprocess.run(
        ["timeout", "30s", "helm", "template", "test-release", str(ROUTER),
         "--namespace", "ptr-inference", "--values", str(ROUTER / f"values-{profile}.yaml"),
         *extra],
        check=True,
        text=True,
        capture_output=True,
    ).stdout


def document(rendered: str, kind: str, name: str) -> str:
    for item in rendered.split("\n---\n"):
        if re.search(rf"(?m)^kind: {kind}$", item) and re.search(
            rf"(?m)^  name: {re.escape(name)}$", item
        ):
            return item
    raise AssertionError(f"missing {kind}/{name}")


def test_prod_router_is_pinned_sized_and_single_replica() -> None:
    rendered = render("prod")
    deployment = document(rendered, "Deployment", "test-release-epp")
    config = document(rendered, "ConfigMap", "test-release-epp")
    assert "replicas: 1" in deployment
    assert "kind: PodDisruptionBudget" not in rendered
    assert (
        "image: ghcr.io/llm-d/llm-d-router-endpoint-picker:v0.11.0@"
        "sha256:39257d24552d16d8f215d3de25cc734fd44af3b282b67032db01aff900c610cf"
    ) in deployment
    assert (
        "image: docker.io/envoyproxy/envoy:distroless-v1.33.2@"
        "sha256:85500e28ed088ec39ff0adc1be3d358a8ad062926aaa62c36b28bde00919e4e8"
    ) in deployment
    assert "cpu: 500m" in deployment and "memory: 512Mi" in deployment
    assert "cpu: 250m" in deployment and "memory: 256Mi" in deployment
    assert "--ha-enable-leader-election" not in deployment
    assert deployment.count("tolerationSeconds: 30") == 2
    assert "--metrics-endpoint-auth=false" in deployment
    assert 'maxRequests: "128"' in config
    assert "maxConcurrency: 8" in config


def test_kind_router_keeps_saturation_profile() -> None:
    rendered = render("kind")
    deployment = document(rendered, "Deployment", "test-release-epp")
    config = document(rendered, "ConfigMap", "test-release-epp")

    assert "replicas: 1" in deployment
    assert "--ha-enable-leader-election" not in deployment
    assert "kind: PodDisruptionBudget" not in rendered
    assert deployment.count("tolerationSeconds: 30") == 2
    assert "--metrics-endpoint-auth=false" in deployment
    assert 'maxRequests: "8"' in config
    assert "maxConcurrency: 2" in config


def test_prod_queue_budget_is_literal_in_profile() -> None:
    config = document(
        render("prod"),
        "ConfigMap",
        "test-release-epp",
    )
    assert 'maxRequests: "128"' in config
    assert "maxEngineReplicas" not in config


def test_router_image_digests_are_pinned_through_upstream_value_fields() -> None:
    fake_digest = "sha256:" + "a" * 64
    deployment = document(
        render(
            "kind",
            "--set", f"llm-d-router-standalone.router.epp.image.tag=v0.11.0@{fake_digest}",
            "--set",
            ("llm-d-router-standalone.router.proxy.image="
             f"docker.io/envoyproxy/envoy:distroless-v1.33.2@{fake_digest}"),
        ),
        "Deployment",
        "test-release-epp",
    )
    assert f"v0.11.0@{fake_digest}" in deployment
    assert f"distroless-v1.33.2@{fake_digest}" in deployment


def test_vendored_chart_cannot_be_replaced_by_dependency_build(tmp_path: Path) -> None:
    assert "oci://" not in (ROUTER / "Chart.yaml").read_text()
    subprocess.run(
        ["timeout", "10s", "sha256sum", "-c", "llm-d-router-standalone.sha256"],
        cwd=ROUTER,
        check=True,
        capture_output=True,
    )
    copy = tmp_path / "ptr-router"
    shutil.copytree(ROUTER, copy)
    archive = copy / "charts/llm-d-router-standalone-v0.11.0.tgz"
    before = archive.read_bytes()
    result = subprocess.run(
        ["timeout", "30s", "helm", "dependency", "build", str(copy)],
        check=False,
        capture_output=True,
    )
    assert result.returncode != 0
    assert archive.read_bytes() == before
