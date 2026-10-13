#!/usr/bin/env bash
set -euo pipefail

context=kind-ptr-k8s
namespace=ptr-inference
pod="ptr-saturation-$(date +%s)-$$"
image="$(timeout 10s kubectl --context "$context" -n ptr-app get deployment ptr-api -o jsonpath='{.spec.template.spec.containers[0].image}')"

cleanup() {
  timeout 15s kubectl --context "$context" -n "$namespace" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

client_js=$(cat <<'JS'
const count = Number(process.env.BURST_COUNT || 32);
const url = 'http://chat-primary-epp.ptr-inference.svc.cluster.local:8081/v1/chat/completions';
const body = JSON.stringify({model: 'synthetic-chat', messages: [{role: 'user', content: 'Synthetic load check'}], max_tokens: 64, stream: true});
const outcomes = await Promise.all(Array.from({length: count}, async () => {
  const started = Date.now();
  try {
    const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body, signal: AbortSignal.timeout(45000)});
    const payload = await response.text();
    const drop = response.headers.get('x-llm-d-request-dropped-reason') ||
      /rejected-(?:saturated|ttl-expired)/.exec(payload)?.[0] || 'none';
    return {status: response.status, drop, elapsedMs: Date.now() - started, headers: Object.fromEntries([...response.headers].filter(([key]) => /drop|reason|decision|saturat|ttl/.test(key)))};
  } catch (error) {
    return {status: 'transport-error', drop: error.name || 'unknown', elapsedMs: Date.now() - started, headers: {}};
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
if (outcomes.some(item => item.status === 'transport-error') ||
    !outcomes.some(item => item.drop === 'rejected-saturated') ||
    !outcomes.some(item => item.drop === 'rejected-ttl-expired')) process.exitCode = 1;
JS
)

timeout 90s kubectl --context "$context" -n "$namespace" run "$pod" \
  --rm -i --restart=Never --attach=true \
  --labels='ptr.io/inference-test-client=true' \
  --image="$image" --image-pull-policy=IfNotPresent \
  --env="BURST_COUNT=${BURST_COUNT:-32}" \
  --command -- node --input-type=module -e "$client_js"
