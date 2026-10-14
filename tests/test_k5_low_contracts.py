import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_ci_crd_validation_fails_when_expected_kind_extracts_zero_documents() -> None:
    ci = (ROOT / ".github/workflows/ci.yml").read_text()
    assert "missing expected CRD kind: %s" in ci
    assert re.search(r'test ! -s "\$docs"|!\s*\[\s*-s "\$docs"\s*\]', ci)


def test_schema_inventory_is_versioned_documented_and_deduplicated() -> None:
    schemas = ROOT / "deploy/helm/ptr/schemas"
    readme = (schemas / "README.md").read_text()
    names = sorted(path.name for path in schemas.glob("*.json"))

    assert "InferencePool.json" not in names
    assert "InferencePool-v1.json" in names
    for name in names:
        digest = __import__("hashlib").sha256((schemas / name).read_bytes()).hexdigest()
        assert name in readme
        assert digest in readme


def test_kind_addon_charts_and_backend_python_are_pinned() -> None:
    up = (ROOT / "deploy/kind/up.sh").read_text()
    addons = (ROOT / "deploy/kind/ADDONS.md").read_text()
    dockerfile = (ROOT / "Dockerfile").read_text()

    for chart in ("keda", "metrics-server", "kube-prometheus-stack"):
        assert re.search(rf'{chart}.*sha256:[0-9a-f]{{64}}', up + "\n" + addons)
    assert "sha256sum -c" in up
    assert re.search(r"apt-get install .*python3=", dockerfile)


def test_split_maintenance_invoke_does_not_accept_unused_workdir() -> None:
    source = (ROOT / "scripts/split-maintenance.py").read_text()
    assert "def invoke(argv, env, timeout, *, execute=execute):" in source
    assert "workdir=ROOT" not in source
