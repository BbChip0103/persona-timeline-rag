# Chat core quote-selection contract

The timeline model contract in `persona-chat-v3-offsetless-quotes` requests strict
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
offsets. The model selects exact text without arithmetic. The small-talk message
bytes and `persona-chat-v1-source-quotes` revision are unchanged. The v3 timeline
prompt is an explicit variant; earlier study results must not be relabeled as if
they used it. `PROMPT_REVISION` currently denotes the v3 timeline revision.

## agent-loop conversational voice and service boundaries

`character-agent-context-v3-bounded-roleplay` uses first-person author-role
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
