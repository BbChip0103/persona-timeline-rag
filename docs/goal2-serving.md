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
(503 `draining`, see "Gateway HA" below); several gateways can publish themselves in a Redis gateway registry that
workers read (same section).
Workers use `PTR_CHAT_PROVIDER=gateway` (`PTR_GATEWAY_TOKEN`, `PTR_GATEWAY_STRUCTURED=1` for guided decoding) and the
client below.

Semantic search with `PTR_CHAT_PROVIDER=gateway` or `selfhosted` (architecture review R10): these runtimes have no real
query embedder (queries would get the fake hash embedding, `synthetic/hash-1536-v1`, while licensed source vectors
are `openai/text-embedding-3-small`, so the `model_revision` filter would return no evidence). Session creation with
`retrievalMode: semantic` (also the default of a RAG condition without a mode) is refused with 400
`SEMANTIC_UNAVAILABLE`; turns of a semantic session created earlier fail (`TURN_FAILED`, reason
`RETRIEVAL_UNAVAILABLE`) before any model or search call. Use `lexical`. Real query embeddings there would be a new
external, paid transfer and are not wired. `fake` and `openrouter` keep semantic search.

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
- Gateway URLs: every call starts at the first URL and moves on as in the table; there is no sticky failover state.
  All URLs must be loopback, so a standby gateway is another port on the same host (it covers a process crash or a
  deploy, not a host failure). With `PTR_GATEWAY_DISCOVERY=redis` the list comes from the gateway registry and these
  URLs become its seed and fallback (see "Gateway HA" below); with Kubernetes a single Service address in
  `PTR_GATEWAY_URLS` and `static` discovery replace both (in the cluster profile).
- Every gateway in `PTR_GATEWAY_URLS` must use the **same Postgres ledger database** (`GOAL1_DATABASE_URL`) when a
  billable secondary (`PTR_GATEWAY_FAILOVER=openrouter`) is on. A reset retry that lands on another gateway is safe
  only because both see the same ledger entry for the turn key; with separate ledgers the second gateway could pay for
  the same turn again.
- `PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE` is counted per gateway process. Without the gateway registry, up to twice the
  cap can reach the secondary during an active–standby switchover. With it, each gateway uses cap / k, where k is the
  number of active gateways registered (see "Gateway HA" below).

Capacity rule: **Σ worker concurrency ≤ Σ upstream caps + gateway max queue**
(`PTR_WORKER_CONCURRENCY × replicas ≤ PTR_GATEWAY_MAX_CONCURRENCY + PTR_GATEWAY_MAX_QUEUE` today, one upstream).
A turn makes one model call at a time, so this bounds what can reach the gateway at once. Within the rule, count
rejections (429) do not happen in steady state, waits end only by the queue timeout (503), and further turns wait in
BullMQ, which is durable. **With the capacity controller on** (below; default with `PTR_GATEWAY_DISCOVERY=redis`) the
rule is enforced automatically through BullMQ's global concurrency, and a worker only logs the current G at startup.
**With it off**, at startup a gateway worker reads `capacity` from the first gateway whose `/metrics` answers
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
reports the gateway-wide numbers only; the capacity controller (next section) enforces the rule from the registry.

### Capacity controller (stage S2b)

The dispatcher keeps BullMQ's **global concurrency G** of the turn queue (`ptr:<PTR_TURN_QUEUE>:meta` field
`concurrency`) at

```text
S_live = Σ maxSeqs of the pool's active, unexpired registry records that pass the gateway's record policy
         (allowlist, loopback, one id per origin; draining excluded; slow start ignored: the gateway absorbs the ramp)
Q      = Σ maxQueue of the active gateways in the gateway registry that pass PTR_GATEWAY_ALLOW (S6),
         else PTR_GATEWAY_MAX_QUEUE (256) when none is registered or the registry cannot be read
G*     = max(PTR_CAPACITY_FLOOR (1), min(ceil(S_live × (1 + PTR_CAPACITY_HEADROOM (0.25))), S_live + Q))
```

BullMQ checks G in its Lua when a worker takes the next job, so active turns ≤ G ≤ Σ caps + queue: the capacity rule
holds by construction, whatever the number of workers. `PTR_WORKER_CONCURRENCY` is only a local cap now (64 is a good
value); in-flight turns = min(Σ local caps, G).

- **Leader:** any number of dispatchers may run; one holds `ptr:llm:cap:leader` (`SET NX PX max(15 s, 3 × interval)`,
  renewed every tick) and acts every `PTR_CAPACITY_INTERVAL_MS` (5000). It writes G only when it changes. A dispatcher
  that (re)gains leadership starts with fresh hysteresis, and records that are already draining are its starting point
  (not a new drain that would lower G at once).
- **Hysteresis:** increases apply at once (a new server raises G within one tick). A decrease applies only after 3
  consecutive ticks (15 s) with a lower target, then at most 25% (at least 1) per tick, so a record flapping on its TTL
  never moves G. A newly **draining** upstream (planned shrink) lowers G at once. Lowering G never interrupts active
  turns: BullMQ only stops handing out new jobs (verified by the opt-in BullMQ test), so `active` may exceed G briefly
  and converges as turns finish.
- **Registry unreachable:** G is held and those ticks never count toward a decrease (§13.2 freeze); BullMQ is down
  with it anyway. A readable but empty registry goes to FLOOR (1) through the hysteresis: never 0, which would stop
  every worker silently. With failover on, OpenRouter's 120/min ceiling is the minimum path; turns beyond G wait in
  BullMQ, durably.
- **Misconfiguration guard (`hold_suspect`):** S_live = 0 while registry records were **rejected** by the record
  policy (allowlist, loopback, duplicate origin), or while live records exist **only in other pools** (a wrong
  `PTR_CAPACITY_POOL` / `PTR_GATEWAY_POOL`), is treated as a configuration error: G is held, not decayed to FLOOR, and a
  `WARNING capacity: S_live=0 but …` line names the reasons and what to check for each (`not_allowed` →
  `PTR_GATEWAY_UPSTREAM_ALLOW`, which must equal the gateways' value; `not_loopback`; `invalid_record`;
  `pool_mismatch`). The registry prefix is never the suspect here: the records were found under it. On a **first
  start** (G unset) the same guard leaves G unset instead of writing FLOOR (`leaving G unset` in the warning), so a typo
  cannot throttle every worker to one turn; it stays unset for as long as the configuration looks wrong. A set G is
  held for at most 5 minutes; after that the planner follows the registry again (an empty pool then goes to FLOOR). Rejected records next to live ones are counted
  (`rejected` in the status) and logged once (`capacity: N registry record(s) rejected (…)`).
- **Status:** `ptr:llm:cap` HASH {target, sLive, q, qSource (registry | env), g, active, wait, computedAt, reason, writes,
  leader, registryStale, workerShortage} (expires 60 s after the last tick), and one dispatcher stderr line whenever G,
  Q or registry staleness changes: `capacity G=30 target=30 S_live=24 Q=256 active=… wait=… reason=increase` (`Q=512(gateways)`
  when Q comes from the gateway registry). `reason` is one of init, increase,
  hold, decrease_pending, decrease, draining, registry_stale, hold_suspect.
- **worker_shortage:** `wait > 0` while `active < G` for 15 s logs `WARNING worker_shortage …` once per episode (add
  workers or raise `PTR_WORKER_CONCURRENCY`).
- **capacity_floor:** G at FLOOR while turns wait for 15 s logs `WARNING capacity_floor …` once per episode: no upstream
  capacity is registered for the pool.
- **Startup errors:** a controller configuration error (bad env, unknown mode) is logged as `WARNING capacity
  controller disabled (CODE) …` and the dispatcher runs without it: turn dispatch, lease recovery and the outbox never
  depend on the controller.
- **Known limits:** a crashed worker's job holds its active slot until BullMQ's stall check (about 30–60 s); one queue
  = one pool (several pools need one turn queue each).
- **Headroom:** part of a turn runs outside the gateway (Jev intent p50 0.39 s × 0.594 calls/turn, the safety filter
  about 0.4 s when on; the measured workload), so the GPUs stay busy only if G ≥ S_live / share, i.e. headroom ≈ 1/share − 1, where
  share = time in gateway calls / turn time. From the measured parts: share ≈ 1.0 with both Jev features off (the
  fake-model path's turn e2e p50 1.94 s vs gateway call p50 1.99 s), ≈ 0.86 with intent only and ≈ 0.69 with intent +
  safety at an E4B call of 1.4 s (the measured safety step), so headroom 0 – 0.45. The default 0.25 stays; set 0.5 with both Jev features
  on, and re-measure with real engines (S8). Too much headroom only lengthens gateway waits (bounded by Q); too little
  leaves GPU slots idle (the acceptance harness shows it: share 0.6, G = 15 keeps about 9 of 12 slots busy).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_CAPACITY_CONTROLLER` | `on` with `PTR_GATEWAY_DISCOVERY=redis`, else `off` | `on`; `off` (the dispatcher removes any G at startup, so switching the controller off never leaves a stale cap; `clear`, the earlier name, means the same); `keep` (never touch G, e.g. a G set by hand). All dispatchers on one queue must use the same mode. |
| `PTR_CAPACITY_POOL` | `PTR_GATEWAY_POOL`, else `PTR_SELFHOSTED_MODEL` | pool whose registry records count (required when on) |
| `PTR_CAPACITY_HEADROOM` | 0.25 (0–4) | see above |
| `PTR_CAPACITY_FLOOR` | 1 (1–4096) | lowest G (user decision; the design draft had 4) |
| `PTR_CAPACITY_INTERVAL_MS` | 5000 (500–60000) | tick |
| `PTR_GATEWAY_MAX_QUEUE` | 256 | Q when no gateway is registered (the same value the gateway uses) |
| `PTR_GATEWAY_ALLOW` | `127.0.0.1:56460-56469` | gateway records that count toward Q (the workers' rule) |
| `PTR_TURN_QUEUE`, `PTR_REGISTRY_PREFIX`, `PTR_GATEWAY_UPSTREAM_ALLOW` | as elsewhere | queue to control, registry namespace, record allowlist |

Static discovery (env or file) keeps the controller off by default: G would only mirror a fixed file, and the startup
warning stays the guard.

**Workers** read G and whether a controller leader is alive (`ptr:llm:cap:leader`) once at startup. On a worker only an
explicit `PTR_CAPACITY_CONTROLLER` counts. Workers now often set `PTR_GATEWAY_DISCOVERY=redis` to read the gateway
registry (S6), which derives `on`, but that says nothing about a controller. So without an explicit setting the line
follows the leader lock and never warns: a running leader is reported as `capacity controller running elsewhere: G=…`,
a set G without a leader as an info line. Warnings come only from an explicit setting that disagrees:
`PTR_CAPACITY_CONTROLLER=off|keep` while a leader runs (mixed modes), or `off` while a G is still set. The S1
Σ-concurrency check against the gateways' `/metrics` runs unless `PTR_CAPACITY_CONTROLLER=on` is set here or a leader
is running.

**Mode changes and rolling restarts:** every dispatcher sharing a queue should use the same mode. During a rolling
restart they briefly differ, which is safe:
- off → on: the first `on` dispatcher becomes leader and sets G on its first tick; old `off` dispatchers only act at
  their own startup.
- on → off: an `off` dispatcher removes G at startup only when no leader is alive. While an `on` dispatcher still holds
  the lease it warns once and re-checks every lease interval (max(15 s, 3 × `PTR_CAPACITY_INTERVAL_MS`)), removing G as
  soon as the last `on` dispatcher has stopped and its lease expired. Until then the old leader keeps G current. A check
  that fails because Redis is unavailable is logged and repeated one lease interval later.
- `keep` never touches G; use it for a G set by hand (`off` would remove it).

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

### Upstream pools and the GPU server registry (stage S2)

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
- **redis** (`PTR_GATEWAY_DISCOVERY=redis`, `PTR_REDIS_URL`): the registry below. The file (or else
  `PTR_SELFHOSTED_BASE_URL` as one entry `selfhosted`) is only the seed: the membership until the registry has been
  read once (Redis unreachable at startup). On that first read the seed entries the registry lacks get the TTL grace
  (their agents may not have re-published yet); after it the registry is the only authority, so a drained or removed
  upstream never comes back from the seed, and the seed's id never doubles an engine that its agent registers under
  another id (one id per origin).

Registry layout (`packages/messaging/src/upstream-registry.ts`, prefix `PTR_REGISTRY_PREFIX`, default `ptr:llm`; it must
end in `:llm`, so it can never touch `ptr:turns:*` or `ptr:events:*`):

```text
ptr:llm:up:<pool>:<id>   HASH {pool,id,baseUrl,maxSeqs,kvCapacityTokens,weight,state(active|draining),epoch,seq}  PEXPIRE 10000
ptr:llm:ups:<pool>       ZSET member=<id> score=expiresAtMs   (read with ZRANGEBYSCORE now +inf; writers trim expired entries)
ptr:llm:reg:ver          INCR on every new record, field change, drain or removal
ptr:llm:reg              PUB/SUB, empty message = "poll now"
ptr:llm:drain:<pool>:<id> STRING epoch, PX the record's drainMaxMs + TTL: the drain tombstone
ptr:llm:cap / :cap:leader HASH status / leader lock of the capacity controller (S2b)
```

Expiry scores and the live listing use the Redis server clock (`TIME` inside the scripts). Pool names and ids are
validated before any key or SCAN pattern is built. The gateway and the agent import `@ptr/messaging/registry` (registry +
guarded Redis connection), which never loads BullMQ.

Writes are Lua scripts (atomic): a heartbeat carries the publisher's state and refreshes TTL, index and `seq`; it never
turns a `draining` record of the same epoch back to `active`, and a draining agent's heartbeat recreates an expired
record as draining; a new id or epoch, or a changed field, bumps the version and publishes. The optional fields
`drainMaxMs` and `prefillTokensPerSec` are removed when a heartbeat no longer carries them (also a change), so a
withdrawn R_u calibration cannot linger; gateways compare both fields too, so a changed R_u applies on the next poll. Marking a record draining
also writes a **drain tombstone** for its epoch: if the record expires before its agent deletes it (agent crash, Redis
blip) and an agent comes back on the same engine (same epoch), its heartbeat recreates the record draining and the
agent finishes the drain, so a drain started from the CLI cannot be undone by an expiry. A new epoch (new engine
process) is not affected. The tombstone lives the publishing agent's own drain bound (`drainMaxMs`, which every agent
puts in its record) + the TTL, or the CLI's `PTR_UPSTREAM_DRAIN_MAX_MS` + TTL for a record without one. Removing the
record **with its epoch** (the agent finishing the drain) deletes the tombstone too, so a later start of the same engine
is active; a forced `deregister` (no epoch) leaves it, so a crashed agent still resumes the drain.

Gateway behaviour (`RedisRegistrySource` + `UpstreamPool`):
- **Discovery:** polls every `PTR_GATEWAY_REGISTRY_POLL_MS` (2000) and at once on a nudge; lost nudges are covered by
  the next poll. A new id, or a new **epoch** for a known id (the engine restarted), is a new upstream: fresh breaker,
  slow start. Upstreams present when the gateway starts begin at full capacity.
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
(`not_loopback`, `not_allowed`, `invalid_record`, `pool_mismatch`, and `duplicate_url`: a second id on an origin
(host:port) already listed, which would double that engine's `maxSeqs`; the lower id wins); they are never logged with their URL. File and env
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
| (check) | — | with a pool, `PTR_GATEWAY_UPSTREAM_TIMEOUT_MS` must exceed `PTR_GATEWAY_QUEUE_TIMEOUT_MS`, else startup fails: the upstream deadline starts once a request is admitted and the wait for a free upstream (up to the queue timeout) runs inside it, so a shorter deadline would turn that wait into an unmarked 504 |
| `PTR_REGISTRY_PREFIX` | `ptr:llm` | registry namespace (`…:llm`; tests use `ptrtest:<run>:llm`) |
| `PTR_UPSTREAM_HEARTBEAT_MS` / `PTR_UPSTREAM_TTL_MS` | 2000 / 10000 | agent heartbeat and record TTL (TTL ≥ 2 × heartbeat) |
| `PTR_UPSTREAM_DRAIN_SETTLE_MS` | 4000 | agent drain: minimum wait before checking the engine is idle (two gateway polls) |
| `PTR_UPSTREAM_DRAIN_MAX_MS` | 120000 | agent drain: upper bound before the record is deleted anyway; the CLI's drain tombstone lives this + TTL |
| `PTR_UPSTREAM_HEALTH_TIMEOUT_MS` | 2500 (100–30000, and < TTL − heartbeat) | agent: timeout of one engine `/health` check (a busy engine may answer slowly); it must leave a heartbeat inside the TTL |

`/metrics` with a pool adds `pool`: `members` {active, ramping, draining, gone, breakerOpen}, `waiting`,
`retriedOnOtherPrimary`, `queueTimeouts` (marked 503s because no upstream slot freed in time; a subset of
`rejected.queueTimeout`, which also counts the admission queue), `events` {added, removed, replaced, invalid}, `upstreams[]` {id, epoch, state, inFlight, limit,
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
  move to another upstream, the breaker opens (within a few calls), and the record expires ≤ 10 s after the agent's
  last heartbeat, i.e. a gateway drops it ≤ 12 s (TTL + one poll) after the crash.
- **Agent crash only:** the engine keeps serving its in-flight calls but takes no new ones once the record expires
  (capacity drops); restart the agent and it returns with the same epoch (slow start again).
- **Redis outage:** nothing to do; check `registry.stale` and that `members` did not drop after it came back.
- **Rejected records:** `registry.rejected` rising means someone registered a URL outside the allowlist; `list` shows it.

### Credit admission, central queue and routing (–§4, stage S3)

A pool from a file or the registry **owns admission**: the gateway's own limiter (`PTR_GATEWAY_MAX_CONCURRENCY`) is
bypassed, requests wait in the pool's queue, and an upstream gets a request only when it has credit (late binding).
The env-only single upstream and the failover wrapper keep the old limiter, so N = 1 behaves exactly as before.

**Estimate per request:** T̂ = ceil(content bytes / `PTR_GATEWAY_BYTES_PER_TOKEN` (3.9)), conservative for ~90% of
requests; M = `max_tokens` (else 512). G (the policy block) is the most common msg0 seen (bounded table of 16, counts
decayed with a half-life of 256 requests), so one odd first request or a short batch with another system message
cannot set it, while a policy-prompt deploy re-learns G after about 256 requests (fewer when the old block was rare); a request whose msg0 is that block has G cached (uncached = T̂ − G), any other
has nothing cached (uncached = T̂). G is resident once per server and capped at half the KV budget. Since S5 the
cached share on an upstream is the larger of that and the request's match in the upstream's prefix table (next sections).

**Credit `fits_u(r)`** (all must hold; the same check for every routing policy):
1. active (not draining), breaker closed (with no closed member and no secondary, open ones are still used);
2. sequences: N_u + 1 ≤ S_u^eff (maxSeqs, ramped by slow start);
3. KV, when `kvCapacityTokens` is known: Kres_u + (T̂ − G) + M ≤ κ·K_u − G (`PTR_GATEWAY_KV_OVERCOMMIT` κ = 0.9);
   an idle upstream always takes one request so nothing waits forever;
4. prefill, only when `prefillTokensPerSec` (R_u) is calibrated (record/file field; unset by default): U_u = 0 or
   U_u + (T̂ − G) ≤ R_u · T_max (`PTR_GATEWAY_TTFT_PENALTY_MS` 1000).

5. engine telemetry, while fresh (S4, next section): KV usage < `PTR_GATEWAY_ENGINE_KV_HIGH` and waiting ≤
   `PTR_GATEWAY_ENGINE_WAITING_MAX`, except that an upstream with nothing of ours in flight still takes one request.

The ledger: N (in flight), Kres (reserved KV, released at the end), U (uncached prompt tokens, released at the first
body chunk).

**Queue:** bands from `X-PTR-Priority` (1 = a follow-up model call of a running turn, 0 = a turn's first call, the
default, −1 = batch), strictly ordered (a waiting higher band holds back lower ones). Within a band FIFO, or deficit
round robin per `X-PTR-Flow` (hex) with `PTR_GATEWAY_FAIRNESS=drr` and quantum `PTR_GATEWAY_DRR_QUANTUM_TOKENS` (4096).
Up to `PTR_GATEWAY_LOOKAHEAD` (8) requests that do not fit are skipped so later ones can pass; a skipped request older
than `PTR_GATEWAY_STARVATION_MS` (2000) stops its band instead (no overtaking forever). The loop runs on every enqueue,
completion, first chunk, membership or breaker change, and every 250 ms while requests wait.

**Selection** (`PTR_GATEWAY_ROUTING`) among the fitting upstreams:
- `round_robin`: rotate;
- `least_inflight`: fewest in flight, ties rotate (the S2 rule);
- `scored` (§4.3): least cost (U + (1 − h_u)·T̂) / (R_u · T_max) + (N + 1) / S_eff (h_u·T̂ = G, or the prefix-table
  match when longer, S5), with R_u = weight × 10000 until calibrated; ties go to the rendezvous-hash order of
  hash(policy ‖ persona). Cache affinity (`PTR_GATEWAY_AFFINITY`, S5) can come before any of the three.

The default is `least_inflight`; `scored` stays selectable. It has not met the §9.1 acceptance bar (fixed before the
first run: heterogeneous W2 and W3, one of {max throughput with TTFT p95 ≤ 2 s, TTFT p95 at the knee} ≥ 10% better and
the other ≤ 5% worse; homogeneous W1 both ≤ 5% worse), so there is no evidence to change the default:

- **S3 run** (single seed, fixed rate grid, partly overloaded): heterogeneous W2 had no rate meeting the 2 s TTFT p95
  for either policy, so that half of the bar could not be evaluated and the other did not reach 10%; in heterogeneous
  W3 `scored` was worse (TTFT p95 894 vs 667 ms at the nominal rate, throughput −2.3%). Homogeneous W1 within 5%.
- **S4 re-run with the revised method** (below; `reports/routing-compare-muzx6c629836.json`, merged from three runs
  made in parallel as three processes on one 12-core host, so they shared CPU; knees 7.5 / 6 / 9 req/s for homogeneous
  W1 / heterogeneous W2 / W3, each from a single seed-0 sweep (the script now takes the median over 3 seeds); 3 seeds;
  means with 95% t intervals, descriptive only (3 seeds, no significance test); paired = per-seed relative
  difference, positive = `scored` better; re-evaluated with the ∞ rule below, verdict unchanged):

| Combination | Max throughput with TTFT p95 ≤ 2 s (req/s): scored vs least_inflight | TTFT p95 at the knee (ms) | Verdict |
| --- | --- | --- | --- |
| heterogeneous W2 | 4.11 vs 4.11 (both [−4.8, 13.0]; per seed 5.87 / 0 / 6.47 for both) → +0% | 2672 vs 2801 → +4.6%; paired −5.1% [−58%, +48%] | not ≥ 10% better: FAIL |
| heterogeneous W3 | 2.36 vs 4.91 (per seed 0 / 7.07 / 0 vs 0 / 7.07 / 7.67) → −52% | ∞ for both in seed 1 → no comparison; paired (2 seeds) −0.6% | FAIL (worse) |
| homogeneous W1 | 8.49 vs 8.49 → +0% | 1245 vs 1444 → +13.8%; paired +15.1% [−5.3%, +35.4%] | not worse: PASS |

  How to read it: in an open loop with no failures the completed throughput equals the offered rate for every policy,
  so the throughput metric only moves when a policy's TTFT p95 crosses 2 s at some grid point; with 15 s windows the
  seed-to-seed spread is far larger than the policy difference (heterogeneous W2 TTFT p95 at the knee: 929–5603 ms
  across seeds; between the two policies on the same seed and rate the median gap is 124 ms, under 300 ms in 10 of 15 cells), and a single crossing moves a seed's
  value by a whole grid step or to 0. The W3 "−52%" is one seed where `scored` crossed 2 s at 0.8 × knee (2035 vs
  1531 ms). Every interval includes 0, so the data show no reliable difference in either direction on the
  heterogeneous configs. The one consistent signal is homogeneous W1, where `scored` had the lower TTFT p95 in 11 of
  15 seed × rate cells (it also counts uncached prefill tokens, which least in-flight ignores), not part of the bar.
  Re-run after the prefix table and affinity (S5) and real-engine R_u / S_u calibration (S8), with longer windows or
  more seeds, before revisiting the default.

**Comparison method** (`scripts/routing-compare.ts`, revised in S4): per (config, workload) a knee sweep with
`least_inflight` on `--knee-seeds` seeds (default 3; per seed the highest rate of the monotone prefix with TTFT p95
≤ 2 s; the grid uses their median); a grid of knee ×
0.8/0.9/1/1.1/1.2; 3 seeds per point, every random choice (arrival times, token lengths, outputs, flows) from the
seeded RNG; open-loop arrivals by default (W3 turns scheduled up front every 2.5 s, sessions already running at t = 0),
so every policy sees byte-identical requests; order seed → rate → policy; after the last arrival every request is
awaited (60 s client timeout) and requests still open are counted as unfinished; TTFT p95 counts failed, rejected and
unfinished requests as ∞. In the acceptance an infinite mean TTFT p95 (any seed over 5% failures) is a loss: only
`scored` ∞ → gain −∞ (fails both "better" and "not worse"), only `least_inflight` ∞ → +∞, both → no comparison; gains
are written as the strings "Infinity" / "-Infinity" in the JSON. `--merge=a.json,b.json` combines runs made in
parallel into one verdict; the same point twice is an error (`MERGE_DUPLICATE_POINT`), and so are runs whose stored
`method` differs in anything that shapes points or knees — grid, seeds, `kneeSeeds`, windows, drain, arrivals, SLO, knee
sweep, prompt layout (`MERGE_METHOD_MISMATCH`; reports written before `kneeSeeds` was stored never merge with new ones).
`--policies` also takes `<policy>+affinity` variants (S5).

Limits: `drr` needs `X-PTR-Flow` (the worker does not send one yet, so all traffic is one flow = FIFO with LOOKAHEAD);
for non-streaming requests the first chunk is the whole reply, so U stays reserved to the end; requests waiting on a
half-open probe (with a secondary) are not counted against the queue bound; a waiting band-1 retry that excludes the
only upstream with credit still holds back lower bands (strict bands, as designed).

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

Comparison harness: `scripts/fake-engine.ts` (FakeEngineUpstream: slots, prefill rate on one lane, batch-dependent
TPOT, KV capacity, prefix LRU over message-chain hashes, vLLM-named `/metrics`, `/health`, telemetry controls) and
`scripts/routing-compare.ts` (W1–W4 × homogeneous / heterogeneous × the three policies, method above, report in
`reports/routing-compare-<run>.json`).

### Engine telemetry, slow start after recovery, restarts (stage S4)

Pools only (file or registry; the env-only single upstream and the failover wrapper are unchanged).

**Telemetry polling (off by default):** `PTR_GATEWAY_METRICS_INTERVAL_MS` defaults to 0 until the metric names and
meanings are verified on the real engines (S8); with e.g. 1000 the gateway reads each member's `GET {origin}/metrics`
at that interval (one poll times out after `PTR_GATEWAY_METRICS_TIMEOUT_MS`, default min(500 ms, interval), overlapping polls collapse, a body over 1 MiB is
dropped as a failed poll). Parsed (vLLM v1 names,
checked against vLLM's metrics docs and `v1/metrics/loggers.py` upstream, **not against the deployed build**; design
[확인 필요]):

| Name | Use |
| --- | --- |
| `vllm:num_requests_waiting`, `vllm:num_requests_running` (gauges, summed over label sets) | filter, credit_model_miss, metrics |
| `vllm:kv_cache_usage_perc` (gauge 0–1; older builds `vllm:gpu_cache_usage_perc`; highest label set) | filter |
| `vllm:prefix_cache_queries[_total]`, `vllm:prefix_cache_hits[_total]` (counters; older `vllm:gpu_prefix_cache_*`) | `prefixHitRate` between two polls (metrics only; vLLM counts tokens) |
| `process_start_time_seconds` (prometheus_client process collector; may be absent) | engine restart detection |

Parsing skips comments, NaN and ±Inf, takes the first value token (a timestamp or an OpenMetrics exemplar after it is
ignored) and reads label values containing `}` or escaped quotes. Impossible values (KV usage outside [0, 1], negative
counts) are treated as unknown, never as a block, and counted (`telemetry.implausible`).

**Filter only, never a score input** (§4.4: delayed telemetry in a closed loop oscillates). While the last good poll is
at most 3 × the interval old, a member whose engine reports KV usage ≥ `PTR_GATEWAY_ENGINE_KV_HIGH` (0.95) or waiting >
`PTR_GATEWAY_ENGINE_WAITING_MAX` (2) gets no new request: the request is treated like "no credit" and waits in the
queue (no failover, no spillover); it is re-dispatched as soon as a poll clears the condition. **Fallback (agent
decision, beyond the design text):** selection takes the fitting non-blocked members first; only when none fits does a
blocked member with nothing of this gateway's in flight take one request, like the KV credit's idle rule. Without it, a
misread or stuck metric (the names and semantics are unverified on the deployed vLLM) would remove an idle server
completely, and with several gateways another gateway's load could starve this one; with it the worst case is one call
at a time on that server. The rule is per gateway: with k gateways a blocked engine may get up to k such calls. Older
than 3 × the interval (or never read, or `/metrics` not 200) the filter is ignored and only the gateway's ledger decides
(fail-open, `telemetry.stale`). A member blocked for 10 polls in a row while its engine runs fewer than maxSeqs / 4
sequences logs `WARNING gateway upstream <id>: blocked by engine telemetry …` once per episode
(`telemetry.suspectBlocked`): the metric probably does not mean what the filter assumes.

**credit_model_miss:** waiting > 0 on 3 fresh polls in a row counts one episode per upstream (`telemetry.creditModelMiss`):
the gateway's credits (`maxSeqs`, KV) let more in than the engine runs at once, or other gateways (or other clients)
also load that engine: the engine's queue does not say whose requests wait. Nothing is corrected automatically
(feedback oscillation); lower that upstream's `maxSeqs` or check `kvCapacityTokens`.

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

**Keep-alive pinning (limit of the "several processes" check):** the gateway reads `/metrics` and sends calls through
Node's default fetch agent, which keeps connections alive (undici closes an idle one after about 4 s unless the server
says otherwise). With several processes behind one port (e.g. `SO_REUSEPORT` API servers) the kernel picks the
process per **connection**, not per request, so a 1 s poll that keeps reusing one connection keeps reading one
process. The second process's start time then shows only when that connection is replaced (idle timeout, a reset, an
engine restart), so detection may turn off late, or not at all, and a restart of the process the poller does not see
is caught by the breaker only. Calls are pinned the same way (by connection, not by the gateway's choice of upstream
id), which is harmless for routing because the API server processes share one engine and one prefix cache.

**Primary-to-primary retry and failover (§5, verified):** retried on another member only for connection-phase errors
(`UpstreamConnectError.certain`) and, with `PTR_GATEWAY_FAILOVER_ON_CLOSE=true`, a close before any response byte; at
most `PTR_GATEWAY_PRIMARY_ATTEMPTS` (2) members per request; the reservation moves with it (released on the failed
member, a new one on the next). Timeouts, HTTP errors and streams cut mid-response are not moved. The secondary is used
only when no primary can take the request: every member's breaker open (`breaker_open`), none active (`no_upstream`,
draining members included), or every tried member failed to connect. Busy members (no credit, or telemetry-blocked) are
waited for, never failed over. One nuance the design text leaves open: after a failed connect, if the other members
stay busy until the queue timeout, the request goes to the secondary (or the connect error surfaces); the marked
"nothing was sent" 503 is not used because a close before response may have reached the engine.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_METRICS_INTERVAL_MS` | 0 = off (else 100–60000, e.g. 1000) | telemetry poll interval; stale after 3 ×; off until verified on real engines (S8) |
| `PTR_GATEWAY_METRICS_TIMEOUT_MS` | 500 (the interval when shorter; 50–60000, at most 3 × the interval when telemetry is on) | one poll's timeout. Use 2000 for engines behind an SSH tunnel: S8 measured 0.6–1.2 s for `/metrics` on a new tunnel connection (3 ms on the host), so 500 ms polls failed and the member went stale; with 2000 the real-engine acceptance passed |
| `PTR_GATEWAY_ENGINE_KV_HIGH` | 0.95 (0.1–1) | KV usage at or above it filters a member out |
| `PTR_GATEWAY_ENGINE_WAITING_MAX` | 2 (0–100000) | engine waiting above it filters a member out |

**Metrics:** per upstream `rampReason` and `telemetry` {stale, ageMs, staleEpisodes, failedPolls, running, waiting,
kvUsage, prefixHitRate, blocked, blockedPolls, creditModelMiss, waitingStreak, restarts, restartDetectionDisabled, implausible, suspectBlocked}
(null when off); `members`
adds `telemetryBlocked` and `telemetryStale`; `events.restarted`; pool `telemetry` {intervalMs, kvHigh, waitingMax} or
null.

**Acceptance (fake engines, `scripts/telemetry-acceptance.ts`, telemetry explicitly on at 1000 ms, open-loop W1 at
8 req/s for 15 s, one run each; `reports/telemetry-acceptance-muzxeyw8c96c.json`):**

| Scenario | Result |
| --- | --- |
| A1 b reports KV 0.97 (engine actually idle) | telemetry on: b 16 / a 105 dispatches (b only when a had no room), 0 failed, TTFT p95 8.6 s, one suspect-block warning; off: b 57 / a 64, TTFT p95 1.6 s. The filter works; a false high report concentrates load on a (without the fallback an earlier run had 15 queue timeouts) |
| A1b b has 3 engine slots but maxSeqs 12 | on: b 35 dispatches, TTFT p95 5.7 s, credit_model_miss 2; off: b 41, TTFT p95 7.6 s. Peak engine waiting 9 in both: with a 1 s poll the gateway overfills b before the first report. Small gain, single run |
| A2 b blocked, then its /metrics hangs at 5 s | stale 2.8 s after the hang (3 × interval minus the poll phase); b dispatches 2 before 5 s, 1 until stale, 47 after; 0 failed |
| A3 b's engine down 2–5 s (telemetry off) | breaker open at 2.2 s, closed at 5.2 s (3 s cooldown), b's limit 1 → 2 → 5 → 8 → 12 at +0/2.5/5/7.5/10 s (10 s ramp), at most 2 in flight in the first 2 s; 5 failed = the streams on b cut when it stopped (the worker retries those) |
| A4 b's engine restarts at 5 s (same port and epoch) | restart confirmed at 6.8 s (two polls), b's limit 1 then 5 after 5 s, breaker closed, `events.restarted` 1; 4 failed = streams cut by the restart |

### Prefix table, cache affinity, routing log and §8 metrics (–4.3, §8, stage S5)

Pools only (file or registry).

**Prefix table (always kept).** Every request carries its message-boundary chain H_k = sha256(salt ‖ message 1 ‖ … ‖
message k) (one running hash, each message's role and content length-prefixed, first 128 bits; the salt is random per
gateway process, so the in-memory hashes cannot be checked against guessed content) for k = 1..m−1 (the last message,
the new user turn, is never a cached prefix), each with the
cumulative token estimate ceil(bytes / `PTR_GATEWAY_BYTES_PER_TOKEN`), the same rule as T̂ and G. Each upstream has a
table of the chains the gateway has seen it serve: a request's chain is recorded at its **first 2xx body chunk** (its
prefill is done, so the engine holds it; refused, failed and non-2xx calls are not recorded), tail first so that a
request's longest prefixes are the least recently seen and evicted first (vLLM frees a sequence's tail blocks first).
Entries expire after `PTR_GATEWAY_PREFIX_TTL_MS` (120000, Dynamo's approximate-mode default). Size: the own tokens of
the resident entries (H_k counts only message k, so a shared policy block counts once) stay within the upstream's
`kvCapacityTokens`, like the engine's prefix cache, which lives in the KV pool; and at most 4096 entries in any case. **Agent decision (deviation):** the design's bound "K_u / mean request tokens × 4 entries" counts requests,
but the table stores one entry per message; a token bound measures the same thing at that granularity. A table is
emptied when its upstream's breaker opens, when an engine restart is detected, and once when restart detection turns
off (several processes on the port, one may be a fresh engine); a new member (new id, epoch or address) starts empty. h_u(r) = the cumulative tokens of the longest fresh H_k in u's table / T̂.

**What the table changes (only with affinity on):** the cached share of a request on upstream u becomes
max(policy-block share G, its table match on u) for **prefill only**: the prefill ledger U, the calibrated prefill gate
and the §4.3 cost (and so `scored`'s choice) use (1 − h_u)·T̂. The **KV reservation stays (T̂ − G) + M**: a prefix hit
saves prefill compute, but KV only for blocks that a *running* request holds, and a session's history is held by none
(one turn per session at a time), so vLLM allocates those blocks again (its free cached blocks move into use). The
policy block is the one prefix that running requests always share. With affinity off the table is not consulted at all
(matched = 0), so credit, `scored` cost and selection are exactly as in S4; the table is still kept, but only its
size metrics fill in (`prefix.entries`, `prefix.tokens`, `prefix.cleared`): `extraHits` and the `affinity` outcome
counters need a lookup and stay 0, so with affinity off the metrics do not show what affinity would have picked.

**Cache affinity (`PTR_GATEWAY_AFFINITY=off|on`, default `off`).** Among the candidates whose credit fits:
g_u = matched_u − G (cached tokens beyond the policy block, which every warm server holds). The member with the largest
g (the cheapest of those, then the rendezvous order) is picked if g ≥ `PTR_GATEWAY_AFFINITY_MIN_TOKENS` (256) and its
cost_u ≤ min cost + `PTR_GATEWAY_AFFINITY_SLACK` (0.5), with cost_u = (U_u + (1 − h_u)·T̂) / (R_u·T_max) + (N_u + 1) /
S_eff (R_u = weight × 10000 until calibrated). Otherwise the configured `PTR_GATEWAY_ROUTING` decides. **Composition
(agent decision):** the slack is measured with the §4.3 cost whatever the routing policy, so its meaning ("at most
0.5 more occupancy / prefill pressure than the least loaded candidate") is the same for every policy; the fallback is
the policy itself — `least_inflight` (fewest in flight; with affinity on its ties go to the rendezvous order of
hash(policy ‖ persona) instead of rotating, so a persona's cold-start requests gather on one server), `scored` (least
cost, rendezvous ties) or `round_robin`. With today's prompts persona-only matches give g ≈ 220 < 256: only a
session's own history makes a server sticky, as the design intends.

**Routing decision log** (sampled, `PTR_GATEWAY_ROUTE_LOG_SAMPLE`, default 0.01, 0 = off; no message text, the
request key only as sha256[:12], member ids not URLs; to the gateway's stderr):

```text
route rk=3f2a9c0d1b7e pool=gemma-4-e4b-fp8 band=0 est=1912 h={a:0.71,b:0.59} cost={a:0.42,b:0.3} pick=a reason=affinity affinity=picked wait=12ms
```

`rk` is salted per process (comparable within one gateway's log, not across processes). `reason`: `affinity`, `load`
(the policy's pick), `tie` (the policy's tie-break), `retry` (another primary after a
connection failure), `failover` (`pick=secondary`, h and cost empty); `affinity=` (picked | brokenBySlack | none) only
when affinity is on; h and cost list the candidates that fit.

**Metrics (§8)** added to `pool` in `/metrics`: per upstream `ttftMs` and `e2eMs` {p50, p95} (2xx calls, from dispatch
to the first body chunk / to the end of a completed stream; a stream the caller closed early counts for TTFT only), `estOverActualTokens` {p50, p95, n} (T̂ / `usage.prompt_tokens` read from the
end of the answer; the worker asks for usage with `stream_options.include_usage`), `prefix` {entries, tokens, cleared,
extraHits (affinity on: dispatches whose table match exceeded G)}; per pool `latency` {ttftMs, e2eMs} (from arrival at the pool,
queue wait included), `affinity` {mode, minTokens, slack, picked, brokenBySlack, none} (counted only when on),
`prefixTtlMs`. Already present and named differently from §8: `retriedOnOtherPrimary` (= primaryRetries),
`failover.failovers` by reason, `queue.queued` by band, `queue.rejected` by reason (`draining` since S6),
`seqUtil`, `kvUtil`, `telemetry`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_AFFINITY` | `off` | `on` = cache affinity before the routing policy |
| `PTR_GATEWAY_AFFINITY_MIN_TOKENS` | 256 (0–1000000) | g needed to stick |
| `PTR_GATEWAY_AFFINITY_SLACK` | 0.5 (0–100) | cost over the cheapest candidate that still sticks |
| `PTR_GATEWAY_PREFIX_TTL_MS` | 120000 (1000–3600000) | prefix-table entry lifetime |
| `PTR_GATEWAY_ROUTE_LOG_SAMPLE` | 0.01 (0–1) | share of routing decisions logged |

**Affinity evaluation — pre-registered before the first run** (`scripts/routing-compare.ts`, `affinityAcceptance`):
`least_inflight+affinity` (256 / 0.5) against `least_inflight` (the default), homogeneous and heterogeneous configs,
W3 and W1, the S4 method (median knee of `least_inflight` over 3 knee seeds, grid 0.8–1.2 × knee, open loop, 15 s
windows, failures = ∞) with **5 seeds**. Affinity becomes the default only if **all** hold, on seed means:
W3 on both configs — TTFT p95 at the knee ≥ 10% better and max throughput with TTFT p95 ≤ 2 s ≤ 5% worse; W1 on both
configs — both ≤ 5% worse. Reported next to it, not part of the bar: TTFT p50, engine prefix hit rate (requests and
tokens), dispatch imbalance (max / mean per upstream), affinity outcomes. Workload change for this run: W3 requests put
the agent state after the history (the approved S7 P2 layout), so a session's turns share a prefix that grows with
its history; with the layout of that time (state before the history) the shared prefix stopped at the persona and
affinity had nothing to act on. S7 (below) made the app use that layout. The fake engine now models vLLM's KV: a request holds prompt − (prefix shared with running
requests) + output, so a cached history saves prefill but not KV, and cached prefixes live in the free KV (capacity −
KV in use, so load evicts them; the old model was 2000 entries and subtracted every cached token from KV). It counts
hit tokens. **Fixed after the runs below (S6, Part A):** the shared blocks were charged to the request that allocated
them only, so when that request ended first its sharer's history dropped out of the KV in use (under-counted KV:
the fake engine admitted somewhat more than vLLM would under sharing). Shared blocks are now counted once and freed by
their last running holder. Every run below was affected (all requests share at least the policy block), both arms
alike: the fake engine's own KV limit was looser than intended, which matters only where that limit binds (KV-bound
configs near the knee). The runs were not repeated: the bar failed by a wide margin, and the fix tightens the engine
for both arms, not one. The fake cache has the gateway table's message-boundary granularity and sees exactly the gateway's
requests, so these runs do not exercise table staleness (other clients, engine eviction policy, real tokenization). Expectation from the design (§0, §1.2): small, because the
policy block (~60% of a prompt) is cached on every server whatever the routing.

**Result.** Two runs; the second is the one that counts for W3. Both: 5 seeds per point, knees from 3 seeds, seed
means with 95% t intervals, gains positive = affinity better, paired = mean of the per-seed relative differences,
runs made in parallel (one process per config × workload, one 12-core host, shared CPU).

1. `reports/routing-compare-muzzck15899f.json` (all four combinations) used the first S5 code: the KV reservation
   subtracted the table match and the fake engine subtracted every cached token from KV. Both overstated what a
   history hit saves (review finding; fixed above).
2. `reports/routing-compare-mv00vpea57e4.json` (W3 only, after the fix: KV = (T̂ − G) + M, table off when affinity is
   off, fake engine KV = prompt − prefix shared with running requests + output). W1 was not re-run: it has no history,
   so affinity changes only its tie-break, and the bar fails on W3 whatever W1 shows.

| Combination | Knee (req/s; per seed) | Max throughput with TTFT p95 ≤ 2 s: on vs off | TTFT p95 at the knee (ms): on vs off | Bar |
| --- | --- | --- | --- | --- |
| homogeneous W3 (run 2) | 10.5 (15, 10.5, 10.5) | 11.99 vs 11.99 [10.84, 13.14] → 0% | 1255 [118, 2392] vs 1263 [169, 2357] → +0.6%; paired +7.3% [−15.2, +29.7] | needs ≥ 10%: **FAIL** |
| heterogeneous W3 (run 2) | 7 (9, 5, 7) | 7.47 [6.45, 8.49] vs 7.25 [6.33, 8.17] → +2.9% | 1838 [−342, 4018] vs 1893 [−215, 4001] → +2.9%; paired +8.4% [−13.7, +30.5] | needs ≥ 10%: **FAIL** |
| homogeneous W1 (run 1) | 7.5 (7.5 × 3) | 7.99 [6.57, 9.40] vs 8.15 [7.02, 9.27] → −2.0% | 1558 [990, 2126] vs 1539 [896, 2182] → −1.2% | ≤ 5% worse: PASS |
| heterogeneous W1 (run 1) | 5 (5 × 3) | 4.63 [3.68, 5.58] vs 4.69 [3.81, 5.58] → −1.4% | 1955 [559, 3352] vs 1884 [560, 3208] → −3.8% | ≤ 5% worse: PASS |

Run 1's W3 rows were +1.4% and +4.2% (also FAIL).

**Verdict: the bar is not met (W3 fails on both configs in both runs), so `PTR_GATEWAY_AFFINITY` stays `off` by
default.** Supporting numbers (run 2, at the knee unless noted; not part of the bar):

- Engine prompt tokens served from cache, on vs off: homogeneous W3 0.772 vs 0.756, heterogeneous W3 0.777 vs 0.768
  (median paired difference over the 25 seed × rate cells +1.0 and +0.6 points). As the design expected, most cached
  tokens are the policy block that every server holds.
- Affinity outcomes: about half the W3 decisions `picked` (homogeneous: 512 picked / 512 none over 5 seeds; `none` =
  a session's first or second turn or a persona-only match); `brokenBySlack` 1 in heterogeneous, 0 in homogeneous.
- TTFT p50: homogeneous 840 vs 846 ms, heterogeneous 717 vs 759. Dispatch imbalance (max / mean): 1.03 vs 1.03 and
  1.51 vs 1.54: affinity did not concentrate load.
- Over the 25 seed × rate cells affinity had the lower TTFT p95 in 12 (homogeneous) and 12 (heterogeneous), median
  paired gain 0.0% in both: run 1's heterogeneous lean (19 of 25) did not survive the KV fix. The seed spread is far
  larger than the difference; as in S4, throughput in an open loop equals the offered rate unless a policy crosses
  2 s somewhere on the grid, so that half of the bar barely moves.

Revisit only with a reason to expect more: the approved S7 prompt reordering in the app (this run assumed it), longer
histories (more prefill saved per sticky turn), or real-engine calibration (S8). Reusing history never saves KV.

### Gateway HA: drain, gateway registry, per-replica limits (stage S6)

**Graceful drain (§6.3).** SIGTERM or SIGINT on a gateway:
1. `draining = true`: `/healthz` answers 503 `{ok:false,draining:true}`, `/metrics` reports `draining: true`.
2. Every request waiting in the gateway (the limiter's queue, or a pool's band queue) and every request arriving
   later get **503 `GATEWAY_DRAINING`** with `X-PTR-Gateway: rejected`, `X-PTR-Gateway-Reason: draining`,
   `Retry-After: 1` and `Connection: close`. None of them was sent upstream, so the worker client resends at once to
   its next gateway URL, with no wait (S1 rule). A retry inside a pool (a second primary after a connect failure, whose
   first attempt may have reached an engine) is neither refused nor counted: queued or arriving during the drain, it
   waits for credit and is served like an in-flight call (or ends as before: secondary, or the connect error).
3. The registry record (below) is set to `draining`, and the leader hint is given up.
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

**Gateway registry (§13.6, G2).** `PTR_GATEWAY_REGISTRY=on|off` (default `on` with `PTR_GATEWAY_DISCOVERY=redis`,
else `off`) publishes, under the registry prefix (`PTR_REGISTRY_PREFIX`, default `ptr:llm`):

```text
ptr:llm:gw:<id>      HASH {id,url,maxQueue,state(active|draining),startedAt,seq,beatAt}  PEXPIRE 10000 (heartbeat 2000)
ptr:llm:gws          ZSET member=<id> score=expiresAtMs (trimmed by every heartbeat; Redis server clock)
ptr:llm:gw:leader    STRING <id>  SET … PX 5000, renewed by its holder's heartbeat
```

- `PTR_GATEWAY_ID`: default `gw-<port>-<random8>`. `leader` is reserved.
- `PTR_GATEWAY_ADVERTISE_URL`: default `http://127.0.0.1:<port>/v1`. It must pass the workers' own rule (startup
  error otherwise).
- `maxQueue` is `PTR_GATEWAY_MAX_QUEUE`. `startedAt` is the process start; `beatAt` is the registry clock of the last
  heartbeat.
- The record is published once the gateway listens. It is deleted at the end of a drain, and a crashed gateway's
  record expires 10 s after its last heartbeat.

**Leader hint (agent decision, refines the design):** a free hint goes to the **oldest** active gateway whose
`beatAt` is within the hint's 5 s lease, not to whichever gateway heartbeats first. In the first T6 run, a gateway
that had just started took the free hint ahead of the running standby, and every worker moved to the cold newcomer.
A gateway also takes a free hint only after one lease (5 s) of successful heartbeats in a row (a failed heartbeat
restarts the wait), so a gateway that just started or just got Redis back cannot take it on its first beat; it renews a
hint it already holds on every beat. Index members that are not gateway ids (the hint's own name, a stray key) or whose
key is not a hash are skipped by the heartbeat script and the list read. The hint is only an optimisation: a request
sent to a standby is served there just the same.

**Same ledger:** every gateway a worker can reach through the registry (like every URL in `PTR_GATEWAY_URLS`) must use
the same Postgres ledger database (`GOAL1_DATABASE_URL`) when a billable secondary is on. A reset retry or a drain
rejection moves a turn to another gateway with the same request key; only a shared ledger turns that into a replay or
an unresolved refusal instead of a second paid call.

**Upgrade note:** with `PTR_GATEWAY_DISCOVERY=redis` the gateway registry is on by default, and the advertised URL must
be on a port in `PTR_GATEWAY_ALLOW` (default 56460–56469). A gateway on another port then fails at startup with
`INVALID_PTR_GATEWAY_ADVERTISE_URL`, and workers and the capacity controller ignore records outside the allowlist: set
`PTR_GATEWAY_ALLOW` to the same value on gateways, workers and dispatchers (or `PTR_GATEWAY_REGISTRY=off`).

**Workers (`PTR_CHAT_PROVIDER=gateway` with `PTR_GATEWAY_DISCOVERY=redis`):**
- A `GatewayDirectory` reads the registry every 2 s.
- Each call walks a list read at its start: active gateways first, the leader at the head, then by oldest `startedAt`,
  then by id. After them come any `PTR_GATEWAY_URLS` seed URLs that the registry does not list as active or draining
  (for example a gateway running without the registry).
- Before the first read, and whenever the registry has no usable active gateway, the seed is the whole list.
- A failed read keeps the last list (Redis outage fallback), so the list is never empty.
- Registry URLs must be `http://127.0.0.1:<port>/v1` with no credentials, query or fragment, on a port in
  `PTR_GATEWAY_ALLOW` (default `127.0.0.1:56460-56469`; same syntax as `PTR_GATEWAY_UPSTREAM_ALLOW`). This is the same
  §13.4 guard as for engines: anyone with the Redis password can register, and a prompt must never go to an
  unlisted port.
- If two ids share a URL, the later start wins.
- Ignored records are logged once per record version, with the reason only and no URLs: `WARNING gateway registry: N
  record(s) ignored (not_allowed) …`.
- The client checks each listed URL again (loopback and duplicates) at every call.

**Capacity controller Q:** Σ `maxQueue` of the active registered gateways that pass `PTR_GATEWAY_ALLOW`, read every tick;
`PTR_GATEWAY_MAX_QUEUE` when none is active or the read fails (status `qSource`). With H1 (one active gateway) the
standby's queue is counted although only the active one queues in steady state. Q only binds when S_live × headroom
exceeds it (S_live 24 at headroom 0.25 adds 6, far below 256), so this over-count does not matter in practice.

**Per-replica limits (§6.2 amendment):**
- **Failover per-minute ceiling:** each gateway uses floor(`PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE` / k), at least 1.
  k = the active gateways in the registry that pass `PTR_GATEWAY_ALLOW` at its last successful read, itself always
  included (also while draining). In H1 this halves the active gateway's own share while a standby is registered
  (60/min each at the default 120). `failover.perMinuteCap` shows the value in force.
  - **The k-fold bound holds only while k is steady.** Each gateway counts its own rolling minute, so around a change
    of k the sum can exceed one ceiling. Example: a gateway that ran at cap / 2 sees its peer die and moves to cap / 1
    within the minute; a newcomer starts its own empty minute. Expect up to about 1.5–2× one ceiling over the minute
    around a membership change. A dead gateway counts until its record expires (≤ 10 s), and a Redis outage keeps the
    last k.
  - **k is unknown until the first successful registry read**, for example on a cold start during a Redis outage.
    Until then the ceiling is 1 per minute, the most conservative value. BullMQ shares that Redis, so no new turns
    run then anyway (§13.2).
  - A global per-minute check in the Postgres ledger (design S9) would remove both limits.
  - **Registry heartbeat failures are visible (S7 Part A).** A wrong `PTR_REDIS_URL` or password on a gateway used
    to leave k unknown, so the ceiling stayed at 1 per minute without any sign. The gateway now writes one line to
    stderr on the first failed heartbeat and then at most one a minute while failures go on (a flapping Redis is
    limited the same way): `WARNING gateway registry heartbeat failed (<code or error class>): N in a row, M in total; k
    unknown, so the failover per-minute cap is 1` (or `k <n> (last read), so … stays at cap/<n>`). The line carries no
    URL and no error message. `/metrics` has a `registry` object when the gateway is registered: `{id, state, leader,
    active (k, null before the first read), failedBeats, consecutiveFailedBeats}`; `leader` is whether this gateway
    holds the leader hint after its last heartbeat.
- **Telemetry fallback** (one call on a blocked engine with nothing of this gateway in flight) is still per gateway:
  up to k such calls.
- **H2 per-replica credit split S_u / k (`PTR_GATEWAY_SPLIT_CREDIT`): deferred, not implemented (agent decision).**
  Splitting credits on the gateways is a few lines, but on its own it is harmful. Workers send everything to the
  leader (H1 order), so the leader would run at S_u / k and throughput would drop by (k − 1)/k. It needs worker-side
  spreading (hash of the turn id over the active gateways), a credit rule for while k changes (a dead gateway counts
  until its TTL, so the survivors would run at S_u / 2 for up to 10 s), and its own acceptance tests. The design adopts
  it only when gateway CPU is the bottleneck, and nothing has measured that. Active–standby H1 stays the only topology.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_REGISTRY` | `on` with `PTR_GATEWAY_DISCOVERY=redis`, else `off` | gateway publishes itself (needs `PTR_REDIS_URL`) |
| `PTR_GATEWAY_ID` | `gw-<port>-<random8>` | registry id |
| `PTR_GATEWAY_ADVERTISE_URL` | `http://127.0.0.1:<port>/v1` | URL workers use; checked against `PTR_GATEWAY_ALLOW` |
| `PTR_GATEWAY_ALLOW` | `127.0.0.1:56460-56469` | ports a registry gateway URL may use (gateways, workers, capacity controller) |
| `PTR_GATEWAY_DISCOVERY` (worker) | `static` | `redis`: worker reads the gateway registry; `PTR_GATEWAY_URLS` becomes seed + fallback |
| `PTR_GATEWAY_SHUTDOWN_MS` | 30000 | drain bound for calls already sent upstream |

**Acceptance (zero cost).** Two harnesses were used.

`scripts/gateway-ha-acceptance.ts` runs real gateway processes (pool mode, registry on) in front of in-process fake
engines (2 × 12 slots, about 1.5 s per call). It runs closed-loop worker clients, one client per user, with request
keys and the S1 retry settings, and two `GatewayDirectory`s over the real Redis registry in a `ptrtest:s6<run>:llm`
namespace, deleted afterwards. Each scenario runs for 30 s, and the leader is killed at 10 s.

For D, the gateways run `PTR_GATEWAY_FAILOVER=openrouter` with the real `OpenRouterClient` and Postgres ledger
(tables created in `ptr_loadtest` for the run and dropped afterwards). A preload (`scripts/ha-openrouter-redirect.ts`)
sends openrouter.ai fetches to a fake on loopback and refuses any other external fetch, and the API key is synthetic.
The primary engine is down, so every call goes to the secondary (1.5 s).

`scripts/loadtest.ts crash` runs the full stack (2 APIs, workers, dispatcher, Postgres turns, static
`PTR_GATEWAY_URLS`, 16 users).

Report: `reports/gateway-ha-acceptance-be804406.json` and `reports/loadtest/…-crash/report.json` (private).

| Test | Setup | Result | Bar |
| --- | --- | --- | --- |
| C (HA harness) | 2 gateways, leader SIGKILL, no restart, 16 users | 320 calls, **0 failed**. The 16 in flight were retried on gw-2 (16 engine generations regenerated, no billing). Kill window e2e p95 1518 ms. Leader hint moved after 6.0 s; gw-1's record left the lists after 10.0 s (TTL), until then a refused connect took ~0 ms per call. Q 512 → 256 | 0 failed: **PASS** |
| C (loadtest, full stack) | `--target=gateway --standby-gateway=1 --restart=0` | 231 turns, **0 failed**, 0 orphaned, 16 generating at the kill | **PASS** |
| D (HA harness) | primary engines down, fake billable secondary + ledger, leader SIGKILL during secondary calls | 336 secondary POSTs for 336 distinct bodies: **0 posted twice (no double billing)**. **16 unresolved refusals** (`REQUEST_UNRESOLVED_NO_RESUBMIT` → 502 → the turn fails), exactly the calls in flight on gw-1; their ledger rows stay `submitted`, the other 320 are `settled`. 0 other failures | double billing 0: **PASS**; refusals counted (16) |
| E (HA harness) | SIGTERM drain of the leader with 12 in flight + 12 queued (credit 12/gateway, 24 users) | 282 calls, **0 failed**, 0 regenerated. The 12 queued and 11 later arrivals got `draining` and were served by gw-2 at once. gw-1 exited 0 after 1.55 s (its in-flight calls done). Lists dropped gw-1 and the hint moved after 2.0 s. Q 512 → 256 | 0 failed: **PASS** |
| E (loadtest, full stack) | `--signal=SIGTERM --gateway-concurrency=8`, static URLs | 132 turns, **0 failed**, 0 orphaned. Drain: 8 in flight, 8 queued refused at once, 25 refused while draining in total (static lists keep trying the draining gateway first until it exits) | **PASS** |
| T6 (HA harness) | leader SIGKILL at 10 s, gw-3 registers at 15 s | 320 calls, **0 failed**. Hint moved to gw-2 (the oldest beating) after 6.0 s, and gw-3 stayed standby (0 calls). gw-3 was in the workers' lists 0.8 s after it started. gw-1 left them after 10.0 s. Q 512 → 768 → 512 | workers switch, lists update, 0 failed: **PASS** |

Notes:
- Before the registry record expires, the killed gateway stays at the head of the list. Each call pays one refused
  connect (S1: no wait before an untried URL; 48 of 96 calls in the C kill window show 2 attempts).
- After a drain the deleted record's URL can reappear at the end of the list as a seed URL, which is harmless.
- One run per scenario on one host. These results describe the failover mechanics, not multi-host fault tolerance.

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

Gateway HA acceptance (`scripts/gateway-ha-acceptance.ts` C/D/E, T6; see "Gateway HA" above):

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
