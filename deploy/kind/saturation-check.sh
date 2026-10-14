#!/usr/bin/env bash
set -euo pipefail

context=kind-ptr-k8s
namespace=ptr-inference
pod="ptr-saturation-$(date +%s)-$$"
request_prefix="sat-$(date +%s)-$$"
evidence_dir="${K8S_EVIDENCE_DIR:-reports/k8s}"
image="$(timeout 10s kubectl --context "$context" -n ptr-app get deployment ptr-api -o jsonpath='{.spec.template.spec.containers[0].image}')"

capture_failure() {
  mkdir -p "$evidence_dir"
  chmod 700 "$evidence_dir"
  local evidence="$evidence_dir/${request_prefix}.private.log"
  {
    echo "request_prefix=$request_prefix"
    echo 'epp logs:'
    timeout 15s kubectl --context "$context" -n "$namespace" logs deployment/chat-primary-epp -c epp --since=3m --tail=1000 || true
    echo 'flow-control metrics:'
    local metric_pod="ptr-metric-${request_prefix}"
    timeout 35s kubectl --context "$context" -n ptr-monitoring run "$metric_pod" \
      --rm -i --restart=Never --labels='app.kubernetes.io/name=prometheus' \
      --image="$image" --image-pull-policy=IfNotPresent \
      --command -- node -e '
        fetch("http://chat-primary-epp.ptr-inference.svc.cluster.local:9090/metrics", {signal: AbortSignal.timeout(5000)})
          .then(response => response.text())
          .then(body => console.log(body.split("\n").filter(line => line.startsWith("llm_d_epp_flow_control_")).join("\n")))
          .catch(error => { console.log(`METRIC_CAPTURE_ERROR ${error.name}`); process.exitCode = 1; });
      ' || true
    timeout 15s kubectl --context "$context" -n ptr-monitoring delete pod "$metric_pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  } >"$evidence" 2>&1
  chmod 600 "$evidence"
  printf 'EVIDENCE path=%s\n' "$evidence" >&2
}

cleanup() {
  timeout 15s kubectl --context "$context" -n "$namespace" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

client_js=$(cat <<'JS'
const count = Number(process.env.BURST_COUNT || 32);
const url = 'http://chat-primary-epp.ptr-inference.svc.cluster.local:8081/v1/chat/completions';
const body = JSON.stringify({model: 'synthetic-chat', messages: [{role: 'user', content: 'Synthetic load check'}], max_tokens: 64, stream: true});
const outcomes = await Promise.all(Array.from({length: count}, async (_, index) => {
  const requestId = `${process.env.REQUEST_PREFIX}-${String(index).padStart(3, '0')}`;
  const started = Date.now();
  try {
    const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json', 'x-request-id': requestId}, body, signal: AbortSignal.timeout(45000)});
    const payload = await response.text();
    const drop = response.headers.get('x-llm-d-request-dropped-reason') ||
      /rejected-(?:saturated|ttl-expired)/.exec(payload)?.[0] || 'none';
    return {requestId, status: response.status, drop, elapsedMs: Date.now() - started, headers: Object.fromEntries([...response.headers].filter(([key]) => /drop|reason|decision|saturat|ttl/.test(key)))};
  } catch (error) {
    return {requestId, status: 'transport-error', drop: error.name || 'unknown', elapsedMs: Date.now() - started, headers: {}};
  }
}));
const counts = new Map();
for (const {status, drop} of outcomes) {
  const key = `${status} ${drop}`;
  counts.set(key, (counts.get(key) || 0) + 1);
}
console.log('status drop-reason count');
for (const [key, count] of [...counts].sort()) console.log(`${key} ${count}`);
console.log(`total ${outcomes.length}`);
console.log('drop-headers ' + JSON.stringify([...new Set(outcomes.flatMap(item => Object.keys(item.headers)))]));
console.log('elapsed-ms ' + JSON.stringify({min: Math.min(...outcomes.map(item => item.elapsedMs || 0)), max: Math.max(...outcomes.map(item => item.elapsedMs || 0))}));
console.log('requests ' + JSON.stringify(outcomes.map(({requestId, status, drop}) => ({requestId, status, drop}))));
if (outcomes.some(item => item.status === 'transport-error') ||
    !outcomes.some(item => item.drop === 'rejected-saturated') ||
    !outcomes.some(item => item.drop === 'rejected-ttl-expired')) process.exitCode = 1;
JS
)

if timeout 90s kubectl --context "$context" -n "$namespace" run "$pod" \
  --rm -i --restart=Never --attach=true \
  --labels='ptr.io/inference-test-client=true' \
  --image="$image" --image-pull-policy=IfNotPresent \
  --env="BURST_COUNT=${BURST_COUNT:-32}" \
  --env="REQUEST_PREFIX=$request_prefix" \
  --command -- node --input-type=module -e "$client_js"; then
  printf 'RESULT test=V7_0 status=PASS request_prefix=%s count=%s\n' "$request_prefix" "${BURST_COUNT:-32}"
else
  capture_failure
  printf 'RESULT test=V7_0 status=FAIL request_prefix=%s count=%s\n' "$request_prefix" "${BURST_COUNT:-32}"
  exit 1
fi
