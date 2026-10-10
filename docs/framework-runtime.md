# Current deployment: Python split

The default worker is now the independent Python image. Use separate app/LLM roles
and private env files; see [split cutover/runbook](python-llm-split.md). Historical
framework instructions below describe the retained TS reference/runtime and must not
be used to give Python the old all-in-one credentials.

# Framework runtime: current serving path

The default application has exactly three TypeScript processes: NestJS API, a Nest
BullMQ worker, and Next.js web. It does not launch a dispatcher, bespoke gateway,
server registry, credit/DRR scheduler or capacity-controller loop. The separate
[framework infrastructure](framework-deployment.md) supplies LiteLLM, Guardrails
and the six-service Langfuse v4 stack. Python ingestion remains unchanged.

## Serving and setup

Install with `pnpm install --frozen-lockfile`. Use a **new, explicit** private
framework environment, never copy existing research credentials into a synthetic
run. `.env.example` has placeholders only. `pnpm ops:check-env --role api
--file <new-private-env>` validates without printing rejected values.

Required serving settings include `DATABASE_URL`, authenticated `PTR_REDIS_URL`,
`PTR_API_TOKEN`, `PTR_PERSONAS_FILE`, explicit `PTR_CHAT_PROVIDER=fake|litellm`,
and the internal `PTR_GUARDRAILS_URL`/`PTR_GUARDRAILS_TOKEN`. Both fake and LiteLLM
serving use genuine Guardrails; omitting it is only supported by isolated domain
test harnesses. Queue names, limits, worker lock/recovery settings and Jev controls
are validated before serving. Removed fleet/demo settings are rejected.

Run migrations and checkpoint schema setup **explicitly before serving**:

```sh
node --env-file=<new-private-env> --import tsx scripts/db-migrate.ts
node --env-file=<new-private-env> --import tsx scripts/framework-checkpoints.ts
node --env-file=<new-private-env> --import tsx apps/api/src/main.ts
node --env-file=<new-private-env> --import tsx apps/api/src/worker.ts
```

These commands are not authorization to change a research/shared database. The
synthetic framework DB is `ptr_framework_test` on loopback port 57432; its Redis
is on 57479. Existing research targets retain their original isolation guards.
Runtime composition neither seeds personas nor migrates tables at startup.

Application Compose uses the same image for API/worker/web and an explicitly
selected new private environment. The infrastructure stack has separate state,
credentials and networks. `network_mode: host` in the application profile preserves
Linux loopback isolation; it is not a recommendation to share databases/credentials
or to use the development machine's resources for production sizing.

## Model and validation boundaries

LiteLLM owns proxy routing/admission and virtual-key budget enforcement. LangChain
`ChatOpenAI` owns model transport and structured output. Every SDK/proxy HTTP retry
and automatic fallback is disabled. Within the approved proxy configuration, the
non-billable alias `primary` is reserved for self-hosted engines. Other/unknown
aliases require `PTR_LITELLM_BILLABLE=1`, both explicit live/data approvals and the
durable Postgres request ledger. Do not remap a self-hosted alias to a paid provider
or issue a virtual key whose allowed-model scope bypasses this policy.

Ambiguous paid submissions remain unresolved and are not resubmitted; successful
receipts can replay. A checkpoint alone does **not** provide external exactly-once.
No real model/GPU/paid/private transfer is implied by a synthetic smoke run.

Jev retains its decision-question protocol and optional, separately gated paid
client. Its actual scores are passed once to Guardrails. With Jev explicitly off,
Guardrails receives `classification: rules-only`, runs the frozen deterministic
input policy and records no invented classifier probabilities. This is weaker
coverage than evaluated Jev and must not be reported as Jev validation. Configured
Jev failure and Guardrails outage fail closed, without regex/backend bypass or
reask. Output-specific Jev remains a separate unevaluated contract.

Fake vectors are never used to query real vector spaces. LiteLLM sessions use
lexical RAG unless a separately approved compatible embedder is implemented.

## Durable execution

The API reserves the turn and outbox row in one transaction. BullMQ owns job lock
renewal/stalled recovery. Postgres owns the execution generation fence, so a worker
that loses its lock cannot commit late. The outbox remains until terminal state;
worker-local maintenance republishes missing jobs and repairs queue/DB disagreement
using compare-and-swap and a new dispatch sequence. No Postgres heartbeat duplicates
the BullMQ lock in the framework path. Queue-age expiry defaults to 60 seconds.

LangGraph still executes initialize/safety/intent/retrieve/generate/evidence/
output_guard/persist and character/tool branches, but does **not** persist their
whole-stage state. A recovered job restarts these cheap stages, including evidence
and Guardrails validation. Final message identity is assigned again if its prior
attempt never committed; exactly one committed assistant message remains protected
by the completion transaction and fence. Cancellation and old generations cannot
commit.

Only expensive call results are durable. Non-billable/self-hosted **turn** model
calls use a small standalone LangGraph graph with root namespace and a stable
`model:<turn UUID>:<request fingerprint>` thread. Its state holds only the request
fingerprint and raw response/upstream/usage receipt, never persona/history/search
frames or full request messages. The fingerprint binds trusted provider/model/
output revision and exact messages; changed evidence/context makes a different
request, never reuses an incompatible answer. Completed calls replay usage/upstream
callbacks, while the rest of the job reruns. Existing paid chat/Jev request ledgers
already persist receipts and block uncertain resubmission, so they are not wrapped
in a duplicate checkpoint. Creative drafts retain their original provider path.
A small call graph still writes framework checkpoint/pending-write records: this
policy means call-level recovery, not literally one SQL row per call.

## Observability, evaluation and retention

All production turns use real OTel/Langfuse parent/stage/model observations. Content
capture defaults off; versions, pseudonymous IDs, outcome, usage and available cost
remain observable. Export is bounded and is not awaited on the chat path. An SDK
queued span is not proof of server persistence. Prometheus collectors own metrics;
there is no homegrown accumulator or exposition serializer.

[Evaluation and review](framework-evaluation.md) use Langfuse datasets, SDK
experiments, native scores, score configs and annotation queues. The built-in
`framework-app-experiment` module exercises existing app/domain contracts; the
safe default CLI fixtures only prove SDK plumbing and make no model calls. Hidden
HTTP diagnostics are not fabricated as passing scores. Historical unlinked results
retain archive provenance and never become fabricated original traces/reviews.

Retention is explicit: 90-day supported deletion of traces, dataset/review items,
private blob lifecycle and separate backup expiry. New model-call checkpoints contain raw model responses; old turn/character
checkpoints may still contain full turn/source snapshots. Run the explicit checkpoint
retention CLI with dry-run first; it covers both legacy and model-call threads in
all three saver tables and defaults to at least90days after terminal completion.
There is no automatic bulk purge of existing checkpoints. Never delete active/
resumable checkpoint threads. OSS support and
unsupported enterprise automation are distinguished in the runbooks.

## Validation and rollback

`pnpm check`, `pnpm build:web`, and Playwright cover offline behavior. `pnpm test`
splits ordinary CommonJS/Nest tests from real OTel-export tests: Jest29 needs VM
modules for the latter, while Nest12's ESM wrapper is bridged only inside tests.
Production uses native modules. Synthetic full-stack smoke/load commands and their
frozen numeric thresholds are in [load evidence](framework-load-evidence.md).

The local branch is `feat/framework-migration`, starting at `ee9f55c`. Rollback is a
separate checkout of that Git baseline plus its compatible, explicitly selected
configuration; no long-lived runtime legacy toggle is retained. The migrations are
additive. Do not reset shared history, delete existing volumes or automatically
roll back a research database. Actual GPU/model quality and production capacity
require fresh live gates; prior PoC numbers are not evidence for this migration.

## Explicit residual acceptance gaps

- This transition validates synthetic behavior, not real-model response quality,
  GPU capacity, private historical imports or a production deployment.
- A successful non-billable model result lost before its durable task receipt can
  execute again after recovery. Checkpoints alone do not imply exactly-once billing;
  billable ambiguous receipts independently refuse automatic resubmission.
- Rules-only input screening is weaker than configured Jev coverage. Jev remains
  optional and paid/data gated; its generation spans record only reported receipt
  usage/cost, not fabricated costs or proof of a second transport submission.
- No real embedding transport is configured by this migration. LiteLLM serving
  uses the explicit lexical method instead of comparing real vectors with fake
  embeddings; semantic acceptance requires a compatible approved embedder.
- Legacy/unlinked provider receipts are excluded from automatic 90-day scrubbing
  until their scope can be established safely. Accounting/idempotency tombstones
  survive raw-receipt deletion. Backup schedules and physical object-version
  erasure remain operator responsibilities, not claims of OSS enterprise features.
- Queue attempt exhaustion commits terminal `WORKER_LOST` safely, but the current
  claim/repair return contract does not expose that outcome to the maintenance
  failure counter or immediate PubSub notice. SSE observes the terminal DB state
  on its bounded poll (5s normally, 1s when degraded); failure counters may
  undercount this path. Stale-CAS rejection must not be miscounted as a failure.
- The performance thresholds were frozen after implementation edits, before the
  first measurement, contrary to the original P0 ordering. The first throughput
  failure and unchanged subsequent results remain in the load evidence; neither
  the old PoC performance nor synthetic model output proves a live quality gate.
