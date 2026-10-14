# Observability: `/metrics/prom`, JSON logs, `reply.serving` and `ops:status`

For the current Kubernetes split path, see [kubernetes.md](kubernetes.md).
Its ServiceMonitors scrape API `/metrics/prom`, LiteLLM `/metrics`, EPP
`/metrics` and vLLM `/metrics`; the split worker has no metrics listener.
Watch durable ACK/outbox age, queue delay, KEDA fallback, EPP drop reasons and
flow-control failures, engine readiness/restarts, spillover rate and unknown
paid receipts. `PROVIDER_REQUEST_UNRESOLVED` means submission or cost is
uncertain: retain the receipt and do not resubmit. The Compose metrics below
describe the historical single-host stack.

> Historical pre-framework procedure. For current serving, use [framework runtime](framework-runtime.md). Old gateway/dispatcher/local review-sheet commands below are not the default migration path.


 and decisions D18–D21. A single user runs this service on one host, so there is no Prometheus server,
Grafana or alert rules file. Each role serves Prometheus text and writes JSON log lines, and `pnpm ops:status` reads
the four endpoints and prints one health table.

## `/metrics/prom`

Prometheus text format 0.0.4 (`text/plain; version=0.0.4; charset=utf-8`), written by hand without a client library
(`packages/ops/src/metrics.ts`). Every role binds to 127.0.0.1 only. The endpoint needs no token, like `/api/health`
and `/healthz`, because it reports aggregates only. Label values are fixed enums or operator-chosen upstream ids
(registry or upstreams-file ids, never URLs). No label or value carries user text, model text, a turn id or an owner.

| Role | Where | Metrics (all roles also report `ptr_build_info{role,version}` and `process_start_time_seconds`) |
| --- | --- | --- |
| api | `http://127.0.0.1:56441/metrics/prom` (API port) | `ptr_http_requests_total{route,status_class}`, `ptr_turns_created_total`, `ptr_sse_streams_open`, `ptr_owner_rejected_total{reason}` |
| worker | `http://127.0.0.1:56442/metrics/prom` | `ptr_turns_finished_total{outcome,code}`, `ptr_turn_duration_seconds` (histogram), `ptr_turn_queue_wait_seconds` (histogram), `ptr_turns_inflight`, `ptr_safety_fallback_total{scope,reason}`, `ptr_reply_guard_total{action,reason}`, `ptr_model_calls_total{upstream_kind}` |
| dispatcher | `http://127.0.0.1:56443/metrics/prom` | `ptr_dispatch_requeued_total`, `ptr_dispatch_failed_total{code}`, `ptr_outbox_republished_total`, `ptr_queue_waiting`, `ptr_oldest_pending_age_seconds` |
| gateway | `http://127.0.0.1:56460/metrics/prom` (gateway port) | `ptr_gateway_requests_total{result}`, `ptr_gateway_rejected_total{reason}`, `ptr_gateway_served_total{upstream}`, `ptr_gateway_breaker_open{upstream}`, `ptr_gateway_breaker_opened_total{upstream}`, `ptr_gateway_failover_total{reason}`, `ptr_gateway_deadline_aborts_total`, `ptr_gateway_retry_deadline_total`, `ptr_gateway_inflight`, `ptr_gateway_queue_waiting`, `ptr_gateway_ttft_seconds` (histogram), `ptr_gateway_upstream_timeouts_total{upstream}` |

Label values:

- `route`: one of `health`, `personas`, `sessions`, `session`, `send_turn`, `draft`, `turn`, `turn_events`, `cancel_turn`,
  `metrics` or `other`. `status_class` is `2xx` to `5xx`.
- `ptr_owner_rejected_total{reason}`: `missing` (no `X-PTR-Owner`), `format` (no valid owner) or `space` (a valid owner
  of the other token's owner space, D10).
- `ptr_turns_finished_total{outcome,code}`: `outcome` is `completed` (with code `none`), `failed` (with the turn
  failure code, for example `TURN_TIMEOUT` or `CONTEXT_LIMIT`) or `abandoned` (no chat hook fired: the worker lost its
  lease and the dispatcher recovers the turn, or the turn was cancelled before its final write).
- `ptr_dispatch_failed_total{code}`: `WORKER_LOST` or `QUEUE_TIMEOUT`.
- `ptr_model_calls_total{upstream_kind}`: model calls of completed turns, taken from `reply.serving`. The kinds are
  `primary`, `secondary`, `fake`, `openrouter`, `direct` and `unknown`.
- Gateway `upstream`: on `ptr_gateway_served_total` this is the `X-PTR-Upstream` value (`primary`, `secondary` or
  `fake`). It counts when the 200 headers go out, so a stream that breaks afterwards is still counted as served.
  A gateway whose only upstream is OpenRouter (`PTR_GATEWAY_UPSTREAM=openrouter`, demo layer) reports `primary`. On the breaker and timeout series it is the pool member id. A single engine or the env-only failover reports
  one `primary`.
- Gateway O2 counters :
  - `ptr_gateway_rejected_total{reason="deadline"}`: refused before any send.
  - `ptr_gateway_deadline_aborts_total`: sent calls cut at `X-PTR-Deadline`.
  - `ptr_gateway_retry_deadline_total`: a second primary attempt or the secondary was not sent after a primary attempt,
    because the deadline left too little time. D17 does not mark these refusals. It counts per skipped target, so one
    request can add 2 (the other primary and then the secondary).
- `ptr_gateway_ttft_seconds`: a histogram of successful calls through a pool or the env-only failover, from arrival
  (queue wait included) to the first chunk. It has no samples for a single engine or the fake model.

The JSON `/metrics` on the gateway (Bearer token) is unchanged and keeps every detail.

### Worker and dispatcher listeners

The worker and the dispatcher have no HTTP server of their own, so each one opens a small listener. The ports are 56442
and 56443 by default. `PTR_METRICS_PORT` (demo layer, `PTR_DEMO_SCALING=1`) sets the port, and `0` turns the listener
off. The listener also answers `GET /healthz` with 200, as a liveness probe for Compose. If the bind fails, for example
with `EADDRINUSE`, the role logs `metrics_listener_failed` with the error code and keeps processing turns. A second
worker on the same host with the default port therefore runs without metrics, and `ops:status` sees only the first
one; give each extra worker its own `PTR_METRICS_PORT`. An invalid `PTR_METRICS_PORT` value fails startup like any
other configuration error. Observability never blocks a turn. `scripts/loadtest.ts` gives every worker and dispatcher its
own port (base port +100… and +200…; base 56451 by default). It never reuses a port within a run. `--metrics=0` turns
the listeners off. The report records which `/metrics/prom` endpoints answered at the start and at the end of the run.

## JSON log lines

`packages/ops/src/log.ts` writes one JSON object per line on stderr: `{ts, role, event, …fields}`. The correlation id is
`turnId`. A string field that does not look like an id or a code is written as `INVALID`. This rule keeps user or model
text out of the log even if a call site makes a mistake.

| Role | Events |
| --- | --- |
| api | `turn_created {turnId}`, `input_safety_fallback {scope, reason, count}` (drafts) |
| worker | `turn_finished {turnId, outcome, code, durationMs, queueWaitMs}`, `input_safety_fallback {scope, reason}`, `worker_error {phase}`, `metrics_listener_failed {port, code}` |
| dispatcher | `turn_requeued {turnId}`, `turn_failed {turnId, code}`, `turn_republished {turnId}`, `dispatcher_error {phase}`, `metrics_listener_failed` |
| gateway | `gateway_route {turnId, pool, band, est, h, cost, pick, reason, affinity?, waitMs}` (sampled, `PTR_GATEWAY_ROUTE_LOG_SAMPLE`), `gateway_upstream_error {turnId, code, …}`, `gateway_draining`, `gateway_drained`, `gateway_stopped` |

**Change in the gateway route log (D20).** The route log used to record the request key as `rk`, a per-process salted
sha256 prefix, so the line could not be joined to a turn. It now records the raw `turnId`, the value of
`X-PTR-Request-Key` that the worker sends. The two lines therefore join on the same value. Every process binds to
loopback on a single-user host, where a turn id is not a secret, so correlation is worth more here than hiding the id.
The line still carries no text, URL or owner.

Startup lines on stdout (`… listening on …`) stay plain text.

## `reply.serving` (D21)

Every gateway answer carries `X-PTR-Upstream`:

- `primary` for an engine (a pool member or a single engine);
- `secondary` for the OpenRouter failover;
- `fake` for the synthetic fake model (`synthetic/…`).

The worker's client passes the value to the turn through the per-call `onServed` callback. Providers outside the
gateway report themselves: the in-process fake model reports `fake`, a direct OpenRouter client `openrouter`, and an
engine reached directly with no header `direct`. A value outside the known set is recorded as `unknown`.

A completed turn's internal reply records `serving: {calls, upstreams[], secondaryCalls}`. `upstreams` holds one name
per model call in call order, so `calls` equals `upstreams.length`. The field is absent when the reply needed no model
call, for example a fixed refusal. The public turn DTO is an allowlist (`apps/api/src/public-turn.ts`) and never
includes it.

`scripts/review-sample.ts` keeps a turn only if every call was answered by a known real upstream (`primary`,
`secondary`, `openrouter` or `direct`). A call answered by `fake` or `unknown`, or a `serving` record without this
shape, leaves the turn out (fail-closed). A fake failover secondary in a load test is reported as `fake`, not
`secondary`. In a fake-failover load test, failovers therefore show as `ptr_gateway_served_total{upstream="fake"}`, and
the `ops:status` secondary-ratio ALERT does not fire. Turns stored before O4 have no record and stay eligible
([review-sampling.md](review-sampling.md)).

## `/api/health` (D23)

The API runtime checks the database with `SELECT 1` and Redis with `PING`, each within 1 s. If either check fails, the
answer is 503 with `{ok:false, …, checks:{database, redis}}`, where each check is `ok` or `down`. Redis gets its own
connection, which opens on the first check.

## `pnpm ops:status [--window 30]` (D19)

This script reads the four endpoints, waits `--window` seconds (1–600, default 30) and reads them again. It then prints
one table:

- each role `up` or `down`. A role that is down makes the checks that depend on it `n/a`, never ALERT.
- each `breaker <upstream>`. An open breaker is always `INFO engine unreachable` and never an ALERT, because the GPU pod
  is often off and an open breaker can then be the normal state.
- **ALERT** in exactly these cases:
  - secondary share of gateway answers above 20%;
  - any queue timeout (dispatcher `QUEUE_TIMEOUT` or gateway `queue_timeout`);
  - `TURN_TIMEOUT` share of finished turns above 5%;
  - any input-safety fallback.

Counters are compared within the window, and a counter that went back after a restart counts from zero. A role that
missed the first read has no baseline, so its checks are `n/a (no baseline)` rather than its lifetime totals. Breakers
come from the second read alone. `ops:status` reads the default ports only, so it sees one worker. The exit code
is 0 with no ALERT, 1 with an ALERT and 2 for bad arguments. The upstreams file format (`sources.ts` FILE_KEYS) has no
`required` field.

## Sources

-  (operations round 2) §6, §9 O4 and decisions D18–D21, D23, `private design notes` repo
  `<private-design-notes>`.
- Prometheus text exposition format: https://prometheus.io/docs/instrumenting/exposition_formats/
- Prometheus metric and label naming: https://prometheus.io/docs/practices/naming/
