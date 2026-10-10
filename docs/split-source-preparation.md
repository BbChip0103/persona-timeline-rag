# Approved source preparation for the split database

`pnpm prepare:split` is an **offline maintenance tool**, not a serving worker or a
LangChain wrapper. It reuses `prepare()` and `importablePersonas()` from the historical
TS preparation tool. Serving remains backend / Python worker / LLM gateway. No model,
embedding, download, startup DDL or service restart is performed by this command.

## Explicit inputs and authorization

Use only sources whose import/license is approved for this research. The approval flag
records operator intent; it does not certify a license or replace privacy review.
Never import fictional/generated posts as licensed source evidence.

- `--posts`: approved UTF-8 JSONL. Each original row has `person_id`, `post_id`,
  `caption`, `posted_at`, `source_url`, and nullable `event_date`. Original row content
  (including extra metadata and JSON property order) participates in its source hash.
- `--targets`: JSON `{ "people": [...] }`, with `username`, `display_name`, `category`,
  `cohort` per person. Sources outside these targets and duplicate source IDs fail.
- `--authored-list`: required current, accurate private persona list bound to the exact
  database, `{ "database": "ptr_split_research", "personas": [...] }`. An explicit
  empty list is allowed only when there are no authored personas; missing files fail.
  Authored persons' generated candidates remain in the private artifact, but are not
  published/imported. Their sources still import.
- Optional `--previous-generated-list`: an explicitly selected previous `personas.json`
  artifact (array or database-bound persona list). A changed existing current persona
  may advance only if its exact content matches this baseline. Unknown/unlisted current
  definitions fail closed rather than being inferred from a `silver` review status.
  This is an operator-selected baseline, not a cryptographic authorship certificate.

Input files must be regular, non-symlink, single-link, current-user-owned and private
(no group/other permissions), maximum 16 MiB each; posts are capped at 10,000 rows and
targets at 100. Output requires a current-user-owned private parent directory and a
**new** output leaf. Artifacts are mode `0600` inside a mode `0700` directory. They contain
private source/persona text: do not commit, print or publish them.

## Prepare, inspect privately, then apply

Set `PTR_LLM_MAINTENANCE_DATABASE_URL` privately to the explicit `ptr_split_owner` URL
for the exact loopback port `58432` database `ptr_split_research` (or `ptr_split_test`).
Do not use runtime credentials or a serving environment file. URL guard runs before
input reads; apply additionally checks the actual connected database/user and schema.

```sh
umask 077
mkdir -p /private/approved-preparation
# Set the maintenance URL without exposing it in shell logs or command arguments.
pnpm prepare:split \
  --posts /private/approved-posts.jsonl \
  --targets /private/approved-targets.json \
  --authored-list /private/current-authored-personas.json \
  --approval approved-licensed-source-import \
  --output /private/approved-preparation/dryrun
```

Default dry-run writes prepared artifacts and count-only `preparation.json` / stdout,
but opens **no DB connection** and makes no DB writes. Inspect only approved private
preparation artifacts; automated agents must not read human review sheet rows. Re-run
with a different new output directory to apply:

```sh
pnpm prepare:split \
  --posts /private/approved-posts.jsonl \
  --targets /private/approved-targets.json \
  --authored-list /private/current-authored-personas.json \
  --approval approved-licensed-source-import \
  --output /private/approved-preparation/applied \
  --execute --confirm-database ptr_split_research
```

Add `--previous-generated-list /private/previous-preparation/personas.json` only for an
intended generated-persona revision advance with that exact current baseline. For
synthetic fixtures, use `ptr_split_test`, its bound authored list and `--synthetic`;
synthetic origin on `ptr_split_research` is forbidden.

## Preserved policy and transactional boundary

- Unsafe-caption regex is conservative screening, **not** a privacy/injection guarantee.
  Unsafe sources are marked, not silently erased or semantically redacted.
- Split is per-person safe-caption **UTC calendar-day 70:30 chronological proxy**,
  not semantic same-event grouping. At least five safe development posts are required.
  Persona style and source references use development rows only. Imported event dates
  are preserved; unknown dates are not inferred from posting time. Generated personas
  remain `silver`, not human-validated identity or answer-quality evidence.
- Source snapshot hashes the entire original batch. Treat batches as immutable:
  identical batch reruns are idempotent; appending/changing an old batch changes its
  snapshot and conflicts with previously imported source IDs. Do not bypass this by
  editing existing source rows or disabling immutable triggers. Prepare distinct approved
  new-source batches (with sufficient development rows) or use a separately designed
  migration if historical source identity truly needs changing.
- One transaction covers **all** `llm.source_posts` and importable persona revisions.
  Immutable source/revision conflicts roll back the whole DB batch. Existing persona
  ID/person binding is preserved; exact reruns do not move an existing revision pointer.
- Short maintenance table locks serialize import/publication writes, while reads
  continue. Lock wait is 1 s, statements 5 s; the batch checks a 60 s deadline between
  operations. A statement in progress may take its own timeout. This is explicit
  maintenance, not a throughput/online-ingestion claim.
- No `app` table, provider accounting/idempotency ledger, saver, vector, generated-post
  or image table is changed. `personasImported` counts processed importable personas,
  not only newly inserted revisions.

Artifacts created before a failed DB transaction remain private; missing successful
`preparation.json` is not an apply acknowledgement. A report-write failure after COMMIT
can leave a committed batch without that report: retry the **same immutable input** into
a new output directory and use the idempotent counts, never infer rollback from a CLI
failure alone. Errors printed by the CLI withhold private details.

New sources do not gain retrieval embeddings or native post summaries here. An approved
separate native summarize/index qualification is required before activating such an
index; don't run legacy public-schema index scripts against split credentials. Local
source import also makes no claim about complete deletion of artifacts, traces, external
providers or backups; use the separate scoped erasure/retention policy.

## Synthetic verification

Unit regressions cover the original screening/split/style/hash policy, private files,
owner identity and transactional failures. The opt-in actual-PG suite requires three
explicit freshly owned synthetic `ptr_split_test` role URLs:

```sh
# Private harness sets PTR_SPLIT_PREPARATION_TEST_DATABASE_URL (owner),
# PTR_SPLIT_PREPARATION_TEST_APP_DATABASE_URL and
# PTR_SPLIT_PREPARATION_TEST_LLM_DATABASE_URL; never discover live credentials.
pnpm exec jest --runInBand --runTestsByPath \
  scripts/split-prepare-research.test.ts \
  scripts/split-prepare-research.integration.test.ts
```

Without the owner URL the PG suite is visibly skipped, not an integration pass. It
tests idempotency/provenance, both whole-batch rollback paths, connected DB/role denial,
explicit baseline advancement and authored-current protection. Immutable rows are not
deleted by test teardown; the harness destroys **its own disposable container** afterward.
