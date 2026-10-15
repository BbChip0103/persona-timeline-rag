# S2 disposable Compose acceptance — 2026-10-15

All runs used synthetic personas, an internal-only Docker network, `ptr_split_test`,
and fake local/OpenRouter HTTP fixtures. No paid or external model call was made.
The C4 API started with `PTR_CHAT_PROVIDER=local` and `PTR_PAID_SPILLOVER=0`,
matching its spillover-off worker.
Its worker held the local slot and was killed as a container during an in-flight
model call. The framework runtime still rejects local plus paid spillover.

| Case | Final observation | Result |
| --- | --- | --- |
| C1 | 20/20 complete; maximum local concurrency 2; observed offloads 10 = fake OpenRouter submissions 10 = settled ledger receipts 10; unknown receipts 0; duplicate submissions 0 | Accepted |
| C2 | 8/8 local with exhausted budget, paid submissions 0 | Provider check passed |
| C3 | Key-check failure and missing ZDR separately: 8/8 local in each case, paid submissions 0 | Provider check passed |
| C4 | Actual worker container SIGKILL during the first, one-shot marker-stalled local call; lease expiry at deadline + 1,901 ms, observed reclaim at + 1,925 ms; `repairExecution` advanced dispatch 0→1 and attempt 2 claimed while the old lease was live, waited 4,489 ms for expiry, then completed with exactly one assistant message; all four queued turns completed, 5/5 terminal, 0 outbox rows, 0 paid submissions | Accepted |
| C5 | Submitted HTTP 500 and timeout separately: each one unknown ledger receipt, one fake POST, zero duplicates, unrelated local call completed | Provider check passed |
| C6 | Real `LLMEngine.draft`: 8/8 complete, maximum local concurrency 2, observed offloads 4 = fake submissions 4 = settled receipts 4 | Provider check passed |

C4 uses the production default of three turn attempts, a 10 s turn deadline,
and a 15 s marker stall on only the first engine call of the first turn. The
disposable stack uses a zero stalled-job allowance and short lock/repair checks
to exercise the production `repairExecution` retry path before the dead worker's
local slot expires. The worker loads the mounted repository's wire contract;
the image's older embedded contract does not allow the `local` serving upstream.
The retry acquired the slot after the old lease expired and completed without a
duplicate assistant message. The four other turns were queued after the crash
while the retry waited. Paid spillover was disabled, the synthetic database had
no paid ledger table, and the paid submission count was zero. The old standalone
lease-subprocess C4 check remains in the provider harness as a separate,
partial check.

Final provider run: `ptr-cacc-c05cdb0d4f1d` (exit 0). Final real-worker C4 run:
`ptr-c4-2b47847e5f70` (exit 0; preceding retry-path repeat
`ptr-c4-15f2e4517532` also passed). Both runners recorded immutable IDs, verified
their Compose project labels, removed only those IDs, and verified complete
cleanup. Synthetic private logs and resource manifests are under
`reports/compose-acceptance/<project>/`.

## Limits of C4

- C4 sets `PTR_LLM_STALLED_INTERVAL_MS=100` and `PTR_LLM_MAX_STALLED_COUNT=0`. Production uses 30000 and 1, so after a worker crash the retry starts later in production. This run did not measure that delay.
- In this run the retry waited about 4.5 s for the dead worker's slot lease to expire. Only one slot was configured, which makes this the worst case. The wait is bounded by the old turn deadline plus 1.9 s, and a retry gets a fresh 30 s deadline. With 8 slots, one crashed worker takes only one slot until its lease expires.
