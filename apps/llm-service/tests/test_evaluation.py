import asyncio
import json
from types import SimpleNamespace as NS
from unittest.mock import Mock

import pytest
from langfuse import Evaluation

from ptr_llm.evaluation.langfuse import (
    SYNTHETIC_POLICY,
    ensure_human_review,
    load_approved_migration,
    migration_id,
    record_human_review,
    run_framework_experiment,
    verify_experiment_scores,
)


def test_hash_compatible_unicode():
    import hashlib

    expected = hashlib.sha256('["한글","😀"]'.encode()).hexdigest()
    assert migration_id("한글", "😀") == expected


def test_private_import_guard(tmp_path):
    file = tmp_path / "export.json"
    file.write_text(
        json.dumps(
            {
                "source": "approved-private",
                "revision": "v1",
                "cases": [{"id": "synthetic", "input": "hello"}],
            }
        )
    )
    file.chmod(0o600)
    assert (
        load_approved_migration(str(file), "approved-private-import").source == "approved-private"
    )
    with pytest.raises(ValueError):
        load_approved_migration(str(file), "")
    file.chmod(0o644)
    with pytest.raises(ValueError):
        load_approved_migration(str(file), "approved-private-import")


def test_persisted_scores_multiplicity():
    client = Mock()
    client.api.scores_v3.get_many_v3.return_value = NS(
        data=[NS(name="exact_match", value=1, data_type="NUMERIC")], meta=NS(cursor=None)
    )
    item = NS(trace_id="a" * 32, evaluations=[Evaluation(name="exact_match", value=1)])
    verify_experiment_scores(client, [item], timeout=0.01)
    item.evaluations *= 2
    with pytest.raises(TimeoutError):
        verify_experiment_scores(client, [item], timeout=0.005)


def test_cursor_repeated_rejected():
    client = Mock()
    client.api.scores_v3.get_many_v3.return_value = NS(data=[], meta=NS(cursor="same"))
    with pytest.raises(ValueError, match="cursor"):
        verify_experiment_scores(
            client, [NS(trace_id="a" * 32, evaluations=[Evaluation(name="exact_match", value=1)])]
        )


def test_review_requires_every_config_before_any_write():
    client = Mock()
    client.api.annotation_queues.get_queue_item.return_value = NS(
        object_id="a" * 32, object_type="TRACE"
    )
    client.api.annotation_queues.get_queue.return_value = NS(score_config_ids=["one", "two"])
    with pytest.raises(ValueError):
        record_human_review(
            client, "queue", "item", "a" * 32, [{"config_id": "one", "name": "quality", "value": 1}]
        )
    client.api.scores.create.assert_not_called()
    client.api.annotation_queues.update_queue_item.assert_not_called()


def test_existing_queue_rubric_mismatch():
    client = Mock()
    config = NS(
        id="config",
        name="quality",
        is_archived=False,
        data_type="NUMERIC",
        min_value=0,
        max_value=1,
    )
    client.api.score_configs.get.return_value = NS(data=[config], meta=NS(total_pages=1))
    client.api.annotation_queues.list_queues.return_value = NS(
        data=[NS(name="queue", id="q", score_config_ids=["other"])], meta=NS(total_pages=1)
    )
    with pytest.raises(ValueError):
        ensure_human_review(client, "queue", [{"name": "quality", "min_value": 0, "max_value": 1}])


def _experiment_client(evaluator_scores):
    client = Mock()
    dataset = NS(items=[NS(input="hello", expected_output="hello!")])

    def run(**kwargs):
        output = asyncio.run(kwargs["task"](item=dataset.items[0]))
        scores = asyncio.run(
            kwargs["evaluators"][0](
                input="hello", output=output, expected_output="hello!", metadata={}
            )
        )
        evaluator_scores.extend(scores)
        return NS(run_name="run", item_results=[NS(trace_id="a" * 32, evaluations=scores)])

    dataset.run_experiment = run
    client.get_dataset.return_value = dataset
    client.api.scores_v3.get_many_v3.side_effect = lambda **_: NS(
        data=[NS(name=s.name, value=s.value, data_type=s.data_type) for s in evaluator_scores],
        meta=NS(cursor=None),
    )
    return client


def test_native_experiment_requires_scores_and_counts_duplicate():
    client = _experiment_client([])
    result = run_framework_experiment(
        client,
        "data",
        "run",
        {"code": "synthetic"},
        lambda **_: "hello!",
        [
            lambda **_: [
                Evaluation(name="exact_match", value=1),
                Evaluation(name="exact_match", value=1),
            ]
        ],
        SYNTHETIC_POLICY,
    )
    assert result["failedScores"] == 1
    assert result["missingScores"] == 0


def test_experiment_task_failure_cannot_pass():
    client = _experiment_client([])

    def failed(**_):
        raise RuntimeError("private details")

    result = run_framework_experiment(
        client,
        "data",
        "run",
        {},
        failed,
        [lambda **_: Evaluation(name="exact_match", value=1)],
        SYNTHETIC_POLICY,
    )
    assert result["taskFailures"] == result["failedScores"] == 1


def test_policy_multiplicity_checked_before_task():
    client = _experiment_client([])
    task = Mock()
    with pytest.raises(ValueError, match="multiplicity"):
        run_framework_experiment(
            client,
            "data",
            "run",
            {},
            task,
            [lambda **_: Evaluation(name="exact_match", value=1)],
            {"rules": SYNTHETIC_POLICY["rules"], "expected": lambda _: {"unknown": 1}},
        )
    task.assert_not_called()


async def test_async_native_runner_keeps_tasks_and_evaluators_on_runtime_owner_loop(monkeypatch):
    from contextvars import ContextVar

    from ptr_llm.evaluation.langfuse import run_framework_experiment_async

    context = ContextVar("synthetic_sdk_context", default="missing")
    owner = asyncio.get_running_loop()
    calls = []
    client = _experiment_client([])
    original = client.get_dataset.return_value.run_experiment

    def sdk(**kwargs):
        context.set("sdk-parent")
        return original(**kwargs)

    client.get_dataset.return_value.run_experiment = sdk

    async def task(**_):
        assert asyncio.get_running_loop() is owner
        assert context.get() == "sdk-parent"
        calls.append("task")
        return "hello!"

    async def evaluator(**_):
        assert asyncio.get_running_loop() is owner
        assert context.get() == "sdk-parent"
        calls.append("evaluator")
        return Evaluation(name="exact_match", value=1)

    result = await run_framework_experiment_async(
        client, "data", "run", {}, task, [evaluator], SYNTHETIC_POLICY
    )
    assert calls == ["task", "evaluator"]
    assert not result["failedScores"] and not result["taskFailures"]


async def test_cancelled_native_runner_gates_future_callbacks_and_drains_sdk_before_close(
    monkeypatch,
):
    import threading

    import ptr_llm.evaluation.langfuse as experiments

    started = asyncio.Event()
    sdk_cancelled = threading.Event()
    release_sdk = threading.Event()
    sdk_settled = threading.Event()
    calls = []
    lifecycle = []

    def sdk(client, dataset, run, versions, task, evaluators, policy, **options):
        async def sequential():
            try:
                await task(index=1)
            except asyncio.CancelledError:
                sdk_cancelled.set()
                # Reproduce an SDK that continues after an individual cancellation.
                assert release_sdk.wait(3)
            try:
                await task(index=2)
            except asyncio.CancelledError:
                pass
            try:
                await evaluators[0](index=3)
            except asyncio.CancelledError:
                pass

        try:
            asyncio.run(sequential())
            return {"failedScores": 0}
        finally:
            sdk_settled.set()
            lifecycle.append("sdk-settled")

    monkeypatch.setattr(experiments, "run_framework_experiment", sdk)

    async def owned(**kwargs):
        calls.append(kwargs["index"])
        started.set()
        await asyncio.Event().wait()

    running = asyncio.create_task(
        experiments.run_framework_experiment_async(
            None, "synthetic", "cancel", {}, owned, [owned], SYNTHETIC_POLICY
        )
    )
    await asyncio.wait_for(started.wait(), 3)
    running.cancel()
    assert await asyncio.to_thread(sdk_cancelled.wait, 3)
    assert not running.done(), "Cancellation ACK must wait for SDK thread settlement"
    running.cancel()  # A second signal must not bypass the shutdown barrier.
    await asyncio.sleep(0)
    assert not running.done()
    release_sdk.set()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(running, 3)
    assert sdk_settled.is_set()
    lifecycle.append("runtime-close")
    assert lifecycle == ["sdk-settled", "runtime-close"]
    assert calls == [1], "Neither task 2 nor evaluator may invoke application after cancellation"


def test_evaluate_setup_only_module_opens_runs_closes_on_one_loop(monkeypatch, capsys):
    import ptr_llm.evaluation.langfuse as experiments
    from ptr_llm import cli, telemetry

    lifecycle = []
    loops = []
    instance = NS(client=Mock(), shutdown=lambda: lifecycle.append("telemetry-close"))
    monkeypatch.setattr(telemetry, "FrameworkTelemetry", lambda _: instance)
    monkeypatch.setattr(
        telemetry.TelemetryConfig, "from_env", lambda: NS(enabled=True, release="synthetic")
    )
    monkeypatch.setattr(experiments, "migrate_dataset", lambda *a: {"items": 2})

    async def close():
        loops.append(asyncio.get_running_loop())
        lifecycle.append("close")

    async def setup():
        loops.append(asyncio.get_running_loop())
        lifecycle.append("setup")
        return {"task": "selected", "evaluators": [], "score_policy": {}, "close": close}

    async def run(client, dataset, run, versions, task, *args, **kwargs):
        assert task == "selected"
        loops.append(asyncio.get_running_loop())
        lifecycle.append("run")
        return {"failedScores": 0, "missingScores": 0, "taskFailures": 0}

    # Patch this CLI's injection surface, not stdlib importlib used by cold SDK imports.
    monkeypatch.setattr(cli, "importlib", NS(import_module=lambda name: NS(setup=setup)))
    monkeypatch.setattr(experiments, "run_framework_experiment_async", run)
    assert cli.main(["evaluate", "--task", "synthetic.setup.only"]) == 0
    assert lifecycle == ["setup", "run", "close", "telemetry-close"]
    assert all(loop is loops[0] for loop in loops)
    assert json.loads(capsys.readouterr().out)["items"] == 2
