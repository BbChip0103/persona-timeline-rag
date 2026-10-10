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
| Agent state updates | Typed `StateGraph` channels and additive reducers | Ordered transcript/source binding, limits and ownership remain domain policy |
| Timeline tool dispatch | `StructuredTool`, `ToolNode` | One trusted scoped tool, strict JSON action, opaque content/original evidence artifact |
| Classifier execution SLA | LangGraph node `TimeoutPolicy` | Absolute grant/lease deadlines, abort and nonblocking receipt settlement |
| Generic policy retrieval | Langfuse `get_prompt` | Exact version/approved content hash, read-only startup fetch, immutable snapshot/local fallback |
| Internal structure and API validation | Pydantic, FastAPI `Depends`, Nest Pipes | Shared wire schema authoritative; authentication before parsing, resource ownership before execution |
| Turn SSE transport | Nest `SseStream`, RxJS | Exact comments/no IDs, owner404, final store reread, bounded lifecycle |

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

Native ChatOpenAI and LangGraph turn, character, tool and receipt invocations use
a separate task-local SDK scope: inherited Runnable configuration and registered
callback ContextVars are detached and restored; LangSmith tracing is disabled for
that scope, without changing independent redacted application OTel. ChatOpenAI
also disables the ambient SDK cache, so it cannot introduce another raw-prompt
store. Process-global SDK debug/verbose and environment-created callback handlers
have no scoped opt-out in the pinned SDK and are unsupported: the call fails
closed with `SDK_RAW_TRACING_FORBIDDEN`, before a text-provider paid reservation.
Serving SDK/environment configuration must remain stable during an invocation;
this does not promise suppression of arbitrary mid-call global mutations. Recheck
the private configure-hook registry boundary on SDK upgrades.

Prompt templates are cached and receive policy, evidence JSON and user text as
values, not template source. Final messages are formatted once after the wire-native
budget loop. Existing roles, extra extension fields and JSON key order are preserved;
this is message assembly reuse, not migration of the source-selection budget policy.

## Framework-native execution boundaries

Typed agent channels append counter/transcript/step deltas rather than copying a
nested run dictionary. Source deduplication and first-seen provenance still use
replacement channels. No outer-state saver or second conversational memory is added.
Each tool invocation creates one trusted `timeline_search` tool; native argument
validation/dispatch owns execution, but SDK ToolMessages do not replace the existing
model-visible JSON action transcript. Tool artifacts retain the original evidence.

Classifier graphs use native node timeouts with no retry policy. `langgraph>=1.2`
is required; the lock already contains this version family. Native timeout errors
map to the existing timeout fallback. Cancellation is issued once and late results
cannot enter the answer; shielded transport settlement may continue in the background.
This is not a claim that arbitrary cancellation-resistant providers immediately drain.

Pydantic validates internal persona/reply structure without repairing JSON or changing
decoded key order. Python/UTF-16 bounds and provenance checks retain their existing
semantics, including escaped surrogate compatibility. Nest Pipes reuse existing
Zod/shared wire schemas; they do not define another backend contract. Nest caller
guards precede field validation; resource ownership is checked before execution.
FastAPI's
authentication dependency rejects unauthorized requests before body consumption.

Nest 10's installed SSE encoder does not support heartbeat comments and invents IDs.
The minimal `ExactTurnSseStream` adapter preserves `: ping` and ID-free frames while
native `writeMessage` owns encoding/drain. RxJS owns clocks, subscription deadlines
and serialized writes. Hard maximum duration also terminates an undraining final
frame; client close releases late subscriptions. SDK error messages are never sent
as SSE data. Recheck the internal `@nestjs/core/router/sse-stream` boundary on upgrades.

Prompt management is offline/local by default. Opt-in requires an exact generic
policy name, positive version and the approved local bundle's SHA-256 via
`PTR_LLM_PROMPT_MANAGEMENT=langfuse`, `PTR_LLM_PROMPT_NAME`,
`PTR_LLM_PROMPT_VERSION` and `PTR_LLM_PROMPT_SHA256`; the optional
`PTR_LLM_PROMPT_FETCH_TIMEOUT_SECONDS` is bounded to 1–2 seconds. Startup fetch is
read-only, bounded and has no retries or SDK background cache refresh. Missing,
invalid, mismatched or unavailable remote policy uses the same local policy bytes
with explicit fallback provenance. The immutable runtime snapshot is associated
only with generations that actually assembled that verified policy. No persona,
source, personalized prompt or `create_prompt` upload is performed by this feature.
The SDK4.17 read-only facade retains native `get_prompt` but disables both its
outer retries and Fern transport retries, with a worker-owned HTTP client. Startup
timeout/cancellation does not forcibly kill the synchronous GET; that isolated
client closes when its worker exits, independently of telemetry shutdown. Recheck
this private SDK wrapper boundary on upgrades.

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
