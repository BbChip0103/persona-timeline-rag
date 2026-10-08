# Goal2 serving: queued execution, SSE, LLM gateway, load harness and engine benchmarks

Current contract and reproduction steps for the Goal2 (LLMOps) work, including the large-scale rework. Measured
results and the decision history live in the issue repository; this file only says how the system behaves and how
to rerun it.

## Topology

```
client ─POST /api/sessions/:id/turns──→ API ×N ── one transaction: turns(pending) + turn_outbox ──→ Postgres
       ─GET  /api/turns/:id/events (SSE)─→  │ after commit: BullMQ add (job id t-<turn>-<seq>)        ▲
                                            ▼                                                       │ claim / lease / fenced writes
                                 Redis: BullMQ queue + pub/sub ──deliver──→ worker ×M ──────────────┘
                                            ▲   state notices ◀── publish ──┘   │
       dispatcher ×D: requeue expired leases / WORKER_LOST, re-publish unclaimed outbox entries
                                                                                ▼
                       LLM gateway (fake | self-hosted vLLM: one engine or a pool from a file / the Redis registry
                                    [+ optional OpenRouter failover] | OpenRouter)
```

Every turn runs queued; there is no inline mode (`PTR_EXECUTION` is rejected at startup). Processes:
`pnpm dev:api`, `pnpm dev:worker` (any number), `pnpm dev:dispatcher` (one or more), `pnpm dev:gateway`.
All need `PTR_REDIS_URL` (`infra/compose.redis.yml`) and migrations through `0008_turn_leases.sql`.

## Delivery, leases and recovery

- Reservation writes the turn and its `turn_outbox` entry in one transaction, then publishes to BullMQ. A failed
  publish is not an error: the entry stays until a worker claims the turn, and the dispatcher re-publishes entries
  older than `PTR_DISPATCH_GRACE_MS` (2000) at most once per grace period. Re-publishing a dispatch BullMQ still
  holds is a no-op (job id per turn + `dispatch_seq`; finished jobs are kept 1 h for this). Redis is not a source
  of truth: a job lost with Redis is re-published from the outbox.
- BullMQ retries are off. A worker claims the dispatched turn by id under a Postgres lease (`PTR_LEASE_MS`, 15000,
  renewed every lease/3). The claim succeeds only for a pending turn with no live lease, so duplicate or stale
  deliveries are skipped. The claim retires the outbox entry.
- Fencing: every state write from a worker requires `lease_owner = worker AND attempts = claimed attempt`, so a
  stale worker never overwrites a turn another worker reclaimed.
- Lease storage (`0008_turn_leases.sql`): the fencing token (`turns.lease_owner`, `turns.attempts`) changes only on
  claim and recovery; the expiry lives in the small `turn_leases(turn_id, owner, attempt, expires_at)` table, so
  heartbeats never write `turns`. A lease row counts only while (owner, attempt) equals the token. The claim updates
  the token and upserts the lease row in one statement (a concurrent loser re-checks the committed token, which
  matches no lease row it can see); a renewal never revives an expired lease (a claim may already have taken it);
  recovery locks expired lease rows and their turns with `SKIP LOCKED`, clears the token and deletes the row;
  completion, failure and cancellation delete the row too. `turn_leases` holds only in-flight turns: no secondary
  index (recovery scans it), fillfactor 70 so heartbeats are HOT updates, fixed-threshold autovacuum.
- Lease reconciliation: every `PTR_LEASE_RECONCILE_INTERVAL_MS` (60000) the dispatcher requeues (or fails with
  `WORKER_LOST`) active turns older than `PTR_LEASE_MS` whose token has no matching lease row, and drops lease rows
  that match no active token. The normal paths never produce either; this covers mixed-version deploys and manual
  fixes. It uses `SKIP LOCKED` and is safe with several dispatchers.
- The dispatcher (`PTR_DISPATCH_INTERVAL_MS`, 1000) returns turns with an expired lease to pending with a new
  `dispatch_seq` and outbox entry, or fails them with `WORKER_LOST` after `PTR_MAX_ATTEMPTS` (3) and publishes the
  failure. It is safe to run more than one. Its outbox sweep is database-wide.
- Cancellation: the API marks the turn cancelled and publishes it; the worker running it is subscribed to the
  turn's channel and aborts the provider call at once (the lease heartbeat stays as the backstop).
- Re-execution after a lost worker is safe for the live OpenRouter provider: its ledger reuses a settled response
  for the identical request or refuses an unresolved one (`REQUEST_UNRESOLVED_NO_RESUBMIT`).
- Admission control: before any session lookup, the API reads the BullMQ backlog (shared for 200 ms) and takes a
  slot synchronously; at `PTR_QUEUE_MAX_DEPTH` (256) it answers `503 QUEUE_FULL` + `Retry-After: 1`. It is per API
  process over a shared backlog.
- Workers bound in-flight turns with `PTR_WORKER_CONCURRENCY` (32). `PTR_TURN_QUEUE` / `PTR_EVENTS_NAMESPACE`
  (`turns` / `events`) separate users of the same Redis. `onTurnFailure` reports error codes only.

## Push delivery (SSE)

`GET /api/turns/:id/events` (same auth/owner headers): ownership is checked first (else a JSON 404), then the API
subscribes to `ptr:<namespace>:turn:<id>`, sends one store snapshot (`event: turn`), forwards `event: state`
notices and, when a notice says the turn ended, reads the turn back from the store and sends it through the public
DTO before closing. Notices never carry model output. Pub/sub does not store messages, so the stream also re-checks
the store every 5 s, sends `: ping` every 15 s and ends after 120 s (clients reconnect for a fresh snapshot).
`GET /api/turns/:id` remains. The web UI reads the stream through the Next proxy with `fetch` (header auth) and
falls back to one status read before reconnecting; it never resubmits.

## LLM gateway

`apps/gateway` (`PTR_GATEWAY_PORT` 56460, 127.0.0.1, `PTR_GATEWAY_TOKEN`) exposes OpenAI-compatible
`POST /v1/chat/completions`, `GET /metrics` (token) and `GET /healthz`, in front of one upstream chosen by
`PTR_GATEWAY_UPSTREAM` — `fake` (optional `PTR_FAKE_LATENCY`), `selfhosted` (`PTR_SELFHOSTED_BASE_URL` loopback,
`PTR_SELFHOSTED_MODEL`) or `openrouter` (shared budget ledger). A self-hosted upstream may add a failover secondary
(below, default off); there is no other fallback between upstreams. It runs at
most `PTR_GATEWAY_MAX_CONCURRENCY` (32) upstream calls, queues up to `PTR_GATEWAY_MAX_QUEUE` (256) FIFO for
`PTR_GATEWAY_QUEUE_TIMEOUT_MS` (10000), and rejects the rest before anything reaches the upstream: 429
`GATEWAY_QUEUE_FULL` / 503 `GATEWAY_QUEUE_TIMEOUT`, both with `Retry-After`, `X-PTR-Gateway: rejected` and
`X-PTR-Gateway-Reason: queue_full` / `queue_timeout`. A full queue's `Retry-After` is the estimated wait,
`clamp(ceil(ceil(queued / PTR_GATEWAY_MAX_CONCURRENCY) × mean upstream call time), 1, 5)` seconds (mean = EWMA of
successful calls only, 1 before the first); a queue timeout answers 1. `/metrics` also reports
`capacity: {maxConcurrent, maxQueue, total}` (total = upstream cap + queue). A caller's disconnect leaves the queue or
aborts the upstream call. Upstream errors become 502 without that marker.
Workers use `PTR_CHAT_PROVIDER=gateway` (`PTR_GATEWAY_TOKEN`, `PTR_GATEWAY_STRUCTURED=1` for guided decoding) and the
client below.

### Worker gateway client: retries, gateway URLs, capacity rule

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_URLS` | — | comma list of loopback gateway base URLs, in priority order (active first, then standby) |
| `PTR_GATEWAY_URL` | `http://127.0.0.1:56460/v1` | used when `PTR_GATEWAY_URLS` is unset, as a list of one |
| `PTR_GATEWAY_RESET_RETRIES` | 2 (0–10; empty is an error) | connection resets retried per call, across all URLs (0 = the old behaviour) |
| `PTR_GATEWAY_RETRY_MIN_REMAINING_MS` | 5000 (0–60000; empty is an error) | a reset is retried only while this much time is left before the earlier of the provider deadline (60 s) and the turn deadline (30 s, so effectively the turn's) |
| `PTR_WORKER_REPLICAS_HINT` | 1 (1–1024) | how many workers run with this concurrency; used only for the startup capacity warning |

Retry rules (one `generate()` call, all inside the call deadline, the turn deadline and the caller's signal). The turn
times out after 30 s (`ChatService` `timeoutMs`) and passes that deadline to every model call as `deadlineAt`; the
provider's own 60 s timeout only matters for callers without a turn. Duplicate URLs are rejected at startup
(`ENDPOINT_DUPLICATE`; a non-loopback URL is `ENDPOINT_NOT_LOOPBACK`).

| Failure | Retried? | Next URL? | Wait |
| --- | --- | --- | --- |
| connection refused (`ECONNREFUSED`): nothing was sent | yes, while the wait + `PTR_GATEWAY_RETRY_MIN_REMAINING_MS` still fits before the deadline; else `PROVIDER_TRANSPORT` at once | yes | none before an untried URL; `min(100·2^n, 1000)` ms once every URL was tried |
| 429/503 marked `X-PTR-Gateway: rejected`, reason `queue_full` / `queue_timeout` | yes, while the wait + `PTR_GATEWAY_RETRY_MIN_REMAINING_MS` still fits before the deadline; else `PROVIDER_HTTP_429` / `PROVIDER_HTTP_503` at once | no | `min(Retry-After, 5 s) × U(0.5, 1.5)` (250 ms base without a header); the cap comes before the jitter so long waits still spread over 2.5–7.5 s |
| the same, reason `draining` (sent by drain, a later stage) | yes (same time rule) | yes | none before an untried URL, else as above |
| reset or close before the response headers, or a failed connect: a fetch `TypeError` whose cause code is `ECONNRESET`, `EPIPE`, `ECONNABORTED`, `UND_ERR_SOCKET` ("other side closed"), `UND_ERR_CLOSED`, `UND_ERR_CONNECT_TIMEOUT`, `EHOSTUNREACH` or `ENETUNREACH` | only with a request key, at most `PTR_GATEWAY_RESET_RETRIES` in total, only with ≥ `PTR_GATEWAY_RETRY_MIN_REMAINING_MS` left | yes | full jitter `U(0, min(2000, 200·2^k))` ms |
| reset while reading the SSE body after a 200 (same codes), or a stream that ends cleanly without `[DONE]` or a `finish_reason` | as above; the partial text and its usage are discarded (only a complete answer is returned) | yes | as above |
| any other HTTP status (502/504/500/4xx, an unmarked 503), our own abort or timeout, `INVALID_PROVIDER_RESPONSE` (empty or > 65536 chars), malformed SSE JSON, any other transport error (bad port, unexpected redirect, a `TypeError` without a known code) | never | — | — |

- A lost lease aborts the turn's signal (`LEASE_LOST`): an in-flight request or a backoff stops at once. The lease
  heartbeat keeps running during retries, and the dispatcher's turn retries are unchanged.
- Why a reset may be resent: turn calls always carry the turn id as `X-PTR-Request-Key`. A request still queued in the
  gateway never reached a model. A self-hosted generation cut by the reset is regenerated (no per-request bill). For the
  OpenRouter secondary, the ledger replays a settled answer for the same body and key, and refuses an unresolved one
  (`REQUEST_UNRESOLVED_NO_RESUBMIT`), so a turn is billed at most once.
- `CallMetrics.attempts` counts the HTTP requests of one call (1 + retries).
- `PTR_GATEWAY_UPSTREAM_TIMEOUT_MS` (60000) must stay above the turn timeout (30 s). A gateway timeout after the
  response headers cuts the stream, which the client would treat as a reset; above the turn timeout the turn has
  always ended first.
- Reset retries are off (`resetRetries` 0) in the provider class itself; only the gateway runtime turns them on, so
  direct engines (`PTR_CHAT_PROVIDER=selfhosted`) and the benchmarks keep failing fast.
- Gateway URLs: every call starts at the first URL and moves on as in the table; there is no sticky failover state.
  All URLs must be loopback, so a standby gateway is another port on the same host (it covers a process crash or a
  deploy, not a host failure). These URL lists and the startup warning are transitional: the design is moving to a
  stable gateway address with a Redis registry of GPU servers (38 §13).
- Every gateway in `PTR_GATEWAY_URLS` must use the **same Postgres ledger database** (`GOAL1_DATABASE_URL`) when a
  billable secondary (`PTR_GATEWAY_FAILOVER=openrouter`) is on. A reset retry that lands on another gateway is safe
  only because both see the same ledger entry for the turn key; with separate ledgers the second gateway could pay for
  the same turn again.
- `PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE` is counted per gateway process, so during an active–standby switchover up to
  twice the cap can reach the secondary.

Capacity rule: **Σ worker concurrency ≤ Σ upstream caps + gateway max queue**
(`PTR_WORKER_CONCURRENCY × replicas ≤ PTR_GATEWAY_MAX_CONCURRENCY + PTR_GATEWAY_MAX_QUEUE` today, one upstream).
A turn makes one model call at a time, so this bounds what can reach the gateway at once. Within the rule, count
rejections (429) do not happen in steady state, waits end only by the queue timeout (503), and further turns wait in
BullMQ, which is durable. At startup a gateway worker reads `capacity` from the first gateway whose `/metrics` answers
and writes one stderr line if `PTR_WORKER_CONCURRENCY × PTR_WORKER_REPLICAS_HINT` exceeds it (a warning, never a
startup failure; `gateway capacity check skipped` when no gateway answers). Breaking the rule does not fail turns
outright: the excess calls get 429 and wait in jittered client retries until the turn deadline, instead of waiting in
BullMQ. Example: gateway defaults 32 + 256 = 288;
4 workers × 32 = 128 is fine, 4 × 128 = 512 warns:
`WARNING gateway capacity: worker concurrency 128 x replicas 4 = 512 > gateway capacity 288 (upstream caps 32 + queue 256); calls above it are refused with 429 and wait in client retries ...`.
The load harness prints the same check (`report.capacityCheck`). Its fake-model defaults (gateway 1024 + 4096) are
sized so the gateway is never the bottleneck. The S9 setting of 4 workers × 512 broke the rule; it measured fake
throughput only.

With an upstream pool (below) each upstream also has its own cap `maxSeqs` (default 12), and the rule becomes
Σ worker concurrency ≤ min(`PTR_GATEWAY_MAX_CONCURRENCY`, Σ_u maxSeqs_u) + max queue. `/metrics` `capacity` still
reports the gateway-wide numbers only; the capacity controller (design stage S2b) will enforce the rule from the
registry.

### Failover to OpenRouter (optional, default off)

With `PTR_GATEWAY_UPSTREAM=selfhosted` and `PTR_GATEWAY_FAILOVER=openrouter`, the primary is the self-hosted engine and
the secondary is OpenRouter `google/gemma-4-26b-a4b-it` through the same `OpenRouterClient` + budget ledger as the
`openrouter` upstream (caps, `data_collection: deny`, `zdr`, price checks, no resubmission of unresolved requests).
A request goes to the secondary only when the primary did not answer it at all: the connection failed, or (self-hosted
primary, `PTR_GATEWAY_FAILOVER_ON_CLOSE=true`) the connection closed before any response byte, or the breaker is open
and the request is never sent to the primary. There is no spillover: the failover runs inside the gateway's admission
slot, so a full gateway queue still answers 429 `GATEWAY_QUEUE_FULL` / 503 `GATEWAY_QUEUE_TIMEOUT` (marked
`rejected`) and nothing reaches either upstream.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_FAILOVER` | `off` | `off`, `openrouter` (live: needs `GOAL1_LIVE_ENABLED=true`, `GOAL1_ALLOW_EXTERNAL_DATA=true`, `OPENROUTER_API_KEY`, ledger DB), or `fake` (load tests; the fake secondary takes `PTR_FAKE_LATENCY`). Requires `PTR_GATEWAY_UPSTREAM=selfhosted`. |
| `PTR_GATEWAY_FAILOVER_ON_CLOSE` | `true` | fail over a primary connection closed before any response byte. `true` suits a self-hosted primary (no per-request billing; the caller never got an answer). Set `false` for the strict rule (502). |
| `PTR_GATEWAY_BREAKER_FAILURES` | 3 (1–100) | consecutive primary connection failures (refused, connect errors, closed before response) that open the breaker |
| `PTR_GATEWAY_BREAKER_TIMEOUTS` | 3 (1–100) | consecutive primary timeouts that trigger a `/health` probe while closed; only a failed probe opens the breaker |
| `PTR_GATEWAY_BREAKER_COOLDOWN_MS` | 30000 (1000–3600000) | how long an open breaker sends every request straight to the secondary |
| `PTR_GATEWAY_BREAKER_PROBE_TIMEOUT_MS` | 2000 (100–30000) | timeout of a `GET /health` probe (a hung probe counts as failed) |
| `PTR_GATEWAY_PRIMARY_HEADERS_TIMEOUT_MS` | 0 = off (0–600000) | the primary must send response headers within this time (504, counted as a timeout, never failed over). The stream after the headers is not limited. vLLM streams through Starlette's `StreamingResponse`, which sends headers before the first token, so e.g. 10000 catches a hung tunnel without cutting queued or slow generations. Leave it off for non-streaming callers. |
| `PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE` | 120 (1–100000) | secondary calls started per rolling minute; above it the request fails (502, `rateLimited`). Failover shares the ledger's lifetime call cap (10000) with chat and Jev: at 120/min a whole cap lasts at least 83 min of outage. |

With failover on, keep `PTR_GATEWAY_UPSTREAM_TIMEOUT_MS` below 300000. Above it, undici's own 300 s headers timeout ends
a silent primary first. That still counts as a timeout (504, never failed over), but the configured deadline is never
reached.

Primary failure classification (`classifyTransportError`, `FailoverUpstream`):

| Primary outcome | Reached the model? | Gateway answer | Breaker |
| --- | --- | --- | --- |
| connection refused (`ECONNREFUSED`): engine/tunnel not listening | no (no connection) | **secondary** (`connect_refused`) | failures +1 |
| connect timeout (`UND_ERR_CONNECT_TIMEOUT`), any error raised by the `connect` syscall (e.g. `ECONNRESET`/`EHOSTUNREACH` while connecting) | no (undici writes only after connecting) | **secondary** (`connect_timeout` / `connect_error`) | failures +1 |
| DNS failure (`getaddrinfo`, `ENOTFOUND`, `EAI_AGAIN`) / TLS | no; cannot occur today (loopback IP over plain HTTP) | secondary (`dns`) | failures +1 |
| connection closed or reset after connecting, before any response byte (`UND_ERR_SOCKET`, `ECONNRESET` on read, `EPIPE`, a reused keep-alive socket the engine closed, or any other transport error) | maybe; nothing was returned to the caller | **secondary** (`closed_before_response`) with `PTR_GATEWAY_FAILOVER_ON_CLOSE=true`, else 502 `UPSTREAM_UNAVAILABLE` | failures +1 |
| no response headers before the headers timeout or `PTR_GATEWAY_UPSTREAM_TIMEOUT_MS` (hang after accept), or undici's own headers/body timeout (`UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT`, 300 s) | maybe | 504 `UPSTREAM_TIMEOUT` | timeouts +1 (probe at the threshold) |
| caller cancelled | maybe | none | no change |
| any HTTP status other than 2xx, including 503 | maybe (see below) | 502 `UPSTREAM_HTTP_<status>` | both streaks reset |
| 2xx, stream cut mid-response | yes | stream ends broken (client error) | both streaks reset |
| breaker open | not sent to the primary | **secondary** (`breaker_open`) | — |

Why a primary 503 is never failed over (vLLM main at commit 194da61, 2026-10-08):
- **Overload:** the opt-in admission control rejects with 503 before scheduling (`QueueOverflowError` / `MaxQueuedTokensError`: [async_llm.py#L344-L373](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/v1/engine/async_llm.py#L344-L373), [exceptions.py#L156-L183](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/exceptions.py#L156-L183)). Failing those over would be spillover.
- **Already ran:** `RetryableRequestError` answers 503 for a request that ran ([exceptions.py#L133-L138](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/exceptions.py#L133-L138)).
- **Scaling:** the elastic-EP `ScalingMiddleware` answers 503 too ([middleware.py#L22-L44](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/entrypoints/serve/elastic_ep/middleware.py#L22-L44)).

The status alone cannot tell these apart. A dead EngineCore raises `EngineDeadError`, a `VLLMServerError` ([v1/engine/exceptions.py#L12](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/v1/engine/exceptions.py#L12)) that maps to 500 ([error_response.py#L66-L69](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/entrypoints/serve/exception_handling/error_response.py#L66-L69)). The handler then stops the server ([vllm_error.py#L28-L64](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/entrypoints/serve/exception_handling/handlers/vllm_error.py#L28-L64), [launcher.py#L197-L206](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/entrypoints/launchers/launcher.py#L197-L206)), so later requests are refused through a direct port. Through an SSH tunnel (`ssh -L`) a dead engine behind a live tunnel shows up as closed before any response instead; this was reproduced locally with a `socat` forwarder in front of a closed port, which gave `UND_ERR_SOCKET`. Those requests fail over by default. A remote engine that hangs keeps the tunnel connection open; that is the timeout row. Undici's fetch blocks "bad ports" (e.g. port 1) with an uncoded error, which is therefore treated as closed before response; never point the primary at such a port.

Breaker:
- **Opening on failures:** `PTR_GATEWAY_BREAKER_FAILURES` consecutive connection failures open it.
- **Opening on timeouts:** `PTR_GATEWAY_BREAKER_TIMEOUTS` consecutive timeouts run one `/health` probe while closed, and a failed probe opens it. vLLM `/health` answers 200 while the engine is alive and 503 once EngineCore is dead ([health.py#L23-L33](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/entrypoints/serve/instrumentator/health.py#L23-L33)). An overloaded but healthy engine therefore never trips it.
- **Streaks:** HTTP answers reset both streaks, and nothing counts while the breaker is open.
- **While open:** requests skip the primary.
- **Half-open:** after the cooldown, the next request triggers one `GET /health` probe on the engine's origin. Concurrent requests share the probe, and each may abort while waiting. 200 closes the breaker and the request goes to the primary. Anything else (including a hung probe at its timeout) restarts the cooldown and the request goes to the secondary. No user request is used as a probe.

Idempotency: the worker sends its turn id as `X-PTR-Request-Key` (`[A-Za-z0-9._:-]{1,128}`, else 400). The gateway passes it to the OpenRouter client as the ledger idempotency key, and it is never sent upstream. The ledger key is the SHA-256 of the exact OpenRouter body plus that key:
- **Different turns** with identical prompts get separate entries, so neither blocks the other.
- **A retried turn** (same turn id, lease lost or requeued) rebuilds the same prompt. It replays the settled response, or is refused with `REQUEST_UNRESOLVED_NO_RESUBMIT` (502) when the first call's outcome is unknown, for example after the worker aborted mid-call.
- **Without the header** (other callers) the key is the body hash alone, as before.

Within one gateway request the secondary is called at most once. The direct `openrouter` provider (no gateway) keeps its body-only keys, so research reruns still replay.

Lease-lost retry during an in-flight secondary call: the original worker's call may still be running when the
dispatcher requeues the turn. The new worker reaches the same ledger entry while it is `submitted` and is refused
(`REQUEST_UNRESOLVED_NO_RESUBMIT`), so the turn can fail. It is never billed twice. If the original call settles first,
the retry replays it.

Request shape:
- **`response_format`:** the OpenRouter client chooses it itself: strict `json_schema` for gemma agent replies when the catalog advertises structured outputs, else `json_object`, whatever the worker requested.
- **`max_tokens`:** the worker's value passes through but can only lower the client's 512-token cap.
- **Temperature:** fixed at 0, which is what the worker sends.
- **`chat_template_kwargs.enable_thinking:false`:** corresponds to the client's `reasoning: {enabled:false}`.

Input limits: 32 KiB of message JSON and 64 messages. The app caps agent and experiment prompts at 30000 bytes (`EXPERIMENT_PROMPT_BYTE_LIMIT`; the captured Jev/Gemma workload had p50 8983 / p95 29427 / max 30016 bytes measured with Python spacing, at most 11 messages). Legacy (non-agent) prompts carry the full history and can exceed 64 messages; those are refused with 502.

Response shape: the secondary is called non-streaming, and the gateway returns the reply as one SSE chunk with `usage` when OpenRouter reports it (or JSON for `stream:false`). The worker's measured TTFT for a secondary answer therefore equals its total time. A secondary error (budget cap, price change, rate ceiling, transport) is a 502 without the rejection marker, the same provider failure as the `openrouter` upstream.

Startup: with `PTR_GATEWAY_FAILOVER=openrouter` the gateway reads the ledger and verifies the gemma catalog price before it listens, and fails startup (`GATEWAY_STARTUP_FAILED`) otherwise.

Observability:
- **Header:** with failover on, every upstream HTTP answer carries `X-PTR-Upstream: primary|secondary`. Errors without an upstream answer (connection failures, timeouts, secondary errors) carry no such header; `/metrics` splits them.
- **`/metrics`:** adds `failover`:
  - `breaker`: `state` (closed/open/half_open), `consecutiveFailures`, `consecutiveTimeouts`, `opened`, `probesOk`, `probesFailed`
  - `answered.primary|secondary`
  - `failovers` by reason: `connect_refused`, `connect_timeout`, `connect_error`, `dns`, `closed_before_response`, `breaker_open`
  - `closedNotFailedOver`, `rateLimited`, `secondaryErrors`

  Cancelled callers are not counted.
- **Failover off:** responses and metrics are unchanged for the `selfhosted` and `fake` upstreams. Departures that apply with failover off as well:
  - A malformed `X-PTR-Request-Key` is rejected with 400 `INVALID_INPUT` (the worker never sends one).
  - The `openrouter` upstream now scopes its ledger entries per turn when the header is present, so identical prompts of different turns are both billed instead of replayed.
  - The `openrouter` upstream adds a `usage` object to its reply chunk.
  - The `openrouter` upstream honours a lower `max_tokens` from the caller.
  - The `openrouter` upstream does not run the startup check.
  - An undici headers/body timeout from a self-hosted upstream now answers 504 `UPSTREAM_TIMEOUT` instead of 502.
- **Turn trace:** the worker does not record the serving upstream in it (the provider port returns text only).

Runbook:
- **Enable:** set `PTR_GATEWAY_UPSTREAM=selfhosted PTR_GATEWAY_FAILOVER=openrouter` plus the live flags and the ledger database (`GOAL1_DATABASE_URL`/`DATABASE_URL`), e.g. `GOAL1_LIVE_ENABLED=true node --env-file=.env.local --import tsx apps/gateway/src/main.ts`. Consider `PTR_GATEWAY_PRIMARY_HEADERS_TIMEOUT_MS=10000` for streaming workers.
- **Watch:** `failover.breaker.state`, `answered.secondary` and `rateLimited` in `/metrics`. Every secondary answer is billed to the shared ledger.
- **Breaker stuck open:** `/health` on the engine origin is failing; check the engine and the SSH tunnel (`curl http://127.0.0.1:<port>/health`).
- **Stop paid traffic:** restart the gateway without `PTR_GATEWAY_FAILOVER`, lower `PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE`, or lower the ledger caps. In-flight secondary calls finish within the shutdown drain.

### Upstream pools and the GPU server registry (stage S2)

A self-hosted gateway can front a **pool** of engines that serve the same model instead of one
`PTR_SELFHOSTED_BASE_URL`. The member set is dynamic: engines join and leave while the gateway runs.

Sources (`UpstreamSource`):
- **env only** (`PTR_SELFHOSTED_BASE_URL` + `PTR_SELFHOSTED_MODEL`, nothing below set): the single upstream as before.
  It behaves exactly like a pool built from a file with one entry (`apps/gateway/tests/pool.test.ts` compares the
  bytes); the failover wrapper is now that one-entry pool internally.
- **file** (`PTR_GATEWAY_UPSTREAMS_FILE`, `PTR_GATEWAY_DISCOVERY=static`): JSON as in
  `configs/gateway-upstreams.example.json`. The gateway serves one pool, `PTR_GATEWAY_POOL` (default
  `PTR_SELFHOSTED_MODEL`); the pool name is the model name sent to the engines (their `--served-model-name`).
  Entries: `id`, `baseUrl` (loopback rule only: operator config), `maxSeqs` (12), `kvCapacityTokens` (null; used by the
  credit stage later), `weight` (1). The file is re-read when its mtime changes (checked every 5 s) and on `SIGHUP`;
  an invalid file fails startup, an invalid edit keeps the last good list (`fileErrors`, one stderr line, no contents).
  `PTR_SELFHOSTED_BASE_URL` together with a file is a startup error.
- **redis** (`PTR_GATEWAY_DISCOVERY=redis`, `PTR_REDIS_URL`): the registry below. The file (or else
  `PTR_SELFHOSTED_BASE_URL` as one entry `selfhosted`) is only the seed: the membership until the registry has been
  read once (Redis unreachable at startup). From the first successful read on, the registry is the only authority,
  so a drained or removed upstream never comes back from the seed, and the seed's id never doubles an engine that its
  agent registers under another id.

Registry layout (`packages/messaging/src/upstream-registry.ts`, prefix `PTR_REGISTRY_PREFIX`, default `ptr:llm`; it must
end in `:llm`, so it can never touch `ptr:turns:*` or `ptr:events:*`):

```text
ptr:llm:up:<pool>:<id>   HASH {pool,id,baseUrl,maxSeqs,kvCapacityTokens,weight,state(active|draining),epoch,seq}  PEXPIRE 10000
ptr:llm:ups:<pool>       ZSET member=<id> score=expiresAtMs   (read with ZRANGEBYSCORE now +inf; writers trim expired entries)
ptr:llm:reg:ver          INCR on every new record, field change, drain or removal
ptr:llm:reg              PUB/SUB, empty message = "poll now"
```

Writes are Lua scripts (atomic): a heartbeat carries the publisher's state and refreshes TTL, index and `seq`; it never
turns a `draining` record of the same epoch back to `active`, and a draining agent's heartbeat recreates an expired
record as draining; a new id or epoch, or a changed field, bumps the version and publishes.

Gateway behaviour (`RedisRegistrySource` + `UpstreamPool`):
- **Discovery:** polls every `PTR_GATEWAY_REGISTRY_POLL_MS` (2000) and at once on a nudge; lost nudges are covered by
  the next poll. A new id, or a new **epoch** for a known id (the engine restarted), is a new upstream: fresh breaker,
  slow start. Upstreams present when the gateway starts begin at full capacity.
- **Slow start:** a newly added upstream's limit is `max(1, floor(maxSeqs · min(1, Δt / PTR_GATEWAY_SLOW_START_MS)))`
  (30000; 0 = off). This applies on every add, including an agent that comes back with the same epoch, so a flapping
  upstream never receives a burst.
- **Selection (interim, until S3's credit-based scoring):** among upstreams that are active, not draining, with a closed
  breaker and below their limit, the one with the fewest calls in flight (ties rotate). If all are at their limit the
  request waits in the gateway (no spillover) up to `PTR_GATEWAY_QUEUE_TIMEOUT_MS`, then gets the marked 503
  `GATEWAY_QUEUE_TIMEOUT` (nothing was sent, so the worker resends). An empty pool without failover waits the same way.
- **Drain / expiry:** `state=draining` or a record that left the registry gets no new calls at once; its in-flight
  calls finish. A changed `maxSeqs` applies to the next dispatch (in-flight calls are kept).
- **Breaker per upstream** (`UpstreamHealth`, the former failover breaker unchanged: `PTR_GATEWAY_BREAKER_*`). An open
  upstream is skipped; others serve meanwhile and a background `/health` probe lets it back after the cooldown
  (waiting requests are woken when a breaker closes). With no other upstream and no failover the open one is still
  tried, exactly like a single upstream without a breaker.
- **Connection failures** (nothing reached the engine; with `PTR_GATEWAY_FAILOVER_ON_CLOSE=true` also a close before
  any response byte) are retried on another upstream, at most `PTR_GATEWAY_PRIMARY_ATTEMPTS` (2) upstreams per request,
  then on the failover secondary if configured. If the other upstreams stay full until the queue timeout, the original
  connection error is returned (or the secondary used), never the marked "nothing was sent" 503, because a close
  before response may have reached the engine. Timeouts, HTTP errors and streams cut mid-response are not retried here
  (a cut stream is retried by the worker's reset rule). The secondary is used only when no primary could take the
  request: all breakers open, none registered (`no_upstream`), or all tried primaries failed to connect. "All busy"
  waits; it never fails over.
- **Redis unreachable:** the membership is **frozen** (no additions, no expiry; dead engines are left to the breakers),
  `registry.stale=true`. Once readable again, records missing from the registry are kept for
  `PTR_GATEWAY_REGISTRY_GRACE_MS` (10000 = the TTL) before they are dropped, because the agents' next heartbeat may not
  have landed yet or Redis expired the records during the outage. One failed poll is enough to arm the grace, so an
  upstream removed right after a short blip may stay listed for up to 10 s (its breaker covers it). BullMQ shares this
  Redis, so no new turns start during the outage anyway.

Security (single host): anyone with the Redis password can write a record, and a record decides where
prompts (user data) are sent. The gateway therefore applies the existing loopback rule to every record's `baseUrl`
(`http`, `127.0.0.1`, no credentials, query or fragment) **and** `PTR_GATEWAY_UPSTREAM_ALLOW`, a comma list of
`127.0.0.1:<port>` or `127.0.0.1:<from>-<to>` (default `127.0.0.1:18000-18999`; anything else is a startup error).
Records that fail are ignored and counted once per record version in `registry.rejected` / `rejectedReasons`
(`not_loopback`, `not_allowed`, `invalid_record`, `pool_mismatch`, and `duplicate_url`: a second id for a `baseUrl`
already listed, which would double that engine's `maxSeqs`); they are never logged with their URL. File and env
entries are operator config and need only the loopback rule. Records are not signed; multi-host operation (TLS, Redis
ACL users, HMAC-signed records, a host/CIDR allowlist) is a later, separately approved stage.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_DISCOVERY` | `static` | `static` (env or file) or `redis` |
| `PTR_GATEWAY_UPSTREAMS_FILE` | — | pool file (static source, or seed for redis); requires `PTR_GATEWAY_UPSTREAM=selfhosted` |
| `PTR_GATEWAY_POOL` | `PTR_SELFHOSTED_MODEL` | pool served by this gateway = model name sent upstream |
| `PTR_GATEWAY_UPSTREAM_ALLOW` | `127.0.0.1:18000-18999` | ports registry records may use |
| `PTR_GATEWAY_SLOW_START_MS` | 30000 (0–600000) | ramp of a newly added upstream's limit |
| `PTR_GATEWAY_PRIMARY_ATTEMPTS` | 2 (1–8) | upstreams tried per request on connection failures |
| `PTR_GATEWAY_REGISTRY_POLL_MS` | 2000 (100–60000) | registry poll interval |
| `PTR_GATEWAY_REGISTRY_GRACE_MS` | 10000 (0–600000) | keep-missing-records grace after Redis comes back |
| (check) | — | with a pool, `PTR_GATEWAY_UPSTREAM_TIMEOUT_MS` must exceed 2 × `PTR_GATEWAY_QUEUE_TIMEOUT_MS` (admission queue + upstream wait), else startup fails |
| `PTR_REGISTRY_PREFIX` | `ptr:llm` | registry namespace (`…:llm`; tests use `ptrtest:<run>:llm`) |
| `PTR_UPSTREAM_HEARTBEAT_MS` / `PTR_UPSTREAM_TTL_MS` | 2000 / 10000 | agent heartbeat and record TTL (TTL ≥ 2 × heartbeat) |
| `PTR_UPSTREAM_DRAIN_SETTLE_MS` | 4000 | agent drain: minimum wait before checking the engine is idle (two gateway polls) |
| `PTR_UPSTREAM_DRAIN_MAX_MS` | 120000 | agent drain: upper bound before the record is deleted anyway |

`/metrics` with a pool adds `pool`: `members` {active, ramping, draining, gone, breakerOpen}, `waiting`,
`retriedOnOtherPrimary`, `events` {added, removed, replaced, invalid}, `upstreams[]` {id, epoch, state, inFlight, limit,
maxSeqs, weight, slowStart, breaker, dispatched, answered, connectFailures} and `registry` {discovery, stale
(registry_stale), staleForMs, failedPolls, rejected (registry_rejected), rejectedReasons, graceRemainingMs, version,
fileErrors}. With failover on, `failover.breaker` aggregates the members (closed if any is closed).

Agent and CLI (`scripts/upstream-agent.ts`, needs `PTR_REDIS_URL`; prints JSON lines, never the Redis URL):

```bash
# foreground agent next to the engine's SSH tunnel; SIGTERM drains and deregisters
pnpm exec tsx scripts/upstream-agent.ts register --pool=gemma-4-e4b-fp8 --id=pod-a --base-url=http://127.0.0.1:18000/v1 \
  [--max-seqs=12] [--kv-capacity-tokens=347000] [--weight=1] [--epoch=<id>]
pnpm exec tsx scripts/upstream-agent.ts drain --pool=gemma-4-e4b-fp8 --id=pod-a        # exit 0 once the record is gone
pnpm exec tsx scripts/upstream-agent.ts deregister --pool=gemma-4-e4b-fp8 --id=pod-a   # immediate; a running agent re-registers
pnpm exec tsx scripts/upstream-agent.ts list [--pool=gemma-4-e4b-fp8]
```

- `register` waits for the engine's `/health` = 200, reads `/metrics` once: KV capacity from
  `vllm:cache_config_info` (`num_gpu_blocks × block_size`, else `--kv-capacity-tokens`, else null) and
  `process_start_time_seconds` for the epoch (a hash of id, URL and start time: a restarted agent keeps the epoch, a
  restarted engine gets a new one; `--epoch` overrides; without either the epoch is random). Both metric names are
  unverified against the deployed vLLM (); the fallbacks keep the agent working either way.
  It then heartbeats; three failed `/health` checks in a row deregister the engine until it is healthy again.
- Drain (`SIGTERM`/`SIGINT` to the agent, or `drain` from anywhere): the agent heartbeats `state=draining` (every
  tick until a write succeeds), waits `PTR_UPSTREAM_DRAIN_SETTLE_MS` counted from that confirmed write, then until `vllm:num_requests_running + vllm:num_requests_waiting = 0` on two checks in a
  row (an unreachable engine counts as idle), bounded by `PTR_UPSTREAM_DRAIN_MAX_MS`; then the record is deleted
  (`remove_failed` if Redis refuses: it then expires by TTL) and the agent exits. A second signal exits at once; a
  drain requested before the first registration publishes nothing.

Runbook:
- **Scale up:** start the engine and its SSH tunnel on a port inside `PTR_GATEWAY_UPSTREAM_ALLOW`, then `register`. Within
  one poll (usually at once, by nudge) every gateway adds it and ramps it over 30 s. Check `pool.upstreams[]` in
  `/metrics`.
- **Scale down:** `drain` (or `SIGTERM` the agent). New calls stop within a poll, in-flight calls finish, the record is
  deleted, then stop the engine and the tunnel.
- **Engine crash:** in-flight streams break (workers retry them with the turn key), new calls get connection errors and
  move to another upstream, the breaker opens, and the record expires 10 s after the agent's last heartbeat.
- **Agent crash only:** the engine keeps serving its in-flight calls but takes no new ones once the record expires
  (capacity drops); restart the agent and it returns with the same epoch (slow start again).
- **Redis outage:** nothing to do; check `registry.stale` and that `members` did not drop after it came back.
- **Rejected records:** `registry.rejected` rising means someone registered a URL outside the allowlist; `list` shows it.

## Providers (direct, without the gateway)

- `fake` (default): deterministic, no network. `PTR_FAKE_LATENCY='{"medianMs":1900,"p95Ms":3600,"seed":7}'`
  adds a seeded log-normal delay (optional `error429Rate`, `hangRate`) for load tests; rejected for any
  other provider.
- `openrouter`: live API through the shared US$2 / 10000-request ledger (requires `GOAL1_LIVE_ENABLED=true`).
- `selfhosted`: `PTR_SELFHOSTED_BASE_URL` (must be `http://127.0.0.1:<port>/v1`, i.e. an SSH tunnel) and
  `PTR_SELFHOSTED_MODEL`; streams to record TTFT; no per-request billing (GPU time is accounted per run).
  `PTR_SELFHOSTED_STRUCTURED=1` sends `AGENT_RESPONSE_JSON_SCHEMA` as `response_format: json_schema` for
  agent_loop agent turns so the engine's guided decoding enforces the reply shape. Use it with small
  self-hosted models: without it Gemma 4 E4B sometimes omits `evidenceRefs` and the strict no-repair
  contract fails the turn. The zod contract is still the validator.

Evaluation scripts (`scripts/evaluate*.ts`) run turns through Redis with the worker in their own process
(`createQueuedChat`: private queue and namespace, no dispatcher), so per-turn tracing still sees every call; they
need `PTR_REDIS_URL`.

## Load / failure harness (synthetic only)

Uses the isolated `ptr_loadtest` database (`PTR_LOADTEST_DATABASE_URL`, see `infra/README.md`) and Redis
(`PTR_REDIS_URL`), synthetic personas/posts, and spawns its own processes with an explicit environment: API ×`--apis`
(ports from `--port`, default 56451), worker ×`--workers`, dispatcher ×`--dispatchers`, and the gateway (port +50;
`--gateway=0` calls the model in-process). It uses its own queue/namespace (`loadtest-turns` / `loadtest`) and wipes
that queue at the end.

```sh
pnpm exec tsx scripts/loadtest.ts ramp --levels=64,256,1024 --stage-seconds=45 --apis=2 --workers=4 --worker-concurrency=512
pnpm exec tsx scripts/loadtest.ts crash --target=workers|api|redis|gateway --users=32 --apis=2
pnpm exec tsx scripts/loadtest.ts crash --target=gateway --users=16 --apis=2 --standby-gateway=1 --restart=0
pnpm exec tsx scripts/loadtest.ts same-session --trials=30 --apis=2
pnpm exec tsx scripts/loadtest.ts failover --users=32 --apis=2 [--primary-failure=refuse|close] [--breaker-cooldown-ms=5000]
pnpm exec tsx scripts/loadtest.ts ramp --levels=1000 --think-ms=4000 --client=poll --poll-ms=100   # polling comparison
pnpm exec tsx scripts/loadtest.ts ramp --levels=4,16,64 --turns-per-session=10 \
  --provider=selfhosted --base-url=http://127.0.0.1:18000/v1 --model=gemma-4-e4b-fp8 --structured=1
```

`crash` kills the target 10 s into a 30 s stage and restarts it 2 s later (`--restart=0` leaves workers, an API or the
gateway down; `--target=redis` is a `docker restart` in place and ignores it). With
`--standby-gateway=1` a second gateway runs on port +51, workers get both URLs in `PTR_GATEWAY_URLS`, and a gateway
crash kills only the primary.

`failover` serves the self-hosted primary from an in-process fake engine (port +60, same latency profile) with
`PTR_GATEWAY_FAILOVER=fake`. It runs 15 s healthy; then the engine is killed 3 s into a 20 s stage and stays down
(`--primary-failure=refuse` leaves the port closed, `close` keeps it bound by a listener that accepts and closes
without answering, like a tunnel to a dead engine); then the engine restarts for a stage of cooldown + 15 s. Each phase
reports turns, latency and the gateway's failover counters, followed by orphaned active turns. No paid calls.

Virtual users stick to one API and move to the next on network errors; they POST a turn and follow it over SSE
(`--client=poll` for comparison), honour `Retry-After`, and `--turns-per-session=N` starts a new session every N
turns. Reports (`reports/loadtest/<run>/report.json`, private) hold per-stage throughput, e2e/accept percentiles,
error codes, stuck/orphaned turns, database work per stage (transactions/s and per turn, WAL bytes per turn, updates
vs HOT updates and dead tuples of `turns`; inserts, updates, HOT updates, deletes, writes per turn and dead tuples of
`turn_leases`), gateway metrics, and per-second CPU/RSS per process role and DB connections.
Single-host replicas do not demonstrate multi-host fault tolerance. Fake-model results describe the serving
architecture, never real LLM throughput.

Registry acceptance (`scripts/registry-acceptance.ts`–T5, T7, T9): in-process fake engines (12
sequences each, 600 ms per call, an engine-side queue beyond that), the real agent loop, gateway, pool and registry
source, and closed-loop worker clients with the S1 retry settings. `--store=redis` (default) goes through a local TCP
proxy to the isolated Redis (so the outage scenario never touches the shared container) in a `ptrtest:s2<run>:llm`
namespace deleted afterwards; `--store=memory` uses the in-memory registry. Report: `reports/registry-acceptance-<run>.json`.

```sh
pnpm exec tsx scripts/registry-acceptance.ts [--store=redis|memory] [--scenarios=T1,T2,T3,T4,T5,T7,T7b,T9] [--users=24]
```

## Engine benchmarks

- GPU host scripts: `infra/gpu/` (vLLM vs SGLang, BF16 / online FP8 / NVFP4, same client and workloads); every script reads the engine directory from `PTR_GPU_ROOT`.
- `scripts/provider-bench.ts`: same synthetic app-shaped prompt against OpenRouter (capped by `--max-usd`,
  per-request nonce so ledger caching never counts as latency) or a tunnelled self-hosted engine.
- `scripts/summarize_engine_bench.py <run-dir>`: Markdown + `summary.json` joining results with GPU samples.

## Storage integration tests

`RUN_STORAGE_DB_TESTS=1 DATABASE_URL="$PTR_LOADTEST_DATABASE_URL" pnpm exec jest packages/storage/test --runInBand`
(add `RUN_REDIS_TESTS=1` with `PTR_REDIS_URL` for `packages/messaging`; the registry contract runs its Lua scripts
in a per-test `ptrtest:<uuid>:llm` namespace and deletes it). Lease recovery, reconciliation and
outbox sweeps are database-wide, so run them while no dispatcher or load test uses the same database. Their
assertions only look at the tests' own synthetic turns. The migration test creates and drops its own scratch schema.
