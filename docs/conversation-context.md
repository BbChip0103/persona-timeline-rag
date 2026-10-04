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

The same `ChatService`, SQL session/history stores, persona repository, PostgreSQL retrieval and OpenRouter adapter are used. The runner exposes both search and original-evidence resolution; the latter makes only local source lookup calls, not another text-model call. No fixed assistant history, forced intent, evaluator query or date filter is injected. The deterministic retrieval baseline uses a contiguous referential chain from at most five recent user messages, bounded to 500 Unicode characters; this is not semantic coreference or a separate LLM rewrite. Answer generation still receives the existing dialogue history. Reuse restores only previously cited original references and pinned image annotation revisions, not all previously retrieved posts or images. An uncited visual detail may therefore require a new search.

Preflight rebuilds and verifies the frozen assets, registered persona revisions and the existing caption/image-vector corpus. Code and corpus fingerprints must remain unchanged throughout the run. The existing global provider ledger must have **at least 60 request slots**, a total cap no greater than **$1 / 1000 calls**, and remaining dollar allowance. It is never reset or enlarged. This run stops before exceeding **36 text / 24 embedding port calls / 60 fresh provider reservations**; existing provider caches may replay requests without fresh billing. Dollar reservations still fail closed under the original global cap.

Private reports go under ignored `reports/memory-context/pilot-*/` with preflight, evolving progress, full replies and operational summaries. Success updates only `reports/memory-context/latest.json`, leaving `reports/character-chat/latest.json` and its old baseline untouched. Each reply records `retrievalContext` action/query/reused source IDs; traces separate text, embedding, search and original-source lookup calls, provider cache hits, new reservations and known actual cost. Global budget snapshots retain prior unresolved reservations. Any failure preserves progress and stops **without automatic retries or resubmission**.

```bash
pnpm test -- scripts/tests/evaluate-memory-context.test.ts scripts/tests/evaluate-character-chat.test.ts
pnpm typecheck
pnpm lint
```

This is a small, previously observed regression pilot, **not a blind accuracy benchmark or causal estimate of improvement**. Quote validity, completion and answered status are operational evidence only. Review continuity, useful visual detail, wrong-topic reuse and fabricated biography/currentness in the actual conversations separately. Source/image annotation derivations remain unreviewed AI evidence. Do not publish real conversations, captions, personas, images or private reports.
