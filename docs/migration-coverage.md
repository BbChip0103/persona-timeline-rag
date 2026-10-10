# Framework migration coverage

This is a capability/operations map, not a claim that a production deployment or
quality/performance qualification has completed. Synthetic tests must not import
private source material or human-review rows.

| Capability | Current owner and boundary | Qualification |
|---|---|---|
| Admission, session/message truth, outbox, fencing, authoritative Complete CAS | Nest backend; `app` schema and app-role credentials | Actual isolated PG and Nest→Python crash-recovery smoke |
| Queue delivery, lease renewal, cancellation, receipt replay and ACK | BullMQ Python worker; bounded receipt I/O and token/control watcher | Actual queue, immutable ACK recovery, real Psycopg cancellation tests |
| Model execution and cache/state-aware routing | LiteLLM 1.104.2 with project routing callback and atomic shared Redis credits | Two actual proxies with synthetic engines, SSE/lease/auth/no-retry tests; existing research proxy mounts qualified |
| Turn/agent orchestration and call-only checkpointing | Native LangGraph; ephemeral context, no per-stage history checkpoints | Native call tests and actual native PostgreSQL saver tests |
| Retrieval, embeddings and prompts | Native LangChain algorithms with read-only scoped adapters | Native-call spies, ordering/provenance/privacy/byte-budget regressions; see [component boundaries](langchain-components.md) |
| Input/output validation | Actual Guardrails SDK inline in Python, plus strict project provenance/JSON policy | Synthetic input/output/authentication regressions; a separate Guardrails service is not required by this default path |
| Paid consent, immutable accounting and unknown no-resubmit | Durable Python ledger; billable aliases require live/data consent and verified pricing | Mock-transport fresh/replay/unknown tests; nonbillable runtime is restricted to `primary` |
| Tracking | Langfuse v4 application observations, usage and reported receipt cost for LiteLLM/OpenRouter/Jev | Redacted synthetic observation tests; unknown cost is not reported as zero |
| Evaluations and experiment review queues | Native Langfuse dataset experiments and annotation APIs | Synthetic SDK/API tests; explicit existing-dataset runs pin native UTC dataset versions |
| Weekly local review sheets | Explicit read-only maintenance path; masking, quotas and retention preserved | Synthetic-only sampler tests; never open real review sheets during agent verification |
| Split raw recovery-data retention | Explicit `ptr-llm retention` maintenance CLI, default dry-run | Disposable PG tests; serving credentials cannot run it; no automatic research purge |

## Safety/default parity

- LiteLLM input defaults to 65536 bytes; direct OpenRouter defaults to 32768.
  Explicit operator limits still win. Jev intent/safety defaults are independently
  1500/2500 ms, intent confidence 0.6; validated overrides are supported.
- Nonbillable LiteLLM uses only the approved `primary` runtime alias. Billable
  startup requires both live and external-data consent before a pool is opened.
- Ambient native SDK callbacks, LangSmith tracing and ChatOpenAI cache are not
  alternate raw-data stores. Invocation isolation is task-local; unsupported global
  SDK debug/verbose or environment-created callbacks fail closed. Global SDK
  configuration must remain stable during each call.
- Bootstrap is explicit owner maintenance, not startup DDL. It creates native
  saver tables and split upgrades before checking serving-role denials.
- API `/api/health` is dependency liveness, not proof of every schema/cutover
  condition. Worker readiness additionally performs schema/role/config preflight.

## Remaining operational or migration boundaries

1. **New licensed-source preparation/import is not ported.** Existing drained
   snapshot migration and corpus serving work, but legacy `prepare:research`
   cannot import into split schemas. It rejects split targets before reading
   private inputs. Python ingestion normalization is not a replacement for the
   immutable database preparation/import pipeline.
2. **Langfuse dataset deletion is not historical erasure.** In pinned v4.56,
   deleting an item creates a version tombstone; prior input/output versions remain.
   Dataset/audit data is outside automatic project retention. The maintenance
   script blocks dataset deletion without explicit logical-deletion opt-in and
   always reports `historicalDatasetErasureVerified: false`. Do not use an empty
   latest listing as 90-day erasure evidence, or hand-edit the Langfuse database.
   See [pinned implementation](https://github.com/langfuse/langfuse/blob/v4.56.0/packages/shared/src/server/repositories/dataset-items.ts#L501-L579),
   [versioning](https://langfuse.com/docs/evaluation/experiments/datasets#versioning),
   and [retention scope](https://langfuse.com/docs/administration/data-retention).
3. **Daily destructive retention is not deployed automatically.** The split CLI
   needs a separate owner-only environment and explicit target confirmation.
   Deployment of a recurring maintenance job, unknown/orphan reconciliation and
   a verified historical dataset erasure procedure are operator follow-up, not
   accomplished merely by adding the CLI.
4. **Review is not universally centralized.** Native queues cover experiment
   result traces. Weekly runtime review retains the local masked-sheet path;
   runtime root traces deliberately do not capture raw input/output, and no
   verified production turn→native queue mapping is promised.
5. **Real vLLM scaling remains unqualified on the current GPU endpoint.** A cached
   Transformers serial server can prove functional GPU execution, not vLLM metrics,
   TTFT, continuous batching, multi-engine routing performance or production
   throughput. Synthetic multi-proxy policy tests prove the routing contract,
   not its performance benefit on a real deployment.

The optional split CI job qualifies disposable runner-owned PG/Redis and source
runtime paths. It is not evidence of a successful GitHub-hosted run until that run
has actually happened. Independent backend/worker images must also pass their
packaging/startup probes and bounded end-to-end execution on the selected tags.
