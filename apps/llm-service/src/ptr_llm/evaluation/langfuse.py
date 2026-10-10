"""Versioned datasets, native experiments and rubric-complete human review."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import math
import os
import stat
import threading
import time
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from langfuse import Evaluation
from pydantic import BaseModel, ConfigDict, Field, field_validator

from ptr_llm.telemetry import redact_telemetry

API_OPTIONS = {"max_retries": 0, "timeout_in_seconds": 5}
REVIEW_DIMENSIONS = ("persona_fidelity", "evidence_match", "language_match", "safety")


def migration_id(*keys: str) -> str:
    # Same JSON-array hash as the historical TS importer (including non-ASCII).
    return hashlib.sha256(
        json.dumps(keys, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


class HistoricalScore(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=35)
    value: float | str

    @field_validator("value")
    @classmethod
    def finite_score(cls, value: Any) -> Any:
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError("Score must be finite")
        return value

    comment: str | None = None
    reviewer: str | None = None


class Historical(BaseModel):
    model_config = ConfigDict(extra="forbid")
    originalRunAt: str
    originalVersion: str = Field(min_length=1)
    output: Any
    scores: list[HistoricalScore] = Field(default_factory=list)
    status: Literal["PENDING", "COMPLETED"] = "PENDING"
    sourceTraceId: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")

    @field_validator("originalRunAt")
    @classmethod
    def original_timestamp(cls, value: str) -> str:
        if datetime.fromisoformat(value).tzinfo is None:
            raise ValueError("Original timestamp must include timezone")
        return value


class EvaluationCase(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(min_length=1, max_length=200)
    input: Any
    expectedOutput: Any = None
    rubric: dict[str, Any] = Field(default_factory=dict)
    historical: Historical | None = None


class EvaluationMigration(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source: str = Field(pattern=r"^(synthetic|approved-private)$")
    revision: str = Field(min_length=1)
    cases: list[EvaluationCase] = Field(min_length=1, max_length=10000)


def load_owner_only_document(file: str) -> bytes:
    """Explicit bounded regular file; no symlink race or raw review-directory scan."""
    path = Path(file)
    if "review" in path.parts:
        raise ValueError("Human review raw sheets cannot be imported")
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(descriptor)
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_mode & 0o077
            or info.st_uid != os.getuid()
            or info.st_size > 16 * 1024**2
        ):
            raise ValueError("Private export must be owner-owned regular file <=16MiB")
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            value = stream.read(16 * 1024**2 + 1)
        if len(value) > 16 * 1024**2:
            raise ValueError("Private export exceeds bound")
        return value
    finally:
        os.close(descriptor)


def load_approved_migration(file: str, approval: str) -> EvaluationMigration:
    if approval != "approved-private-import":
        raise ValueError("Explicit private import approval required")
    result = EvaluationMigration.model_validate_json(load_owner_only_document(file))
    if result.source != "approved-private":
        raise ValueError("Wrong export provenance")
    return result


class ReviewScore(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    config_id: str = Field(min_length=1, max_length=200)
    name: str = Field(min_length=1, max_length=35)
    value: int | float
    comment: str | None = Field(default=None, max_length=4000)

    @field_validator("value")
    @classmethod
    def finite(cls, value):
        if not math.isfinite(value):
            raise ValueError("Review score must be finite")
        return value


class ReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    source: Literal["approved-review-api"]
    queueId: str = Field(min_length=1, max_length=200)
    itemId: str = Field(min_length=1, max_length=200)
    traceId: str = Field(pattern=r"^[a-f0-9]{32}$")
    scores: list[ReviewScore] = Field(min_length=1, max_length=100)


def load_approved_review(file: str, approval: str) -> ReviewRequest:
    if approval != "approved-review-write":
        raise ValueError("Explicit review API write approval required")
    return ReviewRequest.model_validate_json(load_owner_only_document(file))


def migrate_dataset(client: Any, name: str, migration: EvaluationMigration) -> dict[str, int]:
    from langfuse.api.core.api_error import ApiError

    try:
        client.api.datasets.get(name, request_options=API_OPTIONS)
    except ApiError as error:
        if error.status_code != 404:
            raise
        client.create_dataset(
            name=name, metadata={"source": migration.source, "migration": "python-v4"}
        )
    imported = unlinked = 0
    for case in migration.cases:
        identifier = migration_id(name, migration.revision, case.id)
        historical = case.historical
        metadata = {
            "caseId": case.id,
            "revision": migration.revision,
            "rubric": case.rubric,
            "source": migration.source,
            "managedBy": "ptr-framework",
        }
        if historical:
            # Shared project retention uses these top-level fields in both SDK languages.
            metadata["originalRunAt"] = historical.originalRunAt
            metadata["originalVersion"] = historical.originalVersion
            metadata["historicalArchive"] = {
                **historical.model_dump(mode="json"),
                "notANewExecution": True,
            }
        client.create_dataset_item(
            id=identifier,
            dataset_name=name,
            input=case.input,
            expected_output=case.expectedOutput,
            metadata=metadata,
            source_trace_id=historical.sourceTraceId if historical else None,
        )
        if historical and not historical.sourceTraceId:
            unlinked += 1
        if historical and historical.sourceTraceId:
            for score in historical.scores:
                client.api.scores.create(
                    id=migration_id(identifier, score.name),
                    trace_id=historical.sourceTraceId,
                    name=score.name,
                    value=score.value,
                    comment=redact_telemetry(score.comment),
                    metadata={
                        "source": "historical-import",
                        "originalRunAt": historical.originalRunAt,
                        "originalVersion": historical.originalVersion,
                        "notANewEvaluation": True,
                        "reviewer": redact_telemetry(score.reviewer),
                    },
                    data_type="CATEGORICAL" if isinstance(score.value, str) else "NUMERIC",
                    request_options=API_OPTIONS,
                )
                imported += 1
    return {
        "items": len(migration.cases),
        "historicalScores": imported,
        "unlinkedHistorical": unlinked,
    }


def _pages(call: Any) -> list[Any]:
    result: list[Any] = []
    for page in range(1, 10001):
        response = call(page=page, limit=100, request_options=API_OPTIONS)
        result.extend(response.data)
        if page >= response.meta.total_pages:
            return result
    raise ValueError("Pagination limit exceeded")


def ensure_human_review(
    client: Any, name: str, dimensions: list[dict[str, Any]] | None = None
) -> str:
    dimensions = dimensions or [
        {"name": n, "min_value": 0, "max_value": 1, "description": "0 fail, 1 pass"}
        for n in REVIEW_DIMENSIONS
    ]
    names = [d["name"] for d in dimensions]
    if len(set(names)) != len(names) or not dimensions:
        raise ValueError("Unique review dimensions required")
    configs = _pages(client.api.score_configs.get)
    ids = []
    for dimension in dimensions:
        low, high = dimension["min_value"], dimension["max_value"]
        if not math.isfinite(low) or not math.isfinite(high) or low >= high:
            raise ValueError("Invalid rubric bounds")
        matches = [c for c in configs if c.name == dimension["name"] and not c.is_archived]
        if len(matches) > 1:
            raise ValueError("Ambiguous review rubric")
        config = (
            matches[0]
            if matches
            else client.api.score_configs.create(
                **dimension, data_type="NUMERIC", request_options=API_OPTIONS
            )
        )
        if config.data_type != "NUMERIC" or config.min_value != low or config.max_value != high:
            raise ValueError("Review rubric changed")
        ids.append(config.id)
    queues = [q for q in _pages(client.api.annotation_queues.list_queues) if q.name == name]
    if len(queues) > 1:
        raise ValueError("Ambiguous review queue")
    if queues:
        if sorted(queues[0].score_config_ids) != sorted(ids):
            raise ValueError("Review queue rubric changed")
        return queues[0].id
    return client.api.annotation_queues.create_queue(
        name=name, score_config_ids=ids, request_options=API_OPTIONS
    ).id


def enqueue_human_review(client: Any, queue_id: str, trace_ids: list[str]) -> None:
    existing = {
        i.object_id
        for i in _pages(
            lambda **kwargs: client.api.annotation_queues.list_queue_items(queue_id, **kwargs)
        )
    }
    for trace_id in dict.fromkeys(trace_ids):
        if trace_id not in existing:
            client.api.annotation_queues.create_queue_item(
                queue_id, object_id=trace_id, object_type="TRACE", request_options=API_OPTIONS
            )


def record_human_review(
    client: Any, queue_id: str, item_id: str, trace_id: str, scores: list[dict[str, Any]]
) -> None:
    api = client.api.annotation_queues
    item = api.get_queue_item(queue_id, item_id, request_options=API_OPTIONS)
    queue = api.get_queue(queue_id, request_options=API_OPTIONS)
    if item.object_id != trace_id or item.object_type != "TRACE":
        raise ValueError("Review trace binding mismatch")
    ids = [s["config_id"] for s in scores]
    if len(set(ids)) != len(ids) or sorted(ids) != sorted(queue.score_config_ids) or not scores:
        raise ValueError("Every configured rubric required exactly once")
    for score in scores:
        config = client.api.score_configs.get_by_id(score["config_id"], request_options=API_OPTIONS)
        value = score["value"]
        if (
            config.data_type != "NUMERIC"
            or config.name != score["name"]
            or not isinstance(value, (float, int))
            or not math.isfinite(value)
            or config.min_value is not None
            and value < config.min_value
            or config.max_value is not None
            and value > config.max_value
        ):
            raise ValueError("Invalid review score")
    for score in scores:
        client.api.scores.create(
            **{k: v for k, v in score.items() if k != "comment"},
            id=migration_id(queue_id, item_id, score["name"]),
            trace_id=trace_id,
            queue_id=queue_id,
            source="ANNOTATION",
            data_type="NUMERIC",
            comment=redact_telemetry(score.get("comment")),
            request_options=API_OPTIONS,
        )
    # Direct synchronous REST acknowledgement (not buffered SDK score) before completing item.
    api.update_queue_item(queue_id, item_id, status="COMPLETED", request_options=API_OPTIONS)


def _score_key(score: Any) -> tuple[str, Any, str]:
    value = score.value
    if isinstance(value, bool):
        value = int(value)
    return (
        score.name,
        value,
        score.data_type or ("CATEGORICAL" if isinstance(value, str) else "NUMERIC"),
    )


def verify_experiment_scores(client: Any, items: list[Any], timeout: float = 20) -> None:
    if not 0 < timeout <= 120:
        raise ValueError("Invalid score persistence deadline")
    deadline = time.monotonic() + timeout
    for item in items:
        if not item.trace_id or not item.evaluations:
            raise ValueError("Missing trace/score binding")
        required = Counter(_score_key(s) for s in item.evaluations)
        while True:
            actual: Counter[Any] = Counter()
            cursor = None
            cursors: set[str] = set()
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Score persistence deadline exceeded")
                response = client.api.scores_v3.get_many_v3(
                    trace_id=item.trace_id,
                    limit=100,
                    cursor=cursor,
                    request_options={"max_retries": 0, "timeout_in_seconds": min(5, remaining)},
                )
                actual.update(_score_key(s) for s in response.data)
                cursor = response.meta.cursor
                if not cursor:
                    break
                if cursor in cursors:
                    raise ValueError("Score cursor repeated")
                cursors.add(cursor)
            if not required - actual:
                break
            if time.monotonic() >= deadline:
                raise TimeoutError("Score persistence deadline exceeded")
            time.sleep(min(0.25, max(0, deadline - time.monotonic())))


async def run_framework_experiment_async(
    client: Any,
    dataset_name: str,
    run_name: str,
    versions: dict[str, str],
    task: Any,
    evaluators: list[Any],
    score_policy: dict[str, Any],
    **options: Any,
) -> dict[str, Any]:
    """Native SDK off-loop; application ports remain on their owning async loop.

    Langfuse4.17 synchronously bridges its experiment into a new asyncio loop.
    Calling that sync API from a Runtime loop blocks it and cannot safely move
    an existing pool/AsyncClient. This facade keeps setup/task/close on caller's
    loop and passes SDK OTel/contextvars through the thread-safe coroutine hop.
    """
    loop = asyncio.get_running_loop()
    stopped = threading.Event()
    # Accessed only on the application's owning loop, never from SDK threads.
    active: set[asyncio.Task[Any]] = set()

    def bridge(function):
        async def invoke(**kwargs):
            if stopped.is_set():
                raise asyncio.CancelledError

            async def owned():
                # Submission and execution are separate: cancellation can happen
                # after SDK submits this coroutine but before the owner runs it.
                if stopped.is_set():
                    raise asyncio.CancelledError
                current = asyncio.current_task()
                assert current is not None
                active.add(current)
                try:
                    result = function(**kwargs)
                    return await result if inspect.isawaitable(result) else result
                finally:
                    active.discard(current)

            return await asyncio.wrap_future(asyncio.run_coroutine_threadsafe(owned(), loop))

        return invoke

    job = asyncio.create_task(
        asyncio.to_thread(
            run_framework_experiment,
            client,
            dataset_name,
            run_name,
            versions,
            bridge(task),
            [bridge(evaluator) for evaluator in evaluators],
            score_policy,
            **options,
        )
    )
    try:
        return await asyncio.shield(job)
    except asyncio.CancelledError:
        stopped.set()
        for callback in tuple(active):
            callback.cancel()
        # to_thread cancellation cannot stop its thread. Do not acknowledge the
        # caller cancellation (and permit Runtime.close) until the SDK settles.
        # Native REST/persistence calls have finite deadlines; user callbacks
        # must cooperate with cancellation, as with any asyncio resource owner.
        # Repeated caller cancellation must not abandon this shutdown barrier.
        while not job.done():
            try:
                await asyncio.shield(job)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if job.done() and not job.cancelled():
            # Retrieve a failed SDK outcome without masking caller cancellation.
            job.exception()
        raise


def run_framework_experiment(
    client: Any,
    dataset_name: str,
    run_name: str,
    versions: dict[str, str],
    task: Any,
    evaluators: list[Any],
    score_policy: dict[str, Any],
    queue_name: str | None = None,
    telemetry: Any = None,
    persistence_timeout: float = 20,
    review_dimensions: list[dict[str, Any]] | None = None,
    dataset_version: datetime | None = None,
) -> dict[str, Any]:
    if dataset_version is not None and (
        not isinstance(dataset_version, datetime) or dataset_version.utcoffset() != timedelta(0)
    ):
        raise ValueError("Dataset version requires explicit UTC timestamp")
    rules = {r["name"]: r for r in score_policy.get("rules", [])}
    if (
        not rules
        or len(rules) != len(score_policy["rules"])
        or not evaluators
        or not callable(score_policy.get("expected"))
    ):
        raise ValueError("Unique explicit score policy and evaluators required")
    for rule in rules.values():
        if rule.get("kind") == "numeric":
            bounds = [rule.get(key) for key in ("min", "passMin", "passMax", "max")]
            if any(not isinstance(v, (int, float)) or not math.isfinite(v) for v in bounds):
                raise ValueError("Invalid score pass policy")
            if bounds != sorted(bounds):
                raise ValueError("Invalid score pass policy")
        elif rule.get("kind") == "categorical":
            values, passing = rule.get("values"), rule.get("passValues")
            if not values or not passing or any(v not in values for v in passing):
                raise ValueError("Invalid categorical pass policy")
        else:
            raise ValueError("Unknown score policy kind")
    if queue_name and telemetry is None:
        raise ValueError("Review requires tracing flush boundary")
    failures = {"failedScores": 0, "missingScores": 0, "taskFailures": 0}
    failed_outputs: set[int] = set()

    async def guarded_task(**kwargs: Any) -> Any:
        import inspect

        try:
            output = task(**kwargs)
            return await output if inspect.isawaitable(output) else output
        except Exception:
            failures["taskFailures"] += 1
            result = {"applicationTaskFailed": True}
            failed_outputs.add(id(result))
            return result

    async def guarded_evaluator(**kwargs: Any) -> list[Evaluation]:
        import inspect

        expected = score_policy["expected"](kwargs.get("input"))
        if (
            not isinstance(expected, dict)
            or any(n not in rules or not isinstance(c, int) or c < 1 for n, c in expected.items())
            or not expected
        ):
            raise ValueError("Invalid metric multiplicity")
        scores = []
        for evaluator in evaluators:
            try:
                result = evaluator(**kwargs)
                result = await result if inspect.isawaitable(result) else result
            except Exception:
                failures["failedScores"] += 1
                continue
            for score in result if isinstance(result, list) else [result]:
                rule = rules.get(getattr(score, "name", None))
                if not rule or score.name not in expected:
                    failures["failedScores"] += 1
                    continue
                value = score.value
                numeric = rule["kind"] == "numeric"
                valid = (
                    isinstance(value, (int, float))
                    and math.isfinite(value)
                    and rule["min"] <= value <= rule["max"]
                    and score.data_type != "CATEGORICAL"
                    if numeric
                    else isinstance(value, str) and value in rule["values"]
                )
                if not valid:
                    failures["failedScores"] += 1
                    continue
                passed = (
                    rule["passMin"] <= value <= rule["passMax"]
                    if numeric
                    else (value in rule["passValues"])
                )
                if not passed:
                    failures["failedScores"] += 1
                scores.append(
                    Evaluation(
                        name=score.name,
                        value=value,
                        comment=redact_telemetry(score.comment),
                        metadata=redact_telemetry(score.metadata),
                        data_type=score.data_type,
                    )
                )
        counts = Counter(s.name for s in scores)
        for name, count in expected.items():
            failures["missingScores"] += max(0, count - counts[name])
            failures["failedScores"] += max(0, counts[name] - count)
        if id(kwargs.get("output")) in failed_outputs:
            failures["failedScores"] += 1
        return scores or [Evaluation(name="evaluation_invalid", value=0)]

    dataset = (
        client.get_dataset(dataset_name, version=dataset_version)
        if dataset_version is not None
        else client.get_dataset(dataset_name)
    )
    if not dataset.items:
        raise ValueError("Regression dataset must not be empty")
    # Invalid policy must fail BEFORE any task (and possible paid submission).
    for item in dataset.items:
        expected = score_policy["expected"](item.input)
        if (
            not isinstance(expected, dict)
            or not expected
            or any(
                name not in rules
                or isinstance(count, bool)
                or not isinstance(count, int)
                or count < 1
                for name, count in expected.items()
            )
        ):
            raise ValueError("Invalid required metric multiplicity")
    result = dataset.run_experiment(
        name="persona-regression",
        run_name=run_name,
        metadata=versions,
        task=guarded_task,
        evaluators=[guarded_evaluator],
        max_concurrency=1,
    )
    if len(result.item_results) != len(dataset.items):
        failures["missingScores"] += abs(len(dataset.items) - len(result.item_results))
        failures["failedScores"] += 1
    client.flush()
    if telemetry and not telemetry.flush():
        raise RuntimeError("Experiment tracing flush failed")
    verify_experiment_scores(client, result.item_results, persistence_timeout)
    traces = [item.trace_id for item in result.item_results if item.trace_id]
    if queue_name:
        enqueue_human_review(
            client, ensure_human_review(client, queue_name, review_dimensions), traces
        )
    return {
        "runName": result.run_name,
        "cases": len(result.item_results),
        "traceIds": traces,
        **failures,
    }


SYNTHETIC_MIGRATION = EvaluationMigration.model_validate(
    {
        "source": "synthetic",
        "revision": "synthetic-v1",
        "cases": [
            {"id": "hello-ko", "input": "안녕", "expectedOutput": "안녕!"},
            {"id": "hello-en", "input": "hello", "expectedOutput": "hello!"},
        ],
    }
)
SYNTHETIC_POLICY = {
    "rules": [
        {"name": "exact_match", "kind": "numeric", "min": 0, "max": 1, "passMin": 1, "passMax": 1}
    ],
    "expected": lambda _: {"exact_match": 1},
}
