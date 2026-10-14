# K6 final fix round — kind acceptance, 2026-10-14

Scope: `kind-ptr-k8s`, synthetic data, local simulator, fake OpenRouter, and no paid calls. The acceptance bars are design §7, including its K6 V3 interpretation. The original round ran V1, V2, V3, V7, V8, V9, V11, V13, then V4, V5, V6, V10, V12. The follow-up reran only V2 worker deletion. An initial V2 setup attempt stopped before any subcase because of a Helm field ownership conflict; an initial V7 setup attempt stopped before its first saturation check because EPP could not reach the Kubernetes API. Both setup faults were repaired before the measured runs. A FAIL means a clause failed or its evidence was not obtained.

**Result: 5 PASS, 1 PARTIAL, 7 FAIL.** No bar was relaxed.

| Test | Status | Final measured result | Unmet clause and cause |
|---|---|---|---|
| V1 | FAIL | 48/48 completed; 0 failed | New pod Ready transition recorded, but KEDA removed it before the harness fetched timestamped logs. First request ID and arrival within 10s were not proved. The harness now snapshots logs while the pod exists. |
| V2 | PARTIAL | Original worker delete: 14/16 completed, 2 `PROVIDER_REQUEST_UNRESOLVED` from premature guard cancellation. After the drain fix, the single worker-delete rerun completed 16/16 with 0 failed, 0 duplicate/outbox rows, 16/16 ACKed receipts, and 4/4 sampled nonterminal turns ACKed. Earlier engine delete and node drain each completed 16/16 with 16 ACKs; PDB had 2 healthy and 1 disruption allowed. | Not proved that the deleted worker pod held any of the in-flight turns (2 workers × up to 4 jobs; no per-job pod attribution). A later run should log the processing pod per job. Other clauses: PDB 2 healthy / 1 allowed and 0 request IDs first seen after deletion (engine and drain sub-cases). The worker-only harness initially printed FAIL because it cast text turn IDs as UUIDs; the query was corrected. |
| V3 | FAIL | Pre-submit subcase did not create a turn (`HTTP_502`); mid-generation had a nonterminal turn with an execution grant at kill. | Pre-submit completion and a terminal event over reconnected SSE were not proved. The pre-submit harness created a session after stopping workers; the common DB proof also crossed the app/LLM credential boundary. Both harness paths are corrected for future runs. |
| V4 | PASS | 100/100 completed during API ×3 rolling update; outbox and duplicate completions 0; 100 ACK receipts. | — |
| V5 | PASS | 200/200 completed; workers 2→6 within 60s, held while active, returned to 2; 0 failed/outbox/duplicates. | — |
| V6 | FAIL | Original engine stayed Ready with 0 restarts; desired engines stayed at 1. | The GPU holder pod failed with `OutOfnvidia.com/gpu`, so 1→2 scale-up, exactly one extra Pending pod, and post-Pending request success were not proved. |
| V7 | FAIL | Saturation 10/10 including three EPP restarts; 100-turn fake spillover helper passed; direct paid alias without a grant was blocked with a valid app key. | Fault request-ID correlation was incomplete because EPP rewrote upstream IDs; timeout was not actually injected, and reset plus full queue was not proved. The earlier unknown receipt's exact ID cannot be derived from archived aggregate evidence, so reconciliation remains unproved. Fault pod marker logging and timeout injection are corrected for future runs. |
| V8 | FAIL | (a) A direct stall trigger was observed, but the fake stall pod did not stall when reached through EPP. In the later batch, 97 requests returned `413` in 2–18 ms because the fake engine rejected requests without `Content-Length`; only 3/100 completed. This was not saturation. (b) Readiness exclusion 0s and liveness restart 38s. | The intended EPP-path stall and its request ID were not proved; deadline failure and ≥95% later healthy routing were not proved. R4, EPP keeps routing to an engine that has stalled but still reports healthy, was **not tested** and remains open. Side note: EPP kept routing to a fast-failing pod. The fake engine now accepts bounded chunked requests for a future valid run; V8 was not rerun. |
| V9 | FAIL | 24/24 terminal: 19 completed, 5 classified `PROVIDER_REQUEST_UNRESOLVED`; outbox/completion duplicates 0; API `readyz` 503→200; workers 2→2. | KEDA `Fallback=True` was not observed during the brief Redis restart. The harness now samples the fallback condition and holds a future outage long enough to test it. Failed terminal turns do not violate this bar. |
| V10 | PASS | Four unlabelled targets blocked; 2/2 allowed paths connected; C1 rejected a non-cluster URL. | — |
| V11 | FAIL | Manual Job completed; `JobAlreadyActive` proved `Forbid` kept one active Job. | The selected Job did not change synthetic DB rows, and `jobTemplate.metadata` lacked the synthetic label during the run. The chart label and a synthetic DB marker Job are fixed for future runs. |
| V12 | PASS | Wrapper reported 11/11 commands; its hidden kubeconform error was corrected and independently revalidated: 186 resources valid, 0 invalid/errors. | — |
| V13 | PASS | 100/100 completed; budget errors, outbox, duplicates, unclassified failures 0; 87 fake submissions matched 87 settled paid receipts. | — |

## Fix evidence

- `pg.Pool` idle errors: new unit test failed before the listener and 2 tests passed afterward. In kind, a Postgres 1→0→1 interruption gave API `readyz` 503→200 with 0 restarts of the new API pod. The handler logs only a SQLSTATE-shaped code.
- Python worker: six new control and classification tests failed before the runtime change; the domain file then passed 390 tests. Control loss before submission is re-raised. Failed-turn logs contain fixed error code, exception class, core reason, and provider code without exception messages. V13 improved from the previous 98/100 with two generic failures to 100/100.
- Worker drain: a real BullMQ/throwaway Redis SIGTERM test failed on the old code because the job entered BullMQ `failed` before completion or ACK; it passed after `_worker_done` stopped cancelling guards during `close()`. In kind, the worker-only V2 rerun had 16/16 completed and ACKed. Its four sampled turns had provider rows created before deletion sampling, receipts after sampling, and one ACKed receipt each. The proof query's `text = uuid` error was repaired and the saved run was checked read-only; no second worker deletion was run.
- Kind scheduling and shutdown: contract tests failed for Postgres placement and simulator `preStop`, then passed (3 targeted tests; 28 in the full chart contract file). Postgres has a fresh PV on the non-GPU worker. The simulator has a 15s `preStop`, and the engine PDB rendered at minimum 2 for V2 only.
- EPP restart: kind router egress now permits the Kubernetes API service and the control-plane endpoint on 443/6443. The EPP rolled out Ready after this repair.
- Helm validation: V12 first masked a prod vLLM duplicate `lifecycle` key. The duplicate and shell return-code propagation were fixed; a fresh four-profile kubeconform run found 186 valid, 0 invalid, 0 errors.

## Final suites and release state

| Suite | Evidence |
|---|---|
| Root pytest | 155 passed |
| Service pytest | 1,457 passed; 24 skipped |
| `make check` | 143 tests; Ruff passed; mypy checked 17 files |
| `pnpm test` | 1,777 passed; 110 skipped |
| `pnpm typecheck`, `pnpm lint`, web build | 3/3 passed |
| Compose app and framework config | 2/2 passed |
| infra/litellm | 96 passed; 14 skipped |
| Helm lint | 4/4 profiles passed |
| kubeconform | 186 valid; 0 invalid/errors |

Temporary replica counts, simulator timing, router TTL, autoscaling pause, node cordon, and fault pods from the original round were restored. The follow-up loaded `ptr-worker:k6-drain-20261014` into kind and rolled out only the worker deployment; that live image tag is newer than the Helm release's stored tag. Private run evidence is in `reports/k8s/` with file mode `0600`. No commit or push was made.
