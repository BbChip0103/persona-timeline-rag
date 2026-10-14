"""Pure gate/privacy regressions: no SDK imports, database, or model calls."""

import ast
import collections
import importlib.util
import json
import os
import pathlib
import textwrap
import time
import uuid

import pytest

SCRIPT = pathlib.Path(__file__).resolve().parents[3] / "scripts/split-memory-proof.py"
SPEC = importlib.util.spec_from_file_location("split_memory_proof", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
PROOF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROOF)
URL = "postgresql://ptr_split_llm:synthetic-only@127.0.0.1:58432/ptr_split_test"


def test_proof_manifest_sources_exist():
    assert "apps/llm-service/src/ptr_llm/providers/local.py" in PROOF.SOURCE_FILES
    assert all((PROOF.ROOT / source).is_file() for source in PROOF.SOURCE_FILES)


def points(slope=0):
    return [
        {
            "jobs": jobs,
            "rssKiB": 1024 * (100 + slope * jobs / 1000),
            "pssKiB": 1024 * (100 + slope * jobs / 1000),
            "tracedBytes": 1048576 * (100 + slope * jobs / 1000),
        }
        for jobs in [4200, 4700, 5200, 5800]
    ]


def test_preregistered_numeric_and_acquisition_policy_is_frozen():
    assert PROOF.GATES == {
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


def test_constant_memory_passes_and_calibrated_positive_slope_fails():
    assert PROOF.evaluate_window(points(), 4000, 6000, 3, 1000)["passed"]
    failed = PROOF.evaluate_window(points(1.01), 4000, 6000, 3, 1000)
    assert failed["valid"] and not failed["passed"]
    assert failed["plateau"]["traced"]["slopeMiBPer1000"] > 1


@pytest.mark.parametrize("values", [[], points()[:2], points()[2:]])
def test_insufficient_count_or_job_span_is_invalid_not_pass(values):
    result = PROOF.evaluate_window(values, 4000, 6000, 3, 1000)
    assert not result["valid"] and not result["passed"]


def test_drift_gate_is_independent_of_slope():
    values = [
        {
            "jobs": jobs,
            "rssKiB": 1024 * (100 + jobs / 2000),
            "pssKiB": 1024 * (100 + jobs / 2000),
            "tracedBytes": 1048576 * (100 + jobs / 2000),
        }
        for jobs in [4100, 6000, 8000, 9900]
    ]
    result = PROOF.evaluate_window(values, 4000, 10000, 3, 3000)
    assert result["valid"] and not result["passed"]
    assert result["plateau"]["rss"]["slopeMiBPer1000"] < 1
    assert result["plateau"]["rss"]["driftMiB"] > 2


@pytest.mark.parametrize(
    "url",
    [
        URL.replace("127.0.0.1", "example.invalid"),
        URL.replace("58432", "5432"),
        URL.replace("ptr_split_test", "ptr_split_research"),
        URL.replace("ptr_split_llm", "ptr_split_app"),
        URL.replace("synthetic-only", ""),
        URL + "?options=unsafe",
        URL + "#fragment",
        "not-a-database-url",
        None,
    ],
)
def test_database_guard_rejects_nonexact_targets_without_echoing_credentials(url):
    with pytest.raises(PROOF.ProofError) as error:
        PROOF.guarded_database_url(url)
    assert str(error.value) == "SYNTHETIC_LLM_DATABASE_REQUIRED"


def test_role_file_is_explicit_owned_private_nonsymlink(tmp_path):
    path = tmp_path / "roles.env"
    path.write_text("PTR_SPLIT_TEST_LLM_DATABASE_URL=" + URL + "\n")
    path.chmod(0o600)
    assert PROOF.read_roles_url(path) == URL
    path.chmod(0o644)
    with pytest.raises(PROOF.ProofError):
        PROOF.read_roles_url(path)
    path.chmod(0o600)
    link = tmp_path / "symlink.env"
    link.symlink_to(path)
    with pytest.raises(PROOF.ProofError):
        PROOF.read_roles_url(link)
    path.write_text("PTR_SPLIT_TEST_LLM_DATABASE_URL=" + URL + "\n" + path.read_text())
    with pytest.raises(PROOF.ProofError):
        PROOF.read_roles_url(path)


def test_fresh_private_output_and_file_modes():
    directory = pathlib.Path("/tmp") / ("ptr-split-memory-unit-" + uuid.uuid4().hex)
    assert PROOF.guarded_output(directory) == directory
    directory.mkdir(mode=0o700)
    try:
        with pytest.raises(PROOF.ProofError):
            PROOF.guarded_output(directory)
        path = directory / "baseline.json"
        assert PROOF.guarded_output(path, child=True) == path
        PROOF.write(path, {"synthetic": True})
        assert path.stat().st_mode & 0o777 == 0o600
        assert json.loads(path.read_text()) == {"synthetic": True}
        directory.chmod(0o755)
        with pytest.raises(PROOF.ProofError):
            PROOF.guarded_output(path, child=True)
    finally:
        directory.chmod(0o700)
        path.unlink(missing_ok=True)
        directory.rmdir()


def test_required_roles_argument_and_sanitized_failure(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(PROOF.sys, "argv", [str(SCRIPT), "--output=/tmp/ptr-split-memory-unit"])
    with pytest.raises(SystemExit):
        PROOF.main()
    assert "--roles-env" in capsys.readouterr().err
    roles = tmp_path / "roles.env"
    roles.write_text("PTR_SPLIT_TEST_LLM_DATABASE_URL=" + URL + "\n")
    roles.chmod(0o600)
    monkeypatch.setattr(
        PROOF.sys,
        "argv",
        [str(SCRIPT), "--roles-env=" + str(roles), "--output=/tmp/ptr-split-memory-unit"],
    )
    monkeypatch.setattr(PROOF.sys, "version_info", (3, 13))

    def fail(*_):
        raise RuntimeError("must-not-print-credential")

    monkeypatch.setattr(PROOF, "parent", fail)
    previous = os.umask(0o077)
    try:
        assert PROOF.main() == 1
    finally:
        os.umask(previous)
    output = capsys.readouterr()
    assert "must-not-print-credential" not in output.err + output.out
    assert json.loads(output.err)["errorCode"] == "MEMORY_PROOF_FAILED"


def pending_factory(inject):
    """Exercise actual source closures without importing SDKs or changing GC."""
    tree = ast.parse(SCRIPT.read_text())
    workload = next(
        node
        for node in tree.body
        if isinstance(node, ast.AsyncFunctionDef) and node.name == "workload"
    )
    closures = [
        node
        for node in workload.body
        if isinstance(node, ast.FunctionDef) and node.name in ["gc_timing", "capture_pending_epoch"]
    ]
    source = """def factory(inject):
 epoch_number=0;pending_gen2=None;pending_coalesced=0;observer_gen2_count=0
 probe_active=False;manual_gc=False;measuring=True;completed_total=GATES['warmup']+100
 active_jobs=4;observer_max_refs=0;refs=[];epochs=collections.deque(maxlen=128)
 gc_started={};gc_events=collections.deque(maxlen=64);gc_counts=collections.Counter()
 def memory(label,jobs):
  nonlocal inject
  if inject:
   inject=False;gc_timing('start',{'generation':2})
   gc_timing('stop',{'generation':2,'collected':1,'uncollectable':0})
  return {'label':label,'jobs':jobs}
"""
    source += "\n".join(textwrap.indent(ast.unparse(node), " ") for node in closures) + "\n"
    source += """ gc_timing('start',{'generation':2})
 gc_timing('stop',{'generation':2,'collected':1,'uncollectable':0})
 completed_total+=4;active_jobs=0
 def state():
  return {'pending':pending_gen2,'epochs':list(epochs),'observerCount':observer_gen2_count}
 return capture_pending_epoch,state
"""
    namespace = {"GATES": PROOF.GATES, "collections": collections, "time": time}
    exec(source, namespace)
    return namespace["factory"](inject)


def test_observer_gen2_pending_flag_survives_and_contaminated_epochs_are_excluded():
    capture, state = pending_factory(True)
    capture()
    first = state()
    assert first["pending"][0] == 2 and first["pending"][3] is True
    assert first["epochs"][0]["observerGen2DuringProbe"]
    assert first["epochs"][0]["completedJobLag"] == 4
    capture()
    second = state()
    assert second["pending"] is None and second["epochs"][1]["originObserver"]
    assert second["observerCount"] == 1


def test_clean_quiescent_sample_has_exact_phase_zero_and_bounded_lag():
    capture, state = pending_factory(False)
    capture()
    sample = state()["epochs"][0]
    assert state()["pending"] is None
    assert sample["activeJobs"] == 0 and sample["completedJobLag"] == 4
    assert not sample["originObserver"] and not sample["observerGen2DuringProbe"]
