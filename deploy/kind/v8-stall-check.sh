#!/usr/bin/env bash
set -euo pipefail
umask 077

context="${KUBE_CONTEXT:-kind-ptr-k8s}"
namespace="${PTR_INFERENCE_NAMESPACE:-ptr-inference}"
app_namespace="${PTR_APP_NAMESPACE:-ptr-app}"
run_id="v8-$(date +%Y%m%d%H%M%S)-$$"
configmap="ptr-${run_id}-fake-engine"
engine_ingress_policy="ptr-${run_id}-engine-ingress"
router_egress_policy="ptr-${run_id}-router-egress"
generation_pod=""
health_pod=""
client_pod=""

if [[ "$context" != "kind-ptr-k8s" ]]; then
  echo "Refusing to run outside kind-ptr-k8s" >&2
  exit 1
fi

usage() {
  cat <<'USAGE'
Usage: deploy/kind/v8-stall-check.sh generation|health|all

V8 acceptance helper for the kind ptr-k8s cluster.

  generation  V8(a): generation stalls while /health remains OK, then 20 EPP
              requests complete through the normal simulator path.
  health      V8(b): /health stalls; readiness goes false and liveness restarts.
  all         Run generation then health.

Every cluster command is wrapped in timeout and all temporary pods/configmaps
are removed by the script trap.
USAGE
}

kubectl_t() {
  timeout "${KUBECTL_TIMEOUT:-60s}" kubectl --context "$context" "$@"
}

result() {
  local test="$1" status="$2"
  shift 2
  printf 'RESULT test=%s status=%s run_id=%s' "$test" "$status" "$run_id"
  for item in "$@"; do
    printf ' %s' "$item"
  done
  printf '\n'
}

worker_image() {
  kubectl_t -n "$app_namespace" get deployment ptr-worker \
    -o jsonpath='{.spec.template.spec.containers[0].image}'
}

api_image() {
  kubectl_t -n "$app_namespace" get deployment ptr-api \
    -o jsonpath='{.spec.template.spec.containers[0].image}'
}

epp_client_deadline_ms() {
  # Explicit client abort deadline for the stalled-pod probe. The router
  # flowControl.defaultRequestTTL is queue TTL, not generation deadline.
  printf '%s\n' "${V8_STALLED_CLIENT_DEADLINE_MS:-10000}"
}

cleanup() {
  if [[ -n "${client_pod:-}" ]]; then
    timeout 90s kubectl --context "$context" -n "$namespace" delete pod "$client_pod" \
      --ignore-not-found --wait=true --timeout=75s >/dev/null 2>&1 || true
    client_pod=""
  fi
  if [[ -n "${generation_pod:-}" ]]; then
    timeout 90s kubectl --context "$context" -n "$namespace" delete pod "$generation_pod" \
      --ignore-not-found --wait=true --timeout=75s >/dev/null 2>&1 || true
    generation_pod=""
  fi
  if [[ -n "${health_pod:-}" ]]; then
    timeout 90s kubectl --context "$context" -n "$namespace" delete pod "$health_pod" \
      --ignore-not-found --wait=true --timeout=75s >/dev/null 2>&1 || true
    health_pod=""
  fi
  timeout 30s kubectl --context "$context" -n "$namespace" delete configmap "$configmap" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || true
  timeout 30s kubectl --context "$context" -n "$namespace" delete networkpolicy "$engine_ingress_policy" "$router_egress_policy" \
    --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

ensure_fake_engine_configmap() {
  timeout 15s kubectl --context "$context" -n "$namespace" create configmap "$configmap" \
    --from-file=fake-engine.py=infra/litellm/fake-engine.py \
    --dry-run=client -o yaml |
    timeout 30s kubectl --context "$context" apply -f - >/dev/null
}

ensure_fake_engine_network() {
  kubectl_t -n "$namespace" apply -f - >/dev/null <<YAML
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${engine_ingress_policy}
  namespace: ${namespace}
spec:
  podSelector:
    matchLabels:
      ptr.io/v8-stall-check-engine: "true"
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              llm-d-router-standalone: chat-primary-epp
      ports:
        - {protocol: TCP, port: 8000}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${router_egress_policy}
  namespace: ${namespace}
spec:
  podSelector:
    matchLabels:
      llm-d-router-standalone: chat-primary-epp
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              ptr.io/v8-stall-check-engine: "true"
      ports:
        - {protocol: TCP, port: 8000}
YAML
}

create_generation_pod() {
  local image
  image="$(worker_image)"
  generation_pod="ptr-${run_id}-gen"
  kubectl_t -n "$namespace" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${generation_pod}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ptr
    app.kubernetes.io/component: inference-engine
    pool: chat-primary
    llm-d.ai/model: synthetic-chat
    ptr.io/v8-stall-check: "generation"
    ptr.io/v8-stall-check-engine: "true"
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  nodeSelector:
    ptr.io/fake-gpu: "true"
  tolerations:
    - {key: nvidia.com/gpu, operator: Exists, effect: NoSchedule}
  containers:
    - name: fake-engine
      image: ${image}
      imagePullPolicy: IfNotPresent
      command: ["python", "/fixture/fake-engine.py"]
      env:
        - {name: PTR_SYNTHETIC_ENGINE_STALL_MODE, value: "generation"}
        - {name: PTR_SYNTHETIC_ENGINE_GENERATION_STALL_MS, value: "120000"}
      ports:
        - {name: http, containerPort: 8000}
      readinessProbe:
        httpGet: {path: /health, port: http}
        periodSeconds: 2
        timeoutSeconds: 1
        failureThreshold: 2
      resources:
        requests: {cpu: 50m, memory: 96Mi}
        limits: {cpu: 500m, memory: 256Mi}
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: ["ALL"]}
      volumeMounts:
        - {name: fixture, mountPath: /fixture, readOnly: true}
        - {name: tmp, mountPath: /tmp}
  volumes:
    - name: fixture
      configMap:
        name: ${configmap}
    - name: tmp
      emptyDir: {}
YAML
  kubectl_t -n "$namespace" wait --for=condition=Ready "pod/$generation_pod" --timeout=90s >/dev/null
}

create_health_pod() {
  local image
  image="$(worker_image)"
  health_pod="ptr-${run_id}-health"
  kubectl_t -n "$namespace" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${health_pod}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/name: ptr
    app.kubernetes.io/component: inference-engine
    pool: chat-primary
    llm-d.ai/model: synthetic-chat
    ptr.io/v8-stall-check: "health"
    ptr.io/v8-stall-check-engine: "true"
spec:
  restartPolicy: Always
  automountServiceAccountToken: false
  nodeSelector:
    ptr.io/fake-gpu: "true"
  tolerations:
    - {key: nvidia.com/gpu, operator: Exists, effect: NoSchedule}
  containers:
    - name: fake-engine
      image: ${image}
      imagePullPolicy: IfNotPresent
      command: ["python", "/fixture/fake-engine.py"]
      env:
        - {name: PTR_SYNTHETIC_ENGINE_STALL_MODE, value: "health"}
        - {name: PTR_SYNTHETIC_ENGINE_HEALTH_STALL_MS, value: "120000"}
      ports:
        - {name: http, containerPort: 8000}
      readinessProbe:
        httpGet: {path: /health, port: http}
        periodSeconds: 2
        timeoutSeconds: 1
        failureThreshold: 1
      livenessProbe:
        httpGet: {path: /health, port: http}
        periodSeconds: 2
        timeoutSeconds: 1
        failureThreshold: 3
      resources:
        requests: {cpu: 50m, memory: 96Mi}
        limits: {cpu: 500m, memory: 256Mi}
      securityContext:
        allowPrivilegeEscalation: false
        capabilities: {drop: ["ALL"]}
      volumeMounts:
        - {name: fixture, mountPath: /fixture, readOnly: true}
        - {name: tmp, mountPath: /tmp}
  volumes:
    - name: fixture
      configMap:
        name: ${configmap}
    - name: tmp
      emptyDir: {}
YAML
  kubectl_t -n "$namespace" wait --for=jsonpath='{.status.phase}'=Running "pod/$health_pod" --timeout=90s >/dev/null
}

exec_fake_python() {
  local pod="$1"
  shift
  timeout "${FAKE_EXEC_TIMEOUT:-20s}" kubectl --context "$context" -n "$namespace" exec -i "$pod" \
    -- python - "$@"
}

fake_counts_json() {
  exec_fake_python "$generation_pod" <<'PY'
import json
import urllib.request

with urllib.request.urlopen("http://127.0.0.1:8000/counts", timeout=3) as response:
    print(response.read().decode())
PY
}


all_engine_counts_json() {
  local pods_json
  pods_json="$(timeout 30s kubectl --context "$context" -n "$namespace" get pod \
    -l app.kubernetes.io/component=inference-engine,pool=chat-primary -o json)"
  timeout 30s python3 - "$context" "$namespace" "$pods_json" <<'PY'
import json
import subprocess
import sys

context, namespace, pods_json = sys.argv[1:4]
pods = json.loads(pods_json).get("items", [])
rows = []
for pod in pods:
    name = pod.get("metadata", {}).get("name", "")
    phase = pod.get("status", {}).get("phase")
    ready = any(
        condition.get("type") == "Ready" and condition.get("status") == "True"
        for condition in pod.get("status", {}).get("conditions", [])
    )
    if not name or phase != "Running" or not ready:
        continue
    try:
        proc = subprocess.run(
            [
                "timeout", "15s", "kubectl", "--context", context, "-n", namespace,
                "exec", name, "--", "python", "-c",
                "import json,urllib.request; print(json.dumps(json.load(urllib.request.urlopen('http://127.0.0.1:8000/counts', timeout=3)), sort_keys=True))",
            ],
            check=True, text=True, capture_output=True, timeout=20,
        )
        counts = json.loads(proc.stdout)
    except Exception as error:
        counts = {"error": error.__class__.__name__}
    rows.append({"pod": name, "ready": ready, "counts": counts})
print(json.dumps(rows, sort_keys=True))
PY
}

generation_pool_membership_json() {
  kubectl_t -n "$namespace" get pod "$generation_pod" -o json |
    timeout 10s python3 -c '
import json,sys
pod=json.load(sys.stdin)
labels=pod.get("metadata",{}).get("labels",{})
conditions={row.get("type"): row.get("status") for row in pod.get("status",{}).get("conditions",[])}
print(json.dumps({
  "pod": pod.get("metadata",{}).get("name"),
  "podIP": pod.get("status",{}).get("podIP"),
  "pool": labels.get("pool"),
  "model": labels.get("llm-d.ai/model"),
  "component": labels.get("app.kubernetes.io/component"),
  "ready": conditions.get("Ready"),
  "inInferencePool": labels.get("pool") == "chat-primary" and labels.get("llm-d.ai/model") == "synthetic-chat" and conditions.get("Ready") == "True",
}, sort_keys=True))
'
}

prove_generation_stall() {
  exec_fake_python "$generation_pod" <<'PY'
import json
import socket
import sys
import urllib.request

body = json.dumps({
    "model": "synthetic-chat",
    "messages": [{"role": "user", "content": "V8 generation stall probe"}],
    "max_tokens": 16,
}).encode()
request = urllib.request.Request(
    "http://127.0.0.1:8000/v1/chat/completions",
    data=body,
    headers={"content-type": "application/json", "x-request-id": "v8-generation-stall-probe"},
)
try:
    urllib.request.urlopen(request, timeout=2).read()
except (TimeoutError, socket.timeout):
    print("GENERATION_STALL_OBSERVED")
    sys.exit(0)
print("GENERATION_STALL_NOT_OBSERVED")
sys.exit(1)
PY
}

prove_health_ok() {
  exec_fake_python "$generation_pod" <<'PY'
import json
import urllib.request

with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=2) as response:
    payload = json.loads(response.read().decode())
    print(f"health_status={response.status} payload_status={payload.get('status')}")
    raise SystemExit(0 if response.status == 200 else 1)
PY
}

run_epp_single() {
  local request_id="$1"
  local timeout_ms="${2:-45000}"
  local image
  image="$(api_image)"
  client_pod="ptr-${run_id}-single"
  local client_js
  client_js="$(cat <<'JS'
const requestId = process.env.REQUEST_ID;
const timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || '45000');
const url = 'http://chat-primary-epp.ptr-inference.svc.cluster.local:8081/v1/chat/completions';
const body = JSON.stringify({
  model: 'synthetic-chat',
  messages: [{role: 'user', content: `K4_ID:${requestId} Synthetic V8 deadline route check`}],
  max_tokens: 64,
  stream: false,
});
const started = Date.now();
try {
  const response = await fetch(url, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-request-id': requestId},
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  await response.arrayBuffer();
  console.log(JSON.stringify({requestId, status: response.status, elapsedMs: Date.now() - started}));
  process.exit(response.status === 200 ? 0 : 1);
} catch (error) {
  console.log(JSON.stringify({requestId, status: `transport:${error.name || 'unknown'}`, elapsedMs: Date.now() - started}));
  process.exit(1);
}
JS
)"

  set +e
  timeout 90s kubectl --context "$context" -n "$namespace" run "$client_pod" \
    --rm -i --restart=Never --attach=true \
    --labels='ptr.io/inference-test-client=true,ptr.io/v8-stall-check=client' \
    --image="$image" --image-pull-policy=IfNotPresent \
    --env="REQUEST_ID=$request_id" \
    --env="REQUEST_TIMEOUT_MS=$timeout_ms" \
    --command -- node --input-type=module -e "$client_js"
  local rc="$?"
  set -e
  client_pod=""
  return "$rc"
}

run_epp_until_stalled() {
  local request_prefix="${run_id}-stall"
  local attempts="${V8_STALLED_ROUTE_ATTEMPTS:-12}"
  local expected_deadline_ms="${V8_EXPECTED_CLIENT_DEADLINE_MS:-10000}"
  local timeout_ms="${V8_STALLED_REQUEST_TIMEOUT_MS:-$expected_deadline_ms}"
  local attempt request_id output rc counts seen
  for attempt in $(seq 1 "$attempts"); do
    request_id="${request_prefix}-$(printf '%03d' "$attempt")"
    set +e
    output="$(run_epp_single "$request_id" "$timeout_ms" 2>&1)"
    rc=$?
    set -e
    counts="$(fake_counts_json)"
    seen="$(
      timeout 10s python3 - "$counts" "$request_id" <<'PY'
import json, sys
counts = json.loads(sys.argv[1])
request_id = sys.argv[2]
markers = counts.get("marker_request_ids") or {}
print("1" if markers.get(request_id) else "0")
PY
    )"
    printf 'stall_attempt=%s request_id=%s rc=%s seen_by_stalled_pod=%s output=%s\n' \
      "$attempt" "$request_id" "$rc" "$seen" "$(printf '%s' "$output" | tr '\n' ' ')" >&2
    if [[ "$seen" == "1" ]]; then
      timeout 10s python3 - "$output" "$counts" "$rc" <<'PY'
import json, sys
lines = [line for line in sys.argv[1].splitlines() if line.startswith("{")]
client = json.loads(lines[-1]) if lines else {"requestId": "missing", "status": "missing", "elapsedMs": 0}
counts = json.loads(sys.argv[2])
print(json.dumps({
    "attempts": int(client["requestId"].rsplit("-", 1)[-1]),
    "requestId": client["requestId"],
    "status": client["status"],
    "elapsedMs": int(client.get("elapsedMs") or 0),
    "clientRc": int(sys.argv[3]),
    "stalledPodSubmitted": int(counts.get("submitted") or 0),
    "stalledGeneration": int(counts.get("stalled_generation") or 0),
    "upstreamRequestIds": (counts.get("marker_request_ids") or {}).get(client["requestId"], []),
    "duplicates": counts.get("duplicates") or {},
}, sort_keys=True))
PY
      return 0
    fi
  done
  timeout 10s python3 - "$attempts" <<'PY'
import json, sys
print(json.dumps({
    "attempts": int(sys.argv[1]),
    "requestId": "not_observed",
    "status": "not_observed",
    "elapsedMs": 0,
    "clientRc": 1,
    "stalledPodSubmitted": 0,
    "stalledGeneration": 0,
    "duplicates": {},
}, sort_keys=True))
PY
  return 1
}

run_epp_client() {
  local image
  image="$(api_image)"
  client_pod="ptr-${run_id}-client"
  local request_prefix="${run_id}-healthy"
  local client_js
  client_js="$(cat <<'JS'
const count = Number(process.env.V8_TURN_COUNT || '20');
const concurrency = Number(process.env.V8_CONCURRENCY || '1');
const prefix = process.env.REQUEST_PREFIX;
const url = 'http://chat-primary-epp.ptr-inference.svc.cluster.local:8081/v1/chat/completions';
let next = 0;
const rows = [];
async function one(index) {
  const requestId = `${prefix}-${String(index).padStart(3, '0')}`;
  const body = JSON.stringify({
    model: 'synthetic-chat',
    messages: [{role: 'user', content: `K4_ID:${requestId} Synthetic V8 post-stall healthy route check`}],
    max_tokens: 64,
    stream: false,
  });
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json', 'x-request-id': requestId},
      body,
      signal: AbortSignal.timeout(45000),
    });
    await response.arrayBuffer();
    rows.push({requestId, status: response.status, elapsedMs: Date.now() - started});
  } catch (error) {
    rows.push({requestId, status: `transport:${error.name || 'unknown'}`, elapsedMs: Date.now() - started});
  }
}
await Promise.all(Array.from({length: concurrency}, async () => {
  while (next < count) {
    const index = next++;
    await one(index);
  }
}));
rows.sort((a, b) => a.requestId.localeCompare(b.requestId));
const completed = rows.filter(row => row.status === 200).length;
const statuses = {};
for (const row of rows) statuses[row.status] = (statuses[row.status] || 0) + 1;
console.log(JSON.stringify({
  requestPrefix: prefix,
  total: rows.length,
  completed,
  completionPct: Math.round((completed / rows.length) * 10000) / 100,
  statuses,
  rows,
}));
process.exit(completed >= Math.ceil(rows.length * 0.95) ? 0 : 1);
JS
)"

  timeout 240s kubectl --context "$context" -n "$namespace" run "$client_pod" \
    --rm -i --restart=Never --attach=true \
    --labels='ptr.io/inference-test-client=true,ptr.io/v8-stall-check=client' \
    --image="$image" --image-pull-policy=IfNotPresent \
    --env="REQUEST_PREFIX=$request_prefix" \
    --env="V8_TURN_COUNT=${V8_TURN_COUNT:-20}" \
    --env="V8_CONCURRENCY=${V8_CONCURRENCY:-1}" \
    --command -- node --input-type=module -e "$client_js"
  client_pod=""
}

run_generation() {
  ensure_fake_engine_configmap
  ensure_fake_engine_network
  create_generation_pod

  local health_output direct_stall_output stalled_epp_output client_output counts_json all_counts_json pool_json analysis status expected_deadline_ms
  expected_deadline_ms="$(epp_client_deadline_ms)"
  set +e
  health_output="$(prove_health_ok 2>&1)"
  local health_rc=$?
  direct_stall_output="$(prove_generation_stall 2>&1)"
  local direct_stall_rc=$?
  stalled_epp_output="$(V8_EXPECTED_CLIENT_DEADLINE_MS="$expected_deadline_ms" run_epp_until_stalled 2>&1)"
  local stalled_epp_rc=$?
  client_output="$(run_epp_client 2>&1)"
  local client_rc=$?
  set -e
  pool_json="$(generation_pool_membership_json)"
  counts_json="$(fake_counts_json)"
  all_counts_json="$(all_engine_counts_json)"
  analysis="$(
    timeout 10s node -e '
      const counts = JSON.parse(process.argv[1]);
      const allCounts = JSON.parse(process.argv[10]);
      const pool = JSON.parse(process.argv[7]);
      const stalledLine = process.argv[2].trim().split(/\n/).reverse().find((line) => {
        try {
          const item = JSON.parse(line);
          return item && item.requestId;
        } catch {
          return false;
        }
      });
      const clientLine = process.argv[3].trim().split(/\n/).reverse().find((line) => {
        try {
          const item = JSON.parse(line);
          return item && item.requestPrefix;
        } catch {
          return false;
        }
      });
      const stalledProbe = stalledLine ? JSON.parse(stalledLine) : {requestId: "missing", status: "missing", elapsedMs: 0, stalledGeneration: 0, duplicates: {}};
      const client = clientLine ? JSON.parse(clientLine) : {total: 0, completed: 0, completionPct: 0, statuses: {missing_client_json: 1}, rows: []};
      const markerMap = counts.marker_request_ids || {};
      const stalledMarkerSeen = Boolean(markerMap[stalledProbe.requestId]?.length);
      const allMarkerPods = new Map();
      let duplicateCount = 0;
      const countSources = allCounts.length ? allCounts : [{pod: pool.pod, counts}];
      for (const item of countSources) {
        const requestDuplicates = item.counts?.duplicates || {};
        const markerDuplicates = item.counts?.marker_duplicates || {};
        duplicateCount += Object.keys(requestDuplicates).length + Object.keys(markerDuplicates).length;
        const map = item.counts?.marker_request_ids || {};
        for (const [marker, upstreamIds] of Object.entries(map)) {
          if (!Array.isArray(upstreamIds) || upstreamIds.length === 0) continue;
          if (!allMarkerPods.has(marker)) allMarkerPods.set(marker, new Set());
          allMarkerPods.get(marker).add(item.pod);
        }
      }
      duplicateCount += [...allMarkerPods.values()].filter((pods) => pods.size > 1).length;
      const healthyMarkers = new Map();
      for (const item of allCounts) {
        if (item.pod === pool.pod) continue;
        const map = item.counts?.marker_request_ids || {};
        for (const [marker, upstreamIds] of Object.entries(map)) {
          if (Array.isArray(upstreamIds) && upstreamIds.length > 0) healthyMarkers.set(marker, item.pod);
        }
      }
      const laterRows = Array.isArray(client.rows) ? client.rows : [];
      const healthyRouted = laterRows.filter((row) => healthyMarkers.has(row.requestId)).length;
      const healthyCompleted = laterRows.filter((row) => row.status === 200 && healthyMarkers.has(row.requestId)).length;
      const stalledLaterRouted = laterRows.filter((row) => Boolean(markerMap[row.requestId]?.length)).length;
      const stalledStatus = String(stalledProbe.status || "");
      const stalledFailed = stalledStatus !== "200" && stalledStatus !== "ok";
      const expectedDeadlineMs = Number(process.argv[9]);
      const earlyToleranceMs = Number(process.env.V8_DEADLINE_EARLY_TOLERANCE_MS || "1000");
      const lateToleranceMs = Number(process.env.V8_DEADLINE_LATE_TOLERANCE_MS || "3000");
      const stalledElapsedMs = Number(stalledProbe.elapsedMs || 0);
      const stalledAtDeadline = stalledFailed && stalledElapsedMs >= expectedDeadlineMs - earlyToleranceMs && stalledElapsedMs <= expectedDeadlineMs + lateToleranceMs;
      const expectedTotal = Number(process.env.V8_TURN_COUNT || "20");
      const laterHealthyThreshold = Math.ceil(expectedTotal * 0.95);
      const laterHealthy = client.total === expectedTotal && healthyRouted >= laterHealthyThreshold && healthyCompleted >= laterHealthyThreshold && stalledLaterRouted === 0 && Number(process.argv[4]) === 0;
      const routeOk = Number(process.argv[5]) === 0 && Number(process.argv[6]) === 0 && Number(process.argv[8]) === 0 &&
        pool.inInferencePool === true && stalledMarkerSeen && Number(stalledProbe.stalledGeneration || 0) >= 1;
      const ok = routeOk && stalledAtDeadline && laterHealthy && duplicateCount === 0;
      const missing = [];
      if (!routeOk) missing.push("epp_request_id_not_observed_on_stalled_pod");
      if (!stalledAtDeadline) missing.push("stalled_request_not_failed_at_deadline_window");
      if (!laterHealthy) missing.push("later_requests_under_95_percent_healthy");
      if (duplicateCount !== 0) missing.push("duplicate_generations");
      console.log(JSON.stringify({
        ok,
        total: client.total,
        completed: client.completed,
        completionPct: client.completionPct,
        healthyRouted,
        healthyCompleted,
        stalledLaterRouted,
        laterHealthyThreshold,
        duplicateRequestIds: duplicateCount,
        stalledRequestId: stalledProbe.requestId,
        stalledMarkerSeen,
        stalledStatus,
        stalledElapsedMs,
        expectedDeadlineMs,
        deadlineDeltaMs: stalledElapsedMs - expectedDeadlineMs,
        deadlineEarlyToleranceMs: earlyToleranceMs,
        deadlineLateToleranceMs: lateToleranceMs,
        stalledAttempts: Number(stalledProbe.attempts || 0),
        fakeSubmitted: Number(counts.submitted || 0),
        fakeStalledGeneration: Number(counts.stalled_generation || 0),
        poolReady: pool.ready,
        pool: pool.pool,
        model: pool.model,
        clientRc: Number(process.argv[4]),
        healthRc: Number(process.argv[5]),
        directStallRc: Number(process.argv[6]),
        stalledEppRc: Number(process.argv[8]),
        missingClause: missing.length ? missing.join(",") : "none",
      }));
    ' "$counts_json" "$stalled_epp_output" "$client_output" "$client_rc" "$health_rc" "$direct_stall_rc" "$pool_json" "$stalled_epp_rc" "$expected_deadline_ms" "$all_counts_json"
  )"
  status="$(
    timeout 10s node -e 'const item = JSON.parse(process.argv[1]); process.stdout.write(item.ok ? "PASS" : "FAIL")' "$analysis"
  )"
  timeout 10s node -e '
    const item = JSON.parse(process.argv[1]);
    console.log(`health="${process.argv[2]}"`);
    console.log(`direct_stall="${process.argv[3]}"`);
    console.log(`stalled_epp=${process.argv[4]}`);
    console.log(`client=${process.argv[5]}`);
    console.log(`counts=${process.argv[6]}`);
    console.log(`all_counts=${process.argv[8]}`);
    console.log(`pool=${process.argv[7]}`);
    console.log(`summary=${JSON.stringify(item)}`);
  ' "$analysis" "$health_output" "$direct_stall_output" "$stalled_epp_output" "$client_output" "$counts_json" "$pool_json" "$all_counts_json" >&2
  result V8A "$status" \
    "total=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).total))' "$analysis")" \
    "completed=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).completed))' "$analysis")" \
    "completion_pct=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).completionPct))' "$analysis")" \
    "healthy_routed=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).healthyRouted))' "$analysis")" \
    "healthy_completed=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).healthyCompleted))' "$analysis")" \
    "stalled_later_routed=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).stalledLaterRouted))' "$analysis")" \
    "duplicate_request_ids=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).duplicateRequestIds))' "$analysis")" \
    "fake_stalled_generation=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).fakeStalledGeneration))' "$analysis")" \
    "stalled_request_id=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).stalledRequestId))' "$analysis")" \
    "stalled_status=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).stalledStatus))' "$analysis")" \
    "stalled_marker_seen=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).stalledMarkerSeen))' "$analysis")" \
    "stalled_elapsed_ms=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).stalledElapsedMs))' "$analysis")" \
    "expected_client_deadline_ms=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).expectedDeadlineMs))' "$analysis")" \
    "deadline_delta_ms=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).deadlineDeltaMs))' "$analysis")" \
    "stalled_attempts=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).stalledAttempts))' "$analysis")" \
    "pool_ready=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).poolReady))' "$analysis")" \
    "missing_clause=$(timeout 10s node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).missingClause))' "$analysis")"
  [[ "$status" == PASS ]]
}

pod_ready_status() {
  kubectl_t -n "$namespace" get pod "$health_pod" \
    -o jsonpath='{range .status.conditions[?(@.type=="Ready")]}{.status}{end}'
}

pod_restart_count() {
  kubectl_t -n "$namespace" get pod "$health_pod" \
    -o jsonpath='{.status.containerStatuses[?(@.name=="fake-engine")].restartCount}'
}

run_health() {
  ensure_fake_engine_configmap
  ensure_fake_engine_network
  create_health_pod

  local start ready_false_seconds restart_seconds status restarts
  start="$(date +%s)"
  ready_false_seconds="not_observed"
  for _ in $(seq 1 10); do
    if [[ "$(pod_ready_status)" == "False" ]]; then
      ready_false_seconds="$(($(date +%s) - start))"
      break
    fi
    timeout 2s sleep 1
  done

  restart_seconds="not_observed"
  for _ in $(seq 1 40); do
    restarts="$(pod_restart_count)"
    if [[ "${restarts:-0}" =~ ^[0-9]+$ ]] && (( restarts > 0 )); then
      restart_seconds="$(($(date +%s) - start))"
      break
    fi
    timeout 2s sleep 1
  done

  status=FAIL
  if [[ "$ready_false_seconds" =~ ^[0-9]+$ && "$restart_seconds" =~ ^[0-9]+$ ]] &&
     (( ready_false_seconds <= 10 && restart_seconds <= 40 )); then
    status=PASS
  fi
  result V8B "$status" \
    "ready_false_seconds=$ready_false_seconds" \
    "restart_seconds=$restart_seconds" \
    "restart_count=${restarts:-0}"
  [[ "$status" == PASS ]]
}

main() {
  case "${1:-}" in
    generation)
      run_generation
      ;;
    health)
      run_health
      ;;
    all)
      rc=0
      run_generation || rc=1
      cleanup
      trap cleanup EXIT
      run_health || rc=1
      exit "$rc"
      ;;
    -h|--help|help|"")
      usage
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
