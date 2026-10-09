# Chat core quote-selection contract

The timeline model contract introduced in `persona-chat-v3-offsetless-quotes` (current revision
`persona-chat-v4-turn-note-last`: same bytes without a safety note, see the S7 layout below) requests strict
JSON with `status`, `answer`, and `evidenceRefs`. Model prose in `answer` is never
used to render factual claims. New model selections contain only:

```json
{"sourceId":"synthetic-source","quote":"An exact, unique caption substring."}
```

The core resolves the selected id only among safe, same-person retrieved source
posts. It derives canonical `[start,end)` **UTF-16 code-unit** offsets only when
the quote occurs exactly once in that caption (overlapping repeats also count).
Unknown ids, cross-person/unsafe sources, fabricated/empty/ambiguous quotes, and
credential-shaped quotes fail closed. No fuzzy matching, normalization, or
semantic entailment is claimed.

Legacy selections containing both `start` and `end` remain supported. Both must
be integers, nonnegative/positive as appropriate, ordered, within the caption,
and select exactly the supplied quote. Supplying just one selector, an invalid
selector, or extra keys fails closed. Malformed supplied selectors are **never
repaired or ignored**, even if the quote is otherwise exact and unique. Valid
legacy selectors can disambiguate repeated quotes by their explicit position.

Final `ChatReply.claims[].evidenceRefs` always contain canonical `sourceId`,
`quote`, `start`, and `end`; API/UI/storage contracts have not changed. Source
cards retain posted/event date separation, and rendering labels quotations as
caption statements rather than assertions of actual activities.

Timeline prompt evidence includes a bounded candidate **string**, not candidate
offsets. The model selects exact text without arithmetic. Historical (v3): the small-talk message
bytes and `persona-chat-v1-source-quotes` revision were unchanged by it. The v3 timeline
prompt is an explicit variant; earlier study results must not be relabeled as if
they used it. `PROMPT_REVISION` currently denotes the timeline revision.

**Prompt layout (S7).** Every builder renders
`policy · persona · history · [agent state/tools] · [evidence] · [safety note] · user · [tool transcript]`,
so policy → persona → history is a prefix that only grows from turn to turn. The input-safety deflection note is
its own system message right before the user utterance (it was appended to the policy message). Revisions:
`persona-chat-v2-turn-note-last` (small talk), `persona-chat-v4-turn-note-last` (timeline),
`persona-chat-v7-turn-note-last` (experiment) and `character-agent-context-v4-prefix-stable` (agent; superseded, see
the persona card paragraph below). Without a
safety note the first three render the same bytes as v1 / v3 / v6; the agent prompt changes on every turn (state and
tools moved after the history). `tests/prompt-layout.test.ts` pins the byte stability.

**Persona card .** The agent prompt is `character-agent-context-v5-persona-card` and the experiment
prompt `persona-chat-v8-persona-card`. Their layout is
`policy · persona definition · [examples] · history · [state] · [lore] · [tools] · [evidence] · [note] · user`.
- `PERSONA_CARD_POLICY` sits right before `TIMELINE_JSON_REPLY:`, so the agent's policy split keeps it.
- `renderPersonaBlock` renders the definition (the v4 bytes when the new fields are absent) and the style examples.
- `matchLore` and `renderLoreMessage` select and render lore. Selection is deterministic: user utterances only, turns
  the input-safety filter acted on are skipped, nothing on deflected turns, at most 3 entries within 2,048 B.
- `validatePersonaForPublish` and `personaRevision` back the authoring CLI.
- The legacy `buildPrompt` revisions above are unchanged.
- Contract, checks and CLI: `docs/persona-authoring.md`.

## agent-loop conversational voice and service boundaries

`character-agent-context-v5-persona-card` (v3 wording, S7 layout, persona card) uses first-person author-role
narration in the disclosed research simulation. Light reactions, humour,
atmosphere and minor scene embellishment are allowed, but are not verified
source facts. Established core events/actors, exact quotations and important
real-world/private events must not be contradicted or fabricated. Natural
uncertainty and clarification stay conversational; technical errors stay
explicit service notices. Persona/history are not source evidence, and real
personality fidelity is not established by this policy.

The experimental natural-prose validator first requires a unique exact quote.
For **offsetless** selections only, a non-exact quote can be resolved if collapsing
ASCII spaces, tabs, CR and LF produces exactly one matching substring. The server
stores the original substring and its UTF-16 offsets, and marks
`QUOTE_WHITESPACE_CANONICALIZED`. Words, punctuation, Unicode spacing and explicit
selectors are never repaired. Ambiguous normalized matches and unauthorized
parents/annotations still fail closed. The historical strict renderer above is
unchanged. Quote binding is not semantic validation of the conversational prose.

A schema-valid unavailable tool request returns an explicit service notice with
`AGENT_TOOL_UNAVAILABLE`, empty refs, unchanged state and no tool/extra model call.
Malformed/unknown actions, unsafe queries and tool-loop exhaustion still fail.
Provider errors expose only allowlisted service codes; unresolved submissions
are not retried. This is deterministic robustness, not new live quality evidence.
Old completed sessions/results retain their recorded prompt versions; new turns
use the current runtime prompt, while their persona revision remains pinned.

The paired Korean regression runs with
`node --env-file=.env.local -r tsx/cjs scripts/evaluate-korean-chat.ts --live --recollection`
and the existing explicit live/external-data environment opt-ins. It requires
the archived 72-turn Korean baseline and a separately frozen private recollection
rubric. New results use `reports/recollection-chat/`, leaving the prior Korean
pointer unchanged. It plans 72 turns, prioritizes memory conversations, limits
fresh requests to 60, and preserves the existing global $1/1000-request ledger.
Budget/port exhaustion produces an explicitly partial report, not a reset or retry.
