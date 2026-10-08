> Historical legacy pilot only. Forward agent-loop three-condition evaluation is documented in [character-agent.md](character-agent.md).

# Conversation-context retrieval

## Reproduce the bounded live regression pilot

The pilot reuses four conversations from the existing frozen natural-chat smoke set: one memory conversation per Korean persona, one imaginary-photo conversation and one caption/photo conversation. Each uses three genuine evolving turns in each of `off`, `caption`, and `caption_image`: **36 answer turns**. Selection metadata is never sent to the chatbot; its input remains session/request IDs and natural user text only.

```bash
# Run from repository root with existing ignored personal-provider/local-DB configuration.
# Explicit opt-ins and the baseline model must already be set:
# GOAL1_LIVE_ENABLED=true
# GOAL1_ALLOW_EXTERNAL_DATA=true
# GOAL1_TEXT_MODEL=google/gemini-3-flash-preview
pnpm exec tsx scripts/evaluate-memory-context.ts --live
```

The same `ChatService`, SQL session/history stores, persona repository, PostgreSQL retrieval and OpenRouter adapter are used. The runner exposes both search and original-evidence resolution; the latter makes only local source lookup calls, not another text-model call. No fixed assistant history, forced intent, evaluator query or date filter is injected. The deterministic retrieval baseline uses a contiguous referential chain from at most five recent user messages, bounded to 500 Unicode characters; this is not semantic coreference or a separate LLM rewrite. Answer generation still receives the existing dialogue history. Reuse selects parents actually cited by the prior answer and restores their original caption plus image annotations that were actually offered in that prompt. Server-created sourceContext references pin exact hashes and revisions (at most 20 references total); they are original context, not new factual claims or assistant prose. It does not retain uncited candidate parents, budget-omitted images, or every historical retrieval. A detail outside that bounded context may still require a new search.

Preflight rebuilds and verifies the frozen assets, registered persona revisions and the existing caption/image-vector corpus. Code and corpus fingerprints must remain unchanged throughout the run. The existing global provider ledger must have **at least 60 request slots**, a total cap no greater than **$1 / 1000 calls**, and remaining dollar allowance. It is never reset or enlarged. This run stops before exceeding **36 text / 24 embedding port calls / 60 fresh provider reservations**; existing provider caches may replay requests without fresh billing. Dollar reservations still fail closed under the original global cap.

Private reports go under ignored `reports/memory-context/pilot-*/` with preflight, evolving progress, full replies and operational summaries. Success updates only `reports/memory-context/latest.json`, leaving `reports/character-chat/latest.json` and its old baseline untouched. Each reply records `retrievalContext` action/query/reused source IDs; traces separate text, embedding, search and original-source lookup calls, provider cache hits, new reservations and known actual cost. Global budget snapshots retain prior unresolved reservations. Any failure preserves progress and stops **without automatic retries or resubmission**.

```bash
pnpm test -- scripts/tests/evaluate-memory-context.test.ts scripts/tests/evaluate-character-chat.test.ts
pnpm typecheck
pnpm lint
```

This is a small, previously observed regression pilot, **not a blind accuracy benchmark or causal estimate of improvement**. Quote validity, completion and answered status are operational evidence only. Review continuity, useful visual detail, wrong-topic reuse and fabricated biography/currentness in the actual conversations separately. Source/image annotation derivations remain unreviewed AI evidence. Do not publish real conversations, captions, personas, images or private reports.

## Optional intent classifier (Jev, default off)

Intent routing is deterministic first (`packages/core/src/intent-routing.ts`). Rule order: sensitive pattern or explicit `unsupported` → `unsupported`; the sensitive pattern also covers current-whereabouts and in-person visit requests (`지금 어디 있어`, `어디 살아`, `찾아갈게`, `where are you now`, `where do you live`, `are you nearby`, `I'll stop by`) but not past places or past-trip/photo accommodation, hometown, travel advice or meeting someone else. Known regex gaps, left for the planned Jev safety filter's private-information category rather than a growing regex: `우리 만날래?`, `어느 동네 살아?`, `주소 알려줘` and similar indirect phrasings; explicit `clarification` → `clarification`; any timeline signal → `timeline`; otherwise explicit intent or `small_talk`. Timeline signals are split into:

- **strong** (authoritative): explicit `timeline` query, biographical request, post-memory request, follow-up bound to a previous timeline reply;
- **weak** (lexical only): the generic time/place/past-tense cue (`when`, `did you`, `어디`, `했어`, …) or image words in a RAG session.

With `PTR_INTENT_CLASSIFIER=jev`, retrieval-off control sessions (`retrievalMode=off` with no RAG condition) keep pure rule routing with no classifier call; their trace records `decidedBy: rule`. In other sessions a classifier is asked only when the request is not sensitive, has no explicit intent, is not creative and has no strong signal, i.e. when the rules decided timeline vs small_talk from weak cues or from no cue. Its label replaces the rule result only at or above `PTR_JEV_MIN_CONFIDENCE` (default `0.6`; for a two-label Jev Choice, confidence = 2·p−1, so 0.6 means p ≥ 0.8). It can upgrade small_talk to timeline or downgrade a weak-cue timeline to small_talk; it never produces or overrides `unsupported`/`clarification`. Errors (including an internally inconsistent answer), a missing answer, ledger refusal, an unresolved earlier attempt of the same turn, `PTR_JEV_TIMEOUT_MS` (default 1500, also bounded by the turn's abort) and low confidence keep the rule result.

The classifier receives only the current user text (≤500 chars) and the last two user turns (≤300 chars each; credential-pattern and sensitive-pattern turns dropped): no persona, assistant replies, retrieved posts or IDs. Label order is rotated per turn (seeded by the turn id) against Jev's first-option bias. Model: `PTR_JEV_MODEL` (pinned `typesafe/jev-1.13`; the `~typesafe/jev-latest` alias is rejected). Calls use the shared OpenRouter client and budget ledger, so they need the same live gates and count against the same call/USD caps. The ledger key includes the turn id (never sent upstream): a lease-lost retry of the same turn replays its settled answer or, if the first attempt is unresolved, falls back (`unresolved`) without resubmitting; an unresolved request never blocks other turns. Identical-input answers are therefore not reused across turns: each turn pays for its own decision (about US$0.00002). When a classifier is configured, the stored reply carries an internal `intentRouting` trace (`decidedBy` rule/classifier/classifier_fallback, rule intent, label, confidence, fallback reason) without user text; the public turn DTO does not expose it.

Evaluation (not run in `pnpm check`):

```bash
GOAL1_LIVE_ENABLED=true node --env-file=.env.local --import tsx scripts/evaluate-jev-intent.ts --live --data-root=<checkout with data/research>
```

It routes the 96 frozen natural-chat utterances through rules only and rules+Jev (user text and prior user turns only), writes `reports/jev-intent/<time>/` (private), and refuses to start without ledger headroom. Seeds are the frozen export turn ids, so a live rerun replays the ledger's stored Jev answers (no new calls, same answers, replay latency) rather than sampling again; `--rules-only` makes no calls at all. Expected intents are the script's mapping of evaluator behaviours, not human labels.
