# LiteLLM engine routing

The digest-pinned LiteLLM **1.104.2 Proxy**, not a replacement gateway, loads
`ptr_routing.router` through its normal custom-callback configuration. Authentication,
virtual-key model access, native healthy/cooldown/team/tag/token filters, usage and
spend accounting remain LiteLLM responsibilities. Only the nonbillable `primary`
OpenAI-compatible engine pool uses the custom deployment selector. Explicit paid
aliases retain native selection; primary overload never switches to them.

## Restored policies

- `PTR_ROUTING_POLICY=least_inflight|scored` (default `least_inflight`). Scored uses
  outstanding prefill work, estimated uncached prompt tokens, calibrated engine
  prefill throughput (or `weight * 10000`) and sequence occupancy. It is selectable;
  historical experiments did **not** establish that it is always faster.
- `PTR_ROUTING_AFFINITY=on|off` (default `on`). A per-engine, salted message-chain
  table estimates prefix reuse. It chooses the longest additional cached prefix
  only when the gain reaches `PTR_ROUTING_AFFINITY_MIN_TOKENS` (256) and its cost
  exceeds the cheapest admissible engine by no more than
  `PTR_ROUTING_AFFINITY_SLACK` (0.5). Capacity constraints always come first.
- vLLM metrics are polled in the background every
  `PTR_ROUTING_METRICS_INTERVAL_S` (1 second). Fresh KV usage >= 0.95 or waiting
  requests > 2 exclude an engine; these delayed gauges are **filters, not score
  inputs**. Stale/invalid/absent metrics fail open to gateway-owned credit.
  If capacity spillover is disabled, a blocked idle engine may admit only one request.
  When enabled, a blocked idle engine is not selected; the budget-authorized paid route is preferred. Fresh running requests at the configured sequence capacity also block local admission.

Metrics use the configured engine's same origin `/metrics`, never a client-provided
URL. Redirects, malformed origins and responses over 1 MiB are rejected. Polling
timeout is `PTR_ROUTING_METRICS_TIMEOUT_S` (0.5 seconds, maximum 2). A failed poll
retains the last good sample until it exceeds three polling intervals. Readiness
and routing do not issue model probes.

## Credit and cache correctness

Redis owns atomic selection/reservation/release across Proxy processes. Replicas
must share the dedicated proxy Redis, `LITELLM_SALT_KEY` and identical engine IDs,
identities/capacities. The namespace is pool-specific. Redis failure refuses a call;
it never enables unaccounted random routing. No-fit waits at most
`PTR_ROUTING_QUEUE_TIMEOUT_S` (10 seconds) and then returns a retry-free 503.

Per-deployment `model_info.ptr_routing` supports:

```yaml
ptr_routing:
  max_seqs: 32           # use the actual configured engine sequence capacity
  # kv_capacity: 120000 # optional calibrated token capacity, not GPU bytes
  # prefill_rate: 8000  # optional measured prefill tokens/second
  epoch: "1"            # change on engine replacement/address/model changes
```

Unknown KV capacity or prefill rate disables its corresponding calibrated gate;
do not invent calibration from GPU memory or unrelated latency. An idle engine
can admit one oversized request to avoid permanent starvation. Prefix hits reduce
estimated prefill, **not historical-message KV reservations**. Prefix tables contain
HMAC hashes only, expire after 120 seconds and are bounded to 4096 entries and
known engine token capacity. The dominant shared system prefix is learned with
half-life 256 arrivals, retaining at most 16 variants.

Completed responses and successfully generated streaming chunks learn prefixes.
The first nonempty generated chunk releases prefill credit once, while sequence/KV
credit remains reserved until stream completion. A subsequently failed stream
clears its learned cache evidence. Nonstreaming calls
conservatively retain prefill credit until their response is complete. Failure,
confirmed restart, ambiguous restart baseline or deployment identity change
invalidate cached evidence. The table is a routing estimate, not a direct inspection
of vLLM's cache contents or its global hit counter.

Server-owned reservation tokens are released idempotently. Expiring leases recover
disconnect/crash/callback failures on the next ledger operation; expiry is not an
exactly-once billing mechanism. A server-issued deadline bounds the complete
request, including credit waiting and continuously emitting streams, to 25 seconds; the lease is
35 seconds. A per-read HTTP timeout alone is not this wall-time guarantee.
Retried submissions and post-submission/provider fallbacks remain disabled. Optional capacity spillover is a first-attempt destination choice, not a retry. Client credentials/base URL, mirroring, provider fallback and routing
overrides are rejected for the controlled pool. Client-supplied reservation/request
IDs, deadlines and prefill markers are removed before routing. The server mints the request ID/deadline before the
Proxy and Router split their metadata, so both lifecycles use the same credit.

## Integration boundary

The callback checks method ownership before every request because LiteLLM settings
updates can reset the selector even on the same Router. It reattaches without
capturing a previous wrapper recursively and reads current native candidates.
A concurrently captured, unattached old Router fails closed rather than selecting
outside the ledger.
Auto/tier/adaptive routing, routing groups and routing plugin pipelines are not
combined with this initial adapter; unsupported combinations fail explicitly.
Do not add them without their own integration tests. Sync primary selection and
non-chat request surfaces are refused rather than bypassing custom credit.

This restores cache affinity, scored selection and engine-state overload filtering;
it does not recreate the historical fleet registry, DRR scheduler or autoscaler.
The single-engine configuration still benefits from admission/overload accounting,
but only multiple engines can benefit from a different destination choice.

## Verification

```sh
python3 infra/litellm/test-routing-telemetry.py
# Requires a NEW, explicitly isolated loopback Redis, not app/research Redis:
PTR_ROUTING_TEST_REDIS_URL=redis://127.0.0.1:<isolated-port>/0 \
  apps/llm-service/.venv/bin/python infra/litellm/test-routing-state.py
apps/llm-service/.venv/bin/python infra/litellm/test-routing-callback.py
apps/llm-service/.venv/bin/python infra/litellm/routing-smoke.py
```

The smoke creates its own private environment, two synthetic engines and two real
pinned Proxy replicas sharing fresh Redis/Postgres, and removes only that project's
containers/volumes. No GPU, external model/provider, private corpus or shared service
is involved. Functional routing proof is not a real-GPU throughput improvement claim.
The `gateway-routing` CI workflow repeats the regressions and real-Proxy smoke
without secrets on changes to this integration. Updating the deployed service
requires draining active primary calls and recreating it with the updated Compose
mounts and configuration. Do not mix salts, engine identities or capacities across
replicas during a rollout. Changing a YAML file alone does not install the Python extension into an existing container.

References: [custom Router selection](https://docs.litellm.ai/docs/routing),
[Proxy callback loading](https://docs.litellm.ai/docs/proxy/logging),
[per-attempt callback lifecycle](https://docs.litellm.ai/docs/observability/custom_callback).

## Optional capacity spillover (local-first, no retries)

Set gateway `PTR_ROUTING_CAPACITY_SPILLOVER=1` and the same private >=32-byte
`PTR_LLM_CAPACITY_SPILLOVER_KEY` on the gateway and worker. Configure the dedicated
`openrouter-primary` deployment (ID also `openrouter-primary`); local deployment
IDs remain `primary`/`secondary`. Worker must use `PTR_LLM_LITELLM_BILLABLE=1`,
explicit live/external-data consent and verified price ceilings. Invalid worker
configuration fails before DB/provider startup; enabled gateway requires its
signature key and paid deployment. Existing defaults remain local-only.

The native local candidate filters and atomic Redis cache/scored selector remain
first. If none fits shared sequence/KV/prefill credit, or all are overloaded by
fresh KV>=0.95, waiting>2, or running>=configured sequence limit, select the paid
alias immediately **before any local upstream request**. No speculative pair,
local-started-error fallback, timeout/unknown reroute or SDK/provider retry occurs.
Native access/filter errors and Redis errors fail closed. Stale/invalid metrics
still defer to gateway-owned credit, not guessed overload. Thresholds are capacity
heuristics, not TTFT/latency guarantees. Existing input/evidence schema is retained.

Every spillover-capable primary call reserves worst-case paid cost in the existing
cumulative global ledger before submission, including calls ultimately served
locally. The HTTPX hook signs the actual generation fields in the SDK request,
provider fingerprint nonce, expiry and reserved amount. Gateway verifies the
request and supported chat endpoint, removes the grant header, and atomically
consumes its nonce in shared Redis (35s TTL covers <=30s validity). Client metadata
cannot authorize a paid call; direct paid alias calls are rejected. This small
shared helper is cost authority, not a second DB or dispatcher. Gateway receives
no application/worker DB credentials. Existing no-schema/no-spillover fingerprints
remain unchanged. The private key is not retained in traces or Redis.

Trusted `x-litellm-model-id` identifies the actual **configured deployment**, not
JSON response model/alias. Verified local IDs settle at zero; paid invoices use
usage.cost or the OpenRouter cost header preserved by LiteLLM. Missing/invalid
cost stays conservatively reserved/unknown, with no resubmission. Gateway's
resetting daily spend limit is only a secondary guard; the worker ledger's
cumulative US$1 cap and prior unknown charges remain authoritative.

The deployed paid model retains the existing approved Gemma model, pins DeepInfra,
requires supported parameters, disables provider fallbacks and bounds price at
US$0.1/0.5 per million input/output tokens. Prices and availability must be checked
before changing this configuration. See [OpenRouter provider preferences](https://openrouter.ai/docs/guides/routing/provider-selection)
and [model endpoints/prices](https://openrouter.ai/api/v1/models/google/gemma-4-26b-a4b-it/endpoints).

`infra/litellm/capacity-smoke.py` uses two real pinned Proxies and isolated fake
local/paid engines, with Internet masquerading disabled. It proves local-first,
fresh overload→simulated OpenRouter with no local submission, one-use budget
admission, tamper/direct-alias refusal, no retry on paid failure and no grant
header forwarded. It does not prove real OpenRouter availability or answer quality.
