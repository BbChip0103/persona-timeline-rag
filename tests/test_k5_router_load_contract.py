from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_kind_epp_queue_ttl_covers_synthetic_engine_latency() -> None:
    values = yaml.safe_load((ROOT / "deploy/helm/ptr-router/values-kind.yaml").read_text())
    router = values["llm-d-router-standalone"]["router"]
    flow = router["epp"]["pluginsConfig"]["flowControl"]
    assert flow["maxRequests"] == "8"
    assert flow["defaultRequestTTL"] == "30s"
