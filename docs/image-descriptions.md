# Original-image descriptions (private, not yet RAG)

This stdlib-only runner annotates only JPEGs referenced by the selected four-person target posts.
It cross-checks the selected targets, research sources and original image mapping manifest. It
never glob-selects orphan images, other persons or generated creative artifacts. Original sources,
captions, personas, database, index and chat remain unchanged. Annotation is a separate preparation
step: descriptions must not be treated as original captions, original quotes or actual event truth.

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

From the repository root:

```sh
# Small actual model-and-image preflight (also creates the fixed target manifest).
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions --max-batches 1
# Resume all remaining batches, without resubmitting previously completed batches.
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions
# Safe while a runner is active: read the most recent atomic progress snapshot only.
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions --status
```

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
in a private launch receipt. The runner owns only its child subprocess group. On timeout/interruption
SIGTERM is handled as a bounded interruption; it terminates only that group; it never kills unrelated Codex sessions. No credentials or API budget
are adjusted by this operational launch.

## Private output and provenance

All outputs are ignored by Git: `data/research/image_descriptions/` and
`reports/image-description/`. Directories are mode 700 and files mode 600 (process umask 077).
Original licensed images are unchanged. The inventory stores original SHA256, relative file paths,
and **all** person/post/image-position/source-ID/source-hash associations. Identical file contents
can share one visual annotation without dropping any source associations.

- `manifest.json`: compatibility hash, full original mapping, initial start time and batch size.
- `batch-NNNN/state.json`: submitted/succeeded/unknown, times, runner PID and result checksum.
- `batch-NNNN/result.json`: validated structured visuals, original mappings, observation timestamp,
  `origin=image_derived`, fixed model/effort, prompt version/hash, `human_reviewed=false`.
- `batch-NNNN/workspace/`: anonymous copies, schema, raw response, private CLI events/stderr,
  child process identity, exact CLI argv/runner-source hash, observed usage. These are not public fixtures or documentation.
- `progress.json` and `reports/image-description/summary.json`: validated referenced-file/content
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
private modes and the single-writer lock. Passing tests is not a substitute for an actual small
requested-model image session before a full run.
