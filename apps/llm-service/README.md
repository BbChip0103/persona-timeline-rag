# Python LLM application service

This is the independent orchestration worker, not the GPU inference server. Nest owns
sessions, input outbox, execution fencing and atomic final-message commit. Python owns
persona/source/vector retrieval, LangGraph, inline Guardrails/Jev, costly-call receipts,
paid ambiguity protection, Langfuse v4 and domain evaluation. It completes a queue job
only after Nest's durable commit ACK. Current model serving is direct local vLLM
for Compose, and local vLLM through EPP/InferencePool plus optional worker-only
direct OpenRouter spillover for Kubernetes. LiteLLM provider support is
historical and rejected for the active runtime.

```sh
uv sync --project apps/llm-service --locked
uv run --project apps/llm-service pytest
uv run --project apps/llm-service ruff check apps/llm-service/src apps/llm-service/tests
uv run --project apps/llm-service ptr-llm worker
uv run --project apps/llm-service ptr-llm serve
uv run --project apps/llm-service ptr-llm ingest --help
uv run --project apps/llm-service ptr-llm evaluate --review-queue ptr-synthetic-review
```

`ingest` directly imports the existing `persona_timeline_rag` Python package: algorithms
are not duplicated. Domain experiments use native Python Langfuse 4.17 experiments,
versioned datasets, score-v3 persistence readback, annotation queues and original rubrics.
The default `evaluate` executes two English/Korean synthetic boundary cases through the
actual Python `LLMEngine`, input/output Guardrails and domain rubric. It makes **zero
model/retrieval calls**, asserts eight policy/binding scores per case, and is not evidence
of real-model answer quality. Explicit model-enabled cases require a selected `--task`
module, case registry and budget/provider configuration; no private corpus is discovered.

`evaluation/domain.py` ports the existing TS domain registry adapters and original prompt:

- Natural registry: 32 conversations × three RAG modes = **96 trials**, preserving
  lexical/semantic method revisions, evaluator-only gold, timestamps and asset hashes.
- Legacy registry: 50 single turns × three modes plus 12 five-turn scenarios × three
  modes × fixed/evolving history = **222 trials**. Silver surrogate labels stay silver.
- Original caption extraction: **50 definitions** and exact prompt revision, caption
  quote/date surface checks and unreviewed status; no automatic accuracy claim.
- Original human naturalness/continuity dimensions remain **0..2**, not rescaled to 0..1.

The checked-in fixtures are fictional synthetic data generated with the original TS pure
adapters. They lock every converted case, rubric score/multiplicity and extraction surface;
they do not execute the original private 32/50 registries or replace human quality review.
App tasks reuse `create_core_app_task` and existing engine ports, including backend-equivalent
refused/lore-excluded history, persona language/greeting and fixed/evolving continuity.

An injected `--task package.module` exports `task`, `evaluators`, `score_policy` (explicit
metric multiplicity), and optionally `review_dimensions`. Alternatively async `setup()`
returns those fields and optional `close()`. Setup, application tasks/evaluators and close
stay on one owning loop, even though the native synchronous SDK batch runs off-thread.
Cancellation blocks further task/evaluator dispatch, cancels active callbacks and drains
the SDK thread **before** close/cancellation acknowledgement. Native REST/persistence
requests have finite deadlines; custom async callbacks must cooperate with cancellation.

Private imports require an explicitly selected owner-only regular export and
`--approval approved-private-import`; no reports/review scan or raw S8 import occurs.
Existing TS experimental/audit scripts remain explicitly legacy, not default LLM runtime.
Historical tracking already in the same existing Langfuse v4 project is retained **in
place**: switching the SDK language does not require duplicate imports. Foreign-instance
exports, when explicitly approved, retain original versions/timestamps/provenance;
unlinked historical results remain archives, never invented new traces. Verification
performed **zero private historical/human imports**.

## Environment and deployment boundary

Compose uses **separate** `PTR_FRAMEWORK_APP_ENV_FILE` (backend) and
`PTR_LLM_SERVICE_ENV_FILE` (Python), both explicit private files. Python must never
receive the backend DB credential. `PTR_LLM_DATABASE_URL` uses the llm-only runtime role;
backend uses the app-only role; DDL migrations require a separate owner credential.
Model keys and Langfuse project secrets live only in the Python env. Both roles need
queue/control credentials. No whole private env is baked/copied into either image.

The dedicated worker uses a conditional process-owned static-import GC phase before
its loop/client/job creation; normal request GC remains enabled and default thresholds
unchanged. Serve/evaluation/library paths do not freeze. See the current
[scope and revalidation contract](../../docs/python-llm-split.md#worker-owned-static-import-heap).

Worker env: `PTR_LLM_REDIS_URL`, `PTR_LLM_QUEUE_NAME=turns`, `PTR_LLM_QUEUE_PREFIX=ptr`,
`PTR_LLM_BACKEND_URL=http://127.0.0.1:56441`, `PTR_LLM_CONTROL_TOKEN`, `PTR_LLM_DATABASE_URL`,
`PTR_LLM_CONCURRENCY=4`, `PTR_LLM_HOST=127.0.0.1`, `PTR_LLM_PORT=58442`.
Use local worker concurrency only: BullMQ Python globalConcurrency liveness is not
supported by this deployment. Queue delivery is at-least-once, not upstream exactly-once.

`LANGFUSE_ENABLED=true` requires explicit `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`,
`LANGFUSE_SECRET_KEY`, `LANGFUSE_TRACING_ENVIRONMENT`, `FRAMEWORK_RELEASE`. Local HTTP
requires `LANGFUSE_ALLOW_LOCAL_HTTP=true`; remote endpoints require TLS. Content capture
is opt-in (`LANGFUSE_CAPTURE_CONTENT=true`) and secret/media redaction remains enabled.
No global `OTEL_SDK_DISABLED` switch: inline Guardrails must not disable application tracing.
SDK flush only proves a drain; evaluation additionally reads persisted scores via native v3.

Build independent image from repository root:

```sh
docker build -f apps/llm-service/Dockerfile -t ptr_llm:local .
```

Existing research data is preserved; migration copies to new app/llm schemas, verifies
backup restore, row hashes/revisions and paid ledger before switching. Never reset a
paid/ambiguous ledger to get a fresh budget. This work's added paid API usage+reserved
exposure is at most US$1 (existing RunPod excluded), with no automatic paid fallback.

## Persona publication and review

`ptr-llm persona validate|publish|restore <owner-only-json-file> --target
ptr_split_test|ptr_split_research` uses the shared persona domain validator. Validate/publish
require explicit `--sources-doc`, `--captions-file`, `--split-file`; generated/baseline
lists are optional. Publish/restore require explicit `--authored-list` and `--publish-log`.
`--confirm` is necessary for DB changes; a baseline exemption is verified against the
stored current version before confirmed publication. Imports/restore are one DB
transaction; authored lists retain other personas and bind the target database.
Artifacts are atomic owner-only JSON, and the publication log is an accumulating
**JSON array** (legacy TS JSONL logs are not silently parsed/reset). No private content
is printed; only validation rule codes/counts are reported.

Explicit annotation writes use:

```sh
uv run --project apps/llm-service ptr-llm review \
  --private-file /approved/owner-only-review.json --approval approved-review-write
```

The owner-only JSON has `source:"approved-review-api"`, `queueId`, `itemId`, `traceId`
and `scores:[{config_id,name,value,comment?}]`. The CLI reuses `record_human_review()`:
all configured original dimensions, matching trace/item binding and bounded finite
numeric values are validated **before any score write**. Queue completion follows
acknowledged writes. Output contains counts only; API annotations never impersonate a
human reviewer. This is not a raw human-sheet importer or automatic quality approval.

Upstream interfaces verified against installed SDK and official docs:
[Python SDK reference](https://python.reference.langfuse.com/langfuse),
[native experiments](https://langfuse.com/docs/evaluation/experiments/experiments-via-sdk),
[score query v3](https://langfuse.com/docs/api-and-data-platform/features/query-via-sdk).

Full owner-role provisioning/copy/rollback and nonsecret env templates: [split runbook](../../docs/python-llm-split.md).
Billable direct OpenRouter use requires explicit live/data approval, trusted
price ceilings and, by default, a configured provider key credit limit; missing or nonfinite
provider-side key limits fail startup in `required` mode. Explicit
`PTR_LLM_OPENROUTER_KEY_LIMIT_CHECK=skip` still authenticates the key and relies
on the US$1 ledger cap and account-level limits. Compose keeps `PTR_LLM_SPILLOVER=off` and carries no
OpenRouter key.

Native split owner operations are `ptr-llm checkpoint-setup` and `ptr-llm retention`.
Select `PTR_LLM_MAINTENANCE_DATABASE_URL` in a separate private maintenance environment;
never distribute an owner credential to a worker. Retention defaults to dry-run and
requires `--apply --confirm-database <exact split database>` to change storage. Legacy
Node checkpoint/receipt operations reject split targets. The [split maintenance and CI
contract](../../docs/python-llm-split.md#explicit-split-maintenance-and-ci) describes scope,
bootstrap, deferred historical bindings and actual opt-in PG/queue/Nest regression gates.
