#!/usr/bin/env bash
set -euo pipefail
umask 077

context="${KUBE_CONTEXT:-kind-ptr-k8s}"
app_ns="${PTR_APP_NAMESPACE:-ptr-app}"
inference_ns="${PTR_INFERENCE_NAMESPACE:-ptr-inference}"
data_ns="${PTR_DATA_NAMESPACE:-ptr-data}"
release="${PTR_HELM_RELEASE:-ptr}"
chart="${PTR_HELM_CHART:-deploy/helm/ptr}"
kind_values="${PTR_HELM_KIND_VALUES:-deploy/helm/ptr/values-kind.yaml}"
evidence_dir="${K8S_EVIDENCE_DIR:-reports/k8s}"
run_id="rec-$(date +%Y%m%d%H%M%S)-$$"
short_run_id="${K8S_ACCEPTANCE_SHORT_RUN_ID:-$(date +%H%M%S)}"
client_pod=""
created_job=""
drained_node=""
original_engine_replicas=""
original_api_replicas=""
original_engine_min=""
original_worker_replicas=""
original_worker_scaledobject_paused=""
worker_autoscaling_restore_needed=""
original_redis_replicas=""
restore_engine_values=""
original_engine_time_to_first_token=""
original_engine_inter_token_latency=""

if [[ "$context" != "kind-ptr-k8s" ]]; then
  echo "Refusing to run outside kind-ptr-k8s" >&2
  exit 1
fi

mkdir -p "$evidence_dir"
chmod 700 "$evidence_dir"

kind_helm_upgrade() {
  local control_plane_ip
  control_plane_ip="$(timeout 10s docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ptr-k8s-control-plane)"
  [[ "$control_plane_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  timeout 240s helm --kube-context "$context" upgrade "$release" "$chart" -n ptr-system \
    --reuse-values -f "$kind_values" \
    --set-string "inference.apiServerCIDRs[1]=$control_plane_ip/32" \
    --set-string "policy.apiServerCIDRs[1]=$control_plane_ip/32" \
    "$@" --wait
}

usage() {
  cat <<USAGE
Usage: $0 V1|V2|V3|V4|V9|V11|all

Recovery-focused K6 acceptance helpers for design section 7. Each subcommand
uses kind-ptr-k8s, creates/deletes its own client pod when it submits traffic,
wraps kubectl/helm actions in timeout, and prints one RESULT line.
USAGE
}

kubectl_t() { timeout "${KUBECTL_TIMEOUT:-60s}" kubectl --context "$context" "$@"; }
helm_t() { timeout "${HELM_TIMEOUT:-240s}" helm "$@"; }

result() {
  local test="$1" status="$2"
  shift 2
  printf 'RESULT test=%s status=%s run_id=%s' "$test" "$status" "$run_id"
  for item in "$@"; do
    printf ' %s' "$item"
  done
  printf '\n'
}

append_missing_clause() {
  local var_name="$1" clause="$2" current
  current="${!var_name:-}"
  if [[ -z "$current" ]]; then
    printf -v "$var_name" '%s' "$clause"
  else
    printf -v "$var_name" '%s,%s' "$current" "$clause"
  fi
}

append_missing_clause_list() {
  local var_name="$1" clauses="$2" clause
  local -a clause_array
  [[ -n "$clauses" ]] || return 0
  IFS=',' read -ra clause_array <<<"$clauses"
  for clause in "${clause_array[@]}"; do
    [[ -n "$clause" ]] && append_missing_clause "$var_name" "$clause"
  done
}

private_log() {
  local path="$1"
  : >"$path"
  chmod 600 "$path"
}

seal_private() {
  local path
  for path in "$@"; do
    [[ -e "$path" ]] && chmod 600 "$path"
  done
}

current_api_pod() {
  kubectl_t -n "$app_ns" get pod -l 'app.kubernetes.io/name=ptr,app.kubernetes.io/component=api' \
    -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}'
}

current_worker_pod() {
  kubectl_t -n "$app_ns" get pod -l 'app.kubernetes.io/name=ptr,app.kubernetes.io/component=worker' \
    -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}'
}

current_engine_pod() {
  kubectl_t -n "$inference_ns" get pod -l 'app.kubernetes.io/name=ptr,app.kubernetes.io/component=inference-engine' \
    -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}'
}

api_image() {
  kubectl_t -n "$app_ns" get deployment ptr-api -o jsonpath='{.spec.template.spec.containers[0].image}'
}

cleanup_client() {
  if [[ -n "${client_pod:-}" ]]; then
    timeout 30s kubectl --context "$context" -n "$app_ns" delete "pod/$client_pod" "networkpolicy/${client_pod}-egress" "networkpolicy/${client_pod}-ingress" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    client_pod=""
  fi
}

cleanup_job() {
  if [[ -n "${created_job:-}" ]]; then
    timeout 60s kubectl --context "$context" -n "$app_ns" delete job "$created_job" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    created_job=""
  fi
  timeout 60s kubectl --context "$context" -n "$app_ns" delete job,configmap,networkpolicy \
    -l "ptr.io/k8s-acceptance-run=$run_id" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  timeout 60s kubectl --context "$context" -n "$app_ns" delete cronjob \
    -l "ptr.io/k8s-acceptance-run=$run_id" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}


restore_redis_replicas() {
  if [[ -n "${original_redis_replicas:-}" ]]; then
    timeout 60s kubectl --context "$context" -n "$data_ns" scale statefulset/ptr-redis --replicas="$original_redis_replicas" >/dev/null || { echo "restore failed: Redis replicas" >&2; return 1; }
    timeout 180s kubectl --context "$context" -n "$data_ns" rollout status statefulset/ptr-redis >/dev/null || { echo "restore failed: Redis rollout" >&2; return 1; }
    original_redis_replicas=""
  fi
}

restore_node() {
  if [[ -n "${drained_node:-}" ]]; then
    timeout 60s kubectl --context "$context" uncordon "$drained_node" >/dev/null || { echo "restore failed: node uncordon" >&2; return 1; }
    drained_node=""
  fi
}

restore_engine_replicas() {
  if [[ -n "${original_engine_replicas:-}" ]]; then
    timeout 120s kubectl --context "$context" -n "$inference_ns" scale deployment/ptr-sim --replicas="$original_engine_replicas" >/dev/null || { echo "restore failed: engine replicas" >&2; return 1; }
    timeout 180s kubectl --context "$context" -n "$inference_ns" rollout status deployment/ptr-sim >/dev/null || { echo "restore failed: engine rollout" >&2; return 1; }
    original_engine_replicas=""
  fi
}

restore_engine_min() {
  if [[ -n "${original_engine_min:-}" ]]; then
    kind_helm_upgrade --set autoscaling.engine.minReplicaCount="$original_engine_min" >/dev/null || { echo "restore failed: engine minimum" >&2; return 1; }
    original_engine_min=""
  fi
}



restore_engine_values_file() {
  if [[ -n "${restore_engine_values:-}" ]]; then
    kind_helm_upgrade \
      --set inference.engine.timeToFirstToken="${original_engine_time_to_first_token:-8s}" \
      --set inference.engine.interTokenLatency="${original_engine_inter_token_latency:-0s}" >/dev/null || { echo "restore failed: engine latency values" >&2; return 1; }
    restore_engine_values=""
    original_engine_time_to_first_token=""
    original_engine_inter_token_latency=""
  fi
}


pause_worker_autoscaling() {
  worker_autoscaling_restore_needed=1
  original_worker_scaledobject_paused="$(kubectl_t -n "$app_ns" get scaledobject ptr-worker -o jsonpath='{.metadata.annotations.autoscaling\.keda\.sh/paused}' 2>/dev/null || true)"
  original_worker_replicas="$(kubectl_t -n "$app_ns" get deployment ptr-worker -o jsonpath='{.spec.replicas}')"
  kubectl_t -n "$app_ns" annotate scaledobject ptr-worker autoscaling.keda.sh/paused=true --overwrite >/dev/null
  kubectl_t -n "$app_ns" scale deployment/ptr-worker --replicas=0 >/dev/null
  kubectl_t -n "$app_ns" rollout status deployment/ptr-worker --timeout=180s >/dev/null
}

restore_worker_autoscaling() {
  if [[ -n "${worker_autoscaling_restore_needed:-}" ]]; then
    if [[ -n "${original_worker_scaledobject_paused:-}" ]]; then
      timeout 60s kubectl --context "$context" -n "$app_ns" annotate scaledobject ptr-worker autoscaling.keda.sh/paused="$original_worker_scaledobject_paused" --overwrite >/dev/null || { echo "restore failed: worker autoscaling annotation" >&2; return 1; }
    else
      timeout 60s kubectl --context "$context" -n "$app_ns" annotate scaledobject ptr-worker autoscaling.keda.sh/paused- >/dev/null || { echo "restore failed: worker autoscaling annotation" >&2; return 1; }
    fi
    original_worker_scaledobject_paused=""
    worker_autoscaling_restore_needed=""
  fi
}

restore_worker_replicas() {
  if [[ -n "${original_worker_replicas:-}" ]]; then
    timeout 120s kubectl --context "$context" -n "$app_ns" scale deployment/ptr-worker --replicas="$original_worker_replicas" >/dev/null || { echo "restore failed: worker replicas" >&2; return 1; }
    timeout 180s kubectl --context "$context" -n "$app_ns" rollout status deployment/ptr-worker >/dev/null || { echo "restore failed: worker rollout" >&2; return 1; }
    original_worker_replicas=""
  fi
}

restore_api_replicas() {
  if [[ -n "${original_api_replicas:-}" ]]; then
    kind_helm_upgrade >/dev/null || { echo "restore failed: API replicas" >&2; return 1; }
    original_api_replicas=""
  fi
}

cleanup_all() {
  local status=0
  cleanup_client
  cleanup_job
  restore_redis_replicas || status=1
  restore_node || status=1
  restore_worker_autoscaling || status=1
  restore_worker_replicas || status=1
  restore_engine_values_file || status=1
  restore_api_replicas || status=1
  restore_engine_min || status=1
  restore_engine_replicas || status=1
  return "$status"
}
finish() {
  local status=$?
  trap - EXIT
  cleanup_all || status=1
  exit "$status"
}
trap finish EXIT

create_api_client() {
  cleanup_client
  client_pod="ptr-accept-${run_id}-${1,,}"
  local image manifest
  image="$(api_image)"
  manifest="$(mktemp)"
  cat >"$manifest" <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: ${client_pod}
  namespace: ${app_ns}
  labels:
    app.kubernetes.io/name: ptr
    app.kubernetes.io/component: acceptance-client
    ptr.io/k8s-acceptance-client: "true"
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 900
    runAsGroup: 2000
    fsGroup: 2000
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: client
      image: ${image}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ec", "sleep 3600"]
      env:
        - name: PTR_API_SYNTHETIC_TOKEN
          valueFrom: {secretKeyRef: {name: ptr-api, key: PTR_API_SYNTHETIC_TOKEN}}
        - name: HOME
          value: /tmp
        - name: TMPDIR
          value: /tmp
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        runAsNonRoot: true
        capabilities: {drop: ["ALL"]}
      volumeMounts:
        - {name: tmp, mountPath: /tmp}
  volumes:
    - name: tmp
      emptyDir: {}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${client_pod}-egress
  namespace: ${app_ns}
spec:
  podSelector:
    matchLabels:
      ptr.io/k8s-acceptance-client: "true"
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: kube-system}
          podSelector:
            matchLabels: {k8s-app: kube-dns}
      ports:
        - {protocol: UDP, port: 53}
        - {protocol: TCP, port: 53}
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: ptr
              app.kubernetes.io/component: api
      ports:
        - {protocol: TCP, port: 56441}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${client_pod}-ingress
  namespace: ${app_ns}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ptr
      app.kubernetes.io/component: api
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              ptr.io/k8s-acceptance-client: "true"
      ports:
        - {protocol: TCP, port: 56441}
YAML
  kubectl_t apply -f "$manifest" >/dev/null
  rm -f "$manifest"
  kubectl_t -n "$app_ns" wait --for=condition=Ready "pod/$client_pod" --timeout=90s >/dev/null
}

client_node() {
  timeout "${CLIENT_TIMEOUT:-900s}" kubectl --context "$context" -n "$app_ns" exec -i "$client_pod" -- env "$@" node --input-type=module -
}

api_node() {
  local pod
  pod="$(current_api_pod)"
  if [[ -z "$pod" ]]; then
    echo "missing running api pod" >&2
    return 1
  fi
  timeout "${API_EXEC_TIMEOUT:-120s}" kubectl --context "$context" -n "$app_ns" exec -i "$pod" -- env "$@" node --input-type=module -
}

worker_python() {
  local pod
  pod="$(current_worker_pod)"
  if [[ -z "$pod" ]]; then
    echo "missing running worker pod" >&2
    return 1
  fi
  timeout "${WORKER_EXEC_TIMEOUT:-120s}" kubectl --context "$context" -n "$app_ns" exec -i "$pod" -- env "$@" python -
}

probe_job_name() {
  printf 'ptr-accept-%s-%s' "$run_id" "${1,,}"
}

probe_script_configmap() {
  printf '%s-script' "$(probe_job_name "$1")"
}

probe_file() {
  printf '%s/%s-%s.private.log' "$evidence_dir" "$1" "$2"
}

apply_probe_job() {
  local test="$1" prefix="$2" count="$3" concurrency="$4" poll_attempts="$5" script_kind="$6"
  local job script_cm file image
  job="$(probe_job_name "$test")"
  script_cm="$(probe_script_configmap "$test")"
  file="$(probe_file "$test" "$prefix")"
  image="$(api_image)"
  private_log "$file"
  {
    cat <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: ${script_cm}
  namespace: ${app_ns}
  labels:
    ptr.io/k8s-acceptance-run: ${run_id}
data:
  probe.mjs: |
YAML
    if [[ "$script_kind" == "sse" ]]; then
      sse_reconnect_js | sed 's/^/    /'
    else
      submit_and_poll_js | sed 's/^/    /'
    fi
    cat <<YAML
---
apiVersion: batch/v1
kind: Job
metadata:
  name: ${job}
  namespace: ${app_ns}
  labels:
    ptr.io/k8s-acceptance-run: ${run_id}
    ptr.io/k8s-acceptance-test: ${test}
spec:
  backoffLimit: 0
  template:
    metadata:
      labels:
        ptr.io/k8s-acceptance-run: ${run_id}
        ptr.io/k8s-acceptance-test: ${test}
        ptr.io/k8s-acceptance-client: "true"
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 900
        runAsGroup: 2000
        fsGroup: 2000
        seccompProfile: {type: RuntimeDefault}
      containers:
        - name: client
          image: ${image}
          imagePullPolicy: IfNotPresent
          command: ["node", "/scripts/probe.mjs"]
          env:
            - name: PTR_API_SYNTHETIC_TOKEN
              valueFrom: {secretKeyRef: {name: ptr-api, key: PTR_API_SYNTHETIC_TOKEN}}
            - {name: REQUEST_PREFIX, value: "${prefix}"}
            - {name: TURN_COUNT, value: "${count}"}
            - {name: TURN_CONCURRENCY, value: "${concurrency}"}
            - {name: POLL_ATTEMPTS, value: "${poll_attempts}"}
            - {name: FIRST_SSE_MS, value: "${FIRST_SSE_MS:-1200}"}
            - {name: SECOND_SSE_MS, value: "${SECOND_SSE_MS:-120000}"}
            - {name: EXPECT_TERMINAL_ANY, value: "${EXPECT_TERMINAL_ANY:-0}"}
            - {name: CREATE_SESSION_ONLY, value: "${CREATE_SESSION_ONLY:-0}"}
            - {name: EXISTING_SESSION_ID, value: "${EXISTING_SESSION_ID:-}"}
            - {name: HOME, value: /tmp}
            - {name: TMPDIR, value: /tmp}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            capabilities: {drop: ["ALL"]}
          volumeMounts:
            - {name: script, mountPath: /scripts, readOnly: true}
            - {name: tmp, mountPath: /tmp}
      volumes:
        - name: script
          configMap:
            name: ${script_cm}
        - name: tmp
          emptyDir: {}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${job}-egress
  namespace: ${app_ns}
  labels:
    ptr.io/k8s-acceptance-run: ${run_id}
spec:
  podSelector:
    matchLabels:
      ptr.io/k8s-acceptance-run: ${run_id}
      ptr.io/k8s-acceptance-test: ${test}
  policyTypes: [Egress]
  egress:
    - to:
        - namespaceSelector:
            matchLabels: {kubernetes.io/metadata.name: kube-system}
          podSelector:
            matchLabels: {k8s-app: kube-dns}
      ports:
        - {protocol: UDP, port: 53}
        - {protocol: TCP, port: 53}
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: ptr
              app.kubernetes.io/component: api
      ports:
        - {protocol: TCP, port: 56441}
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: ${job}-ingress
  namespace: ${app_ns}
  labels:
    ptr.io/k8s-acceptance-run: ${run_id}
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/name: ptr
      app.kubernetes.io/component: api
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector:
            matchLabels:
              ptr.io/k8s-acceptance-run: ${run_id}
              ptr.io/k8s-acceptance-test: ${test}
      ports:
        - {protocol: TCP, port: 56441}
YAML
  } | kubectl_t apply -f - >/dev/null
  for _ in {1..30}; do
    if kubectl_t -n "$app_ns" get pod -l "job-name=$job" -o name | timeout 10s grep -q .; then
      kubectl_t -n "$app_ns" wait --for=condition=Ready pod -l "job-name=$job" --timeout=60s >/dev/null
      return 0
    fi
    timeout 2s sleep 1
  done
  echo "probe job pod did not appear for $job" >&2
  return 1
}

wait_probe_job() {
  local test="$1" prefix="$2" expected="$3" timeout_seconds="${4:-900}" file job wait_rc
  job="$(probe_job_name "$test")"
  file="$(probe_file "$test" "$prefix")"
  wait_rc=124
  local deadline status
  deadline="$(($(date +%s) + timeout_seconds))"
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    status="$(kubectl_t -n "$app_ns" get job "$job" -o jsonpath='{range .status.conditions[*]}{.type}={.status}{" "}{end}' 2>/dev/null || true)"
    if [[ "$status" == *"Complete=True"* ]]; then
      wait_rc=0
      break
    fi
    if [[ "$status" == *"Failed=True"* ]]; then
      wait_rc=2
      break
    fi
    timeout 2s sleep 1
  done
  timeout 60s kubectl --context "$context" -n "$app_ns" logs "job/$job" --tail=-1 >>"$file" 2>&1 || true
  append_db_proof "$prefix" "$file"
  seal_private "$file"
  [[ "$wait_rc" == "0" ]] && proof_passes "$file" "$expected"
}

submit_and_poll_js() {
  cat <<'NODE'
const count = Number(process.env.TURN_COUNT || '8');
const concurrency = Number(process.env.TURN_CONCURRENCY || '4');
const prefix = process.env.REQUEST_PREFIX;
const owner = process.env.REQUEST_OWNER || 'lt-k5-synthetic';
const terminal = new Set(['completed', 'failed', 'cancelled']);
const api = 'http://ptr-api.ptr-app.svc.cluster.local:56441/api/';
if (!prefix || !/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error('INVALID_PREFIX');
async function request(path, body, timeoutMs = 15000) {
  const response = await fetch(api + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${process.env.PTR_API_SYNTHETIC_TOKEN}`, 'X-PTR-Owner': owner, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}
async function one(index) {
  const marker = `${prefix}-${String(index).padStart(4, '0')}`;
  const sessionId = process.env.EXISTING_SESSION_ID || (await request('sessions', {personId: 'synthetic-split-person', retrievalMode: 'off', ragCondition: 'off', executionProfile: 'agent_loop'})).session.id;
  const created = await request(`sessions/${sessionId}/turns`, {clientRequestId: marker, text: JSON.stringify({message: `K4_ID:${marker}`, status: 'answered', evidenceRefs: [], variableUpdates: {}})});
  const turnId = created.turn.id;
  let final = created.turn;
  for (let attempt = 0; attempt < Number(process.env.POLL_ATTEMPTS || '360'); attempt++) {
    final = (await request(`turns/${turnId}`, undefined, 10000)).turn;
    if (terminal.has(final.state)) break;
    await new Promise(resolve => setTimeout(resolve, Number(process.env.POLL_MS || '500')));
  }
  return {turnId, marker, state: final?.state || 'timeout', errorCode: final?.errorCode || null};
}
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({length: Math.min(limit, items.length)}, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) break;
      try { results[index] = await fn(items[index]); }
      catch (error) { results[index] = {marker: `${prefix}-${String(items[index]).padStart(4, '0')}`, state: 'client_error', errorCode: error?.message || error?.name || 'CLIENT_ERROR'}; }
    }
  }));
  return results;
}
if (process.env.CREATE_SESSION_ONLY === '1') {
  const session = await request('sessions', {personId: 'synthetic-split-person', retrievalMode: 'off', ragCondition: 'off', executionProfile: 'agent_loop'});
  console.log(JSON.stringify({event: 'session_precreated', prefix, sessionId: session.session.id}));
} else {
  const results = await mapLimit(Array.from({length: count}, (_, index) => index), concurrency, one);
  const counts = {};
  for (const row of results) counts[`${row.state}:${row.errorCode || 'none'}`] = (counts[`${row.state}:${row.errorCode || 'none'}`] || 0) + 1;
  console.log(JSON.stringify({event: 'turn_probe', prefix, count, results, counts}));
  if (results.some(row => row.state !== 'completed')) process.exitCode = 2;
}
NODE
}

session_id_from_probe() {
  timeout 10s python3 - "$1" <<'PY'
import json,sys
session=''
for line in open(sys.argv[1], errors='replace'):
    if not line.startswith('{'):
        continue
    try: row=json.loads(line)
    except Exception: continue
    if row.get('event')=='session_precreated':
        session=row.get('sessionId') or ''
print(session)
PY
}

sse_reconnect_js() {
  cat <<'NODE'
const prefix = process.env.REQUEST_PREFIX;
const owner = process.env.REQUEST_OWNER || 'lt-k5-synthetic';
const api = 'http://ptr-api.ptr-app.svc.cluster.local:56441/api/';
async function request(path, body, timeoutMs = 15000) {
  const response = await fetch(api + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {Authorization: `Bearer ${process.env.PTR_API_SYNTHETIC_TOKEN}`, 'X-PTR-Owner': owner, 'Content-Type': 'application/json'},
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response;
}
async function readEvents(turnId, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const frames = [];
  try {
    const response = await fetch(api + `turns/${turnId}/events`, {headers: {Authorization: `Bearer ${process.env.PTR_API_SYNTHETIC_TOKEN}`, 'X-PTR-Owner': owner}, signal: controller.signal});
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    const reader = response.body.getReader();
    let text = '';
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
      let split;
      while ((split = text.indexOf('\n\n')) >= 0) {
        frames.push(text.slice(0, split));
        text = text.slice(split + 2);
      }
    }
  } catch (error) {
    if (error?.name !== 'AbortError') frames.push(`error:${error?.message || error?.name || 'unknown'}`);
  } finally {
    clearTimeout(timer);
  }
  return frames;
}
const session = await (await request('sessions', {personId: 'synthetic-split-person', retrievalMode: 'off', ragCondition: 'off', executionProfile: 'agent_loop'})).json();
const turn = await (await request(`sessions/${session.session.id}/turns`, {clientRequestId: `${prefix}-sse`, text: JSON.stringify({message: `K4_ID:${prefix}-sse`, status: 'answered', evidenceRefs: [], variableUpdates: {}})})).json();
const turnId = turn.turn.id;
const first = await readEvents(turnId, Number(process.env.FIRST_SSE_MS || '1500'));
const second = await readEvents(turnId, Number(process.env.SECOND_SSE_MS || '120000'));
let final;
for (let attempt = 0; attempt < 240; attempt++) {
  final = await (await request(`turns/${turnId}`, undefined, 10000)).json();
  if (['completed', 'failed', 'cancelled'].includes(final.turn.state)) break;
  await new Promise(resolve => setTimeout(resolve, 500));
}
console.log(JSON.stringify({event: 'sse_reconnect_probe', prefix, turnId, firstFrames: first.length, secondFrames: second.length, finalState: final?.turn?.state || 'unknown'}));
const terminalOk = ['completed', 'failed', 'cancelled'].includes(final?.turn?.state);
if (second.length === 0 || (process.env.EXPECT_TERMINAL_ANY === '1' ? !terminalOk : final?.turn?.state !== 'completed')) process.exitCode = 2;
NODE
}

app_proof_js() {
  cat <<'NODE'
import pg from 'pg';
const {Client} = pg;
const prefix = process.env.REQUEST_PREFIX;
const client = new Client({connectionString: process.env.PTR_APP_DATABASE_URL});
await client.connect();
try {
  const q = await client.query(`WITH target AS (
      SELECT id, state, error_code FROM app.turns WHERE client_request_id LIKE $1
    ), assistant_counts AS (
      SELECT t.id, count(m.*)::int AS n FROM target t LEFT JOIN app.messages m ON m.turn_id=t.id AND m.role='assistant' GROUP BY t.id
    ), grant_counts AS (
      SELECT t.id, count(g.*)::int AS n FROM target t LEFT JOIN app.turn_execution_grants g ON g.turn_id=t.id AND g.result_hash IS NOT NULL GROUP BY t.id
    ), execution_counts AS (
      SELECT t.id, count(g.*)::int AS n, array_remove(array_agg(g.execution_id ORDER BY g.execution_id), NULL) AS execution_ids
      FROM target t
      LEFT JOIN app.turn_execution_grants g ON g.turn_id=t.id
      GROUP BY t.id
    )
    SELECT count(*)::int AS observed,
      (count(*) FILTER (WHERE t.state IN ('completed','failed','cancelled')))::int AS terminal,
      (count(*) FILTER (WHERE t.state='completed'))::int AS completed,
      (count(*) FILTER (WHERE t.state='failed'))::int AS failed,
      (count(*) FILTER (WHERE t.state='cancelled'))::int AS cancelled,
      COALESCE((SELECT count(*)::int FROM app.turn_outbox o JOIN target x ON x.id=o.turn_id),0)::int AS outbox,
      (count(*) FILTER (WHERE t.state='completed' AND a.n <> 1))::int AS assistant_not_exactly_once,
      (count(*) FILTER (WHERE t.state='completed' AND g.n <> 1))::int AS grants_not_exactly_once,
      (count(*) FILTER (WHERE t.state='completed' AND (a.n > 1 OR g.n > 1)))::int AS duplicate_completion_rows,
      (count(*) FILTER (WHERE e.n > 1))::int AS turns_with_multiple_executions,
      COALESCE(max(e.n),0)::int AS max_executions,
      COALESCE(jsonb_agg(jsonb_build_object('turnId', t.id, 'state', t.state, 'executionIds', e.execution_ids)) FILTER (WHERE t.id IS NOT NULL), '[]'::jsonb) AS turn_executions,
      COALESCE(jsonb_object_agg(COALESCE(t.error_code,'none'), c.n) FILTER (WHERE c.n IS NOT NULL), '{}'::jsonb) AS error_codes
    FROM target t
    JOIN assistant_counts a ON a.id=t.id
    JOIN grant_counts g ON g.id=t.id
    JOIN execution_counts e ON e.id=t.id
    LEFT JOIN (SELECT COALESCE(error_code,'none') AS code, count(*)::int AS n FROM target GROUP BY COALESCE(error_code,'none')) c ON c.code=COALESCE(t.error_code,'none')`, [`${prefix}-%`]);
  console.log(JSON.stringify({event: 'app_db_proof', prefix, ...q.rows[0]}));
} finally {
  await client.end();
}
NODE
}

receipt_proof_py() {
  cat <<'PY'
import json, os, psycopg
prefix=os.environ.get('REQUEST_PREFIX','')
executions=[]
for item in os.environ.get('EXECUTION_IDS','').split(','):
    if item:
        executions.append(item)
rows=[]
if executions:
    with psycopg.connect(os.environ['PTR_LLM_DATABASE_URL'], connect_timeout=3) as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT execution_id, acknowledged_at FROM llm.result_receipts WHERE execution_id = ANY(%s) ORDER BY execution_id', (executions,))
            rows=[{'executionId': row[0], 'acknowledgedAt': row[1].isoformat() if row[1] is not None else None} for row in cur.fetchall()]
acked=sum(1 for row in rows if row.get('acknowledgedAt'))
print(json.dumps({'event':'receipt_db_proof','prefix':prefix,'expectedExecutions':len(executions),'receiptRows':len(rows),'ackedReceipts':acked,'receipts':rows}, separators=(',',':')))
PY
}

proof_execution_ids() {
  timeout 10s python3 - "$1" <<'PY'
import json,sys
ids=[]
for line in open(sys.argv[1], errors='replace'):
    if not line.startswith('{'):
        continue
    try: row=json.loads(line)
    except Exception: continue
    if row.get('event')=='app_db_proof':
        ids=[]
        for turn in row.get('turn_executions') or []:
            if turn.get('state')=='completed':
                ids.extend(turn.get('executionIds') or [])
print(','.join(ids))
PY
}

append_db_proof() {
  local prefix="$1" file="$2" execution_ids
  api_node REQUEST_PREFIX="$prefix" < <(app_proof_js) >>"$file" 2>&1 || true
  execution_ids="$(proof_execution_ids "$file")"
  worker_python REQUEST_PREFIX="$prefix" EXECUTION_IDS="$execution_ids" < <(receipt_proof_py) >>"$file" 2>&1 || true
}


run_probe() {
  local test="$1" count="$2" concurrency="$3" prefix="$4" output="$evidence_dir/${test}-${prefix}.private.log"
  private_log "$output"
  create_api_client "$test"
  if client_node REQUEST_PREFIX="$prefix" TURN_COUNT="$count" TURN_CONCURRENCY="$concurrency" < <(submit_and_poll_js) >"$output" 2>&1; then
    append_db_proof "$prefix" "$output"
    return 0
  fi
  append_db_proof "$prefix" "$output" || true
  return 1
}

summarize_probe() {
  python3 - "$1" <<'PY'
import json,sys
rows=[]
for line in open(sys.argv[1]):
    if line.startswith('{'):
        try: rows.append(json.loads(line))
        except Exception: pass
probe=next((r for r in rows if r.get('event')=='turn_probe'),{})
proof=next((r for r in rows if r.get('event')=='app_db_proof'),{})
receipt=next((r for r in rows if r.get('event')=='receipt_db_proof'),{})
print('expected=%s observed=%s terminal=%s completed=%s failed=%s outbox=%s duplicate=%s assistant_bad=%s grants_bad=%s acked=%s multi_exec=%s max_exec=%s' % (
    probe.get('count','na'), proof.get('observed','na'), proof.get('terminal','na'), proof.get('completed','na'), proof.get('failed','na'), proof.get('outbox','na'), proof.get('duplicate_completion_rows','na'), proof.get('assistant_not_exactly_once','na'), proof.get('grants_not_exactly_once','na'), receipt.get('ackedReceipts','na'), proof.get('turns_with_multiple_executions','na'), proof.get('max_executions','na')))
PY
}

proof_passes() {
  python3 - "$1" "$2" <<'PY'
import json,sys
proof={}
receipt={}
for line in open(sys.argv[1]):
    if line.startswith('{'):
        try: row=json.loads(line)
        except Exception: continue
        if row.get('event')=='app_db_proof': proof=row
        if row.get('event')=='receipt_db_proof': receipt=row
expected=int(sys.argv[2])
ok=(proof.get('observed')==expected and proof.get('terminal')==expected and proof.get('completed')==expected and proof.get('outbox')==0 and proof.get('duplicate_completion_rows')==0 and proof.get('assistant_not_exactly_once')==0 and proof.get('grants_not_exactly_once')==0 and int(receipt.get('ackedReceipts') or -1)==int(receipt.get('expectedExecutions') or -2) and int(receipt.get('expectedExecutions') or 0)>0 and proof.get('turns_with_multiple_executions')==0 and int(proof.get('max_executions') or 0) <= 1)
raise SystemExit(0 if ok else 1)
PY
}

probe_missing_clauses() {
  timeout 10s python3 - "$1" "$2" "${3:-1}" "${4:-1}" <<'PY'
import json,sys
path=sys.argv[1]
expected=int(sys.argv[2])
require_receipts=sys.argv[3] != "0"
require_completed=sys.argv[4] != "0"
proof={}
receipt={}
for line in open(path, errors='replace'):
    if line.startswith('{'):
        try: row=json.loads(line)
        except Exception: continue
        if row.get('event')=='app_db_proof': proof=row
        if row.get('event')=='receipt_db_proof': receipt=row
missing=[]
if proof.get('observed') != expected or proof.get('terminal') != expected:
    missing.append('all_turns_terminal')
if require_completed and (proof.get('completed') != expected or proof.get('failed') not in (0, None)):
    missing.append('zero_failed_turns')
if proof.get('outbox') != 0:
    missing.append('zero_outbox_rows')
if proof.get('duplicate_completion_rows') != 0:
    missing.append('zero_duplicate_completion_rows')
if proof.get('assistant_not_exactly_once') != 0:
    missing.append('assistant_messages_exactly_once')
if proof.get('grants_not_exactly_once') != 0:
    missing.append('execution_grants_exactly_once')
if proof.get('turns_with_multiple_executions') != 0 or int(proof.get('max_executions') or 0) > 1:
    missing.append('zero_resubmissions')
if require_receipts:
    acked=int(receipt.get('ackedReceipts') or -1)
    expected_exec=int(receipt.get('expectedExecutions') or -2)
    if acked != expected_exec or expected_exec <= 0:
        missing.append('result_receipts_acked')
if not proof:
    missing.append('app_db_proof_present')
print(','.join(dict.fromkeys(missing)))
PY
}

v9_terminal_proof_passes() {
  timeout 10s python3 - "$1" <<'PY'
import json, sys
proof = {}
for line in open(sys.argv[1], errors='replace'):
    if not line.startswith('{'):
        continue
    try:
        row = json.loads(line)
    except json.JSONDecodeError:
        continue
    if row.get('event') == 'app_db_proof':
        proof = row
ok = (proof.get('observed') == 24 and proof.get('terminal') == 24
      and proof.get('outbox') == 0 and proof.get('duplicate_completion_rows') == 0)
raise SystemExit(0 if ok else 1)
PY
}

synthetic_db_counts_js() {
  cat <<'NODE'
import pg from 'pg';
const {Client} = pg;
const client = new Client({connectionString: process.env.PTR_APP_DATABASE_URL});
await client.connect();
try {
  const result = await client.query(`
    SELECT current_database() AS database,
      (SELECT count(*)::int FROM app.sessions WHERE person_id LIKE 'synthetic-%' OR owner_id LIKE '%synthetic%') AS synthetic_sessions,
      (SELECT count(*)::int FROM app.turns WHERE owner_id LIKE '%synthetic%') AS synthetic_turns,
      (SELECT count(*)::int FROM app.messages m JOIN app.sessions s ON s.id=m.session_id WHERE s.person_id LIKE 'synthetic-%' OR s.owner_id LIKE '%synthetic%') AS synthetic_messages,
      (SELECT count(*)::int FROM app.turn_outbox) AS outbox_rows,
      (SELECT count(*)::int FROM app.turn_execution_grants) AS execution_grants`);
  console.log(JSON.stringify({event: 'synthetic_db_counts', ...result.rows[0]}));
} finally {
  await client.end();
}
NODE
}

append_synthetic_db_counts() {
  local label="$1" file="$2"
  printf 'db_counts_label=%s\n' "$label" >>"$file"
  api_node < <(synthetic_db_counts_js) >>"$file" 2>&1 || true
}

synthetic_before_database() {
  timeout 10s python3 - "$1" <<'PY'
import json,sys
label=None
for line in open(sys.argv[1], errors='replace'):
    if line.startswith('db_counts_label='):
        label=line.strip().split('=',1)[1]
        continue
    if label != 'before' or not line.startswith('{'):
        continue
    try:
        item=json.loads(line)
    except Exception:
        continue
    if item.get('event') == 'synthetic_db_counts' and item.get('database'):
        print(item['database'])
        raise SystemExit(0)
raise SystemExit(1)
PY
}

compare_synthetic_counts() {
  timeout 10s python3 - "$1" <<'PY'
import json,sys
rows=[]; marker=None; label=None
for line in open(sys.argv[1], errors='replace'):
    if line.startswith('db_counts_label='):
        label=line.strip().split('=',1)[1]
        continue
    if not line.startswith('{'):
        continue
    try: item=json.loads(line)
    except Exception: continue
    if item.get('event')=='synthetic_db_counts':
        item['_label']=label
        rows.append(item)
    elif item.get('event')=='synthetic_marker_write':
        marker=item
before=next((r for r in rows if r.get('_label')=='before'),None)
after=next((r for r in rows if r.get('_label')=='after'),None)
if not before or not after:
    print('db_before_after=missing')
    raise SystemExit(1)
if not marker:
    print('synthetic_marker_write=missing')
    raise SystemExit(1)
keys=['synthetic_sessions','synthetic_turns','synthetic_messages','outbox_rows','execution_grants']
delta={k:int(after[k])-int(before[k]) for k in keys}
before_db=before.get('database')
after_db=after.get('database')
marker_db=marker.get('database')
expected_db=marker.get('expectedDatabase')
same_db=bool(before_db) and before_db==after_db==marker_db==expected_db
marker_before=int(marker.get('beforeMarkerCount') or 0)
marker_after=int(marker.get('afterMarkerCount') or 0)
marker_inserted=int(marker.get('inserted') or 0)
marker_changed=(marker_after-marker_before)==1 and marker_inserted==1
queues_unchanged=delta['outbox_rows']==0 and delta['execution_grants']==0
print('database=%s same_synthetic_db=%s synthetic_marker_changed=%s queue_delta_clean=%s marker_before=%s marker_after=%s db_delta=%s' % (after_db, int(same_db), int(marker_changed), int(queues_unchanged), marker_before, marker_after, json.dumps(delta,sort_keys=True)))
raise SystemExit(0 if same_db and marker_changed and queues_unchanged else 1)
PY
}

manual_v11_job_from_cron() {
  local source="$1" job="$2" expected_database="$3" worker_image="$4"
  timeout 10s python3 - "$job" "$run_id" "$expected_database" "$worker_image" <(kubectl_t -n "$app_ns" get cronjob "$source" -o json) <<'PY' |
import json,sys
cron=json.load(open(sys.argv[5]))
job_name=sys.argv[1]
run_id=sys.argv[2]
expected_database=sys.argv[3]
worker_image=sys.argv[4]
spec=cron["spec"]["jobTemplate"]["spec"]
job={
  "apiVersion":"batch/v1",
  "kind":"Job",
  "metadata":{
    "name":job_name,
    "namespace":cron["metadata"]["namespace"],
    "labels":{
      "ptr.io/k8s-acceptance-run":run_id,
      "ptr.io/k8s-acceptance-test":"V11",
      "ptr.io/k8s-acceptance-manual":"true",
    },
  },
  "spec":spec,
}
tmpl=job["spec"]["template"]
labels=tmpl.setdefault("metadata",{}).setdefault("labels",{})
labels["ptr.io/k8s-acceptance-run"]=run_id
labels["ptr.io/k8s-acceptance-test"]="V11"
container=tmpl["spec"]["containers"][0]
if worker_image:
    container["image"]=worker_image
env=container.setdefault("env",[])
env=[e for e in env if e.get("name") not in {"PTR_ACCEPTANCE_RUN_ID","PTR_EXPECTED_DATABASE","PTR_MAINTENANCE_APPLY","PTR_MAINTENANCE_SYNTHETIC_ONLY","PTR_MAINTENANCE_DAILY_LIMIT"}]
env.extend([
  {"name":"PTR_ACCEPTANCE_RUN_ID","value":run_id},
  {"name":"PTR_EXPECTED_DATABASE","value":expected_database},
  {"name":"PTR_MAINTENANCE_APPLY","value":"1"},
  {"name":"PTR_MAINTENANCE_SYNTHETIC_ONLY","value":"1"},
  {"name":"PTR_MAINTENANCE_DAILY_LIMIT","value":"1"},
])
container["env"]=env
container["command"]=["/bin/sh","-ec",r'''
python3 - <<'PYMARKER'
import json, os, sys
import psycopg

def emit(payload):
    print(json.dumps(payload, separators=(",",":")), flush=True)

dsn = os.environ.get("PTR_MAINTENANCE_DATABASE_URL") or os.environ.get("PTR_LLM_MAINTENANCE_DATABASE_URL") or os.environ.get("PTR_APP_DATABASE_URL") or os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL")
if not dsn:
    emit({"event":"synthetic_marker_write","ok":False,"reason":"missing_database_url"})
    raise SystemExit(2)
run_id = os.environ["PTR_ACCEPTANCE_RUN_ID"]
expected = os.environ["PTR_EXPECTED_DATABASE"]
with psycopg.connect(dsn, connect_timeout=5) as conn:
    with conn.cursor() as cur:
        cur.execute("SELECT current_database()")
        database = cur.fetchone()[0]
        if database != expected:
            emit({"event":"synthetic_marker_write","ok":False,"database":database,"expectedDatabase":expected,"reason":"database_mismatch"})
            raise SystemExit(3)
        cur.execute("SELECT to_regclass('app.synthetic_acceptance_markers')")
        table_exists = cur.fetchone()[0] is not None
        if table_exists:
            cur.execute("SELECT count(*) FROM app.synthetic_acceptance_markers")
            before = int(cur.fetchone()[0])
        else:
            before = 0
        cur.execute("CREATE TABLE IF NOT EXISTS app.synthetic_acceptance_markers (run_id text NOT NULL, marker text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (run_id, marker))")
        cur.execute("INSERT INTO app.synthetic_acceptance_markers(run_id, marker) VALUES (%s, %s) ON CONFLICT DO NOTHING", (run_id, "v11-db-change"))
        inserted = cur.rowcount
        cur.execute("SELECT count(*) FROM app.synthetic_acceptance_markers")
        after = int(cur.fetchone()[0])
    conn.commit()
emit({"event":"synthetic_marker_write","ok":True,"database":database,"expectedDatabase":expected,"beforeMarkerCount":before,"afterMarkerCount":after,"inserted":inserted})
PYMARKER
''']
container.pop("args",None)
print(json.dumps(job))
PY
    kubectl_t apply -f - >/dev/null
}

cronjob_forbid_probe() {
  local source="$1" temp="$2" file="$3"
  timeout 10s python3 - "$temp" "$run_id" <(kubectl_t -n "$app_ns" get cronjob "$source" -o json) <<'PY' |
import json,sys
doc=json.load(open(sys.argv[3]))
name=sys.argv[1]
run_id=sys.argv[2]
doc.pop('status', None)
metadata=doc.setdefault('metadata',{})
for key in ['uid','resourceVersion','generation','creationTimestamp','managedFields']:
    metadata.pop(key,None)
metadata['name']=name
metadata.setdefault('labels',{})['ptr.io/k8s-acceptance-run']=run_id
metadata['labels']['ptr.io/k8s-acceptance-test']='V11'
spec=doc.setdefault('spec',{})
spec['schedule']='* * * * *'
spec['suspend']=False
spec['concurrencyPolicy']='Forbid'
job_labels=spec['jobTemplate'].setdefault('metadata',{}).setdefault('labels',{})
job_labels['ptr.io/k8s-acceptance-run']=run_id
job_labels['ptr.io/k8s-acceptance-test']='V11'
template=spec['jobTemplate']['spec']['template']
template.setdefault('metadata',{}).setdefault('labels',{})['ptr.io/k8s-acceptance-run']=run_id
template['metadata']['labels']['ptr.io/k8s-acceptance-test']='V11'
container=template['spec']['containers'][0]
container['command']=['/bin/sh','-ec','sleep 95']
container.pop('args',None)
print(json.dumps(doc))
PY
    kubectl_t apply -f - >/dev/null
  local active_one="0" active_later="unknown" deadline active_jobs
  deadline="$(($(date +%s)+130))"
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    active_jobs="$(kubectl_t -n "$app_ns" get jobs -l "ptr.io/k8s-acceptance-run=$run_id,ptr.io/k8s-acceptance-test=V11" -o jsonpath='{range .items[?(@.status.active==1)]}{.metadata.name}{" "}{end}' || true)"
    if [[ -n "$active_jobs" ]]; then
      active_one="$(wc -w <<<"$active_jobs" | tr -d ' ')"
      break
    fi
    timeout 2s sleep 1
  done
  timeout 75s sleep 70
  kubectl_t -n "$app_ns" get events --field-selector involvedObject.name="$temp" --sort-by=.lastTimestamp >>"$file" 2>&1 || true
  active_jobs="$(kubectl_t -n "$app_ns" get jobs -l "ptr.io/k8s-acceptance-run=$run_id,ptr.io/k8s-acceptance-test=V11" -o jsonpath='{range .items[?(@.status.active==1)]}{.metadata.name}{" "}{end}' || true)"
  active_later="$(wc -w <<<"$active_jobs" | tr -d ' ')"
  printf 'forbid_probe_cron=%s active_initial=%s active_after_overlap_window=%s\n' "$temp" "$active_one" "$active_later" >>"$file"
  timeout 10s grep -q 'JobAlreadyActive' "$file" && [[ "$active_one" == "1" && "$active_later" == "1" ]]
}

ready_transition_time() {
  local namespace="$1" pod="$2"
  timeout 10s python3 - <(kubectl_t -n "$namespace" get pod "$pod" -o json) <<'PY'
import json,sys
pod=json.load(open(sys.argv[1]))
for item in pod.get("status",{}).get("conditions",[]):
    if item.get("type")=="Ready" and item.get("status")=="True":
        print(item.get("lastTransitionTime",""))
        raise SystemExit(0)
raise SystemExit(1)
PY
}

engine_pods() {
  kubectl_t -n "$inference_ns" get pod -l 'app.kubernetes.io/name=ptr,app.kubernetes.io/component=inference-engine' \
    -o jsonpath='{range .items[*]}{.metadata.name}{" "}{end}'
}

new_engine_pod_after_scale() {
  local before="$1" pod
  for pod in $(engine_pods); do
    if [[ " $before " != *" $pod "* ]]; then
      printf '%s\n' "$pod"
      return 0
    fi
  done
  return 1
}


turn_request_map_js() {
  cat <<'NODE'
import pg from 'pg';
const {Client} = pg;
const prefix = process.env.REQUEST_PREFIX;
const client = new Client({connectionString: process.env.PTR_APP_DATABASE_URL});
await client.connect();
try {
  const rows = await client.query(`SELECT id, client_request_id FROM app.turns WHERE client_request_id LIKE $1 ORDER BY created_at, client_request_id`, [`${prefix}-%`]);
  console.log(JSON.stringify({event: 'request_id_map', prefix, ids: rows.rows.map(row => ({turnId: row.id, clientRequestId: row.client_request_id}))}));
} finally {
  await client.end();
}
NODE
}




turn_execution_probe_js() {
  cat <<'NODE'
import pg from 'pg';
const {Client} = pg;
const prefix = process.env.REQUEST_PREFIX;
const label = process.env.PROBE_LABEL || 'execution_probe';
const client = new Client({connectionString: process.env.PTR_APP_DATABASE_URL});
await client.connect();
try {
  const q = await client.query(`WITH target AS (
      SELECT id, client_request_id, state FROM app.turns WHERE client_request_id LIKE $1
    ), grants AS (
      SELECT t.id, count(g.*)::int AS executions, array_remove(array_agg(g.execution_id ORDER BY g.execution_id), NULL) AS execution_ids
      FROM target t LEFT JOIN app.turn_execution_grants g ON g.turn_id=t.id GROUP BY t.id
    )
    SELECT count(*)::int AS turns,
      (count(*) FILTER (WHERE t.state IN ('completed','failed','cancelled')))::int AS terminal,
      COALESCE(sum(g.executions),0)::int AS executions,
      COALESCE(jsonb_agg(jsonb_build_object('turnId', t.id, 'clientRequestId', t.client_request_id, 'state', t.state, 'executions', g.executions, 'executionIds', g.execution_ids)) FILTER (WHERE t.id IS NOT NULL), '[]'::jsonb) AS details
    FROM target t JOIN grants g ON g.id=t.id`, [`${prefix}-%`]);
  console.log(JSON.stringify({event: 'turn_execution_probe', label, prefix, ...q.rows[0]}));
} finally {
  await client.end();
}
NODE
}

execution_probe_passes() {
  timeout 10s python3 - "$1" "$2" "$3" <<'PY'
import json,sys
path,label,mode=sys.argv[1:4]
row=None
for line in open(path, errors='replace'):
    if not line.startswith('{'):
        continue
    try: item=json.loads(line)
    except Exception: continue
    if item.get('event')=='turn_execution_probe' and item.get('label')==label:
        row=item
if not row:
    raise SystemExit(1)
executions=int(row.get('executions') or 0)
turns=int(row.get('turns') or 0)
terminal=int(row.get('terminal') or 0)
if mode=='none':
    ok=turns >= 1 and executions == 0
elif mode=='inflight':
    ok=turns >= 1 and executions >= 1 and terminal == 0
else:
    ok=False
raise SystemExit(0 if ok else 1)
PY
}

worker_inflight_sample_js() {
  cat <<'NODE'
import pg from 'pg';
const {Client} = pg;
const prefix = process.env.REQUEST_PREFIX;
const client = new Client({connectionString: process.env.PTR_APP_DATABASE_URL});
await client.connect();
try {
  const rows = await client.query(`SELECT id, client_request_id, state FROM app.turns WHERE client_request_id LIKE $1 AND state NOT IN ('completed','failed','cancelled') ORDER BY created_at, client_request_id LIMIT 16`, [`${prefix}-%`]);
  console.log(JSON.stringify({event: 'worker_inflight_sample', prefix, sampledAt: new Date().toISOString(), turns: rows.rows.map(row => ({turnId: row.id, clientRequestId: row.client_request_id, stateAtDelete: row.state}))}));
} finally {
  await client.end();
}
NODE
}

worker_admitted_count_js() {
  cat <<'NODE'
import pg from 'pg';
const {Client} = pg;
const client = new Client({connectionString: process.env.PTR_APP_DATABASE_URL});
await client.connect();
try {
  const rows = await client.query('SELECT count(*)::int AS n FROM app.turns WHERE client_request_id LIKE $1', [`${process.env.REQUEST_PREFIX}-%`]);
  console.log(JSON.stringify({event: 'worker_admitted_count', count: rows.rows[0].n}));
} finally {
  await client.end();
}
NODE
}

worker_inflight_state_js() {
  cat <<'NODE'
import pg from 'pg';
const {Client} = pg;
const ids = (process.env.SAMPLED_TURN_IDS || '').split(',').filter(Boolean);
const client = new Client({connectionString: process.env.PTR_APP_DATABASE_URL});
await client.connect();
try {
  const rows = ids.length ? await client.query(`SELECT t.id, t.client_request_id, t.state, g.execution_id
      FROM app.turns t
      LEFT JOIN app.turn_execution_grants g ON g.turn_id=t.id AND g.result_hash IS NOT NULL
      WHERE t.id = ANY($1::text[])
      ORDER BY t.client_request_id, g.execution_id`, [ids]) : {rows: []};
  const grouped = new Map();
  for (const row of rows.rows) {
    const current = grouped.get(row.id) || {turnId: row.id, clientRequestId: row.client_request_id, state: row.state, executionIds: []};
    if (row.execution_id) current.executionIds.push(row.execution_id);
    grouped.set(row.id, current);
  }
  const turns = [...grouped.values()];
  const ok = ids.length > 0 && turns.length === ids.length && turns.every(row => ['completed','failed','cancelled'].includes(row.state) && row.executionIds.length === 1);
  console.log(JSON.stringify({event: 'worker_inflight_state_proof', sampled: ids.length, proved: turns.length, ok, turns}));
} finally {
  await client.end();
}
NODE
}

worker_receipt_ack_py() {
  cat <<'PY'
import json, os, psycopg
ids=[value for value in os.environ.get('EXECUTION_IDS','').split(',') if value]
rows=[]
if ids:
    with psycopg.connect(os.environ['PTR_LLM_DATABASE_URL'], connect_timeout=3) as conn:
        with conn.cursor() as cur:
            cur.execute('SELECT execution_id, acknowledged_at FROM llm.result_receipts WHERE execution_id = ANY(%s) ORDER BY execution_id', (ids,))
            rows=[{'executionId': row[0], 'acknowledgedAt': row[1].isoformat() if row[1] is not None else None} for row in cur.fetchall()]
seen={row['executionId']: row for row in rows}
ok=bool(ids) and len(seen)==len(ids) and all(seen.get(value,{}).get('acknowledgedAt') for value in ids)
print(json.dumps({'event':'worker_inflight_receipt_ack_proof','sampled':len(ids),'proved':len(seen),'ok':ok,'receipts':rows}, separators=(',',':')))
PY
}


sampled_turn_ids() {
  timeout 10s python3 - "$1" <<'PY'
import json,sys
ids=[]
for line in open(sys.argv[1], errors='replace'):
    if not line.startswith('{'):
        continue
    try: row=json.loads(line)
    except Exception: continue
    if row.get('event')=='worker_inflight_sample':
        ids=[item.get('turnId') for item in row.get('turns') or [] if item.get('turnId')]
print(','.join(ids))
PY
}

sampled_execution_ids() {
  timeout 10s python3 - "$1" <<'PY'
import json,sys
ids=[]
for line in open(sys.argv[1], errors='replace'):
    if not line.startswith('{'):
        continue
    try: row=json.loads(line)
    except Exception: continue
    if row.get('event')=='worker_inflight_state_proof':
        ids=[]
        for turn in row.get('turns') or []:
            ids.extend(turn.get('executionIds') or [])
print(','.join(ids))
PY
}

worker_ack_passes() {
  timeout 10s python3 - "$1" <<'PY'
import json,sys
state=None
receipt=None
for line in open(sys.argv[1], errors='replace'):
    if not line.startswith('{'):
        continue
    try: row=json.loads(line)
    except Exception: continue
    if row.get('event')=='worker_inflight_state_proof':
        state=row
    if row.get('event')=='worker_inflight_receipt_ack_proof':
        receipt=row
ok=bool(state and receipt and state.get('ok') and receipt.get('ok') and state.get('sampled',0)>0 and receipt.get('sampled',0)>0)
raise SystemExit(0 if ok else 1)
PY
}

capture_pod_log_snapshot() {
  local namespace="$1" pod="$2" log_file="$3" seconds="${4:-15}" deadline tmp ok=0 attempts=0
  private_log "$log_file"
  tmp="$(mktemp)"
  deadline="$(($(date +%s)+seconds))"
  while [[ "$(date +%s)" -lt "$deadline" ]]; do
    attempts=$((attempts + 1))
    if timeout 10s kubectl --context "$context" -n "$namespace" logs "$pod" --timestamps --tail=-1 >"$tmp" 2>&1; then
      ok=1
      {
        printf '# log_snapshot_status=ok pod=%s namespace=%s attempts=%s captured_at=%s\n' "$pod" "$namespace" "$attempts" "$(date -Iseconds)"
        cat "$tmp"
      } >"$log_file"
    elif [[ "$ok" == "1" ]]; then
      break
    fi
    timeout 2s sleep 1
  done
  if [[ "$ok" != "1" ]]; then
    {
      printf '# log_snapshot_status=failed pod=%s namespace=%s attempts=%s captured_at=%s\n' "$pod" "$namespace" "$attempts" "$(date -Iseconds)"
      cat "$tmp"
    } >"$log_file"
  fi
  rm -f "$tmp"
  chmod 600 "$log_file"
  [[ "$ok" == "1" ]]
}

capture_engine_log_snapshot() {
  capture_pod_log_snapshot "$inference_ns" "$1" "$2" 15
}


engine_first_request_proof() {
  local pod="$1" ready_at="$2" prefix="$3" file="$4" log_file="$5" map_file tmp_log
  [[ -e "$log_file" ]] || private_log "$log_file"
  map_file="$evidence_dir/V1-request-map-${prefix}.private.log"
  private_log "$map_file"
  api_node REQUEST_PREFIX="$prefix" < <(turn_request_map_js) >"$map_file" 2>&1 || true
  cat "$map_file" >>"$file"
  tmp_log="$(mktemp)"
  if timeout 60s kubectl --context "$context" -n "$inference_ns" logs "$pod" --timestamps --tail=-1 >"$tmp_log" 2>&1; then
    {
      printf '# final_log_fetch=ok captured_at=%s\n' "$(date -Iseconds)"
      cat "$tmp_log"
    } >>"$log_file"
  else
    printf '# final_log_fetch=failed captured_at=%s preserved_snapshot=1\n' "$(date -Iseconds)" >>"$log_file"
    cat "$tmp_log" >>"$log_file"
  fi
  rm -f "$tmp_log"
  chmod 600 "$log_file"
  timeout 10s python3 - "$ready_at" "$prefix" "$pod" "$log_file" "$map_file" >>"$file" <<'PY'
import datetime as dt,json,re,sys
ready_raw,prefix,pod,path,map_path=sys.argv[1:6]
def parse(value):
    value=value.replace("Z","+00:00")
    return dt.datetime.fromisoformat(value)
ready=parse(ready_raw)
expected=[]
for line in open(map_path, errors="replace"):
    if not line.startswith('{'):
        continue
    try:
        row=json.loads(line)
    except Exception:
        continue
    if row.get('event')=='request_id_map':
        expected=row.get('ids') or []
turn_to_client={str(row.get('turnId')): str(row.get('clientRequestId')) for row in expected if row.get('turnId') and str(row.get('clientRequestId','')).startswith(prefix+'-')}
client_ids=set(turn_to_client.values())
turn_ids=set(turn_to_client.keys())
marker_re=re.compile(rf"\b{re.escape(prefix)}-[0-9]{{4}}\b")
field_re=re.compile(r"(?i)(?:x-request-id|request[-_ ]?id|req[_-]?id)[^A-Za-z0-9_.:-]{0,20}([A-Za-z0-9_.:-]{1,128})")
first=None
first_line=None
first_request_id=None
first_client_id=None
with open(path, errors="replace") as handle:
    for line in handle:
        marker=marker_re.search(line)
        matched_turn=next((turn_id for turn_id in turn_ids if turn_id in line), None)
        if marker:
            client_id=marker.group(0)
            request_id=client_id
        elif matched_turn:
            client_id=turn_to_client[matched_turn]
            request_id=matched_turn
        else:
            continue
        field=field_re.search(line)
        if field and (field.group(1) in turn_ids or field.group(1) in client_ids):
            request_id=field.group(1)
        head=line.split(None,1)[0]
        try:
            stamp=parse(head)
        except Exception:
            continue
        if stamp < ready:
            continue
        if first is None or stamp < first:
            first=stamp
            first_line=line[:400].rstrip()
            first_request_id=request_id
            first_client_id=client_id
if first is None:
    print(json.dumps({"event":"engine_first_request","pod":pod,"readyAt":ready_raw,"prefix":prefix,"observed":False,"expectedRequestCount":len(expected)}))
    raise SystemExit(1)
delta=(first-ready).total_seconds()
print(json.dumps({"event":"engine_first_request","pod":pod,"readyAt":ready_raw,"firstRequestAt":first.isoformat(),"deltaSeconds":delta,"observed":True,"requestId":first_request_id,"clientRequestId":first_client_id,"expectedRequestCount":len(expected),"line":first_line}))
raise SystemExit(0 if delta <= 10 else 1)
PY
}

terminating_pod_request_proof() {
  local namespace="$1" pod="$2" delete_at="$3" prefix="$4" file="$5" log_file="$6"
  [[ -e "$log_file" ]] || private_log "$log_file"
  timeout 10s python3 - "$delete_at" "$prefix" "$pod" "$log_file" >>"$file" <<'PY'
import datetime as dt,json,sys
delete_raw,prefix,pod,path=sys.argv[1:5]
def parse(value):
    return dt.datetime.fromisoformat(value.replace("Z","+00:00"))
deleted=parse(delete_raw)
first_seen={}
snapshot_ok=False
with open(path, errors="replace") as handle:
    for line in handle:
        if line.startswith('# log_snapshot_status=ok'):
            snapshot_ok=True
        # The simulator also logs X-Request-Id headers for readiness probes.
        # Only a POST request line can show new inference traffic.
        if 'method="POST"' not in line:
            continue
        try:
            stamp=parse(line.split(None,1)[0])
        except Exception:
            continue
        request_id=f"post-{len(first_seen)+1}"
        first_seen[request_id]=stamp
new_ids={request_id: stamp for request_id, stamp in first_seen.items() if stamp >= deleted}
print(json.dumps({"event":"terminating_pod_request_proof","pod":pod,"deleteAt":delete_raw,"prefix":prefix,"logSnapshotOk":snapshot_ok,"distinctRequestIds":len(first_seen),"newDistinctRequestIdsAfterDelete":len(new_ids),"sample":[{"requestId": key, "firstSeenAt": value.isoformat()} for key,value in list(new_ids.items())[:3]]}))
raise SystemExit(0 if snapshot_ok and not new_ids else 1)
PY
}

pdb_proof() {
  local file="$1"
  local pdb_json
  pdb_json="$(kubectl_t -n "$inference_ns" get pdb ptr-sim -o json 2>/dev/null || true)"
  timeout 10s python3 - "$pdb_json" >>"$file" <<'PY'
import json,sys
try:
    pdb=json.loads(sys.argv[1])
except Exception:
    print(json.dumps({"event":"pdb_proof","present":False}))
    raise SystemExit(1)
status=pdb.get("status",{})
expected=int(status.get("expectedPods") or 0)
current=int(status.get("currentHealthy") or 0)
desired=int(status.get("desiredHealthy") or 0)
allowed=int(status.get("disruptionsAllowed") or 0)
ok=expected>=2 and current>=desired and allowed>=0
print(json.dumps({"event":"pdb_proof","present":True,"expectedPods":expected,"currentHealthy":current,"desiredHealthy":desired,"disruptionsAllowed":allowed}))
raise SystemExit(0 if ok else 1)
PY
}

v3_mid_passes() {
  timeout 10s python3 - "$1" "$2" <<'PY'
import json,sys
proof={}
receipt={}
for line in open(sys.argv[1]):
    if line.startswith('{'):
        try: row=json.loads(line)
        except Exception: continue
        if row.get('event')=='app_db_proof': proof=row
        if row.get('event')=='receipt_db_proof': receipt=row
expected=int(sys.argv[2])
ok=(proof.get('observed')==expected and proof.get('terminal')==expected and proof.get('outbox')==0 and proof.get('duplicate_completion_rows')==0 and proof.get('assistant_not_exactly_once')==0 and proof.get('grants_not_exactly_once')==0 and proof.get('turns_with_multiple_executions')==0 and int(proof.get('max_executions') or 0) <= 1)
raise SystemExit(0 if ok else 1)
PY
}

select_drain_node_without_data_pods() {
  timeout 10s python3 - <(kubectl_t get nodes -o json) <(kubectl_t -n "$data_ns" get pods -o json) <(kubectl_t -n "$inference_ns" get pods -l 'app.kubernetes.io/name=ptr,app.kubernetes.io/component=inference-engine' -o json) <<'PY'
import json,sys
nodes=json.load(open(sys.argv[1])).get("items",[])
data=json.load(open(sys.argv[2])).get("items",[])
engines=json.load(open(sys.argv[3])).get("items",[])
data_nodes={p.get("spec",{}).get("nodeName") for p in data if p.get("spec",{}).get("nodeName")}
engine_nodes={p.get("spec",{}).get("nodeName") for p in engines if p.get("spec",{}).get("nodeName")}
preferred=["ptr-k8s-worker3","ptr-k8s-worker2","ptr-k8s-worker"]
ready=[]
for node in nodes:
    name=node["metadata"]["name"]
    sched=node.get("spec",{}).get("unschedulable") is not True
    is_ready=any(c.get("type")=="Ready" and c.get("status")=="True" for c in node.get("status",{}).get("conditions",[]))
    if sched and is_ready and name not in data_nodes:
        ready.append(name)
for name in preferred:
    if name in ready and name in engine_nodes:
        print(name)
        raise SystemExit(0)
for name in ready:
    if name in engine_nodes:
        print(name)
        raise SystemExit(0)
for name in preferred:
    if name in ready:
        print(name)
        raise SystemExit(0)
if ready:
    print(ready[0])
    raise SystemExit(0)
raise SystemExit(1)
PY
}

run_v1() {
  local prefix="${V1_PREFIX:-v1${short_run_id}}" file summary ready_at rc before_pods new_pod ready_proof_rc log_file snapshot_rc missing_clause
  file="$evidence_dir/V1-${prefix}.private.log"
  private_log "$file"
  original_engine_replicas="$(kubectl_t -n "$inference_ns" get deployment ptr-sim -o jsonpath='{.spec.replicas}')"
  kubectl_t -n "$inference_ns" scale deployment/ptr-sim --replicas=1 >/dev/null
  kubectl_t -n "$inference_ns" rollout status deployment/ptr-sim --timeout=180s >/dev/null
  before_pods="$(engine_pods)"
  apply_probe_job V1 "$prefix" 48 8 360 turns
  timeout 5s sleep 2
  kubectl_t -n "$inference_ns" scale deployment/ptr-sim --replicas=2 >/dev/null
  kubectl_t -n "$inference_ns" rollout status deployment/ptr-sim --timeout=180s >/dev/null
  new_pod="$(new_engine_pod_after_scale "$before_pods" || true)"
  log_file="$evidence_dir/V1-engine-${prefix}.private.log"
  snapshot_rc=1
  if [[ -n "$new_pod" ]]; then
    ready_at="$(ready_transition_time "$inference_ns" "$new_pod" || true)"
    if [[ -n "$ready_at" ]]; then
      capture_engine_log_snapshot "$new_pod" "$log_file" && snapshot_rc=0 || snapshot_rc=$?
    fi
  else
    ready_at=""
  fi
  set +e
  wait_probe_job V1 "$prefix" 48 900
  rc=$?
  ready_proof_rc=1
  if [[ -n "$new_pod" && -n "$ready_at" ]]; then
    engine_first_request_proof "$new_pod" "$ready_at" "$prefix" "$file" "$log_file"
    ready_proof_rc=$?
  else
    private_log "$log_file"
    printf '{"event":"engine_first_request","observed":false,"reason":"new_pod_or_ready_transition_missing","pod":"%s","readyAt":"%s"}\n' "${new_pod:-}" "${ready_at:-}" >>"$file"
  fi
  set -e
  seal_private "$file" "$log_file"
  summary="$(summarize_probe "$file")"
  if [[ "$rc" == "0" ]] && proof_passes "$file" 48 && [[ "$ready_proof_rc" == "0" ]]; then
    result V1 PASS "$summary" "new_pod=$new_pod" "ready_at=$ready_at" "snapshot_rc=$snapshot_rc" first_request_within_10s=1 "evidence=$file" "engine_log=$log_file"
    return 0
  elif [[ "$rc" == "0" ]] && proof_passes "$file" 48; then
    result V1 FAIL "$summary" "new_pod=${new_pod:-missing}" "ready_at=${ready_at:-missing}" "snapshot_rc=$snapshot_rc" missing_clause=first_request_to_new_engine_pod_within_10s cause=engine_new_pod_request_within_10s_not_proved "evidence=$file" "engine_log=$log_file"
  else
    missing_clause=""
    append_missing_clause_list missing_clause "$(probe_missing_clauses "$file" 48)"
    [[ "$ready_proof_rc" == "0" ]] || append_missing_clause missing_clause first_request_to_new_engine_pod_within_10s
    result V1 FAIL "$summary" "missing_clause=${missing_clause:-unknown}" "cause=turn_or_duplicate_proof_failed" "evidence=$file"
  fi
  return 1
}


run_v2() {
  local prefix="${V2_PREFIX:-v2${short_run_id}}" file engine worker node summary engine_rc worker_rc drain_rc term_rc pdb_rc drain_term_rc delete_at log_file drain_log drain_pods pod worker_sample_ids worker_execution_ids worker_ack_rc missing_clause admitted
  file="$evidence_dir/V2-${prefix}.private.log"
  private_log "$file"
  if [[ "${V2_WORKER_ONLY:-0}" == "1" ]]; then
    worker="$(current_worker_pod)"
    if [[ -z "$worker" ]]; then
      result V2 FAIL mode=worker_only missing_clause=worker_pod_present cause=missing_worker_pod worker=none
      return 1
    fi
    apply_probe_job V2W "${prefix}w" 16 4 360 turns
    admitted=0
    for _ in {1..120}; do
      admitted="$(api_node REQUEST_PREFIX="${prefix}w" < <(worker_admitted_count_js) | python3 -c 'import json,sys; print(json.load(sys.stdin)["count"])' 2>/dev/null || echo 0)"
      [[ "$admitted" == "16" ]] && break
      timeout 2s sleep 1
    done
    printf 'worker_admitted_before_delete=%s\n' "$admitted" >>"$file"
    if [[ "$admitted" != "16" ]]; then
      result V2 FAIL mode=worker_only missing_clause=all_turns_admitted_before_delete cause=worker_probe_admission_failed "evidence=$file"
      return 1
    fi
    api_node REQUEST_PREFIX="${prefix}w" < <(worker_inflight_sample_js) >>"$file" 2>&1 || true
    worker_sample_ids="$(sampled_turn_ids "$file")"
    kubectl_t -n "$app_ns" delete pod "$worker" --wait=false >/dev/null
    kubectl_t -n "$app_ns" rollout status deployment/ptr-worker --timeout=180s >/dev/null
    set +e
    wait_probe_job V2W "${prefix}w" 16 900
    worker_rc=$?
    api_node SAMPLED_TURN_IDS="$worker_sample_ids" < <(worker_inflight_state_js) >>"$file" 2>&1 || true
    worker_execution_ids="$(sampled_execution_ids "$file")"
    worker_python EXECUTION_IDS="$worker_execution_ids" < <(worker_receipt_ack_py) >>"$file" 2>&1 || true
    worker_ack_passes "$file"
    worker_ack_rc=$?
    set -e
    summary="worker={$(summarize_probe "$(probe_file V2W "${prefix}w")")}"
    seal_private "$file"
    if [[ "$worker_rc" == "0" && "${worker_ack_rc:-1}" == "0" ]] && proof_passes "$(probe_file V2W "${prefix}w")" 16; then
      result V2 PASS "$summary" mode=worker_only "worker_deleted=$worker" worker_inflight_ack=1 "worker_sampled_turns=$(tr ',' ' ' <<<"$worker_sample_ids" | wc -w | tr -d ' ')" "evidence=$file"
      return 0
    fi
    missing_clause=""
    append_missing_clause_list missing_clause "$(probe_missing_clauses "$(probe_file V2W "${prefix}w")" 16)"
    [[ "${worker_ack_rc:-1}" == "0" ]] || append_missing_clause missing_clause worker_inflight_ack
    result V2 FAIL "$summary" mode=worker_only "worker_deleted=$worker" "worker_rc=${worker_rc:-na}" "worker_ack_rc=${worker_ack_rc:-na}" "missing_clause=${missing_clause:-unknown}" cause=v2_worker_delete_proof_failed "evidence=$file"
    return 1
  fi
  original_engine_min="$(kubectl_t -n "$inference_ns" get scaledobject ptr-sim -o jsonpath='{.spec.minReplicaCount}')"
  kind_helm_upgrade --set autoscaling.engine.minReplicaCount=2 >/dev/null
  kubectl_t -n "$inference_ns" rollout status deployment/ptr-sim --timeout=180s >/dev/null
  pdb_rc=1
  pdb_proof "$file" && pdb_rc=0

  # Subcase V2a: graceful engine pod delete.
  engine="$(current_engine_pod)"
  if [[ -z "$engine" ]]; then
    result V2 FAIL missing_clause=engine_pod_present cause=missing_engine_pod engine=none
    return 1
  fi
  apply_probe_job V2E "${prefix}e" 16 4 360 turns
  timeout 5s sleep 2
  log_file="$evidence_dir/V2-engine-${prefix}.private.log"
  delete_at="$(date -Iseconds)"
  kubectl_t -n "$inference_ns" delete pod "$engine" --wait=false >/dev/null
  capture_pod_log_snapshot "$inference_ns" "$engine" "$log_file" 15 || true
  kubectl_t -n "$inference_ns" rollout status deployment/ptr-sim --timeout=180s >/dev/null
  set +e
  wait_probe_job V2E "${prefix}e" 16 900
  engine_rc=$?
  terminating_pod_request_proof "$inference_ns" "$engine" "$delete_at" "${prefix}e" "$file" "$log_file"
  term_rc=$?
  set -e

  # Subcase V2b: graceful worker pod delete while work is in flight.
  worker="$(current_worker_pod)"
  if [[ -z "$worker" ]]; then
    result V2 FAIL missing_clause=worker_pod_present cause=missing_worker_pod worker=none
    return 1
  fi
  apply_probe_job V2W "${prefix}w" 16 4 360 turns
  admitted=0
  for _ in {1..120}; do
    admitted="$(api_node REQUEST_PREFIX="${prefix}w" < <(worker_admitted_count_js) | python3 -c 'import json,sys; print(json.load(sys.stdin)["count"])' 2>/dev/null || echo 0)"
    [[ "$admitted" == "16" ]] && break
    timeout 2s sleep 1
  done
  printf 'worker_admitted_before_delete=%s\n' "$admitted" >>"$file"
  if [[ "$admitted" != "16" ]]; then
    result V2 FAIL mode=full missing_clause=all_turns_admitted_before_delete cause=worker_probe_admission_failed "evidence=$file"
    return 1
  fi
  api_node REQUEST_PREFIX="${prefix}w" < <(worker_inflight_sample_js) >>"$file" 2>&1 || true
  worker_sample_ids="$(sampled_turn_ids "$file")"
  kubectl_t -n "$app_ns" delete pod "$worker" --wait=false >/dev/null
  kubectl_t -n "$app_ns" rollout status deployment/ptr-worker --timeout=180s >/dev/null
  set +e
  wait_probe_job V2W "${prefix}w" 16 900
  worker_rc=$?
  api_node SAMPLED_TURN_IDS="$worker_sample_ids" < <(worker_inflight_state_js) >>"$file" 2>&1 || true
  worker_execution_ids="$(sampled_execution_ids "$file")"
  worker_python EXECUTION_IDS="$worker_execution_ids" < <(worker_receipt_ack_py) >>"$file" 2>&1 || true
  worker_ack_passes "$file"
  worker_ack_rc=$?
  set -e

  # Subcase V2c: drain a node with no data pods.
  node="$(select_drain_node_without_data_pods)"
  drained_node="$node"
  drain_pods="$(kubectl_t -n "$inference_ns" get pods -l 'app.kubernetes.io/name=ptr,app.kubernetes.io/component=inference-engine' --field-selector "spec.nodeName=$node" -o jsonpath='{range .items[*]}{.metadata.name}{" "}{end}' || true)"
  apply_probe_job V2D "${prefix}d" 16 4 360 turns
  timeout 5s sleep 2
  delete_at="$(date -Iseconds)"
  drain_log="$evidence_dir/V2-drain-${prefix}.private.log"
  private_log "$drain_log"
  timeout 20s kubectl --context "$context" drain "$node" --ignore-daemonsets --delete-emptydir-data --timeout=5s >"$drain_log" 2>&1 || true
  for pod in $drain_pods; do
    capture_pod_log_snapshot "$inference_ns" "$pod" "$evidence_dir/V2-drain-engine-${pod}-${prefix}.private.log" 15 || true
  done
  timeout 120s kubectl --context "$context" drain "$node" --ignore-daemonsets --delete-emptydir-data --timeout=90s >>"$drain_log" 2>&1 || true
  restore_node
  kubectl_t -n "$inference_ns" rollout status deployment/ptr-sim --timeout=180s >/dev/null
  set +e
  wait_probe_job V2D "${prefix}d" 16 900
  drain_rc=$?
  drain_term_rc=0
  for pod in $drain_pods; do
    terminating_pod_request_proof "$inference_ns" "$pod" "$delete_at" "${prefix}d" "$file" "$evidence_dir/V2-drain-engine-${pod}-${prefix}.private.log" || drain_term_rc=1
  done
  set -e

  summary="engine={$(summarize_probe "$(probe_file V2E "${prefix}e")")} worker={$(summarize_probe "$(probe_file V2W "${prefix}w")")} drain={$(summarize_probe "$(probe_file V2D "${prefix}d")")}"
  seal_private "$file" "$log_file" "$drain_log"
  if [[ "$engine_rc" == "0" && "$worker_rc" == "0" && "$drain_rc" == "0" && "$term_rc" == "0" && "$drain_term_rc" == "0" && "$pdb_rc" == "0" && "${worker_ack_rc:-1}" == "0" ]] &&
    proof_passes "$(probe_file V2E "${prefix}e")" 16 &&
    proof_passes "$(probe_file V2W "${prefix}w")" 16 &&
    proof_passes "$(probe_file V2D "${prefix}d")" 16 &&
    ! timeout 10s grep -Eqi 'cannot evict.*poddisruptionbudget|violat.*poddisruptionbudget' "$drain_log"; then
    result V2 PASS "$summary" "drained_node=$node" "engine_deleted=$engine" "worker_deleted=$worker" pdb_respected=1 terminating_pod_new_requests=0 worker_inflight_ack=1 "worker_sampled_turns=$(tr ',' ' ' <<<"$worker_sample_ids" | wc -w | tr -d ' ')" "evidence=$file" "drain_log=$drain_log"
    return 0
  else
    missing_clause=""
    append_missing_clause_list missing_clause "$(probe_missing_clauses "$(probe_file V2E "${prefix}e")" 16)"
    append_missing_clause_list missing_clause "$(probe_missing_clauses "$(probe_file V2W "${prefix}w")" 16)"
    append_missing_clause_list missing_clause "$(probe_missing_clauses "$(probe_file V2D "${prefix}d")" 16)"
    [[ "$pdb_rc" == "0" ]] || append_missing_clause missing_clause pdb_respected
    [[ "${term_rc:-1}" == "0" && "${drain_term_rc:-1}" == "0" ]] || append_missing_clause missing_clause no_new_requests_to_terminating_pod
    [[ "${worker_ack_rc:-1}" == "0" ]] || append_missing_clause missing_clause worker_inflight_ack
    if timeout 10s grep -Eqi 'cannot evict.*poddisruptionbudget|violat.*poddisruptionbudget' "$drain_log"; then
      append_missing_clause missing_clause drain_did_not_violate_pdb
    fi
    result V2 FAIL "$summary" "drained_node=${node:-unknown}" "engine_rc=${engine_rc:-na}" "worker_rc=${worker_rc:-na}" "drain_rc=${drain_rc:-na}" "pdb_rc=$pdb_rc" "term_rc=${term_rc:-na}" "drain_term_rc=${drain_term_rc:-na}" "worker_ack_rc=${worker_ack_rc:-na}" "missing_clause=${missing_clause:-unknown}" cause=v2_subcase_proof_failed "drain_log=$drain_log" "evidence=$file"
  fi
  return 1
}

run_v3() {
  local prefix="${V3_PREFIX:-v3${short_run_id}}" file worker api engine pre_rc mid_rc summary sse_ok mid_file pre_submit_rc mid_inflight_rc pre_session_id missing_clause
  file="$evidence_dir/V3-${prefix}.private.log"
  private_log "$file"

  # Subcase V3a: deterministic queued turn before provider submission.
  # Pause KEDA and scale workers to zero, enqueue one turn, prove it exists with
  # zero execution grants, force-delete API while queued, then restore workers.
  CREATE_SESSION_ONLY=1 apply_probe_job V3PRESESS "${prefix}presess" 1 1 60 turns
  set +e
  wait_probe_job V3PRESESS "${prefix}presess" 0 120
  set -e
  pre_session_id="$(session_id_from_probe "$(probe_file V3PRESESS "${prefix}presess")")"
  if [[ -z "$pre_session_id" ]]; then
    result V3 FAIL missing_clause=pre_submission_session_precreated cause=session_precreate_failed "evidence=$(probe_file V3PRESESS "${prefix}presess")"
    return 1
  fi
  pause_worker_autoscaling
  EXISTING_SESSION_ID="$pre_session_id" apply_probe_job V3PRE "${prefix}pre" 1 1 240 turns
  for _ in {1..20}; do
    api_node REQUEST_PREFIX="${prefix}pre" PROBE_LABEL=pre_kill < <(turn_execution_probe_js) >>"$(probe_file V3PRE "${prefix}pre")" 2>&1 || true
    if execution_probe_passes "$(probe_file V3PRE "${prefix}pre")" pre_kill none; then
      break
    fi
    timeout 2s sleep 0.5
  done
  api="$(current_api_pod || true)"
  [[ -n "$api" ]] && kubectl_t -n "$app_ns" delete pod "$api" --grace-period=0 --force --wait=false >/dev/null || true
  kubectl_t -n "$app_ns" rollout status deployment/ptr-api --timeout=180s >/dev/null
  restore_worker_autoscaling
  restore_worker_replicas
  set +e
  wait_probe_job V3PRE "${prefix}pre" 1 240
  pre_rc=$?
  execution_probe_passes "$(probe_file V3PRE "${prefix}pre")" pre_kill none
  pre_submit_rc=$?
  set -e

  # Subcase V3b: add temporary simulator TTFT latency, prove the provider execution is
  # in flight, then force-delete worker/API/engine and require terminal SSE after reconnect.
  original_engine_time_to_first_token="$(timeout 30s helm --kube-context "$context" get values "$release" -n ptr-system --all -o json | timeout 10s python3 -c 'import json,sys; print(json.load(sys.stdin).get("inference",{}).get("engine",{}).get("timeToFirstToken") or "8s")')"
  original_engine_inter_token_latency="$(timeout 30s helm --kube-context "$context" get values "$release" -n ptr-system --all -o json | timeout 10s python3 -c 'import json,sys; print(json.load(sys.stdin).get("inference",{}).get("engine",{}).get("interTokenLatency") or "0s")')"
  restore_engine_values=1
  kind_helm_upgrade \
    --set inference.engine.timeToFirstToken=20s \
    --set inference.engine.interTokenLatency="$original_engine_inter_token_latency" >/dev/null
  kubectl_t -n "$inference_ns" rollout status deployment/ptr-sim --timeout=180s >/dev/null
  mid_file="$(probe_file V3MID "${prefix}mid")"
  EXPECT_TERMINAL_ANY=1 SECOND_SSE_MS=180000 apply_probe_job V3MID "${prefix}mid" 1 1 360 sse
  for _ in {1..30}; do
    api_node REQUEST_PREFIX="${prefix}mid" PROBE_LABEL=mid_kill < <(turn_execution_probe_js) >>"$mid_file" 2>&1 || true
    if execution_probe_passes "$mid_file" mid_kill inflight; then
      break
    fi
    timeout 2s sleep 1
  done
  set +e
  execution_probe_passes "$mid_file" mid_kill inflight
  mid_inflight_rc=$?
  set -e
  worker="$(current_worker_pod || true)"
  api="$(current_api_pod || true)"
  engine="$(current_engine_pod || true)"
  [[ -n "$worker" ]] && kubectl_t -n "$app_ns" delete pod "$worker" --grace-period=0 --force --wait=false >/dev/null || true
  [[ -n "$api" ]] && kubectl_t -n "$app_ns" delete pod "$api" --grace-period=0 --force --wait=false >/dev/null || true
  [[ -n "$engine" ]] && kubectl_t -n "$inference_ns" delete pod "$engine" --grace-period=0 --force --wait=false >/dev/null || true
  kubectl_t -n "$app_ns" rollout status deployment/ptr-api --timeout=180s >/dev/null
  kubectl_t -n "$app_ns" rollout status deployment/ptr-worker --timeout=180s >/dev/null
  kubectl_t -n "$inference_ns" rollout status deployment/ptr-sim --timeout=180s >/dev/null
  set +e
  wait_probe_job V3MID "${prefix}mid" 1 360
  mid_rc=$?
  set -e
  restore_engine_values_file
  seal_private "$file" "$mid_file" "$(probe_file V3PRE "${prefix}pre")" "$(probe_file V3PRESESS "${prefix}presess")"
  summary="pre={$(summarize_probe "$(probe_file V3PRE "${prefix}pre")")} mid={$(summarize_probe "$mid_file")}"
  sse_ok="$(python3 - "$mid_file" <<'PY' || true
import json,sys
frames='na'; final='na'; ok=False
for line in open(sys.argv[1]):
    if line.startswith('{'):
        try: row=json.loads(line)
        except Exception: continue
        if row.get('event')=='sse_reconnect_probe':
            frames=row.get('secondFrames'); final=row.get('finalState'); ok=bool(frames) and final in ('completed','failed','cancelled')
print(f'sse_second_frames={frames} sse_final={final}')
raise SystemExit(0 if ok else 1)
PY
)"
  if [[ "$pre_rc" == "0" && "$mid_rc" == "0" && "$pre_submit_rc" == "0" && "$mid_inflight_rc" == "0" ]] &&
    proof_passes "$(probe_file V3PRE "${prefix}pre")" 1 &&
    v3_mid_passes "$mid_file" 1; then
    result V3 PASS "$summary" "$sse_ok" pre_submit_no_provider_execution_at_kill=1 mid_generation_inflight_at_kill=1 mid_generation_terminal=1 resubmissions=0 duplicate_completions=0 force_deleted=worker,api,engine "evidence=$file" "mid_evidence=$mid_file"
  else
    missing_clause=""
    [[ "$pre_submit_rc" == "0" ]] || append_missing_clause missing_clause pre_submission_force_kill_before_provider
    [[ "$mid_inflight_rc" == "0" ]] || append_missing_clause missing_clause mid_generation_inflight_kill
    [[ "$mid_rc" == "0" ]] || append_missing_clause missing_clause mid_generation_terminal_over_reconnected_sse
    append_missing_clause_list missing_clause "$(probe_missing_clauses "$(probe_file V3PRE "${prefix}pre")" 1)"
    append_missing_clause_list missing_clause "$(probe_missing_clauses "$mid_file" 1 0 0)"
    result V3 FAIL "$summary" "$sse_ok" "pre_rc=$pre_rc" "mid_rc=$mid_rc" "pre_submit_rc=$pre_submit_rc" "mid_inflight_rc=$mid_inflight_rc" "missing_clause=${missing_clause:-unknown}" cause=v3_subcase_recovery_not_proved "evidence=$file" "mid_evidence=$mid_file"
    return 1
  fi
}


run_v4() {
  local prefix="${V4_PREFIX:-v4${short_run_id}}" file summary rc
  file="$evidence_dir/V4-${prefix}.private.log"
  private_log "$file"
  original_api_replicas="kind-values"
  apply_probe_job V4 "$prefix" 100 16 360 turns
  timeout 5s sleep 2
  helm_t --kube-context "$context" upgrade "$release" "$chart" -n ptr-system --reuse-values \
    --set app.api.replicas=3 --set autoscaling.hpa.api.minReplicas=3 --wait >/dev/null
  kubectl_t -n "$app_ns" rollout restart deployment/ptr-api >/dev/null
  kubectl_t -n "$app_ns" rollout status deployment/ptr-api --timeout=180s >/dev/null
  set +e
  wait_probe_job V4 "$prefix" 100 900
  rc=$?
  set -e
  seal_private "$file"
  summary="$(summarize_probe "$file")"
  restore_api_replicas
  if [[ "$rc" == 0 ]] && proof_passes "$file" 100; then
    result V4 PASS "$summary" api_replicas_tested=3 "evidence=$file"
  else
    result V4 FAIL "$summary" missing_clause=all_turns_terminal,zero_failed_turns,zero_duplicate_outbox_reexecutions,zero_duplicate_completion_rows cause=outbox_or_duplicate_proof_failed "evidence=$file"
    return 1
  fi
}

run_v9() {
  local prefix="${V9_PREFIX:-v9${short_run_id}}" file rc readiness_down readiness_up fallback_seen workers_before workers_during workers summary missing_clause
  file="$evidence_dir/V9-${prefix}.private.log"
  private_log "$file"
  readiness_down=0
  readiness_up=0
  fallback_seen=0
  workers_before="$(kubectl_t -n "$app_ns" get deployment ptr-worker -o jsonpath='{.spec.replicas}')"
  original_redis_replicas="$(kubectl_t -n "$data_ns" get statefulset ptr-redis -o jsonpath='{.spec.replicas}')"
  apply_probe_job V9 "$prefix" 24 8 480 turns
  timeout 5s sleep 2
  timeout 60s kubectl --context "$context" -n "$data_ns" scale statefulset/ptr-redis --replicas=0 >>"$file" 2>&1 || true
  workers_during="$(kubectl_t -n "$app_ns" get deployment ptr-worker -o jsonpath='{.spec.replicas}' || true)"
  for _ in {1..240}; do
    timeout 10s kubectl --context "$context" -n "$app_ns" get events --field-selector involvedObject.kind=Pod --sort-by=.lastTimestamp >>"$file" 2>&1 || true
    timeout 10s kubectl --context "$context" -n "$app_ns" get endpoints ptr-api -o wide >>"$file" 2>&1 || true
    timeout 10s kubectl --context "$context" -n "$app_ns" get scaledobject ptr-worker -o jsonpath='{range .status.conditions[*]}scaledobject_condition type={.type} status={.status} reason={.reason} message={.message}{"\n"}{end}' >>"$file" 2>&1 || true
    if timeout 10s kubectl --context "$context" -n "$app_ns" get scaledobject ptr-worker -o jsonpath='{range .status.conditions[?(@.type=="Fallback")]}{.status}{" "}{.reason}{end}' | timeout 10s grep -q '^True'; then
      fallback_seen=1
    fi
    if timeout 8s kubectl --context "$context" -n "$app_ns" exec "$(current_api_pod)" -- node -e "fetch('http://127.0.0.1:56441/api/readyz',{signal:AbortSignal.timeout(2500)}).then(r=>process.exit(r.status===503?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      readiness_down=1
    fi
    workers_during="$(kubectl_t -n "$app_ns" get deployment ptr-worker -o jsonpath='{.spec.replicas}' || true)"
    if [[ "$readiness_down" == "1" && "$fallback_seen" == "1" ]]; then
      break
    fi
    timeout 2s sleep 1
  done
  restore_redis_replicas
  kubectl_t -n "$app_ns" rollout status deployment/ptr-api --timeout=180s >/dev/null || true
  for _ in {1..120}; do
    if timeout 8s kubectl --context "$context" -n "$app_ns" exec "$(current_api_pod)" -- node -e "fetch('http://127.0.0.1:56441/api/readyz',{signal:AbortSignal.timeout(2500)}).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      readiness_up=1
      break
    fi
    timeout 1s sleep 0.5
  done
  set +e
  wait_probe_job V9 "$prefix" 24 900
  rc=$?
  set -e
  workers="$(kubectl_t -n "$app_ns" get deployment ptr-worker -o jsonpath='{.spec.replicas}')"
  summary="$(summarize_probe "$file")"
  seal_private "$file"
  if v9_terminal_proof_passes "$file" && [[ "$readiness_down" == "1" && "$readiness_up" == "1" && "$fallback_seen" == "1" && "${workers_before:-0}" -ge 1 && "${workers_during:-0}" -ge 1 && "${workers:-0}" -ge 1 ]]; then
    result V9 PASS "$summary" "readiness503=$readiness_down" "readiness200=$readiness_up" "fallback_seen=$fallback_seen" "worker_replicas_before=$workers_before" "worker_replicas_during=$workers_during" "worker_replicas_after=$workers" "evidence=$file"
  else
    missing_clause=""
    append_missing_clause_list missing_clause "$(probe_missing_clauses "$file" 24 0 0)"
    [[ "$readiness_down" == "1" ]] || append_missing_clause missing_clause api_readyz_observed_503
    [[ "$readiness_up" == "1" ]] || append_missing_clause missing_clause api_readyz_observed_200
    [[ "$fallback_seen" == "1" ]] || append_missing_clause missing_clause keda_fallback_condition_true
    [[ "${workers_before:-0}" -ge 1 && "${workers_during:-0}" -ge 1 && "${workers:-0}" -ge 1 ]] || append_missing_clause missing_clause keda_fallback_kept_worker_count
    result V9 FAIL "$summary" "readiness503=$readiness_down" "readiness200=$readiness_up" "fallback_seen=$fallback_seen" "worker_replicas_before=${workers_before:-unknown}" "worker_replicas_during=${workers_during:-unknown}" "worker_replicas_after=${workers:-unknown}" "missing_clause=${missing_clause:-unknown}" cause=redis_restart_recovery_not_proved "evidence=$file"
    return 1
  fi
}

run_v11() {
  local cron policy wait_rc file db_summary forbid_rc temp_cron job_template_labels before_db created_job worker_image
  file="$evidence_dir/V11-${run_id}.private.log"
  private_log "$file"
  cron="$(kubectl_t -n "$app_ns" get cronjob -l 'app.kubernetes.io/name=ptr,app.kubernetes.io/component=maintenance,ptr.io/synthetic-smoke=true' -o jsonpath='{.items[0].metadata.name}')"
  if [[ -z "$cron" ]]; then
    result V11 FAIL missing_clause=synthetic_maintenance_cronjob_present,manual_trigger_succeeds,forbid_blocks_scheduled_overlap,only_synthetic_database_changed cause=missing_synthetic_maintenance_cronjob synthetic_cronjobs=0
    return 1
  fi
  policy="$(kubectl_t -n "$app_ns" get cronjob "$cron" -o jsonpath='{.spec.concurrencyPolicy}')"
  job_template_labels="$(kubectl_t -n "$app_ns" get cronjob "$cron" -o json | timeout 10s python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("spec",{}).get("jobTemplate",{}).get("metadata",{}).get("labels",{}).get("ptr.io/synthetic-smoke",""))' || true)"
  kubectl_t -n "$app_ns" get cronjob "$cron" -o json |
    timeout 10s python3 -c 'import json,sys; d=json.load(sys.stdin); env=[e.get("name") for e in d["spec"]["jobTemplate"]["spec"]["template"]["spec"]["containers"][0].get("env",[])]; print("cronjob_env_names="+",".join(sorted(env)))' >>"$file"
  printf 'job_template_synthetic_smoke_label=%s\n' "${job_template_labels:-missing}" >>"$file"
  append_synthetic_db_counts before "$file"
  before_db="$(synthetic_before_database "$file" 2>/dev/null || true)"
  printf 'synthetic_expected_database=%s\n' "${before_db:-missing}" >>"$file"
  if [[ -z "$before_db" ]]; then
    seal_private "$file"
    result V11 FAIL "cronjob=$cron" "concurrencyPolicy=$policy" "jobTemplateLabelSyntheticSmoke=${job_template_labels:-missing}" missing_clause=before_snapshot_database_identity,manual_trigger_succeeds,forbid_blocks_scheduled_overlap,only_synthetic_database_changed cause=before_database_snapshot_missing "evidence=$file"
    return 1
  fi
  created_job="ptr-accept-${run_id}-v11"
  worker_image="$(kubectl_t -n "$app_ns" get deployment ptr-worker -o jsonpath='{.spec.template.spec.containers[0].image}')"
  printf 'synthetic_marker_job_image=%s\n' "${worker_image:-missing}" >>"$file"
  manual_v11_job_from_cron "$cron" "$created_job" "$before_db" "$worker_image"
  wait_rc=0
  timeout 600s kubectl --context "$context" -n "$app_ns" wait --for=condition=complete "job/$created_job" --timeout=540s >/dev/null || wait_rc=$?
  timeout 30s kubectl --context "$context" -n "$app_ns" logs "job/$created_job" --tail=200 >>"$file" 2>&1 || true
  append_synthetic_db_counts after "$file"
  db_summary="$(compare_synthetic_counts "$file" 2>&1)" || true
  temp_cron="ptr-accept-${run_id}-v11-forbid"
  forbid_rc=0
  cronjob_forbid_probe "$cron" "$temp_cron" "$file" || forbid_rc=$?
  seal_private "$file"
  if [[ "$wait_rc" == "0" && "$policy" == "Forbid" && "$forbid_rc" == "0" && "$job_template_labels" == "true" ]] && compare_synthetic_counts "$file" >/dev/null; then
    result V11 PASS "cronjob=$cron" "concurrencyPolicy=$policy" jobTemplateLabelSyntheticSmoke=true manual_job=complete forbid_overlap=JobAlreadyActive "$db_summary" "evidence=$file"
    return 0
  fi
  if [[ "$wait_rc" == "0" && "$policy" == "Forbid" ]]; then
    result V11 FAIL "cronjob=$cron" "concurrencyPolicy=$policy" "jobTemplateLabelSyntheticSmoke=${job_template_labels:-missing}" manual_job=complete "forbid_rc=$forbid_rc" "$db_summary" missing_clause=jobTemplate_metadata_labels,forbid_blocks_scheduled_overlap,only_synthetic_database_changed cause=v11_proof_incomplete "evidence=$file"
    return 1
  fi
  result V11 FAIL "cronjob=$cron" "concurrencyPolicy=$policy" "jobTemplateLabelSyntheticSmoke=${job_template_labels:-missing}" "wait_rc=$wait_rc" "$db_summary" missing_clause=jobTemplate_metadata_labels,manual_trigger_succeeds,concurrency_policy_is_forbid,forbid_blocks_scheduled_overlap,only_synthetic_database_changed cause=cronjob_manual_trigger_failed "evidence=$file"
  return 1
}

cmd="${1:-}"
case "$cmd" in
  V1|v1) run_v1 ;;
  V2|v2) run_v2 ;;
  V3|v3) run_v3 ;;
  V4|v4) run_v4 ;;
  V9|v9) run_v9 ;;
  V11|v11) run_v11 ;;
  all)
    failures=0
    for t in V1 V2 V3 V4 V9 V11; do
      "run_${t,,}" || failures=$((failures + 1))
    done
    exit "$failures"
    ;;
  -h|--help|help|"") usage ;;
  *) usage >&2; exit 2 ;;
esac
