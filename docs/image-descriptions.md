# Original-image descriptions v3 (private, not yet RAG)

This stdlib-only runner annotates only JPEGs referenced by the selected four-person target posts.
It cross-checks the selected targets, research sources and original image mapping manifest. It
never glob-selects orphan images, other persons or generated creative artifacts. Original sources,
captions, personas, database, index and chat remain unchanged. Annotation is a separate preparation
step: descriptions must not be treated as original captions, original quotes or actual event truth.

## Observation versus communicative intent

V3 uses a **generic** salience policy: identify the photo's central communicated content and visible
emphasis, then include only information contributing to understanding, interpreting or remembering
that content. Do not enumerate elements just because they are visible. Important subjects/elements
are not predetermined by genre, a fixed subject taxonomy, an object blacklist, or examples. Position,
size, color or focus alone do not establish significance; relevance is judged from the image itself.
This is not a guaranteed relevance oracle.

Objective prose is normally 2–3 short sentences, at most 500 characters; fewer are fine. The main-subject and
visual-basis arrays contain at most three short strings and can be empty when ambiguous. There
are no exhaustive object/activity/color/text inventory fields or preset photo/intent categories.
Address relevant ambiguity concisely, not generic boilerplate. Never invent purpose for every photo.

V3 saves three deliberately separate layers under each result's `images[].visual`:

1. `description_ko`: concise grounded observation, not inferred motive.
2. `observed_emphasis`: visible `main_subjects` and `visual_basis` about framing, position, label
   orientation, size, contrast, color or focus: at most three subjects and three basis strings.
   An identified emphasized subject needs visible basis.
3. `communicative_intent`: `epistemic_status=tentative_not_author_fact` with zero to two hypotheses.
   Each has tentative Korean `hypothesis_ko`, nonempty `visual_basis` copied verbatim from
   the observed basis, qualitative `confidence` (`low` or `medium`), `uncertainty_ko`, and at least
   one alternative (at most two). Basis strings reference at most two observed cues per hypothesis.
   Prefer one hypothesis when helpful; no hypothesis is required when intent is unclear.

Subject/basis strings are at most 120 characters; hypothesis/uncertainty/alternative strings
are at most 180. The prompt requests a model self-check for central focus, omission of incidental
details, brevity and inference separation. Provenance records the checklist as **AI self-check, not
human verification**, and retains `human_reviewed=false`. These limits and labels are structural
checks, not an independent semantic relevance assessment.

This considers what the **photo's presentation could communicate**, including a plausible reason
for making/posting that kind of image, only when visually grounded—not what the actual author
thought or intended. There is no intent-kind taxonomy. Actual motives, psychology, personality,
identity, private beliefs, sponsorship/ad certainty and unverified event facts are outside the
contract. Hypotheses never become original quotes or factual event/author claims. Structural
validation checks labels, evidence references and bounds; it does not independently prove every
natural-language interpretation or relevance judgment. Human semantic review remains necessary.

The fixed v3 variant re-annotates **every** referenced image, even those with existing v1 objective
captions. It is a deliberate prompt/schema change, not a retry of unresolved old work. V1 objective
annotations and the single v2 domain-guided preflight retain their original state, prompt/schema,
provenance and observed usage in separate directories. No v1/v2 results or usage are silently reused
or mixed into v3. The v3 manifest includes its prompt version and variant policy; incompatible
output/config cannot be reused.

## Fixed execution contract

- Local authenticated `codex exec`, exactly `-m gpt-6.1-sol` and
  `-c model_reasoning_effort="high"`. No model substitutions or cheaper-model comparisons.
- Requires existing ChatGPT login, forces ChatGPT login mode, ignores user configuration, whitelists
  the child environment without API-key variables. No API key inspection or paid API requests.
  Codex plan usage is accounted separately; the project's existing paid API budget does not change.
- One runner lock, concurrency one, at most eight images/session, default timeout 900 seconds
  (allowed maximum 1800). The first invocation should use `--max-batches 1`; verify actual requested
  model/image success before starting the remainder. `--max-batches` counts new batches, not skipped
  compatible successes. No automatic retry, waiting loop, model fallback or credential acquisition.
- Isolated non-repository workspaces contain anonymized SHA256 image IDs/copies and the schema.
  No captions, dates, names, source paths or post/person IDs are sent as textual image context.
  Image pixels may themselves contain visible text; the prompt treats that text as untrusted content.
- Read-only sandbox; shell/unified execution, web search, apps, multi-agent, browser/computer use,
  image generation and image-file tools disabled. Prompt forbids all tool use. Unexpected completed
  tool items or incomplete event streams reject the result. The wrapper, not the model, writes files.
- Strict ID/count/order/field/length validation. People are described nonidentifyingly. Visible dates
  and locations are not verified activity dates/locations; uncertainty and absent readable text are
  supported explicitly. This is not a guarantee of OCR/visual accuracy: human review is still needed.

## Commands

The current module defaults to `original-image-ko-v3`,
`data/research/image_descriptions_v3/`, and `reports/image-description-v3/`.
From the repository root:

```sh
# Small actual model-and-image preflight (also creates the fixed target manifest).
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions --max-batches 1
# Resume all remaining batches, without resubmitting previously completed batches.
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions
# Safe while a runner is active: read the most recent atomic progress snapshot only.
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions --status
```

To inspect archived progress, read `data/research/image_descriptions/progress.json` /
`reports/image-description/summary.json` for v1, or
`data/research/image_descriptions_v2/progress.json` /
`reports/image-description-v2/summary.json` for v2. The current CLI never resumes or mutates them.
Old variants must be settled/preserved; only the current generic v3 variant proceeds to a full run.

`--status` does not rehash originals or claim a fresh full validation. Its `observed_at` identifies
snapshot freshness. Every successful batch is validated again when resuming. Changed source hashes,
mappings, prompt/schema/model/effort or batch size make the manifest incompatible and halt rather
than silently replacing existing output. Submitted/unknown/failed states halt resumption: they may
represent a paid-for request and are never implicitly resubmitted. Authentication, rate-limit,
unsupported-model, timeout and validation failures leave their private evidence for review.

`--reconcile` only recovers already-written valid local artifacts from unresolved batches; it does
not submit the unresolved batch again. It checks state compatibility before mutation, refuses a
still-live recorded child PID, and rechecks event/tool and output contracts when recovering raw
output. Missing successful output/usage remains blocked. Do not remove state/locks/results to force
retries; inspect the private batch evidence first. Normal interruption may leave `submitted` rather
than `unknown`; the same no-resubmission rule applies.

For a durable local job, launch the already-tested resume command using a detached subprocess with
`start_new_session=True`, `stdin=DEVNULL`, and a private log, and retain its PID/start time/command
in a private launch receipt. The runner owns only its child subprocess group. SIGTERM and timeout
are handled as bounded interruptions: it terminates only that group, never unrelated Codex sessions.
No credentials or API budget are adjusted by this operational launch.

## Private output and provenance

All outputs are ignored by Git: `data/research/image_descriptions_v3/` and
`reports/image-description-v3/`. Directories are mode 700 and files mode 600 (process umask 077).
Original licensed images are unchanged. The inventory stores original SHA256, relative file paths,
and **all** person/post/image-position/source-ID/source-hash associations. Identical file contents
can share one visual annotation without dropping any source associations.

- `manifest.json`: compatibility hash, full original mapping, initial start time and batch size.
- `batch-NNNN/state.json`: submitted/succeeded/unknown, times, runner PID and result checksum.
- `batch-NNNN/result.json`: validated structured visuals, original mappings, observation timestamp,
  separated visual observation/emphasis/intent, `origin=image_derived`, fixed model/effort,
  prompt version/hash, `human_reviewed=false`.
- `batch-NNNN/workspace/`: anonymous copies, schema, raw response, private CLI events/stderr,
  child process identity, exact CLI argv/runner-source hash, observed usage. These are not public
  fixtures or documentation.
- `progress.json` and `reports/image-description-v3/summary.json`: validated referenced-file/content
  totals, status counts, timestamps, observed Codex usage and explicit incomplete/complete status.

Accounting sums exact observed `turn.completed` usage, including available unsuccessful-batch
usage, without adding cached-input tokens again. Available reasoning-output tokens are preserved
and treated as a subset; unavailable fields/cost remain null rather than estimated. Missing usage
for in-flight/failed sessions is reported, not invented. Separate Codex CLI sessions may not be
linked into the orchestrator's session tree; do not double-count their tokens in coordination totals.

Only implementation, synthetic tests and this current contract belong in a public commit. No original
image/caption, real description, session transcript, private report or key may enter Git. No push is
performed. Human review/retrieval integration and effectiveness evaluation are subsequent work;
this runner does not insert descriptions into original sources or start the LLMOps goal.

## Validation

`make check` runs synthetic unit tests, existing regressions, ruff and mypy. Synthetic tests cover
count/order/schema, source scope/path/mapping, SHA256 dedup associations, Unicode caption parsing,
fixed auth/model/tool settings, compatible resume, unknown-state no-retry, provenance tampering,
private modes, the single-writer lock, v3 emphasis/intent separation and bounds, rejected
absence of prompt domain examples/fixed intent taxonomy, required evidence/uncertainty/alternatives,
qualitative confidence and rejected actual-author epistemic labels,
concise salience bounds/no exhaustive inventory fields, complete v3 regeneration, and byte-preserved v1/v2
artifacts. Passing tests is not a substitute for an actual small requested-model image session
before a full run.
