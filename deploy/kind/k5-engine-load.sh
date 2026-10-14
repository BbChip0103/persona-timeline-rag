#!/usr/bin/env bash
set -euo pipefail

context="${KUBE_CONTEXT:-kind-ptr-k8s}"
if [[ "$context" != kind-ptr-k8s ]]; then
  echo 'Refusing to run outside kind-ptr-k8s' >&2
  exit 1
fi

pod="ptr-k5-engine-load-$(date +%s)-$$"
image="$(timeout 15s kubectl --context "$context" -n ptr-app get deployment ptr-api -o jsonpath='{.spec.template.spec.containers[0].image}')"
cleanup() {
  timeout 15s kubectl --context "$context" -n ptr-inference delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

client_js=$(cat <<'JS'
const end = Date.now() + Number(process.env.LOAD_SECONDS || '90') * 1000;
const parallel = Number(process.env.LOAD_CONCURRENCY || '24');
const url = 'http://chat-primary-epp.ptr-inference.svc.cluster.local:8081/v1/chat/completions';
const body = JSON.stringify({model: 'synthetic-chat', messages: [{role: 'user', content: 'Synthetic K5 EPP queue test'}], max_tokens: 64});
const counts = {};
await Promise.all(Array.from({length: parallel}, async () => {
  while (Date.now() < end) {
    let key;
    try {
      const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body, signal: AbortSignal.timeout(15000)});
      await response.arrayBuffer();
      key = String(response.status);
    } catch (error) {
      key = error.name || 'transport-error';
    }
    counts[key] = (counts[key] || 0) + 1;
  }
}));
console.log(JSON.stringify({event: 'engine_load', seconds: Number(process.env.LOAD_SECONDS || '90'), parallel, counts}));
JS
)

timeout 150s kubectl --context "$context" -n ptr-inference run "$pod" \
  --rm -i --restart=Never --attach=true \
  --labels='ptr.io/inference-test-client=true' \
  --image="$image" --image-pull-policy=IfNotPresent \
  --env="LOAD_SECONDS=${LOAD_SECONDS:-90}" --env="LOAD_CONCURRENCY=${LOAD_CONCURRENCY:-24}" \
  --command -- node --input-type=module -e "$client_js"
