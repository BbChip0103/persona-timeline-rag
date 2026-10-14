from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_kind_epp_queue_ttl_matches_design_and_precedes_worker_timeout() -> None:
    values = yaml.safe_load((ROOT / "deploy/helm/ptr-router/values-kind.yaml").read_text())
    router = values["llm-d-router-standalone"]["router"]
    flow = router["epp"]["pluginsConfig"]["flowControl"]
    assert flow["maxRequests"] == "8"
    assert flow["defaultRequestTTL"] == "2s"
