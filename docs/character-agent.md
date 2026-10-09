# Independent agent-loop character agent


## Profiles

- `legacy`: existing server-routed RAG → `answer/evidenceRefs` generation. Existing sessions without `executionProfile`, and direct core calls without an explicit profile, remain legacy. Historical baseline runners retain this profile explicitly; they are not the forward evaluation path.
- `agent_loop`: default for **new API sessions**; persists the profile and RAG condition at creation. Missing condition becomes `off` for retrieval off, otherwise `caption`. Forward natural-character-chat evaluation pins this same profile across `off`, `caption`, and `caption_image`. Low-level direct core callers must still set it explicitly for backward compatibility. Profile cannot change mid-session.

```json
{"personId":"synthetic-person","executionProfile":"agent_loop","ragCondition":"caption_image"}
```

## Execution

1. Reserve an owner-bound, immutable persona/person/revision turn. Duplicate requests replay the same turn without provider calls; active turns serialize the session.
2. Assemble persona definition (with personality/background and style examples when the persona card has them), completed visible history, conversational variables, permitted tools and untrusted source/annotation data. Existing recent-user-context search and pinned evidence reuse run before generation when relevant.
3. Parse strict `message/status/evidenceRefs/variableUpdates` plus optional `reasoning` or `function`. `reasoning` is an optional **short decision summary**, not hidden thinking, source proof or a request for detailed deliberation. It is stored privately, never shown as chat text.
4. Optional `timeline_search` → authorized read-only retrieval → tool-result context → another model call. The tool accepts only a bounded query, never person, owner, URL, SQL, date override, credentials or write operations. Server binds person/date/mode/scope. Off and creative routes expose no tool. Unknown/repeated actions and exhausted limits fail without automatic repair/retry.
5. Exact quote/source scope validation → optional configured validator → atomic completed reply, visible messages and private variables/trace. Failed/cancelled turns cannot commit state. The next turn reads only the latest completed, owner/person/revision-bound state.

The turn-level candidates keep at most 20 parents, retaining the first authorized snapshot per source ID for the whole turn. A tool search puts its results first (the model chose that query for this turn), then the earlier candidates, each group in retrieval order; that merged order is the relevance order. The prompt carries at most 3 of them (`EVIDENCE_POST_LIMIT`), added whole in that order: a parent that does not fit the byte budget is skipped and the next ones still fill the remaining slots. The context step and `promptEvidence` record the rest as `omittedSourceIds`. The tool result's `availableSourceIds` lists the candidates and may name a parent that is not in the prompt, which still cannot be cited. An empty later search does not discard prior evidence. Captions are never sliced, and `CONTEXT_LIMIT` is raised only when the prompt does not fit with no parent at all. Only captions/whole annotations actually offered in the final budgeted context can be cited. Sources beyond the parent/context budget are not factual support.

Variables are allowlisted **conversationTopic/tone**, not durable user memory, biography or permissions. Only an accepted `answered` final applies variable updates. Safety/clarification shortcuts preserve previous state with zero model calls. Public HTTP DTOs use an explicit allowlist and omit internal decision summaries, variables, tool query trace and sourceContext.

## Cost and validation controls

No extra planner/rewrite call. A no-tool answer uses1 text call; a tool-requesting answer uses more. Default maximum2 tool rounds/3 text calls per turn; server configuration may set0–10 tool rounds, never caller input. All text/embedding calls use existing provider ledger and input/output/time limits; no budget reset. New prompt/state/protocol tokens can increase cost even on the one-call path.

- Total prompt≤30,000 UTF8 bytes and64 messages, including state and action transcript. Over the byte budget, evidence parents are skipped first (whole, in relevance order); the message count does not depend on evidence, so over64 messages is always `CONTEXT_LIMIT`.
- Message≤180 Unicode codepoints; optional summary≤160 UTF16 units; topic≤200; at most2 quotes≤96 UTF16 units. Existing provider output cap512 tokens is unchanged, and does not guarantee JSON completion.
- Exact quotes prove text binding, **not semantic entailment or truth**. No new factual-quality or cost-equivalence claim follows from fake tests.

## Verification and remaining differences

```sh
pnpm test
pnpm typecheck
pnpm lint
# Dedicated local DB only, guard validated:
RUN_STORAGE_DB_TESTS=1 pnpm exec jest --runInBand packages/storage/test/agent-runtime.integration.test.ts
```

Synthetic regressions cover multi-search evidence retention, state restart, scope isolation, malformed/repeated actions, cancellation, idempotency, off zero retrieval, validator outcomes and HTTP redaction. They are control-flow tests, not a real-person chat-quality benchmark.


## Forward three-condition evaluation

`evaluate-character-chat.ts --live --smoke` uses only `agent_loop` for all three
conditions: no RAG, caption RAG, and caption plus image-description RAG. Profile
and agent prompt/runtime revisions are recorded in new reports. It requires
explicit existing live/data opt-ins and available budget; do not run it merely
to update defaults. Tool rounds may add calls, so completion is not guaranteed.
Do not reset the global budget or migrate existing legacy sessions.

## Historical paired profile regression (not the forward evaluation path)

`node --env-file=.env.local -r tsx/cjs scripts/evaluate-agent-profile.ts --live`
runs the frozen four-conversation memory pilot in both profiles and all three
RAG conditions (72 planned turns). It requires existing explicit live/data
opt-ins, the baseline Gemini model, and120 available request slots in the
unchanged global $1/1000-request budget. No budget initialization/reset occurs.
The run may stop at hard limits;72 planned turns are not guaranteed. A failed
session skips its dependent followups without retry, while independent sessions
can proceed. Completed matched pairs are summarized separately from all observed
rows. Actual private replies/accounting go under `reports/agent-reevaluation/`;
previous evaluation pointers are not overwritten. Cached legacy replays are not
newly billed and cannot be compared naively to uncached latency/cost.


## Current conversational/service contract

The prompt is `character-agent-context-v5-persona-card`: the v3 bounded-roleplay wording in the S7 layout (agent
state/tools after the history, a safety note right before the user utterance; see docs/goal2-serving.md), plus the
persona card (docs/persona-authoring.md). It adds one policy sentence: background, example dialogues and
lore are author-set notes, never evidence, never citable (v5 also said "never real memories"; v7 replaces that with "you
may speak about them as yourself" and adds the identity/privacy policy, see docs/persona-authoring.md). Example dialogues are a system message
before the history. Matched lore is an untrusted user-role message between the state and the tools. Lore and examples
have no source ID, so an answer built on them stays `unverified_model`. v4 and v5 numbers are not compared, because the
policy sentence changes every persona's prompt. Light roleplay
embellishment is allowed without promoting it to source facts or contradicting
established core events/actors. This is not a semantic guarantee or measured
quality improvement. Existing completed turn reports keep their recorded prompt
versions; new turns use the current runtime and session-pinned persona revision.

Offsetless experimental quotes may be canonicalized only for a unique match
under ASCII space/tab/CR/LF collapsing. Stored quotes and UTF-16 ranges use the
original source bytes; `QUOTE_WHITESPACE_CANONICALIZED` records this case.
Explicit selectors and the historical strict renderer remain exact-only.
Unavailable tools produce `AGENT_TOOL_UNAVAILABLE` service notices with no tool,
retry or state patch. Unknown/malformed/unsafe actions and exhausted/repeated tool
loops still fail closed. Provider unresolved failures expose only a safe service
code and never trigger resubmission. These service states are not persona memory
or factual successes. See [core contract](../packages/core/README.md).
