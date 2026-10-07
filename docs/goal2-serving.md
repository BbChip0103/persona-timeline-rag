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
                                            LLM gateway (one upstream: fake | self-hosted vLLM | OpenRouter)
```

Every turn runs queued; there is no inline mode (`PTR_EXECUTION` is rejected at startup). Processes:
`pnpm dev:api`, `pnpm dev:worker` (any number), `pnpm dev:dispatcher` (one or more), `pnpm dev:gateway`.
All need `PTR_REDIS_URL` (`infra/compose.redis.yml`) and migrations through `0007_turn_outbox.sql`.

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
`PTR_SELFHOSTED_MODEL`) or `openrouter` (shared budget ledger). There is no fallback between upstreams. It runs at
most `PTR_GATEWAY_MAX_CONCURRENCY` (32) upstream calls, queues up to `PTR_GATEWAY_MAX_QUEUE` (256) FIFO for
`PTR_GATEWAY_QUEUE_TIMEOUT_MS` (10000), and rejects the rest before anything reaches the upstream: 429
`GATEWAY_QUEUE_FULL` / 503 `GATEWAY_QUEUE_TIMEOUT`, both with `Retry-After` and `X-PTR-Gateway: rejected`. A
caller's disconnect leaves the queue or aborts the upstream call. Upstream errors become 502 without that marker.
Workers use `PTR_CHAT_PROVIDER=gateway` (`PTR_GATEWAY_URL`, default `http://127.0.0.1:56460/v1`,
`PTR_GATEWAY_TOKEN`, `PTR_GATEWAY_STRUCTURED=1` for guided decoding); the client retries only marked rejections.

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
pnpm exec tsx scripts/loadtest.ts same-session --trials=30 --apis=2
pnpm exec tsx scripts/loadtest.ts ramp --levels=1000 --think-ms=4000 --client=poll --poll-ms=100   # polling comparison
pnpm exec tsx scripts/loadtest.ts ramp --levels=4,16,64 --turns-per-session=10 \
  --provider=selfhosted --base-url=http://127.0.0.1:18000/v1 --model=gemma-4-e4b-fp8 --structured=1
```

Virtual users stick to one API and move to the next on network errors; they POST a turn and follow it over SSE
(`--client=poll` for comparison), honour `Retry-After`, and `--turns-per-session=N` starts a new session every N
turns. Reports (`reports/loadtest/<run>/report.json`, private) hold per-stage throughput, e2e/accept percentiles,
error codes, stuck/orphaned turns, database work per stage (transactions/s and per turn, WAL bytes per turn, turns
updates vs HOT updates, dead tuples), gateway metrics, and per-second CPU/RSS per process role and DB connections.
Single-host replicas do not demonstrate multi-host fault tolerance. Fake-model results describe the serving
architecture, never real LLM throughput.

## Engine benchmarks

- GPU host scripts: `infra/gpu/` (vLLM vs SGLang, BF16 / online FP8 / NVFP4, same client and workloads); every script reads the engine directory from `PTR_GPU_ROOT`.
- `scripts/provider-bench.ts`: same synthetic app-shaped prompt against OpenRouter (capped by `--max-usd`,
  per-request nonce so ledger caching never counts as latency) or a tunnelled self-hosted engine.
- `scripts/summarize_engine_bench.py <run-dir>`: Markdown + `summary.json` joining results with GPU samples.
