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
| retired LiteLLM proxy helpers | 96 passed; 14 skipped |
| Helm lint | 4/4 profiles passed |
| kubeconform | 186 valid; 0 invalid/errors |

Temporary replica counts, simulator timing, router TTL, autoscaling pause, node cordon, and fault pods from the original round were restored. The follow-up loaded `ptr-worker:k6-drain-20261014` into kind and rolled out only the worker deployment; that live image tag is newer than the Helm release's stored tag. Private run evidence is in `reports/k8s/` with file mode `0600`. No commit or push was made.

## L3 direct-path addendum, 2026-10-14

The L3 chart path removes the `ptr-gateway` namespace and LiteLLM Kubernetes resources. New acceptance runs should treat worker to EPP and worker to fake OpenRouter as the allowed model paths. Historical rows above are preserved as recorded and still mention the previous LiteLLM gateway.

Updated checks:

- New wrapper results go to ignored `reports/k8s/acceptance-summary.private.md`; this historical table is not rewritten by a run.
- V7 fake OpenRouter lookup uses `ptr-app` / `ptr-fake-openrouter`.
- V10 denies unlabelled pods to EPP, engine and fake OpenRouter, and proves worker to EPP plus worker to fake OpenRouter.
- V13 fake submission accounting uses the fake OpenRouter pod in `ptr-app`.
- The spillover helper is `deploy/kind/worker-spillover-check.sh` and now checks the direct worker path.

L3 kind re-verification (synthetic data and fake OpenRouter only):

- Recreated `ptr-k8s` with `down.sh` and `up.sh`, created synthetic Secrets, and installed the `ptr` and `chat-primary` Helm releases. All active pods became Ready; `ptr-gateway` did not exist.
- A local smoke turn completed with a durable ACK and removed outbox entry. Its serving record was one `local` call, the provider's local cost was zero, and there were no paid ledger rows for that turn.
- `saturation-check.sh` passed: 32 requests yielded 2 successes, 22 `rejected-saturated` and 8 `rejected-ttl-expired` drops.
- The direct worker spillover check completed 100/100 turns and matched 98 fake submissions to 98 settled paid receipts, with no duplicate fake submissions.
- `V7NEG` reached all five direct worker fault origins (forged drop header on 500, 503, headerless 503, reset and timeout). All five turns failed; fake submissions and new paid ledger rows were both zero. The temporary fault pods, Services and NetworkPolicies were removed, and worker routing was restored.
- With the fake key reporting `limit_reset: "daily"`, newly started workers logged `OPENROUTER_SPILLOVER_CHECK_FAILED` and rejected startup. After restoring `null`, the worker rollout became Ready and logged `OPENROUTER_SPILLOVER_ENABLED`.
- V10 passed: three unlabelled targets denied, and worker to EPP plus worker to fake OpenRouter allowed.
- V13 passed: 100/100 turns completed at submission concurrency 16, with zero outbox or duplicate rows; 96 fake submissions matched 96 paid receipts.
- Helm lint passed for app and router kind/prod values. Kubeconform found 79/56 app resources and 8/8 router resources for kind/prod, with zero invalid or errors after CRD schema checks.

The full V7 wrapper had a 10/10 saturation and spillover pass in one L3 run, but its first negative-probe attempt encountered a transient API 502 before reaching the forged-header target. A later full rerun was stopped after the known intermittent EPP saturation failure appeared on its first repeat. `V7NEG` provides the completed negative-case evidence above; no full V7 PASS is claimed for L3.

## L4 gateway removal addendum, 2026-10-14

This is a targeted L4 verification on `kind-ptr-k8s` with synthetic data and the in-cluster fake OpenRouter. It does not change the historical acceptance verdict above or claim a full V7 rerun.

- The current `ptr` chart upgraded to revision 5 with `ptr-backend:k2-l4-20261014a` and `ptr-worker:k2-l4-20261014a`. An earlier upgrade attempt hit the previous `kubectl-set` ownership of the worker model timeout; the successful kind-only upgrade used Helm server-side conflict resolution. The worker now renders `PTR_LLM_MODEL_TIMEOUT_MS=25000` and has no `PTR_PAID_SPILLOVER` env.
- After rollout, all 32 active pods and 13 deployments were Ready. A synthetic RAG-off smoke turn completed with one durable ACK and no outbox residue.
- One `saturation-check.sh` run passed: 32 requests yielded 2 successes, 22 `rejected-saturated` drops and 8 `rejected-ttl-expired` drops.
- One `worker-spillover-check.sh` run completed 100/100 turns: 90 settled paid ledger receipts matched 90 fake OpenRouter submissions, with no duplicate fake submissions. After the helper restored its temporary worker setting and API autoscaling settled, all 39 active pods and 13 deployments were Ready.
- Offline L4 checks (corrected by independent review; the original report said 1,598): service pytest 1,485 passed/24 skipped; root pytest 154 passed/80 subtests; `make check` 141 unittests plus Ruff and mypy; main Jest 1,702 passed/110 skipped and OTel Jest 18 passed; TS typecheck, lint, web build, three Compose renders, four Helm lint profiles, kind/prod kubeconform plus local CRD schemas, fake engine 7 tests, fake OpenRouter 6 tests, production fixture render guard and actionlint all passed.

## L5 autoscaling correction, 2026-10-14

First L5 round (worker cap only, before the engine-demand fix), recorded by the
coordinator from that round's report:

| Case | Result |
|---|---|
| A — one engine, 200 turns | Wait list peaked at 196; workers held at the 2/2 cap; 200/200 completed, 0 failed, 0 outbox. |
| B — two engines | Workers reached the 3/3 cap; 100/100 completed. The second engine had to be forced with a temporary minimum because the engine queue trigger read a metric name that EPP v0.11.0 does not export (`llm_d_epp_flow_control_queue_size`); review also showed a structural deadlock (worker cap keeps the EPP queue below the engine threshold). Fixed below. |
| C — drain | Workers returned to 2 and engines to 1; no lost turns. |
| D — Prometheus outage | Fallback reached 4 workers; recovered afterwards. Superseded by `currentReplicasIfLower` below. |

The kind worker concurrency for the active L5 chart is 2. Older V5/V6 rows above
used concurrency 4 and should not be compared directly to the L5 worker cap.
With `maxNumSeqs=2` and the default 1.25 headroom, one ready engine caps workers
at 2 and two ready engines cap workers at 3.

Live L5 E1-E3 results on `kind-ptr-k8s`, synthetic data and fake OpenRouter.
The final 200-turn run used the corrected `AverageValue` engine formula in Helm
revision 21; revision 22 restored the kind control-plane CIDR after the outage:

- E1 submitted 200 turns at about 14:04:03 UTC. Engines scaled from 1 to 2 at
  14:04:58 UTC and the second engine was Ready at 14:04:59 UTC. The worker cap
  rose from 2 to 3; the third worker was created at 14:05:13 UTC and all three
  were Ready by 14:05:30 UTC. The run completed 200/200 with 0 failed, 0
  cancelled, 0 outbox residue and 0 duplicate completion rows. Ledger rows:
  100 local and 100 fake spillover; fake OpenRouter submitted 100 requests with
  0 duplicate IDs.
- E2 scaled Prometheus to zero from 14:05:35 to 14:06:31 UTC. Engines held at 2
  and workers held at 3 while both KEDA ScaledObjects showed fallback. The
  Prometheus pod returned, but its Kubernetes discovery remained blocked by a
  missing kind control-plane CIDR from the Helm upgrade. Revision 22 restored
  that CIDR; all eight scrape targets were then healthy and fallback cleared.
- E3 drained the Redis wait and active lists to zero. Workers returned from 3
  to 2 at 14:08:57 UTC; engines returned from 2 to 1 at 14:10:12 UTC after
  scraping recovered. The E1 terminal proof found 0 lost turns.

L5 round 2, 2026-10-14 UTC, used the same synthetic kind cluster and fake
OpenRouter only. The worker formula now uses Deployment Ready replicas from
kube-state-metrics and 1.0 headroom at steady state; 1.25 applies while desired
engines exceed Ready engines. The engine backlog divisor uses the 1.0 steady
headroom. kube-state-metrics 8.6.0 was enabled with only the `ptr-inference`
Deployment collector. KEDA's Redis list scaler still needs `EVAL`; `EVALSHA`
was removed. Live ACL dry runs allowed `EVAL`, denied `EVALSHA`, and both
ScaledObjects remained healthy.

| Case | Result |
|---|---|
| F1 — fixed one engine | Engine max was pinned to the current count of 1. With the final kind worker minimum of 1, 60/60 turns completed, 0 failed/cancelled/outbox/duplicate rows; wait peaked at 58 and active at 2. Across 200 samples, desired and Ready workers stayed at the steady cap of 1. Fake spillover receipts: **0** (1,118 before and after). An earlier fixed-two-engine run also completed 200/200 with 0 lost, workers at 2/2 across 404 samples, wait peak 196, and **0** fake spillover receipts (1,028 before and after). |
| F2 — one to two engines | Kind's worker minimum 1 and a temporary simulator readiness delay of 90 s exposed the scale-up window. Engines first showed desired 2 / Ready 1 at 15:03:30; Prometheus `scaling_up=1` at 15:03:47; workers reached 2/2 at 15:04:20, never above the scale-up cap of 2. The second engine was Ready at 15:05:00, with workers at the two-engine steady cap of 2/2 through the remaining 32 s of sampling. All 100/100 turns completed, with 0 failed/cancelled/outbox/duplicate rows. Fake spillover receipts: **26** (1,092 to 1,118). |
| F3 — idle | After restoring engine max to 2 and removing the temporary readiness delay, engines returned to 1/1, workers to the final kind minimum of 1/1, and both Redis wait and active lists were 0. The passing F1 and F2 terminal proofs found 0 lost turns. |

An initial F2 attempt used Prometheus `up` for ready-engine capacity. It
counted the second simulator while its Deployment was still unready, allowing
workers to reach 3; that signal was replaced with Deployment Ready replicas.
The initial attempt's 100 turns reached terminal state, but its helper hit a
Kubernetes API sampling timeout after completion, so only the corrected F2
run above is counted as a passing terminal proof.

Prometheus was scaled to 0 from 15:08:08 to 15:09:12 UTC. At 15:08:56 both
KEDA ScaledObjects were in fallback and held workers 2/2 and engines 1/1;
fallback cleared at 15:09:39. After changing kind's worker minimum to 1, a
second outage ran from 15:25:35 to 15:26:39 UTC. At 15:26:24 both ScaledObjects
were in fallback and held workers and engines at 1/1; fallback cleared at
15:26:47. A synthetic RAG-off smoke turn completed with durable ACK and no
outbox residue on the final profile. One saturation check passed: 32 requests,
2 successes, 22 `rejected-saturated`, and 8 `rejected-ttl-expired` drops.
