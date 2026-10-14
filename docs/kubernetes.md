# Kubernetes deployment

This is the owned, synthetic kind deployment and a production template. It does
not authorize real persona data, paid calls, or a production rollout. See the
[K6 acceptance record](../deploy/kind/ACCEPTANCE.md) for measured results.

## Architecture

```text
ptr-app:       web -> api -> BullMQ (ptr-data Redis) -> worker
                                                         | local
ptr-inference:                            EPP / InferencePool -> vLLM
                  worker -> OpenRouter (EPP drop reasons only; fake in kind)
ptr-data:      kind-only Postgres + Redis; production uses managed services
ptr-system:    ptr Helm release; ptr-monitoring and ptr-keda run add-ons
```

The kind engine is a simulator on fake GPU nodes; its OpenRouter endpoint is a
local fake. The router is a separate Helm release in `ptr-inference`. NetworkPolicy
limits the permitted paths.

## Install on kind

Prerequisites: Docker 29.8.1, kind v0.33.0 (kindest/node v1.37.0),
kubectl v1.37.1, Helm v4.3.0,
kubeconform v0.8.0, `jq`, `curl`, `openssl`, `sha256sum`, and sufficient local
CPU, memory and disk for four kind nodes. The exact chart versions installed by
`up.sh` are KEDA 2.21.0, metrics-server 3.14.0 and kube-prometheus-stack 92.3.1;
it verifies their archive hashes. It also installs Gateway API Inference Extension
v1.6.0 `InferencePool` CRD. The router chart vendors llm-d-router-standalone
v0.11.0. Use the repository root as the working directory. These commands touch
only `ptr-k8s` and use synthetic data.

```bash
set -o pipefail
timeout 1800s deploy/kind/up.sh | tee /tmp/ptr-kind-up.txt
timeout 60s deploy/kind/secrets.sh
backend_tag=$(sed -n 's/^backend_image=ptr-backend://p' /tmp/ptr-kind-up.txt)
worker_tag=$(sed -n 's/^worker_image=ptr-worker://p' /tmp/ptr-kind-up.txt)
control_plane_ip=$(timeout 10s docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ptr-k8s-control-plane)
test -n "$backend_tag" && test -n "$worker_tag" && test -n "$control_plane_ip"
timeout 900s helm --kube-context kind-ptr-k8s install ptr deploy/helm/ptr \
  --namespace ptr-system --values deploy/helm/ptr/values-kind.yaml \
  --set "images.backend.repository=ptr-backend" --set "images.backend.tag=$backend_tag" \
  --set "images.worker.repository=ptr-worker" --set "images.worker.tag=$worker_tag" \
  --set-string "inference.apiServerCIDRs[1]=$control_plane_ip/32" \
  --wait --timeout 12m
timeout 300s helm --kube-context kind-ptr-k8s install chat-primary deploy/helm/ptr-router \
  --namespace ptr-inference --values deploy/helm/ptr-router/values-kind.yaml \
  --wait --timeout 4m
timeout 15s kubectl --context kind-ptr-k8s get pods -A -o json | jq -e '
  [.items[] | select(.status.phase != "Succeeded")] as $pods |
  ($pods | length) > 0 and all($pods[];
    .status.phase == "Running" and
    (.status.containerStatuses | length) > 0 and
    all(.status.containerStatuses[]; .ready == true))'
api_pod=$(timeout 10s kubectl --context kind-ptr-k8s -n ptr-app get pod -l app.kubernetes.io/component=api -o jsonpath='{.items[0].metadata.name}')
test -n "$api_pod"
timeout 90s kubectl --context kind-ptr-k8s -n ptr-app exec -i "$api_pod" -- node - < deploy/kind/smoke-turn.cjs
timeout 200s deploy/kind/saturation-check.sh
timeout 90s deploy/kind/networkpolicy-check.sh
```

`secrets.sh` creates synthetic Secrets only; it prints key names, never values.
The role Secrets are `ptr-api` (`PTR_APP_DATABASE_URL`, `PTR_REDIS_URL`, tokens
and session/UI credentials), `ptr-worker` (`PTR_LLM_DATABASE_URL`,
`PTR_LLM_REDIS_URL`, control token), `ptr-maintenance` (maintenance DB/Redis
URLs and controls), `ptr-personas` (synthetic fixture), `ptr-keda-redis` (Redis
address/user/password), `ptr-data` (local DB/Redis credentials), and
`ptr-worker-openrouter` (a synthetic worker-only key in kind). Never inspect or
print their values. On success the smoke command
prints `{"state":"completed","durableAck":true,"outboxRemoved":true}`.

## Upgrade and rollback

Use the same values, image overrides and cluster API CIDR overrides as the install
command. For an ordinary chart update:

```sh
timeout 900s helm --kube-context kind-ptr-k8s upgrade ptr deploy/helm/ptr \
  --namespace ptr-system --values deploy/helm/ptr/values-kind.yaml \
  --set "images.backend.repository=ptr-backend" --set "images.backend.tag=$backend_tag" \
  --set "images.worker.repository=ptr-worker" --set "images.worker.tag=$worker_tag" \
  --set-string "inference.apiServerCIDRs[1]=$control_plane_ip/32" \
  --wait --timeout 12m
timeout 300s helm --kube-context kind-ptr-k8s history ptr -n ptr-system
timeout 900s helm --kube-context kind-ptr-k8s rollback ptr REVISION -n ptr-system --wait --timeout 12m
timeout 300s helm --kube-context kind-ptr-k8s upgrade chat-primary deploy/helm/ptr-router \
  -n ptr-inference --values deploy/helm/ptr-router/values-kind.yaml --wait --timeout 4m
timeout 300s helm --kube-context kind-ptr-k8s history chat-primary -n ptr-inference
timeout 300s helm --kube-context kind-ptr-k8s rollback chat-primary REVISION \
  -n ptr-inference --wait --timeout 4m
```

Replace `REVISION` with a verified prior revision; rollback does not restore a
database, queue or paid receipt. For wire-schema changes, roll out the API reader
before workers that write the new receipt: run the upgrade command first with
the new backend tag and current worker tag, verify readiness, then run it with
the new worker tag. Apply
`supabase/split/0005_generated_artifacts.sql` with the approved migration owner
before the API release that stores drafts. Run all required migrations before API
rollout; do not put owner credentials in runtime pods. `--wait` checks Kubernetes
resource readiness through its timeout; ordinary Jobs need `--wait-for-jobs`.
It does not prove a completed turn, durable ACK, or every external dependency.
Run the smoke again after rollout.

## Production checklist

`deploy/helm/ptr/values-prod.yaml` is a template, not an installable production
configuration. Before use:

- Replace managed Postgres and Redis hostnames, ports, TLS/CA settings, DB
  identities, and every `192.0.2.0/24`, `198.51.100.0/24` or
  `203.0.113.0/24` TEST-NET CIDR with verified service/API/egress ranges in
  `network`, `policy.managedData` and
  `inference.apiServerCIDRs`. Keep role DB grants separate.
- Provision named Secrets through External Secrets per role. `ptr-api` supplies
  `PTR_APP_DATABASE_URL`, `PTR_REDIS_URL`, `PTR_API_TOKEN`,
  `PTR_API_SYNTHETIC_TOKEN`, `PTR_LLM_CONTROL_TOKEN`, `PTR_SESSION_SECRET` and
  `PTR_UI_PASSWORD` (the web reads Redis, API token, session secret and UI
  password from this Secret).
  `ptr-worker` supplies `PTR_LLM_DATABASE_URL`, `PTR_LLM_REDIS_URL`,
  `PTR_LLM_CONTROL_TOKEN`. `ptr-worker-openrouter` supplies a dedicated
  `OPENROUTER_API_KEY` with a provider-side credit limit no greater than
  `PTR_LLM_OPENROUTER_KEY_MAX_LIMIT_USD`. `ptr-personas` supplies
  `PTR_LLM_PUBLISHED_PERSONAS_JSON`. `ptr-maintenance` supplies
  `PTR_LLM_MAINTENANCE_DATABASE_URL` and approved maintenance controls/Redis
  URL. `ptr-keda-redis` supplies `REDIS_ADDRESS`, `REDIS_USERNAME`,
  `REDIS_PASSWORD`, plus `REDIS_CA` and `REDIS_TLS_MODE=enable` for a private
  CA. No `ptr-data` Secret is needed when
  `data.enabled=false`.
- Install NVIDIA GPU Operator, create a dedicated GPU node pool with
  `ptr.io/gpu-pool=true` and `nvidia.com/gpu` taint, and provide the model
  weights PVC named by `inference.engine.weights.existingClaim`. Budget one
  spare GPU for the configured rolling update.
- Authorize OpenRouter egress through an egress proxy or hostname-aware policy
  if host pinning is required. A CIDR NetworkPolicy is not host pinning. Keep
  the fake OpenRouter disabled and require explicit paid-call authorization.
- Verify the worker-only OpenRouter key credit limit and the separate shared
  USD ledger cap before enabling paid spillover. Provider API unavailability
  disables spillover until the next key check; local serving remains available.
- Install KEDA, Prometheus Operator/Prometheus, and metrics-server; install the
  GIE v1 `InferencePool` CRD before rendering the app chart. Provide matching
  ServiceMonitor discovery and alert rules.
- Keep weekly human review on the host/systemd timers with durable private
  lock, journal and review directory. Production disables both weekly CronJobs.

## Operations

Web/API/worker and engine have startup, readiness and liveness probes.
API readiness checks Postgres and Redis. API/web use a 30 s termination grace;
worker has 100 s to finish and ACK in-flight BullMQ jobs; engine has 60 s plus
`preStop` drain. Keep PDBs and probe budgets aligned with actual model startup.
The single EPP replica has no leader election or PDB; losing it produces an
approximately 2 s routing gap during replacement, even though readiness recovers.

HPA targets 70% CPU for web and API. KEDA polls every 10 s: worker
Redis wait-list threshold 8 and active-list trigger tied to worker concurrency
(4 in kind); fallback uses 4 workers after 3 failures. Engine scaling watches
EPP queue-size threshold 4 and vLLM KV cache usage threshold 0.8, subject to GPU pool
capacity and a stabilization window. Validate these thresholds on real GPUs.

Daily split and framework retention are CronJobs. Kind runs weekly review jobs
as synthetic smoke only; production runs them on the host. `Forbid` stops
scheduled overlap only: operators must serialize manual Jobs themselves.

ServiceMonitors scrape API `/metrics/prom`, EPP `/metrics`
and vLLM `/metrics`. The worker has no metrics HTTP endpoint in this deployment.
Alert on nonterminal turn age/outbox growth, API readiness, queue wait and KEDA
fallback, EPP drops versus saturation/timeouts, engine readiness/restarts,
spillover rate, and paid budget/unknown receipts. Keep telemetry redacted.

Spillover is allowed only for EPP `rejected-saturated` or
`rejected-ttl-expired` drop reasons. A bare 503, engine 5xx, timeout or reset is
not a spillover grant. A paid result with unclear cost becomes `unknown` in the
durable ledger; never resubmit it. The provider key limit is separate from the
shared USD budget. Production worker egress uses an OpenRouter CIDR list on 443;
CIDR policy does not pin a hostname. Kind permits only its fake OpenRouter
Service for spillover.

## Known limits

The [acceptance record](../deploy/kind/ACCEPTANCE.md) is 5 PASS, 1 PARTIAL and
7 FAIL. Open risk (R9): EPP flow control occasionally fails to limit under
saturation (K3: about 2 of 11 runs; K6: 10/10 passed).
Open risk (stalled-but-healthy engine; `R4` in the acceptance record): an engine
stalled during generation while still reporting healthy was not tested; EPP was observed routing to a fast-failing pod. Add a short generation
liveness probe and repeat V8 with request-level evidence. V2: the worker drain
defect was fixed, but the deleted worker pod was not proven to own the sampled
in-flight jobs. Kind is one host with fake GPUs. Design §7's real-GPU-only
checks remain open: vLLM/EPP metrics, model load and weight caching, SIGTERM
streams, KEDA deadline fit, prefix scoring benefit, GPU Operator labels and
pool separation, EPP versus callback TTFT/throughput, and minimum replica cost.
