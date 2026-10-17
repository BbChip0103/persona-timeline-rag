# Framework deployment and isolated verification

> Historical TypeScript runtime reference: current API is split-only and the Node worker/legacy execution commands are retired. Reproduce these experiments from their archived reference checkout; use [current Python split](python-llm-split.md) and [native ownership](generic-framework-components.md) for current operation.

## Boundaries and versions

`infra/compose.framework.yml` is the new isolated infrastructure stack. It never loads
`.env.local`, mounts the research corpus, uses host networking, or attaches to existing
Postgres/Redis volumes. Every resource belongs to the generated `ptr-fw-<random>` Compose
project. Only user-facing/proxy ports publish on `127.0.0.1`; database services are not
published except the explicitly synthetic `runtime-test` profile. No existing live
container should be restarted to validate this stack.

Pinned images were checked against upstream registry metadata on 2026-10-10:

| Component | Actual pinned version |
| --- | --- |
| LiteLLM Proxy | `main-stable` immutable manifest `3d88bd757134…`; image package reports **1.104.2** |
| Langfuse web + worker | **4.56.0**, matching official published web and worker manifests |
| Langfuse/LiteLLM Postgres | **17.6-alpine** |
| Redis | **7.4.5-alpine** |
| ClickHouse | **25.12**, upstream Langfuse Compose recommendation |
| MinIO | Official Langfuse-recommended Chainguard image, immutable manifest `7df55d002b69…` |
| Synthetic engine only | Python **3.12.10-slim-bookworm** |
| Synthetic application DB only | pgvector **0.8.1-pg15**, isolated new volume |

The earlier proposed Langfuse `4.51.0` web tag returned `not found` from the registry,
although its worker tag existed. It is **not** silently substituted by v3: the stack
uses published matching v4.56.0 images. All complete manifest digests are in Compose.

Sources: [Langfuse official Compose](https://github.com/langfuse/langfuse/blob/v4.56.0/docker-compose.yml),
[Langfuse release](https://github.com/langfuse/langfuse/releases/tag/v4.56.0),
[LiteLLM official gateway quickstart](https://docs.litellm.ai/docs/proxy/docker_quick_start).

## New secrets, never copied credentials

Run from the repository root:

```bash
python infra/langfuse/init-framework-env.py --output /tmp/ptr-framework-new.env
# Validates quietly: normal `config` expands and prints secrets, so do not use it.
docker compose --env-file /tmp/ptr-framework-new.env \
  -f infra/compose.framework.yml --profile smoke --profile observability \
  --profile guardrails config -q
```

The generator exclusively creates a new mode-0600 file with unique project name,
random unused localhost ports, independent database/Redis/blob/auth secrets and
headless Langfuse organization/project/user/API credentials. Repeating the command
against an existing file fails rather than rotating stored database credentials.
`infra/langfuse/.env.example` contains **empty placeholders only**. No provider key,
existing database password, real evaluation sheet or research data is copied.

Keep the generated environment in a private secret store. Do not print it, commit
it, paste expanded Compose configuration or expose it in CI artifacts. Port selection
is a best-effort local allocation; if another process wins a released port, startup
fails without modifying that process. Create another **new** env/project for the retry.

## Historical LiteLLM proxy verification

The previous framework smoke used a real LiteLLM proxy, virtual-key bootstrap and
synthetic OpenAI-compatible upstream. That path is historical for this repository's
current operational Compose deployment. Current operations use the direct path in
[operational deployment](operational-deployment.md): the Python worker calls the
authenticated loopback vLLM endpoint directly, with `PTR_LLM_PROVIDER=local`,
`PTR_LLM_LOCAL_BASE_URL`, `PTR_LLM_LOCAL_MODEL`, `PTR_LLM_LOCAL_API_KEY` and
`PTR_LLM_LOCAL_AUTH_REQUIRED=1`, with `PTR_LLM_SPILLOVER=off`.

Do not run the old LiteLLM smoke, app-key bootstrap or proxy profile commands for
the operational stack. L4 removes the retired LiteLLM proxy helper directory from the active
repository; rollback uses the private operational snapshot. Retry, fallback,
health-probe and cost limits for the active stack are enforced at the
worker/provider boundary and verified by `pnpm ops:status` plus
`scripts/operational-smoke.ts`.

## Guardrails and Langfuse v4

```bash
docker compose --env-file /tmp/ptr-framework-new.env \
  -f infra/compose.framework.yml --profile guardrails --profile observability \
  up -d --wait --wait-timeout 480
python infra/langfuse/smoke.py --env-file /tmp/ptr-framework-new.env
```

Guardrails builds `apps/guardrails/Dockerfile`, listens internally on 8000, and exposes
`/health`. `GUARDRAILS_API_KEY` is populated from `PTR_GUARDRAILS_TOKEN`. The service
has no private-corpus mount; its isolated bridge disables outbound masquerade; Jev decisions enter as metadata,
not a second hidden paid call. App integration uses `PTR_GUARDRAILS_URL`,
`PTR_GUARDRAILS_TOKEN` and a bounded `PTR_GUARDRAILS_TIMEOUT_MS`.

Langfuse consists of **six persistent logical services**: web, worker, Postgres,
ClickHouse, Redis and MinIO-compatible blob. A one-shot blob initializer creates a
private bucket and installs its lifecycle policy. All stores/credentials/volumes are
isolated from application stores. Web and blob are localhost-only. Worker/databases
are internal-only. Web/blob attach an additional isolated host-access bridge with
outbound masquerade disabled. `HOSTNAME=0.0.0.0` ensures both v4 processes listen
on localhost/container interfaces rather than only Docker's default hostname IP. Telemetry, in-app agents and experimental features are disabled;
no model judge credentials are configured in the synthetic deployment.

Headless initialization creates the private operator and project; open signup is
disabled. `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` in the generated
file are the project SDK/CLI contract. UI authentication uses the generated user;
project ingestion requires project keys. Invalid project credentials must not ingest.
The worker healthcheck monitors queue consumption, and web health includes DB access.
Readiness is `/api/public/ready`, not merely a running process.

Before an internet-facing deployment, terminate TLS, provide access controls/network
policy and separate machine/storage failure domains. This Compose is a reproducible
single-node verification/deployment starting point, **not HA**. Do not base production
sizing on the developer machine. Measure average/peak turns, observations per turn,
bytes per observation, ingest/query latency, evaluation backlog, and 90-day data plus
backup/replication overhead; then provision independently.

Source: [Langfuse health/readiness](https://langfuse.com/self-hosting/configuration/health-readiness-endpoints),
[deployment and scale limitations](https://langfuse.com/self-hosting/deployment/docker-compose).

## 90-day retention: all storage copies

Automatic project retention is **Enterprise Edition**, not OSS. Setting an apparent
retention environment variable without a license would not implement this policy.
The OSS stack therefore uses two explicit layers:

1. `blob-lifecycle.json` expires events/media/exports and noncurrent object versions
   after 90 days; incomplete uploads expire after one day. The initializer installs
   and lists that rule using real `mc ilm import`; the bucket remains private.
2. The repository's `scripts/framework-retention.ts` is the explicit project-scoped
   retention CLI for traces/observations/scores, retained dataset input/output, and
   annotation queue items. Dry-run first, then apply only to a confirmed project.
   Treat the command's actual output as the evidence; configuration alone proves no
   row deletion. Age cutoff, project/environment and named dataset/queue scopes must
   be fixed before deleting. Verify asynchronous deletion by querying again.

Deleting traces removes their related observations/scores, but **does not erase
saved dataset items/run records**. Blob expiry also does not erase Postgres or
ClickHouse rows. The CLI/runbook must cover every retained copy; preserve neither
private review text nor history through an unbounded backup. Backups need <=90-day
expiry in the backup system and version/snapshot policies, not only S3 DeleteObject.
An external reference/backup remains outside Langfuse's API deletion boundary.
Audit/record-only metadata may be kept only if it does not contain conversation data.
Avoid direct hand-edited ClickHouse TTL/schema changes; use supported APIs and verify
row disappearance. Run the retained-data job daily from existing CI/operations,
alert on failed runs, and test with expired synthetic sentinel records before release.

Sources: [EE-only automatic retention and dataset exceptions](https://langfuse.com/docs/administration/data-retention),
[supported deletion APIs and asynchronous limits](https://langfuse.com/docs/administration/data-deletion).

## Paid-provider raw receipts (separate from checkpoint retention)

Explicit migration `0009_provider_receipt_scope.sql` adds request kind/turn linkage,
receipt timestamp and a sticky scrub marker to `ptr_provider_requests`. New chat
UUID keys and Jev UUID/window seeds link to their actual turn; stable `draft:` keys
are classified as standalone draft operations. Do not invent historical links from
hashed bodies or guessed UUIDs. Serving adapters never run migration/retention.

```bash
# Use only the explicit private DB target approved for this operation.
node --import tsx scripts/framework-receipt-retention.ts
node --import tsx scripts/framework-receipt-retention.ts \
  --apply --confirm-database ptr_framework_test
```

Dry-run is the default; apply requires the exact connected isolated database name.
Only >=90-day raw receipts belonging to >=90-day terminal chat/Jev turns without
outbox work, plus expired standalone drafts, are scrubbed. Active, resumable and
recent turns are excluded; concurrent terminal row locks are skipped. Receipt JSON
is nulled and its irreversible scrub marker set. Request identifiers,
submitted or unknown status, task state, actual/reserved cost, and generation IDs
remain as accounting and idempotency tombstones. The adapter continues refusing a second billable submission after
the replay payload expires. Unknown receipts cannot be restored by later finish or
reconciliation calls once scrubbed.

The CLI enumerates metadata/counts only and never logs receipt text or credentials.
Legacy unscoped/body-only receipts, missing turn links and unsupported embedding
scope are explicitly reported under `deferred`. Nonzero deferred counts are an
operator action item, **not full historical 90-day coverage**: retain them until a
separately verified private manual policy establishes whether their work can resume.
Preserve minimal terminal turn rows, or execute receipt retention before deleting
turn rows, to avoid orphaning new receipt scopes. Accounting tombstone retention is
indefinite unless a separately reviewed deduplication/billing policy changes it.

## Application runtime-test stores and drain

The root runtime integration can use `--profile runtime-test` to create a **new**
pgvector DB on `127.0.0.1:57432`, database `ptr_framework_test`, non-superuser
`ptr_framework_tester`, and queue Redis on `127.0.0.1:57479`. These two explicit test
ports must be unused; binding errors are not permission to stop other services.
Passwords are `PTR_FRAMEWORK_TEST_DB_PASSWORD` and `PTR_FRAMEWORK_QUEUE_PASSWORD`.
Use this target only for synthetic migrations/recovery/load tests; it is not research DB.
There is no dispatcher/gateway application process in the new architecture.

Infrastructure stop grace periods let the proxy finish bounded requests and Langfuse
flush workers. The app must stop accepting work, close BullMQ gracefully and flush
bounded telemetry before exiting. Validate app drain/recovery separately; an infra
healthcheck alone does not prove full API/worker behavior.

```bash
# Keep generated environment/project identity to operate only its own resources.
docker compose --env-file /tmp/ptr-framework-new.env \
  -f infra/compose.framework.yml --profile smoke --profile observability \
  --profile guardrails --profile runtime-test ps
# Coordinated final cleanup: `down` preserves volumes. Add -v only for NEW synthetic data.
docker compose --env-file /tmp/ptr-framework-new.env \
  -f infra/compose.framework.yml --profile smoke --profile observability \
  --profile guardrails --profile runtime-test down
```

Rollback preserves additive app schema and returns to the recorded Git baseline and
old configuration, not a second long-lived runtime branch. A v4 observability store
cannot be downgraded by pointing v3 at its migrated data. Keep version-compatible
backups for rollback; restoration to existing research/production stores is outside
this synthetic validation and requires separate authority.

## Synthetic historical baseline stores (benchmark only)

When a baseline of the untouched historical implementation is needed, use the
separate `infra/langfuse/compose.baseline.yml` project. Generate a new private env
using `python infra/langfuse/init-baseline-env.py --output /tmp/ptr-baseline-new.env`.
It creates new pgvector/Redis stores at57433/57480; inside that **new** database
container the historical logical pair `ptr_loadtester`/`ptr_loadtest` is created
with a generated password and no superuser privileges. The original DB at56432
is never accessed. Only a copied historical source tree may adapt its loopback
port guard to57433/57480 for the benchmark; production/main guards are untouched.
`BASELINE_DATABASE_URL` and `BASELINE_REDIS_URL` are the explicit private contracts.

Both baseline gateway and migrated proxy must call the same synthetic engine,
with the fixed100ms delay, fixed response shape/size, same worker concurrency,
input rate/burst and numeric gates fixed before either measurement. This supports
relative framework overhead/queue behavior only, not GPU quality or operating SLOs.
Stop/remove only the generated baseline project's resources after coordinated tests.
