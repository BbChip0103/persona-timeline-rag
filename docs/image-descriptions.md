# Original-image descriptions v2 (private, not yet RAG)

This stdlib-only runner annotates only JPEGs referenced by the selected four-person target posts.
It cross-checks the selected targets, research sources and original image mapping manifest. It
never glob-selects orphan images, other persons or generated creative artifacts. Original sources,
captions, personas, database, index and chat remain unchanged. Annotation is a separate preparation
step: descriptions must not be treated as original captions, original quotes or actual event truth.

## Observation versus communicative intent

V2 prioritizes retrieval/story-worthy **salient memory**, not everything visible. Objective prose
is 2–3 short sentences when useful, at most 500 characters; fewer are fine for ambiguity. Every
detail list is at most three short strings and may be empty. Incidental passersby, shirt colors,
background objects and microdetail are omitted unless central to the shot. Scenery focuses on
scenery/atmosphere; makeup portraits may focus on makeup/hair/styling; presented products focus on
product/important label. Colors/composition/text matter only when defining the presentation. The
`uncertainties` field addresses ambiguities affecting the main point or intent, not boilerplate
unknown dates/places or every unreadable background letter. No padded descriptions or invented
intent for every photo; this is not a guaranteed relevance oracle.

V2 saves three deliberately separate layers under each result's `images[].visual`:

1. `description_ko` and visible detail fields: grounded observation, not inferred motive.
2. `observed_emphasis`: visible `main_subjects` and `visual_basis` about framing, position, label
   orientation, size, contrast, color or focus: at most three subjects and three basis strings.
   An identified emphasized subject needs visible basis.
3. `communicative_intent`: `epistemic_status=tentative_not_author_fact` with zero to two hypotheses.
   Each has `kind`, tentative Korean `hypothesis_ko`, nonempty `visual_basis` copied verbatim from
   the observed basis, qualitative `confidence` (`low` or `medium`), `uncertainty_ko`, and at least
   one alternative (at most two). Basis strings reference at most two observed cues per hypothesis.
   Prefer one hypothesis when helpful; no hypothesis is required when intent is unclear.

Detail/subject/basis strings are at most 120 characters; hypothesis/uncertainty/alternative strings
are at most 180. The prompt requests a model self-check for central focus, omission of incidental
details, brevity and inference separation. Provenance records the checklist as **AI self-check, not
human verification**, and retains `human_reviewed=false`. These limits and labels are structural
checks, not an independent semantic relevance assessment.

This considers what the **photo's presentation could communicate**, including a plausible reason
for making/posting that kind of image, not what the actual author thought or intended. A centered
cream container/forward-facing label can support possible product presentation, not paid advertising
or endorsement certainty. Scenery with feet in frame can support scenic-experience framing, not
verified travel motive, location, date or emotions. Psychology, personality, identity and private
beliefs are outside the annotation contract. Intent hypotheses must never become original quotes
or factual event/author claims. Structural validation checks labels, basis references and bounds;
it does not prove that every natural-language interpretation is visually correct. Human semantic
review remains necessary.

The fixed v2 variant re-annotates **every** referenced image, even those with existing v1 objective
captions. It is a deliberate prompt/schema change, not a retry of unresolved v1 work. V1 outputs,
state and observed Codex usage stay in their old directories untouched; no annotations or usage
from the two variants are silently mixed. The v2 manifest includes its prompt version and variant
policy; incompatible output/config cannot be reused.

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

The current module defaults to `original-image-ko-v2`,
`data/research/image_descriptions_v2/`, and `reports/image-description-v2/`.
From the repository root:

```sh
# Small actual model-and-image preflight (also creates the fixed target manifest).
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions --max-batches 1
# Resume all remaining batches, without resubmitting previously completed batches.
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions
# Safe while a runner is active: read the most recent atomic progress snapshot only.
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions --status
```

To inspect archived v1 progress, read `data/research/image_descriptions/progress.json` or
`reports/image-description/summary.json` directly; the current CLI does not resume or mutate v1.
Do not start v2 full generation until the prior v1 runner's bounded current session has settled.

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

All outputs are ignored by Git: `data/research/image_descriptions_v2/` and
`reports/image-description-v2/`. Directories are mode 700 and files mode 600 (process umask 077).
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
- `progress.json` and `reports/image-description-v2/summary.json`: validated referenced-file/content
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
private modes, the single-writer lock, v2 emphasis/intent separation and bounds, rejected
unsupported motive/ad-fact kinds, required evidence/uncertainty/alternatives, qualitative confidence,
concise salience bounds/empty irrelevant fields, complete v2 regeneration, and byte-preserved v1
artifacts. Passing tests is not a substitute for an actual small requested-model image session
before a full run.
