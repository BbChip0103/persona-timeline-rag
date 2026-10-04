# Goal2 serving: queued execution, load harness and engine benchmarks

Current contract and reproduction steps for the Goal2 (LLMOps) work. Measured results and the decision
history live in the issue repository; this file only says how the system behaves and how to rerun it.

## Execution modes

| | `PTR_EXECUTION=inline` (default) | `PTR_EXECUTION=queue` |
|---|---|---|
| where a turn runs | inside the API process that accepted it | `apps/api/src/worker.ts` processes (any number) |
| API `POST /sessions/:id/turns` | reserves and starts executing | reserves (stores the structured request) and returns |
| process crash / restart | in-flight turns stay active forever; the session gets `TURN_ACTIVE` until cancelled | expired leases are requeued; after `PTR_MAX_ATTEMPTS` the turn fails with `WORKER_LOST`, unblocking the session |
| overload | unbounded in-flight work | `503 QUEUE_FULL` + `Retry-After: 1` when the unclaimed backlog reaches `PTR_QUEUE_MAX_DEPTH` |

Queue semantics:

- Claim: `FOR UPDATE SKIP LOCKED` on pending turns with no live lease; each claim increments `attempts`.
- Lease: `PTR_LEASE_MS` (default 15000), renewed every lease/3 while the turn is active. A failed renewal
  (user cancelled, or the lease was lost) aborts the provider call.
- Fencing: every state write from a worker requires `lease_owner = worker AND attempts = claimed attempt`,
  so a stale worker can never overwrite a turn another worker reclaimed.
- Re-execution after a lost worker is safe for the live OpenRouter provider because its ledger reuses a
  settled response for the identical request or refuses an unresolved one (`REQUEST_UNRESOLVED_NO_RESUBMIT`);
  it never submits a second billable request.
- Admission control runs before any session lookup, shares one backlog count for 200 ms and takes a slot
  synchronously, so bursts do not overshoot the bound. It is per API process (soft across several APIs).
- `onTurnFailure` reports failed turns with an error code/class only; workers log `turn failed <code>`.

Settings: `PTR_QUEUE_MAX_DEPTH` (256), `PTR_DB_POOL_MAX` (8, per process), `PTR_WORKER_CONCURRENCY` (32),
`PTR_LEASE_MS` (15000), `PTR_WORKER_POLL_MS` (50), `PTR_MAX_ATTEMPTS` (3). Migrations `0005_turn_queue.sql`
(lease/fence/request columns) and `0006_messages_session_index.sql` (per-session history index) are required.

## Providers

- `fake` (default): deterministic, no network. `PTR_FAKE_LATENCY='{"medianMs":1900,"p95Ms":3600,"seed":7}'`
  adds a seeded log-normal delay (optional `error429Rate`, `hangRate`) for load tests; rejected for any
  other provider.
- `openrouter`: live API through the shared US$2 / 10000-request ledger (requires `GOAL1_LIVE_ENABLED=true`).
- `selfhosted`: `PTR_SELFHOSTED_BASE_URL` (must be `http://127.0.0.1:<port>/v1`, i.e. an SSH tunnel) and
  `PTR_SELFHOSTED_MODEL`; streams to record TTFT; no per-request billing (GPU time is accounted per run).

## Load / failure harness (synthetic only)

Uses the isolated `ptr_loadtest` database (`PTR_LOADTEST_DATABASE_URL`, see `infra/README.md`), synthetic
personas/posts, and spawns its own API (port 56451) and workers with an explicit environment.

```sh
pnpm exec tsx scripts/loadtest.ts ramp --levels=64,256,512,1024 --stage-seconds=45            # inline
pnpm exec tsx scripts/loadtest.ts ramp --levels=1024 --execution=queue --workers=4 \
  --worker-concurrency=512 --pool-max=12 --lease-ms=5000                                         # queue
pnpm exec tsx scripts/loadtest.ts crash --users=32 [--execution=queue --workers=2 ...]           # kill API / all workers
pnpm exec tsx scripts/loadtest.ts faults --users=32 --latency='{"medianMs":1900,"p95Ms":3600,"error429Rate":0.1,"hangRate":0.05}'
pnpm exec tsx scripts/loadtest.ts same-session --trials=30
pnpm exec tsx scripts/loadtest.ts ramp --levels=16 --provider=selfhosted --base-url=http://127.0.0.1:18000/v1 --model=gemma-4-e4b-fp8
```

Virtual users create a session and loop POST turn → poll until terminal; rejected requests honor
`Retry-After`. Reports (`reports/loadtest/<run>/report.json`, private) hold per-stage throughput, e2e/accept
percentiles, error codes, stuck/orphaned turns, and per-second API/worker CPU, RSS and DB connections.
Fake-model results describe the serving architecture, never real LLM throughput.

## Engine benchmarks

- GPU host scripts: `infra/gpu/` (vLLM vs SGLang, BF16 / online FP8 / NVFP4, same client and workloads); every script reads the engine directory from `PTR_GPU_ROOT`.
- `scripts/provider-bench.ts`: same synthetic app-shaped prompt against OpenRouter (capped by `--max-usd`,
  per-request nonce so ledger caching never counts as latency) or a tunnelled self-hosted engine.
- `scripts/summarize_engine_bench.py <run-dir>`: Markdown + `summary.json` joining results with GPU samples.
