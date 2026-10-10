# LangChain-first components

Prefer native LangChain/LangGraph functionality over duplicate general-purpose code,
including migrating existing implementations where the behavior is equivalent.
Adapters are for application/provider contracts, not alternative RAG orchestration.

## Current ownership

| Function | Native component | Explicit adapter/policy boundary |
| --- | --- | --- |
| Gateway text and guided output | `ChatOpenAI`, `with_structured_output` | Metered transport, model allowlist, receipts, cancellation |
| Summary child → original parents | `MultiVectorRetriever` | Read-only normalized PostgreSQL stores, pinned run, current hashes/revisions |
| Legacy caption/image semantic search | `VectorStoreRetriever` | Scoped cosine SQL, trusted person/date/timezone/evidence condition |
| Search → answer-evidence filtering | `ContextualCompressionRetriever` | JEV `BaseDocumentCompressor`, variable count/probability threshold, guarded batches |
| Query and summary-index batch embeddings | `OpenAIEmbeddings.aembed_query/aembed_documents` | Metered OpenRouter client bridge, ordered validated vectors,1536/raw float |
| Final prompt assembly | `ChatPromptTemplate`, `MessagesPlaceholder` | Exact wire roles/content/order;30KB whole-post/image budget and omission accounting |
| Agent flow and receipt-only checkpoints | LangGraph, PostgreSQL saver | Turn ownership/state lifecycle and no raw outer-state persistence |

The embedding SDK receives only an explicit blocked synchronous client and a
metered asynchronous bridge. It does **not** create a separate HTTP client or use
another credential. Whole batches are validated before SDK execution (1–32 texts,
input-byte ceiling); context-length/tokenization handling is disabled, so it does
not split, normalize, average vectors, or create extra billable batches. The
original OpenRouter transport, provider privacy/routing, request fingerprint,
pricing/reservation/settlement and invalid/unknown receipt validation are retained.
The bridge uses a per-invocation cancellation context, restored on every exit.
Summary-index ingestion uses this same SDK path without changing saved batch identity.

JEV is not replaced with `LLMListwiseRerank` or `LLMChainFilter`: those change its
non-chat decisions protocol or variable evidence-count semantics. Native contextual
compression owns retrieve/empty-result skip/compress sequencing; the provider-specific
compressor returns selected original Documents, never summary quotations. Remembered
references are validated first and then use the same compressor. Tool searches share
this pipeline; off/creative/safety-deflected paths do not invoke it.

Native retrievers share an internal asynchronous invocation boundary that bypasses
SDK automatic callback configuration. Even `callbacks=[]` can inherit global raw
tracing/debug hooks. Only an internally passed empty child callback manager is
accepted; it is not installed. Ambient Runnable configuration is detached/restored,
while independent redacted application OTel remains untouched. Standard traced
retriever/stream callbacks are not exposed by application APIs. Compatibility of
the inherited SDK async hooks must be rechecked on dependency upgrades.

Prompt templates are cached and receive policy, evidence JSON and user text as
values, not template source. Final messages are formatted once after the wire-native
budget loop. Existing roles, extra extension fields and JSON key order are preserved;
this is message assembly reuse, not migration of the source-selection budget policy.

## Deliberate non-equivalences / remaining custom code

- Default `JsonOutputParser` repairs partial JSON and accepts Markdown. Keep strict
  JSON/schema/credential/Unicode/tool-state gates; do not add output-repair retries.
- Backend history and source-bound memory remain authoritative. A second stock
  conversational-memory store would duplicate ownership and lose immutable provenance.
- Generic PGVectorStore initialization is not a replacement for normalized scoped
  source/summary tables. No DDL, copied collections or reembedding is required here.
- The optional direct OpenRouter text driver and JEV decisions transport retain
  provider-specific privacy, pricing and durable receipt contracts. Gateway text
  generation is already native ChatOpenAI. Native transport replacement must prove
  exact receipt/request equivalence before adoption; a wrapper alone is not that migration.
- Lexical filtering, licensed/trusted evidence validation, whole-source budgeting,
  model/cost policy and deletion/ownership guards are application contracts.

No accuracy or end-to-end performance improvement follows merely from SDK reuse.
Synthetic tests lock native method invocation, exact bytes/order, batching/cancellation,
no-resubmit, callback privacy, and off-path zero calls. Opt-in PostgreSQL tests use
rollback-only synthetic fixtures; research parity checks reuse stored vectors with
no model calls. New deployment/paid evaluation remains a separate action.

## Primary references

- [OpenAIEmbeddings](https://docs.langchain.com/oss/python/integrations/embeddings/openai)
- [VectorStoreRetriever](https://reference.langchain.com/python/langchain-core/vectorstores/base/VectorStoreRetriever)
- [ContextualCompressionRetriever](https://reference.langchain.com/python/langchain-classic/retrievers/contextual_compression/ContextualCompressionRetriever)
- [MultiVector implementation](https://github.com/langchain-ai/langchain/blob/master/libs/langchain/langchain_classic/retrievers/multi_vector.py)
- [JSON parser implementation](https://github.com/langchain-ai/langchain/blob/master/libs/core/langchain_core/output_parsers/json.py)
