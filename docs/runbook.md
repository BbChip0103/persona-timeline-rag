# Local chat / Goal 1 research runbook

> Historical pre-framework procedure. For current serving, use [framework runtime](framework-runtime.md). Old gateway/dispatcher/local review-sheet commands below are not the default migration path.


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
scripts are documented in [goal2-serving.md](goal2-serving.md). Metrics (`/metrics/prom` on every role), JSON log
lines and `pnpm ops:status` are described in [observability.md](observability.md).

## Deploy with Compose (production profile)

 (D22–D24). `infra/compose.app.yml` (project `ptr_app`) runs the roles from one image (`Dockerfile`,
`ptr_app:local`): api, worker, dispatcher, web, and the gateway behind the `gateway` profile (only for
`PTR_CHAT_PROVIDER=gateway`; with `openrouter` it is not started). Postgres and Redis stay in `compose.db.yml` and
`compose.redis.yml`, both `restart: unless-stopped`. Every app service has the same settings:

- `network_mode: host`, so every role keeps its loopback guard and fixed 127.0.0.1 port (56440 web, 56441 api, 56442
  worker metrics, 56443 dispatcher metrics, 56460 gateway). Linux only. Never run the `pnpm dev:*` processes, the native
  commands above or a load test on the default ports at the same time. The api, web and gateway exit on a taken port, but
  the worker and dispatcher only log `metrics_listener_failed` and keep running, so their healthcheck could reach the
  other process: check `ss -ltnp | grep -E ':564(4[0-3]|60)'` is empty before `up`.
- `user: "${PTR_UID:-900}:${PTR_GID:-2000}"` (`init: true`, so SIGTERM reaches the role). On another host, set
  `PTR_UID`/`PTR_GID` in `.env.local` to the account that owns `data/generated` and can read `data/`.
- `env_file: ../.env.local` (`required: false`; a missing file shows up as `config_invalid` at startup), `restart:
  unless-stopped`, json-file logs rotated at 10 MB × 5 files per container. Every role receives the whole file (one env
  file, D22), including infra keys such as `PTR_DB_PASSWORD`, visible in `docker inspect`. Keep infra-only passwords in
  `infra/.env.db` ([DB setup](../infra/README.md)) when that matters.
- Mounts: `data/` read-only and `data/generated` read-write on api and worker; the upstreams file read-only on the gateway.
  Nothing else from the host. The image contains no `.env*`, `data/`, `reports/` or `accounts/` (`.dockerignore`).
- Healthchecks (`node -e fetch`, no curl): api `/api/health` (database `SELECT 1` and Redis `PING`, D23), worker
  `:56442/healthz`, dispatcher `:56443/healthz`, gateway `/healthz`, web `/login`.
- `stop_grace_period: 35s` on worker and gateway: a turn has a 30 s deadline; SIGTERM lets the worker finish its turns
  and the gateway drain (`gateway_draining` / `gateway_drained` log lines). Both exit 0 after a clean stop.

Requirements: Docker Engine with Compose v2.24 or later (`env_file` `required`). Run every command from the repo root,
always with `--env-file .env.local`: it gives Compose `PTR_UID`/`PTR_GID` and the upstreams path for the mounts. A
variable exported in the shell wins over `--env-file` for these, so do not export them.

```sh
C="docker compose --env-file .env.local -f infra/compose.app.yml"   # add --profile gateway with the gateway provider
```

### Environment checklist

1. `pnpm ops:check-env` prints `errors 0` (key names and rule ids only, never values; see [configuration](configuration.md)).
   With `PTR_CHAT_PROVIDER=gateway` it also checks the gateway role.
2. `PTR_PERSONAS_FILE`, `PTR_AUTHORED_PERSONAS_FILE` and `PTR_GATEWAY_UPSTREAMS_FILE` are **repo-relative** (for example
   `data/research/personas.json`): the container's working directory is the image's repo root `/app`, where `data/` is
   mounted. Absolute paths are flagged `path_not_repo_relative`.
3. `PTR_REDIS_URL` uses the ACL user `ptr` (`redis_username_ptr`); `DATABASE_URL` names the isolated database.
4. `mkdir -p data/generated && chmod 700 data/generated`, owned by `PTR_UID`. Compose does not create the bind-mount
   sources (`create_host_path: false`), so a missing `data/` or `data/generated` stops `up` instead of appearing
   root-owned.
5. Postgres and Redis are up (`docker compose --env-file .env.local -f infra/compose.db.yml up -d db`, the same for
   `compose.redis.yml`) and migrated (next section). A role started before them keeps reconnecting; the api stays
   unhealthy (`/api/health` 503) until both answer.
6. Values with `$` must be single-quoted in `.env.local`: Compose interpolates `env_file` values, `node --env-file` does not.

### First deploy, stop and logs

```sh
$C build
$C run --rm --no-deps api node --import tsx scripts/db-migrate.ts   # migrations, through the same image and env
$C up -d --wait          # returns when every role is healthy; fails when one turns unhealthy
pnpm ops:status          # role up/down, breakers, ALERTs (observability.md); the host network makes the ports local
$C ps
$C logs -f worker        # JSON lines; correlate by turnId across roles
$C stop                  # worker and gateway get 35 s to finish and drain
$C down                  # removes the containers; data stays on the host
```

The upstreams file is mounted as a single file. Edit it in place: the gateway re-reads it on an mtime change, or on
`$C kill -s SIGHUP gateway`. An editor that replaces the file (new inode) leaves the container on the old copy until
`$C restart gateway`. After a change in `.env.local`, recreate the roles: `$C up -d --force-recreate`.

### Upgrade order

1. Wait until the service is idle (no turn in flight; `pnpm ops:status`, worker `ptr_turns_inflight`).
2. `git pull` (or check out the release commit), then `pnpm install --frozen-lockfile` and `pnpm ops:check-env` on the
   host: a release can add or rename keys.
3. Keep the running image for rollback: `docker tag ptr_app:local ptr_app:previous`.
4. Back up the database when the release adds a migration (`supabase/migrations`), with the bootstrap password from the
   environment, never in the command text:
   `mkdir -p data/backups; (umask 077; PGPASSWORD="$PTR_DB_PASSWORD" docker exec -e PGPASSWORD ptr_goal1_db pg_dump -U supabase_admin -d ptr_research -Fc > data/backups/ptr_research-<stamp>.dump)`
   (the subshell keeps the file at 0600 and the password out of the shell's exports).
5. `$C build`.
6. With a new migration: `$C stop` first (the worker and gateway finish in-flight work and drain), because the old roles
   must not run on the new schema (`0008` dropped a column). Then migrate:
   `$C run --rm --no-deps api node --import tsx scripts/db-migrate.ts`. Migrations are forward-only and applied once
   each (`ptr_schema_migrations`).
7. `$C up -d --wait` recreates the changed roles. Without a migration the old worker and gateway get SIGTERM here and
   finish in-flight work first.
8. `pnpm ops:status` and one turn through the web.

### Rollback

1. `git checkout <previous commit>` (the compose file, configs and docs must match the image).
2. `docker tag ptr_app:previous ptr_app:local && $C up -d --wait --force-recreate` (or `$C build` on the old commit).
3. Database: there are no down migrations, and some migrations drop objects (for example `0007` drops an index and
   `0008` a column). An image rollback is safe when both commits have the same `supabase/migrations`. Across a
   migration, stop the roles and restore the dump from upgrade step 4 (`pg_restore --clean` into `ptr_research`)
   before starting the old image.
4. Redis is not a source of truth: queued turns are re-published from the Postgres outbox by the dispatcher.

## CI (`.github/workflows/ci.yml`)

- **check** (every push and pull request): `pnpm install --frozen-lockfile && pnpm check`, `docker compose -f
  infra/compose.app.yml --profile gateway config -q` and actionlint. It uses no secrets, and the checkout has no `data/`
  and no `.env*`, so a test that needs a private local file fails here. Reproduce locally:
  `git clone --branch <branch> <repo> /tmp/ptr-clean && cd /tmp/ptr-clean && pnpm install --frozen-lockfile && pnpm check`.
- **integration** (pushes to `main` and manual runs): a `pgvector/pgvector` PostgreSQL 15 service container with the
  synthetic `ptr_loadtest` database (`infra/init-loadtest-db.sh`), Redis from `infra/compose.redis.yml` (the same ACL),
  credentials generated per run, then `pnpm db:migrate` and `RUN_STORAGE_DB_TESTS=1 RUN_REDIS_TESTS=1
  GOAL1_TEST_BUDGET_DB=true pnpm test`. Redis runs from the compose file because a GitHub service container cannot set
  the server command that writes the ACL.

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
