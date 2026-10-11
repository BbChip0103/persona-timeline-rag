# Split runtime and non-destructive cutover

The default application runtime is now Nest → Python → LiteLLM/model serving.
The gateway's [engine routing](gateway-routing.md) preserves cache-affinity,
selectable cost scoring and background vLLM overload filtering through a pinned
LiteLLM Proxy extension; these policies do not live in the Python chat worker.
The historical TS worker is retired; the API rejects `PTR_LLM_SERVICE_MODE=legacy`.
See `apps/llm-service/README.md` for native Python
experiments, reviews, ingestion and persona commands.

## Ownership

| Owner | Storage / responsibility |
|---|---|
| Nest / `ptr_split_app` | `app.sessions/turns/messages/turn_outbox/turn_leases/turn_execution_grants`; auth, admission, queue reconciliation, immutable grant, generation fence, atomic final commit |
| Python / `ptr_split_llm` | `llm.personas/persona_versions/source_*`, provider ledger, call-only Python checkpoints, result receipts; retrieval, prompts, LangGraph, inline Guardrails/Jev, Langfuse v4 and domain evaluation |
| model serving | LiteLLM routing and existing GPU/provider; no access to app/LLM database credentials |
| migration / `ptr_split_owner` | new-target DDL and explicit native saver setup; never a running service credential |

BullMQ renews queue locks. Nest validates the current Redis token **after** obtaining
its PostgreSQL turn row lock. Each new acquisition gets a fenced generation.
Python checks owner/status before each costly call; expiry stops models, not failure
reporting/exact durable ACK retries. The backend owns the result truth. A current
holder's successful result that crosses its deadline during receipt/row-lock work
becomes terminal `TURN_TIMEOUT`, without publishing a reply or redispatching a model.
Cancellation/lost tokens cannot publish. Delivery is at-least-once, not provider
exactly-once. Queue global concurrency is rejected; use local concurrency and replica
sizing. More than 100 prior messages fails `CONTEXT_LIMIT`, never silently truncates.

## Approved current persona publication

Set `PTR_LLM_PUBLISHED_PERSONAS_FILE` in the Python worker to an explicitly approved,
read-only JSON snapshot with exactly `{ "database": "ptr_split_research", "personas": [...] }`
(use `ptr_split_test` for an isolated test target). The database must match the worker
URL. This setting is exclusive: it does not load generated/authored defaults or choose
the latest imported variant. Mount only that file, not its private parent directory.

Without that setting, native Python preserves the historical registry merge:
`PTR_PERSONAS_FILE` (default `data/research/personas.json`) supplies a generated array;
only an explicitly set `PTR_AUTHORED_PERSONAS_FILE` adds an authored array or a strict
database-bound wrapper. Authored cards override the same `personId` in generated order;
authored-only people append in authored order. An existing default authored artifact is
not discovered automatically. Duplicate people/IDs within an input or conflicting IDs
in the merged selection fail closed.

At startup and on catalogue reads, selected cards must equal the canonical current DB
documents, including ID, person, revision and full normalized content. Missing/stale
cards, binding/content drift, malformed files and ambiguous JSON keys fail with sanitized
`PERSONA_UNAVAILABLE`; no partial catalogue, pointer repointing, DB imports or deletions
occur. Other imported variants stay stored but are not advertised. Changing the approval
file requires a worker restart; DB-current drift is checked again on each catalogue read.
Only the existing public projection crosses to the application backend.

This is a current catalogue/new-session admission policy, **not** an execution allowlist
for historical sessions. Existing sessions retain their pinned persona/revision lookup,
including variants no longer advertised. For isolated fake/synthetic compatibility only,
`PTR_LLM_PROVIDER=fake` (also the default) with all three registry settings unset retains
the existing DB catalogue behavior. Explicit empty registries publish no cards and never
fall back to imported variants. Real model providers do not use the fake unset exception.

## Environments and images

Copy `infra/split/backend.env.example` and `infra/split/llm.env.example` to **different**
private files (`chmod 600`), set new-role credentials and distinct tokens. Never reuse
the old all-in-one `.env.local` as both service envs. Backend/web get no model or
Langfuse secret. Python gets no app/owner DB password. Compose uses Linux host networking
and explicit loopback targets; this is a verified isolated deployment, not a cloud
capacity claim. Remote control endpoints require TLS; expose neither internal API
nor Redis publicly. Existing GPU can be reached via a private serving endpoint/tunnel.

```sh
PTR_FRAMEWORK_APP_ENV_FILE=/private/backend.env \
PTR_LLM_SERVICE_ENV_FILE=/private/llm.env \
docker compose -f infra/compose.app.yml config -q
# up/build only after new targets are migrated and both private files are checked.
```

Readiness validates runtime role/schema/budget prerequisites without DDL. Python's
health also checks database and worker queue liveness. API remains responsible for
outbox recovery while Python is down. Python has only read-only corpus mounts;
fictional draft artifacts are saved by Nest. Nest mounts only `data/generated`,
not the private source/persona corpus.

For semantic retrieval set an approved query embedding provider/revision in Python
and mirror `PTR_LLM_SEMANTIC_SEARCH=1` in Nest only when that capability is available.
Never compare real stored embeddings with synthetic hash vectors. Jev uses the same
bounded durable paid ledger as generation. Nonbillable self-host routes do not silently
fall back to paid APIs. Explicit billable LiteLLM additionally requires trusted
`PTR_LLM_PROMPT_USD_PER_M` / `PTR_LLM_COMPLETION_USD_PER_M` ceilings matching selected routes.

New RAG-enabled sessions and the UI search selector default to **semantic**.
If the backend has no semantic capability, default or explicit semantic session
creation fails with `SEMANTIC_UNAVAILABLE`; it never silently selects lexical.
Explicit lexical and RAG-off sessions remain supported, and existing sessions keep
their stored retrieval mode. RAG-off remains the initial experimental condition.
The current query embedder calls OpenRouter with `openai/text-embedding-3-small`,
explicitly requesting **1536 dimensions**, then compares against stored vectors with
the matching model revision using pgvector cosine distance. The search-mode default change alone introduces no new embedder or corpus
re-embedding; the optional summary-index build below is a separate operation. Approved runtime configuration requires
`PTR_LLM_EMBEDDING_PROVIDER=openrouter`,
`PTR_LLM_EMBEDDING_MODEL_REVISION=openai/text-embedding-3-small`, the existing OpenRouter
credentials/live/data-consent/budget gates, and the matching backend capability flag.
Example envs keep external calls disabled; changing the default does not enable paid
requests, change private deployment envs, or migrate existing sessions.

### Summary-only retrieval and evidence selection

The optional replacement index embeds **one three-line Korean summary per eligible
licensed post**, not concatenated caption/image annotation text. Summarization uses
the complete caption, all stored image descriptions and explicit location-tag names.
Known activity dates take precedence; otherwise the stored upload calendar date is
used without rewriting `eventDate` (the current stored uploads use UTC calendar dates). Missing information and explanations such as
“date unknown” or “shared via a caption” are omitted. Image hypotheses do not become
verified author intent. Summaries are generated retrieval aids, never quote evidence.

Apply `supabase/split/0003_post_summaries.sql` with the isolated migration owner after
a private backup. It adds immutable run manifests, summaries and 1536-dimensional
summary vectors, plus a single active-index pointer. Original corpus, annotations
and caption/image vectors remain untouched for rollback. Activation requires exact
eligible corpus coverage, current source/annotation bindings and a matching nonzero
vector for every summary. New/changed sources or annotations invalidate completeness;
summary mode never silently falls back to old vectors.

`ptr-llm summarize` defaults to a read-only dry run. Explicit execution requires a
private LLM-only env, approved external-data/provider flags, an additional cost cap
and an owner-only budget record. One live builder per database is enforced by a
session advisory lock. Both the run cap and existing durable global/migration cap
apply, including in-flight/unknown reservations; neither old ledger nor budget baseline
is reset. Original geotag metadata is bound to the immutable DB source hash. Only
the tag name is sent, not coordinates, tagged people or comments.

```sh
uv run --project apps/llm-service ptr-llm summarize \
  --env /private/llm-summary.env \
  --processed-posts /private/approved/target_posts.jsonl \
  --metadata-root /private/approved/instagram-subset \
  --run post-summary-v1
# For summaries authored directly in a Codex session, add:
# --summary-file /private/source-bound-summaries.jsonl
# Add only within an approved embedding run:
# --execute --max-usd 1 --budget-record /private/summary-budget.json --activate
```

All summaries are saved before the embedding phase. Stable full batches and durable
provider receipts support resume after partial DB writes; ambiguous submissions are
not retried. `--summary-file` imports session-authored text without calling a paid
summarizer, records `codex-session-direct` provenance and binds the artifact digest.
Its private JSONL must contain exactly one row per eligible source with `source_id`,
`source_hash`, `annotation_revision`, `annotation_hash` and `summary`. Every row is
validated before any embedding call, and all rows are saved to DB first. Original
source/annotation bindings survive the builder's refreshed source read; changed parents
fail before paid work. A resumed run without its existing budget record is rejected,
never silently rebased. The initial manifest membership must match exactly; per-source freshness is checked during import.
Direct-summary execution permits an embedding cap of at most US$1. Without that
option, the separately authorized provider-summary path uses the approved Gemma model.
Both paths use `openai/text-embedding-3-small` for vectors; runtime selection uses
`typesafe/jev-1.13`. An embedding authorization does not authorize paid Jev evaluation.
Exact three-line/date/location/length checks are structural guards, not factual-quality
certification. Do not start a new run/record to bypass a spent cap or unresolved request.

Enable the paired Python settings only after index validation:
`PTR_LLM_RETRIEVAL_INDEX=summary`, `PTR_LLM_EVIDENCE_SELECTOR=jev`, and the existing
approved OpenRouter query-embedding settings. Search gathers 10–20 candidates. Jev
judges which posts supply necessary/useful answer evidence, independently of a fixed
quota, and orders selected posts by relevance. Selection can return zero, one or more
than three posts. The provisional threshold is separately configurable with
`PTR_LLM_EVIDENCE_THRESHOLD` (default `0.7`); it is not a calibrated accuracy claim.
Size-bounded requests may require several Jev batches, each ownership/deadline fenced;
an invalid/missing answer fails closed, not a partial selection or fallback to all posts.

Summary-mode search uses the actual `langchain-classic` `MultiVectorRetriever`:
read-only scoped `VectorStore` → summary child Documents → SDK ordered parent-ID
deduplication → read-only `BaseStore.amget` → original caption/image Documents.
The SDK owns this retrieval orchestration; existing PostgreSQL policy SQL and the
metered query embedder remain custom. This is not a `PGVectorStore` collection
migration: no runtime DDL, vector copying or re-embedding is required. The normalized
summary/vector/parent tables do not directly map to its single-relation schema.
Missing/stale parents fail closed instead of the SDK default of dropping missing
entries. Invocation-local stores prevent concurrent person/run/filter leakage.

A small private retriever subclass calls the SDK's unchanged async retrieval hook
with a noop run manager. Its async entry point deliberately bypasses automatic SDK
callback configuration: even `callbacks=[]` can inherit global tracing/debug/hooks
and export original Documents. Standard raw-document callbacks/stream tracing are
not supported at this internal boundary; independent redacted application OTel is
unchanged. Ambient Runnable checkpoint/private metadata is detached and restored.
This migration is framework reuse, not a measured latency or accuracy improvement.

Candidate vectors and selector summaries are pinned to the same immutable run. Followups
resolve trusted prior references before loading full current parent evidence. Tool
searches also use selection. Off/creative/safety-deflected paths do not invoke it.
Answer generation still receives original captions and permitted image annotations,
not summary quotes. The fixed three-post prompt cap is lifted in selected mode, but
the existing 30KB total prompt budget remains; omitted evidence is tracked. Summary
mode requires semantic search, and refuses explicit lexical search rather than using
the old caption index. Legacy-index mode retains its old lexical/semantic behavior.

The full-post summary index uses images in retrieval for both `caption` and
`caption_image`; those conditions only control answer-evidence scope in this mode.
It must not be described as the historical no-image retrieval ablation. Use explicit
legacy-index mode when reproducing that older comparison.

## Migration / rollback

1. Provision a **new** isolated target `ptr_split_research` on loopback 58432 and separate
   owner/app/LLM login roles. Preinstall pgvector and owner-owned `public` schema. The
   supplied migration tool deliberately rejects other targets/source roles.
2. Drain original research turns. Export one read-only repeatable-read snapshot,
   save a private custom archive, restore that archive into the empty new target,
   and compare all table row counts/content digests.
3. Apply `supabase/split/0001_owner_partition.sql` as owner; preserve old TS saver tables
   under `llm.legacy_ts_*`, never deserialize them as native Python checkpoints.
   Compare partitioned contents before upgrades. `0002_receipt_scope.sql` adds nullable
   receipt-scope columns for older archives without rewriting original ledger values.
4. Explicitly run `setup_call_checkpoints(owner_database_url)` once as owner. Runtime
   users cannot create schemas/tables. Verify app↔LLM read/DDL denials.
5. Start independent images on selected private envs and verify API/browser, restart,
   durable ACK and synthetic functional gates before switching the public local UI.
6. Roll back by stopping **only** newly owned services and selecting the preserved
   historical runtime/source DB; do not merge newly generated dialogue back blindly.

```sh
PYTHONPATH=src uv run --project apps/llm-service python \
  -m persona_timeline_rag.split_migration \
  --source-env /private/original-research.env --target-env /private/new-roles.env \
  --private-output /private/new-copy-proof
# A repeated attempt refuses an existing archive/nonempty target, never overwrites.
```

Budget migration preserves all old actual/unknown/in-flight reservations and adds an
immutable **US$1 extra exposure cap** (RunPod excluded). Unknown submissions are never
automatically resubmitted. Do not reset the ledger/cap to make a test pass. Only successful
receipt bytes are checkpointed, not history/persona/evidence or cheap graph stages.
The detached one-node nonbillable call graph uses LangGraph `durability="exit"`: its
final receipt write must finish before returning success. This removes input/intermediate
step writes; it does not make receipt persistence fire-and-forget. A process crash before
that commit can repeat a nonbillable call, as before. Paid submission markers/unknown
reservations remain separate and are never automatically resubmitted. Existing three-row
Python sync receipts and preserved TS tables remain compatible/read-only respectively.
See [upstream durability modes](https://docs.langchain.com/oss/python/langgraph/checkpointers#durability-modes).

Outer turn/character graphs and the call graph are compiled once, with fresh ephemeral
invocation contexts. The LiteLLM SDK/HTTP connection pool is service-owned and explicitly
closed on shutdown; usage/deadline/cancellation hooks remain request-local. No global GC
disable/threshold tuning or reduced validation/tracing is used to meet the load gate.

## Worker-owned static-import heap

The dedicated synchronous worker entrypoint primes public SDK classes/schema before
creating its event loop, Settings, Runtime, clients, pools, tasks or jobs. On the pinned
CPython 3.13.5 default GC policy it collects import temporaries once, then freezes that
process-owned import generation. Newly created service/request objects remain under
normal automatic GC; the owned generation is unfrozen only after the loop/runtime closes.
Serve/evaluation/async-library paths do not alter GC. Pre-existing freeze, custom/disabled
GC, another running loop, unsupported Python, or an existing personal Guardrails RC skips
this optimization. No HOME/SDK/config monkeypatch, threshold tuning, per-turn collection,
validation reduction or trace disabling is part of this runtime policy.

Freezing mutable module caches can retain cycles into newer requests: it is not a general
library optimization. Revalidate memory and load behavior when changing the pinned SDKs.
The bounded synthetic proof compares baseline/candidate through 64 warm + 10,000 jobs,
actual test PG costly/result receipts, tools/errors/cancellation/deadlines/replay and
Langfuse observations. It samples at existing four-job barriers after natural generation2
GC (zero active jobs, at most four completed-job lag), with bounded observers, strict
per-window/relative numeric gates, request weakrefs and a retained-cycle negative control.
It does not prove indefinite lifetime or exporter/network/BullMQ retention. Ordinary
fixed-block traced memory is exploratory: GC sawtooth can fail those separate windows;
failed/invalid calibrations remain evidence, never retrospectively relabeled PASS.

## Reproducible checks

`pnpm check`, `pnpm llm:check`, `make check`, both image builds, actual PG control suite,
`scripts/split-smoke.py --browser`, and `scripts/split-loadtest.ts` are separate proof
surfaces. The load harness locks four matched O/C/P triplets, equal fixture outputs,
32 turns/8 clients/one worker/local concurrency4/100ms engine/16+12 tokens. Every triplet
must pass both predeclared throughput/p95 gates; failed/invalid runs remain artifacts.
The memory proof is independently reproducible against an **already bootstrapped synthetic**
`ptr_split_test` target; it refuses research/nonexact roles, existing output and nonprivate
credentials. It creates no DDL, paid/model network calls or private-corpus imports:

```sh
uv run --project apps/llm-service python scripts/split-memory-proof.py \
  --roles-env /absolute/private/new-test-roles.env \
  --output /tmp/ptr-split-memory-NEW
```

The CLI and pure safety/gate tests are checked in; the retained executed proof and portable
adapter share measured functions, but that is not a claim that every future installation
has already completed a full 10,000-job proof. Its instrumentation is outside the timed
load protocol. Local numbers do not predict production GPU throughput. Actual paid/GPU and Langfuse
checks must use narrowly selected approved endpoints, not unbounded corpus re-evaluation.

## Explicit split maintenance and CI

The Node `framework:checkpoints`, `framework:checkpoint-retention` and
`framework:receipt-retention` commands are **legacy/public-schema only**. They reject
split databases rather than operating on empty/wrong public tables. Use the native
owner-only commands below with an explicitly selected
`PTR_LLM_MAINTENANCE_DATABASE_URL` (loopback 58432, `ptr_split_owner`, exact split DB).
Do not put the maintenance owner credential in either running service env.

```sh
# Run from a separate, approved private maintenance environment; no automatic DDL.
uv run --project apps/llm-service ptr-llm checkpoint-setup
# Read-only plan/counts by default. Explicit application requires exact DB confirmation.
uv run --project apps/llm-service ptr-llm retention
uv run --project apps/llm-service ptr-llm retention \
  --apply --confirm-database ptr_split_test
```

Retention preserves provider accounting/idempotency tombstones and unresolved work;
missing historical bindings are reported as deferred, never inferred from body hashes.
It is an explicit maintenance operation, not a worker startup hook or an automatically
installed daily schedule. Langfuse/public API retention and external backup expiry are
separate boundaries; a local DB sweep does not prove erasure there.

For a **new synthetic** `ptr_split_test` with preprovisioned isolated roles/pgvector,
`scripts/split-bootstrap.py --roles-env /private/new-test-roles.env` applies the original
schema, partitions it, applies split receipt/summary upgrades, creates the **native Python
saver as owner**, then verifies runtime cross-schema/DDL denials. It rejects mismatched
runtime targets before connecting the owner and refuses an existing target. It does
not populate research data, activate a summary index, reset a ledger or repair an
existing deployment. Do not call `pnpm framework:checkpoints` afterward.

The `llm-service` workflow has a separate manual/main `split-integration` job. It creates
fresh runner-only PG/Redis and owner/app/LLM roles, runs this bootstrap, actual Python
PG/BullMQ suites, app-schema generation/fencing/ACK tests and Nest→Python cancellation,
RAG-off and crash-recovery smoke. It uses fake generation and no corpus/provider secrets.
Offline PR tests, two independent image builds and gateway routing qualification remain
separate checks. A passed CI invocation is not a GPU performance or real-answer-quality
qualification.

Backend `/api/health` is dependency **liveness** (`SELECT 1` + Redis `PING`), not proof
that all app migrations/permissions are ready. Python startup checks its role/schema/cap.
Use the split integration/bootstrap gates for cutover readiness, not just a green backend
health response.

`ptr-llm ingest` reuses licensed download/normalization tooling; it is not a new-source
DB importer. New approved source batches use the explicit offline owner-maintenance
[`pnpm prepare:split`](split-source-preparation.md) command. It reuses the original
screening/chronological split policy and atomically imports into qualified `llm` tables;
it does not call models, embed sources or activate a summary index. `prepare:research`
refuses split targets; historical TS preparation/index tools are legacy/public-schema
tools, not split import/index surfaces. Existing licensed data is copied by the explicit
split migration; do not point legacy scripts at split runtime credentials.
