# Framework synthetic functional and comparison gates

## Frozen protocol (before the first comparative measurement)

The synthetic fixture is the same actual HTTP model server for both paths:
100 ms fixed delay, 16 prompt / 12 completion usage tokens, identical bounded output.
The old copy uses custom gateway + streaming transport; migration uses real LiteLLM
+ ChatOpenAI non-streaming transport + Guardrails + LangGraph Postgres checkpoints +
Langfuse v4. These framework differences are intentionally part of the comparison.

- One API, one worker, four worker execution slots; application DB pools eight each.
- Four warm-up turns, then 32 measured turns at eight bounded clients, distinct sessions.
- Zero failed/rejected/stuck turns; exactly 32 successful measured synthetic submissions.
- Migration p95 ≤ baseline p95 × 1.75 + 250 ms.
- Migration completed turns/second ≥ 60% of baseline.
- Same immutable `LOAD_GATE` in `scripts/framework-loadtest.ts`; no retuning after results.

**Gate-order deviation:** plan 44 requested numeric gates before code migration.
These numerical gates were fixed after implementation started, before any comparative
performance run. A pristine baseline passed its original 1,619 checks, but that is not
an earlier numerical load baseline. This deviation cannot be repaired retroactively.

This is a small deterministic integration/regression gate, **not** a capacity/SLO,
real model quality, production traffic, GPU throughput or proof of paid exactly-once.

## Isolation and reproduction

Both suites accept only newly generated `/tmp/ptr-fw-*.env` files with mode 0600.
They never read the research environment, original source data, private reports or
real personas. Child processes receive an explicit allowlist, no inherited provider
keys, and paid/Jev endpoints remain off. Results are sanitized JSON only; generated
credentials and process logs remain in private temporary storage.

- Migration synthetic stores: `ptr_framework_test` / `ptr_framework_tester` on
  localhost 57432 and new Redis on 57479.
- Pristine COPY `/tmp/ptr-framework-baseline-src` uses a new `ptr_loadtest` /
  `ptr_loadtester` on 57433 and new Redis on 57480. The runner adapts only two exact
  port literals in this copied source. Original `main`, research stores and ports
  56432/56479 are never changed.
- Each run creates a fresh queue/namespace, authored synthetic catalogue and prefix-
  scoped synthetic rows. It never truncates an existing database or queue.
- The functional UI retains its established synthetic loopback ports 56448/56449.
  They must be free; occupied ports are not reclaimed. Next starts in synthetic mode.
- Only runner-owned child handles receive signals and bounded cleanup. Infrastructure
  containers and unrelated application processes are left running.

```bash
pnpm exec tsx scripts/framework-smoke.ts \
  --env-file=/tmp/ptr-fw-infra-smoke.env \
  --app-key-file=/tmp/ptr-fw-infra-app-key.env
pnpm exec tsx scripts/framework-loadtest.ts \
  --env-file=/tmp/ptr-fw-infra-smoke.env \
  --app-key-file=/tmp/ptr-fw-infra-app-key.env \
  --baseline-env-file=/tmp/ptr-fw-baseline.env
```

No concurrent fixture requests should run during numerical comparison: exactly 32
measured submissions per topology detects shared-fixture contamination. Unit tests
never connect to this infrastructure.

## Measurement meanings

The original numerical results below are historical evidence for the initial
all-stage-checkpoint implementation. They are not rewritten or retuned by the
later user-approved call-only policy. Original checkpoint counts/bytes covered
only the outer `turn:` rows, omitting child threads/blobs/pending writes.

### Original protocol

End-to-end latency spans POST admission through terminal-state HTTP observation.
It includes bounded polling resolution; it is not model-only latency. Worker peak is
sampled at 20 ms and is a lower bound. Queue-wait quantiles are histogram upper bucket
bounds, not exact percentiles. Checkpoint bytes are stored JSON checkpoint + metadata
row payload, not WAL/disk/network I/O; blob/pending-write bytes are not included.
Provider TTFT is null because migration deliberately uses non-streaming ChatOpenAI.
Trace/cardinality/static stage-name ingestion checks and observation stage latencies
use the real Langfuse v4 Observations API v2 after shutdown, with bounded session filters,
cursor pagination and core/basic/metrics fields only (no IO content). Reads never
contaminate the timed load. Stage latency is an observed span duration, not a profiler.

### Updated call-only protocol

Current serving persists only costly nonbillable turn model-call receipts; paid
model/Jev reuse their existing request ledgers. Cheap graph stages restart, and
Guardrails/evidence/fencing remain mandatory. Current load tooling counts scoped
model-call plus legacy turn/character threads across checkpoints, checkpoint_blobs
and checkpoint_writes. The aggregate is live row payload, not physical disk/WAL/
index or network traffic. The old original figures retain their old definition.

Timed stages no longer scrape worker metrics every20ms: the new worker's collectors
perform live DB/Redis reads, unlike the old worker's in-memory collector. Before/
after metrics remain available; an unmeasured worker peak is unavailable, not an
invented configured concurrency. Terminal HTTP polling is still100ms, so closed-
loop finite-batch throughput is not sustained production capacity. Exact engine
success/submission deltas, zero failure/timeout and nonfallback outputs are checked.
The frozen original numeric LOAD_GATE is unchanged. Post-change results are
recorded separately below; historical observations are not substituted.

## Current evidence

### First frozen comparison — 2026-10-10

The reproduction command above ran both real topologies sequentially. Exit status 1:
**throughput gate failed; this result is not a completed performance migration.**
No thresholds were changed after seeing these numbers.

| Measurement | Pristine adapted copy | Framework migration |
|---|---:|---:|
| Completed / attempted | 32 / 32 | 32 / 32 |
| Errors | 0 | 0 |
| Measured elapsed ms | 1,050 | 1,901 |
| Completed turns / second | 30.468 | 16.829 |
| End-to-end p50 ms | 232.183 | 417.850 |
| End-to-end p95 ms | 361.249 | 528.514 |
| End-to-end p99 ms | 364.523 | 628.609 |
| Client / sampled worker peak | 8 / 4 | 8 / 4 |
| Measured synthetic submissions | 32 | 32 |
| Queue wait p50 / p95 upper bound seconds | 0.1 / 0.25 | 0.25 / 0.5 |
| Checkpoint JSON+metadata rows / bytes | 0 / 0 | 320 / 239,808 |
| Native v4 trace / observation count | unavailable | 32 / 314 |

- p95 gate: 528.514 ≤ 882.186 ms, **pass**.
- Throughput gate: ratio 0.5523 < 0.60 (required ≥18.281 turns/s), **fail**.
- Zero errors, complete count and single measured submission gates: **pass**.
- Model TTFT: **unavailable**, not inferred from span duration.
- Actual disk/WAL/transport metadata I/O: **unavailable**; checkpoint payload bytes
  are not a replacement for those measurements.
- Baseline trace and stage instrumentation: **unavailable**, not zero.

Observed migration span p50 / p95 ms: `model` 123 / 136; `generate` 147 / 173;
`safety` 17 / 62; `output_guard` 16 / 23; `persist` 8 / 14; `initialize` 2 / 12;
`turn` 206 / 291. Zero-duration stages remain present by name but are not given
invented durations. All model calls are to the local fixture; paid calls = 0.

### Functional validation status

Seven isolated unit tests and focused ESLint passed. Real HTTP exercised auth,
owner isolation, public DTO projection, model-result/serving identification, SSE,
idempotency, PostgreSQL checkpoints, exact synthetic citation binding, fictional
post drafts, Guardrails outage fail-closed without a model submission, and worker
restart. Actual Next + Chromium completed login, turn/SSE and reload with no route
mocking. A real HTTP-app Langfuse dataset experiment and v4 observations also ran.

The stale-worker gate originally used the seven-second transport-timeout fixture
against a five-second proxy timeout, so its model correctly failed. The fixture now
has a distinct three-second successful `__LOCK_LOSS__` marker: reclaimed attempt 2
completed and exactly one assistant row survived (stale writer rejected).
The HTTP experiment helper initially exceeded the API's bounded owner regex; its
owner length was fixed with a dedicated regression test. Neither harness defect
was converted into a relaxed success condition.

**Final full functional command: exit 0 on 2026-10-10.** All 23 gates passed:
auth, SSE, completed turn, real non-fallback model result and LiteLLM serving,
owner isolation, public DTO, idempotency, PostgreSQL checkpoints, exact synthetic
evidence, fictional draft, Guardrails fail-closed/no-model, worker restart,
lock-loss recovery, stale writer rejection, single persistence, Prometheus scrape,
web auth/proxy, actual browser turn/reload, HTTP-app experiment, and tracing.
The first turn stored 10 real PostgreSQL checkpoint rows. Native v4 readback counted
6 traces / 51 observations across 10 static stages (including the deliberately
interrupted/recovered attempt). Actual HTTP-app experiment: one case, zero failed
scores, zero missing scores, zero task failures, one trace and exactly one synthetic
model submission, with a real annotation queue. These are synthetic behavior gates,
not evidence of production response accuracy, human rubric review or paid execution.

### Post-optimization frozen rerun — 2026-10-10

Only the new isolated project's Guardrails container was rebuilt, using genuine
thread-local Guard instances with request-local validation state. Service image:
`sha256:b896ec41c44713c5650ac4af9a2691fb0149001694ee9a8cbfd97aae4db45ef1`.
The same command, fixture, slots and **unchanged** frozen thresholds returned exit 0.
The first failed result above remains part of this evidence, not discarded.

| Measurement | Pristine adapted copy | Framework migration |
|---|---:|---:|
| Completed / attempted; errors | 32 / 32; 0 | 32 / 32; 0 |
| Elapsed ms; completed turns/s | 969; 33.0067 | 1,575; 20.3198 |
| End-to-end p50 / p95 / p99 ms | 212.169 / 333.213 / 334.242 | 320.396 / 526.572 / 527.271 |
| Client / sampled worker peak | 8 / 4 | 8 / 4 |
| Measured synthetic submissions | 32 | 32 |
| Queue wait p50 / p95 upper bound seconds | 0.1 / 0.25 | 0.25 / 0.25 |
| Checkpoint rows / payload bytes | 0 / 0 | 320 / 239,808 |
| Native v4 traces / observations | unavailable | 32 / 320 |

All five frozen gates passed: 526.572 ms p95 ≤ 833.123 ms bound; throughput ratio
0.615625 ≥ 0.60 (20.3198 turns/s ≥19.8040 minimum). Migration is still **38.44% slower
than this baseline**, not faster. Passing the bounded regression allowance is not
proof of performance parity or a production-capacity claim.

Observed migration span p50 / p95 ms: `safety` 4 / 7; `output_guard` 4 / 14;
`model` 122 / 133; `generate` 141 / 175; `persist` 4 / 13; `initialize` 1 / 13;
`turn` 168 / 227. The prior safety/guard span reduction is observed, not an isolated
causal benchmark. Root repository checks/Jest were running on the shared host during
this rerun, so a final quiet-host run remains pending and will be recorded separately.
No service outage, paid provider, GPU or private source was used by the comparison.

Post-optimization full functional smoke also returned exit 0: all 23 gates still
passed, the first turn retained 10 PostgreSQL checkpoints, and native v4 readback
counted 6 traces / 50 observations / 10 static stage names. The real HTTP-app
experiment retained 1 case, failed/missing/task-failure counts all 0, 1 trace and
1 synthetic model submission. The paused runner-owned worker was reclaimed and
completed attempt 2 with exactly one persisted assistant message. API, workers,
Next and Chromium child handles were closed on exit; infrastructure stays running.

### Final quiet-host frozen comparison — 2026-10-10

Root explicitly signaled that repository checks, browser/build/Docker tests and
its isolated real-DB tests had finished, with heavyweight tool processes stopped.
The same frozen comparison command then returned **exit 0**. No fixture, threshold,
worker slots, client limit or measurement definition was changed. This is the final
comparison evidence; the earlier failure and concurrent-host pass remain above.

| Measurement | Pristine adapted copy | Framework migration |
|---|---:|---:|
| Completed / attempted; errors | 32 / 32; 0 | 32 / 32; 0 |
| Elapsed ms; completed turns/s | 1,059; 30.2243 | 1,659; 19.2926 |
| End-to-end p50 / p95 / p99 ms | 214.131 / 325.351 / 326.007 | 318.614 / 529.620 / 530.731 |
| Client / sampled worker peak | 8 / 4 | 8 / 4 |
| Measured synthetic submissions | 32 | 32 |
| Queue wait p50 / p95 upper bound seconds | 0.1 / 0.25 | 0.25 / 0.5 |
| Checkpoint rows / payload bytes | 0 / 0 | 320 / 239,808 |
| Native v4 traces / observations | unavailable | 32 / 320 |

All frozen gates pass: throughput ratio **0.638313 ≥ 0.60**, 19.2926 turns/s ≥
18.1346 minimum, and 529.620 ms p95 ≤819.365 ms bound. Migration remains **36.17%
slower** than this baseline; the gate permits bounded regression and does not claim
speedup, production capacity, model accuracy or cross-machine performance parity.

Observed migration span p50 / p95 ms: `model` 114 / 144; `generate` 135 / 192;
`safety` 3 / 10; `output_guard` 3 / 5; `persist` 8 / 21; `initialize` 1 / 13;
`turn` 171 / 283. Native readback contains the same 10 safe stage names. Provider
TTFT and actual disk/WAL metadata I/O remain unavailable, not estimated. Paid calls
remain 0; the real LiteLLM transport used only the authored local synthetic engine.

Final functional smoke after the latest runtime health/Jev metadata-only changes:
**exit 0, 23/23 gates pass**. Actual API/worker/Next/Chromium paths, Guardrails outage
fail-closed, lock-loss recovery with one persisted assistant, evidence/draft gates
and owner/secret-safe DTO behavior remain intact. Native v4 readback: 6 traces /
51 observations / 10 stages. HTTP-app experiment: 1 case, failed scores 0, missing
scores 0, task failures 0, 1 trace, exactly 1 synthetic submission. Owned application
and browser handles closed normally. Infrastructure remains intentionally running.


### Call-only persistence — isolated synthetic verification, 2026-10-11 KST

Current serving has no turn/character stage saver. A durable nonbillable call holds
only its fingerprint and response receipt; expensive paid/Jev calls retain their
existing ledgers. Actual PostgreSQL recovery destroys the first pool/saver and uses
a fresh worker/pool: model calls stay at one while retrieval/safety/guards rerun.
The pending-successful-task receipt case also replays without a new model request.
Old fences cannot commit; successful completion leaves one assistant message.

A bounded policy-only diagnostic compares the archived all-stage framework code
with current code through the **same** LiteLLM/Guardrails/Langfuse stack. Four runs
per policy, alternating order twice; each run warms16 and measures64 turns with
clients8/worker4/pool8 and the same100ms engine. No active metrics sampler or query
profiler runs inside measurements. Worker time is the existing `turn_finished`
wall clock after execution claim, not pure CPU or queue wait. Warm-ups are excluded.
All512 measured turns and128 warm-ups completed with one successful engine request
per turn, identical full output-shape hash, no model errors/timeouts or fallback.

| Order | Policy | Turns/s | Mean worker ms | HTTP p95 ms |
|---|---|---:|---:|---:|
| forward | previous | 15.8626 | 233.297 | 710.859 |
| forward | current | 21.1367 | 175.562 | 424.441 |
| reverse | current | 21.9919 | 171.625 | 422.474 |
| reverse | previous | 21.9204 | 175.266 | 423.020 |
| forward2 | previous | 18.7336 | 199.516 | 555.223 |
| forward2 | current | 21.3270 | 174.797 | 423.261 |
| reverse2 | current | 21.9600 | 170.953 | 425.661 |
| reverse2 | previous | 21.9773 | 174.359 | 523.033 |

Across four runs per policy, worker means are195.609ms before and173.234ms current;
mean per-run completed rates are19.6235 and21.6039 turns/s. **Order variance is
material:** reverse runs nearly tie, so these means do not establish a universal
speedup or identify a production bottleneck. No production capacity forecast,
CPU attribution or exact causal allocation is claimed.

Storage is much less ambiguous for this authored single-model-call fixture:
84→13 rows/turn and ~153,893→4,877 complete row bytes/turn across all saver tables
(**96.83% less row payload**). Current per64 turns: checkpoints192/108,992 bytes,
blobs384/95,040 bytes, writes256/108,096 bytes; no legacy stage rows. This is not
physical disk/WAL/index I/O, and response length/tool rounds affect storage.
One call-level checkpoint still entails multiple framework records/transactions.

A fresh original-baseline comparison uses the unchanged numeric LOAD_GATE and
updated no-active-sampler protocol, not the64-turn policy diagnostic:

| Metric | Original baseline COPY | Current call-only framework |
|---|---:|---:|
| Measured completed/errors | 32/0 | 32/0 |
| Turns/s | 32.9856 | 20.4182 |
| HTTP p95 ms | 338.437 | 532.764 |
| Successful submissions / failures / timeouts | 32/0/0 | 32/0/0 |
| Nonfallback outputs | 32 | 32 |
| Observed worker peak | unavailable | unavailable |
| Checkpoint rows / row bytes | 0/0 | 416/156,064 |
| Native traces / observations | unavailable | 32/320 |

All nine gates pass; throughput ratio **0.619004 ≥0.60**. The current framework
is still **38.10% slower** than the original topology in this finite
batch. This is a fresh run, not an improvement percentage against the historical
19.2926 result; changed sampling and run variance prevent that inference. Both
32-turn outputs have the same full status/content/limitations hash. Paid/GPU calls0.


Final verification on the call-only implementation: `pnpm check` passes
1,492 standard tests plus17 isolated OTel/evaluation tests, TypeScript and ESLint;
94 explicitly gated tests remain skipped in that offline suite. Separately, actual
isolated PostgreSQL/Redis tests pass21/21, covering fresh-saver costly receipt
recovery, pending writes, execution fencing, queue lock loss and both retention
families. Final API/worker/Next/Chromium smoke passes23/23 gates, including real
HTTP-app evaluation with one successful request/one trace and zero failed/missing
scores. Run-scoped storage includes browser/experiment sessions:79 model rows /
30,665 complete row bytes / zero legacy stage rows. Native sampled smoke readback:
6 traces,55 observations, all10 safe stage names. Independent final read-only
review reports no blockers. Runner-owned application/browser processes closed;
the isolated infrastructure remains available. Real GPU/model quality/private
imports/production deployment and Python LLM-service separation are not validated
or implemented by this persistence change.
