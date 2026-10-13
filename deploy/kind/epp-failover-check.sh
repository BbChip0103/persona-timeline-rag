#!/usr/bin/env bash
set -euo pipefail

context=kind-ptr-k8s
namespace=ptr-inference
pod="ptr-failover-$(date +%s)-$$"
image="$(timeout 10s kubectl --context "$context" -n ptr-app get deployment ptr-api -o jsonpath='{.spec.template.spec.containers[0].image}')"
log_file="$(mktemp)"

cleanup() {
  timeout 15s kubectl --context "$context" -n "$namespace" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  rm -f "$log_file"
}
trap cleanup EXIT

client_js=$(cat <<'JS'
const url = 'http://chat-primary-epp.ptr-inference.svc.cluster.local:8081/v1/models';
const end = Date.now() + 45000;
while (Date.now() < end) {
  const at = Date.now();
  let status;
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(1500)});
    await response.arrayBuffer();
    status = response.status;
  } catch (error) {
    status = `transport:${error.name || 'unknown'}`;
  }
  console.log(JSON.stringify({at, status}));
  await new Promise(resolve => setTimeout(resolve, 100));
}
JS
)

timeout 10s kubectl --context "$context" -n "$namespace" run "$pod" \
  --restart=Never --labels='ptr.io/inference-test-client=true' \
  --image="$image" --image-pull-policy=IfNotPresent \
  --command -- node --input-type=module -e "$client_js" >/dev/null
timeout 30s kubectl --context "$context" -n "$namespace" wait --for=condition=Ready "pod/$pod" --timeout=25s >/dev/null
timeout 3s sleep 2
router_pod="$(
  timeout 10s kubectl --context "$context" -n "$namespace" get pods \
    -l llm-d-router-standalone=chat-primary-epp -o json |
    timeout 10s jq -er '[.items[] | select(any(.status.containerStatuses[]?; .name == "epp" and .ready == true)) | .metadata.name] | if length == 1 then .[0] else error("expected one active EPP") end'
)"
deleted_at="$(date +%s%3N)"
timeout 10s kubectl --context "$context" -n "$namespace" delete pod "$router_pod" --wait=false >/dev/null
timeout 65s kubectl --context "$context" -n "$namespace" wait --for=jsonpath='{.status.phase}'=Succeeded "pod/$pod" --timeout=60s >/dev/null
timeout 10s kubectl --context "$context" -n "$namespace" logs "$pod" > "$log_file"
timeout 10s node - "$log_file" "$deleted_at" <<'JS'
const fs = require('node:fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map(line => JSON.parse(line));
const event = Number(process.argv[3]);
const before = rows.filter(row => row.at < event);
const after = rows.filter(row => row.at >= event);
const failed = after.filter(row => row.status !== 200);
const firstRecovery = failed.length ? after.find(row => row.at > failed[0].at && row.status === 200) : undefined;
const counts = new Map();
for (const row of after) counts.set(String(row.status), (counts.get(String(row.status)) || 0) + 1);
console.log(`deleted-router ${event}`);
console.log(`before ${before.length} successes=${before.filter(row => row.status === 200).length}`);
console.log(`after ${after.length} ${JSON.stringify(Object.fromEntries(counts))}`);
console.log(`first-recovery-after-delete-ms ${firstRecovery ? firstRecovery.at - event : 'not-observed'}`);
console.log(`first-failure-gap-ms ${firstRecovery ? firstRecovery.at - failed[0].at : 'not-observed'}`);
console.log(`first-failure-after-delete-ms ${failed.length ? failed[0].at - event : 'none'}`);
JS
