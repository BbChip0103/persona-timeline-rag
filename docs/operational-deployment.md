# Owned three-tier operational deployment

Use `infra/compose.app.yml` with `infra/split/compose.operational.yml` for the
private Linux deployment. The override does not provision or recreate the approved
research database/queue. Validate their identities, durable storage, schema and
role grants first. Runtime credentials must never be migration-owner credentials.

For Kubernetes installation and operations, use [kubernetes.md](kubernetes.md).
The Compose path here remains independent. The K6 fixes to the API `pg.Pool`
idle-error listener, worker drain, K4 pass-through validation and gateway key
name `PTR_OPENROUTER_API_KEY` (defined in the private gateway env file) need an operational Compose redeploy before that
deployment benefits from them; obtain user approval for that redeploy. Apply
`supabase/split/0005_generated_artifacts.sql` before the API, and roll out the
API reader before workers that emit the new receipt wire schema. Check durable
ACKs and readiness after each role rollout.

## Configuration and supervision

Select a new owned Compose project/nonce, immutable verified backend and worker
image IDs, separate private environment files and loopback ports in a `0600`
operator Compose environment. Keep its directory `0700`. Do not print resolved
Compose configuration: it can contain secrets. Validate with `config -q`.
If paid failover is explicitly enabled, set `PTR_OPENROUTER_API_KEY` in the
private gateway env file referenced by `PTR_OPERATIONAL_GATEWAY_ENV_FILE`; keep
that key out of the operator Compose env file and all other role env files.

```sh
docker compose --env-file /private/compose.env \
  -f infra/compose.app.yml -f infra/split/compose.operational.yml config -q
# Only after identity, grants, image and configuration verification:
docker compose --env-file /private/compose.env \
  -f infra/compose.app.yml -f infra/split/compose.operational.yml up -d --no-build
```

Web receives only UI/session/API credentials and no corpus mount. Backend receives
the app role/control credentials; Python receives the LLM role, approved model key
and explicitly consented auxiliary-provider configuration. The gateway receives
no app/LLM database credentials. Its own PostgreSQL/Redis use owned durable volumes,
native health checks and bounded logs. All roles restart `unless-stopped`.

Gateway configuration must retain the pinned native scored/cache-affinity routing
extension, a self-hosted primary only, zero automatic retries and no paid fallback.
Set `turn_off_message_logging`, `redact_messages_in_exceptions` and
`store_prompts_in_spend_logs=false`, including `STORE_PROMPTS_IN_SPEND_LOGS=false`.
Use `/health/readiness`, not `/health`, which can invoke models. Give Python a
model-constrained native gateway key rather than the gateway master key.

Run the existing GPU engine through an authenticated private endpoint. When native
remote process supervision is unavailable, an operator-owned user-systemd unit can
supervise foreground SSH plus its loopback forward. Keep its environment, key,
script and cached model location durable, with native restart/backoff. Do not add a
TTL to a persistent service. Enable user linger only when persistent execution is
authorized. Native supervision is not proof of host reboot, instance recreation,
network availability or multi-engine performance.

Apply `supabase/split/0004_cumulative_budget_cap.sql` with the selected research
owner before live work. It makes the cumulative US$1 budget operator-controlled;
runtime cannot raise or delete/recreate the global cap. Preserve existing ledger,
immutable migration baseline and unknown reservations. GPU qualification call
limits and gateway-key budgets are **not** this monetary cap.

For a repeatable kind-only synthetic load run after the split ledger fills,
drain the kind API and workers, rename the old `ptr_split_test` database to a
distinct archive name, create an empty `ptr_split_test`, and run the existing
kind bootstrap Job before restoring the deployments. The archived database
retains all prior `unknown` reservations; never resubmit those requests. The
bootstrap rejects a nonempty target and re-applies the ordinary synthetic
US$1 cap. The kind-only `gateway.billing.maxCallMicrousd: 5000` limits the
reservation exposure of a 200-turn V5 run to US$1.00 even if all receipts are
`unknown`; it does not change the production setting or ledger rules. Do not
use this procedure for the research or production database.

The constrained LiteLLM application key must not be the first bottleneck during
worker scale-out. Set `gateway.bootstrap.rpm` to at least
`autoscaling.worker.maxReplicaCount * app.worker.concurrency`, plus operational
headroom. The production floor is `40 * 4 * 1.25 = 200 rpm`; the configured
`5000 rpm` also accommodates repeated short turns. The kind profile uses
`1000 rpm` and four in-flight turns per worker. The worker active-list scaler
threshold derives from `app.worker.concurrency`, so the active trigger tracks
that same capacity instead of a separate stale value.
The kind EPP queue TTL is 30 seconds because the simulator's first token takes
eight seconds; the queue size remains eight. Production retains its two-second
flow-control TTL.
For V5, apply `deploy/kind/k5-worker-values.yaml` after `values-kind.yaml` to
keep the two allowed synthetic engines warm, then restore the ordinary kind
values after the run so V6 can check engine scale-up from one. The kind API
allows ten minutes of synthetic queue wait; the production default remains one
minute. This avoids expiring unclaimed V5 turns while the 200-turn burst drains.

Kubernetes maintenance CronJobs use `concurrencyPolicy: Forbid` for scheduled
overlap only. Operators must not start a manual Job while a scheduled or manual
run is active, or start two manual runs together. Concurrent SQL apply runs are
still row-safe: native split retention and the legacy checkpoint and receipt
retention select candidates with `SKIP LOCKED`, then mutate those locked rows
in the same transaction. These retention steps remain valid Kubernetes CronJobs.

The weekly human-review steps are host/systemd-only in production.
`review-sample` writes private review sheets under the repo root, which is
read-only in the Kubernetes image, and `production-review` uses a lock and
journal that must live in a shared durable private directory. A Kubernetes
`emptyDir` would make that state per pod run. The production chart values
therefore disable `weekly-review-sample` and `weekly-production-review`; run
them only through the operator-owned host timers described in
`infra/split/maintenance`. Kind keeps those two CronJobs enabled only as
synthetic smoke tests, labelled `ptr.io/synthetic-smoke=true` and
`ptr.io/host-only-production-step=true`, with `/tmp` state and no private review
sheet output.

Redis classifies KEDA 2.21's `EVAL` with a declared key as write-capable even
when the script only calls `TYPE` and `LLEN`. The kind Redis ACL therefore uses
`%R~ptr:turns:*` for direct reads and a second queue-key selector for `EVAL`;
neither selector grants `SET` or another write command. Verify script-write
denial after changing KEDA or Redis versions.
For production `rediss` with a private CA, the worker scaler's Secret must
provide `REDIS_CA` and `REDIS_TLS_MODE=enable`. KEDA uses these together in
`TriggerAuthentication`; its `enableTLS` trigger field is reserved for the
system-CA path without a custom CA.

Apply `supabase/split/0005_generated_artifacts.sql` before deploying the new API;
draft requests fail without its table. No backfill of old `data/generated/*.json`
is needed because `loadArtifact` has no caller; leave those files in place.

When rolling out gateway receipts that can report the `local-pool` upstream, roll
the API before workers that emit those receipts. This keeps the durable ACK schema
reader ahead of the worker receipt writer during mixed-version deployments.

## Bounded acceptance and recovery

`scripts/operational-smoke.ts` requires explicit private configuration and an
owned deployment manifest. Default mode performs only identity, readiness,
unauthenticated-access and native idle-counter checks: no catalogue/model calls.
The operational qualification artifact root is fixed in the harness; another
qualification must intentionally update/review that boundary rather than reuse
stale phase markers.

```sh
pnpm exec tsx scripts/operational-smoke.ts --env-file /private/e2e.env
# Explicit approved live qualification only:
pnpm exec tsx scripts/operational-smoke.ts --env-file /private/e2e.env \
  --execute --owner-nonce <owned-nonce>
```

Live acceptance uses a synthetic API actor with an existing published persona,
RAG off, at most three distinct turn submissions, disabled retrieval tools and
one generation per attempt. Verify backend `PTR_MAX_ATTEMPTS<=3` and gateway/SDK
retries zero before live work: this bounds generation calls per turn to three,
within a 12-call qualification ceiling and 512 output tokens.
It verifies reply structure, owner isolation, idempotence, queued cancellation,
backend restart recovery, single assistant persistence, outbox drain and receipt
ACK. It stores only counts/state/private hashes, never persona IDs/labels/replies.
Native success counters corroborate successful generations; they do not prove an
atomic provider admission hard cap or unsupported error counters. Semantic
retrieval/Jev and human answer quality are separate acceptance stages.

The parent operator handles requested phases only after checking exact container
ID, owner label, Compose service/project and immutable image. Stop/drain the owned
worker first, keep backend/gateway alive, then restart only the owned backend and
resume the same worker. Acknowledge each phase atomically in a `0600` metadata file
with the exact fresh request nonce. Never use pattern process/container kills.
The override allows 90 seconds for worker shutdown and uses native dependency
ordering. Preserve failed proofs before another explicitly bounded qualification.

Rollback changes images/configuration, not post-cutover databases, queues, provider
ledger or receipts. Never restore an old snapshot over completed work. Public
ingress/TLS, historical hard-erasure and human quality decisions are not established
by operational acceptance; private central review export stays disabled unless
separately authorized.
