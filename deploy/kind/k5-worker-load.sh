#!/usr/bin/env bash
set -euo pipefail

context="${KUBE_CONTEXT:-kind-ptr-k8s}"
if [[ "$context" != "kind-ptr-k8s" ]]; then
  echo "Refusing to run outside kind-ptr-k8s" >&2
  exit 1
fi

app_namespace="${PTR_APP_NAMESPACE:-ptr-app}"
api_label="${PTR_API_LABEL:-app.kubernetes.io/component=api}"
worker_deployment="${PTR_WORKER_DEPLOYMENT:-ptr-worker}"
engine_namespace="ptr-inference"
engine_deployment="ptr-sim"
expected_engine_min="${K5_EXPECT_ENGINE_MIN:-2}"
expected_engine_ready="${K5_EXPECT_ENGINE_READY:-$expected_engine_min}"
expected_worker_start="${K5_EXPECT_WORKER_START:-2}"
expected_worker_min="${K5_EXPECT_WORKER_MIN:-2}"
expected_worker_cap="${K5_EXPECT_WORKER_CAP:-3}"
case_name="${K5_CASE:-}"
case "$case_name" in
  K1|K2|K3) ;;
  "") ;;
  *) echo "K5_CASE must be K1, K2, or K3" >&2; exit 1 ;;
esac
summary_path=""
if [[ -n "$case_name" ]]; then
  umask 077
  mkdir -p reports/k8s
  summary_path="reports/k8s/design64-s3-${case_name,,}-$(date -u +%Y%m%dT%H%M%S%NZ).json"
fi
require_all_completed="${K5_REQUIRE_ALL_COMPLETED:-0}"
turn_count="${TURN_COUNT:-200}"
submit_concurrency="${SUBMIT_CONCURRENCY:-80}"
poll_ms="${POLL_MS:-1000}"
timeout_seconds="${TIMEOUT_SECONDS:-900}"
scale_down_wait_seconds="${SCALE_DOWN_WAIT_SECONDS:-900}"
throughput_only="${THROUGHPUT_ONLY:-0}"
if [[ -n "$case_name" ]]; then
  expected_engine_min=1
  expected_engine_ready=1
  expected_worker_start=1
  expected_worker_min=1
  expected_worker_cap=2
  if [[ "$case_name" == K2 ]]; then expected_worker_cap=1; fi
  if [[ "$case_name" == K3 ]]; then expected_worker_start=2; expected_worker_min=2; fi
  require_all_completed=1
  throughput_only=0
  if [[ "$case_name" == K2 && -z "${TURN_COUNT:-}" ]]; then turn_count=60; fi
  if [[ "$case_name" == K1 && -z "${TURN_COUNT:-}" ]]; then turn_count=100; fi
  if [[ "$case_name" == K3 && -z "${TURN_COUNT:-}" ]]; then turn_count=40; fi
  if [[ -z "${SUBMIT_CONCURRENCY:-}" ]]; then submit_concurrency=40; fi
fi
prefix="${K5_PREFIX:-k5-load-$(date +%s)}"
host_python="$(if command -v python3 >/dev/null 2>&1; then command -v python3; else command -v python; fi)"
job_name="k5-worker-load-$(date +%s)"
metric_pod="${job_name}-metrics"
budget_restore_needed=0
worker_min_restore_needed=0
epp_restore_needed=0
engine_restore_needed=0
control_plane_ip="$(timeout 10s docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ptr-k8s-control-plane)"
if [[ ! "$control_plane_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "missing kind control-plane IP" >&2
  exit 1
fi

engine_min="$(timeout 20s kubectl --context "$context" -n "$engine_namespace" get scaledobject "$engine_deployment" -o jsonpath='{.spec.minReplicaCount}')"
engine_max="$(timeout 20s kubectl --context "$context" -n "$engine_namespace" get scaledobject "$engine_deployment" -o jsonpath='{.spec.maxReplicaCount}')"
engine_ready="$(timeout 20s kubectl --context "$context" -n "$engine_namespace" get deployment "$engine_deployment" -o jsonpath='{.status.readyReplicas}')"
if [[ "$engine_min" != "$expected_engine_min" || "${engine_ready:-0}" -lt "$expected_engine_ready" || ( -n "$case_name" && "$engine_max" != 1 ) ]]; then
  echo "engine ScaledObject must match the expected pinned replicas; got minReplicaCount=$engine_min maxReplicaCount=$engine_max readyReplicas=${engine_ready:-0}" >&2
  exit 1
fi

pod_name() {
  local namespace="$1"
  local label="$2"
  timeout 20s kubectl --context "$context" -n "$namespace" get pod -l "$label" \
    -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' \
    | awk '{print $1}'
}

api_pod="$(pod_name "$app_namespace" "$api_label")"
if [[ -z "$api_pod" ]]; then
  echo "missing running api pod" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
node_out="$work_dir/node.out"
node_err="$work_dir/node.err"

cleanup() {
  local status=0
  local remaining=""
  if [[ "$budget_restore_needed" == 1 ]]; then
    set_budget_cap 1000000 || { echo "failed to restore synthetic ledger cap" >&2; status=1; }
  fi
  if [[ "$worker_min_restore_needed" == 1 ]]; then
    timeout 20s kubectl --context "$context" -n "$app_namespace" patch scaledobject "$worker_deployment" \
      --type=merge -p '{"spec":{"minReplicaCount":1}}' >/dev/null || status=1
  fi
  if [[ "$epp_restore_needed" == 1 ]]; then
    timeout 20s kubectl --context "$context" -n "$engine_namespace" patch configmap chat-primary-epp \
      --type=merge --patch-file "$work_dir/epp-original-patch.json" >/dev/null || status=1
    timeout 20s kubectl --context "$context" -n "$engine_namespace" rollout restart deployment/chat-primary-epp >/dev/null || status=1
    timeout 180s kubectl --context "$context" -n "$engine_namespace" rollout status deployment/chat-primary-epp --timeout=160s >/dev/null || status=1
  fi
  if [[ "$engine_restore_needed" == 1 ]]; then
    timeout 20s kubectl --context "$context" -n "$engine_namespace" patch deployment "$engine_deployment" \
      --type=strategic --patch-file "$work_dir/engine-original-patch.json" >/dev/null || status=1
    timeout 180s kubectl --context "$context" -n "$engine_namespace" rollout status deployment/"$engine_deployment" --timeout=160s >/dev/null || status=1
  fi
  timeout 60s kubectl --context "$context" -n "$app_namespace" delete \
    "job/$job_name" \
    "configmap/$job_name" \
    "serviceaccount/$job_name" \
    "role/$job_name" \
    "rolebinding/$job_name" \
    "networkpolicy/$job_name" \
    --ignore-not-found --wait=true >/dev/null || status=1
  if [[ -n "$case_name" ]]; then
    timeout 60s kubectl --context "$context" -n ptr-monitoring delete pod "$metric_pod" --ignore-not-found --wait=true >/dev/null || status=1
  fi
  remaining="$(timeout 20s kubectl --context "$context" -n "$app_namespace" get job,configmap,serviceaccount,role,rolebinding,networkpolicy -o name)" || status=1
  if grep -Fq "$job_name" <<<"$remaining"; then
    echo "cleanup failed: $job_name objects remain" >&2
    status=1
  fi
  if [[ -n "$case_name" ]]; then
    remaining="$(timeout 20s kubectl --context "$context" -n ptr-monitoring get pod -o name)" || status=1
    if grep -Fq "$metric_pod" <<<"$remaining"; then
      echo "cleanup failed: $metric_pod remains" >&2
      status=1
    fi
  fi
  rm -rf "$work_dir"
  return "$status"
}
finish() {
  local status=$?
  trap - EXIT
  cleanup || status=1
  if [[ -n "$summary_path" && -f "$summary_path" ]]; then
    printf 'summaryPath=%s\n' "$summary_path"
  fi
  exit "$status"
}
trap finish EXIT

budget_cap() {
  timeout 20s kubectl --context "$context" -n ptr-data exec ptr-postgres-0 -c postgres -- sh -c \
    'PGPASSWORD="$POSTGRES_PASSWORD" psql -X -qAt -U "$POSTGRES_USER" -d ptr_split_test -c "SELECT cap_microusd FROM llm.ptr_provider_budget WHERE id = '\''global'\''"'
}

set_budget_cap() {
  local cap="$1"
  [[ "$cap" == 0 || "$cap" == 1000000 ]] || return 1
  timeout 20s kubectl --context "$context" -n ptr-data exec ptr-postgres-0 -c postgres -- sh -c \
    "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -X -qAt -U \"\$POSTGRES_USER\" -d ptr_split_test -c \"UPDATE llm.ptr_provider_budget SET cap_microusd=$cap WHERE id='global' RETURNING cap_microusd\"" \
    | grep -Fx "$cap" >/dev/null
}

metric_snapshot() {
  timeout 25s kubectl --context "$context" -n ptr-monitoring exec "$metric_pod" -- node -e '
    const prom = "http://ptr-monitoring-kube-promet-prometheus.ptr-monitoring.svc:9090/api/v1/query?query=" + encodeURIComponent("max(ptr_llm_spillover_available{namespace=\"ptr-app\"})");
    const epp = "http://chat-primary-epp.ptr-inference.svc:9090/metrics";
    Promise.all([fetch(prom,{signal:AbortSignal.timeout(5000)}).then(r=>r.json()),fetch(epp,{signal:AbortSignal.timeout(5000)}).then(r=>r.text())]).then(([g,m])=>{
      const values=g.data?.result||[];
      const line=m.split("\n").find(x=>x.startsWith("llm_d_epp_flow_control_requests_total{") && x.includes("outcome=\"RejectedCapacity\""));
      // A freshly restarted EPP has no RejectedCapacity series until its first rejection.
      if(values.length!==1)throw Error("METRIC_MISSING");
      console.log(JSON.stringify({gauge:Number(values[0].value[1]),eppRejections:line?Number(line.trim().split(/\s+/).at(-1)):0,at:Date.now()/1000}));
    }).catch(e=>{console.error(e.message||e.name);process.exitCode=1});
  '
}

fake_count() {
  local fake_pod
  fake_pod="$(pod_name "$app_namespace" 'app.kubernetes.io/component=fake-openrouter')"
  timeout 20s kubectl --context "$context" -n "$app_namespace" exec "$fake_pod" -- python -c \
    "import json,urllib.request; d=json.load(urllib.request.urlopen('http://127.0.0.1:8000/counts',timeout=5)); ids=[x for x in d['request_ids'] if x.startswith('$prefix-')]; print(json.dumps({'count':len(ids),'duplicates':sum(v-1 for k,v in d['duplicates'].items() if k.startswith('$prefix-'))}))"
}

worker_retry_snapshot() {
  local names pod retry
  local -a values=()
  names="$(timeout 20s kubectl --context "$context" -n "$app_namespace" get pods \
    -l 'app.kubernetes.io/component=worker,!ptr.io/probe' \
    -o json | "$host_python" -c 'import json,sys; pods=json.load(sys.stdin)["items"]; print(" ".join(p["metadata"]["name"] for p in pods if not p["metadata"].get("deletionTimestamp") and any(c["type"]=="Ready" and c["status"]=="True" for c in p["status"].get("conditions",[]))))')"
  [[ -n "$names" ]] || return 1
  for pod in $names; do
    retry="$(timeout 20s kubectl --context "$context" -n "$app_namespace" exec "$pod" -c worker -- python -c '
import urllib.request
metrics = urllib.request.urlopen("http://127.0.0.1:58442/metrics", timeout=5).read().decode()
values = [line.split()[-1] for line in metrics.splitlines() if line.startswith("ptr_llm_local_capacity_retries_total ")]
assert len(values) == 1
print(values[0])
')"
    values+=("$pod=$retry")
  done
  "$host_python" - "${values[@]}" <<'PY'
import json, sys
print(json.dumps(dict(item.split("=", 1) for item in sys.argv[1:])))
PY
}

ledger_count() {
  timeout 20s kubectl --context "$context" -n ptr-data exec ptr-postgres-0 -c postgres -- sh -c \
    "PGPASSWORD=\"\$POSTGRES_PASSWORD\" psql -X -qAt -U \"\$POSTGRES_USER\" -d ptr_split_test -c \"SELECT count(*) FROM llm.ptr_provider_requests p JOIN app.turns t ON t.id=p.turn_id WHERE t.client_request_id LIKE '$prefix-%' AND p.state='settled'\""
}

api_image="$(timeout 20s kubectl --context "$context" -n "$app_namespace" get deployment -l "$api_label" -o jsonpath='{.items[0].spec.template.spec.containers[?(@.name=="api")].image}')"
api_secret="$(timeout 20s kubectl --context "$context" -n "$app_namespace" get deployment -l "$api_label" -o jsonpath='{.items[0].spec.template.spec.containers[?(@.name=="api")].env[?(@.name=="PTR_API_SYNTHETIC_TOKEN")].valueFrom.secretKeyRef.name}')"
if [[ -z "$api_image" || -z "$api_secret" ]]; then
  echo "missing api image or secret reference" >&2
  exit 1
fi

if [[ -n "$case_name" ]]; then
  if [[ "$(budget_cap)" != 1000000 ]]; then
    echo "synthetic ledger cap must start at 1000000 microUSD" >&2
    exit 1
  fi
  budget_restore_needed=1
  if [[ "$case_name" == K2 || "$case_name" == K3 ]]; then set_budget_cap 0; fi
  if [[ "$case_name" == K3 ]]; then
    current_min="$(timeout 20s kubectl --context "$context" -n "$app_namespace" get scaledobject "$worker_deployment" -o jsonpath='{.spec.minReplicaCount}')"
    [[ "$current_min" == 1 ]] || { echo "K3 requires worker minReplicaCount=1 before pinning at 2" >&2; exit 1; }
    worker_min_restore_needed=1
    timeout 20s kubectl --context "$context" -n "$app_namespace" patch scaledobject "$worker_deployment" \
      --type=merge -p '{"spec":{"minReplicaCount":2}}' >/dev/null
    for ((i=0; i<60; i++)); do
      ready_workers="$(timeout 20s kubectl --context "$context" -n "$app_namespace" get deployment "$worker_deployment" -o jsonpath='{.status.readyReplicas}')"
      if [[ "$ready_workers" == 2 ]]; then break; fi
      sleep 2
    done
    [[ "$ready_workers" == 2 ]] || { echo "K3 did not reach two Ready workers" >&2; exit 1; }
    timeout 20s kubectl --context "$context" -n "$engine_namespace" get deployment "$engine_deployment" -o json | \
      "$host_python" -c '
import json, sys
from pathlib import Path
d = json.load(sys.stdin)
containers = [c for c in d["spec"]["template"]["spec"]["containers"] if c["name"] == "sim"]
assert len(containers) == 1
args = containers[0]["args"]
assert args.count("--time-to-first-token=8s") == 1, "K3 requires default simulator latency"
work = Path(sys.argv[1])
def patch(value):
    return {"spec": {"template": {"spec": {"containers": [{"name": "sim", "args": value}]}}}}
(work / "engine-original-patch.json").write_text(json.dumps(patch(args)))
(work / "engine-k3-patch.json").write_text(json.dumps(patch([a.replace("--time-to-first-token=8s", "--time-to-first-token=4s") for a in args])))
' "$work_dir"
    engine_restore_needed=1
    timeout 20s kubectl --context "$context" -n "$engine_namespace" patch deployment "$engine_deployment" \
      --type=strategic --patch-file "$work_dir/engine-k3-patch.json" >/dev/null
    timeout 180s kubectl --context "$context" -n "$engine_namespace" rollout status deployment/"$engine_deployment" --timeout=160s >/dev/null
    timeout 20s kubectl --context "$context" -n "$engine_namespace" get configmap chat-primary-epp -o json | \
      "$host_python" -c '
import json, sys
from pathlib import Path
d = json.load(sys.stdin)
old = d["data"]["default-plugins.yaml"]
assert old.count("maxRequests: \"8\"") == 1, "K3 requires the default kind EPP cap of 8"
work = Path(sys.argv[1])
(work / "epp-original-patch.json").write_text(json.dumps({"data": {"default-plugins.yaml": old}}))
(work / "epp-k3-patch.json").write_text(json.dumps({"data": {"default-plugins.yaml": old.replace("maxRequests: \"8\"", "maxRequests: \"1\"")}}))
' "$work_dir"
    epp_restore_needed=1
    timeout 20s kubectl --context "$context" -n "$engine_namespace" patch configmap chat-primary-epp \
      --type=merge --patch-file "$work_dir/epp-k3-patch.json" >/dev/null
    timeout 20s kubectl --context "$context" -n "$engine_namespace" rollout restart deployment/chat-primary-epp >/dev/null
    timeout 180s kubectl --context "$context" -n "$engine_namespace" rollout status deployment/chat-primary-epp --timeout=160s >/dev/null
    worker_retry_snapshot >"$work_dir/before-worker-retries.json"
  fi
  timeout 30s kubectl --context "$context" -n ptr-monitoring run "$metric_pod" \
    --restart=Never --labels='app.kubernetes.io/name=prometheus' \
    --image="$api_image" --image-pull-policy=IfNotPresent \
    --command -- node -e 'setInterval(() => {}, 60000)' >/dev/null
  timeout 60s kubectl --context "$context" -n ptr-monitoring wait --for=condition=Ready "pod/$metric_pod" --timeout=55s >/dev/null
  expected_gauge=1
  if [[ "$case_name" == K2 || "$case_name" == K3 ]]; then expected_gauge=0; fi
  for ((i=0; i<30; i++)); do
    metric_snapshot >"$work_dir/before-metrics.json"
    if "$host_python" -c 'import json,sys; raise SystemExit(json.load(open(sys.argv[1]))["gauge"] != int(sys.argv[2]))' "$work_dir/before-metrics.json" "$expected_gauge"; then break; fi
    sleep 2
  done
  "$host_python" -c 'import json,sys; assert json.load(open(sys.argv[1]))["gauge"] == int(sys.argv[2]), "starting gauge mismatch"' "$work_dir/before-metrics.json" "$expected_gauge"
  fake_count >"$work_dir/before-fake.json"
  ledger_count >"$work_dir/before-ledger.txt"
  timeout 20s kubectl --context "$context" -n "$app_namespace" get deployment "$worker_deployment" -o json |
    "$host_python" -c 'import json,sys; d=json.load(sys.stdin); values=[e.get("value") for c in d["spec"]["template"]["spec"]["containers"] if c["name"] == "worker" for e in c.get("env",[]) if e["name"] == "PTR_LLM_CONCURRENCY"]; assert len(values)==1 and int(values[0])>0; print(values[0])' >"$work_dir/worker-concurrency.txt"
fi

timeout 30s kubectl --context "$context" -n "$app_namespace" create configmap "$job_name" \
  --from-file=probe.mjs=/dev/stdin <<'NODE'
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import pg from 'pg';

const { Client } = pg;

const terminalStates = new Set(['completed', 'failed', 'cancelled']);
const prefix = process.env.K5_PREFIX;
const turnCount = Number(process.env.TURN_COUNT || '200');
const submitConcurrency = Number(process.env.SUBMIT_CONCURRENCY || '80');
const pollMs = Number(process.env.POLL_MS || '1000');
const scaleDownWaitSeconds = Number(process.env.SCALE_DOWN_WAIT_SECONDS || '900');
const throughputOnly = process.env.THROUGHPUT_ONLY === '1';
const expectedWorkerMin = Number(process.env.K5_EXPECT_WORKER_MIN || '2');
const requireAllCompleted = process.env.K5_REQUIRE_ALL_COMPLETED === '1';
const appNamespace = process.env.PTR_K8S_NAMESPACE || 'ptr-app';
const workerDeployment = process.env.PTR_WORKER_DEPLOYMENT || 'ptr-worker';
const owner = 'lt-k5-synthetic';
const started = Date.now();
const serviceAccountToken = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
const serviceAccountCa = fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/ca.crt');

function elapsedSeconds() {
  return Number(((Date.now() - started) / 1000).toFixed(3));
}

function event(name, body = {}) {
  console.log(JSON.stringify({ event: name, elapsedSeconds: elapsedSeconds(), ...body }));
}

function assertSafeConfig() {
  if (!prefix || !/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error('INVALID_PREFIX');
  if (!Number.isInteger(turnCount) || turnCount < 1 || turnCount > 1000) throw new Error('INVALID_TURN_COUNT');
  if (!Number.isInteger(submitConcurrency) || submitConcurrency < 1 || submitConcurrency > 200) throw new Error('INVALID_SUBMIT_CONCURRENCY');
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 10000) throw new Error('INVALID_POLL_MS');
  if (!Number.isInteger(scaleDownWaitSeconds) || scaleDownWaitSeconds < 1 || scaleDownWaitSeconds > 1800) throw new Error('INVALID_SCALE_DOWN_WAIT_SECONDS');
}

async function request(path, body) {
  const response = await fetch(`${process.env.PTR_API_BASE_URL}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PTR_API_SYNTHETIC_TOKEN}`,
      'X-PTR-Owner': owner,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function kubernetesJson(path) {
  return new Promise((resolve, reject) => {
    const request = https.request({
      hostname: 'kubernetes.default.svc',
      port: 443,
      path,
      method: 'GET',
      ca: serviceAccountCa,
      headers: {
        Authorization: `Bearer ${serviceAccountToken}`,
        Accept: 'application/json',
      },
      timeout: 5000,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode > 299) {
          reject(new Error(`K8S_HTTP_${response.statusCode}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch {
          reject(new Error('K8S_INVALID_JSON'));
        }
      });
    });
    request.on('timeout', () => {
      request.destroy(new Error('K8S_TIMEOUT'));
    });
    request.on('error', reject);
    request.end();
  });
}

async function sampleWorkerReplicas() {
  let deployment;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      deployment = await kubernetesJson(
        `/apis/apps/v1/namespaces/${appNamespace}/deployments/${workerDeployment}`,
      );
      break;
    } catch (error) {
      if (attempt === 2 || !['K8S_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT'].includes(error?.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  const sample = {
    desired: Number(deployment.spec?.replicas ?? 0),
    replicas: Number(deployment.status?.replicas ?? 0),
    ready: Number(deployment.status?.readyReplicas ?? 0),
    available: Number(deployment.status?.availableReplicas ?? 0),
  };
  event('replica_sample', sample);
  return sample;
}

async function submitTurn(index) {
  const session = await request('sessions', {
    personId: 'synthetic-split-person',
    retrievalMode: 'off',
    ragCondition: 'off',
    executionProfile: 'agent_loop',
  });
  const clientRequestId = `${prefix}-${String(index).padStart(4, '0')}`;
  const turn = await request(`sessions/${session.session.id}/turns`, {
    clientRequestId,
    text: JSON.stringify({
      message: `K4_ID:${clientRequestId}`,
      status: 'answered',
      evidenceRefs: [],
      variableUpdates: {},
    }),
  });
  return turn.turn.id;
}

function encodeRedisCommand(args) {
  return `*${args.length}\r\n${args.map(arg => {
    const value = String(arg);
    return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }).join('')}`;
}

function parseRedisResponse(buffer, offset = 0) {
  const type = buffer[offset];
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;
  const line = buffer.slice(offset + 1, lineEnd).toString('utf8');
  if (type === 43) return { value: line, offset: lineEnd + 2 };
  if (type === 58) return { value: Number(line), offset: lineEnd + 2 };
  if (type === 45) throw new Error('REDIS_ERROR');
  if (type === 36) {
    const length = Number(line);
    if (length < 0) return { value: null, offset: lineEnd + 2 };
    const start = lineEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.slice(start, end).toString('utf8'), offset: end + 2 };
  }
  throw new Error('REDIS_UNSUPPORTED_RESPONSE');
}

async function redisCommand(args) {
  const redisUrl = new URL(process.env.PTR_REDIS_URL);
  const commands = [];
  if (redisUrl.password) {
    const username = decodeURIComponent(redisUrl.username || 'default');
    const password = decodeURIComponent(redisUrl.password);
    commands.push(['AUTH', username, password]);
  }
  commands.push(args);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: redisUrl.hostname,
      port: Number(redisUrl.port || '6379'),
    });
    let buffer = Buffer.alloc(0);
    let expected = commands.length;
    let lastValue;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('REDIS_TIMEOUT'));
    }, 5000);
    socket.on('connect', () => {
      socket.write(commands.map(encodeRedisCommand).join(''));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (expected > 0) {
          const parsed = parseRedisResponse(buffer);
          if (!parsed) return;
          lastValue = parsed.value;
          buffer = buffer.slice(parsed.offset);
          expected -= 1;
        }
        clearTimeout(timer);
        socket.end();
        resolve(lastValue);
      } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function sampleQueues() {
  const [wait, active] = await Promise.all([
    redisCommand(['LLEN', 'ptr:turns:wait']).catch(() => null),
    redisCommand(['LLEN', 'ptr:turns:active']).catch(() => null),
  ]);
  event('queue_sample', { wait, active });
  return { wait, active };
}

async function states(client, turnIds) {
  const result = await client.query(
    `SELECT state, count(*)::int AS n
       FROM app.turns
      WHERE id = ANY($1::text[])
      GROUP BY state
      ORDER BY state`,
    [turnIds],
  );
  const counts = Object.fromEntries(result.rows.map(row => [row.state, row.n]));
  const terminal = Object.entries(counts)
    .filter(([state]) => terminalStates.has(state))
    .reduce((sum, [, n]) => sum + n, 0);
  return { counts, terminal };
}

async function proof(client, turnIds) {
  const result = await client.query(
    `WITH target AS (
       SELECT id, state, error_code
         FROM app.turns
        WHERE id = ANY($1::text[])
     ), assistant_counts AS (
       SELECT t.id, count(m.*)::int AS n
         FROM target t
         LEFT JOIN app.messages m ON m.turn_id = t.id AND m.role = 'assistant'
        GROUP BY t.id
     ), grant_counts AS (
       SELECT t.id, count(g.*)::int AS n
         FROM target t
         LEFT JOIN app.turn_execution_grants g ON g.turn_id = t.id AND g.result_hash IS NOT NULL
        GROUP BY t.id
     )
     SELECT
       count(*)::int AS observed,
       (count(*) FILTER (WHERE t.state IN ('completed','failed','cancelled')))::int AS terminal,
       (count(*) FILTER (WHERE t.state = 'completed'))::int AS completed,
       (count(*) FILTER (WHERE t.state = 'failed'))::int AS failed,
       (count(*) FILTER (WHERE t.state = 'cancelled'))::int AS cancelled,
       COALESCE((SELECT count(*)::int FROM app.turn_outbox o WHERE o.turn_id = ANY($1::text[])), 0)::int AS outbox,
       (count(*) FILTER (WHERE t.state = 'completed' AND a.n <> 1))::int AS assistant_not_exactly_once,
       (count(*) FILTER (WHERE t.state = 'completed' AND g.n <> 1))::int AS grants_not_exactly_once,
       (count(*) FILTER (WHERE t.state = 'completed' AND (a.n > 1 OR g.n > 1)))::int AS duplicate_completion_rows,
       jsonb_object_agg(COALESCE(t.error_code, 'none'), c.n) FILTER (WHERE c.n IS NOT NULL) AS error_codes
      FROM target t
      JOIN assistant_counts a ON a.id = t.id
      JOIN grant_counts g ON g.id = t.id
      LEFT JOIN (
        SELECT COALESCE(error_code, 'none') AS code, count(*)::int AS n
          FROM target
         GROUP BY COALESCE(error_code, 'none')
      ) c ON c.code = COALESCE(t.error_code, 'none')`,
    [turnIds],
  );
  return result.rows[0];
}

async function main() {
  assertSafeConfig();
  event('start', { prefix, turnCount, submitConcurrency });
  if (!throughputOnly) {
    await sampleWorkerReplicas();
    await sampleQueues();
  }
  const turnIds = await mapLimit(Array.from({ length: turnCount }, (_, index) => index), submitConcurrency, submitTurn);
  event('submitted', { submitted: turnIds.length });
  if (!throughputOnly) await sampleWorkerReplicas();

  const client = new Client({ connectionString: process.env.PTR_APP_DATABASE_URL });
  await client.connect();
  try {
    const deadline = Date.now() + 840000;
    let current = { counts: {}, terminal: 0 };
    while (Date.now() < deadline) {
      current = await states(client, turnIds);
      if (!throughputOnly) {
        await sampleWorkerReplicas();
        await sampleQueues();
      }
      event('state_sample', { terminal: current.terminal, states: current.counts });
      if (current.terminal === turnIds.length) {
        event('all_completed', { atEpochSeconds: Date.now() / 1000 });
        break;
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    if (!throughputOnly) {
      const scaleDownDeadline = Date.now() + scaleDownWaitSeconds * 1000;
      while (Date.now() < scaleDownDeadline) {
        const sample = await sampleWorkerReplicas();
        if (sample.desired <= expectedWorkerMin) break;
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
    const final = await proof(client, turnIds);
    const passed = final.observed === turnIds.length
      && final.terminal === turnIds.length
      && (requireAllCompleted ? final.completed === turnIds.length : final.completed > turnIds.length / 2)
      && Number(final.error_codes?.PROVIDER_BUDGET_EXCEEDED ?? 0) === 0
      && final.outbox === 0
      && final.duplicate_completion_rows === 0
      && final.assistant_not_exactly_once === 0
      && final.grants_not_exactly_once === 0;
    event('result', {
      passed,
      prefix,
      expected: turnIds.length,
      observed: final.observed,
      terminal: final.terminal,
      completed: final.completed,
      failed: final.failed,
      cancelled: final.cancelled,
      outbox: final.outbox,
      assistantNotExactlyOnce: final.assistant_not_exactly_once,
      grantsNotExactlyOnce: final.grants_not_exactly_once,
      duplicateCompletionRows: final.duplicate_completion_rows,
      errorCodes: final.error_codes || {},
    });
    if (!passed) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  const code = /^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : error?.name || 'K5_WORKER_LOAD_FAILED';
  console.error(JSON.stringify({ event: 'error', elapsedSeconds: elapsedSeconds(), code }));
  process.exitCode = 1;
});
NODE

timeout 30s kubectl --context "$context" -n "$app_namespace" apply -f - <<YAML
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $job_name
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: $job_name
rules:
  - apiGroups: ["apps"]
    resources: ["deployments"]
    resourceNames: ["$worker_deployment"]
    verbs: ["get"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: $job_name
subjects:
  - kind: ServiceAccount
    name: $job_name
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: $job_name
---
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: $job_name
spec:
  podSelector:
    matchLabels:
      ptr.io/probe: k5-worker-load
  policyTypes: [Egress]
  egress:
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: ptr
              app.kubernetes.io/component: api
      ports:
        - {protocol: TCP, port: 56441}
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ptr-data
          podSelector:
            matchLabels:
              app.kubernetes.io/name: ptr
              app.kubernetes.io/component: postgres
      ports:
        - {protocol: TCP, port: 5432}
    - to:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ptr-data
          podSelector:
            matchLabels:
              app.kubernetes.io/name: ptr
              app.kubernetes.io/component: redis
      ports:
        - {protocol: TCP, port: 6379}
    - to:
        - ipBlock: {cidr: 10.96.0.1/32}
        - ipBlock: {cidr: $control_plane_ip/32}
      ports:
        - {protocol: TCP, port: 443}
        - {protocol: TCP, port: 6443}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: $job_name
spec:
  backoffLimit: 0
  activeDeadlineSeconds: $timeout_seconds
  template:
    metadata:
      labels:
        app.kubernetes.io/name: ptr
        app.kubernetes.io/component: worker
        ptr.network/role: app
        ptr.io/probe: k5-worker-load
    spec:
      restartPolicy: Never
      serviceAccountName: $job_name
      automountServiceAccountToken: true
      terminationGracePeriodSeconds: 5
      securityContext:
        runAsNonRoot: true
        runAsUser: 900
        runAsGroup: 2000
        fsGroup: 2000
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: probe
          image: "$api_image"
          imagePullPolicy: IfNotPresent
          command: ["node", "/app/probe/probe.mjs"]
          env:
            - {name: K5_PREFIX, value: "$prefix"}
            - {name: TURN_COUNT, value: "$turn_count"}
            - {name: SUBMIT_CONCURRENCY, value: "$submit_concurrency"}
            - {name: POLL_MS, value: "$poll_ms"}
            - {name: SCALE_DOWN_WAIT_SECONDS, value: "$scale_down_wait_seconds"}
            - {name: THROUGHPUT_ONLY, value: "$throughput_only"}
            - {name: K5_EXPECT_WORKER_MIN, value: "$expected_worker_min"}
            - {name: K5_REQUIRE_ALL_COMPLETED, value: "$require_all_completed"}
            - {name: PTR_K8S_NAMESPACE, value: "$app_namespace"}
            - {name: PTR_WORKER_DEPLOYMENT, value: "$worker_deployment"}
            - {name: PTR_API_BASE_URL, value: "http://ptr-api.$app_namespace.svc.cluster.local:56441"}
            - name: PTR_API_SYNTHETIC_TOKEN
              valueFrom:
                secretKeyRef: {name: "$api_secret", key: PTR_API_SYNTHETIC_TOKEN}
            - name: PTR_APP_DATABASE_URL
              valueFrom:
                secretKeyRef: {name: "$api_secret", key: PTR_APP_DATABASE_URL}
            - name: PTR_REDIS_URL
              valueFrom:
                secretKeyRef: {name: "$api_secret", key: PTR_REDIS_URL}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - {name: probe, mountPath: /app/probe, readOnly: true}
            - {name: tmp, mountPath: /tmp}
      volumes:
        - name: probe
          configMap: {name: "$job_name"}
        - name: tmp
          emptyDir: {}
YAML

probe_status=124
job_deadline=$((SECONDS + timeout_seconds))
if [[ "$case_name" == K3 ]]; then
  cp "$work_dir/before-worker-retries.json" "$work_dir/retry-previous.json"
fi
while (( SECONDS < job_deadline )); do
  if [[ "$case_name" == K3 ]]; then
    if [[ ! -f "$work_dir/first-rejection.json" ]]; then
      worker_retry_snapshot >"$work_dir/retry-current.json"
      metric_snapshot >"$work_dir/metric-current.json"
      if "$host_python" - "$work_dir/before-metrics.json" "$work_dir/metric-current.json" <<'PY'
import json, sys
before, current = (json.load(open(path)) for path in sys.argv[1:])
raise SystemExit(current["eppRejections"] <= before["eppRejections"])
PY
      then
        cp "$work_dir/retry-previous.json" "$work_dir/active-retries-start.json"
        cp "$work_dir/metric-current.json" "$work_dir/first-rejection.json"
      else
        mv "$work_dir/retry-current.json" "$work_dir/retry-previous.json"
      fi
    fi
    if [[ ! -f "$work_dir/active-retries-end.json" ]]; then
      timeout 20s kubectl --context "$context" -n "$app_namespace" logs "job/$job_name" >"$work_dir/live-node.out" 2>/dev/null || true
      if grep -Fq '"event":"all_completed"' "$work_dir/live-node.out"; then
        worker_retry_snapshot >"$work_dir/active-retries-end.json"
      fi
    fi
  fi
  job_counts="$(timeout 20s kubectl --context "$context" -n "$app_namespace" get job "$job_name" -o json | \
    "$host_python" -c 'import json,sys; s=json.load(sys.stdin).get("status",{}); print(s.get("succeeded",0),s.get("failed",0))')"
  read -r job_succeeded job_failed <<<"$job_counts"
  if [[ "${job_succeeded:-0}" == 1 ]]; then probe_status=0; break; fi
  if [[ "${job_failed:-0}" =~ ^[1-9][0-9]*$ ]]; then probe_status=1; break; fi
  sleep 2
done

timeout 60s kubectl --context "$context" -n "$app_namespace" logs "job/$job_name" >"$node_out" 2>"$node_err" || true

timeout 30s "$host_python" - "$node_out" <<'PY'
import json, sys
for line in open(sys.argv[1]):
    event = json.loads(line)
    if event.get("event") in {"start", "submitted", "result", "error"}:
        print(json.dumps(event))
PY
if [[ -s "$node_err" ]]; then
  timeout 30s sed 's/^/stderr /' "$node_err" >&2
fi

if [[ -n "$case_name" ]]; then
  metric_snapshot >"$work_dir/after-metrics.json"
  fake_count >"$work_dir/after-fake.json"
  ledger_count >"$work_dir/after-ledger.txt"
  if [[ "$case_name" == K3 ]]; then worker_retry_snapshot >"$work_dir/after-worker-retries.json"; fi
fi

env K5_EXPECT_WORKER_CAP="$expected_worker_cap" K5_EXPECT_WORKER_START="$expected_worker_start" K5_EXPECT_WORKER_MIN="$expected_worker_min" \
  timeout 30s "$host_python" - "$node_out" "$probe_status" "$throughput_only" "$case_name" "$work_dir" "$summary_path" <<'PY'
import json
import os
import sys
from pathlib import Path

node_path = Path(sys.argv[1])
probe_status = int(sys.argv[2])
throughput_only = sys.argv[3] == "1"
case_name = sys.argv[4]
work_dir = Path(sys.argv[5])
summary_path = Path(sys.argv[6]) if sys.argv[6] else None

events = [json.loads(line) for line in node_path.read_text().splitlines() if line.strip()]
replicas = [event for event in events if event.get("event") == "replica_sample"]
submitted = next((event for event in events if event.get("event") == "submitted"), None)
result = next((event for event in events if event.get("event") == "result"), None)
all_completed = next((event for event in events if event.get("event") == "all_completed"), None)
queue_samples = [event for event in events if event.get("event") == "queue_sample"]

submitted_at = submitted.get("elapsedSeconds") if submitted else None
scale_deadline = submitted_at + 60 if isinstance(submitted_at, (int, float)) else 60
within_60 = [row for row in replicas if row["elapsedSeconds"] <= scale_deadline]
active_samples = [row for row in queue_samples if isinstance(row.get("active"), int) and row["active"] > 0]
active_max = max((row["active"] for row in active_samples), default=0)
wait_max = max((row.get("wait") for row in queue_samples if isinstance(row.get("wait"), int)), default=0)
active_first = min((row["elapsedSeconds"] for row in active_samples), default=None)
active_last = max((row["elapsedSeconds"] for row in active_samples), default=None)
desired_start = replicas[0]["desired"] if replicas else None
ready_start = replicas[0]["ready"] if replicas else None
desired_peak_60 = max((row["desired"] for row in within_60), default=0)
ready_peak_60 = max((row["ready"] for row in within_60), default=0)
desired_peak_all = max((row["desired"] for row in replicas), default=0)
ready_peak_all = max((row["ready"] for row in replicas), default=0)
desired_final = replicas[-1]["desired"] if replicas else None
ready_final = replicas[-1]["ready"] if replicas else None
while_active = [
    row for row in replicas
    if active_first is not None and active_last is not None and active_first <= row["elapsedSeconds"] <= active_last
]
desired_min_while_active = min((row["desired"] for row in while_active), default=None)
downsteps_while_active = sum(
    current["desired"] < previous["desired"]
    for previous, current in zip(while_active, while_active[1:])
)
expected_cap = int(os.environ.get("K5_EXPECT_WORKER_CAP", "3"))
expected_start = int(os.environ.get("K5_EXPECT_WORKER_START", "2"))
expected_min = int(os.environ.get("K5_EXPECT_WORKER_MIN", "2"))
cap_observed = bool(replicas) and all(
    row["desired"] <= expected_cap and row["ready"] <= expected_cap for row in replicas
)
cap_reached = desired_peak_60 >= expected_cap and ready_peak_60 >= expected_cap
scale_up_passed = desired_start == expected_start and ready_start == expected_start and cap_observed and cap_reached
active_hold_passed = bool(active_samples) and downsteps_while_active == 0
scale_down_passed = desired_final == expected_min and ready_final == expected_min

summary = {
    "event": "host_summary",
    "probeExitCode": probe_status,
    "replicaSamples": len(replicas),
    "case": case_name or None,
    "desiredStart": desired_start,
    "readyStart": ready_start,
    "desiredPeakWithin60sAfterSubmit": desired_peak_60,
    "readyPeakWithin60sAfterSubmit": ready_peak_60,
    "desiredPeakAll": desired_peak_all,
    "readyPeakAll": ready_peak_all,
    "expectedWorkerCap": expected_cap,
    "workerCapObserved": cap_observed,
    "workerCapReached": cap_reached,
    "desiredFinal": desired_final,
    "readyFinal": ready_final,
    "scaleDownToMinObserved": desired_final is not None and desired_final <= expected_min,
    "waitListMax": wait_max,
    "activeListMax": active_max,
    "desiredMinWhileActiveApprox": desired_min_while_active,
    "desiredDownstepsWhileActiveApprox": downsteps_while_active,
    "scaleUpWithin60sPassed": scale_up_passed,
    "activeHoldPassed": active_hold_passed,
    "scaleDownPassed": scale_down_passed,
    "terminalProofPassed": bool(result and result.get("passed")),
    "submittedTurns": submitted.get("submitted") if submitted else None,
    "completedTurns": result.get("completed") if result else None,
    "failedTurns": result.get("failed") if result else None,
    "cancelledTurns": result.get("cancelled") if result else None,
    "outboxRows": result.get("outbox") if result else None,
    "duplicateCompletionRows": result.get("duplicateCompletionRows") if result else None,
}
case_passed = True
if case_name:
    before = json.loads((work_dir / "before-metrics.json").read_text())
    after = json.loads((work_dir / "after-metrics.json").read_text())
    fake_before = json.loads((work_dir / "before-fake.json").read_text())
    fake_after = json.loads((work_dir / "after-fake.json").read_text())
    ledger_before = int((work_dir / "before-ledger.txt").read_text().strip())
    ledger_after = int((work_dir / "after-ledger.txt").read_text().strip())
    fake_delta = fake_after["count"] - fake_before["count"]
    ledger_delta = ledger_after - ledger_before
    rejection_delta = after["eppRejections"] - before["eppRejections"]
    duration = after["at"] - before["at"]
    worker_concurrency = int((work_dir / "worker-concurrency.txt").read_text().strip())
    retry_rate_bound = worker_concurrency * 4
    expected_gauge = 0 if case_name in ("K2", "K3") else 1
    worker_retry_delta = None
    if case_name == "K3":
        retries_before = json.loads((work_dir / "before-worker-retries.json").read_text())
        retries_after = json.loads((work_dir / "after-worker-retries.json").read_text())
        if retries_before.keys() == retries_after.keys() and len(retries_before) == 2:
            worker_retry_delta = sum(
                float(retries_after[pod]) - float(retries_before[pod])
                for pod in retries_before
            )
    retry_count = worker_retry_delta if case_name == "K3" else rejection_delta
    retry_rate = retry_count / duration if retry_count is not None and duration > 0 else float("inf")
    rejection_rate = rejection_delta / duration if duration > 0 else float("inf")
    active_seconds = None
    active_retry_by_pod = None
    active_retry_rate_by_pod = None
    active_cluster_retry_rate = None
    first_rejection_at = None
    last_completion_at = all_completed.get("atEpochSeconds") if all_completed else None
    if case_name == "K3" and all(
        (work_dir / name).exists() for name in (
            "first-rejection.json", "active-retries-start.json", "active-retries-end.json"
        )
    ):
        first_rejection_at = json.loads((work_dir / "first-rejection.json").read_text())["at"]
        active_seconds = last_completion_at - first_rejection_at if last_completion_at else None
        active_start = json.loads((work_dir / "active-retries-start.json").read_text())
        active_end = json.loads((work_dir / "active-retries-end.json").read_text())
        if active_seconds and active_seconds > 0 and active_start.keys() == active_end.keys() and len(active_start) == 2:
            active_retry_by_pod = {
                pod: float(active_end[pod]) - float(active_start[pod]) for pod in active_start
            }
            active_retry_rate_by_pod = {
                pod: round(delta / active_seconds, 3) for pod, delta in active_retry_by_pod.items()
            }
            active_cluster_retry_rate = round(sum(active_retry_by_pod.values()) / active_seconds, 3)
    case_passed = (
        before["gauge"] == expected_gauge
        and (case_name != "K3" or submitted is not None and result is not None
             and result.get("expected") == submitted.get("submitted")
             and result.get("completed") == submitted.get("submitted")
             and result.get("failed") == 0)
        and (fake_delta > 0 if case_name == "K1" else fake_delta == 0)
        and fake_delta == ledger_delta
        and fake_after["duplicates"] == 0
        and (rejection_delta > 0 if case_name == "K3" else rejection_delta >= 0)
        and (case_name != "K3" or worker_retry_delta is not None and worker_retry_delta > 0)
        and (case_name != "K3" or active_retry_by_pod is not None
             and all(delta >= 0 and delta / active_seconds <= retry_rate_bound
                     for delta in active_retry_by_pod.values()))
        and (case_name == "K3" or retry_rate <= retry_rate_bound)
        and (case_name != "K3" or after["gauge"] == 0)
        and len(replicas) > 0
        and cap_observed
    )
    summary.update({
        "gaugeStart": before["gauge"], "gaugeEnd": after["gauge"],
        "fakeSubmissionsDelta": fake_delta, "ledgerDelta": ledger_delta,
        "fakeDuplicateSubmissions": fake_after["duplicates"],
        "eppMetric": 'llm_d_epp_flow_control_requests_total{outcome="RejectedCapacity"}',
        "eppRejectionsBefore": before["eppRejections"],
        "eppRejectionsAfter": after["eppRejections"],
        "eppRejectionsDelta": rejection_delta,
        "eppRejectionRatePerSecond": round(rejection_rate, 3),
        "retryRatePerSecond": round(retry_rate, 3),
        "retryRateBoundPerSecond": retry_rate_bound,
        "workerLocalRetriesDelta": worker_retry_delta,
        "workerLocalRetriesSource": "ptr_llm_local_capacity_retries_total" if case_name == "K3" else None,
        "firstRejectionObservedAtEpochSeconds": first_rejection_at,
        "lastCompletionAtEpochSeconds": last_completion_at,
        "activeWindowSeconds": round(active_seconds, 3) if active_seconds is not None else None,
        "activeWorkerRetriesByPod": active_retry_by_pod,
        "activeWorkerRetryRateByPodPerSecond": active_retry_rate_by_pod,
        "activeClusterRetryRatePerSecond": active_cluster_retry_rate,
        "activeWindowStartMethod": "first observed EPP rejection; preceding worker counter sample" if case_name == "K3" else None,
        "eppFlowControlMaxRequests": 1 if case_name == "K3" else None,
        "engineTimeToFirstToken": "4s" if case_name == "K3" else None,
        "casePassed": case_passed,
    })
print(json.dumps(summary))
if summary_path:
    with os.fdopen(os.open(summary_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(summary, output, sort_keys=True)
        output.write("\n")

if (probe_status != 0 or not result or not result.get("passed")
        or not case_passed
        or not throughput_only and (not replicas or not scale_up_passed or (case_name != "K3" and not active_hold_passed) or not scale_down_passed)):
    raise SystemExit(1)
PY
