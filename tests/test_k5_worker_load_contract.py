from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_worker_load_uses_smoke_reply_shape() -> None:
    load = (ROOT / "deploy/kind/k5-worker-load.sh").read_text()
    smoke = (ROOT / "deploy/kind/smoke-turn.cjs").read_text()
    for source in (load, smoke):
        assert "text: JSON.stringify({" in source
        assert "status: 'answered'" in source
        assert "evidenceRefs: []" in source
        assert "variableUpdates: {}" in source
    assert "final.completed > turnIds.length / 2" in load
    assert "engine ScaledObject must be pinned to two replicas for V5" in load
