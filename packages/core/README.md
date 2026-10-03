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
