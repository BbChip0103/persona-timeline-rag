# Natural character-chat testset

This is an **agent-authored, source-informed draft**, not a human-gold accuracy
benchmark or proof that a real person's voice/psychology has been cloned. It
replaces date/query-hinted lookup probes for the character-chat evaluation lane;
those older probes remain preserved as retrieval integration tests.

## Dialogue design

Four registered personas each have eight three-turn conversations: **32 dialogues,
96 user turns**. The categories are everyday chat, domain advice, hypothetical
creative choices, caption memory, image memory, mixed memory, genuinely ambiguous
follow-ups, and unsupported current activity/private-location requests followed
by ordinary conversation recovery. User turns are individually authored rather
than a date/query template applied to every source.

The turns include references to previous topics, constrained advice, recalled
public content and visual impressions. They do not supply a structured retrieval
query, source identifier, annotation identifier, gold label or posted-date filter.
Natural public topic/location references can legitimately identify a remembered
post; those are user clues, not secret query parameters. Visual scoring should
reward **new supported information**, not repetition of clues already supplied.

The eight-dialogue/24-turn smoke subset covers all eight categories with two
dialogues per persona. Full three-condition execution would require **288 text
turns plus retrieval work**, not96 calls. This preparation does not run it, reset
an existing budget, or assume additional paid-call authority. Check the persistent
remaining global budget before any later pilot/evaluation.

## Private artifacts and preparation

Inputs and generated cases are ignored/private:

- `data/research/character-chat-curation.private.json`: authored user conversations,
  evaluator expectations, source references and a smoke selection.
- Existing registered personas, source posts, chronological split and final v5
  image descriptions. All grounded targets are safe same-person `test` sources.
- `data/research/character-chat-testsets/<revision>/user.json`: allowlisted user
  inputs with opaque scenario/turn IDs and persona metadata. No evaluator fields.
- The adjacent `evaluator.json`: evaluator-only claims, exact support excerpts,
  hashes, behavior expectations, continuity links, alternatives and scoring checks.
- `data/research/character-chat-testset.latest.json`: current immutable revision.

```sh
# Local JSON validation and export only: no DB connection or model/provider call.
pnpm exec tsx scripts/prepare-character-chat-testset.ts
pnpm test --runTestsByPath scripts/tests/prepare-character-chat-testset.test.ts
pnpm typecheck
pnpm lint
```

Preparation validates balance, turn references, persona/source/annotation scope,
unsafe/held-out filtering, complete provenance and exact unique support excerpts.
Recorded image interpretations require visual observations too. Changing curated
input/assets yields a new content-addressed revision; an existing frozen file is
never overwritten. Rerunning identical inputs preserves existing timestamps/files.
Schema validation cannot prove that a question or scoring claim semantically
matches a photograph: independent private review is required, especially for
multi-image post positions.

`asOf` supplies a common evaluation clock for relative current-time questions, not
a hint about the target post's timestamp. A future runner must send only each
user `text` and ordinary conversation context through the shared chat API. Never
append evaluator targets/checks/claims or hand it a hidden retrieval query/date.
The preparation script is **not yet connected to the old lookup experiment runner**.

## Scoring contract

Evaluate naturalness, coarse persona style, continuity, source faithfulness,
retrieval appropriateness, visual contribution, uncertainty and safety separately.
An `answered` model status or quote substring match is not accuracy. Suggested
review scale is0/1/2 with reviewer identity/type recorded; unobserved answers have
no scores. Critical failures include cross-person evidence, invented activity,
private-location disclosure and forged quotations.

- Ordinary chat/advice/creative turns should not require retrieval or blanket
  factual refusal. Fictional ideas must remain fictional.
- Grounded turns require memory support, **not necessarily a fresh search on every
  turn**. Previously validated evidence may be reused; prior assistant prose alone
  is not factual evidence.
- Ambiguous prompts should permit a natural clarification before retrieval.
- Unsupported questions can have available visual records while lacking the
  requested identity, weather, purpose or current activity. Score the missing
  claim, not whether any record exists.
- Interpretations may differ from a stored AI hypothesis if supported by visible
  details and labeled as interpretation. Do not demand one supposed author-intent
  answer or turn low-confidence inference into fact.
- Fixed follow-ups should remain interpretable, or allow clarification when an
  assistant answer did not establish the assumed referent. Compare scripted user
  turns across conditions while acknowledging assistant histories diverge.

Counts are balanced by dialogue category, **not by difficulty or turn behavior**;
report slices/behavior types rather than rank personas by aggregate scores.
Previously explored sources and old probe responses informed curation. This is
not a blind unseen benchmark, representative traffic sample or human validation.
Only synthetic fixtures/public tooling are committed. Actual cases, quotations,
private reports and identifying datasets remain ignored.
