# Observability

For the current Kubernetes split path, see [kubernetes.md](kubernetes.md). The
active deployment has no LLM gateway metrics endpoint. ServiceMonitors scrape:

| Source | Endpoint | What it proves |
| --- | --- | --- |
| API | `/metrics/prom` | HTTP health, turn creation, SSE streams, owner rejection and `reply.serving` model-call labels from completed turns |
| EPP | `/metrics` | InferencePool routing decisions, drop reasons and queue pressure before local engine admission |
| vLLM engine | `/metrics` | Engine readiness, restarts, running/waiting work and cache pressure |
| Provider ledger | Postgres ledger/receipt state | paid call admission, known cost, unknown receipts and no-resubmission state |
| Langfuse | self-hosted Langfuse v4 traces and scores | redacted application observations, evaluation runs and human-review annotations when explicitly enabled |

Watch durable ACK/outbox age, queue delay, KEDA fallback, EPP drop reasons and
flow-control failures, engine readiness/restarts, spillover rate, and paid
budget or unknown receipts. `PROVIDER_REQUEST_UNRESOLVED` means submission or
cost is uncertain: retain the receipt and do not resubmit.

## Why no LLM gateway

The active serving path has no LLM gateway. The durable provider ledger
and, by default, the provider key credit limit enforce paid budget, the EPP owns local routing and
admission, and the paid OpenRouter key is present only in the Kubernetes worker.
Rollback restores the old gateway from the private operational snapshot, not
from files kept in this repository.

## API `/metrics/prom`

Prometheus text format 0.0.4 (`text/plain; version=0.0.4; charset=utf-8`) is
written by `packages/ops/src/metrics.ts`. The endpoint reports aggregates only
and carries no user text, model text, turn id or owner value.

| Metric | Labels | Meaning |
| --- | --- | --- |
| `ptr_build_info` | `role`, `version` | process build metadata |
| `process_start_time_seconds` | none | process start time |
| `ptr_http_requests_total` | `route`, `status_class` | API request counts by fixed route group and status class |
| `ptr_turns_created_total` | none | accepted turn submissions |
| `ptr_sse_streams_open` | none | currently open SSE streams |
| `ptr_owner_rejected_total` | `reason` | rejected owner headers, with `missing`, `format` or `space` |
| `ptr_model_calls_total` | `upstream_kind` | completed-turn model calls from internal `reply.serving` |

`upstream_kind` is an allowlisted label. Current direct providers use `local`,
`local-pool`, `openrouter`, `openrouter-primary`, `direct`, `fake` and
`unknown`; older stored records may still contain `primary`, `secondary` or
`litellm`. Those labels remain wire-compatible for existing records and metrics
history, but no current provider should emit new LiteLLM calls.

The Python worker does not expose `/metrics/prom` in the split deployment. Use
its readiness endpoint, API completion metrics, durable ACK/outbox state, ledger
rows and Langfuse observations for worker evidence.

## Logs

`packages/ops/src/log.ts` writes one JSON object per line on stderr. String
fields that do not look like an id or code are redacted to `INVALID`, keeping
user/model text out of logs even when a call site passes the wrong value.

Current operational logs to watch:

- API startup, readiness failures, turn creation and owner rejection.
- Worker turn completion/failure, provider errors, spillover checks and receipt
  ambiguity.
- EPP drop reasons and engine readiness or restart events from Kubernetes
  events/metrics.
- Langfuse trace and score persistence when tracing or evaluation is explicitly
  enabled.

Startup lines on stdout may remain plain text.

## `reply.serving`

A completed turn's internal reply records
`serving: {calls, upstreams[], secondaryCalls}`. `upstreams` holds one provider
label per model call in call order, so `calls` equals `upstreams.length`. The
field is absent when a reply needed no model call. The public turn DTO is an
allowlist and never includes it.

Direct providers report their own labels: local vLLM reports `local` or
`local-pool`, direct OpenRouter reports `openrouter` or `openrouter-primary`,
the in-process fake model reports `fake`, and an unrecognized label is recorded
as `unknown`. Stored historical values remain readable for review sampling.

`scripts/review-sample.ts` keeps a turn only if every call was answered by a
known real upstream. A call answered by `fake` or `unknown`, or a malformed
`serving` record, leaves the turn out.

## `/api/health` and readiness

API readiness checks Postgres and Redis. If either check fails, the answer is
503 with a redacted `checks` object. Kubernetes readiness and liveness probes
are the source of truth for pod availability. Compose operational checks use
`ops:status`, the API metrics endpoint and the Python worker health endpoint.

## Engine Scraping

The live EPP v0.11.0 `/metrics` HELP text identifies
`llm_d_epp_flow_control_global_capacity_utilization_requests` as the fraction
of configured global request capacity in use, and
`llm_d_epp_flow_control_pool_saturation` as the dispatch gating signal by
pipeline stage (`effective` is the maximum of prefill and decode, with 1.0 as
the gate). They are diagnostic gauges, not engine demand triggers.

The Helm chart does not install a Prometheus Operator, so it does not render a
`PrometheusRule`. Configure the equivalent alert in the cluster's alerting
system:

```promql
absent(up{job="ptr-engine-metrics", namespace="ptr-inference"} == 1)
```

Name it `EngineScrapeMissing` and page after two minutes. Without engine scrape
data, worker scaling treats ready engines as zero and stays at the worker
minimum. The engine KV trigger treats a missing series as an error; after the
failure threshold, fallback holds the current engine count until scraping
recovers.

## Sources

- Prometheus text exposition format: https://prometheus.io/docs/instrumenting/exposition_formats/
- Prometheus metric and label naming: https://prometheus.io/docs/practices/naming/
