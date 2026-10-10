# Host maintenance: explicit owner boundary

These user-systemd units are **definitions, not deployment evidence**. They run
outside app/worker processes. No owner credential is added to either serving
service or image. The Python runner is stdlib-only; subprocess dependencies must
already be installed/pinned. `uv run --no-sync` never updates them during a timer.

## Private configuration

Create `~/.config/ptr-maintenance/` and its `state/` directory as the current user,
mode0700, and explicitly author `maintenance.json`, mode0600, using
`maintenance.example.json`. Symlinks, shared permissions, unexpected environment
keys, runtime DB credentials and inconsistent database names are rejected. Do
not copy app/worker environment files or put secrets in unit files/command lines.
The only DB URL is `PTR_LLM_MAINTENANCE_DATABASE_URL`, loopback58432,
`ptr_split_owner`, exact `ptr_split_test` or `ptr_split_research`.

- `daily.apply`: false by default. True enables the already-authorized native
  90-day recovery-data purge with exact configured database confirmation.
- `daily.limit`:1..1000 terminal turns/provider receipts per invocation, default100.
  Active/outbox/unknown/unlinked records fail closed or defer as native retention
  specifies. A limit-limited run is not proof all old records are gone; inspect
  remaining/deferred counts and qualify backlog capacity separately.
- `weekly.apply`: false by default. True creates the existing private local
  review sheet, `--since7d`, deterministic date seed, `--prune`, no S8 input.
  It does not enable central private-content export. Fewer than20 eligible
  turns and no S8 use scheduler-only `--allow-empty`: successful skipped status
  (`rows:0`, `dbSkipped:true`, `emptySample:true`), no new sheet/trace. Manual
  sampler commands still fail `empty_sample` by default. This is not review
  completion or human approval.
- `timeoutSeconds`:30..300, default90, **one whole-job budget**. Child stdout is
  capped at2MiB while streaming; timeout/failure kills the owned process group,
  including descendants after a wrapper exits. Cleanup adds at most bounded
  grace. An exclusive OS flock prevents daily/weekly overlap.

Optional Langfuse scope:

```json
"langfuseRetention": {
  "from": "2025-01-01T00:00:00Z",
  "projectId": "EXACT_APPROVED_PROJECT_ID",
  "queueIds": ["EXACT_DEDICATED_REVIEW_QUEUE_ID"]
}
```

Add only `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, optional
`LANGFUSE_ALLOW_LOCAL_HTTP`, `FRAMEWORK_RELEASE` under `env`. This operation is
restricted to the **production-review** trace environment and explicitly named
queues, with no datasets, project deletion, direct DB purge or historical raw
import. Native APIs submit asynchronous trace deletion; query absence is not
proof of backup/blob/log physical erasure. The fixed `from` must predate the
90-day cutoff. Credentials must select exactly the confirmed project.

Central review is an additional, separate private-content opt-in:

```json
"centralReview": {"apply": false, "projectId": "EXACT_ID", "queueId": "EXACT_ID"}
```

Leave it omitted/false unless approved. True is rejected unless `daily.apply`
is true and the same project/queue belongs to `langfuseRetention`. It additionally
requires an independently generated stable64hex `PTR_PRODUCTION_REVIEW_SALT`
and the explicit `PTR_PRODUCTION_REVIEW_APPROVAL=approved-redacted-final-turn-review`
under private `env`. **Do not generate that approval marker as deployment
boilerplate.** Obtain explicit content-export approval and verify the daily
retention timer is actually active/successful first. Regex masking is not
anonymization: user/final-reply prose is still private content.

## Dry-run, status, installation

```sh
# Default daily native inventory only; weekly dry-run performs no source reads/exports.
python3 scripts/split-maintenance.py --config ~/.config/ptr-maintenance/maintenance.json --operation daily
python3 scripts/split-maintenance.py --config ~/.config/ptr-maintenance/maintenance.json --operation weekly
python3 scripts/split-maintenance.py --config ~/.config/ptr-maintenance/maintenance.json --operation status
```

Manual `--apply` enables that operation; `--scheduled` uses its explicit private
`apply` setting. Logs/status contain allowlisted counts, timing and flags only;
child stderr and private payloads/credentials are never forwarded. Failed jobs
store `ok:false`; unknown reservations are not automatically retried.

Review unit `WorkingDirectory`, `ExecStart`, pinned Node/uv `PATH` against the
selected installation. Copy the four reviewed files into
`~/.config/systemd/user/`, then `systemctl --user daemon-reload`. Initially keep
both apply settings false, start each service once, inspect counts-only status
and `systemctl --user show ... -p Result -p ExecMainStatus`. Enable reviewed timers
with `systemctl --user enable --now ptr-maintenance-daily.timer
ptr-maintenance-weekly.timer`; confirm `systemctl --user list-timers` next run,
last run and actual active state. Calendars use the host timezone: daily03:15,
Monday03:45, up to10min jitter, persistent catch-up. These are user services;
verify user-manager lifetime/linger/reboot behavior before claiming unattended
operation. Service definitions alone do not prove successful deployment.

## Validation

```sh
uv run --no-sync --project apps/llm-service pytest -q scripts/test-split-maintenance.py
NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --runInBand --runTestsByPath \
  scripts/production-review.test.ts packages/ops/test/production-review-transport.test.ts \
  scripts/review-sample.test.ts
systemd-analyze --user verify infra/split/maintenance/*.service infra/split/maintenance/*.timer
```

`production-review-smoke.ts` is a synthetic-only native proof for an explicitly
approved self-hosted project and owned `/tmp/ptr-followup-three-20261011/` scope.
It reads no source DB/review/S8 data, creates only invented input/output, verifies
native IDs/root/source clock and queue binding, then deletes only its owned
trace/item IDs while proving an unrelated owned control trace remains. It leaves
an empty operational queue/rubric for a later separate opt-in; it is not permission
to export actual conversations. Never reuse the smoke to purge other records.
