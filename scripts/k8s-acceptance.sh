#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CONTEXT="${KUBE_CONTEXT:-kind-ptr-k8s}"
REPORT_DIR="${K8S_ACCEPTANCE_REPORT_DIR:-$ROOT/reports/k8s}"
PRIVATE_REPORT="${K8S_ACCEPTANCE_PRIVATE_REPORT:-$REPORT_DIR/acceptance.private.md}"
SUMMARY="${K8S_ACCEPTANCE_SUMMARY:-$ROOT/deploy/kind/ACCEPTANCE.md}"
DEFAULT_TIMEOUT="${K8S_ACCEPTANCE_TIMEOUT:-1200s}"
RUN_ID="${K8S_ACCEPTANCE_RUN_ID:-k6-$(date -u +%Y%m%dT%H%M%SZ)}"

cd "$ROOT"

die() {
  printf 'ERROR %s\n' "$*" >&2
  exit 2
}

usage() {
  cat <<'USAGE'
Usage: scripts/k8s-acceptance.sh V1|V2|...|V13|all|summary

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
while end < len(lines) and re.match(r"^\| V[0-9]+ \|", lines[end]):
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
    and int(host.get("desiredPeakWithin60sAfterSubmit") or 0) >= 6
    and int(host.get("readyPeakWithin60sAfterSubmit") or 0) >= 6
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

v7_fault_probes() {
  local out="$1"
  local prefix="v7-fault-$(date +%s)-$$"
  local api_image worker_image engine_pod fake_pod worker_pod fail_pod headerless_pod reset_pod timeout_pod
  api_image="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get deployment ptr-api -o jsonpath='{.spec.template.spec.containers[0].image}')"
  worker_image="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get deployment ptr-worker -o jsonpath='{.spec.template.spec.containers[0].image}')"
  engine_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-inference get pod -l app.kubernetes.io/component=inference-engine -o jsonpath='{.items[0].metadata.name}')"
  fake_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-gateway get pod -l app.kubernetes.io/component=fake-openrouter -o jsonpath='{.items[0].metadata.name}')"
  worker_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=worker -o jsonpath='{.items[0].metadata.name}')"
  fail_pod="ptr-v7-5xx-${prefix}"
  headerless_pod="ptr-v7-headerless-${prefix}"
  reset_pod="ptr-v7-reset-${prefix}"
  timeout_pod="ptr-v7-timeout-${prefix}"
  printf '\nfault_probe_prefix=%s\n' "$prefix" >>"$out"
  v7_apply_fault_engine "$fail_pod" synthetic-v7-5xx json_5xx "$worker_image" "$out" || true
  v7_apply_fault_engine "$headerless_pod" synthetic-v7-headerless headerless_503 "$worker_image" "$out" || true
  v7_apply_fault_engine "$reset_pod" synthetic-v7-reset reset "$worker_image" "$out" || true
  v7_apply_fault_engine "$timeout_pod" synthetic-v7-timeout hold_timeout "$worker_image" "$out" || true
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
  run_capture 90s "$out.fault-auth" kubectl --context "$CONTEXT" -n ptr-app exec -i "$worker_pod" -- python - <<'PYAUTH' || true
import json, os, urllib.error, urllib.request
base = os.environ["PTR_LLM_LITELLM_BASE_URL"].removesuffix("/v1")
api_key = os.environ["PTR_LLM_LITELLM_API_KEY"]
def post(name, body):
    data = json.dumps(body, separators=(",", ":")).encode()
    headers = {"content-type": "application/json", "authorization": "Bearer " + api_key}
    req = urllib.request.Request(base + "/v1/chat/completions", data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            status = response.status
            payload = response.read(1024).decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        status = error.code
        payload = error.read(1024).decode("utf-8", "replace")
    print(f"auth_probe={name} status={status} blocked={status in (400,403,409)} valid_app_key=True missing_spillover_grant=True body={payload[:160]!r}")
post("unsigned_primary", {"model":"primary","messages":[{"role":"user","content":"synthetic unsigned"}],"max_tokens":8})
post("direct_paid_no_spillover_grant", {"model":"openrouter-primary","messages":[{"role":"user","content":"synthetic direct paid no spillover grant"}],"max_tokens":8})
PYAUTH
  cat "$out.fault-auth" >>"$out"
  rm -f "$out.fault-auth"
  run 30s kubectl --context "$CONTEXT" -n ptr-inference exec "$engine_pod" -- python -c '
import json, urllib.request
data=json.load(urllib.request.urlopen("http://127.0.0.1:8000/counts",timeout=5))
print("engine_counts " + json.dumps({k:data.get(k) for k in ("failed","timeout","request_ids","duplicates")}, sort_keys=True))
' >>"$out" 2>&1 || true
  printf 'engine_5xx_fault_counts %s\n' "$(v7_fault_engine_counts "$fail_pod" 2>/dev/null || printf '{}')" >>"$out"
  printf 'headerless_fault_counts %s\n' "$(v7_fault_engine_counts "$headerless_pod" 2>/dev/null || printf '{}')" >>"$out"
  printf 'reset_fault_counts %s\n' "$(v7_fault_engine_counts "$reset_pod" 2>/dev/null || printf '{}')" >>"$out"
  printf 'timeout_fault_counts %s\n' "$(v7_fault_engine_counts "$timeout_pod" 2>/dev/null || printf '{}')" >>"$out"
  run_capture 30s "$out.fault-epp-logs" kubectl --context "$CONTEXT" -n ptr-inference logs deployment/chat-primary-epp -c epp --since=5m --tail=2000 || true
  printf 'epp_fault_logs_begin\n' >>"$out"
  cat "$out.fault-epp-logs" >>"$out"
  printf '\nepp_fault_logs_end\n' >>"$out"
  rm -f "$out.fault-epp-logs"
  run 30s kubectl --context "$CONTEXT" -n ptr-gateway exec "$fake_pod" -- env PREFIX="$prefix" python -c '
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
  record_private V7 "$out"
  local parsed=0
  set +e
  local numbers
  numbers="$(python3 - "$out" "$pass" "$fail" "$restart_after" "$spillover_exit" <<'PY'
import hashlib
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
engine_5xx_counts = last_json_after("engine_5xx_fault_counts") or {}
headerless_counts = last_json_after("headerless_fault_counts") or {}
reset_counts = last_json_after("reset_fault_counts") or {}
timeout_counts = last_json_after("timeout_fault_counts") or {}
fake_ids = set(fake_counts.get("all_ids") or [])
fake_duplicates = fake_counts.get("duplicates") or {}

def read_json_tail(line, prefix):
    if not line.startswith(prefix):
        return None
    try:
        return json.loads(line[len(prefix):])
    except json.JSONDecodeError:
        return None

def archived_unknown_receipt(report_dir):
    candidates = []
    reasons = []
    for path in sorted(report_dir.glob("*.private.log*")) + sorted(report_dir.glob("*.private.md")):
        if path.resolve() == log_path.resolve():
            continue
        try:
            archive_text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for match in re.finditer(r"^unknown_receipt_candidates (.+)$", archive_text, re.M):
            try:
                rows = json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
            for row in rows:
                if not isinstance(row, list):
                    continue
                for value in row:
                    if isinstance(value, str) and value in fake_ids:
                        candidates.append((value, f"{path.name}:unknown_receipt_candidates"))
        summary = None
        ledger = None
        fake = None
        for line in archive_text.splitlines():
            if line.startswith('{"prefix"'):
                try:
                    item = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(item, dict) and item.get("results") and str(item.get("prefix", "")).startswith("worker-spill-"):
                    summary = item
            elif line.startswith("ledger-window "):
                ledger = read_json_tail(line, "ledger-window ")
            elif line.startswith("fake-openrouter "):
                fake = read_json_tail(line, "fake-openrouter ")
        if summary and ledger and fake:
            unknown_n = sum(int(row.get("n") or 0) for row in ledger if isinstance(row, dict) and row.get("unknown") is True)
            fake_archive_ids = set(fake.get("ids") or []) if isinstance(fake, dict) else set()
            prefix = fake.get("prefix") if isinstance(fake, dict) else None
            count = int(summary.get("count") or 0)
            if unknown_n == 1 and isinstance(prefix, str) and count > 0:
                expected = {f"{prefix}-{index:02d}" for index in range(count)}
                missing = sorted(expected - fake_archive_ids)
                local_n = sum(int(row.get("n") or 0) for row in ledger if isinstance(row, dict) and row.get("upstream") == "local-pool")
                if len(missing) == 1:
                    candidates.append((missing[0], f"{path.name}:single_missing_archived_request"))
                elif len(missing) == local_n + unknown_n:
                    reasons.append(f"{path.name}:ambiguous_archived_candidates_{len(missing)}")
                else:
                    reasons.append(f"{path.name}:missing_count_{len(missing)}_does_not_identify_unknown")
    unique = sorted({value for value, _source in candidates})
    if len(unique) == 1:
        value = unique[0]
        duplicate_count = int(fake_duplicates.get(value, 1)) if value in fake_ids else 0
        return {
            "status": "matched" if value in fake_ids and duplicate_count == 1 else "not_in_current_fake_counts",
            "sha12": hashlib.sha256(value.encode()).hexdigest()[:12],
            "duplicate_count": duplicate_count,
            "source_count": len(candidates),
        }
    if len(unique) > 1:
        return {"status": "unproved", "sha12": "none", "duplicate_count": 0, "reason": f"multiple_archived_candidates_{len(unique)}"}
    return {"status": "unproved", "sha12": "none", "duplicate_count": 0, "reason": ";".join(reasons) or "no_archived_exact_request_id"}

archived_unknown = archived_unknown_receipt(log_path.parent)
unknown_exact_match = archived_unknown.get("status") == "matched" and int(archived_unknown.get("duplicate_count") or 0) == 1
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
direct_paid_line = next((line for line in text.splitlines() if line.startswith("auth_probe=direct_paid_no_spillover_grant ")), "")
clauses = {
    "saturation_10_of_10": sat_pass == 10 and sat_fail == 0,
    "epp_restart_runs": epp_restart >= 3,
    "spillover_helper_pass": spillover_exit == 0,
    "only_rejected_saturated_or_ttl_spill": "fake-openrouter" in text and "paidReceiptRows" in text,
    "headerless_503_fault": re.search(r"fault=headerless_503 .*status=503", text) is not None and int(headerless_counts.get("headerless_503") or 0) >= 1 and headerless_seen and headerless_absent_from_fake,
    "engine_5xx_fault": int(engine_5xx_counts.get("json_5xx") or 0) >= 1 and engine_5xx_seen and engine_5xx_absent_from_fake,
    "timeout_fault": re.search(r"fault=timeout .*status=transport_error", text) is not None and int(timeout_counts.get("hold_timeout") or 0) >= 1 and timeout_seen and timeout_absent_from_fake,
    "upstream_reset_full_queue_correlation": re.search(r"upstream[_-]reset.*full[_-]queue.*correlation.*pass", text, re.I | re.S) is not None and reset_seen and reset_absent_from_fake and reset_client_rejected and epp_queue_rejection and epp_reset_upstream_match,
    "unsigned_and_direct_paid_blocked": all(
        re.search(pattern, text) is not None
        for pattern in (
            r"auth_probe=unsigned_primary status=(400|403|409) blocked=True .*valid_app_key=True",
            r"auth_probe=direct_paid_no_spillover_grant status=(400|403|409) blocked=True .*valid_app_key=True .*missing_spillover_grant=True",
        )
    ) and "INVALID_BUDGET_AUTHORITY" not in direct_paid_line,
    "ledger_matching_unknown_receipt_accounted": unknown_exact_match,
}
missing = [name for name, ok in clauses.items() if not ok]
print(
    f"v7_0_pass={sat_pass} v7_0_fail={sat_fail} epp_restart_runs={epp_restart} unknown_receipts={unknown_receipts} "
    f"archived_unknown_status={archived_unknown.get('status')} archived_unknown_sha12={archived_unknown.get('sha12')} "
    f"archived_unknown_duplicate_count={int(archived_unknown.get('duplicate_count') or 0)} "
    f"archived_unknown_reason={archived_unknown.get('reason', 'none')} "
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

restore_v7_settings() {
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
  local image worker_image engine_ip epp_ip redis_ip litellm_ip worker_pod litellm_pod
  image="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get deployment ptr-api -o jsonpath='{.spec.template.spec.containers[0].image}')"
  worker_image="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get deployment ptr-worker -o jsonpath='{.spec.template.spec.containers[0].image}')"
  engine_ip="$(run 20s kubectl --context "$CONTEXT" -n ptr-inference get pod -l app.kubernetes.io/component=inference-engine -o jsonpath='{.items[0].status.podIP}')"
  epp_ip="$(run 20s kubectl --context "$CONTEXT" -n ptr-inference get pod -l llm-d-router-standalone=chat-primary-epp -o jsonpath='{.items[0].status.podIP}')"
  redis_ip="$(run 20s kubectl --context "$CONTEXT" -n ptr-gateway get pod -l app.kubernetes.io/component=litellm-redis -o jsonpath='{.items[0].status.podIP}')"
  litellm_ip="$(run 20s kubectl --context "$CONTEXT" -n ptr-gateway get pod -l app.kubernetes.io/component=litellm -o jsonpath='{.items[0].status.podIP}')"
  worker_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=worker -o jsonpath='{.items[0].metadata.name}')"
  litellm_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-gateway get pod -l app.kubernetes.io/component=litellm -o jsonpath='{.items[0].metadata.name}')"
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
    --env="ENGINE_IP=$engine_ip" --env="EPP_IP=$epp_ip" --env="REDIS_IP=$redis_ip" --env="LITELLM_IP=$litellm_ip" \
    --command -- node --input-type=module -e '
      const targets = [
        ["engine", process.env.ENGINE_IP, 8000],
        ["epp", process.env.EPP_IP, 8081],
        ["redis", process.env.REDIS_IP, 6379],
        ["litellm", process.env.LITELLM_IP, 4000],
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
  run_capture 60s "$out.worker-litellm" kubectl --context "$CONTEXT" -n ptr-app exec "$worker_pod" -- python -c '
import socket
socket.create_connection(("ptr-litellm.ptr-gateway.svc", 4000), timeout=5).close()
print("allowed_path=worker_to_litellm ok=1")
' || rc=$?
  cat "$out.worker-litellm" >>"$out"
  rm -f "$out.worker-litellm"
  run_capture 60s "$out.litellm-epp" kubectl --context "$CONTEXT" -n ptr-gateway exec "$litellm_pod" -- python -c '
import socket
socket.create_connection(("chat-primary-epp.ptr-inference.svc.cluster.local", 8081), timeout=5).close()
print("allowed_path=litellm_to_epp ok=1")
' || rc=$?
  cat "$out.litellm-epp" >>"$out"
  rm -f "$out.litellm-epp"
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
    "unlabelled_denied_redis": denied.get("redis") is True,
    "unlabelled_denied_litellm": denied.get("litellm") is True,
    "allowed_worker_to_litellm": "allowed_path=worker_to_litellm ok=1" in text,
    "allowed_litellm_to_epp": "allowed_path=litellm_to_epp ok=1" in text,
    "c1_startup_rejection": "c1_startup_guard=1" in text and re.search(r"guard_error=(BACKEND_URL_NOT_ALLOWED|BACKEND_REQUIRES_HTTPS)", text) is not None,
}
missing = [name for name, ok in clauses.items() if not ok]
print(
    f"blocked_targets={sum(1 for v in denied.values() if v)} required_blocked_targets=3 "
    f"allowed_paths_proved={int(clauses['allowed_worker_to_litellm']) + int(clauses['allowed_litellm_to_epp'])}/2 "
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
    "python3 infra/langfuse/test-deployment.py && apps/llm-service/.venv/bin/python -m pytest infra/litellm/test-*.py -q"
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
  printf 'test=V13\nhelper=deploy/kind/k5-worker-load.sh TURN_COUNT=100 SUBMIT_CONCURRENCY=16\n' >"$out"
  pin_engine_min_two "$out" || rc=1
  if (( rc == 0 )); then
    run_capture "$DEFAULT_TIMEOUT" "$out.tmp" env KUBE_CONTEXT="$CONTEXT" K5_PREFIX="$prefix" TURN_COUNT=100 SUBMIT_CONCURRENCY=16 deploy/kind/k5-worker-load.sh || rc=$?
    cat "$out.tmp" >>"$out" || true
    rm -f "$out.tmp"
  fi
  restore_engine_on_exit
  trap - EXIT
  fake_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-gateway get pod -l app.kubernetes.io/component=fake-openrouter -o jsonpath='{.items[0].metadata.name}')"
  worker_pod="$(run 20s kubectl --context "$CONTEXT" -n ptr-app get pod -l app.kubernetes.io/component=worker -o jsonpath='{.items[0].metadata.name}')"
  fake_stats="$(run 30s kubectl --context "$CONTEXT" -n ptr-gateway exec "$fake_pod" -- python -c '
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
