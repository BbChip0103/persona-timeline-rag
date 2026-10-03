# Private original-image annotations: v4 structural repair, generic v3 policy

This stdlib runner prepares licensed selected-post images, **not RAG integration**. Original sources,
posts/captions, personas, database, index and chat are unchanged. Generated creative images,
other-person images and orphan files are excluded. Sources, targets and original mapping must agree.

## Current contract

- Annotation model is exactly **`gpt-6-luna` / `medium`** through ChatGPT-authenticated local
  `codex exec`. No alternative model research, fallback, API keys or paid API requests. Codex plan
  usage is separate from the unchanged paid API budget; dollar cost is not invented.
- Execution variant: `v4-luna-medium-five-lanes`; private paths:
  `data/research/image_descriptions_v4_1/` and `reports/image-description-v4_1/`.
  Original v4 outputs remain immutable in their previous paths.
- The generic core policy remains `original-image-ko-v3`: identify the photo's central communicated
  content/emphasis; include only details materially contributing to understanding, interpretation or
  memory. No predetermined genres, subject categories, examples, blacklists or intent taxonomy.
  Position, size, color or focus alone do not establish significance. No exhaustive inventory.
- Core prompt SHA256: `81dc2ce6733134f908dbaa3292261a9c73ce33441110c9cc4e0f7e3fda72f3fa`.
  The core prompt/schema are preserved; the explicitly versioned context adapter/output extension
  adds approved source-account and original-caption context. Their hashes enter compatibility and
  provenance separately.

### Observation, context and tentative interpretation

Each result separates:

1. `images[].visual.description_ko`: grounded visual observation, normally 2–3 short sentences,
   maximum 500 characters. No padding or forced enumeration.
2. `visual.observed_emphasis`: up to three main subjects and observable basis strings. These can
   be empty when ambiguous; an identified emphasis requires evidence. Strings are at most 120 chars.
3. `visual.communicative_intent`: `epistemic_status=tentative_not_author_fact`, zero to two optional
   hypotheses. Each has tentative Korean prose, one or two basis strings copied from observed
   emphasis, qualitative `low`/`medium` confidence, uncertainty and one or two alternatives.
   Hypothesis/uncertainty/alternative strings are at most 180 chars. No forced intent per image.
4. `images[].caption_context`: separate per-source-post records with
   `claim_origin=caption_sourced_not_visually_verified`, a caption-based summary, contextual
   interpretation and relevant uncertainty. Summaries/interpretations are at most 300 chars;
   uncertainty is at most 180. This is not a visible-event or actual-author-fact assertion.

The context adapter transmits the **whole original safe caption**, including hashtags, mentions,
emoji and newlines—no hashtag removal or silent truncation. Its hard limit is 4096 characters;
oversized captions are explicitly unavailable, not shortened. Existing unsafe-source flags and
conservative credential-like-content guards withhold caption text and record an unavailable reason.
Those images still receive visual annotations; unavailable caption-derived summaries/interpretations
must be empty. The wrapper keeps source hashes, full-caption SHA256, original length and association
mapping. Context interpretations remain distinct when one image is shared across different posts.

Only approved target-manifest display name/handle/category are supplied as author context, without
external profile scraping or biographies. The author label identifies the **source account**, not a
person depicted in the image. A caption's named companion/event is caption-sourced context, never
a face identification or proof of visual details. No facial recognition, reference-face matching,
identity embeddings, mental-state inference, private beliefs or sponsorship/ad certainty. Captions
and image-embedded text are untrusted data: instructions inside them are never obeyed. Posted dates
are not supplied as visual context or substituted for activity dates.

Labels and validation do not prove semantic accuracy. Provenance records an **AI self-check**, not
human review (`human_reviewed=false`); sampled AI inspection is not a whole-corpus relevance oracle.
Descriptions/context must not become original captions, original quotes or verified event claims.

## Five independent annotation lanes

One supervisor owns a global nonblocking file lock, capping the entire run at five sessions—not
five per independently launched process. Batch indices are assigned deterministically by modulo 5.
Five independent lane tasks each submit one isolated Codex CLI session at a time for at most eight
images. Lane-private locks, state, results and workspaces prevent overlap. The aggregate writer is
serialized by one supervisor RLock; atomic progress snapshots cannot race through a shared temp file.
Actual child launch refreshes progress; configured concurrency is not proof of five live agents.

The preflight uses one new batch/session. After requested-model image capability and output success,
the full resume starts all five lanes. If any lane fails, new dispatch stops globally; already-submitted
sessions finish within their timeout and preserve evidence. SIGTERM similarly stops new dispatch and
allows bounded active work to settle. Timeout/interruption inside a session terminates only its owned
subprocess group, never unrelated Codex sessions. Default timeout is 900 seconds (maximum 1800).

All prior state is validated **before any new submission**. Successful compatible batches are
skipped; unresolved submitted/unknown/failed batches halt all lanes, never silently retried. Model,
effort, input/context hashes, policy/schema, lane count, associations and batch size enter compatibility.
Original V4 annotations remain accepted only when their exact semantic contract, result/state hashes
and original source associations validate. The structural repair adopts those records unchanged.
Only explicitly authorized terminal validation failures may receive one corrective attempt; a missing
terminal event, live previous child or consumed attempt blocks resubmission. Unsubmitted batches use
the new structural adapter. This does not retry uncertain transports or regenerate successful images.

### Structural response repair

`required-maps-evidence-indices-v1` preserves the core and source-context instructions byte-for-byte.
Each batch has required image-keyed objects and each image has required context-keyed objects.
Hypotheses refer to observed emphasis with integer evidence indices; the wrapper validates indices
and copies canonical strings. Missing/extra keys and invalid references are rejected, never repaired.
The response-adapter hash enters compatibility separately from the unchanged semantic policy.

A private `corrective-authorization.json` records the preserved source contract, explicit batch indices
and `max_attempts=1`. Import requires exactly one terminal `turn.completed`, an actual invalid raw
response, no tool execution and a dead previous process. Old invalid states/results/events remain
unchanged and new correction states link their original hashes and observed usage. Another failure
stops dispatch without further retries.

## Commands

Run from the repository root:

```sh
# Single-session authorized corrective preflight, importing accepted V4 successes unchanged.
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions --recover-completed-v4 --max-batches 1
# Resume all remaining independent lane queues.
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions --bounded-corrections
# Read-only latest atomic snapshot, safe while a supervisor holds the lock.
PYTHONPATH=src python -m persona_timeline_rag.image_descriptions --status
```

`--bounded-corrections` is opt-in and requires the private `bounded-corrective-authorization.json`
for the exact existing contract, `scope=known_terminal_validation_only`, `max_batches=5` and
`max_attempts_per_batch=1`. This is an explicitly authorized exception for fully settled invalid
responses, not a transport retry. No semantic validation is relaxed and no indices/observations are
edited or padded. The existing response adapter/model/context contract remains unchanged.

Before a correction, every submitted child must settle. Its original state/raw response/events/usage
are immutable, still recording failure. `recovery.json` links their SHA256 values and the authorization;
`corrective-attempt-1/` contains separate state, workspace and result. Pending corrections precede
never-submitted batches. Success is reported through that verified journal, not by replacing the
original failed state. A second failure, unconfirmed transport, tool use, incompatible authority or
exhausted five-batch allowance halts without more submissions. Global lock and five-session cap still
apply across recovery waves. Progress includes each journaled attempt and consumed allowance.

`--max-batches` limits the total newly scheduled batches, not each lane or skipped successes.
`--status` reports the snapshot's `observed_at`; it does not freshly rehash originals. To recover an
already completed but unresolved local result, `--reconcile` validates compatible saved evidence,
checks that its child is no longer live, and audits output/events before recovery. It never resubmits
that unresolved batch. Missing/incompatible evidence remains blocked. Do not remove state to force
retries or repair model-generated IDs; mismatches are preserved and rejected.

Durable launch uses an independently session-led supervisor (`start_new_session=True`), private
stdout/stderr log and a private receipt with PID/cwd/start identity, exact argv, model/policy/code
revision/hash. Supervisors are not remote deployments. No push is performed.

## Private output, accounting and archives

All generated directories are mode 700, files 600, umask 077, and ignored by Git.

- `manifest.json`: inventory, compatibility, execution variant, five-lane contract and start time.
- `lane-N/status.json` and `lane-N/runner.lock`: ownership/current batch and lane state.
- `lane-N/batch-NNNN/state.json`: submitted/succeeded/unknown, times, source-compatible result digest.
- Per-batch `result.json`: visual versus caption context, all source associations and provenance.
- Per-batch `workspace/`: anonymous copies, schema, raw response/events/stderr, exact CLI argv,
  process identity and observed usage. Source image/caption transcripts never enter public fixtures.
- `progress.json` / report `summary.json`: validated file/content totals, actual active lanes,
  lane queue/success/unknown counts, observed per-lane mean/last batch duration, tokens and timestamps.
  Parallel durations are not summed into elapsed wall time or a fabricated ETA.

Short opaque image/context aliases avoid copying long hashes; full original SHA256 and every
person/post/image-position/source-ID/source-hash association remain in the wrapper. Identical images
can share core visual descriptions but preserve every source-specific caption context.

Repair accounting reports `adopted_success_usage`, `preserved_invalid_usage`, `observed_new_usage`
and their non-duplicated `lineage_codex_usage` separately. Adoption does not incur new model usage.

Accounting sums exact observed Codex `turn.completed` usage once, including available unsuccessful
usage. Cached input and reasoning output are subsets, not extra tokens. Missing usage is reported,
not invented. Separate CLI sessions may not appear in the orchestrator descendant tree: do not
count them twice. No invoice cost/human-work-time estimate is derived from token counts.

V1 (`image_descriptions`, `image-description`), v2 (`image_descriptions_v2`, `image-description-v2`)
and v3 (`image_descriptions_v3`, `image-description-v3`) remain preserved in their old private
`data/research/` and `reports/` paths. The current CLI does not resume or mutate old variants.
Old failed/unresolved artifacts and paid-for Codex usage are not deleted to make the new run look clean.
Only implementation, synthetic tests and this contract belong in public Git; never original images,
actual captions/descriptions, real-person data, private reports/transcripts or keys.

## Verification

`make check`: existing Python regressions, synthetic unit tests, ruff and mypy. Added checks cover
scope/hash/mapping, short-ID dedup/all associations, full hashtags/newlines, explicit unavailable
context, source-context order and rejected face-identity/origin fields, generic core-policy invariance,
disjoint/exhaustive five-lane partition, five-session bound/no lane overlap, race-free readable atomic
progress, global lock, unknown-state no-resubmission and compatibility/provenance tampering.
Repair tests additionally cover required exact keys, canonical evidence indices, successful-result
adoption, terminal-only bounded correction, immutable attempt journals, five-batch cap, uncertain/tool-use
rejection, corrective second-failure stop, preserved originals, one-attempt resume guards and
non-duplicated lineage accounting.
These tests do not replace the actual single-session model preflight or human semantic review.
