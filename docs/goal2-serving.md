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
       dispatcher ×D: requeue expired leases / WORKER_LOST, QUEUE_TIMEOUT, re-publish unclaimed outbox entries
                                                                                ▼
                       LLM gateway (fake | self-hosted vLLM: one engine or a pool from a file / the Redis registry
                                    [+ optional OpenRouter failover] | OpenRouter)
```

Every turn runs queued; there is no inline mode (`PTR_EXECUTION` is rejected at startup). Processes:
`pnpm dev:api`, `pnpm dev:worker`, `pnpm dev:dispatcher`, `pnpm dev:gateway`.
All need `PTR_REDIS_URL` (`infra/compose.redis.yml`) and migrations through `0008_turn_leases.sql`.

Configuration : production is one process per role with 19 variables, checked at startup
([configuration.md](configuration.md), `pnpm ops:check-env`). The scaling features below that are not part of that
profile (several workers or gateways, the registries, routing policies other than `least_inflight`, telemetry, affinity)
need `PTR_DEMO_SCALING=1`: see [demo-mode.md](demo-mode.md).

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
- Queue wait limit (`PTR_TURN_MAX_QUEUE_MS`, 60000, 1000–3600000; set the same value on workers and dispatchers): a
  pending turn no worker holds fails once it has waited longer than this since it was last queued (its outbox entry:
  the reservation, or the latest requeue after a lost lease), and the failure is published. A turn that never ran
  fails with `QUEUE_TIMEOUT`; a requeued one (an earlier attempt may have reached a model) fails with `WORKER_LOST`.
  The dispatcher's sweep does it each tick after recovery; it scans the outbox (every unclaimed pending turn has an
  entry) and locks with `SKIP LOCKED`. The claim itself also refuses a turn past the limit, so no worker starts one
  before the sweep runs. Both use the database clock and are compare-and-set on the turns row (state `pending`, empty
  token): a claim committed first is never failed, and a failed turn is never claimed. A claimed turn is never failed
  by this sweep, whatever its age; from the claim the turn timeout (30 s) owns it. For `QUEUE_TIMEOUT` the web UI shows
  a short "try again in a moment" line in the session language; nothing ran, so trying again is safe.
  Each requeue starts a fresh wait, so across `PTR_MAX_ATTEMPTS` a turn can stay unfinished for up to about
  attempts × (limit + turn timeout + lease), roughly 5 minutes with the defaults.
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
aborts the upstream call. Upstream errors become 502 without that marker. SIGTERM/SIGINT start a graceful drain
(503 `draining`, see "Gateway drain" below); several gateways can publish themselves in a Redis gateway registry that
workers read (demo mode, [demo-mode.md](demo-mode.md)).
Workers use `PTR_CHAT_PROVIDER=gateway` (`PTR_GATEWAY_TOKEN`; guided decoding is on by default, `PTR_GATEWAY_STRUCTURED=0`
turns it off in demo mode) and the client below.

Semantic search with `PTR_CHAT_PROVIDER=gateway` or `selfhosted` (architecture review R10): these runtimes have no real
query embedder (queries would get the fake hash embedding, `synthetic/hash-1536-v1`, while licensed source vectors
are `openai/text-embedding-3-small`, so the `model_revision` filter would return no evidence). Session creation with
`retrievalMode: semantic` (also the default of a RAG condition without a mode) is refused with 400
`SEMANTIC_UNAVAILABLE`; turns of a semantic session created earlier fail (`TURN_FAILED`, reason
`RETRIEVAL_UNAVAILABLE`) before any model or search call. Use `lexical`. Real query embeddings there would be a new
external, paid transfer and are not wired. `fake` and `openrouter` keep semantic search.

### Worker gateway client: retries

The variables in this table are demo layer (`PTR_DEMO_SCALING=1`, [demo-mode.md](demo-mode.md)); production uses the
defaults: one gateway at `http://127.0.0.1:56460/v1`, 2 reset retries, 5000 ms minimum remaining time.

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
| the same, reason `draining` (a gateway draining on SIGTERM, S6) | yes (same time rule) | yes | none before an untried URL, else as above |
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
- Several gateway URLs (`PTR_GATEWAY_URLS`, active–standby), the per-gateway failover ceiling and the capacity rule
  (Σ worker concurrency ≤ gateway caps + queue) are demo-mode topics: see [demo-mode.md](demo-mode.md#several-gateway-urls-and-the-capacity-rule).
  Production runs one gateway at the default URL.

### Capacity controller (demo mode)

Moved to [demo-mode.md](demo-mode.md#capacity-controller-design-38-135-stage-s2b): production runs one worker
(`PTR_WORKER_CONCURRENCY`, 32) against one gateway and has no controller .

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
| `PTR_GATEWAY_PRIMARY_HEADERS_TIMEOUT_MS` | 10000 (0–600000; 0 = off) | the primary must send response headers within this time (504, counted as a timeout, never failed over). The stream after the headers is not limited. vLLM streams through Starlette's `StreamingResponse`, which sends headers before the first token, so 10000 catches a hung engine or tunnel without cutting queued or slow generations. The worker always streams; set 0 only for non-streaming callers. It applies to pools, the failover wrapper and (without a breaker) the env-only engine with failover off. The fake-engine harnesses (`loadtest`, `routing-compare`, telemetry / registry / gateway-HA acceptance) set it to 0: their fake engines send headers only with the first token. |
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
| caller cancelled after waiting at least the headers timeout without headers (on only when the headers timeout is) | maybe | none | timeouts +1 (probe at the threshold) |
| caller cancelled earlier | maybe | none | no change |
| any HTTP status other than 2xx, including 503 | maybe (see below) | 502 `UPSTREAM_HTTP_<status>` | both streaks reset |
| 2xx, stream cut mid-response | yes | stream ends broken (client error) | both streaks reset |
| breaker open | not sent to the primary | **secondary** (`breaker_open`) | — |

Why a primary 503 is never failed over (vLLM main at commit 194da61, 2026-10-08):
- **Overload:** the opt-in admission control rejects with 503 before scheduling (`QueueOverflowError` / `MaxQueuedTokensError`: [async_llm.py#L344-L373](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/v1/engine/async_llm.py#L344-L373), [exceptions.py#L156-L183](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/exceptions.py#L156-L183)). Failing those over would be spillover.
- **Already ran:** `RetryableRequestError` answers 503 for a request that ran ([exceptions.py#L133-L138](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/exceptions.py#L133-L138)).
- **Scaling:** the elastic-EP `ScalingMiddleware` answers 503 too ([middleware.py#L22-L44](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/entrypoints/serve/elastic_ep/middleware.py#L22-L44)).

The status alone cannot tell these apart. A dead EngineCore raises `EngineDeadError`, a `VLLMServerError` ([v1/engine/exceptions.py#L12](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/v1/engine/exceptions.py#L12)) that maps to 500 ([error_response.py#L66-L69](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/entrypoints/serve/exception_handling/error_response.py#L66-L69)). The handler then stops the server ([vllm_error.py#L28-L64](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/entrypoints/serve/exception_handling/handlers/vllm_error.py#L28-L64), [launcher.py#L197-L206](https://github.com/vllm-project/vllm/blob/194da61de1769c28bfad2b6642c60cc7eca544dd/vllm/entrypoints/launchers/launcher.py#L197-L206)), so later requests are refused through a direct port. Through an SSH tunnel (`ssh -L`) a dead engine behind a live tunnel shows up as closed before any response instead; this was reproduced locally with a `socat` forwarder in front of a closed port, which gave `UND_ERR_SOCKET`. Those requests fail over by default. A remote engine that hangs keeps the tunnel connection open; that is the timeout row. Undici's fetch blocks "bad ports" (e.g. port 1) with an uncoded error, which is therefore treated as closed before response; never point the primary at such a port.

Hung engine (architecture review R1): before, the headers timeout was off and the gateway's own deadline (60 s) came
after the worker's turn deadline (30 s), whose abort was not counted, so an engine that accepts connections and never
answers never opened the breaker and every turn spent 30 s. Now the headers timeout is on by default and late caller
aborts count too. A hung engine costs each turn up to 10 s (504) until `PTR_GATEWAY_BREAKER_TIMEOUTS` such timeouts in
a row run a `/health` probe; a hung engine or tunnel does not answer it either (probe timeout), so the breaker opens
and later requests go to another primary or, when configured, the secondary. The request that timed out is not
resent anywhere, also not to another free primary: its body was sent, so it may be in the model (the timeout row
above), and the gateway does not resubmit such a request to the paid secondary. Every secondary call stays keyed by
the worker's turn id in the ledger, so nothing is billed twice (`apps/gateway/tests/failover.test.ts`, "hung engine").
An engine whose `/health` still answers 200 while completions hang is not taken out (its probe passes); each of its
calls still ends at the headers timeout.

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

Input limits: 32 KiB of message JSON and 64 messages. The app caps agent and experiment prompts at 30000 bytes and 3 evidence posts (`EXPERIMENT_PROMPT_BYTE_LIMIT`, `EVIDENCE_POST_LIMIT`; posts are added whole in relevance order, one that does not fit is skipped, and only a prompt that does not fit without posts is `CONTEXT_LIMIT`; the captured Jev/Gemma workload had p50 8983 / p95 29427 / max 30016 bytes measured with Python spacing, at most 11 messages). Legacy (non-agent) prompts carry the full history and can exceed 64 messages; those are refused with 502.

Response shape: the secondary is called non-streaming, and the gateway returns the reply as one SSE chunk with `usage` when OpenRouter reports it (or JSON for `stream:false`). The worker's measured TTFT for a secondary answer therefore equals its total time. A secondary error (budget cap, price change, rate ceiling, transport) is a 502 without the rejection marker, the same provider failure as the `openrouter` upstream.

Startup: with `PTR_GATEWAY_FAILOVER=openrouter` the gateway reads the ledger and verifies the gemma catalog price before it listens, and fails startup (`GATEWAY_STARTUP_FAILED`) otherwise.

Observability:
- **Header:** with failover on, every upstream HTTP answer carries `X-PTR-Upstream: primary|secondary`. Errors without an upstream answer (connection failures, timeouts, secondary errors) carry no such header; `/metrics` splits them.
- **`/metrics`:** adds `failover`:
  - `breaker`: `state` (closed/open/half_open), `consecutiveFailures`, `consecutiveTimeouts`, `opened`, `probesOk`, `probesFailed`
  - `answered.primary|secondary`
  - `failovers` by reason: `connect_refused`, `connect_timeout`, `connect_error`, `dns`, `closed_before_response`, `breaker_open`
  - `closedNotFailedOver`, `rateLimited`, `secondaryErrors`

  Cancelled callers are not counted here (a late one counts only toward the breaker's timeout streak).
- **Failover off:** responses and metrics are unchanged for the `selfhosted` and `fake` upstreams. Departures that apply with failover off as well:
  - A malformed `X-PTR-Request-Key` is rejected with 400 `INVALID_INPUT` (the worker never sends one).
  - The `openrouter` upstream now scopes its ledger entries per turn when the header is present, so identical prompts of different turns are both billed instead of replayed.
  - The `openrouter` upstream adds a `usage` object to its reply chunk.
  - The `openrouter` upstream honours a lower `max_tokens` from the caller.
  - The `openrouter` upstream does not run the startup check.
  - An undici headers/body timeout from a self-hosted upstream now answers 504 `UPSTREAM_TIMEOUT` instead of 502.
  - The env-only self-hosted engine ends a call that has no response headers after `PTR_GATEWAY_PRIMARY_HEADERS_TIMEOUT_MS` (default 10000) with 504 `UPSTREAM_TIMEOUT`; there is no breaker or alternative here.
- **Turn trace:** the worker does not record the serving upstream in it (the provider port returns text only).

Runbook:
- **Enable:** set `PTR_GATEWAY_UPSTREAM=selfhosted PTR_GATEWAY_FAILOVER=openrouter` plus the live flags and the ledger database (`GOAL1_DATABASE_URL`/`DATABASE_URL`), e.g. `GOAL1_LIVE_ENABLED=true node --env-file=.env.local --import tsx apps/gateway/src/main.ts`. The primary headers timeout is on (10000) by default; keep it for streaming workers.
- **Watch:** `failover.breaker.state`, `answered.secondary` and `rateLimited` in `/metrics`. Every secondary answer is billed to the shared ledger.
- **Breaker stuck open:** `/health` on the engine origin is failing; check the engine and the SSH tunnel (`curl http://127.0.0.1:<port>/health`).
- **Stop paid traffic:** restart the gateway without `PTR_GATEWAY_FAILOVER`, lower `PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE`, or lower the ledger caps. In-flight secondary calls finish within the shutdown drain.

### Upstream pools (stage S2)

Production : the gateway requires `PTR_GATEWAY_UPSTREAMS_FILE` with exactly one pool and serves that pool
(its name is the served model; `PTR_GATEWAY_POOL` and the env-only single engine are demo layer).

A self-hosted gateway can front a **pool** of engines that serve the same model instead of one
`PTR_SELFHOSTED_BASE_URL`. The member set is dynamic: engines join and leave while the gateway runs.

Sources (`UpstreamSource`):
- **env only** (`PTR_SELFHOSTED_BASE_URL` + `PTR_SELFHOSTED_MODEL`, nothing below set): the single upstream as before.
  It behaves like a pool built from a file with one entry (`apps/gateway/tests/pool.test.ts` compares the bytes), with
  one difference: env only has no per-upstream cap (only `PTR_GATEWAY_MAX_CONCURRENCY`), while a file entry defaults to
  `maxSeqs` 12; give the entry `maxSeqs` = `PTR_GATEWAY_MAX_CONCURRENCY` for the same behaviour. The failover wrapper
  is that uncapped one-entry pool internally.
- **file** (`PTR_GATEWAY_UPSTREAMS_FILE`, `PTR_GATEWAY_DISCOVERY=static`): JSON as in
  `configs/gateway-upstreams.example.json`. The gateway serves one pool, `PTR_GATEWAY_POOL` (default
  `PTR_SELFHOSTED_MODEL`); the pool name is the model name sent to the engines (their `--served-model-name`).
  Entries: `id`, `baseUrl` (loopback rule only: operator config), `maxSeqs` (12), `kvCapacityTokens` (null; used by the
  credit stage later), `weight` (1). The file is re-read when its mtime changes (checked every 5 s) and on `SIGHUP`;
  an invalid file fails startup, an invalid edit keeps the last good list (`fileErrors`, one stderr line, no contents).
  `PTR_SELFHOSTED_BASE_URL` together with a file is a startup error.
- **redis** (`PTR_GATEWAY_DISCOVERY=redis`): the upstream registry and `scripts/upstream-agent.ts`, demo mode only; see
  [demo-mode.md](demo-mode.md#upstream-registry-and-agent).

Gateway behaviour (`UpstreamPool`; production: the file source):
- **Slow start:** a newly added upstream's limit is `max(1, floor(maxSeqs · min(1, Δt / PTR_GATEWAY_SLOW_START_MS)))`
  (30000; 0 = off). This applies on every add, including an agent that comes back with the same epoch, so a flapping
  upstream never receives a burst.
- **Selection:** the pool's central queue and credit admission (next section): among upstreams that are active, not
  draining, with a closed breaker and with credit, by `PTR_GATEWAY_ROUTING` (default `least_inflight`). Without credit
  anywhere the request waits (no spillover) up to `PTR_GATEWAY_QUEUE_TIMEOUT_MS`, then gets the marked 503
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

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_UPSTREAMS_FILE` | — | pool file (static source, or seed for redis); requires `PTR_GATEWAY_UPSTREAM=selfhosted` |
| `PTR_GATEWAY_POOL` | `PTR_SELFHOSTED_MODEL` | pool served by this gateway = model name sent upstream |
| `PTR_GATEWAY_SLOW_START_MS` | 30000 (0–600000) | ramp of a newly added upstream's limit |
| `PTR_GATEWAY_PRIMARY_ATTEMPTS` | 2 (1–8) | upstreams tried per request on connection failures |
| (check) | — | with a pool, `PTR_GATEWAY_UPSTREAM_TIMEOUT_MS` must exceed `PTR_GATEWAY_QUEUE_TIMEOUT_MS`, else startup fails: the upstream deadline starts once a request is admitted and the wait for a free upstream (up to the queue timeout) runs inside it, so a shorter deadline would turn that wait into an unmarked 504 |

`/metrics` with a pool adds `pool`: `members` {active, ramping, draining, gone, breakerOpen}, `waiting`,
`retriedOnOtherPrimary`, `queueTimeouts` (marked 503s because no upstream slot freed in time; a subset of
`rejected.queueTimeout`, which also counts the admission queue), `events` {added, removed, replaced, invalid}, `upstreams[]` {id, epoch, state, inFlight, limit,
maxSeqs, weight, slowStart, breaker, dispatched, answered, connectFailures} and `registry` {discovery, stale
(registry_stale), staleForMs, failedPolls, rejected (registry_rejected), rejectedReasons, graceRemainingMs, version,
fileErrors}. With failover on, `failover.breaker` aggregates the members (closed if any is closed).

### Credit admission, central queue and routing (–§4, stage S3)

A pool from a file or the registry **owns admission**: the gateway's own limiter (`PTR_GATEWAY_MAX_CONCURRENCY`) is
bypassed, requests wait in the pool's queue, and an upstream gets a request only when it has credit (late binding).
The env-only single upstream and the failover wrapper keep the old limiter, so N = 1 behaves exactly as before.

**Estimate per request:** T̂ = ceil(content bytes / `PTR_GATEWAY_BYTES_PER_TOKEN` (3.9)), conservative for ~90% of
requests; M = `max_tokens` (else 512). G (the policy block) is the most common msg0 seen (bounded table of 16, counts
decayed with a half-life of 256 requests), so one odd first request or a short batch with another system message
cannot set it, while a policy-prompt deploy re-learns G after about 256 requests (fewer when the old block was rare); a request whose msg0 is that block has G cached (uncached = T̂ − G), any other
has nothing cached (uncached = T̂). G is resident once per server and capped at half the KV budget. Since S5 the
cached share on an upstream is the larger of that and the request's match in the upstream's prefix table ([demo-mode.md](demo-mode.md)).

**Credit `fits_u(r)`** (all must hold; the same check for every routing policy):
1. active (not draining), breaker closed (with no closed member and no secondary, open ones are still used);
2. sequences: N_u + 1 ≤ S_u^eff (maxSeqs, ramped by slow start);
3. KV, when `kvCapacityTokens` is known: Kres_u + (T̂ − G) + M ≤ κ·K_u − G (`PTR_GATEWAY_KV_OVERCOMMIT` κ = 0.9);
   an idle upstream always takes one request so nothing waits forever;
4. prefill, only when `prefillTokensPerSec` (R_u) is calibrated (record/file field; unset by default): U_u = 0 or
   U_u + (T̂ − G) ≤ R_u · T_max (`PTR_GATEWAY_TTFT_PENALTY_MS` 1000).

5. engine telemetry, while fresh (S4, off in production, [demo-mode.md](demo-mode.md)): KV usage < `PTR_GATEWAY_ENGINE_KV_HIGH` and waiting ≤
   `PTR_GATEWAY_ENGINE_WAITING_MAX`, except that an upstream with nothing of ours in flight still takes one request.

The ledger: N (in flight), Kres (reserved KV, released at the end), U (uncached prompt tokens, released at the first
body chunk).

**Queue:** bands from `X-PTR-Priority` (1 = a follow-up model call of a running turn, 0 = a turn's first call, the
default, −1 = batch), strictly ordered (a waiting higher band holds back lower ones). Within a band FIFO, or deficit
round robin per `X-PTR-Flow` (hex) with `PTR_GATEWAY_FAIRNESS=drr` and quantum `PTR_GATEWAY_DRR_QUANTUM_TOKENS` (4096).
Up to `PTR_GATEWAY_LOOKAHEAD` (8) requests that do not fit are skipped so later ones can pass; a skipped request older
than `PTR_GATEWAY_STARVATION_MS` (2000) stops its band instead (no overtaking forever). The loop runs on every enqueue,
completion, first chunk, membership or breaker change, and every 250 ms while requests wait.

**Selection:** production routes by `least_inflight` (fewest in flight, ties rotate), the default. `round_robin`,
`scored`, the routing comparisons that kept the default, and DRR fairness are demo mode: see
[demo-mode.md](demo-mode.md#routing-policies-and-the-comparison).

**Rejections** (all marked `X-PTR-Gateway: rejected`, nothing was sent): queue over `PTR_GATEWAY_MAX_QUEUE` (256)
after a dispatch attempt → 429 `queue_full` (a request with credit still runs at 0; when full, a higher band takes the
place of the newest request of the lowest band below it, which gets the 429 instead); with `PTR_GATEWAY_REJECT_SATURATED=true` (default false) an estimated wait above the queue timeout → 429
`saturated`; `PTR_GATEWAY_QUEUE_TIMEOUT_MS` (10000) → 503 `queue_timeout`. The `saturated` estimate is
load-dependent, which is why it is off by default: estimated wait = (uncached tokens queued at this band and above +
this request's) / the uncached prompt tokens per second that reached a first chunk over the last 10 s. That rate is
what the engines *did*, not what they *can* do: right after a load increase the 10 s window still holds the quieter
period, so the rate is too low and the wait too high (early 429s while the pool could still catch up); with slow
answers it lags too. It is only consulted while requests already wait, and only with ≥ 20 successful answers in the
window. Enable it only after checking `rejected.saturated` against `queue_timeout` under the real load. Retry-After = clamp(ceil(queued uncached
tokens at this band and above / recent prefill tokens per second), 1, 5) s (1 before any rate is known; only 2xx
answers count toward the rate, and the early `saturated` refusal needs at least 20 of them in the last 10 s).

**Worker:** turn calls send `X-PTR-Priority`: 0 on the turn's first model call, 1 on agent follow-up iterations, so a
started turn finishes first (shorter e2e, shorter lease hold).

**Metrics** (`pool` in `/metrics`): per upstream `reservedKvTokens`, `prefillTokens`, `kvCapacityTokens`,
`prefillTokensPerSec`, `seqUtil`, `kvUtil`; `queue` {routing, fairness, queued by band, queuedTokens, waitMs p50/p95,
rejected {queue_full, saturated, queue_timeout}, globalPrefixTokens, prefillTokensPerSec}. `capacity` reports
Σ maxSeqs + the pool queue bound.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_ROUTING` | `least_inflight` | `round_robin`, `least_inflight`, `scored` |
| `PTR_GATEWAY_KV_OVERCOMMIT` | 0.9 (0.1–1) | κ |
| `PTR_GATEWAY_BYTES_PER_TOKEN` | 3.9 (0.5–20) | token estimate |
| `PTR_GATEWAY_TTFT_PENALTY_MS` | 1000 | T_max (prefill gate and cost) |
| `PTR_GATEWAY_LOOKAHEAD` / `PTR_GATEWAY_STARVATION_MS` | 8 / 2000 | queue head-of-line relief and aging |
| `PTR_GATEWAY_FAIRNESS` / `PTR_GATEWAY_DRR_QUANTUM_TOKENS` | `fifo` / 4096 | `fifo` or `drr` |
| `PTR_GATEWAY_REJECT_SATURATED` | false | early 429 `saturated` |
| `PTR_GATEWAY_MAX_QUEUE` / `PTR_GATEWAY_QUEUE_TIMEOUT_MS` | 256 / 10000 | the pool queue bound and wait |

### Slow start after recovery, restarts (stage S4)

Pools only (file or registry). Engine telemetry polling and its filter (off by default) are demo mode: see
[demo-mode.md](demo-mode.md#engine-telemetry-design-38-44-stage-s4).

**Slow start after a breaker closes** (§5, deferred in S2): when a member's breaker closes again (probe healthy, or a
call sent while open answered), its limit ramps from 1 over `PTR_GATEWAY_SLOW_START_MS` like a newly added member, so a
recovered (cold-cache) engine does not receive the whole queue at once. `rampReason` in the member metrics says why a
member is ramping: `added`, `breaker_closed` or `restarted`. Exception: a breaker closed by a call sent while it was
open (no other member and no secondary, so the open upstream was used and answered) does not ramp: that upstream is
already serving, and ramping the only member would throttle the whole pool.

**Engine restarts:** a registry record's new epoch already makes a new member (S2). For file and env members the epoch
never changes, and an agent started with `--epoch` keeps it too, so a **later** `process_start_time_seconds` clears the
member once two polls in a row report the same new value: a fresh breaker, slow start from 1 (`rampReason: restarted`),
the telemetry streaks reset, the prefix table emptied (S5), `events.restarted` + 1. A restart only ever moves the start
time forward, so a value **earlier** than the latest one seen (current or pending candidate) means several processes
answer on that port (e.g. API server processes behind one port, each with its own start time): restart detection is
then turned off for that member (`telemetry.restartDetectionDisabled`, one `WARNING gateway upstream <id>:
restart detection off …` line, the prefix table cleared once), because alternating start times would otherwise be read
as restarts back and forth (S4 re-review). In the worst order (A, B, B, A with B later) the B, B pair still counts one
restart before the earlier A turns detection off. While off, only the breaker reacts to real restarts; 30 polls in a
row with one start time (one process again) re-arm it with that value as the new baseline (`restart detection back
on` line); when that baseline differs from the one before detection went off, the prefix table is emptied once more
(the process left on the port may not be the one whose cache the table describes). In-flight calls of the old process end on their own (cut streams are
retried by the worker's reset rule). Without the metric nothing is detected (only the breaker reacts).

**Primary-to-primary retry and failover (§5, verified):** retried on another member only for connection-phase errors
(`UpstreamConnectError.certain`) and, with `PTR_GATEWAY_FAILOVER_ON_CLOSE=true`, a close before any response byte; at
most `PTR_GATEWAY_PRIMARY_ATTEMPTS` (2) members per request; the reservation moves with it (released on the failed
member, a new one on the next). Timeouts, HTTP errors and streams cut mid-response are not moved. The secondary is used
only when no primary can take the request: every member's breaker open (`breaker_open`), none active (`no_upstream`,
draining members included), or every tried member failed to connect. Busy members (no credit, or telemetry-blocked) are
waited for, never failed over. One nuance the design text leaves open: after a failed connect, if the other members
stay busy until the queue timeout, the request goes to the secondary (or the connect error surfaces); the marked
"nothing was sent" 503 is not used because a close before response may have reached the engine.

### Prefix table and cache affinity (demo mode)

Moved to [demo-mode.md](demo-mode.md#prefix-table-cache-affinity-routing-log-and-8-metrics-design-38-4243-8-stage-s5). In production
only the learned global policy block G (credit admission above) changes routing; with affinity off (the default)
the per-member prefix tables are recorded but do not change the choice.

### Gateway drain (stage S6)

**Graceful drain (§6.3).** SIGTERM or SIGINT on a gateway:
1. `draining = true`: `/healthz` answers 503 `{ok:false,draining:true}`, `/metrics` reports `draining: true`.
2. Every request waiting in the gateway (the limiter's queue, or a pool's band queue) and every request arriving
   later get **503 `GATEWAY_DRAINING`** with `X-PTR-Gateway: rejected`, `X-PTR-Gateway-Reason: draining`,
   `Retry-After: 1` and `Connection: close`. None of them was sent upstream, so the worker client resends at once to
   its next gateway URL, with no wait (S1 rule). A retry inside a pool (a second primary after a connect failure, whose
   first attempt may have reached an engine) is neither refused nor counted: queued or arriving during the drain, it
   waits for credit and is served like an in-flight call (or ends as before: secondary, or the connect error).
3. The registry record (demo mode, [demo-mode.md](demo-mode.md)) is set to `draining`, and the leader hint is given up.
4. Calls already sent upstream finish, for up to `PTR_GATEWAY_SHUTDOWN_MS` (30000). Idle keep-alive connections are
   closed at once, and every response written while draining closes its connection.
5. Then the listener and every remaining connection close, the record is deleted, the registry Redis connection and
   the ledger pool are closed. The process exits 0 only after a clean drain; it exits 1 (with `gateway stopped
   uncleanly …`) when the deadline cut calls still in flight or a cleanup step failed (record delete, ledger pool).

The gateway logs two lines: `gateway draining: N in flight, M queued (refused now)` and `gateway drained (idle|deadline):
K request(s) refused while draining, J still in flight`. `rejected.draining` counts the refusals (`pool.queue.rejected.draining`
counts those refused in a pool queue). A call cut at the deadline behaves like a SIGKILL for that call: a self-hosted
generation is regenerated by the worker's reset retry, and a paid secondary call keeps its ledger row `submitted`, so it
is never resent.

The gateway registry, several gateways, per-replica limits and their acceptance runs are demo mode: see
[demo-mode.md](demo-mode.md#gateway-registry-and-several-gateways).

### Prompt layout for prefix reuse ( P1–P3, §9.2, stage S7)

All chat prompt builders (`packages/core/src/prompts.ts`; the agent runtime uses `buildExperimentContext`) render:

```text
policy · persona · history · [AGENT_STATE, AGENT_TOOLS] · [UNTRUSTED_EVIDENCE] · [safety note] · user · [tool transcript]
```

- **P1:** the input-safety deflection note (`SAFETY_DEFLECTION_NOTE`) is its own system message right before the user
  utterance. It used to be appended to the policy message.
- **P2:** the agent's per-turn state and tool list come after the history (they used to come before it).
- **P3:** `packages/core/tests/prompt-layout.test.ts` pins the byte stability on real multi-turn chat-service runs
  (agent with every RAG condition, experiment, legacy): the policy message is identical across personas and turns; the
  persona message is identical across a persona's turns; the first model call of turn N up to the end of its history
  is a byte prefix of turn N+1's first call (and of the next agent iteration's); state, tools, evidence, the note and
  tool results appear only after the history. Mutating either change back makes the suite fail.
- **Superseded by the persona card :** agent `character-agent-context-v5-persona-card` and experiment
  `persona-chat-v8-persona-card`. The S7 layout is kept. Style examples are added before the history, and matched lore
  is placed between the state and the tools. One persona-independent policy sentence is added, and English sessions
  get an English disclosure prefix. Superseded in turn by agent `character-agent-context-v6-identity-privacy` and
  experiment `persona-chat-v9-identity-privacy` (S8 follow-up: identity/privacy policy and reply guard; same layout),
  then by `character-agent-context-v7-own-voice` / `persona-chat-v10-own-voice` (first-person voice kept, no added
  details) and `character-agent-context-v8-small-talk` / `persona-chat-v11-small-talk` (light everyday
  small talk for real-person personas, no concrete invented facts), then by
  `character-agent-context-v9-persona-voice` / `persona-chat-v12-persona-voice` (AI disclosure only when
  asked, no disowned background, replies in the user's language, persona-voice fixed texts, agent message cap 400
  code points instead of 180; same layout), then by `character-agent-context-v10-steady-voice` /
  `persona-chat-v13-steady-voice` (light fictional likes allowed, no quotable policy lines, origin stated, one
  Korean speech level carried in the state message; same layout), then by `character-agent-context-v11-no-meta-talk` /
  `persona-chat-v14-no-meta-talk` (persona data named only by block names, no talk about it, unknown details
  answered like a person, only important real-world facts never invented; reply guard v7 removes meta-talk sentences; same
  layout), then by `character-agent-context-v12-evidence-cap` / `persona-chat-v15-evidence-cap` (at most 3
  evidence posts in the character prompts, tool results first in the agent, a post that does not fit skipped whole instead
  of a `CONTEXT_LIMIT` turn failure; retrieval and the legacy path keep their limit; policy text and layout unchanged). v12/v15 need S8 gates b–f, with c re-measuring recall
  under the cap, before serving or baselining; a only when the layout changes. See
  docs/persona-authoring.md (persona authoring, CLI, deploy order, reply guard, persona voice).
- **Revisions:** `character-agent-context-v4-prefix-stable` (agent, every turn's bytes change), and for the note
  placement only `persona-chat-v7-turn-note-last` (experiment), `persona-chat-v4-turn-note-last` (timeline) and
  `persona-chat-v2-turn-note-last` (small talk). Without a safety note these three render the same bytes as v6 / v3 / v1,
  so runs without the input-safety filter stay comparable. The timeline bump is nominal: a deflected turn is always
  routed to small talk, so a timeline prompt never carries the note. Turns record the agent revision in
  `reply.agent.promptRevision`; the evaluation scripts record the constants in their reports. Pre-existing gaps, not
  changed here: only agent turns store a prompt revision (experiment and legacy turns store none), and
  `scripts/live-research.ts` labels its small-talk outputs with the timeline revision (`PROMPT_REVISION`).
- **HARD GATES before v4 is served or used as an eval baseline** (S8, items 1 and 2 below):
  (a) the chat-template check. It applies to **every agent turn from turn 2 on**, not only to deflected turns: the
  state and tool system messages now follow assistant turns. (b) The reply-level `prompt_injection` comparison of v3
  and v4. The S7 safety condition is so far met only structurally (deterministic placement checks), not on model replies.
- **Not changed:** the legacy goal1 `buildPrompt` keeps its reply-format instruction inside the policy message, so it
  has two policy variants (small talk / timeline), each byte-stable; the serving path (agent) has one. The fictional
  draft prompt (`fictional-post-draft-v1`, one call without history) still appends a deflection note to its policy.
- **Gateway side effects:** the policy block G that admission learns from the first message (§3.1) is no longer
  polluted by deflected turns, and the S5 prefix table (message-boundary hashes) now matches a deflected turn up to
  its history.
- **The Jev input-safety filter is unaffected:** it receives only the user text, at most two earlier user turns, a
  seed and the question set (`SafetyAssessInput`), runs before any prompt is built, and does not import the prompt
  builders. Its synthetic-set accuracy (152/154 at the defaults) measures the classifier, not the chat model, so it
  needs no re-run.

**Offline prefix gain (§9.2; zero cost).** `scripts/prompt-prefix-gain.ts --workload=<workload.private.json>` takes
the captured Jev/Gemma workload (`reports/jev-gemma-bench/2026-10-08T11-39-16-577Z`, private: 91 agent calls, 32
conversations of 2–3 turns, no tool rounds, no deflections), rebuilds each call in the S7 order from its own
messages (byte-identical to the new builder, tested), and takes for each call, in capture order, the longest common
byte prefix with any earlier call. This is an unbounded prefix cache that never evicts, so the numbers are upper
bounds. **Global** is the prefix shared with other conversations (policy, persona, greeting). **Session** adds the
prefix shared with the same conversation; that part hits only on the engine that served the conversation before.
There is no Gemma tokenizer offline: bytes become tokens at 4.45 B/token (the median of UTF-8 bytes / vLLM
`prompt_tokens` measured on these captures; range 3.74–4.96) and are floored to whole 16-token KV
blocks. Messages are serialized with a generic chat-template wrapper.

| Calls | Prompt tokens (mean) | Global: previous → S7 | Session: previous → S7 |
| --- | --- | --- | --- |
| turn 1 (32) | 3360 | 40.5% → 40.6% | 40.5% → 40.6% |
| turn 2 (28) | 2591 | 49.1% → 49.9% | 51.8% → 52.7% |
| turn 3 (31) | 2582 | 49.5% → 50.4% | 54.1% → 55.1% |
| all (91) | 2858 | 45.7% → 46.2% | 47.8% → 48.4% |
| per session, p10 / p50 / p90 | | 26.9 / 46.0 / 92.4% (prev. 26.5 / 45.3 / 91.0%) | 29.3 / 51.7 / 93.8% (prev. 29.1 / 51.4 / 93.4%) |
| a deflected turn (each call as one) | | 36.7% → 44.7% | 37.5% → 46.8% |

- On this workload the gain is small. Global column: +0.5 pp of prompt tokens overall (about 14 tokens per call),
  +0.8–0.9 pp (about 22 tokens) on turns 2–3. Session column: +0.6 pp overall (about 17 tokens per call), +0.9–1.0 pp
  (about 25 tokens) on turns 2–3. The history is only 3.5% of the prompt bytes (2–3 turns, replies ≤ 180 characters),
  while evidence is 49% and the policy 40%. The agent state changed between consecutive turns in 43 of 59 pairs, so
  P2 did matter where history existed; there was just little history.
- A deflected turn gains +8.0 pp in the global column (about 230 tokens) and +9.3 pp in the session column (about 270
  tokens). The previous layout still kept the policy tokens (the note was appended at the end of the policy text, so the
  policy stayed a byte prefix), but it lost the persona and the history.
  The design's "even the global prefix breaks" holds for message-level hashes (gateway prefix table, G), not for the
  engine's token blocks.
- Longer sessions gain more. A model with the capture's mean block sizes (policy 5029 B, persona 858, greeting 159,
  user 59, reply 159, state + tools 116, evidence 6111) and the state unchanged in 27% of turn pairs gives a
  same-engine cacheable share at turn n of 47.5 → 48.2% (n = 2, +19 tokens), 47.2 → 49.1% (3, +55), 46.5 → 50.7%
  (5, +126), 45.0 → 54.5% (10, +305) and 42.6 → 60.5% (20, +662). This is a model, not a measurement.
- The session part needs the same engine: with affinity off (the default) and N engines it hits about 1/N of the time.
  The global part is reused on every engine.

**To re-measure in S8 (needs the GPU host or paid calls, not run here):**
1. **Chat template (hard gate a).** Render v4 prompts through the engine's chat template (vLLM `/tokenize` with `messages`, then
   `/detokenize`; no generation) and check that system messages after assistant turns are accepted and stay in place.
   If the template hoists or merges system messages, both the prefix gain and the note's position change. Do the same
   for the OpenRouter failover model, whose provider applies its own template.
2. **Reply-level injection handling (hard gate b).** No existing eval measures the chat model's answer to a deflected turn: the Jev
   safety eval scores the classifier only. Send the 14 synthetic `prompt_injection` items (including the multi-turn
   `prompt_injection-ko-08`) through a `agent_loop` session with the filter on, under v3 and v4, on the self-hosted
   model. Check that no reply reveals the policy or prompt text, that the reply stays in persona, and that it keeps
   the JSON format. Deterministic offline checks (note right before the utterance, once; no retrieval or tool; same
   policy bytes) pass for all 14 items in all three profiles.
3. **Answer quality under P2.** Run the Korean paired regression (`evaluate-korean-chat.ts --recollection`) on the
   agent prompt v3 vs v4, because the state and tool list now sit closer to the question. The state includes the
   model-written `conversationTopic`, so model-generated text now sits right before the evidence and the question.
4. **Engine prefix hits.** Compare vLLM prefix-cache hit rate (tokens) on the same replayed workload, v3 vs v4; the
   expectation from the table is about +0.5 pp on 2–3-turn sessions. Re-capture the workload under v4 for later
   routing comparisons and recalibrate bytes per token.

## Providers (direct, without the gateway)

**Control tokens (all providers that call a model):** `OpenAICompatibleTextProvider.generate` and
`OpenRouterClient.generate`/`decide` neutralize chat-template control strings in every message (and every string of a
Jev decision state) before the request body, and so its ledger key, is built (`neutralizeControlTokens`): the 24 added
special tokens of the deployed Gemma 4 tokenizer (`<|turn>`, `<turn|>`, `<|channel>`, `<|"|>`, `<bos>`, …), any
`<|x>`/`<x|>`/`<|x|>`, the legacy `<start_of_turn>` family, `<s>`, `<<SYS>>` and `[INST]`. The leading `<` becomes `‹`
(`[` becomes `［`): readable, deterministic, idempotent, and text without such strings is byte-identical (prefix
caching and ledger keys unchanged). S8 gate a showed vLLM turning these strings inside content into real control
tokens (a user could forge a system turn). The gateway neutralizes forwarded messages again (defence in depth for any
other caller). Known limit: a caption that contains one is shown to the model neutralized,
so a quote copied from it no longer matches the original caption and that reference fails validation.

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
crash kills only the primary. `--signal=SIGTERM` (gateway only) drains it instead of SIGKILL; the report then
carries the gateway's two drain log lines (`drainLog`).

Gateway HA acceptance (`scripts/gateway-ha-acceptance.ts` C/D/E, T6; see "Gateway registry and several gateways" in [demo-mode.md](demo-mode.md)):

```sh
pnpm exec tsx scripts/gateway-ha-acceptance.ts [--scenarios=C,E,T6,D] [--users=16] [--seconds=30] [--base-port=56531]
```

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
pnpm exec tsx scripts/registry-acceptance.ts --scenarios=G1,G2,G5,T8     # capacity controller, Redis only
```

The G scenarios (S2b) drive the production BullMQ path (`BullMqTurnDelivery`, `startTurnConsumer`, `openTurnQueue`) on
a throwaway `ptrtest-cap-<hex>` queue (obliterated afterwards) with the real `CapacityController`: workers of local
concurrency 64 whose turn is 400 ms outside the gateway plus one gateway call, and a feeder that keeps 48 turns
waiting. G1 = scale-up (G rises within a tick), G2 = drain (G drops at once), G5 = flapping (G changes at most once per
15 s), T8 = `maxSeqs` lowered (G drops after the hysteresis; active converges).

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
