# Disposable Compose spillover acceptance

Run from the repository root:

```sh
python3 deploy/compose-acceptance/test_contract.py
python3 deploy/compose-acceptance/run.py
python3 deploy/compose-acceptance/run_c4.py
```

The runner uses an existing Python 3.13 worker image (override with
`PTR_ACCEPTANCE_IMAGE`) and the repository's installed
`apps/llm-service/.venv/lib/python3.13/site-packages` for newly added dependencies.
The real-worker C4 runner also uses the existing `ptr-backend:515f3fc` image
to launch the current repository API source from a read-only mount.
It mounts repository source read only and creates a UUID Compose project.
Postgres (`ptr_split_test`) and Redis are disposable, with no published ports,
external networks, production env files, or persistent data volumes. The runner
shares the disposable Postgres network namespace so provider loopback guards
remain effective. The Docker network is internal and cannot reach paid services.
The only key is a literal synthetic fixture token.

The existing `infra/fake-engine/fake-engine.py` is imported directly. C4 places
its native one-shot stall marker on the first engine call of the first turn and
checks its counters. The C4
worker uses the mounted repository's wire contract directory.
The existing kind OpenRouter fixture supplies pricing/key/ZDR and response
contracts, extended locally with verification failure, missing ZDR, submitted 500,
and submitted timeout cases. The production provider, Redis lease implementation,
Postgres ledger adapter, and domain draft engine execute unchanged. Ledger tables
come from the existing ledger migration; the fixture creates the synthetic
migration-budget baseline. This is provider/ledger acceptance, not a complete
application database migration or operational Compose deployment test.

`assertions.py` is separate from the load generator. Its contract tests were
written before the harness, checking that absent observations, receipt mismatch,
and duplicate submissions fail.

| Case | Coverage |
| --- | --- |
| C1 | 20 requests, concurrency 4, slots 2, maximum active engine calls, observed offloads = fake submissions = settled receipts, zero failures/duplicates |
| C2 | Disposable ledger cap zero, eight requests complete locally, zero paid submissions |
| C3 | Key verification outage and missing ZDR separately, eight requests each, all local |
| C4 | `run_c4.py` starts a disposable split API and Python BullMQ worker, kills the worker container during the first marker-stalled call, restarts it, and requires `repairExecution` to re-queue the lost turn under the default three-attempt limit. It checks one assistant message, four other completed turns, lease reclaim by deadline + 2 seconds, a successful retry after waiting for the held slot, zero paid submissions, and an empty outbox. The provider harness retains its earlier lease-subprocess check. |
| C5 | Submitted HTTP 500 and timeout separately; exactly one failed/unknown request, zero duplicate submissions, unrelated local request succeeds |
| C6 | Eight real `LLMEngine.draft` requests use the configured slot-controlled provider |

The provider runner prints `provider_checks_passed` only after its bounded
assertions pass. The real-worker runner records its own C4 outcome in a separate
private report and requires the actual worker container to be killed.

Each run records immutable container and network IDs before execution, verifies
project labels before deletion, and removes only those IDs. Private synthetic
logs, resource manifests, cleanup evidence, and the run summary live under
`reports/compose-acceptance/<UUID-project>/`, with files mode 0600. Stdout contains
only the project, report location, exit code, and cleanup status. Failed runs keep
the same evidence and cleanup behavior. No environment values are printed.
