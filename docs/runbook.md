# Local chat / Goal 1 research runbook

## Scope and prerequisite

Node24 compatible, pnpm workspace, TypeScript5.7, Nest10, Next15.5.27/React19.2.6.
Versions follow the integration family, not proprietary code imports. Python ingestion is retained.
Next uses a compatible patched release rather than copying the reference's older patch.

All sources/personas/secrets/outputs are ignored and private. Tests use synthetic fixtures.
Copy `.env.example` only on a new install, create random local auth/session secrets, and use
`scripts/db-init-env.ts` for the **new, isolated** DB config; never overwrite existing credentials.
See [DB setup](../infra/README.md) for limited role, exact loopback target and logging precautions.

## Offline checks

```sh
pnpm install
pnpm check
pnpm exec tsc -p apps/web/tsconfig.json --noEmit
pnpm exec eslint apps/web e2e
pnpm exec playwright test --config=e2e/playwright.config.ts
NEXT_TELEMETRY_DISABLED=1 pnpm build:web
make check
```

Browser tests start a synthetic local API fixture and Next dev server; stop real listeners on
56440/56441 before running. Run E2E and production build sequentially, not concurrently.
Optional actual SQL tests use environment flags; never export secret URLs in command text/logs:
`RUN_STORAGE_DB_TESTS=1`, `GOAL1_TEST_BUDGET_DB=true`, and safe `GOAL1_TEST_DATABASE_URL`.

## Database / preparation

```sh
docker compose --env-file .env.local -f infra/compose.db.yml up -d db
node --env-file=.env.local --import tsx scripts/db-migrate.ts
node --env-file=.env.local --import tsx scripts/prepare-research.ts
node --import tsx scripts/prepare-evaluation.ts
```

Preparation expects approved `data/manifests/targets.json` and `data/processed/target_posts.jsonl`.
It imports immutable source snapshots and versioned silver personas. Existing imported content
cannot be overwritten under the same ID/revision. Conservative unsafe-caption regex is **not**
an exhaustive privacy/injection check. Personas use development-only caption length/emoji/hashtag
statistics and manifest categories. Same-day/person chronological dev/test is only a grouping proxy.

## Live research (explicit, shared cap)

Provider authorization and external processing permission must be established before enabling live.
All live text/embedding callers share durable PostgreSQL reservations with a **US$2 aggregate cap**
and 10000-call limit (raised by the user on 2026-10-05 from the agent-chosen US$1/1000). This is not a per-run/provider budget. Never reset budget rows between reruns.
Model prices are verified from public OpenRouter catalogs. Unknown prices fail closed.

```sh
GOAL1_LIVE_ENABLED=true node --env-file=.env.local --import tsx scripts/live-research.ts preflight
GOAL1_LIVE_ENABLED=true node --env-file=.env.local --import tsx scripts/live-research.ts baseline
GOAL1_LIVE_ENABLED=true node --env-file=.env.local --import tsx scripts/live-research.ts index
GOAL1_LIVE_ENABLED=true node --env-file=.env.local --import tsx scripts/evaluate.ts --live
node --env-file=.env.local --import tsx scripts/live-research.ts budget
```

Canonical embedding model is `openai/text-embedding-3-small`,1536 dimensions; the exact observed
vendorless response alias is accepted, no arbitrary model substitution. Explicit reported cost
is settled; missing/invalid cost keeps reservation. Timeout/ambiguous submission does not auto-retry.
Persistent response hashes reuse known output without another POST. Failed source vector imports
can resume from existing immutable vectors; do not change model space under the same revision.
Text defaults to Gemini 3 Flash Preview (reasoning effort minimal), temperature0. Earlier Goal1 results used Gemini2.5 Flash-Lite. No automatic model fallback.

Private reports record actual/fake mode, settings, revision, source IDs, errors, latency and costs.
Silver questions are caption-derived keyword/date probes, not independently authored human gold.
Do not use their retrieval/source agreement as event-date truth, persona fidelity, or deployment readiness.
The 50 extraction cases preserve unknown dates and distinguish candidate extraction from human validation.
Timeline v3 asks for sourceId + exact quote only; the core derives canonical UTF-16 offsets
from a unique same-source occurrence. Supplied legacy selectors are still strictly validated,
never repaired. This fixes selector arithmetic, not semantic entailment.

## Local UI/API

```sh
node --env-file=.env.local --import tsx apps/api/src/main.ts
pnpm --filter @ptr/web start
```

API56441/UI56440 bind **127.0.0.1**. Web's private `.env.local` needs only UI password/session
secret/API token; the API URL is a constant (`PTR_API_URL` only gives a warning, a different value stops the web).
Provider keys/database credentials stay server-side. Production needs `PTR_CHAT_PROVIDER=gateway|openrouter`
(`fake` only with `PTR_DEMO_SCALING=1`; see [configuration.md](configuration.md), `pnpm ops:check-env`);
for paid chat explicitly set `PTR_CHAT_PROVIDER=openrouter` and `GOAL1_LIVE_ENABLED=true`.
The ledger must already be initialized. It stops further paid requests at the same research cap.
Login with private configured password. Do not expose these localHTTP services on a public interface.
The BFF uses signed HttpOnly owner sessions, fixed same-origin routes and server-only Bearer token.
There is no production identity system or durable restart worker: process death can leave a pending
turn requiring explicit diagnostic handling. See API/web/core contracts for actual guarantees.

## Images and effort

Images are separately generated fictional creative artifacts, never licensed source evidence.
Only explicitly authorized free queue mode is in scope; no paid fallback/reference uploads.
Service eligibility/transport can change. A task submit is not an image completion; persisted IDs,
status, bytes and balance checks are required. No duplicate submit on timeout/uncertain response.

[Effort accounting](effort-accounting.md) separates Codex cached/uncached tokens and wall intervals
from provider dollars. Human reading/typing/management time remains unknown if not measured.
Historical decisions/time checkpoints live beside the external issue, not duplicated here.

## Goal2 serving (Redis queue, workers, SSE, LLM gateway, load tests, engines)

Turns always run queued: API (`pnpm dev:api`) + worker(s) (`pnpm dev:worker`) + dispatcher (`pnpm dev:dispatcher`),
optionally the LLM gateway (`pnpm dev:gateway`, workers with `PTR_CHAT_PROVIDER=gateway`). All need the local Redis
(`infra/compose.redis.yml`, `PTR_REDIS_URL`) and migrations through 0008 (`0008_turn_leases.sql`); evaluation scripts need Redis too. The
synthetic load/failure harness on `ptr_loadtest`, self-hosted engines over an SSH tunnel and the GPU benchmark
scripts are documented in [goal2-serving.md](goal2-serving.md).

## Authentication and owner spaces

Threat model : single-user research serving; every process binds 127.0.0.1 only (code guards). The
browser authenticates to the web with the login password and a signed HttpOnly cookie; the web proxy authenticates to
the API with the Bearer `PTR_API_TOKEN` and names the owner in `X-PTR-Owner`. The remaining risks are a local process
holding a token (the load harness included) claiming an arbitrary owner, and harness owners mixing with the real web
owner. Other OS users and malicious local processes on the same host are out of scope: reading the token files already
grants everything. So instead of signing owner assertions the API separates the owner spaces:

- the production token accepts only `local-<40 hex>`, the owner the web derives (`apps/web/lib/auth.ts`);
- the harness token `PTR_API_SYNTHETIC_TOKEN` (demo layer, `PTR_DEMO_SCALING=1`) accepts only `lt-[a-z0-9-]{1,40}`
  (`scripts/loadtest.ts`) and `owner_synthetic_[a-z0-9_]{1,40}` (API tests);
- any other token/owner pair is 403 `UNAUTHORIZED`; the API refuses to start when the two tokens are equal
  (`synthetic_token_reuse` in `ops:check-env`).

The login password (`PTR_UI_PASSWORD`) needs at least 12 characters: in production mode the web refuses to start below
that; with `PTR_DEMO_SCALING=1` only the login route refuses it (503 `AUTH_UNAVAILABLE`).

## Redis ACL migration and rollback

`infra/compose.redis.yml` runs Redis with an ACL (–D13): the app user `ptr` (password
`PTR_REDIS_PASSWORD`), the `default` user off, no `requirepass`, no admin user. Moving an existing `requirepass`
container keeps the volume and the AOF. Redis is not a source of truth; a lost job is re-published from the outbox.
Values are never printed; only key names and counts.

1. Stop every app process (api, worker, dispatcher, gateway, evaluation scripts, load tests) and check that Redis is
   idle (only the `CLIENT LIST` line count is printed):
   `docker exec ptr_goal2_redis sh -c 'REDISCLI_AUTH="$PTR_REDIS_PASSWORD" redis-cli CLIENT LIST | wc -l'` → `1` (before
   the move; afterwards `CLIENT LIST` is refused to `ptr`, use `INFO clients` → `connected_clients:1`).
2. Back up: `BGSAVE` the same way, wait for `LASTSAVE` to change, then
   `docker cp ptr_goal2_redis:/data data/backups/redis-<stamp>/` (`chmod -R go-rwx`), and copy `.env.local` next to it
   (mode 600). Keep the old compose file: `git show <pre-ACL commit>:infra/compose.redis.yml > data/backups/redis-<stamp>/compose.redis.yml`.
3. In `.env.local`, change `PTR_REDIS_URL` from `redis://:<pw>@…` to `redis://ptr:<pw>@…` (user name only; the password
   stays `PTR_REDIS_PASSWORD`). Edit it without printing the file.
4. `docker compose --env-file .env.local -f infra/compose.redis.yml up -d --force-recreate redis` and wait until healthy.
5. `pnpm ops:check-env` (no `redis_username_ptr`), then
   `RUN_REDIS_TESTS=1 node --env-file=.env.local node_modules/jest/bin/jest.js packages/messaging --runInBand`, then a
   synthetic load test (`PTR_DEMO_SCALING` is set by the harness), then start the roles.

Rollback (also the break-glass path: there is no admin user). The startup check of this code requires the user name
`ptr` (`redis_username_ptr`), so after steps 1–3 the roles start only from the pre-ACL code (`git checkout <pre-O3
commit>`); otherwise keep them stopped and use the old Redis for admin access only.

1. Stop the app processes again.
2. Restore `.env.local` from the backup copy (or put `PTR_REDIS_URL` back to `redis://:<pw>@…`).
3. `docker compose --env-file .env.local -f data/backups/redis-<stamp>/compose.redis.yml up -d --force-recreate redis`
   (the old `requirepass` config on the same volume; the project name `ptr_goal2` and container name are in the file).
4. Only if the data itself is damaged: stop the container, copy the backed-up `/data` back into the
   `ptr_goal2_redis_data` volume (`docker cp data/backups/redis-<stamp>/data/. ptr_goal2_redis:/data/` while stopped),
   and start it again.
