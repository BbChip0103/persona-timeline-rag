#!/usr/bin/env bash
set -euo pipefail

context=kind-ptr-k8s
namespace=ptr-inference
pod="ptr-denied-$(date +%s)-$$"
image="$(timeout 10s kubectl --context "$context" -n ptr-app get deployment ptr-api -o jsonpath='{.spec.template.spec.containers[0].image}')"
router_ip="$(timeout 10s kubectl --context "$context" -n "$namespace" get pod -l llm-d-router-standalone=chat-primary-epp -o jsonpath='{.items[0].status.podIP}')"
engine_ip="$(timeout 10s kubectl --context "$context" -n "$namespace" get pod -l app.kubernetes.io/component=inference-engine -o jsonpath='{.items[0].status.podIP}')"

cleanup() {
  timeout 15s kubectl --context "$context" -n "$namespace" delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

client_js=$(cat <<'JS'
const targets = [['envoy', process.env.ROUTER_IP, 8081], ['engine', process.env.ENGINE_IP, 8000]];
let denied = 0;
for (const [name, ip, port] of targets) {
  try {
    const response = await fetch(`http://${ip}:${port}/health`, {signal: AbortSignal.timeout(2500)});
    console.log(`${name}: unexpectedly reached HTTP ${response.status}`);
  } catch (error) {
    denied++;
    console.log(`${name}: denied (${error.name})`);
  }
}
if (denied !== targets.length) process.exitCode = 1;
JS
)

timeout 30s kubectl --context "$context" -n "$namespace" run "$pod" \
  --rm -i --restart=Never --attach=true \
  --image="$image" --image-pull-policy=IfNotPresent \
  --env="ROUTER_IP=$router_ip" --env="ENGINE_IP=$engine_ip" \
  --command -- node --input-type=module -e "$client_js"
