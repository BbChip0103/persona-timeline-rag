#!/usr/bin/env bash
set -euo pipefail

context="${KUBE_CONTEXT:-kind-ptr-k8s}"
if [[ "$context" != "kind-ptr-k8s" ]]; then
  echo "Refusing to run outside kind-ptr-k8s" >&2
  exit 1
fi
app_namespace="${PTR_APP_NAMESPACE:-ptr-app}"
gateway_namespace="${PTR_GATEWAY_NAMESPACE:-ptr-gateway}"
worker_deployment="${PTR_WORKER_DEPLOYMENT:-ptr-worker}"
api_label="${PTR_API_LABEL:-app.kubernetes.io/component=api}"
worker_label="${PTR_WORKER_LABEL:-app.kubernetes.io/component=worker}"
fake_label="${PTR_FAKE_OPENROUTER_LABEL:-app.kubernetes.io/component=fake-openrouter}"
count="${TURN_COUNT:-16}"
reservation="${PTR_LLM_MAX_CALL_MICROUSD:-5000}"
prefix="worker-spill-$(date +%s)"
host_python="$(if command -v python3 >/dev/null 2>&1; then command -v python3; else command -v python; fi)"

cleanup() {
  if [[ "${patched:-0}" == "1" ]]; then
    restore_reservation
  fi
}
trap cleanup EXIT

restore_reservation() {
  if [[ -n "$previous_reservation" ]]; then
    timeout 60s kubectl --context "$context" -n "$app_namespace" set env "deployment/$worker_deployment" "PTR_LLM_MAX_CALL_MICROUSD=$previous_reservation" >/dev/null
  else
    timeout 60s kubectl --context "$context" -n "$app_namespace" set env "deployment/$worker_deployment" PTR_LLM_MAX_CALL_MICROUSD- >/dev/null
  fi
  timeout 180s kubectl --context "$context" -n "$app_namespace" rollout status "deployment/$worker_deployment" >/dev/null
}

pod_name() {
  local namespace="$1"
  local label="$2"
  timeout 20s kubectl --context "$context" -n "$namespace" get pod -l "$label" \
    -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' \
    | awk '{print $1}'
}

api_pod="$(pod_name "$app_namespace" "$api_label")"
worker_pod="$(pod_name "$app_namespace" "$worker_label")"
fake_pod="$(pod_name "$gateway_namespace" "$fake_label")"
if [[ -z "$api_pod" || -z "$worker_pod" || -z "$fake_pod" ]]; then
  echo "missing running api/worker/fake-openrouter pod" >&2
  exit 1
fi
previous_reservation="$(
  timeout 20s kubectl --context "$context" -n "$app_namespace" get "deployment/$worker_deployment" -o json |
    timeout 10s "$host_python" -c 'import json,sys; d=json.load(sys.stdin); print(next((e.get("value", "") for c in d["spec"]["template"]["spec"]["containers"] if c["name"]=="worker" for e in c.get("env", []) if e["name"]=="PTR_LLM_MAX_CALL_MICROUSD"), ""))'
)"

before_json="$(
  timeout 30s kubectl --context "$context" -n "$app_namespace" exec "$worker_pod" -- python -c \
    "import os,json,psycopg; conn=psycopg.connect(os.environ['PTR_LLM_DATABASE_URL']); cur=conn.cursor(); cur.execute(\"SELECT now() AS ts, COALESCE(sum(CASE WHEN actual_microusd IS NULL THEN reserved_microusd ELSE actual_microusd END),0)::bigint AS exposure, count(*)::int AS calls FROM llm.ptr_provider_requests\"); cols=[d.name for d in cur.description]; print(json.dumps(dict(zip(cols,cur.fetchone())), default=str)); conn.close()"
)"
echo "before-ledger $before_json"
before_ts="$(timeout 10s "$host_python" -c 'import json,sys; print(json.loads(sys.argv[1])["ts"])' "$before_json")"

timeout 60s kubectl --context "$context" -n "$app_namespace" set env "deployment/$worker_deployment" "PTR_LLM_MAX_CALL_MICROUSD=$reservation" >/dev/null
patched=1
timeout 180s kubectl --context "$context" -n "$app_namespace" rollout status "deployment/$worker_deployment" >/dev/null
worker_pod="$(pod_name "$app_namespace" "$worker_label")"

timeout 180s kubectl --context "$context" -n "$app_namespace" exec "$api_pod" -- node --input-type=module -e "
const count=Number(process.env.TURN_COUNT || '$count');
const prefix=process.env.K4_PREFIX || '$prefix';
async function request(path, body) {
  const response = await fetch('http://127.0.0.1:56441/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.PTR_API_SYNTHETIC_TOKEN,
      'X-PTR-Owner': 'lt-k2-synthetic',
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : {body: JSON.stringify(body)}),
  });
  if (!response.ok) throw new Error('HTTP_' + response.status);
  return response.json();
}
async function one(index) {
  const session = await request('sessions', {
    personId: 'synthetic-split-person',
    retrievalMode: 'off',
    ragCondition: 'off',
    executionProfile: 'agent_loop',
  });
  const marker = prefix + '-' + String(index).padStart(2, '0');
  const turn = await request('sessions/' + session.session.id + '/turns', {
    clientRequestId: marker,
    text: JSON.stringify({
      message: 'K4_ID:' + marker,
      status: 'answered',
      evidenceRefs: [],
      variableUpdates: {},
    }),
  });
  let final;
  for (let attempt = 0; attempt < 240; attempt++) {
    final = (await request('turns/' + turn.turn.id)).turn;
    if (['completed', 'failed', 'cancelled'].includes(final.state)) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return {state: final?.state || 'timeout', errorCode: final?.errorCode || null};
}
const settled = await Promise.allSettled(Array.from({length: count}, (_, index) => one(index)));
const results = {};
for (const item of settled) {
  const key = item.status === 'fulfilled'
    ? item.value.state + ':' + (item.value.errorCode || 'none')
    : 'error:' + (item.reason?.message || item.reason?.name || 'unknown');
  results[key] = (results[key] || 0) + 1;
}
console.log(JSON.stringify({prefix, count, results}));
if (!Object.keys(results).some(key => key.startsWith('completed:'))) process.exitCode = 1;
" 

ledger_json="$(
  timeout 30s kubectl --context "$context" -n "$app_namespace" exec "$worker_pod" -- python -c \
    "import os,json,psycopg; before='$before_ts'; conn=psycopg.connect(os.environ['PTR_LLM_DATABASE_URL']); cur=conn.cursor(); cur.execute(\"SELECT CASE WHEN generation_id LIKE 'chatcmpl-fake-openrouter-%%' THEN 'openrouter-primary' ELSE COALESCE(response_json->>'upstream','missing') END AS upstream, state, actual_microusd IS NULL AS unknown, count(*)::int AS n FROM llm.ptr_provider_requests WHERE created_at >= %s::timestamptz GROUP BY upstream,state,actual_microusd IS NULL ORDER BY upstream,state,unknown\", (before,)); cols=[d.name for d in cur.description]; print(json.dumps([dict(zip(cols,row)) for row in cur.fetchall()], default=str)); conn.close()"
)"
fake_pod="$(pod_name "$gateway_namespace" "$fake_label")"
fake_json="$(
  timeout 30s kubectl --context "$context" -n "$gateway_namespace" exec "$fake_pod" -- python -c \
    "import json,urllib.request; prefix='$prefix'; data=json.loads(urllib.request.urlopen('http://127.0.0.1:8000/counts',timeout=5).read()); ids=[x for x in data['request_ids'] if x.startswith(prefix)]; print(json.dumps({'prefix':prefix,'submitted_for_prefix':len(ids),'ids':ids,'duplicates':{k:v for k,v in data['duplicates'].items() if k.startswith(prefix)}}))"
)"
echo "ledger-window $ledger_json"
echo "fake-openrouter $fake_json"

timeout 10s "$host_python" -c '
import json, sys
ledger = json.loads(sys.argv[1])
fake = json.loads(sys.argv[2])
paid_rows = sum(row["n"] for row in ledger if row["upstream"] == "openrouter-primary")
fake_submitted = fake["submitted_for_prefix"]
if fake_submitted <= 0:
    raise SystemExit("no fake paid submissions observed")
if paid_rows != fake_submitted:
    raise SystemExit(f"paid receipt rows {paid_rows} != fake submissions {fake_submitted}")
if fake.get("duplicates"):
    raise SystemExit(f"duplicate fake submissions: {fake['duplicates']}")
print(json.dumps({"paidReceiptRows": paid_rows, "fakeSubmitted": fake_submitted}))
' "$ledger_json" "$fake_json"

restore_reservation
patched=0
