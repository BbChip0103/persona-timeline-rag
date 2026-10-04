# Independent agent-loop character agent


## Profiles

- `legacy`: existing server-routed RAG → `answer/evidenceRefs` generation. Existing sessions without `executionProfile`, and direct core calls without an explicit profile, remain legacy. Existing evaluation scripts retain this baseline.
- `agent_loop`: default for **new API sessions**; persists the profile and RAG condition at creation. Missing condition becomes `off` for retrieval off, otherwise `caption`. Opt into the same profile explicitly in a direct core/evaluation run. Profile cannot change mid-session.

```json
{"personId":"synthetic-person","executionProfile":"agent_loop","ragCondition":"caption_image"}
```

## Execution

1. Reserve an owner-bound, immutable persona/person/revision turn. Duplicate requests replay the same turn without provider calls; active turns serialize the session.
2. Assemble persona definition, completed visible history, conversational variables, permitted tools and untrusted source/annotation data. Existing recent-user-context search and pinned evidence reuse run before generation when relevant.
3. Parse strict `message/status/evidenceRefs/variableUpdates` plus optional `reasoning` or `function`. `reasoning` is an optional **short decision summary**, not hidden thinking, source proof or a request for detailed deliberation. It is stored privately, never shown as chat text.
4. Optional `timeline_search` → authorized read-only retrieval → tool-result context → another model call. The tool accepts only a bounded query, never person, owner, URL, SQL, date override, credentials or write operations. Server binds person/date/mode/scope. Off and creative routes expose no tool. Unknown/repeated actions and exhausted limits fail without automatic repair/retry.
5. Exact quote/source scope validation → optional configured validator → atomic completed reply, visible messages and private variables/trace. Failed/cancelled turns cannot commit state. The next turn reads only the latest completed, owner/person/revision-bound state.

The turn-level evidence accumulator keeps at most20 parents, retaining the first authorized snapshot per source ID. An empty later search does not discard prior evidence. Only captions/whole annotations actually offered in the final budgeted context can be cited. Sources beyond the parent/context budget are not factual support.

Variables are allowlisted **conversationTopic/tone**, not durable user memory, biography or permissions. Only an accepted `answered` final applies variable updates. Safety/clarification shortcuts preserve previous state with zero model calls. Public HTTP DTOs use an explicit allowlist and omit internal decision summaries, variables, tool query trace and sourceContext.

## Cost and validation controls

No extra planner/rewrite call. A no-tool answer uses1 text call; a tool-requesting answer uses more. Default maximum2 tool rounds/3 text calls per turn; server configuration may set0–10 tool rounds, never caller input. All text/embedding calls use existing provider ledger and input/output/time limits; no budget reset. New prompt/state/protocol tokens can increase cost even on the one-call path.

- Total prompt≤30,000 UTF8 bytes and64 messages, including state and action transcript.
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

