"""Explicit API annotation writes only; never actual human sheets or private corpus."""

import json
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest

from ptr_llm.cli import main
from ptr_llm.evaluation.langfuse import load_approved_review


def payload():
    return {
        "source": "approved-review-api",
        "queueId": "synthetic-queue",
        "itemId": "synthetic-item",
        "traceId": "a" * 32,
        "scores": [{"config_id": "synthetic-config", "name": "naturalness", "value": 2}],
    }


def private_file(tmp_path, value=None):
    path = tmp_path / "selected-synthetic.json"
    path.write_text(json.dumps(payload() if value is None else value))
    path.chmod(0o600)
    return path


def test_explicit_review_file_approval_and_permissions_no_symlink(tmp_path):
    file = private_file(tmp_path)
    assert load_approved_review(str(file), "approved-review-write").scores[0].value == 2
    with pytest.raises(ValueError):
        load_approved_review(str(file), "")
    file.chmod(0o644)
    with pytest.raises(ValueError):
        load_approved_review(str(file), "approved-review-write")
    file.chmod(0o600)
    link = tmp_path / "link.json"
    link.symlink_to(file)
    with pytest.raises(OSError):
        load_approved_review(str(link), "approved-review-write")
    directory = tmp_path / "review"
    directory.mkdir()
    with pytest.raises(ValueError):
        load_approved_review(str(directory / file.name), "approved-review-write")


@pytest.mark.parametrize("value", [True, float("nan"), float("inf"), "2"])
def test_review_input_rejects_bad_numeric_before_service_write(tmp_path, value):
    document = payload()
    document["scores"][0]["value"] = value
    with pytest.raises(ValueError):
        load_approved_review(str(private_file(tmp_path, document)), "approved-review-write")


def service(monkeypatch, *, item_trace="a" * 32, maximum=2):
    from ptr_llm import telemetry

    client = Mock()
    api = client.api.annotation_queues
    api.get_queue_item.return_value = NS(object_id=item_trace, object_type="TRACE")
    api.get_queue.return_value = NS(score_config_ids=["synthetic-config"])
    client.api.score_configs.get_by_id.return_value = NS(
        name="naturalness", data_type="NUMERIC", min_value=0, max_value=maximum
    )
    instance = NS(client=client, shutdown=Mock())
    monkeypatch.setattr(telemetry, "FrameworkTelemetry", lambda _: instance)
    monkeypatch.setattr(telemetry.TelemetryConfig, "from_env", lambda: NS(enabled=True))
    return instance


def test_review_cli_uses_existing_dimension_binding_validator_and_ack_first(
    tmp_path, monkeypatch, capsys
):
    instance = service(monkeypatch)
    assert (
        main(
            [
                "review",
                "--private-file",
                str(private_file(tmp_path)),
                "--approval",
                "approved-review-write",
            ]
        )
        == 0
    )
    score_call = instance.client.api.scores.create.call_args.kwargs
    assert score_call["value"] == 2 and score_call["source"] == "ANNOTATION"
    assert score_call["trace_id"] == "a" * 32
    instance.client.api.annotation_queues.update_queue_item.assert_called_once()
    instance.shutdown.assert_called_once()
    output = json.loads(capsys.readouterr().out)
    assert output["scores"] == 1 and output["completed"]
    assert not output["humanReviewerImpersonated"]


@pytest.mark.parametrize("failure", ["binding", "range", "partial", "score-write"])
def test_review_cli_failclosed_before_completion(tmp_path, monkeypatch, failure):
    instance = service(
        monkeypatch,
        item_trace="b" * 32 if failure == "binding" else "a" * 32,
        maximum=1 if failure == "range" else 2,
    )
    if failure == "partial":
        instance.client.api.annotation_queues.get_queue.return_value.score_config_ids.append(
            "missing"
        )
    if failure == "score-write":
        instance.client.api.scores.create.side_effect = RuntimeError("private")
    assert (
        main(
            [
                "review",
                "--private-file",
                str(private_file(tmp_path)),
                "--approval",
                "approved-review-write",
            ]
        )
        == 1
    )
    instance.client.api.annotation_queues.update_queue_item.assert_not_called()
    if failure != "score-write":
        instance.client.api.scores.create.assert_not_called()
