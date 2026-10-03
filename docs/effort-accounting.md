# Execution effort accounting

Local Codex accounting is separate from the aggregate US$1 research-provider ledger.

```bash
python3 scripts/record-codex-usage.py --since <UTC-start> --output reports/effort/codex-usage.json
```

The recorder reads the local runtime database and leader/descendant rollout usage records, never exports prompts, credentials, thread IDs, or rollout paths. It sums per-response `usage` once, not cumulative `token_count` or `thread_token_usage`; cached input and reasoning output are subsets, not additional token totals. Snapshots are private and in-progress: their unfinished current response is absent until a later sample.

The issue history maintains phase boundaries in KST with their provenance. Report total wall time, autonomous execution intervals, discussion/operational-update intervals, and unclassified/idle intervals separately. A user-to-assistant response interval can contain tool execution and waiting; it is not active human labor. Actual reading/typing/management time is unknown unless supplied or measured. Parallel child wall durations are not added to elapsed leader wall time.

Time-window token attribution includes context replay and cache hits. Whole-session totals and a goal-specific execution window are different scopes. No subscription price, invoice amount, or Codex dollar charge is inferred from token counts. External provider charges/reservations use their own durable budget ledger.
