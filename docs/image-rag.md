# Separate image-annotation retrieval

Timeline evidence has two independent switches: legacy `retrievalMode` selects
`off | lexical | semantic`; optional `ragCondition` selects
`off | caption | caption_image`. Image annotations are AI observations and tentative
interpretations, **not original captions, verified author intention, face identity,
or event-date evidence**. They remain `humanReviewed: false`.

## Storage boundary

Apply forward migration `supabase/migrations/0003_image_annotations.sql` through
`pnpm db:migrate` using the existing dedicated-loopback DB guard. No originals are
rewritten. Separate immutable tables retain complete parent annotation revisions,
per-image/position evidence, and augmented vectors. Imports verify original parent
ID, person and source hash and refuse unknown, unsafe, conflicting or duplicate
associations. Replaying an older revision does not change the latest revision.

`PostgresSourceRepository.importAnnotations(inputs)` accepts a complete image set
for each `(sourceId, revision)`; changed sets require a new revision. Evidence has
`id`, `imageHash`, `annotationHash`, `revision`, `text`, `model`, and
`humanReviewed: false`. Import-only metadata also includes `sourceId`, `personId`,
`sourceHash`, and `imagePosition`. `imageAnnotationHash()` creates canonical hashes.

`importImageVector(sourceId, annotationRevision, modelRevision, embedding)` stores
1536-dimensional float32 vectors separately from the original caption vectors.
The current live adapter uses `openai/text-embedding-3-small` for both conditions.
Caption queries use the original SQL and never return image annotations.
Augmented lexical queries rank caption plus distinct image-annotation text, return
one parent per result and attach separate image evidence. Augmented semantic
queries use the latest annotation revision's vector; they never reuse an older
annotation vector if its replacement is not indexed yet. Parents without any
annotations retain their existing caption vector. Person, safety, date-basis and
local-timezone bounds are applied before ranking in both algorithms.

## Private import

Only ignored local files are consumed:

- `data/research/sources.json`
- `data/research/image_descriptions_v5_declarative/images.jsonl`

The importer requires the separately recorded declarative-style derivation while
preserving original visual-model provenance. It indexes only visual description,
salient emphasis/basis and **explicitly tentative** inferred intention with
uncertainty/alternatives; `caption_context` reinterpretations are excluded.
All unsafe parents are omitted. Repeated images retain each association/position
but identical visual text appears only once in an embedding input. Parent revisions
are content-addressed; no generated material enters `source_posts`.

```sh
# Safe default: validate private inputs and report counts; no DB/provider access.
pnpm exec tsx scripts/import-image-annotations.ts --dry-run

# Explicit local annotation import only, no model call.
pnpm exec tsx scripts/import-image-annotations.ts --import

# Only within an approved live run with both GOAL1 live/external flags enabled:
pnpm exec tsx scripts/import-image-annotations.ts --import --live-index
```

Private environment loading remains the caller's responsibility; never print
credentials. `--legacy-dry-run` may inspect the prior annotation format only for
planning; it cannot be combined with import or live indexing.

Embedding batches contain at most eight parents and 30,000 UTF-8 JSON bytes.
Parents with more than 100 image associations, annotation text over 16,000
UTF-16 code units or oversize embedding text are skipped entirely, not partially indexed. The existing
persistent global US$1/call-cap ledger and provider request-hash cache are reused,
not reset or replaced. Stable full batches are replayed on resume so partially
stored batches recover cached responses without changing request identities;
submitted/unknown requests are not resubmitted. Private progress goes only to
ignored `reports/image-index-progress.json`.

## Checks

```sh
pnpm test -- packages/storage/test/image-annotations.test.ts scripts/tests/import-image-annotations.test.ts
# With an explicitly loaded local DATABASE_URL and applied migration:
RUN_STORAGE_DB_TESTS=1 pnpm test -- packages/storage/test/image-annotations.integration.test.ts packages/storage/test/postgres.integration.test.ts
pnpm typecheck
pnpm lint
```

Public fixtures are synthetic. SQL tests add uniquely scoped synthetic records;
they do not drop, truncate or mutate original data. This is unreviewed prototype
retrieval; it does not establish annotation accuracy or faithful real-person intent.

## Three-condition chat and controlled probes

The chat UI pins `off`, `caption`, or `caption_image` to each new session. Explicit
`off` now asks the same model without retrieval and labels responses unverified;
legacy sessions without a condition retain their previous abstention behavior.
The two RAG conditions share semantic top-5 retrieval by default; the prompt carries at most 3 of those posts (`EVIDENCE_POST_LIMIT`). Original caption
quotes and AI image-annotation quotes have distinct provenance cards. Exact quote
binding is not validation of answer truth, intent, or semantic entailment.

The common experimental prompt budgets the complete JSON messages at 30,000
UTF-8 bytes and carries at most 3 parent posts (`EVIDENCE_POST_LIMIT`).
It keeps original captions/history/user input intact: whole posts are added in
relevance (retrieval) order, a post that does not fit the budget is skipped and
the next ones still fill the remaining slots, then whole image annotations of the
kept posts are allocated round-robin. Omitted counts, omitted
post IDs (`omittedSourceIds`: beyond the cap or skipped for the budget) and actually supplied IDs are reported in
`promptEvidence`; quotes from omitted posts or annotations are rejected. Only a
base context that does not fit with no post fails before text generation with
`CONTEXT_LIMIT`.

```sh
# Freeze private assets and source-derived silver probes before seeing answers:
pnpm exec tsx scripts/evaluate-image-rag.ts --prepare
# Explicit approved live flags/environment required; three initial model turns:
pnpm exec tsx scripts/evaluate-image-rag.ts --live --pilot
# 24 single-turn probes x 3, then 4 three-turn conversations x 3 = 108 turns:
pnpm exec tsx scripts/evaluate-image-rag.ts --live
```

Each condition uses the same persona revision, questions, model and system policy;
only evidence differs. Condition order rotates. Conversation histories evolve and
therefore diverge. Frozen question/asset/code hashes and before/after exact parent,
annotation revision/content and vector-readiness snapshots prevent silent corpus
changes or partially indexed trials. Raw replies, provenance, costs, request IDs,
exposure and citation hits remain private under ignored `reports/image-rag/`.
No unknown external request is automatically retried. Model-format/evidence errors
are reported separately from transport/runtime failures.

These are source/AI-description-derived **silver** probes, partly date-scoped—not
human-gold factual accuracy. Annotation generation already included original
caption context. This experiment compares combined retrieval/context pipelines;
it cannot isolate image-only information, the wording rewrite, or genuine author
intent. Human semantic review remains pending.
