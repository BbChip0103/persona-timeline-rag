# Framework migration coverage

This is a capability/operations map, not a claim that a production deployment or
quality/performance qualification has completed. Synthetic tests must not import
private source material or human-review rows.

| Capability | Current owner and boundary | Qualification |
|---|---|---|
| Admission, session/message truth, outbox, fencing, authoritative Complete CAS | Nest backend; `app` schema and app-role credentials | Actual isolated PG and Nest→Python crash-recovery smoke |
| Queue delivery, lease renewal, cancellation, receipt replay and ACK | BullMQ Python worker; bounded receipt I/O and token/control watcher | Actual queue, immutable ACK recovery, real Psycopg cancellation tests |
| Model execution and local routing | Direct local vLLM provider; Kubernetes local routing/admission through EPP/InferencePool; optional worker-only direct OpenRouter spillover | Direct-provider tests, EPP/engine kind checks, worker spillover checks and no-resubmission ledger tests |
| Turn/agent orchestration and call-only checkpointing | Native LangGraph; ephemeral context, no per-stage history checkpoints | Native call tests and actual native PostgreSQL saver tests |
| Retrieval, embeddings and prompts | Native LangChain algorithms with read-only scoped adapters | Native-call spies, ordering/provenance/privacy/byte-budget regressions; see [component boundaries](langchain-components.md) |
| Input/output validation | Actual Guardrails SDK inline in Python, plus strict project provenance/JSON policy | Synthetic input/output/authentication regressions; a separate Guardrails service is not required by this default path |
| Paid consent, immutable accounting and unknown no-resubmit | Durable Python ledger plus provider key credit limit by default (explicit skip relies on account-level limits); paid OpenRouter requires live/data consent and verified pricing | Mock-transport fresh/replay/unknown tests; nonbillable runtime is restricted to local vLLM |
| Tracking | Langfuse v4 application observations, usage and reported receipt cost for OpenRouter/Jev | Redacted synthetic observation tests; unknown cost is not reported as zero |
| Evaluations and experiment review queues | Native Langfuse dataset experiments and annotation APIs | Synthetic SDK/API tests; explicit existing-dataset runs pin native UTC dataset versions |
| Approved source preparation/import | Explicit offline split-owner CLI; original screening/split/hash policies, authored protection and atomic qualified SQL | Actual disposable PG rollback/identity/provenance and DB-free CLI dry-run; see [preparation](split-source-preparation.md) |
| Weekly local and native central review | Read-only sampler plus separately approved masked final-turn review copies; native independent traces/annotation queues, durable unknown journal | Actual synthetic SDK IDs/source clock/queue readback and owned trace deletion; never open real review sheets during verification |
| Split raw recovery-data retention | Explicit `ptr-llm retention`, default dry-run; separate owner-only daily scheduler configuration | Disposable PG tests and local user-timer trigger; no owner credentials in serving services; see [maintenance](../infra/split/maintenance/README.md) |

## Safety/default parity

- Local vLLM input defaults to 65536 bytes; direct OpenRouter defaults to 32768.
  Explicit operator limits still win. Jev intent/safety defaults are independently
  1500/2500 ms, intent confidence 0.6; validated overrides are supported.
- Nonbillable local serving uses only the approved local provider configuration.
  Billable startup requires both live and external-data consent before a paid
  OpenRouter client is opened.
- Ambient native SDK callbacks, LangSmith tracing and ChatOpenAI cache are not
  alternate raw-data stores. Invocation isolation is task-local; unsupported global
  SDK debug/verbose or environment-created callbacks fail closed. Global SDK
  configuration must remain stable during each call.
- Bootstrap is explicit owner maintenance, not startup DDL. It creates native
  saver tables and split upgrades before checking serving-role denials.
- API `/api/health` is dependency liveness, not proof of every schema/cutover
  condition. Worker readiness additionally performs schema/role/config preflight.

## Remaining operational or migration boundaries

1. **Preparation is not embedding/index activation.** [The split-owner importer](split-source-preparation.md) now preserves screening, chronological split, immutable provenance and authored definitions in one transaction. It makes no model/embedding calls, and does not activate a summary/vector index. Existing batches remain immutable; changing a previously imported batch is not an incremental append operation.
2. **Langfuse dataset deletion is not historical erasure.** In pinned v4.56,
   deleting an item creates a version tombstone; prior input/output versions remain.
   Dataset/audit data is outside automatic project retention. The maintenance
   script blocks dataset deletion without explicit logical-deletion opt-in and
   always reports `historicalDatasetErasureVerified: false`. Do not use an empty
   latest listing as 90-day erasure evidence, or hand-edit the Langfuse database.
   See [pinned implementation](https://github.com/langfuse/langfuse/blob/v4.56.0/packages/shared/src/server/repositories/dataset-items.ts#L501-L579),
   [versioning](https://langfuse.com/docs/evaluation/experiments/datasets#versioning),
   and [retention scope](https://langfuse.com/docs/administration/data-retention).
3. **Schedules are explicit deployments, not serving defaults.** Separate owner-only daily retention and weekly review units are available and qualified in a local user manager. Timer/service activation, exact project/queue scope, private config and unattended host persistence must be checked on each deployment. A user manager without linger does not promise logout/reboot availability. Bounded batches and unknown/orphan deferrals do not establish complete backlog/backup erasure.
4. **Central review is an explicit content-copy opt-in.** Native independent review traces preserve source completion time, not a fresh retention clock, and link actual SDK IDs to queues. They are not original model root traces or new model executions. Masking is not anonymization; private content export requires its own approval and active applying retention scope. Default runtime raw tracing stays off; local weekly sheets remain. An empty eligible population is a scheduler skip, not a completed human review.
5. **Real-model and routing performance are separate qualifications.** An isolated actual vLLM engine has been qualified with cached weights, native cache counters, concurrent GPU execution and meaningful-content streaming TTFT. Four matched original/current/split triplets also passed the predeclared small-sample gate with equivalent effective inputs, identical owned fixtures and controlled cache state; split/original and split/current throughput ratios both had a median of approximately 1.00. See [the bounded qualification contract](vllm-qualification.md). This is not a multi-engine routing benefit, a 32-turn gate replacement or a production QPS claim. Synthetic multi-proxy tests prove routing policy contracts, not their production performance benefit.

The optional split CI job qualifies disposable runner-owned PG/Redis and source
runtime paths. It is not evidence of a successful GitHub-hosted run until that run
has actually happened. Independent backend/worker images must also pass their
packaging/startup probes and bounded end-to-end execution on the selected tags.
