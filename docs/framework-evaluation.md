# Framework observability, evaluation and human review

## Contract and versions

- Langfuse **server v4** is distinct from the JS SDK version. This migration uses
  server **4.56.0** (both published web/worker images, pinned by infra),
  `@langfuse/{client,otel,tracing}` **5.13.1**, OTel API **1.9.0** and Node SDK
  **0.223.0**, Node >=20. SDK packages have identical versions in the lockfile.
- Trace creation is native OTel via `LangfuseSpanProcessor` and SDK observations.
  `x-langfuse-ingestion-version: 4` is explicitly configured. No homegrown trace
  ingestion format or legacy trace-create batch events are used.
- Read tracing data via Observations API v2. Deprecated v3 trace, observation,
  dataset-run and score reads must not be used to prove a v4 integration works.
- The installed official SDK's `dataset.runExperiment()` **still sends a
  compatibility POST to `/api/public/dataset-run-items`**, then emits the v4
  experiment attributes through OTel. This compatibility write is documented
  upstream; it is not the canonical v4 read path. Do not replace this with a
  custom experiment engine or pretend the SDK emits no compatibility writes.

Official references: [SDK setup and compatibility](https://langfuse.com/docs/observability/sdk/overview),
[experiments](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk),
[v4 endpoint migration](https://langfuse.com/faq/all/deprecated-api-migration),
[v4 self-hosted upgrade](https://langfuse.com/self-hosting/upgrade/upgrade-guides/upgrade-v3-to-v4).

## Runtime tracing and privacy

Create one `FrameworkTelemetry` per API/worker process, before loading modules
that need tracing. Wrap each turn with `.turn(context, task)`, graph nodes with
`.stage(staticName, task)` and model calls with `.generation(staticName, task)`.
Generation updates carry model, input/output token usage and cost. Domain
errors remain visible to the caller but their raw exception text is not exported.

Configuration is explicit: `enabled`, `baseUrl`, project `publicKey`/`secretKey`,
`environment`, `release`, `captureContent`, bounded `timeoutMs` (default 2000).
There is no default cloud endpoint when enabled. HTTPS is required; only
explicit test/internal-container HTTP may use `allowInsecureLocal` for loopback
or `langfuse-web`. Never ship project secret keys to the browser.

The application default is content capture **off**: authored input/output is
omitted. Pass sanitized outcome counters via `span.update({metadata: summary})`
inside the turn callback; this preserves lifecycle/version/outcome/cost/latency for
all turns. Evaluation CLI explicitly opts into content capture against the
private self-hosted project. Secret keys, auth/cookies, raw evidence/images,
base64 media, token patterns, email and phone patterns are redacted; IDs are
pseudonymized and media auto-upload is disabled. Redaction is defense in depth,
not a guarantee that arbitrary free-form personal information is detectable.
Do not deliberately pass secrets or full private RAG source material as metadata.

The SDK uses OTel's bounded batch queue; no per-turn export awaits are added.
Shutdown/CLI flush has a bounded deadline and reports failure/timeout counts.
Diagnostics expose **authored redacted payload bytes**, observation count and
turn count, not exact wire bytes, database growth or a production SLO.
Export outage may drop telemetry instead of blocking chat indefinitely. Alert
on collector/export errors and SDK dropped-span diagnostics as well as the
application's flush failures; a queued span is not proof of server persistence.
Server deployment sets `TELEMETRY_ENABLED=false`; do not add an enterprise
license merely to get retention because licensed instances still report
telemetry according to upstream policy.

## Dataset import

```sh
# Generated local/synthetic configuration only; no original research env copied.
pnpm exec tsx scripts/framework-evaluate.ts \
  --dataset ptr-synthetic-regression --run synthetic-v1 \
  --review-queue ptr-synthetic-review
```

`LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` are required.
`LANGFUSE_ALLOW_LOCAL_HTTP=true` is only for the isolated loopback test stack.
CLI overrides `LANGFUSE_TRACING_ENVIRONMENT` and `FRAMEWORK_RELEASE` identify the run;
otherwise shared app labels `PTR_ENVIRONMENT` and `PTR_RELEASE` are reused.
The app uses `PTR_LANGFUSE_ENABLED=1`, `PTR_LANGFUSE_LOCAL=1` for the isolated
stack and `PTR_LANGFUSE_CAPTURE_CONTENT=0` by default. The evaluation CLI
explicitly captures redacted case IO; it does not turn on app content capture.
`PTR_LANGFUSE_LOCAL=1` is accepted by the CLI as the shared local flag too.
Only counts/IDs and versioned synthetic results are printed, not full examples.

The default input has two synthetic language fixtures and makes **zero model
calls**. A real application regression is supplied by an existing-repo module:

```ts
// Local module passed as --task ./scripts/my-app-experiment.ts
export const task = async (item: { input: unknown }) => runExistingApp(item.input);
export const evaluators = [existingDomainEvaluator];
export const scorePolicy = existingDomainScorePolicy; // rules + expected(input) counts
```

The CLI dynamically imports the explicitly supplied module; do not pass an
untrusted module. It must export `task`, non-empty `evaluators` and `scorePolicy`. Use the same
app/core functions and existing rubric instead of duplicating production
policies in the CLI. Multi-turn, RAG comparisons and model conditions belong in
that injected application task. No evaluation-specific server or worker is
introduced. Concurrency defaults to one and task/evaluator failures fail CI,
including failed cases. `scorePolicy.rules` declares finite numeric ranges and
explicit pass ranges, or categorical accepted/pass values. `expected(input)`
declares exact per-case metric names and multiplicity, validated before model
calls. Empty, omitted, duplicate, unknown, out-of-range, NaN and malformed
results cannot pass. Task/evaluator exceptions fail closed. The official SDK
score flush swallows transport errors, so the runner additionally verifies
reported name/value/type multiplicities through native Scores v3 reads (bounded
20-second global deadline, configurable up to120 seconds) before success;
queued scores alone cannot pass. The synthetic
default policy is exact_match 0..1/pass1; original 0..2 or categorical policies
may be supplied explicitly without changing the original scale.

Approved historical export schema:

```json
{
  "source": "approved-private",
  "revision": "original-case-set-revision",
  "cases": [{
    "id": "original-case-id",
    "input": {"syntheticExampleOnly": true},
    "expectedOutput": "synthetic expectation",
    "rubric": {"revision": "original-rubric-revision"},
    "historical": {
      "originalRunAt": "2026-01-01T00:00:00.000Z",
      "originalVersion": "original-code-model-prompt-revision",
      "output": "synthetic archived result",
      "scores": [{"name": "persona_fidelity", "value": 1}],
      "status": "COMPLETED"
    }
  }]
}
```

For an operator-approved import, pass `--private-file /explicit/owner-only.json
--approval approved-private-import --dataset exact-private-dataset`. The loader
requires a <=16MiB regular owner-only file and explicit provenance; it never
searches or opens `reports/review/`, S8 output, research DB or `.env` itself.
Without `--task`, private-file mode **imports only**, never runs a model.
No actual private material has been read/imported by the agent.

Dataset item IDs are deterministic by dataset/revision/case ID; repeat imports
upsert the same item. Old revisions remain separate. Linked historical
`sourceTraceId` values get deterministic-ID native scores; old version/time and
reviewer provenance are metadata, not new evaluation timestamps. Rows without
a trace ID remain in `historicalArchive` on their dataset item with output,
scores, status and explicit `notANewExecution`. They **cannot become native
completed trace annotations** without a real trace mapping; the importer does
not fabricate new model runs or impersonate old reviewers. Retain this gap in
migration reporting rather than claiming all CSV rows became native traces.
Serialize administrative imports: public APIs do not provide a transaction
across dataset, score config and queue creation; parallel creators can race.

## Human review

`ensureHumanReview` creates/reuses score configs (`persona_fidelity`,
`evidence_match`, `language_match`, `safety`, 0..1), checks rubric compatibility,
and creates/reuses one named Annotation Queue. Duplicate/ambiguous configs or
queues fail closed. `enqueueHumanReview` maps resulting trace IDs to queue
objects; repeated serialized imports do not create duplicate targets.

Reviewers log into the private Langfuse UI, open the assigned queue, inspect
input/output and linked evidence metadata, enter rubric scores/comments and
complete the item. Queue assignment is managed by Langfuse admins (or supported
`annotationQueues.createQueueAssignment` API using an existing Langfuse user
ID). Do not create reviewer accounts with guessed credentials.

`recordHumanReview` is available to approved integrations: it verifies the queue
item's trace target and requires all configured rubric dimensions, awaits stable-ID score API acknowledgements, then marks
that exact item complete. The native UI is preferred when native human reviewer
identity is important; the supported public score API can set `source=ANNOTATION` for queue
prefill but does not impersonate an authenticated UI annotation author.
This helper uses that supported source and requires acknowledged score writes
before marking completion; a failed score write leaves the item pending.

References: [Score configs](https://langfuse.com/docs/evaluation/score-configs),
[Annotation Queues](https://langfuse.com/docs/evaluation/evaluation-methods/annotation-queues),
[public API reference](https://api.reference.langfuse.com/).

## 90-day deletion (OSS)

Automatic project Data Retention is **Enterprise Edition** for self-hosted,
not an OSS switch. This repo instead provides a scheduled, dry-run-first CLI
using supported OSS public APIs. Run separately for each managed environment
(including the SDK experiment environment) and explicitly named datasets/queues.
The start is the beginning of managed history, not a guessed empty-month bound.

```sh
pnpm exec tsx scripts/framework-retention.ts \
  --environment synthetic --from 2025-01-01T00:00:00.000Z \
  --dataset exact-managed-dataset --queue exact-managed-queue-id
# After scope review, scheduled invocation uses project-specific confirmation:
pnpm exec tsx scripts/framework-retention.ts \
  --environment synthetic --from 2025-01-01T00:00:00.000Z \
  --dataset exact-managed-dataset --queue exact-managed-queue-id \
  --apply --confirm-project exact-project-id
```

A single project-scoped credential is mandatory. Default dry-run is GET-only;
apply requires exact project ID confirmation. Minimum retention is 90 days.
The CLI enumerates an entire bounded inventory **before any deletion**; limit
breach or scope mismatch aborts with zero writes. Observations v2 is read with
fixed time cutoff, logical-root filter, environment scope and cursor pagination.
Trace IDs are deduplicated and submitted in batches of <=1000 to
`DELETE /api/public/traces`. This removes linked observations/scores through
Langfuse. Named queue items and saved dataset content are separately deleted
via supported item APIs. Historical imports retain their original retention
clock, so reimport does not make old raw content young again. No deprecated
`DELETE /datasets/:name/runs/:run` calls or direct ClickHouse/Postgres mutations.

**Deletion submitted is not proof of immediate physical erasure.** Langfuse
processing is asynchronous. Re-query after worker completion and monitor its
errors. Do not shorten policy or include shared/unmanaged datasets to make a
test pass. Dataset version/history and media cleanup must be audited on the
pinned server as part of deployment acceptance.

Storage scope beyond the CLI:

| Scope | Required deletion/retention control |
|---|---|
| Trace/observation/score rows | Scheduled project/environment CLI + server workers |
| Saved dataset raw values / annotations | Explicit named dataset/queue item deletion |
| Uploaded blobs/media and temporary export blobs | Dedicated bucket/prefix expiration, <=90-day policy consistent with product retention |
| Versioned object non-current data and delete markers | Non-current version expiration + expired marker cleanup, not DeleteObject alone |
| ClickHouse system logs | Admin-defined system-log TTL; not trace API retention |
| DB/object backups, snapshots, replicas and private import exports | Separate backup rotation/expiry with maximum90-day content horizon, deletion verification and access audit |
| Old experiment comparison names/configs | Metadata only; no private raw payload in run names/versions |

A bucket lifecycle is not a substitute for DB/API deletion, and the CLI is not
a substitute for expiring backups/object versions. In production schedule all
controls and record deletion lag/failure alerts. Saved dataset media is excluded
from the upstream automatic event-retention policy, so it must be included in
explicit dataset/blob lifecycle scopes here.

References: [Data Retention availability and exclusions](https://langfuse.com/docs/administration/data-retention),
[Data Deletion](https://langfuse.com/docs/administration/data-deletion),
[hardening and telemetry](https://langfuse.com/self-hosting/configuration/hardening).

## Validation and capacity inputs

```sh
NODE_OPTIONS='--experimental-vm-modules --max-old-space-size=8192' \
  pnpm exec jest --runInBand packages/ops/test/langfuse.test.ts \
  scripts/framework-evaluate.test.ts scripts/framework-retention.test.ts \
  scripts/framework-app-experiment.test.ts
```

Jest29 needs VM modules for the current OTel transport's dynamic Node HTTP
import; normal Node/tsx does not need that flag. `pnpm test` runs the ordinary
repository suite first, excluding exactly `packages/ops/test/langfuse.test.ts`
and `scripts/framework-evaluate.test.ts`, then runs both real-exporter suites
via `pnpm test:otel` with the VM flag. Neither exporter suite is skipped or
replaced by mocks; the experiment suite also owns a real telemetry instance.
Keep new tests that actually export OTel traces in this explicit lane. Tests use the actual JS/OTel
SDK and generated REST client against a local synthetic receiver, not mocked
SDK functions. They verify nesting/model usage/cost, v4 header, redaction,
nonblocking outage, idempotent datasets/score configs/review targets, historical
provenance, correct-target review completion, private import permissions, scoped
dry-run and retention deletes. A fake receiver proves protocol behavior but
not actual Langfuse storage, UI or deployment capacity: the isolated real-server
smoke is a separate gate.

For capacity planning collect average/peak turns/sec, observations/turn,
authored bytes/turn and collector wire bytes, ingestion queue backlog, S3 and
ClickHouse growth, API/UI p95/p99 query latency, judge sample percentage and
latency/cost, backup multiplier and measured90-day steady-state. Compute
`dailyObservations = dailyTurns * observationsPerTurn`; no current development
machine size or old PoC throughput is a new production measurement.

### Existing-app regression adapter (not the hello fixture)

The real-app task is `scripts/framework-app-experiment.ts`, exporting `task`,
`evaluators` and `scorePolicy`. First import a **versioned app-case dataset**, then run:

```sh
# Explicit local synthetic API URL, synthetic owner token and deployed model revision.
# Tokens are inherited privately from generated test configuration, never in cases.
PTR_FRAMEWORK_EVAL_API_URL=http://127.0.0.1:PORT \
PTR_FRAMEWORK_EVAL_TOKEN="$GENERATED_SYNTHETIC_API_TOKEN" \
PTR_FRAMEWORK_EVAL_MODEL_REVISION=primary \
PTR_FRAMEWORK_EVAL_SYNTHETIC=true \
  pnpm exec tsx scripts/framework-evaluate.ts --existing-dataset \
  --dataset exact-versioned-app-dataset --cases-revision original-case-revision \
  --task ./scripts/framework-app-experiment.ts --run exact-code-model-prompt-run
```

`--existing-dataset` does not append the default hello fixtures. API hosts must
be explicit numeric loopback, redirects are rejected, token stays in request
headers, generated synthetic owners isolate sessions, one API session is used
for each evolving conversation, and failed/unknown turns are never resubmitted.
Timeout cancellation addresses only that task's turn. A model-condition change
requires a separately configured app deployment with the pinned model revision;
`primary` is accepted only under explicit synthetic mode for the isolated
LiteLLM route backed by the fake engine (not a declaration that any primary
route is free). Other synthetic revisions begin with `synthetic/` or `fake`;
this runner cannot assert an unexposed deployment model/code version by HTTP.

Case input contains binding/persona revision, timezone, retrieval algorithm,
RAG condition, history kind, user turns, permitted sources and code/prompt/model/
case/rubric revisions. Only user text and already-authorized intent/timeline
fields go to the chat endpoint; gold, expected output, hidden rubric, source
corpus and evaluator expectations never become model user input.

- `migrateNaturalCaseRegistry()` preserves the original frozen32-conversation
  definitions, targets, original rubric (including0/1/2 human scale), revision,
  as-of, silver status and limitations, across off/caption/caption-image.
  Its explicit method argument selects supported lexical (default) or semantic
  with a distinct method revision. Original case/rubric revisions do not change
  to pretend the new retrieval algorithm or prompt is the old experiment.
- `migrateLegacyCaseRegistry()` preserves50 cases across off/lexical/semantic
  and12 five-turn scenarios across fixed/evolving history (222 chat trials).
  `migrateLegacyExtractionRegistry()` separately converts all50 original
  extraction definitions with explicit source objects and original prompt
  revision. `createExtractionTask(existingProvider)` executes the exact shared
  original `EXTRACTION_SYSTEM_PROMPT` and `validateExtractionCandidate`, with
  `extractionEvaluator`/`extractionScorePolicy` providing schema and exact-date
  surface gates. Candidate results still have correctnessAccuracy=null and
  humanReview=pending: this is not extraction truth or human approval. Chat
  cases also archive the original extraction definitions for provenance.
- Registry conversion is a function over explicit operator-approved objects;
  it does not open original data/report files or mutate the corpus.

Scoring reuses current core quote validation, original source-recall function,
S8 language/leak helpers and domain credential/path checks. It checks completed
turns, exact person/persona binding, visible language, off/annotation isolation,
cross-person citations, quote binding, fixed gold recall and explicitly supplied
silver status expectations. Quote matching is not entailment; automatic counts
are not the original nuanced human quality score.

Public API intentionally hides input-safety/reply-guard details and call counts.
It exposes final `promptEvidence.sourceIds`, which are measured separately as
`prompt_gold_coverage`; this is not raw retrievaltop5 recall. Original legacy
cases require `requireRetrievalTrace` and the concrete core adapter captures
the existing retrieval port's top5 IDs for `source_recall_at5`. Missing raw
retrieval observations fail that gate. Natural chat permits validated reused
context and uses prompt coverage without falsely requiring a new lookup.
The result labels `guardCoverage=public-dto-hidden`; a requested internal-guard
coverage gate fails instead of inventing a pass. `createAppTask(existingRuntime)`
can be injected into the same CLI with fixed-history support/internal ChatReply
outcomes. `createCoreAppExperiment({core,modelRevision,executionProfile})` is
a concrete adapter: it uses the existing ChatService/LangGraph/local queued
execution, original store ownership/lease/fencing and domain validators. Only
the history store port is adapted for frozen assistant history (same original
harness semantics); evolving cases use normal committed history. It rejects
concurrent cases and resets the frozen history after each case. Supply the
existing repositories/turn-provider/ledger/Guardrails in `core` (the turn provider
may checkpoint expensive calls; stage graphs do not), then
close the returned adapter; no independent evaluation service is added. Frozen assistant history cannot be created by replaying fresh model
answers through the public API: fixed-history requests fail unless an existing
in-process runtime supports that exact contract. These are explicit coverage
boundaries, not new privileged public endpoints.

For original human rubrics, pass original `ReviewDimension[]` to
`ensureHumanReview(client, queueName, dimensions)`.
`naturalReviewDimensions(originalTestset)` supplies the original named rubric
with its descriptions and 0..2 scale (excluding the scale description itself). Existing config ranges must
match exactly; e.g. original0/1/2 stays0..2 rather than silently changing to0..1.
The default four0..1 dimensions are only a synthetic regression rubric.
Pass the same dimensions as `runFrameworkExperiment.reviewDimensions` (or
export `reviewDimensions` from the injected CLI module) when using a custom queue.
`recordHumanReview` requires every configured dimension once and validates
numeric ranges/names against actual Score Configs before completing an item.

### Real isolated server evidence (2026-10-10)

On the newly generated synthetic six-service Langfuse **4.56.0** stack:

- Official SDK dataset experiment completed2 cases with0 failed/missing scores;
  Observations v2 read confirmed2 persisted spans, Scores v3 read confirmed2
  scores, and the experiment run metadata was visible. The SDK's actual
  experiment environment is **`sdk-experiment`**; schedule retention for it too.
- Targeted review completion acknowledged all four original configured score
  writes and marked only that queue item COMPLETED. A later Scores v3 read
  confirmed4 persisted `ANNOTATION` scores (initial read was eventually stale).
- A deliberately aged synthetic fixture in separate `synthetic-retention`
  scope produced dry-run inventory1 trace/1 dataset item/1 review item with no
  mutation; confirmed supported deletion then yielded post-read0/0/0.
- CLI injection of an explicit temporary synthetic task module completed2
  cases0fail without model calls; current injected modules additionally require
  explicit scorePolicy (covered by regression tests).

These are isolated **synthetic framework/API/storage** results, not real-model
quality, GPU throughput, actual private historical import or human endorsement.

The isolated full-stack application smoke additionally passed one real HTTP
application experiment through NestJS/BullMQ/LangGraph, Guardrails and the
configured synthetic LiteLLM proxy: 1 case, 0 failed/missing scores, 0 task
failures, 1 experiment trace and 1 fake-engine model submission, with a native
review queue. This is an application/framework transport gate, not a paid model
quality experiment. The full smoke's UI, worker, graph and native v4 tracing
checks passed all23 gates. The latest strict CLI hello experiment also passed
2 cases with native Scores v3 persistence readback, not just SDK flush success.
