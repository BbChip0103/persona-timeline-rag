#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONTEXT="${KUBE_CONTEXT:-kind-ptr-k8s}"
REPORT_DIR="${K8S_ACCEPTANCE_REPORT_DIR:-$ROOT/reports/k8s}"
PRIVATE_REPORT="${K8S_ACCEPTANCE_PRIVATE_REPORT:-$REPORT_DIR/acceptance.private.md}"
SUMMARY="${K8S_ACCEPTANCE_SUMMARY:-$REPORT_DIR/acceptance-summary.private.md}"
DEFAULT_TIMEOUT="${K8S_ACCEPTANCE_TIMEOUT:-1200s}"
RUN_ID="${K8S_ACCEPTANCE_RUN_ID:-k6-$(date -u +%Y%m%dT%H%M%SZ)}"

cd "$ROOT"

die() {
  printf 'ERROR %s\n' "$*" >&2
  exit 2
}

usage() {
  cat <<'USAGE'
Usage: scripts/k8s-acceptance.sh V1|V2|...|V13|V7NEG|all|summary

Runs the K6 kind acceptance wrapper against kind-ptr-k8s. Each test writes raw
counts-only evidence to reports/k8s/acceptance.private.md and prints one
machine-readable RESULT line. Tests with no implemented executable evidence fail
explicitly with reason=UNSUPPORTED_HARNESS_GAP.
USAGE
}

require_context() {
  [[ "$CONTEXT" == "kind-ptr-k8s" ]] || die "refusing context=$CONTEXT; expected kind-ptr-k8s"
  local current
  current="$(run 20s kubectl config current-context)"
  [[ "$current" == "$CONTEXT" ]] || die "kubectl current-context is $current, expected $CONTEXT"
}

run() {
  local limit="$1"
  shift
  timeout "$limit" "$@"
}

json_escape() {
  python3 - "$1" <<'PY'
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

init_reports() {
  mkdir -p "$REPORT_DIR"
  chmod 700 "$REPORT_DIR"
  if [[ ! -f "$PRIVATE_REPORT" ]]; then
    {
      printf '# K8s acceptance private evidence\n\n'
      printf 'run_id=%s\n\n' "$RUN_ID"
    } >"$PRIVATE_REPORT"
    chmod 600 "$PRIVATE_REPORT"
  fi
  if [[ ! -f "$SUMMARY" ]]; then
    {
      printf '# K8s Acceptance Summary\n\n'
      printf '| Test | Status | Numbers |\n'
      printf '|---|---|---|\n'
    } >"$SUMMARY"
  fi
  chmod 600 "$SUMMARY"
}

record_private() {
  local test="$1"
  local path="$2"
  {
    printf '\n## %s %s\n\n' "$test" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    sed -E \
      -e 's/(Bearer )[A-Za-z0-9._~+\/=-]+/\1[redacted]/g' \
      -e 's/(token[=:] ?)[A-Za-z0-9._~+\/=-]+/\1[redacted]/Ig' \
      -e 's/(password[=:] ?)[^[:space:]]+/\1[redacted]/Ig' \
      "$path"
    printf '\n'
  } >>"$PRIVATE_REPORT"
}

write_summary_row() {
  local test="$1"
  local status="$2"
  local numbers="$3"
  numbers="$(printf '%s\n' "$numbers" | grep -oE '[A-Za-z_][A-Za-z_0-9]*=[0-9]+([.][0-9]+)?([/][0-9]+)?' | paste -sd ' ' - || true)"
  numbers="${numbers:-0/1}"
  python3 - "$SUMMARY" "$test" "$status" "$numbers" <<'PY'
from pathlib import Path
import os
import re
import tempfile
import sys

path = Path(sys.argv[1])
test, status, numbers = sys.argv[2:]
lines = path.read_text().splitlines(keepends=True)
header = next((i for i, line in enumerate(lines) if line.startswith("| Test | Status |")), None)
if header is None:
    raise SystemExit("acceptance summary table missing")
end = header + 2
while end < len(lines) and re.match(r"^\| V[0-9]+(?:NEG)? \|", lines[end]):
    end += 1
row = f"| {test} | {status} | {numbers} | {'—' if status == 'PASS' else 'See private evidence.'} |\n"
existing = next((i for i in range(header + 2, end) if lines[i].startswith(f"| {test} |")), None)
if existing is None:
    lines.insert(end, row)
else:
    lines[existing] = row
with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False) as stream:
    stream.writelines(lines)
    temporary = Path(stream.name)
os.chmod(temporary, path.stat().st_mode & 0o777)
temporary.replace(path)
PY
}

result() {
  local test="$1"
  local status="$2"
  local numbers="$3"
  local evidence="$4"
  write_summary_row "$test" "$status" "$numbers"
  printf 'RESULT test=%s status=%s numbers=%s evidence=%s\n' "$test" "$status" "$(json_escape "$numbers")" "$(json_escape "$evidence")"
  [[ "$status" == PASS ]]
}

run_capture() {
  local limit="$1"
  local out="$2"
  shift 2
  set +e
  run "$limit" "$@" >"$out" 2>&1
  local rc="$?"
  set -e
  return "$rc"
}

helper_test() {
  local test="$1" description="$2" limit="$3"
  shift 3
  local out="$REPORT_DIR/${test}-${RUN_ID}.private.log" rc=0 numbers
  run_capture "$limit" "$out" "$@" || rc=$?
  record_private "$test" "$out"
  numbers="$(grep -oE '[A-Za-z_][A-Za-z_0-9]*=[0-9]+([.][0-9]+)?' "$out" | paste -sd ' ' - || true)"
  if [[ "$test" == V8 ]]; then
    if (( rc == 0 )) && grep -q '^RESULT test=V8A status=PASS ' "$out" &&
       grep -q '^RESULT test=V8B status=PASS ' "$out"; then
      result "$test" PASS "${numbers:-0/1} helper_exit=0" "$out"
    else
      result "$test" FAIL "${numbers:-0/1} helper_exit=$rc" "$out"
    fi
  elif (( rc == 0 )) && grep -q "^RESULT test=$test status=PASS " "$out"; then
    result "$test" PASS "${numbers:-0/1} helper_exit=0" "$out"
  else
    result "$test" FAIL "${numbers:-0/1} helper_exit=$rc" "$out"
  fi
}

unsupported() {
  local test="$1"
  local reason="$2"
  local out="$REPORT_DIR/${test}-${RUN_ID}.private.log"
  printf 'reason=%s\n' "$reason" >"$out"
  chmod 600 "$out"
  record_private "$test" "$out"
  result "$test" FAIL "reason=UNSUPPORTED_HARNESS_GAP detail=$reason" "$out"
}

engine_min() {
  run 20s kubectl --context "$CONTEXT" -n ptr-inference get scaledobject ptr-sim -o jsonpath='{.spec.minReplicaCount}'
}

pin_engine_min_two() {
  local out="$1"
  ENGINE_MIN_ORIGINAL="$(engine_min)"
  printf 'engine_min_original=%s\n' "${ENGINE_MIN_ORIGINAL:-unset}" >>"$out"
  run 30s kubectl --context "$CONTEXT" -n ptr-inference patch scaledobject ptr-sim --type merge -p '{"spec":{"minReplicaCount":2}}' >>"$out" 2>&1
  run 180s kubectl --context "$CONTEXT" -n ptr-inference rollout status deployment/ptr-sim >>"$out" 2>&1
  run 120s kubectl --context "$CONTEXT" -n ptr-inference wait --for=condition=Ready pod -l app.kubernetes.io/component=inference-engine --timeout=120s >>"$out" 2>&1
  printf 'engine_min_pinned=%s\n' "$(engine_min)" >>"$out"
}

restore_engine_min() {
  local out="$1"
  if [[ -n "${ENGINE_MIN_ORIGINAL:-}" ]]; then
    run 30s kubectl --context "$CONTEXT" -n ptr-inference patch scaledobject ptr-sim --type merge -p "{\"spec\":{\"minReplicaCount\":$ENGINE_MIN_ORIGINAL}}" >>"$out" 2>&1 || true
    run 180s kubectl --context "$CONTEXT" -n ptr-inference rollout status deployment/ptr-sim >>"$out" 2>&1 || true
    printf 'engine_min_restored=%s\n' "$(engine_min 2>/dev/null || printf unknown)" >>"$out"
  fi
}

restore_engine_on_exit() {
  if [[ -n "${ENGINE_MIN_ORIGINAL:-}" && -n "${ENGINE_RESTORE_OUT:-}" ]]; then
    restore_engine_min "$ENGINE_RESTORE_OUT"
    ENGINE_MIN_ORIGINAL=""
  fi
}

python_from_log() {
  local code="$1"
  local log="$2"
  python3 - "$log" <<PY
import json, re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8", errors="replace").read()
$code
PY
}

v1() {
  helper_test V1 "deploy/kind/acceptance-recovery.sh" "$DEFAULT_TIMEOUT" bash deploy/kind/acceptance-recovery.sh V1
}

v2() {
  helper_test V2 "deploy/kind/acceptance-recovery.sh" "$DEFAULT_TIMEOUT" bash deploy/kind/acceptance-recovery.sh V2
}

v3() {
  helper_test V3 "deploy/kind/acceptance-recovery.sh" "$DEFAULT_TIMEOUT" bash deploy/kind/acceptance-recovery.sh V3
}

v4() {
  helper_test V4 "deploy/kind/acceptance-recovery.sh" "$DEFAULT_TIMEOUT" bash deploy/kind/acceptance-recovery.sh V4
}

v5() {
  local out="$REPORT_DIR/V5-${RUN_ID}.private.log"
  local rc=0
  local numbers
  ENGINE_MIN_ORIGINAL=""
  ENGINE_RESTORE_OUT="$out"
  trap restore_engine_on_exit EXIT
  printf 'test=V5\nhelper=deploy/kind/k5-worker-load.sh\nstarted=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$out"
  pin_engine_min_two "$out" || rc=1
  if (( rc == 0 )); then
    run_capture "$DEFAULT_TIMEOUT" "$out.tmp" env KUBE_CONTEXT="$CONTEXT" TURN_COUNT="${TURN_COUNT:-200}" SUBMIT_CONCURRENCY="${SUBMIT_CONCURRENCY:-80}" deploy/kind/k5-worker-load.sh || rc=$?
    cat "$out.tmp" >>"$out" || true
    rm -f "$out.tmp"
  fi
  restore_engine_on_exit
  trap - EXIT
  local parsed=0
  set +e
  numbers="$(python_from_log '
events = [json.loads(line) for line in text.splitlines() if line.startswith("{")]
result = next((e for e in events if e.get("event") == "result"), {})
host = next((e for e in events if e.get("event") == "host_summary"), {})
parts = {
    "expected": result.get("expected", "unknown"),
    "terminal": result.get("terminal", "unknown"),
    "completed": result.get("completed", "unknown"),
    "failed": result.get("failed", "unknown"),
    "outbox": result.get("outbox", "unknown"),
    "duplicates": result.get("duplicateCompletionRows", "unknown"),
    "desiredStart": host.get("desiredStart", "unknown"),
    "readyStart": host.get("readyStart", "unknown"),
    "desiredPeak60": host.get("desiredPeakWithin60sAfterSubmit", "unknown"),
    "readyPeak60": host.get("readyPeakWithin60sAfterSubmit", "unknown"),
    "expectedWorkerCap": host.get("expectedWorkerCap", "unknown"),
    "workerCapObserved": host.get("workerCapObserved", "unknown"),
    "workerCapReached": host.get("workerCapReached", "unknown"),
    "desiredFinal": host.get("desiredFinal", "unknown"),
    "readyFinal": host.get("readyFinal", "unknown"),
    "activeHold": host.get("activeHoldPassed", "unknown"),
    "terminalProof": host.get("terminalProofPassed", "unknown"),
}
print(" ".join(f"{k}={v}" for k, v in parts.items()))
expected = int(result.get("expected") or 0)
passed = (
    expected == 200
    and int(result.get("observed") or 0) == 200
    and int(result.get("terminal") or 0) == 200
    and int(result.get("outbox", -1)) == 0
    and int(result.get("duplicateCompletionRows", -1)) == 0
    and int(host.get("desiredStart") or 0) == 2
    and int(host.get("readyStart") or 0) == 2
    and host.get("expectedWorkerCap") == 3
    and host.get("workerCapObserved") is True
    and host.get("workerCapReached") is True
    and int(host.get("desiredFinal") or 0) == 2
    and int(host.get("readyFinal") or 0) == 2
    and host.get("activeHoldPassed") is True
    and host.get("terminalProofPassed") is True
)
raise SystemExit(0 if passed else 1)
' "$out" 2>/dev/null)"
  parsed=$?
  set -e
  record_private V5 "$out"
  if (( rc == 0 && parsed == 0 )); then
    result V5 PASS "$numbers" "$out"
  else
    result V5 FAIL "${numbers:-parse_failed=1} helper_exit=$rc" "$out"
  fi
}

v6() {
  local out="$REPORT_DIR/V6-${RUN_ID}.private.log"
  local before="$REPORT_DIR/V6-${RUN_ID}-before.private.json"
  local after="$REPORT_DIR/V6-${RUN_ID}-after.private.json"
  local holder_manifest="$REPORT_DIR/V6-${RUN_ID}-gpu-holder.private.yaml"
  local rc=0 numbers=""
  V6_GPU_HOLDER=""
  V6_HOLDER_MANIFEST="$holder_manifest"
  ENGINE_MIN_ORIGINAL="$(engine_min)"
  V6_OUT="$out"
  trap restore_v6_settings EXIT
  printf 'test=V6\nengine_min_original=%s\n' "$ENGINE_MIN_ORIGINAL" >"$out"
  run 30s kubectl --context "$CONTEXT" -n ptr-inference patch scaledobject ptr-sim --type merge -p '{"spec":{"minReplicaCount":1}}' >>"$out" 2>&1
  for _ in $(seq 1 24); do
    [[ "$(run 15s kubectl --context "$CONTEXT" -n ptr-inference get deployment ptr-sim -o jsonpath='{.status.readyReplicas}')" == 1 ]] && break
    run 6s sleep 5
  done
  local baseline_node holder_node holder_image
  baseline_node="$(run 20s kubectl --context "$CONTEXT" -n ptr-inference get pod -l app.kubernetes.io/component=inference-engine -o jsonpath='{.items[0].spec.nodeName}')"
  holder_node="$(run 20s kubectl --context "$CONTEXT" get nodes -l ptr.io/fake-gpu=true -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | awk -v baseline="$baseline_node" '$0 != baseline {print; exit}')"
  if [[ -z "$holder_node" ]]; then
    printf 'v6_gpu_holder_error=no_nonbaseline_fake_gpu_node baseline_node=%s\n' "$baseline_node" >>"$out"
    rc=1
  else
    holder_image="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get deployment ptr-api -o jsonpath='{.spec.template.spec.containers[0].image}')"
    V6_GPU_HOLDER="ptr-v6-gpu-holder-${RUN_ID,,}"
    cat >"$holder_manifest" <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${V6_GPU_HOLDER}
  namespace: ptr-inference
  labels:
    app.kubernetes.io/name: ptr
    app.kubernetes.io/component: v6-gpu-holder
    ptr.io/k8s-acceptance: "v6"
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  nodeName: ${holder_node}
  nodeSelector:
    ptr.io/fake-gpu: "true"
  tolerations:
    - {key: nvidia.com/gpu, operator: Exists, effect: NoSchedule}
  securityContext:
    runAsNonRoot: true
    runAsUser: 900
    runAsGroup: 2000
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: holder
      image: ${holder_image}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ec", "sleep 600"]
      resources:
        requests:
          nvidia.com/gpu: "1"
        limits:
          nvidia.com/gpu: "1"
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        capabilities: {drop: ["ALL"]}
YAML
    chmod 600 "$holder_manifest"
    printf 'v6_gpu_holder=%s baseline_node=%s holder_node=%s\n' "$V6_GPU_HOLDER" "$baseline_node" "$holder_node" >>"$out"
    run 30s kubectl --context "$CONTEXT" apply -f "$holder_manifest" >>"$out" 2>&1 || rc=1
    run 120s kubectl --context "$CONTEXT" -n ptr-inference wait --for=condition=Ready "pod/$V6_GPU_HOLDER" --timeout=120s >>"$out" 2>&1 || rc=1
    run 20s kubectl --context "$CONTEXT" -n ptr-inference get pod "$V6_GPU_HOLDER" -o wide >>"$out" 2>&1 || true
  fi
  run 20s kubectl --context "$CONTEXT" -n ptr-inference get pods -l app.kubernetes.io/component=inference-engine -o json >"$before"
  chmod 600 "$before"
  if (( rc == 0 )); then
    run_capture 180s "$out.load" env LOAD_SECONDS=90 LOAD_CONCURRENCY=24 bash deploy/kind/k5-engine-load.sh || rc=$?
  else
    printf 'engine_load_skipped=1\n' >"$out.load"
    chmod 600 "$out.load"
  fi
  for _ in $(seq 1 36); do
    local desired ready
    desired="$(run 15s kubectl --context "$CONTEXT" -n ptr-inference get deployment ptr-sim -o jsonpath='{.spec.replicas}' || printf 0)"
    ready="$(run 15s kubectl --context "$CONTEXT" -n ptr-inference get deployment ptr-sim -o jsonpath='{.status.readyReplicas}' || printf 0)"
    printf 'post_load_sample desired=%s ready=%s\n' "${desired:-0}" "${ready:-0}" >>"$out"
    [[ "${desired:-0}" -ge 2 ]] && break
    run 6s sleep 5
  done
  run 20s kubectl --context "$CONTEXT" -n ptr-inference get pods -l app.kubernetes.io/component=inference-engine -o json >"$after"
  chmod 600 "$after"
  if (( rc == 0 )); then
    run_capture 60s "$out.probe" env LOAD_SECONDS=12 LOAD_CONCURRENCY=1 bash deploy/kind/k5-engine-load.sh || rc=$?
  else
    printf 'post_pending_probe_skipped=1\n' >"$out.probe"
    chmod 600 "$out.probe"
  fi
  cat "$out.load" >>"$out"
  printf '\npost_pending_probe:\n' >>"$out"
  cat "$out.probe" >>"$out"
  local parsed=0
  set +e
  numbers="$(python3 - "$before" "$after" "$out.load" "$out.probe" <<'PY'
import json, re, sys
before = json.load(open(sys.argv[1]))
after = json.load(open(sys.argv[2]))
load = open(sys.argv[3], encoding="utf-8", errors="replace").read()
probe = open(sys.argv[4], encoding="utf-8", errors="replace").read()
def pod_rows(doc):
    rows = []
    for item in doc.get("items", []):
        statuses = item.get("status", {}).get("containerStatuses") or []
        restarts = sum(int(s.get("restartCount") or 0) for s in statuses)
        ready = bool(statuses) and all(bool(s.get("ready")) for s in statuses)
        rows.append({
            "name": item["metadata"]["name"],
            "phase": item.get("status", {}).get("phase", "Unknown"),
            "ready": ready,
            "restarts": restarts,
        })
    return rows
before_rows, after_rows = pod_rows(before), pod_rows(after)
before_by_name = {row["name"]: row for row in before_rows}
after_by_name = {row["name"]: row for row in after_rows}
original_after = [after_by_name[name] for name in before_by_name if name in after_by_name]
new_after = [row for row in after_rows if row["name"] not in before_by_name]
ready_before = sum(row["ready"] for row in before_rows)
ready_after = sum(row["ready"] for row in after_rows)
pending_after = sum(row["phase"] == "Pending" for row in after_rows)
restart_delta = sum(max(0, row["restarts"] - before_by_name.get(row["name"], {"restarts": row["restarts"]})["restarts"]) for row in after_rows if row["name"] in before_by_name)
desired_after = len(after_rows)
original_ready_after = sum(row["ready"] for row in original_after)
new_pending_after = sum(row["phase"] == "Pending" for row in new_after)
def engine_load_counts(text):
    counts = {}
    for line in text.splitlines():
        if line.startswith("{"):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("event") == "engine_load":
                counts = event.get("counts") or {}
    return counts
load_counts = engine_load_counts(load)
probe_counts = engine_load_counts(probe)
probe_successes = sum(int(value) for key, value in probe_counts.items() if str(key).startswith("2"))
probe_transport_errors = sum(int(value) for key, value in probe_counts.items() if "error" in str(key).lower() or "timeout" in str(key).lower())
successes = sum(int(value) for key, value in load_counts.items() if str(key).startswith("2"))
transport_errors = sum(int(value) for key, value in load_counts.items() if "error" in str(key).lower() or "timeout" in str(key).lower())
clauses = {
    "scale_1_to_2": ready_before == 1 and desired_after >= 2,
    "exactly_one_extra_pending": len(new_after) == 1 and new_pending_after == 1,
    "original_pods_unaffected": original_ready_after == ready_before and restart_delta == 0,
    "client_requests_succeed_after_pending": probe_successes >= 1 and probe_transport_errors == 0,
}
missing = [key for key, ok in clauses.items() if not ok]
print(
    f"ready_before={ready_before} desired_after={desired_after} ready_after={ready_after} "
    f"pending_after={pending_after} new_pending_after={new_pending_after} "
    f"original_ready_after={original_ready_after} restart_delta={restart_delta} successes={successes} "
    f"transport_errors={transport_errors} probe_successes={probe_successes} "
    f"probe_transport_errors={probe_transport_errors} missing={','.join(missing) if missing else 'none'}"
)
raise SystemExit(0 if not missing else 1)
PY
)"
  parsed=$?
  set -e
  record_private V6 "$out"
  restore_v6_settings
  trap - EXIT
  if (( rc == 0 && parsed == 0 )); then
    result V6 PASS "$numbers load_exit=0" "$out"
  else
    result V6 FAIL "${numbers:-parse_failed=1} load_exit=$rc" "$out"
  fi
}

restore_v6_settings() {
  if [[ -n "${V6_GPU_HOLDER:-}" ]]; then
    run 30s kubectl --context "$CONTEXT" -n ptr-inference delete pod "$V6_GPU_HOLDER" --ignore-not-found --wait=false >>"$V6_OUT" 2>&1 || true
    V6_GPU_HOLDER=""
  fi
  if [[ -n "${V6_HOLDER_MANIFEST:-}" ]]; then
    rm -f "$V6_HOLDER_MANIFEST"
    V6_HOLDER_MANIFEST=""
  fi
  if [[ -n "${ENGINE_MIN_ORIGINAL:-}" ]]; then
    restore_engine_min "$V6_OUT"
    ENGINE_MIN_ORIGINAL=""
  fi
}

v7_delete_fault_pods() {
  if [[ -n "${V7_FAULT_PODS:-}" ]]; then
    for pod in $V7_FAULT_PODS; do
      run 30s kubectl --context "$CONTEXT" -n ptr-inference delete pod "$pod" --ignore-not-found --wait=false >>"$V7_OUT" 2>&1 || true
    done
    V7_FAULT_PODS=""
  fi
  if [[ -n "${V7_APP_FAULT_SERVICES:-}" ]]; then
    for service in $V7_APP_FAULT_SERVICES; do
      run 30s kubectl --context "$CONTEXT" -n ptr-app delete service "$service" --ignore-not-found --wait=false >>"$V7_OUT" 2>&1 || true
    done
    V7_APP_FAULT_SERVICES=""
  fi
  if [[ -n "${V7_APP_FAULT_PODS:-}" ]]; then
    for pod in $V7_APP_FAULT_PODS; do
      run 30s kubectl --context "$CONTEXT" -n ptr-app delete pod "$pod" --ignore-not-found --wait=false >>"$V7_OUT" 2>&1 || true
    done
    V7_APP_FAULT_PODS=""
  fi
  if [[ "${V7_APP_FAULT_POLICIES:-0}" == "1" ]]; then
    run 30s kubectl --context "$CONTEXT" -n ptr-app delete networkpolicy ptr-v7-worker-fault-egress ptr-v7-worker-fault-ingress --ignore-not-found --wait=false >>"$V7_OUT" 2>&1 || true
    V7_APP_FAULT_POLICIES=0
  fi
}

v7_apply_fault_engine() {
  local pod="$1" model="$2" mode="$3" image="$4" out="$5"
  V7_FAULT_PODS="${V7_FAULT_PODS:-} $pod"
  run 30s kubectl --context "$CONTEXT" -n ptr-inference apply -f - >>"$out" 2>&1 <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${pod}
  namespace: ptr-inference
  labels:
    app.kubernetes.io/name: ptr
    app.kubernetes.io/component: inference-engine
    pool: chat-primary
    llm-d.ai/model: ${model}
    ptr.io/v7-fault-engine: "true"
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  nodeSelector:
    ptr.io/fake-gpu: "true"
  tolerations:
    - {key: nvidia.com/gpu, operator: Exists, effect: NoSchedule}
  containers:
    - name: fault-engine
      image: ${image}
      imagePullPolicy: IfNotPresent
      command: ["python", "-c"]
      args:
        - |
          import json, os, socket, threading
          from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
          mode = os.environ["PTR_V7_FAULT_MODE"]
          lock = threading.Lock()
          requests = {}
          marker_requests = {}
          counts = {"submitted": 0, "json_5xx": 0, "resets": 0, "headerless_503": 0, "hold_timeout": 0, "active": 0, "max_active": 0}
          ThreadingHTTPServer.daemon_threads = True
          class Handler(BaseHTTPRequestHandler):
              def log_message(self, *args):
                  pass
              def _json(self, status, payload):
                  data = json.dumps(payload, separators=(",", ":")).encode()
                  self.send_response(status)
                  self.send_header("content-type", "application/json")
                  self.send_header("content-length", str(len(data)))
                  self.end_headers()
                  self.wfile.write(data)
              def do_GET(self):
                  if self.path == "/health":
                      return self._json(200, {"status":"synthetic"})
                  if self.path == "/counts":
                      with lock:
                          snapshot = dict(counts)
                          snapshot["request_ids"] = sorted(requests)
                          snapshot["duplicates"] = {key:value for key,value in requests.items() if value > 1}
                          snapshot["marker_request_ids"] = {key: sorted(value) for key, value in marker_requests.items()}
                          snapshot["marker_counts"] = {key: len(value) for key, value in marker_requests.items()}
                      return self._json(200, snapshot)
                  return self._json(404, {"error":"not_found"})
              def do_POST(self):
                  length = int(self.headers.get("content-length", "0"))
                  body = self.rfile.read(length) if length > 0 else b""
                  request_id = self.headers.get("x-request-id") or "missing"
                  marker = "missing"
                  try:
                      payload = json.loads(body.decode("utf-8", "replace") or "{}")
                      for message in payload.get("messages", []):
                          content = str(message.get("content", ""))
                          if "K4_ID:" in content:
                              marker = content.split("K4_ID:", 1)[1].split()[0]
                              break
                  except Exception:
                      pass
                  with lock:
                      requests[request_id] = requests.get(request_id, 0) + 1
                      marker_requests.setdefault(marker, []).append(request_id)
                      counts["submitted"] += 1
                      counts["active"] += 1
                      counts["max_active"] = max(counts["max_active"], counts["active"])
                  try:
                      if mode == "json_5xx":
                          with lock:
                              counts["json_5xx"] += 1
                          return self._json(503, {"error":{"type":"synthetic_5xx"}})
                      if mode == "forged_drop_header_5xx":
                          with lock:
                              counts["json_5xx"] += 1
                          data = json.dumps({"error":{"type":"synthetic_forged_drop_header"}}, separators=(",", ":")).encode()
                          self.send_response(500)
                          self.send_header("content-type", "application/json")
                          self.send_header("x-llm-d-request-dropped-reason", "rejected-saturated")
                          self.send_header("content-length", str(len(data)))
                          self.end_headers()
                          self.wfile.write(data)
                          return
                      if mode == "headerless_503":
                          with lock:
                              counts["headerless_503"] += 1
                          self.send_response_only(503)
                          self.end_headers()
                          return
                      if mode == "hold_timeout":
                          with lock:
                              counts["hold_timeout"] += 1
                          threading.Event().wait(20)
                          return self._json(504, {"error":{"type":"synthetic_hold_timeout"}})
                      if mode == "reset":
                          with lock:
                              counts["resets"] += 1
                          if "hold" in marker:
                              # Keep one upstream request open while sibling calls exercise the EPP queue/rejection path.
                              threading.Event().wait(20)
                          try:
                              self.connection.shutdown(socket.SHUT_RDWR)
                          except OSError:
                              pass
                          self.connection.close()
                          return
                      return self._json(500, {"error":"unknown_fault_mode"})
                  finally:
                      with lock:
                          counts["active"] -= 1
          ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
      env:
        - {name: PTR_V7_FAULT_MODE, value: "${mode}"}
      ports:
        - {name: http, containerPort: 8000}
      readinessProbe:
        httpGet: {path: /health, port: http}
        periodSeconds: 1
        timeoutSeconds: 1
        failureThreshold: 2
      resources:
        requests: {cpu: 50m, memory: 96Mi}
        limits: {cpu: 500m, memory: 256Mi}
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: ["ALL"]}
YAML
  run 90s kubectl --context "$CONTEXT" -n ptr-inference wait --for=condition=Ready "pod/$pod" --timeout=90s >>"$out" 2>&1
}

v7_fault_engine_counts() {
  local pod="$1"
  run 20s kubectl --context "$CONTEXT" -n ptr-inference exec "$pod" -- python -c 'import json,urllib.request; print(json.dumps(json.load(urllib.request.urlopen("http://127.0.0.1:8000/counts", timeout=5)), sort_keys=True))'
}

v7_fault_engine_submissions() {
  local pod="$1"
  v7_fault_engine_counts "$pod" | python3 -c 'import json,sys; print(int(json.load(sys.stdin).get("submitted") or 0))'
}

v7_app_fault_counts() {
  local pod="$1"
  run 20s kubectl --context "$CONTEXT" -n ptr-app exec "$pod" -- python -c 'import json,urllib.request; print(json.dumps(json.load(urllib.request.urlopen("http://127.0.0.1:8000/counts", timeout=5)), sort_keys=True))'
}

v7_app_fault_submissions() {
  local pod="$1"
  v7_app_fault_counts "$pod" | python3 -c 'import json,sys; print(int(json.load(sys.stdin).get("submitted") or 0))'
}

v7_apply_app_fault_origin() {
  local pod="$1" service="$2" mode="$3" image="$4" out="$5"
  V7_APP_FAULT_PODS="${V7_APP_FAULT_PODS:-} $pod"
  V7_APP_FAULT_SERVICES="${V7_APP_FAULT_SERVICES:-} $service"
  run 30s kubectl --context "$CONTEXT" -n ptr-app apply -f - >>"$out" 2>&1 <<YAML
apiVersion: v1
kind: Service
metadata:
  name: ${service}
  namespace: ptr-app
spec:
  selector:
    ptr.io/v7-app-fault: ${pod}
  ports:
    - name: http
      port: 8000
      targetPort: http
---
apiVersion: v1
kind: Pod
metadata:
  name: ${pod}
  namespace: ptr-app
  labels:
    app.kubernetes.io/name: ptr
    ptr.io/v7-app-fault: ${pod}
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  containers:
    - name: fault-origin
      image: ${image}
      imagePullPolicy: IfNotPresent
      command: ["python", "-c"]
      args:
        - |
          import json, os, socket, threading
          from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
          mode = os.environ["PTR_V7_FAULT_MODE"]
          lock = threading.Lock()
          counts = {"submitted": 0, "json_5xx": 0, "resets": 0, "headerless_503": 0, "hold_timeout": 0}
          ThreadingHTTPServer.daemon_threads = True
          class Handler(BaseHTTPRequestHandler):
              def log_message(self, *args):
                  pass
              def _json(self, status, payload, headers=None):
                  data = json.dumps(payload, separators=(",", ":")).encode()
                  self.send_response(status)
                  self.send_header("content-type", "application/json")
                  for key, value in (headers or {}).items():
                      self.send_header(key, value)
                  self.send_header("content-length", str(len(data)))
                  self.end_headers()
                  self.wfile.write(data)
              def do_GET(self):
                  if self.path == "/health":
                      return self._json(200, {"status":"synthetic"})
                  if self.path == "/counts":
                      with lock:
                          snapshot = dict(counts)
                      return self._json(200, snapshot)
                  return self._json(404, {"error":"not_found"})
              def do_POST(self):
                  length = int(self.headers.get("content-length", "0"))
                  if length:
                      self.rfile.read(length)
                  with lock:
                      counts["submitted"] += 1
                  if mode == "forged_drop_header_5xx":
                      with lock:
                          counts["json_5xx"] += 1
                      return self._json(500, {"error":{"type":"synthetic_forged_drop_header"}}, {"x-llm-d-request-dropped-reason":"rejected-saturated"})
                  if mode == "json_5xx":
                      with lock:
                          counts["json_5xx"] += 1
                      return self._json(503, {"error":{"type":"synthetic_5xx"}})
                  if mode == "headerless_503":
                      with lock:
                          counts["headerless_503"] += 1
                      self.send_response_only(503)
                      self.end_headers()
                      return
                  if mode == "hold_timeout":
                      with lock:
                          counts["hold_timeout"] += 1
                      threading.Event().wait(20)
                      return self._json(504, {"error":{"type":"synthetic_hold_timeout"}})
                  if mode == "reset":
                      with lock:
                          counts["resets"] += 1
                      try:
                          self.connection.shutdown(socket.SHUT_RDWR)
                      except OSError:
                          pass
                      self.connection.close()
                      return
                  return self._json(500, {"error":"unknown_fault_mode"})
          ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
      env:
        - {name: PTR_V7_FAULT_MODE, value: "${mode}"}
      ports:
        - {name: http, containerPort: 8000}
      readinessProbe:
        httpGet: {path: /health, port: http}
        periodSeconds: 1
        timeoutSeconds: 1
        failureThreshold: 2
      resources:
        requests: {cpu: 50m, memory: 96Mi}
        limits: {cpu: 500m, memory: 256Mi}
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: ["ALL"]}
YAML
  run 90s kubectl --context "$CONTEXT" -n ptr-app wait --for=condition=Ready "pod/$pod" --timeout=90s >>"$out" 2>&1
}

v7_worker_env_value() {
  local name="$1"
  run 20s kubectl --context "$CONTEXT" -n ptr-app get deployment ptr-worker -o json |
    python3 -c '
import json, sys
name = sys.argv[1]
doc = json.load(sys.stdin)
for container in doc["spec"]["template"]["spec"]["containers"]:
    if container["name"] != "worker":
        continue
    for item in container.get("env", []):
        if item.get("name") == name:
            print(item.get("value", ""))
            raise SystemExit(0)
print("")
' "$name"
}

v7_restore_worker_env() {
  if [[ "${V7_WORKER_ENV_PATCHED:-0}" != "1" ]]; then
    return
  fi
  if [[ "${V7_WORKER_MODEL_WAS_SET:-0}" == "1" ]]; then
    run 60s kubectl --context "$CONTEXT" -n ptr-app set env deployment/ptr-worker "PTR_LLM_LOCAL_MODEL=$V7_WORKER_MODEL_ORIGINAL" >>"$V7_OUT" 2>&1 || true
  else
    run 60s kubectl --context "$CONTEXT" -n ptr-app set env deployment/ptr-worker PTR_LLM_LOCAL_MODEL- >>"$V7_OUT" 2>&1 || true
  fi
  if [[ "${V7_WORKER_BASE_URL_WAS_SET:-0}" == "1" ]]; then
    run 60s kubectl --context "$CONTEXT" -n ptr-app set env deployment/ptr-worker "PTR_LLM_LOCAL_BASE_URL=$V7_WORKER_BASE_URL_ORIGINAL" >>"$V7_OUT" 2>&1 || true
  else
    run 60s kubectl --context "$CONTEXT" -n ptr-app set env deployment/ptr-worker PTR_LLM_LOCAL_BASE_URL- >>"$V7_OUT" 2>&1 || true
  fi
  if [[ "${V7_WORKER_TIMEOUT_WAS_SET:-0}" == "1" ]]; then
    run 60s kubectl --context "$CONTEXT" -n ptr-app set env deployment/ptr-worker "PTR_LLM_MODEL_TIMEOUT_MS=$V7_WORKER_TIMEOUT_ORIGINAL" >>"$V7_OUT" 2>&1 || true
  else
    run 60s kubectl --context "$CONTEXT" -n ptr-app set env deployment/ptr-worker PTR_LLM_MODEL_TIMEOUT_MS- >>"$V7_OUT" 2>&1 || true
  fi
  run 180s kubectl --context "$CONTEXT" -n ptr-app rollout status deployment/ptr-worker >>"$V7_OUT" 2>&1 || true
  V7_WORKER_ENV_PATCHED=0
}

v7_worker_fault_probes() {
  local out="$1" prefix="$2"
  local api_pod fake_pod worker_pod worker_image original_model original_base_url original_timeout app_forged app_fail app_headerless app_reset app_timeout svc_forged svc_fail svc_headerless svc_reset svc_timeout short before_ts
  api_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=api -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}')"
  fake_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=fake-openrouter -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}')"
  worker_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=worker -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}')"
  if [[ -z "$api_pod" || -z "$fake_pod" || -z "$worker_pod" ]]; then
    printf 'worker_fault_setup=missing_pod api=%s fake=%s worker=%s\n' "$api_pod" "$fake_pod" "$worker_pod" >>"$out"
    return
  fi
  before_ts="$(run 30s kubectl --context "$CONTEXT" -n ptr-app exec "$worker_pod" -- python -c 'import os,psycopg; c=psycopg.connect(os.environ["PTR_LLM_DATABASE_URL"]); print(c.execute("SELECT now()").fetchone()[0]); c.close()')"
  original_model="$(v7_worker_env_value PTR_LLM_LOCAL_MODEL)"
  original_base_url="$(v7_worker_env_value PTR_LLM_LOCAL_BASE_URL)"
  original_timeout="$(v7_worker_env_value PTR_LLM_MODEL_TIMEOUT_MS)"
  V7_WORKER_MODEL_ORIGINAL="$original_model"
  V7_WORKER_BASE_URL_ORIGINAL="$original_base_url"
  V7_WORKER_TIMEOUT_ORIGINAL="$original_timeout"
  [[ -n "$original_model" ]] && V7_WORKER_MODEL_WAS_SET=1 || V7_WORKER_MODEL_WAS_SET=0
  [[ -n "$original_base_url" ]] && V7_WORKER_BASE_URL_WAS_SET=1 || V7_WORKER_BASE_URL_WAS_SET=0
  [[ -n "$original_timeout" ]] && V7_WORKER_TIMEOUT_WAS_SET=1 || V7_WORKER_TIMEOUT_WAS_SET=0
  V7_WORKER_ENV_PATCHED=1
  printf 'worker_fault_probe_prefix=%s\n' "$prefix" >>"$out"
  V7_APP_FAULT_POLICIES=1
  run 30s kubectl --context "$CONTEXT" -n ptr-app apply -f - >>"$out" 2>&1 <<'YAML'
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ptr-v7-worker-fault-egress
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: worker
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchExpressions:
              - key: ptr.io/v7-app-fault
                operator: Exists
      ports:
        - {protocol: TCP, port: 8000}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ptr-v7-worker-fault-ingress
spec:
  podSelector:
    matchExpressions:
      - key: ptr.io/v7-app-fault
        operator: Exists
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              app.kubernetes.io/component: worker
      ports:
        - {protocol: TCP, port: 8000}
YAML
  short="${prefix#v7-fault-}"
  app_forged="ptr-v7w-forged-$short"
  app_fail="ptr-v7w-5xx-$short"
  app_headerless="ptr-v7w-headerless-$short"
  app_reset="ptr-v7w-reset-$short"
  app_timeout="ptr-v7w-timeout-$short"
  svc_forged="ptr-v7w-forged-$short"
  svc_fail="ptr-v7w-5xx-$short"
  svc_headerless="ptr-v7w-headerless-$short"
  svc_reset="ptr-v7w-reset-$short"
  svc_timeout="ptr-v7w-timeout-$short"
  worker_image="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get deployment ptr-worker -o jsonpath='{.spec.template.spec.containers[0].image}')"
  v7_apply_app_fault_origin "$app_forged" "$svc_forged" forged_drop_header_5xx "$worker_image" "$out" || true
  v7_apply_app_fault_origin "$app_fail" "$svc_fail" json_5xx "$worker_image" "$out" || true
  v7_apply_app_fault_origin "$app_headerless" "$svc_headerless" headerless_503 "$worker_image" "$out" || true
  v7_apply_app_fault_origin "$app_reset" "$svc_reset" reset "$worker_image" "$out" || true
  v7_apply_app_fault_origin "$app_timeout" "$svc_timeout" hold_timeout "$worker_image" "$out" || true

  local cases=(
    "forged_drop_header synthetic-v7-local 30000 $app_forged $svc_forged"
    "engine_5xx synthetic-v7-local 30000 $app_fail $svc_fail"
    "headerless_503 synthetic-v7-local 30000 $app_headerless $svc_headerless"
    "upstream_reset synthetic-v7-local 30000 $app_reset $svc_reset"
    "timeout synthetic-v7-local 1500 $app_timeout $svc_timeout"
  )
  local item name model timeout_ms target_pod target_service before_count after_count reached
  for item in "${cases[@]}"; do
    read -r name model timeout_ms target_pod target_service <<<"$item"
    run 60s kubectl --context "$CONTEXT" -n ptr-app set env deployment/ptr-worker \
      "PTR_LLM_LOCAL_MODEL=$model" \
      "PTR_LLM_LOCAL_BASE_URL=http://$target_service.ptr-app.svc.cluster.local:8000/v1" \
      "PTR_LLM_MODEL_TIMEOUT_MS=$timeout_ms" >>"$out" 2>&1
    run 180s kubectl --context "$CONTEXT" -n ptr-app rollout status deployment/ptr-worker >>"$out" 2>&1
    before_count="$(v7_app_fault_submissions "$target_pod" 2>/dev/null || printf 0)"
    api_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=api -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}')"
    run_capture 180s "$out.worker-fault-$name" kubectl --context "$CONTEXT" -n ptr-app exec "$api_pod" -- env CASE_NAME="$name" PREFIX="$prefix" node --input-type=module -e '
      const marker = `${process.env.PREFIX}-${process.env.CASE_NAME}`;
      async function request(path, body) {
        for (let attempt = 0; attempt < 3; attempt++) {
          const response = await fetch("http://127.0.0.1:56441/api/" + path, {
            method: body === undefined ? "GET" : "POST",
            headers: {
              Authorization: "Bearer " + process.env.PTR_API_SYNTHETIC_TOKEN,
              "X-PTR-Owner": "lt-k2-synthetic",
              "Content-Type": "application/json",
            },
            ...(body === undefined ? {} : {body: JSON.stringify(body)}),
          });
          if (response.ok) return response.json();
          if (attempt === 2 || ![502, 503, 504].includes(response.status)) throw new Error("HTTP_" + response.status);
          await new Promise(resolve => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
      try {
        const session = await request("sessions", {
          personId: "synthetic-split-person",
          retrievalMode: "off",
          ragCondition: "off",
          executionProfile: "agent_loop",
        });
        const turn = await request("sessions/" + session.session.id + "/turns", {
          clientRequestId: marker,
          text: JSON.stringify({
            message: "K4_ID:" + marker,
            status: "answered",
            evidenceRefs: [],
            variableUpdates: {},
          }),
        });
        let final;
        for (let attempt = 0; attempt < 240; attempt++) {
          final = (await request("turns/" + turn.turn.id)).turn;
          if (["completed", "failed", "cancelled"].includes(final.state)) break;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        console.log(`worker_fault=${process.env.CASE_NAME} client_request_id=${marker} state=${final?.state || "timeout"} errorCode=${final?.errorCode || "none"}`);
      } catch (error) {
        console.log(`worker_fault=${process.env.CASE_NAME} client_request_id=${marker} state=api_error errorCode=${error.message || error.name || "unknown"}`);
      }
    ' || true
    cat "$out.worker-fault-$name" >>"$out"
    rm -f "$out.worker-fault-$name"
    after_count="$(v7_app_fault_submissions "$target_pod" 2>/dev/null || printf 0)"
    reached=0
    if (( after_count > before_count )); then
      reached=1
    fi
    printf 'worker_fault_target=%s pod=%s before=%s after=%s reached=%s\n' "$name" "$target_pod" "$before_count" "$after_count" "$reached" >>"$out"
  done

  fake_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=fake-openrouter -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}')"
  worker_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=worker -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}')"
  run 30s kubectl --context "$CONTEXT" -n ptr-app exec "$fake_pod" -- env PREFIX="$prefix" python -c '
import json, os, urllib.request
prefix=os.environ["PREFIX"]
data=json.load(urllib.request.urlopen("http://127.0.0.1:8000/counts",timeout=5))
ids=[value for value in data["request_ids"] if value.startswith(prefix)]
dupes={key:value for key,value in data["duplicates"].items() if key.startswith(prefix)}
print("worker_fault_fake_counts " + json.dumps({"prefix":prefix,"ids":ids,"submitted_for_prefix":len(ids),"duplicates":dupes}, sort_keys=True))
' >>"$out" 2>&1 || true
  run 30s kubectl --context "$CONTEXT" -n ptr-app exec "$worker_pod" -- env BEFORE_TS="$before_ts" python -c '
import json, os, psycopg
before=os.environ["BEFORE_TS"]
with psycopg.connect(os.environ["PTR_LLM_DATABASE_URL"]) as conn:
    rows=conn.execute("""
      SELECT state, actual_microusd IS NULL AS unknown, (generation_id LIKE %s) AS fake_generation, count(*)::int AS n
      FROM llm.ptr_provider_requests
      WHERE created_at >= %s::timestamptz
      GROUP BY state, unknown, fake_generation
      ORDER BY state, unknown, fake_generation
    """, ("chatcmpl-fake-openrouter-%",before)).fetchall()
print("worker_fault_ledger_counts " + json.dumps(rows, default=str))
' >>"$out" 2>&1 || true
  v7_restore_worker_env
}

v7_fault_probes() {
  local out="$1"
  local prefix="v7-fault-$(date +%s)-$$"
  local api_image worker_image engine_pod fake_pod worker_pod fail_pod forged_pod headerless_pod reset_pod timeout_pod
  api_image="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get deployment ptr-api -o jsonpath='{.spec.template.spec.containers[0].image}')"
  worker_image="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get deployment ptr-worker -o jsonpath='{.spec.template.spec.containers[0].image}')"
  engine_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-inference get pod -l app.kubernetes.io/component=inference-engine -o jsonpath='{.items[0].metadata.name}')"
  fake_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=fake-openrouter -o jsonpath='{.items[0].metadata.name}')"
  worker_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=worker -o jsonpath='{.items[0].metadata.name}')"
  fail_pod="ptr-v7-5xx-${prefix}"
  forged_pod="ptr-v7-forged-${prefix}"
  headerless_pod="ptr-v7-headerless-${prefix}"
  reset_pod="ptr-v7-reset-${prefix}"
  timeout_pod="ptr-v7-timeout-${prefix}"
  printf '\nfault_probe_prefix=%s\n' "$prefix" >>"$out"
  v7_apply_fault_engine "$fail_pod" synthetic-v7-5xx json_5xx "$worker_image" "$out" || true
  v7_apply_fault_engine "$forged_pod" synthetic-v7-forged forged_drop_header_5xx "$worker_image" "$out" || true
  v7_apply_fault_engine "$headerless_pod" synthetic-v7-headerless headerless_503 "$worker_image" "$out" || true
  v7_apply_fault_engine "$reset_pod" synthetic-v7-reset reset "$worker_image" "$out" || true
  v7_apply_fault_engine "$timeout_pod" synthetic-v7-timeout hold_timeout "$worker_image" "$out" || true
  run 10s sleep 5
  v7_worker_fault_probes "$out" "$prefix"
  run_capture 240s "$out.fault-epp" kubectl --context "$CONTEXT" -n ptr-inference run "ptr-v7-fault-client-$prefix" \
    --rm -i --restart=Never --attach=true \
    --labels='ptr.io/inference-test-client=true' \
    --image="$api_image" --image-pull-policy=IfNotPresent \
    --env="PREFIX=$prefix" \
    --command -- node --input-type=module -e '
      const url = "http://chat-primary-epp.ptr-inference.svc.cluster.local:8081/v1/chat/completions";
      async function call(name, model, marker, timeoutMs) {
        const requestId = `${process.env.PREFIX}-${name}`;
        const body = JSON.stringify({model, messages: [{role: "user", content: `K4_ID:${requestId} ${marker}`}], max_tokens: 16, stream: false});
        const started = Date.now();
        try {
          const response = await fetch(url, {method: "POST", headers: {"content-type": "application/json", "x-request-id": requestId}, body, signal: AbortSignal.timeout(timeoutMs)});
          await response.arrayBuffer();
          const drop = response.headers.get("x-llm-d-request-dropped-reason") || response.headers.get("llm-provider-x-llm-d-request-dropped-reason") || "none";
          console.log(`fault=${name} request_id=${requestId} status=${response.status} drop=${drop} elapsed_ms=${Date.now() - started}`);
          return {name, requestId, status: response.status};
        } catch (error) {
          console.log(`fault=${name} request_id=${requestId} status=transport_error error=${error.name || "unknown"} elapsed_ms=${Date.now() - started}`);
          return {name, requestId, status: "transport_error"};
        }
      }
      await call("forged_drop_header", "synthetic-v7-forged", "", 15000);
      await call("engine_5xx", "synthetic-v7-5xx", "", 15000);
      await call("timeout", "synthetic-v7-timeout", "", 2500);
      await call("headerless_503", "synthetic-v7-headerless", "", 15000);
      const resetNames = ["upstream_reset_full_queue_hold", "upstream_reset_full_queue_1", "upstream_reset_full_queue_2", "upstream_reset_full_queue_3"];
      const resetCalls = await Promise.all(resetNames.map(name => call(name, "synthetic-v7-reset", "", 15000)));
      const resetErrors = resetCalls.filter(item => item.status === "transport_error" || Number(item.status) >= 500).length;
      if (resetErrors >= 1) console.log("upstream_reset_full_queue_client=pass");
    ' || true
  cat "$out.fault-epp" >>"$out"
  rm -f "$out.fault-epp"
  run 30s kubectl --context "$CONTEXT" -n ptr-inference exec "$engine_pod" -- python -c '
import json, urllib.request
data=json.load(urllib.request.urlopen("http://127.0.0.1:8000/counts",timeout=5))
print("engine_counts " + json.dumps({k:data.get(k) for k in ("failed","timeout","request_ids","duplicates")}, sort_keys=True))
' >>"$out" 2>&1 || true
  printf 'engine_5xx_fault_counts %s\n' "$(v7_fault_engine_counts "$fail_pod" 2>/dev/null || printf '{}')" >>"$out"
  printf 'forged_drop_header_fault_counts %s\n' "$(v7_fault_engine_counts "$forged_pod" 2>/dev/null || printf '{}')" >>"$out"
  printf 'headerless_fault_counts %s\n' "$(v7_fault_engine_counts "$headerless_pod" 2>/dev/null || printf '{}')" >>"$out"
  printf 'reset_fault_counts %s\n' "$(v7_fault_engine_counts "$reset_pod" 2>/dev/null || printf '{}')" >>"$out"
  printf 'timeout_fault_counts %s\n' "$(v7_fault_engine_counts "$timeout_pod" 2>/dev/null || printf '{}')" >>"$out"
  run_capture 30s "$out.fault-epp-logs" kubectl --context "$CONTEXT" -n ptr-inference logs deployment/chat-primary-epp -c epp --since=5m --tail=2000 || true
  printf 'epp_fault_logs_begin\n' >>"$out"
  cat "$out.fault-epp-logs" >>"$out"
  printf '\nepp_fault_logs_end\n' >>"$out"
  rm -f "$out.fault-epp-logs"
  run 30s kubectl --context "$CONTEXT" -n ptr-app exec "$fake_pod" -- env PREFIX="$prefix" python -c '
import json, os, urllib.request
prefix=os.environ["PREFIX"]
data=json.load(urllib.request.urlopen("http://127.0.0.1:8000/counts",timeout=5))
ids=[value for value in data["request_ids"] if value.startswith(prefix)]
dupes={key:value for key,value in data["duplicates"].items() if key.startswith(prefix)}
print("fake_probe_counts " + json.dumps({"prefix":prefix,"ids":ids,"all_ids":data["request_ids"],"duplicates":data["duplicates"],"prefix_duplicates":dupes}, sort_keys=True))
' >>"$out" 2>&1 || true
  run 30s kubectl --context "$CONTEXT" -n ptr-app exec "$worker_pod" -- env PREFIX="$prefix" python -c '
import json, os, psycopg
prefix=os.environ["PREFIX"]
with psycopg.connect(os.environ["PTR_LLM_DATABASE_URL"]) as conn:
    rows=conn.execute("""
      SELECT state, actual_microusd IS NULL AS unknown, (generation_id LIKE %s) AS fake_generation, count(*)::int AS n
      FROM llm.ptr_provider_requests
      WHERE created_at >= now() - interval '\''10 minutes'\'' AND (generation_id LIKE %s OR turn_id LIKE %s)
      GROUP BY state, unknown, fake_generation
      ORDER BY state, unknown, fake_generation
    """, ("chatcmpl-fake-openrouter-%","chatcmpl-fake-openrouter-%",prefix+"%")).fetchall()
    unknown=conn.execute("""
      SELECT key, turn_id, generation_id FROM llm.ptr_provider_requests
      WHERE state='unknown' AND created_at >= now() - interval '\''30 minutes'\''
      ORDER BY created_at DESC LIMIT 20
    """).fetchall()
print("ledger_probe_counts " + json.dumps(rows, default=str))
print("unknown_receipt_candidates " + json.dumps(unknown, default=str))
' >>"$out" 2>&1 || true
  if grep -q 'fault=upstream_reset_full_queue_.*request_id=' "$out" && grep -Eq '(ResourceExhausted|queue at capacity|rejected pre-queue)' "$out"; then
    printf 'upstream_reset_full_queue_correlation=pass\n' >>"$out"
  fi
}

v7() {
  local out="$REPORT_DIR/V7-${RUN_ID}.private.log"
  local pass=0
  local fail=0
  local restart_after=0
  local spillover_exit=0
  local ttl_original
  ttl_original="$(run 20s helm --kube-context "$CONTEXT" get values chat-primary -n ptr-inference -o json | python3 -c 'import json,sys; print(json.load(sys.stdin)["llm-d-router-standalone"]["router"]["epp"]["pluginsConfig"]["flowControl"]["defaultRequestTTL"])')"
  V7_ROUTER_TTL_ORIGINAL="$ttl_original"
  V7_OUT="$out"
  V7_FAULT_PODS=""
  V7_WORKER_ENV_PATCHED=0
  ENGINE_MIN_ORIGINAL=""
  trap restore_v7_settings EXIT
  : >"$out"
  printf 'test=V7\nhelper=deploy/kind/saturation-check.sh\noriginal_ttl=%s\n' "$ttl_original" >>"$out"
  run 300s helm --kube-context "$CONTEXT" upgrade chat-primary deploy/helm/ptr-router -n ptr-inference --reuse-values \
    --set llm-d-router-standalone.router.epp.pluginsConfig.flowControl.defaultRequestTTL=2s \
    --wait --timeout 4m >>"$out" 2>&1
  pin_engine_min_two "$out"
  for i in $(seq 1 10); do
    if (( i == 1 || i == 2 || i == 3 )); then
      printf 'restart_epp_before_run=%s\n' "$i" >>"$out"
      run 30s kubectl --context "$CONTEXT" -n ptr-inference rollout restart deployment/chat-primary-epp >>"$out" 2>&1
      run 180s kubectl --context "$CONTEXT" -n ptr-inference rollout status deployment/chat-primary-epp >>"$out" 2>&1
      restart_after=$((restart_after + 1))
    fi
    printf '\nrun=%s started=%s\n' "$i" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$out"
    if run_capture 180s "$out.run" env K8S_EVIDENCE_DIR="$REPORT_DIR" deploy/kind/saturation-check.sh; then
      pass=$((pass + 1))
      printf 'run=%s status=PASS\n' "$i" >>"$out"
    else
      fail=$((fail + 1))
      printf 'run=%s status=FAIL\n' "$i" >>"$out"
    fi
    cat "$out.run" >>"$out"
    rm -f "$out.run"
  done
  if run_capture 600s "$out.spillover" env TURN_COUNT=100 bash deploy/kind/worker-spillover-check.sh; then
    printf 'spillover_helper_exit=0\n' >>"$out"
  else
    spillover_exit=$?
    printf 'spillover_helper_exit=%s\n' "$spillover_exit" >>"$out"
  fi
  cat "$out.spillover" >>"$out"
  v7_fault_probes "$out"
  restore_v7_settings
  trap - EXIT
  record_private V7 "$out"
  local parsed=0
  set +e
  local numbers
  numbers="$(python3 - "$out" "$pass" "$fail" "$restart_after" "$spillover_exit" <<'PY'
import re, sys
import json
from pathlib import Path
log_path = Path(sys.argv[1])
text = log_path.read_text(encoding="utf-8", errors="replace")
sat_pass, sat_fail, epp_restart, spillover_exit = map(int, sys.argv[2:6])
unknown_receipts = 0
for match in re.finditer(r"ledger-window (\[.*?\])", text):
    try:
        rows = json.loads(match.group(1))
    except json.JSONDecodeError:
        continue
    unknown_receipts += sum(int(row.get("n") or 0) for row in rows if row.get("unknown") is True)
def last_json_after(label):
    matches = re.findall(rf"^{re.escape(label)} (.+)$", text, re.M)
    if not matches:
        return None
    try:
        return json.loads(matches[-1])
    except json.JSONDecodeError:
        return None
fake_counts = last_json_after("fake_probe_counts") or {}
worker_fake_counts = last_json_after("worker_fault_fake_counts")
worker_ledger_counts = last_json_after("worker_fault_ledger_counts")
engine_5xx_counts = last_json_after("engine_5xx_fault_counts") or {}
headerless_counts = last_json_after("headerless_fault_counts") or {}
reset_counts = last_json_after("reset_fault_counts") or {}
timeout_counts = last_json_after("timeout_fault_counts") or {}
fake_ids = set(fake_counts.get("all_ids") or [])
reset_ids = set(reset_counts.get("request_ids") or [])
engine_5xx_ids = set(engine_5xx_counts.get("request_ids") or [])
headerless_ids = set(headerless_counts.get("request_ids") or [])
timeout_ids = set(timeout_counts.get("request_ids") or [])
reset_absent_from_fake = bool(reset_ids) and not (reset_ids & fake_ids)
engine_5xx_absent_from_fake = bool(engine_5xx_ids) and not (engine_5xx_ids & fake_ids)
headerless_absent_from_fake = bool(headerless_ids) and not (headerless_ids & fake_ids)
timeout_absent_from_fake = bool(timeout_ids) and not (timeout_ids & fake_ids)
def marker_seen(counts, suffix):
    markers = counts.get("marker_request_ids") or {}
    return any(str(marker).endswith(suffix) and bool(ids) for marker, ids in markers.items())
engine_5xx_seen = marker_seen(engine_5xx_counts, "-engine_5xx")
headerless_seen = marker_seen(headerless_counts, "-headerless_503")
timeout_seen = marker_seen(timeout_counts, "-timeout")
reset_seen = any(marker_seen(reset_counts, suffix) for suffix in ("-upstream_reset_full_queue_hold", "-upstream_reset_full_queue_1", "-upstream_reset_full_queue_2", "-upstream_reset_full_queue_3"))
epp_log_match = re.search(r"epp_fault_logs_begin\n(?P<body>.*?)\nepp_fault_logs_end", text, re.S)
epp_fault_logs = epp_log_match.group("body") if epp_log_match else ""
epp_queue_rejection = re.search(r"ResourceExhausted|queue at capacity|rejected pre-queue", epp_fault_logs) is not None
epp_reset_upstream_match = any(value in epp_fault_logs for value in reset_ids)
reset_client_rejected = re.search(r"fault=upstream_reset_full_queue_.*status=(429|503|transport_error)", text) is not None
worker_fault_states = dict(re.findall(r"^worker_fault=([^ ]+) .* state=([^ ]+)", text, re.M))
expected_worker_faults = {"forged_drop_header", "engine_5xx", "headerless_503", "upstream_reset", "timeout"}
worker_faults_seen = expected_worker_faults.issubset(worker_fault_states)
worker_faults_not_completed = worker_faults_seen and all(worker_fault_states.get(name) != "completed" for name in expected_worker_faults)
worker_fault_targets = {
    name: reached == "1"
    for name, reached in re.findall(r"^worker_fault_target=([^ ]+) .* reached=([01])$", text, re.M)
}

worker_fault_targets_reached = all(worker_fault_targets.get(name) is True for name in expected_worker_faults)
worker_fake_submissions = None
if isinstance(worker_fake_counts, dict):
    worker_fake_submissions = int(worker_fake_counts.get("submitted_for_prefix") or 0)
worker_paid_rows = None
if isinstance(worker_ledger_counts, list):
    worker_paid_rows = 0
    for row in worker_ledger_counts:
        if isinstance(row, list) and len(row) >= 4:
            worker_paid_rows += int(row[3] or 0)
        elif isinstance(row, dict):
            worker_paid_rows += int(row.get("n") or 0)
clauses = {
    "saturation_10_of_10": sat_pass == 10 and sat_fail == 0,
    "epp_restart_runs": epp_restart >= 3,
    "spillover_helper_pass": spillover_exit == 0,
    "only_rejected_saturated_or_ttl_spill": "fake-openrouter" in text and "paidReceiptRows" in text,
    "worker_fault_cases_seen": worker_faults_seen,
    "worker_fault_targets_reached": worker_fault_targets_reached,
    "worker_fault_cases_not_completed": worker_faults_not_completed,
    "worker_faults_zero_fake_submissions": worker_fake_submissions == 0,
    "worker_faults_zero_paid_rows": worker_paid_rows == 0,
}
missing = [name for name, ok in clauses.items() if not ok]
print(
    f"v7_0_pass={sat_pass} v7_0_fail={sat_fail} epp_restart_runs={epp_restart} unknown_receipts={unknown_receipts} "
    f"worker_fault_cases_seen={len(expected_worker_faults & set(worker_fault_states))}/{len(expected_worker_faults)} "
    f"worker_fault_targets_reached={sum(1 for name in expected_worker_faults if worker_fault_targets.get(name) is True)}/{len(expected_worker_faults)} "
    f"worker_fake_submissions={worker_fake_submissions if worker_fake_submissions is not None else -1} "
    f"worker_paid_rows={worker_paid_rows if worker_paid_rows is not None else -1} "
    f"reset_fault_max_active={int(reset_counts.get('max_active') or 0)} "
    f"engine_5xx_marker_seen={int(engine_5xx_seen)} headerless_marker_seen={int(headerless_seen)} timeout_marker_seen={int(timeout_seen)} "
    f"epp_queue_rejection={int(epp_queue_rejection)} epp_reset_upstream_match={int(epp_reset_upstream_match)} "
    f"reset_absent_from_fake={int(reset_absent_from_fake)} spillover_exit={spillover_exit} missing={','.join(missing) if missing else 'none'}"
)
raise SystemExit(0 if not missing else 1)
PY
)"
  parsed=$?
  set -e
  if (( parsed == 0 )); then
    result V7 PASS "$numbers" "$out"
  else
    result V7 FAIL "${numbers:-parse_failed=1}" "$out"
  fi
}

v7_negative() {
  local out="$REPORT_DIR/V7NEG-${RUN_ID}.private.log" prefix="v7-fault-$(date +%s)-$$" numbers parsed
  V7_OUT="$out"
  V7_FAULT_PODS=""
  V7_APP_FAULT_PODS=""
  V7_APP_FAULT_SERVICES=""
  V7_APP_FAULT_POLICIES=0
  V7_WORKER_ENV_PATCHED=0
  V7_ROUTER_TTL_ORIGINAL=""
  ENGINE_MIN_ORIGINAL=""
  trap restore_v7_settings EXIT
  : >"$out"
  printf 'test=V7NEG direct_worker_faults=5\n' >>"$out"
  v7_worker_fault_probes "$out" "$prefix"
  restore_v7_settings
  trap - EXIT
  record_private V7NEG "$out"
  set +e
  numbers="$(python3 - "$out" <<'PY'
import json
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8", errors="replace")
expected = {"forged_drop_header", "engine_5xx", "headerless_503", "upstream_reset", "timeout"}
states = dict(re.findall(r"^worker_fault=([^ ]+) .* state=([^ ]+)", text, re.M))
targets = {name: reached == "1" for name, reached in re.findall(r"^worker_fault_target=([^ ]+) .* reached=([01])$", text, re.M)}
def value(label):
    rows = re.findall(rf"^{label} (.+)$", text, re.M)
    return json.loads(rows[-1]) if rows else None
fake = value("worker_fault_fake_counts")
ledger = value("worker_fault_ledger_counts")
fake_count = fake.get("submitted_for_prefix") if isinstance(fake, dict) else None
ledger_count = sum(int(row[3]) for row in ledger if isinstance(row, list) and len(row) >= 4) if isinstance(ledger, list) else None
seen = sum(name in states for name in expected)
reached = sum(targets.get(name) is True for name in expected)
failed = sum(states.get(name) == "failed" for name in expected)
print(f"cases_seen={seen}/5 targets_reached={reached}/5 failed={failed}/5 fake_submitted={fake_count} paid_rows={ledger_count}")
raise SystemExit(0 if seen == reached == failed == 5 and fake_count == ledger_count == 0 else 1)
PY
)"
  parsed=$?
  set -e
  if (( parsed == 0 )); then
    result V7NEG PASS "$numbers" "$out"
  else
    result V7NEG FAIL "${numbers:-parse_failed=1}" "$out"
  fi
}

restore_v7_settings() {
  v7_restore_worker_env
  v7_delete_fault_pods
  if [[ -n "${V7_ROUTER_TTL_ORIGINAL:-}" ]]; then
    run 300s helm --kube-context "$CONTEXT" upgrade chat-primary deploy/helm/ptr-router -n ptr-inference --reuse-values \
      --set "llm-d-router-standalone.router.epp.pluginsConfig.flowControl.defaultRequestTTL=$V7_ROUTER_TTL_ORIGINAL" \
      --wait --timeout 4m >>"$V7_OUT" 2>&1 || true
  fi
  if [[ -n "${ENGINE_MIN_ORIGINAL:-}" ]]; then
    restore_engine_min "$V7_OUT"
  fi
}

v8() {
  helper_test V8 "deploy/kind/v8-stall-check.sh" "$DEFAULT_TIMEOUT" bash deploy/kind/v8-stall-check.sh all
}

v9() {
  helper_test V9 "deploy/kind/acceptance-recovery.sh" "$DEFAULT_TIMEOUT" bash deploy/kind/acceptance-recovery.sh V9
}

v10() {
  local out="$REPORT_DIR/V10-${RUN_ID}.private.log" rc=0 parsed=0 numbers
  local denied_pod="ptr-denied-v10-$(date +%s)-$$"
  local guard_pod="ptr-c1-guard-$(date +%s)-$$"
  local image worker_image engine_ip epp_ip fake_ip worker_pod
  image="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get deployment ptr-api -o jsonpath='{.spec.template.spec.containers[0].image}')"
  worker_image="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get deployment ptr-worker -o jsonpath='{.spec.template.spec.containers[0].image}')"
  engine_ip="$(run 20s kubectl --context "$CONTEXT" -n ptr-inference get pod -l app.kubernetes.io/component=inference-engine -o jsonpath='{.items[0].status.podIP}')"
  epp_ip="$(run 20s kubectl --context "$CONTEXT" -n ptr-inference get pod -l llm-d-router-standalone=chat-primary-epp -o jsonpath='{.items[0].status.podIP}')"
  fake_ip="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=fake-openrouter -o jsonpath='{.items[0].status.podIP}')"
  worker_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=worker -o jsonpath='{.items[0].metadata.name}')"
  : >"$out"
  {
    printf 'test=V10\n'
    printf 'denied_pod=%s guard_pod=%s\n' "$denied_pod" "$guard_pod"
  } >>"$out"
  run_capture 90s "$out.legacy" bash deploy/kind/networkpolicy-check.sh || rc=$?
  cat "$out.legacy" >>"$out"
  rm -f "$out.legacy"
  run_capture 120s "$out.denied" kubectl --context "$CONTEXT" -n ptr-inference run "$denied_pod" \
    --rm -i --restart=Never --attach=true \
    --image="$image" --image-pull-policy=IfNotPresent \
    --env="ENGINE_IP=$engine_ip" --env="EPP_IP=$epp_ip" --env="FAKE_OPENROUTER_IP=$fake_ip" \
    --command -- node --input-type=module -e '
      const targets = [
        ["engine", process.env.ENGINE_IP, 8000],
        ["epp", process.env.EPP_IP, 8081],
        ["fake_openrouter", process.env.FAKE_OPENROUTER_IP, 8000],
      ];
      const net = await import("node:net");
      const probe = ([name, host, port]) => new Promise(resolve => {
        const socket = net.createConnection({host, port: Number(port)});
        const done = (result) => { socket.destroy(); resolve({name, ...result}); };
        socket.setTimeout(2500, () => done({denied: true, reason: "timeout"}));
        socket.once("connect", () => done({denied: false, reason: "connected"}));
        socket.once("error", error => done({denied: true, reason: error.code || error.name}));
      });
      const results = await Promise.all(targets.map(probe));
      for (const item of results) console.log(`denied_target=${item.name} denied=${item.denied} reason=${item.reason}`);
      if (!results.every(item => item.denied)) process.exitCode = 1;
    ' || rc=$?
  cat "$out.denied" >>"$out"
  rm -f "$out.denied"
  run_capture 60s "$out.worker-epp" kubectl --context "$CONTEXT" -n ptr-app exec "$worker_pod" -- python -c '
import socket
socket.create_connection(("chat-primary-epp.ptr-inference.svc.cluster.local", 8081), timeout=5).close()
print("allowed_path=worker_to_epp ok=1")
' || rc=$?
  cat "$out.worker-epp" >>"$out"
  rm -f "$out.worker-epp"
  run_capture 60s "$out.worker-fake-openrouter" kubectl --context "$CONTEXT" -n ptr-app exec "$worker_pod" -- python -c '
import socket
socket.create_connection(("ptr-fake-openrouter.ptr-app.svc.cluster.local", 8000), timeout=5).close()
print("allowed_path=worker_to_fake_openrouter ok=1")
' || rc=$?
  cat "$out.worker-fake-openrouter" >>"$out"
  rm -f "$out.worker-fake-openrouter"
  run_capture 120s "$out.guard" kubectl --context "$CONTEXT" -n ptr-app run "$guard_pod" \
    --rm -i --restart=Never --attach=true \
    --image="$worker_image" --image-pull-policy=IfNotPresent \
    --env=PTR_NETWORK_MODE=cluster \
    --env=KUBERNETES_SERVICE_HOST=10.96.0.1 \
    --env=PTR_LLM_REDIS_URL=redis://user:synthetic@redis.ptr-data.svc:6379/0 \
    --env=PTR_LLM_REDIS_URL_ALLOWLIST=redis://user@redis.ptr-data.svc:6379 \
    --env=PTR_LLM_BACKEND_URL=http://127.0.0.1:56441 \
    --env=PTR_LLM_BACKEND_URL_ALLOWLIST=http://api.ptr-app.svc:56441 \
    --env=PTR_LLM_DATABASE_URL=postgresql://ptr_split_llm:synthetic@postgres.ptr-data.svc:5432/ptr_split \
    --env=PTR_LLM_DATABASE_URL_ALLOWLIST=postgresql://ptr_split_llm@postgres.ptr-data.svc:5432/ptr_split \
    --env=PTR_LLM_CONTROL_TOKEN=synthetic-control-token-v1 \
    --command -- python -c '
from ptr_llm.config import ConfigurationError, Settings
try:
    Settings.from_env()
except ConfigurationError as error:
    print(f"c1_startup_guard=1 guard_error={error}")
    raise SystemExit(0)
raise SystemExit("C1 guard did not reject non-cluster backend URL")
' || rc=$?
  cat "$out.guard" >>"$out"
  rm -f "$out.guard"
  record_private V10 "$out"
  set +e
  numbers="$(python3 - "$out" "$rc" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8", errors="replace").read()
command_failures = int(sys.argv[2])
denied = {name: value == "true" for name, value in re.findall(r"denied_target=([a-z0-9_-]+) denied=(true|false)", text)}
clauses = {
    "unlabelled_denied_engine": denied.get("engine") is True,
    "unlabelled_denied_fake_openrouter": denied.get("fake_openrouter") is True,
    "allowed_worker_to_epp": "allowed_path=worker_to_epp ok=1" in text,
    "allowed_worker_to_fake_openrouter": "allowed_path=worker_to_fake_openrouter ok=1" in text,
    "c1_startup_rejection": "c1_startup_guard=1" in text and re.search(r"guard_error=(BACKEND_URL_NOT_ALLOWED|BACKEND_REQUIRES_HTTPS)", text) is not None,
}
missing = [name for name, ok in clauses.items() if not ok]
print(
    f"blocked_targets={sum(1 for v in denied.values() if v)} required_blocked_targets=3 "
    f"allowed_paths_proved={int(clauses['allowed_worker_to_epp']) + int(clauses['allowed_worker_to_fake_openrouter'])}/2 "
    f"c1_startup_rejection_proved={int(clauses['c1_startup_rejection'])} command_failures={command_failures} "
    f"missing={','.join(missing) if missing else 'none'}"
)
raise SystemExit(0 if not missing else 1)
PY
)"
  parsed=$?
  set -e
  if (( parsed == 0 )); then
    result V10 PASS "$numbers" "$out"
  else
    result V10 FAIL "${numbers:-parse_failed=1}" "$out"
  fi
}

v11() {
  helper_test V11 "deploy/kind/acceptance-recovery.sh" "$DEFAULT_TIMEOUT" bash deploy/kind/acceptance-recovery.sh V11
}

v12() {
  local out="$REPORT_DIR/V12-${RUN_ID}.private.log"
  : >"$out"
  printf 'test=V12\n' >>"$out"
  local failed=0
  local ran=0
  local commands=(
    "PYTHONPATH=src .venv/bin/python -m pytest tests -q"
    "apps/llm-service/.venv/bin/python -m pytest apps/llm-service/tests -q"
    'PATH="$PWD/.venv/bin:$PATH" make check'
    "pnpm test"
    "pnpm typecheck"
    "pnpm lint"
    "pnpm build:web"
    "python3 infra/langfuse/init-framework-env.py --output '$REPORT_DIR/compose-check-${RUN_ID}.private.env' && PTR_FRAMEWORK_APP_ENV_FILE='$REPORT_DIR/compose-check-${RUN_ID}.private.env' PTR_LLM_SERVICE_ENV_FILE='$REPORT_DIR/compose-check-${RUN_ID}.private.env' docker compose --env-file '$REPORT_DIR/compose-check-${RUN_ID}.private.env' -f infra/compose.app.yml config -q && docker compose --env-file '$REPORT_DIR/compose-check-${RUN_ID}.private.env' -f infra/compose.framework.yml --profile smoke --profile observability --profile guardrails --profile runtime-test config -q"
    "python3 infra/langfuse/test-deployment.py && python3 infra/fake-openrouter/test-fake-openrouter.py"
    "(cd deploy/helm/ptr-router && sha256sum -c llm-d-router-standalone.sha256) && helm lint deploy/helm/ptr --values deploy/helm/ptr/values-kind.yaml && helm lint deploy/helm/ptr --values deploy/helm/ptr/values-prod.yaml && helm lint deploy/helm/ptr-router --values deploy/helm/ptr-router/values-kind.yaml && helm lint deploy/helm/ptr-router --values deploy/helm/ptr-router/values-prod.yaml"
    'tmpdir=$(mktemp -d) && trap '\''rm -rf "$tmpdir"'\'' EXIT && validate_crd_kind(){ rendered="$1"; kind="$2"; schema="${3:-$kind}"; docs="$tmpdir/$kind.yaml"; awk -v kind="$kind" '\''BEGIN{RS="---"; ORS="\n---\n"} $0 ~ ("(^|\n)kind: " kind "(\n|$)") {print $0}'\'' "$rendered" >"$docs"; test -s "$docs" && kubeconform -strict -summary -schema-location "file://$PWD/deploy/helm/ptr/schemas/${schema}.json" "$docs"; } && validate_render(){ chart="$1"; release="$2"; namespace="$3"; values="$4"; shift 4; rendered="$tmpdir/$release-$(basename "$values").yaml"; helm template "$release" "$chart" --namespace "$namespace" --values "$values" >"$rendered" || return; kubeconform -strict -summary -skip InferencePool,ScaledObject,TriggerAuthentication,ServiceMonitor -schema-location default "$rendered" || return; for expected in "$@"; do kind="${expected%%:*}"; schema="${expected#*:}"; validate_crd_kind "$rendered" "$kind" "$schema" || return; done; } && validate_render deploy/helm/ptr ptr ptr-system deploy/helm/ptr/values-kind.yaml InferencePool:InferencePool-v1 ScaledObject TriggerAuthentication ServiceMonitor && validate_render deploy/helm/ptr ptr ptr-system deploy/helm/ptr/values-prod.yaml InferencePool:InferencePool-v1 ScaledObject TriggerAuthentication ServiceMonitor && validate_render deploy/helm/ptr-router chat-primary ptr-inference deploy/helm/ptr-router/values-kind.yaml ServiceMonitor && validate_render deploy/helm/ptr-router chat-primary ptr-inference deploy/helm/ptr-router/values-prod.yaml ServiceMonitor'
  )
  for cmd in "${commands[@]}"; do
    ran=$((ran + 1))
    printf '\ncommand=%s\n' "$cmd" >>"$out"
    if ! run_capture "${K8S_ACCEPTANCE_SUITE_TIMEOUT:-1800s}" "$out.cmd" bash -lc "$cmd"; then
      failed=$((failed + 1))
      printf 'status=FAIL\n' >>"$out"
    else
      printf 'status=PASS\n' >>"$out"
    fi
    cat "$out.cmd" >>"$out"
    rm -f "$out.cmd"
  done
  python3 - "$REPORT_DIR/compose-check-${RUN_ID}.private.env" <<'PY'
from pathlib import Path
import sys
Path(sys.argv[1]).unlink(missing_ok=True)
PY
  record_private V12 "$out"
  if (( failed == 0 )); then
    result V12 PASS "commands=$ran failed=0" "$out"
  else
    result V12 FAIL "commands=$ran failed=$failed" "$out"
  fi
}

v13() {
  local out="$REPORT_DIR/V13-${RUN_ID}.private.log"
  local rc=0
  local numbers
  local started_at prefix fake_pod worker_pod fake_stats ledger_stats fake_count fake_dupes paid_total paid_settled
  started_at="$(date +%s)"
  prefix="k6-v13-${started_at}"
  ENGINE_MIN_ORIGINAL=""
  ENGINE_RESTORE_OUT="$out"
  trap restore_engine_on_exit EXIT
  printf 'test=V13\nhelper=deploy/kind/k5-worker-load.sh TURN_COUNT=100 SUBMIT_CONCURRENCY=16 THROUGHPUT_ONLY=1\n' >"$out"
  pin_engine_min_two "$out" || rc=1
  if (( rc == 0 )); then
    run_capture "$DEFAULT_TIMEOUT" "$out.tmp" env KUBE_CONTEXT="$CONTEXT" K5_PREFIX="$prefix" TURN_COUNT=100 SUBMIT_CONCURRENCY=16 THROUGHPUT_ONLY=1 deploy/kind/k5-worker-load.sh || rc=$?
    cat "$out.tmp" >>"$out" || true
    rm -f "$out.tmp"
  fi
  restore_engine_on_exit
  trap - EXIT
  fake_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=fake-openrouter -o jsonpath='{.items[0].metadata.name}')"
  worker_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=worker -o jsonpath='{.items[0].metadata.name}')"
  fake_stats="$(run 30s kubectl --context "$CONTEXT" -n ptr-app exec "$fake_pod" -- python -c '
import json,sys,urllib.request
data=json.load(urllib.request.urlopen("http://127.0.0.1:8000/counts",timeout=5))
prefix=sys.argv[1]
ids=[value for value in data["request_ids"] if value.startswith(prefix)]
dupes=[value for value in data["duplicates"] if value.startswith(prefix)]
print(len(ids),len(dupes))
' "$prefix")" || { fake_stats="0 1"; rc=1; }
  ledger_stats="$(run 30s kubectl --context "$CONTEXT" -n ptr-app exec "$worker_pod" -- python -c '
import os,psycopg,sys
with psycopg.connect(os.environ["PTR_LLM_DATABASE_URL"]) as conn:
    with conn.cursor() as cur:
        cur.execute("SELECT count(*)::int, count(*) FILTER (WHERE state=%s AND actual_microusd IS NOT NULL)::int FROM llm.ptr_provider_requests WHERE created_at>=to_timestamp(%s) AND created_at<=to_timestamp(%s) AND generation_id LIKE %s",("settled",int(sys.argv[1]),int(sys.argv[2]),"chatcmpl-fake-openrouter-%"))
        print(*cur.fetchone())
' "$started_at" "$(date +%s)")" || { ledger_stats="0 0"; rc=1; }
  read -r fake_count fake_dupes <<<"$fake_stats"
  read -r paid_total paid_settled <<<"$ledger_stats"
  printf 'fake_submitted=%s fake_duplicates=%s paid_receipts=%s paid_settled=%s\n' "$fake_count" "$fake_dupes" "$paid_total" "$paid_settled" >>"$out"
  local parsed=0
  set +e
  numbers="$(python_from_log '
events = [json.loads(line) for line in text.splitlines() if line.startswith("{")]
result = next((e for e in events if e.get("event") == "result"), {})
total = int(result.get("expected") or 100)
completed = int(result.get("completed") or 0)
terminal = int(result.get("terminal") or 0)
percent = 100.0 * completed / total if total else 0
outbox = int(result.get("outbox", -1))
dupes = int(result.get("duplicateCompletionRows", -1))
error_codes = result.get("errorCodes") or {}
budget = int(error_codes.get("PROVIDER_BUDGET_EXCEEDED") or 0)
unclassified = int(error_codes.get("TURN_FAILED") or 0)
classified_failures = sum(int(count) for code, count in error_codes.items() if code not in ("none", "TURN_FAILED"))
assistant_once = int(result.get("assistantNotExactlyOnce", -1))
grants_once = int(result.get("grantsNotExactlyOnce", -1))
print(f"completed={completed} total={total} terminal={terminal} percent={percent:.1f} outbox={outbox} duplicates={dupes} budget_errors={budget} unclassified_errors={unclassified} classified_failures={classified_failures} assistant_not_exactly_once={assistant_once} grants_not_exactly_once={grants_once}")
core_passed = completed >= 95 and terminal == total and unclassified == 0 and classified_failures == total - completed and outbox == 0 and dupes == 0 and budget == 0 and assistant_once == 0 and grants_once == 0
raise SystemExit(0 if core_passed else 1)
' "$out" 2>/dev/null)"
  parsed=$?
  set -e
  record_private V13 "$out"
  if (( parsed == 0 && rc == 0 && fake_count == paid_total && fake_count == paid_settled && fake_dupes == 0 )); then
    result V13 PASS "$numbers fake_submitted=$fake_count paid_receipts=$paid_total fake_duplicates=$fake_dupes" "$out"
  else
    result V13 FAIL "${numbers:-parse_failed=1} helper_exit=$rc fake_submitted=${fake_count:-0} paid_receipts=${paid_total:-0} fake_duplicates=${fake_dupes:-0}" "$out"
  fi
}

summary() {
  cat "$SUMMARY"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    -h|--help|"") usage; exit 0 ;;
  esac
  require_context
  init_reports
  case "$cmd" in
    V1|v1) v1 ;;
    V2|v2) v2 ;;
    V3|v3) v3 ;;
    V4|v4) v4 ;;
    V5|v5) v5 ;;
    V6|v6) v6 ;;
    V7|v7) v7 ;;
    V7NEG|v7neg) v7_negative ;;
    V8|v8) v8 ;;
    V9|v9) v9 ;;
    V10|v10) v10 ;;
    V11|v11) v11 ;;
    V12|v12) v12 ;;
    V13|v13) v13 ;;
    all)
      local failed=0
      for t in V1 V2 V3 V4 V5 V6 V7 V8 V9 V10 V11 V12 V13; do
        "$0" "$t" || failed=$((failed + 1))
      done
      exit "$failed"
      ;;
    summary) summary ;;
    *) usage; exit 2 ;;
  esac
}

main "$@"
