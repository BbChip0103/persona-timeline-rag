"""Native existing-dataset snapshots never pretend to be synthetic case revisions."""

from datetime import UTC, datetime
from types import SimpleNamespace as NS
from unittest.mock import Mock

from langfuse import Evaluation


def test_existing_dataset_cli_freezes_native_version_without_synthetic_import(monkeypatch, capsys):
    import ptr_llm.evaluation.langfuse as experiments
    from ptr_llm import cli, telemetry
    from ptr_llm.evaluation import domain

    client, captured = Mock(), {}
    monkeypatch.setattr(
        telemetry, "FrameworkTelemetry", lambda _: NS(client=client, shutdown=lambda: None)
    )
    monkeypatch.setattr(
        telemetry.TelemetryConfig,
        "from_env",
        lambda: NS(enabled=True, release="synthetic-code-revision"),
    )
    importer, synthetic = Mock(), Mock(side_effect=AssertionError("No synthetic revision"))
    monkeypatch.setattr(experiments, "migrate_dataset", importer)
    monkeypatch.setattr(domain, "synthetic_domain_migration", synthetic)

    async def run(client, dataset, name, versions, *args, **kwargs):
        captured.update(versions=versions, **kwargs)
        return {"failedScores": 0, "missingScores": 0, "taskFailures": 0}

    monkeypatch.setattr(experiments, "run_framework_experiment_async", run)
    assert cli.main(["evaluate", "--existing-dataset", "--dataset", "approved-old-cases"]) == 0
    importer.assert_not_called()
    synthetic.assert_not_called()
    version = captured["dataset_version"]
    assert isinstance(version, datetime) and version.utcoffset() == UTC.utcoffset(version)
    assert captured["versions"]["cases"] == "langfuse-dataset@" + version.isoformat()
    assert captured["versions"]["datasetVersion"] == version.isoformat()
    assert "synthetic-python-domain" not in capsys.readouterr().out


def test_native_runner_uses_the_exact_selected_dataset_version():
    from ptr_llm.evaluation.langfuse import SYNTHETIC_POLICY, run_framework_experiment

    version = datetime(2026, 10, 11, tzinfo=UTC)
    client = Mock()
    dataset = NS(items=[NS(input="hello")])
    dataset.run_experiment = Mock(
        return_value=NS(
            run_name="run",
            item_results=[
                NS(trace_id="a" * 32, evaluations=[Evaluation(name="exact_match", value=1)])
            ],
        )
    )
    client.get_dataset.return_value = dataset
    client.api.scores_v3.get_many_v3.return_value = NS(
        data=[NS(name="exact_match", value=1, data_type="NUMERIC")], meta=NS(cursor=None)
    )
    run_framework_experiment(
        client,
        "approved-old-cases",
        "run",
        {"cases": "langfuse-dataset@" + version.isoformat()},
        lambda **_: "hello!",
        [lambda **_: Evaluation(name="exact_match", value=1)],
        SYNTHETIC_POLICY,
        dataset_version=version,
    )
    client.get_dataset.assert_called_once_with("approved-old-cases", version=version)
