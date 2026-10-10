"""Reproduce the bounded synthetic static-import GC memory proof.

Run with apps/llm-service/.venv/bin/python scripts/split-memory-proof.py
--roles-env=/absolute/owned/private/roles.env --output=/tmp/ptr-split-memory-NEW.

Requires the already bootstrapped isolated test DB (port58432, ptr_split_test,
ptr_split_llm role). No DDL, model network calls, Redis, paid calls, or private
corpus. This instrumented proof is not the frozen performance benchmark.
"""

import argparse
import collections
import contextlib
import gc
import hashlib
import json
import os
import pathlib
import stat
import statistics
import subprocess
import sys
import time
import tracemalloc
import weakref
from typing import Any
from urllib.parse import urlsplit

ROOT = pathlib.Path(__file__).resolve().parents[1]
GATES: dict[str, Any] = {
    "jobs": 10000,
    "lateWindowEnds": [8000, 9000, 10000],
    "lateWindowJobs": 1000,
    "aggregateLateWindowJobs": 3000,
    "batch": 100,
    "warmup": 64,
    "rssTailRangeMiB": 32,
    "pssTailRangeMiB": 32,
    "tracedTailRangeMiB": 8,
    "tailSlopeMiBPer1000": 1,
    "candidateExcessSlopeMiBPer1000": 1,
    "tailDriftMiB": 2,
    "unreclaimedRequests": 0,
    "forcedGen2EveryJobs": 0,
    "automaticGcOnlyDuringJobs": True,
    "defaultGcEnabled": True,
    "thresholdsUnchanged": True,
    "epochWindowEnds": [6000, 8000, 10000],
    "epochWindowJobs": 2000,
    "epochAggregateWindowJobs": 6000,
    "dropFirstMeasuredGen2Epochs": 3,
    "dropEpochJobsThrough": 1000,
    "primaryEpochActiveJobs": 0,
    "maximumGen2CompletedJobLag": 4,
    "observerTriggeredEpochsExcluded": True,
    "minimumEpochsPerWindow": 3,
    "minimumEpochJobSpan": 1000,
    "observerGcEventCapacity": 64,
    "observerEpochCapacity": 128,
    "observerBlockCapacity": 102,
    "observerRefCapacity": 2048,
}


class Marker:
    def __init__(self):
        self.cycle = self


class WeakGrant(dict):
    marker: Marker


class ProofError(RuntimeError):
    """Constant safe code only; never format a URL or credential into errors."""


def private_regular(path):
    path = pathlib.Path(path)
    if not path.is_absolute() or path.resolve() != path:
        raise ProofError("PRIVATE_FILE_PATH")
    info = path.lstat()
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or stat.S_IMODE(info.st_mode) != 0o600
    ):
        raise ProofError("PRIVATE_FILE_PERMISSION")
    return path


def guarded_database_url(value):
    try:
        parsed = urlsplit(value)
        valid = (
            parsed.scheme in ("postgresql", "postgres")
            and parsed.hostname in ("127.0.0.1", "localhost")
            and parsed.port == 58432
            and parsed.path == "/ptr_split_test"
            and parsed.username == "ptr_split_llm"
            and bool(parsed.password)
            and not parsed.query
            and not parsed.fragment
        )
    except (TypeError, ValueError):
        valid = False
    if not valid:
        raise ProofError("SYNTHETIC_LLM_DATABASE_REQUIRED")
    return value


def read_roles_url(path):
    path = private_regular(path)
    selected = None
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if key == "PTR_SPLIT_TEST_LLM_DATABASE_URL":
            if not separator or selected is not None:
                raise ProofError("ROLE_FILE_SHAPE")
            selected = value
    if selected is None:
        raise ProofError("LLM_TEST_ROLE_REQUIRED")
    return guarded_database_url(selected)


def guarded_output(path, child=False):
    path = pathlib.Path(path)
    directory = path.parent if child else path
    if (
        not directory.is_absolute()
        or directory.parent != pathlib.Path("/tmp")
        or not directory.name.startswith("ptr-split-memory-")
        or directory.resolve() != directory
    ):
        raise ProofError("PRIVATE_TMP_OUTPUT_REQUIRED")
    if child:
        if path.name not in (
            "baseline.json",
            "candidate.json",
            "baseline-negative.json",
            "candidate-negative.json",
        ):
            raise ProofError("CHILD_OUTPUT_NAME")
        info = directory.lstat()
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) != 0o700
        ):
            raise ProofError("PRIVATE_DIRECTORY_PERMISSION")
    elif directory.exists() or directory.is_symlink():
        raise ProofError("FRESH_OUTPUT_REQUIRED")
    return path


def write(path, value):
    path = pathlib.Path(path)
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW
    with os.fdopen(os.open(path, flags, 0o600), "w") as stream:
        stream.write(json.dumps(value, indent=2) + "\n")
    path.chmod(0o600)


def memory(label, jobs):
    began = time.perf_counter()
    values = {}
    for line in pathlib.Path("/proc/self/smaps_rollup").read_text().splitlines():
        fields = line.split()
        if fields and fields[0] in ["Rss:", "Pss:"]:
            values[fields[0][:-1].lower() + "KiB"] = int(fields[1])
    current, peak = tracemalloc.get_traced_memory()
    return {
        "label": label,
        "jobs": jobs,
        **values,
        "tracedBytes": current,
        "tracedPeakBytes": peak,
        "allocatedBlocks": sys.getallocatedblocks(),
        "gcCounts": gc.get_count(),
        "gcStats": gc.get_stats(),
        "freezeCount": gc.get_freeze_count(),
        "gcEnabled": gc.isenabled(),
        "thresholds": gc.get_threshold(),
        "probeMs": (time.perf_counter() - began) * 1000,
    }


def evaluate_window(points, start, end, minimum_count=0, minimum_span=0):
    tail = [point for point in points if start < point["jobs"] <= end]
    valid = (
        len(tail) >= minimum_count
        and len(tail) >= 2
        and tail[-1]["jobs"] - tail[0]["jobs"] >= minimum_span
    )
    result = {
        "endJobs": end,
        "fromJobsExclusive": start,
        "sampleCount": len(tail),
        "jobSpan": tail[-1]["jobs"] - tail[0]["jobs"] if tail else 0,
        "valid": valid,
    }
    if not valid:
        return {**result, "plateau": {}, "passed": False}
    xs = [point["jobs"] / 1000 for point in tail]

    def metric(key, scale):
        ys = [point[key] / scale for point in tail]
        meanx = statistics.mean(xs)
        meany = statistics.mean(ys)
        den = sum((x - meanx) ** 2 for x in xs)
        slope = sum((x - meanx) * (y - meany) for x, y in zip(xs, ys)) / den
        return {
            "rangeMiB": max(ys) - min(ys),
            "slopeMiBPer1000": slope,
            "firstMiB": ys[0],
            "lastMiB": ys[-1],
            "driftMiB": ys[-1] - ys[0],
        }

    plateau = {
        "rss": metric("rssKiB", 1024),
        "pss": metric("pssKiB", 1024),
        "traced": metric("tracedBytes", 1024 * 1024),
    }
    gates = {
        key: plateau[key]["rangeMiB"] <= GATES[gate]
        and plateau[key]["slopeMiBPer1000"] <= GATES["tailSlopeMiBPer1000"]
        and plateau[key]["driftMiB"] <= GATES["tailDriftMiB"]
        for key, gate in [
            ("rss", "rssTailRangeMiB"),
            ("pss", "pssTailRangeMiB"),
            ("traced", "tracedTailRangeMiB"),
        ]
    }
    return {**result, "plateau": plateau, "metricPassed": gates, "passed": all(gates.values())}


def bootstrap(mode):
    from ptr_llm import bootstrap as module

    if mode == "candidate":
        return module.static_import_gc()

    @contextlib.contextmanager
    def baseline():
        prime = getattr(module, "prime_static_imports", None) or getattr(
            module, "_prime_static_imports", None
        )
        if prime is None:
            raise RuntimeError("BASELINE_STATIC_PRIMING_API_REQUIRED")
        prime()
        gc.collect()
        yield False

    return baseline()


def negative(mode, output):
    # No Runtime/client/task/job has been created. This is a separate process from A/B jobs.
    parent: Marker | None = Marker()
    parent_ref = weakref.ref(parent)
    thresholds = gc.get_threshold()
    initial = gc.get_freeze_count()
    with bootstrap(mode) as owned:
        assert gc.isenabled() and gc.get_threshold() == thresholds
        child: Marker | None = Marker()
        child_ref = weakref.ref(child)
        assert parent is not None and child is not None
        parent.cycle = child
        child.cycle = parent
        parent = None
        child = None
        gc.collect(2)
        alive = (parent_ref() is not None, child_ref() is not None)
        assert alive == ((True, True) if mode == "candidate" else (False, False))
    gc.collect(2)
    assert parent_ref() is None and child_ref() is None and gc.get_freeze_count() == initial
    write(
        output,
        {
            "mode": mode,
            "ownedFreeze": bool(owned),
            "retainedBeforeUnfreeze": alive,
            "reclaimedAfterUnfreeze": True,
            "thresholdsUnchanged": gc.get_threshold() == thresholds,
            "gcEnabled": gc.isenabled(),
        },
    )


async def workload(output, mode):
    import asyncio
    import contextvars
    import copy
    import uuid

    import httpx
    from langfuse import Langfuse
    from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
    from opentelemetry.sdk.trace import TracerProvider
    from psycopg.rows import dict_row
    from psycopg_pool import AsyncConnectionPool
    from ptr_llm.core.runtime import LLMEngine
    from ptr_llm.providers import CheckpointedTextProvider, LiteLLMTextProvider
    from ptr_llm.repositories import ResultReceiptStore
    from ptr_llm.repositories.database import assert_llm_database_url
    from ptr_llm.telemetry import FrameworkTelemetry, TelemetryConfig

    source = json.loads((ROOT / "apps/llm-service/tests/core_domain_golden.json").read_text())
    persona = next(x["input"] for x in source if x["kind"] == "persona")
    post = next(x["source"] for x in source if x["kind"] == "evidence")
    url = os.environ["PTR_MEMORY_PG_URL"]
    assert_llm_database_url(url)
    guarded_database_url(url)
    spec: contextvars.ContextVar[dict[str, Any]] = contextvars.ContextVar("memory-request-spec")
    threads = set()
    executions: set[str] = set()
    initial_thresholds = gc.get_threshold()
    counts = {
        k: 0
        for k in [
            "normal",
            "tool",
            "cancel",
            "deadline",
            "failure",
            "replay",
            "safety",
            "httpCalls",
            "completed",
            "failed",
            "expensiveReplaySuppressed",
            "receiptAck",
            "requestRefs",
            "guardCalls",
        ]
    }
    refs: list[weakref.ReferenceType[Any]] = []
    samples: collections.deque[dict[str, Any]] = collections.deque(
        maxlen=GATES["observerBlockCapacity"]
    )
    gc_events: collections.deque[dict[str, Any]] = collections.deque(
        maxlen=GATES["observerGcEventCapacity"]
    )
    epochs: collections.deque[dict[str, Any]] = collections.deque(
        maxlen=GATES["observerEpochCapacity"]
    )
    gc_counts: collections.Counter[int] = collections.Counter()
    gc_started = {}
    manual_gc = False
    measuring = False
    active_jobs = 0
    completed_total = 0
    epoch_number = 0
    observer_max_refs = 0
    pending_gen2 = None
    probe_active = False
    pending_coalesced = 0
    observer_gen2_count = 0

    def gc_timing(phase, info):
        nonlocal epoch_number, pending_gen2, pending_coalesced, observer_gen2_count
        generation = info["generation"]
        if phase == "start":
            gc_started[generation] = time.perf_counter()
        elif generation in gc_started:
            gc_events.append(
                {
                    "generation": generation,
                    "ms": (time.perf_counter() - gc_started.pop(generation)) * 1000,
                    "collected": info["collected"],
                    "uncollectable": info["uncollectable"],
                    "automatic": not manual_gc,
                    "observerActive": probe_active,
                }
            )
            if not manual_gc:
                gc_counts[generation] += 1
            if generation == 2 and not manual_gc and measuring:
                epoch_number += 1
                if pending_gen2 is not None:
                    pending_coalesced += 1
                if probe_active:
                    observer_gen2_count += 1
                pending_gen2 = (
                    epoch_number,
                    completed_total - GATES["warmup"],
                    active_jobs,
                    probe_active,
                )

    def capture_pending_epoch():
        nonlocal pending_gen2, probe_active, observer_max_refs
        if pending_gen2 is None:
            return
        assert active_jobs == 0
        saved = pending_gen2
        pending_gen2 = None
        probe_active = True
        try:
            probe_started = time.perf_counter()
            sample = memory("natural-gen2-associated-quiescent", completed_total - GATES["warmup"])
            alive = sum(ref() is not None for ref in refs)
            sample.update(
                epoch=saved[0],
                completedJobsAtGen2Stop=saved[1],
                activeJobsAtGen2Stop=saved[2],
                activeJobs=active_jobs,
                completedJobLag=sample["jobs"] - saved[1],
                originObserver=saved[3],
                unreclaimedRequestRefs=alive,
                refObserverSize=len(refs),
                epochProbeMs=(time.perf_counter() - probe_started) * 1000,
            )
            assert 0 <= sample["completedJobLag"] <= GATES["maximumGen2CompletedJobLag"]
            epochs.append(sample)
            observer_max_refs = max(observer_max_refs, len(refs))
            sample["observerGen2DuringProbe"] = pending_gen2 is not None
        finally:
            probe_active = False

    gc.callbacks.append(gc_timing)

    class Personas:
        async def get(self, *_):
            return copy.deepcopy(persona)

    class Retrieval:
        async def search(self, *_, **kw):
            return [copy.deepcopy(post)]

        async def resolve(self, *_, **kw):
            return [copy.deepcopy(post)]

    class OwnedSaver(AsyncPostgresSaver):
        async def aput(self, config, *a, **kw):
            threads.add(config["configurable"]["thread_id"])
            return await super().aput(config, *a, **kw)

    async def transport(request):
        current = spec.get()
        current["calls"] += 1
        counts["httpCalls"] += 1
        await asyncio.sleep(0)
        if current["mode"] == "cancel":
            current["signal"].set()
        if current["mode"] == "failure" and current["calls"] == 1:
            return httpx.Response(
                500, json={"error": {"message": "synthetic memory failure", "type": "synthetic"}}
            )
        body: dict[str, Any] = {
            "message": "Hello synthetic memory!",
            "status": "answered",
            "evidenceRefs": [],
            "variableUpdates": {"conversationTopic": current["key"]},
        }
        if current["mode"] == "tool":
            if current["calls"] == 1:
                body.update(
                    message="",
                    variableUpdates={},
                    function={"name": "timeline_search", "arguments": {"query": "blue sky"}},
                )
            else:
                body.update(
                    message="That blue sky!",
                    evidenceRefs=[{"sourceId": post["id"], "quote": "I painted a blue sky."}],
                )
        return httpx.Response(
            200,
            json={
                "id": "synthetic-memory-generation",
                "object": "chat.completion",
                "created": 1,
                "model": "primary",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": json.dumps(body)},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 16, "completion_tokens": 12, "total_tokens": 28},
            },
        )

    # SDK observations are real; export is deliberately disabled only in this memory proof.
    # The official frozen performance protocol still exports normal tracing.
    cfg = TelemetryConfig(
        enabled=True,
        base_url="http://127.0.0.1:1",
        public_key="pk-lf-synthetic-memory",
        secret_key="sk-lf-synthetic-memory",
        allow_local_http=True,
        capture_content=False,
    )
    telemetry = FrameworkTelemetry(TelemetryConfig())
    telemetry.config = cfg
    telemetry.provider = TracerProvider()
    telemetry.client = Langfuse(
        base_url=cfg.base_url,
        public_key=cfg.public_key,
        secret_key=cfg.secret_key,
        tracer_provider=telemetry.provider,
        should_export_span=lambda span: False,
        mask=lambda **kwargs: None,
    )
    raw = LiteLLMTextProvider(
        base_url="http://127.0.0.1:1/v1",
        model="primary",
        api_key="synthetic-memory-key",
        transport=httpx.MockTransport(transport),
    )
    async with AsyncConnectionPool(
        url,
        min_size=1,
        max_size=8,
        open=False,
        kwargs={
            "autocommit": True,
            "prepare_threshold": 0,
            "row_factory": dict_row,
            "options": "-c search_path=llm,public",
        },
    ) as pool:
        # dict_row is explicit above; kwargs do not preserve pool row typing in mypy.
        provider = CheckpointedTextProvider(raw, OwnedSaver(pool))  # type: ignore[arg-type]
        engine = LLMEngine(
            provider=provider, personas=Personas(), retrieval=Retrieval(), telemetry=telemetry
        )
        receipts = ResultReceiptStore(pool, url)

        async def clean_rows():
            async with pool.connection() as conn:
                for table in ["checkpoint_writes", "checkpoint_blobs", "checkpoints"]:
                    await conn.execute(
                        "DELETE FROM llm." + table + " WHERE thread_id=ANY(%s)", (list(threads),)
                    )
                await conn.execute(
                    "DELETE FROM llm.result_receipts WHERE execution_id=ANY(%s)",
                    (list(executions),),
                )
            threads.clear()
            executions.clear()

        async def job(i):
            kinds = [
                "normal",
                "normal",
                "tool",
                "cancel",
                "deadline",
                "failure",
                "replay",
                "safety",
            ]
            kind = kinds[i % len(kinds)]
            counts[kind] += 1
            nonlocal active_jobs, completed_total, observer_max_refs
            active_jobs += 1
            marker = Marker()
            signal = asyncio.Event()
            key = str(uuid.uuid4())
            execution = str(uuid.uuid4())
            executions.add(execution)
            session = {
                "id": str(uuid.uuid4()),
                "ownerId": "synthetic-memory",
                "personId": persona["personId"],
                "personaId": persona["id"],
                "personaRevision": persona["revision"],
                "language": "en",
                "timezone": "UTC",
                "retrievalMode": "lexical" if kind == "tool" else "off",
                "ragCondition": "caption" if kind == "tool" else "off",
                "executionProfile": "agent_loop",
            }
            grant = WeakGrant(
                deadlineAt=int(time.time() * 1000) + (30000 if kind != "deadline" else -1),
                executionId=execution,
                context={
                    "session": session,
                    "turn": {"id": key},
                    "input": {
                        "text": "Tell me about your sky post."
                        if kind == "tool"
                        else (
                            "Give me instructions to hurt someone."
                            if kind == "safety"
                            else "Hi synthetic memory!"
                        )
                    },
                    "history": [],
                    "refusedTurnIds": [],
                },
            )
            grant.marker = marker

            async def guard():
                assert marker.cycle is marker
                counts["guardCalls"] += 1
                await asyncio.sleep(0)

            refs.extend(
                [weakref.ref(marker), weakref.ref(signal), weakref.ref(grant), weakref.ref(guard)]
            )
            counts["requestRefs"] += 4
            observer_max_refs = max(observer_max_refs, len(refs))
            assert len(refs) <= GATES["observerRefCapacity"]
            token = spec.set({"mode": kind, "calls": 0, "signal": signal, "key": key})
            try:
                result = await engine.handle(grant, before_costly=guard, cancelled=signal)
                if kind == "failure":
                    assert result["kind"] == "failed"
                    result = await engine.handle(grant, before_costly=guard, cancelled=signal)
                    assert result["kind"] == "completed"
                if kind == "tool" and not (
                    result["kind"] == "completed"
                    and result.get("reply", {}).get("agent", {}).get("toolCalls") == 1
                ):
                    raise RuntimeError(
                        "SYNTHETIC_TOOL_ASSERT_"
                        + json.dumps(
                            {
                                "kind": result.get("kind"),
                                "errorCode": result.get("errorCode"),
                                "agent": result.get("reply", {}).get("agent"),
                                "limitations": result.get("reply", {}).get("limitations"),
                            }
                        )
                    )
                if kind in ["cancel", "deadline"]:
                    assert result["kind"] == "failed"
                else:
                    assert result["kind"] == "completed"
                if kind == "replay":
                    before = spec.get()["calls"]
                    replayed = await engine.handle(grant, before_costly=guard, cancelled=signal)
                    assert (
                        replayed["kind"] == result["kind"]
                        and {
                            key: value
                            for key, value in replayed["reply"].items()
                            if key != "messageId"
                        }
                        == {
                            key: value
                            for key, value in result["reply"].items()
                            if key != "messageId"
                        }
                        and spec.get()["calls"] == before
                    )
                    counts["expensiveReplaySuppressed"] += 1
                stored = await receipts.put_result(grant, result)
                assert await receipts.get_result(grant) == stored
                await receipts.mark_result_ack(grant)
                counts["receiptAck"] += 1
                counts["completed" if result["kind"] == "completed" else "failed"] += 1
            finally:
                spec.reset(token)
                active_jobs -= 1
                completed_total += 1

        try:
            samples.append(memory("live-before-warmup", 0))
            for start in range(0, GATES["warmup"], 4):
                await asyncio.gather(
                    *(job(i) for i in range(start, min(start + 4, GATES["warmup"])))
                )
            await clean_rows()
            refs[:] = [ref for ref in refs if ref() is not None]
            samples.append(memory("warmed", 0))
            initial_runtime_freeze = gc.get_freeze_count()
            measuring = True
            for start in range(0, GATES["jobs"], GATES["batch"]):
                before = time.perf_counter()
                for index in range(start, start + GATES["batch"], 4):
                    await asyncio.gather(
                        *(
                            job(i + GATES["warmup"])
                            for i in range(index, min(index + 4, start + GATES["batch"]))
                        )
                    )
                    capture_pending_epoch()
                await clean_rows()
                alive = sum(ref() is not None for ref in refs)
                refs[:] = [ref for ref in refs if ref() is not None]
                probe_active = True
                try:
                    sample = memory("automatic-only-block", start + GATES["batch"])
                    assert (
                        sample["freezeCount"] <= initial_runtime_freeze
                        and sample["gcEnabled"]
                        and tuple(sample["thresholds"]) == initial_thresholds
                    )
                    sample.update(
                        blockMs=(time.perf_counter() - before) * 1000, unreclaimedRequestRefs=alive
                    )
                    samples.append(sample)
                    write(
                        output,
                        {
                            "mode": mode,
                            "gates": GATES,
                            "samples": list(samples),
                            "counts": counts,
                            "gcEvents": list(gc_events),
                            "automaticGcCounts": dict(gc_counts),
                            "epochs": list(epochs),
                            "observerGen2Count": observer_gen2_count,
                            "pendingCoalesced": pending_coalesced,
                            "incomplete": True,
                        },
                    )
                finally:
                    probe_active = False
            assert not raw._active and raw._hook_context.get() is None
            assert epoch_number <= GATES["observerEpochCapacity"]
            assert (
                gc_counts[2] > 0
                and completed_total == GATES["warmup"] + GATES["jobs"]
                and active_jobs == 0
            )
            manual_gc = True
            pre_collect = memory("before-final-diagnostic-collect", GATES["jobs"])
            probe_began = time.perf_counter()
            final_collected = gc.collect(2)
            final_probe_ms = (time.perf_counter() - probe_began) * 1000
            final_alive = sum(ref() is not None for ref in refs)
            assert final_alive == 0
            refs.clear()
            post_collect = memory("after-final-diagnostic-collect", GATES["jobs"])
        finally:
            await clean_rows()
            await raw.aclose()
            telemetry.shutdown()
            gc.callbacks.remove(gc_timing)
    runtime_closed = memory("runtime-closed", GATES["jobs"])
    blocks = [sample for sample in samples if sample["label"] == "automatic-only-block"]
    fixed_windows = [
        evaluate_window(blocks, end - GATES["lateWindowJobs"], end, 10)
        for end in GATES["lateWindowEnds"]
    ] + [
        evaluate_window(blocks, GATES["jobs"] - GATES["aggregateLateWindowJobs"], GATES["jobs"], 30)
    ]
    qualified = [
        epoch
        for epoch in epochs
        if epoch["epoch"] > GATES["dropFirstMeasuredGen2Epochs"]
        and epoch["jobs"] > GATES["dropEpochJobsThrough"]
        and epoch["activeJobs"] == GATES["primaryEpochActiveJobs"]
        and not epoch["originObserver"]
        and not epoch["observerGen2DuringProbe"]
        and 0 <= epoch["completedJobLag"] <= GATES["maximumGen2CompletedJobLag"]
    ]
    windows = [
        evaluate_window(
            qualified,
            end - GATES["epochWindowJobs"],
            end,
            GATES["minimumEpochsPerWindow"],
            GATES["minimumEpochJobSpan"],
        )
        for end in GATES["epochWindowEnds"]
    ] + [
        evaluate_window(
            qualified,
            GATES["jobs"] - GATES["epochAggregateWindowJobs"],
            GATES["jobs"],
            GATES["minimumEpochsPerWindow"] * 3,
            GATES["minimumEpochJobSpan"] * 3,
        )
    ]
    fixed_native_passed = all(
        window["valid"] and window["metricPassed"]["rss"] and window["metricPassed"]["pss"]
        for window in fixed_windows
    )
    valid = all(window["valid"] for window in windows)
    passed = valid and fixed_native_passed and all(window["passed"] for window in windows)
    return {
        "mode": mode,
        "gates": GATES,
        "samples": list(samples),
        "runtimeClosed": runtime_closed,
        "counts": counts,
        "gcEvents": list(gc_events),
        "automaticGcCounts": dict(gc_counts),
        "epochs": list(epochs),
        "observerGen2Count": observer_gen2_count,
        "pendingCoalesced": pending_coalesced,
        "qualifiedEpochCount": len(qualified),
        "observer": {
            "gcEvents": len(gc_events),
            "epochs": len(epochs),
            "blocks": len(samples),
            "maxRefObserverSize": observer_max_refs,
        },
        "fixedBlockWindows": fixed_windows,
        "exploratoryFixedBlockTraced": [
            {
                "fromJobsExclusive": window["fromJobsExclusive"],
                "endJobs": window["endJobs"],
                "passed": window["metricPassed"]["traced"],
                "metrics": window["plateau"]["traced"],
            }
            for window in fixed_windows
        ],
        "acceptancePolicy": (
            "ALL natural-gen2-associated quiescent epoch metrics + fixed-block NATIVE "
            "metrics are primary; fixed-block TRACED metrics are retained exploratory only"
        ),
        "fixedNativePassed": fixed_native_passed,
        "lateWindows": windows,
        "passed": passed,
        "valid": valid,
        "incomplete": False,
        "finalGcProbe": {
            "pre": pre_collect,
            "post": post_collect,
            "ms": final_probe_ms,
            "collected": final_collected,
            "unreclaimedRequestRefs": final_alive,
        },
        "limitations": [
            "synthetic HTTPX MockTransport; no actual network/Redis/BullMQ or billing calls",
            "real Langfuse observations with export disabled; exporter retention not covered",
            "manual gen2 only after all10000jobs; automatic GC throughout "
            "warmup/workload; not a performance gate",
            "10000 jobs is bounded evidence, not indefinite-lifetime proof",
            "quiescent existing4jobbarrier phase0 sample follows natural-gen2 stop "
            "by <=4completedjobs; up to4jobs residualgarbage is retained, not "
            "subtracted",
            "bounded observer overhead is measured and not subtracted; insufficient "
            "qualifying epochs are invalid",
        ],
    }


def child(mode, output):
    import asyncio

    initial_freeze = gc.get_freeze_count()
    thresholds = gc.get_threshold()
    tracemalloc.start(1)
    before = memory("before-static-priming", 0)
    with bootstrap(mode) as owned:
        assert (
            gc.isenabled()
            and gc.get_threshold() == thresholds
            and (bool(owned) == (mode == "candidate"))
        )
        primed = memory("after-static-priming", 0)
        result = asyncio.run(workload(output, mode))
        assert gc.isenabled() and gc.get_threshold() == thresholds
    gc.collect(2)
    result.update(
        ownedFreeze=bool(owned),
        beforePriming=before,
        afterPriming=primed,
        afterOwnedUnfreeze=memory("after-owned-unfreeze", GATES["jobs"]),
        ownershipCleaned=gc.get_freeze_count() == initial_freeze,
        thresholdsUnchanged=gc.get_threshold() == thresholds,
        gcEnabled=gc.isenabled(),
    )
    assert result["ownershipCleaned"]
    write(output, result)


def parent(output, roles_env):
    database_url = read_roles_url(roles_env)
    directory = guarded_output(output)
    directory.mkdir(mode=0o700)
    home = directory / "empty-home"
    home.mkdir(mode=0o700)
    env = {
        "PATH": os.environ["PATH"],
        "HOME": str(home),
        "PYTHONPATH": str(ROOT / "apps/llm-service/src") + ":" + str(ROOT / "src"),
        "PTR_MEMORY_PG_URL": database_url,
        "LANGSMITH_TRACING": "false",
        "LANGCHAIN_TRACING_V2": "false",
    }
    import shutil

    shutil.copyfile(__file__, directory / "proof-source.py")
    (directory / "proof-source.py").chmod(0o600)
    source_files = [
        "apps/llm-service/src/ptr_llm/bootstrap.py",
        "apps/llm-service/src/ptr_llm/providers/checkpoints.py",
        "apps/llm-service/src/ptr_llm/providers/langchain.py",
        "apps/llm-service/src/ptr_llm/core/runtime.py",
        "contracts/llm/v1/models.py",
    ]
    hashes = {file: hashlib.sha256((ROOT / file).read_bytes()).hexdigest() for file in source_files}
    write(
        directory / "source-manifest.json",
        {
            "sourceHashes": hashes,
            "proofHash": hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),
            "python": sys.version,
        },
    )
    write(
        directory / "predeclared.json",
        {
            "gates": GATES,
            "orders": ["baseline", "candidate", "baseline-negative", "candidate-negative"],
            "measurementPolicy": (
                "automatic GC only; natural-gen2-associated existing4jobbarrier "
                "quiescent activeJobs0 primary, completedjoblag<=4, observer-origin and "
                "probe-triggered events excluded, newly emitted pendingflag retained; "
                "drop first3measured epochs and jobs<=1000; each fixed2000jobwindow "
                ">=3epochs/span1000; aggregate >=9epochs/span3000; old native fixed "
                "windows retained; manual final gen2 outside workload"
            ),
            "modelNetworkCalls": 0,
            "paidCalls": 0,
        },
    )
    for mode, negative_flag in [
        ("baseline", False),
        ("candidate", False),
        ("baseline", True),
        ("candidate", True),
    ]:
        name = mode + ("-negative" if negative_flag else "")
        args = [
            sys.executable,
            __file__,
            "--child",
            mode,
            "--roles-env",
            str(roles_env),
            "--output",
            str(directory / (name + ".json")),
        ] + (["--negative"] if negative_flag else [])
        with os.fdopen(
            os.open(
                directory / (name + ".private.log"),
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                0o600,
            ),
            "w",
        ) as log:
            code = subprocess.call(args, env=env, stdout=log, stderr=log)
        (directory / (name + ".private.log")).chmod(0o600)
        print(json.dumps({"stage": name, "exit": code}), flush=True)
        if code:
            raise ProofError("MEMORY_CHILD_FAILED")
    documents = {
        name: json.loads((directory / (name + ".json")).read_text())
        for name in ["baseline", "candidate", "baseline-negative", "candidate-negative"]
    }
    baseline = documents["baseline"]
    candidate = documents["candidate"]
    valid = baseline["valid"] and candidate["valid"]
    excess = {
        str(c["fromJobsExclusive"]) + "-" + str(c["endJobs"]): {
            key: c["plateau"][key]["slopeMiBPer1000"] - b["plateau"][key]["slopeMiBPer1000"]
            for key in ["rss", "pss", "traced"]
        }
        for b, c in zip(baseline["lateWindows"], candidate["lateWindows"], strict=True)
        if b["valid"] and c["valid"]
    }
    native_excess = {
        str(c["fromJobsExclusive"]) + "-" + str(c["endJobs"]): {
            key: c["plateau"][key]["slopeMiBPer1000"] - b["plateau"][key]["slopeMiBPer1000"]
            for key in ["rss", "pss"]
        }
        for b, c in zip(baseline["fixedBlockWindows"], candidate["fixedBlockWindows"], strict=True)
    }
    relative_passed = valid and all(
        value <= GATES["candidateExcessSlopeMiBPer1000"]
        for window in [*excess.values(), *native_excess.values()]
        for value in window.values()
    )
    final_passed = relative_passed and all(documents[k].get("passed", True) for k in documents)
    write(
        directory / "summary.json",
        {
            "passed": final_passed,
            "valid": valid,
            "candidateExcessSlopeMiBPer1000": excess,
            "fixedNativeCandidateExcessSlopeMiBPer1000": native_excess,
            "relativePassed": relative_passed,
            "results": documents,
            "syntheticOnly": True,
            "paidCalls": 0,
        },
    )
    print(json.dumps({"output": str(directory), "passed": final_passed}))
    return final_passed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--roles-env", required=True, type=pathlib.Path)
    parser.add_argument("--child", choices=["baseline", "candidate"], help=argparse.SUPPRESS)
    parser.add_argument("--negative", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if sys.implementation.name != "cpython" or sys.version_info[:2] != (3, 13):
            raise ProofError("CPYTHON_313_REQUIRED")
        private_regular(args.roles_env)
        if args.child:
            guarded_output(args.output, child=True)
            guarded_database_url(os.environ.get("PTR_MEMORY_PG_URL"))
            if args.negative:
                negative(args.child, args.output)
            else:
                child(args.child, args.output)
            return 0
        return 0 if parent(args.output, args.roles_env) else 1
    except Exception as error:
        print(
            json.dumps(
                {
                    "passed": False,
                    "errorCode": "MEMORY_PROOF_FAILED",
                    "errorType": type(error).__name__,
                }
            ),
            file=sys.stderr,
        )
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
