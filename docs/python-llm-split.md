# Split runtime and non-destructive cutover

The default application runtime is now Nest → Python → LiteLLM/model serving.
The historical TS worker is explicit `PTR_LLM_SERVICE_MODE=legacy` and is not the
Compose/default deployment. See `apps/llm-service/README.md` for native Python
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
the matching model revision using pgvector cosine distance. No new embedder or corpus
re-embedding is introduced. Approved runtime configuration requires
`PTR_LLM_EMBEDDING_PROVIDER=openrouter`,
`PTR_LLM_EMBEDDING_MODEL_REVISION=openai/text-embedding-3-small`, the existing OpenRouter
credentials/live/data-consent/budget gates, and the matching backend capability flag.
Example envs keep external calls disabled; changing the default does not enable paid
requests, change private deployment envs, or migrate existing sessions.

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
