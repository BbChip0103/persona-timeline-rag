# Dedicated DB-only local Supabase

> Historical pre-framework procedure. For current serving, use [framework runtime](../docs/framework-runtime.md). Old gateway/dispatcher/local review-sheet commands below are not the default migration path.


`compose.db.yml` uses the cached official Supabase PostgreSQL 15 distribution,
not a complete Supabase Auth/Storage deployment. Its only published listener is
`127.0.0.1:56432`; project/container/volume names are `ptr_goal1`,
`ptr_goal1_db`, and `ptr_goal1_db_data`. Database/user are `ptr_research` and
`ptr_researcher`. Never point these scripts at another project or port.
The distribution's `supabase_admin` is used only by first-volume bootstrap;
`init-research-db.sh` creates the separate non-superuser application role and
installs vector in its database. Statement/audit logging is disabled before
credential DDL, because Supabase distribution defaults can otherwise log keys.

Private configuration must contain `PTR_DB_PASSWORD` and matching `DATABASE_URL`
(or `PTR_DATABASE_URL`). Existing credentials must not be replaced while the
dedicated volume exists. `scripts/db-init-env.ts` exclusively creates an ignored,
mode-0600 `infra/.env.db` for a new installation; the application may instead
provide its existing ignored `.env.local`.

For an explicitly authorized **new local database**, first verify port 56432 is
unused and the `ptr_goal1` resource names are not owned by another project. Then:

```sh
docker compose --env-file .env.local -f infra/compose.db.yml up -d db
# With DATABASE_URL already loaded from private configuration:
pnpm db:migrate
# Storage integration tests run on the synthetic ptr_loadtest database (see below), never on ptr_research;
# their cleanup refuses any other database.
RUN_STORAGE_DB_TESTS=1 DATABASE_URL="$PTR_LOADTEST_DATABASE_URL" pnpm exec jest packages/storage/test --runInBand
```

Migrations run only after URL and connected database/user identity checks. They
do not seed real personas or posts. Integration tests insert only synthetic,
randomly scoped fixtures and never reset/drop/truncate tables or other resources.
Do not use compose prune or shared Supabase CLI reset. Run storage tests only
against the dedicated synthetic load-test database. Provider budget tables are
initialized by the provider ledger.

Source imports accept only `licensed_source` or `synthetic_fixture`; generated
conversation content has no source-origin option. Source and persona revisions
are immutable and idempotent by canonical content hash. Retrieval is a
deterministic multilingual token/phrase substring baseline (not BM25), or exact
1536-dimensional cosine distance over already person/date/safety-filtered rows.
Posted-date ranges convert local midnight via PostgreSQL `AT TIME ZONE`; event
dates remain nullable calendar dates and are never inferred from posted dates.

## Goal2 synthetic load-test database

Load tests must not write into `ptr_research`. The same container hosts a second,
synthetic-only database `ptr_loadtest` owned by its own non-superuser role
`ptr_loadtester` (PUBLIC connect revoked; the research role cannot connect, and the
load-test role has no privileges on research tables). The URL guard accepts only these
two exact database/role pairs. Seed it only with synthetic personas/posts.

```sh
# Private .env.local holds PTR_DB_PASSWORD (bootstrap admin), PTR_LOADTEST_DB_PASSWORD
# and PTR_LOADTEST_DATABASE_URL. Passwords travel via environment, never argv.
export PGPASSWORD="$PTR_DB_PASSWORD"
docker exec -i -e PGPASSWORD -e PTR_LOADTEST_DB_PASSWORD ptr_goal1_db bash -s < infra/init-loadtest-db.sh
DATABASE_URL="$PTR_LOADTEST_DATABASE_URL" pnpm db:migrate
```

## Goal2 scale rework: local Redis

`compose.redis.yml` runs `ptr_goal2_redis` (Redis 8.10.2, pinned by digest) on
`127.0.0.1:56479` only, with `maxmemory-policy noeviction` (required by BullMQ) and AOF.
Access uses an ACL: one app user `ptr` whose password is `PTR_REDIS_PASSWORD`,
limited to the `ptr:*` / `ptrtest:*` keys and channels and to every command except the
`@dangerous` ones (`KEYS`, `CONFIG`, `FLUSHALL`, `CLIENT LIST`, ...) plus `INFO`, which BullMQ
reads. The `default` user is off and there is no admin user; use `SCAN`, not `KEYS`, and
`INFO memory`, not `CONFIG GET`. It carries the BullMQ turn queue and turn-event pub/sub; it
is not a source of truth (turns and the outbox in Postgres are). The URL guard
(`@ptr/messaging` `assertLocalRedisUrl`) accepts only this loopback target. Migration from
the earlier `requirepass` container and its rollback: [runbook](../docs/runbook.md#redis-acl-migration-and-rollback).

```sh
# Private .env.local holds PTR_REDIS_PASSWORD and PTR_REDIS_URL (redis://ptr:<pw>@127.0.0.1:56479/0).
docker compose --env-file .env.local -f infra/compose.redis.yml up -d redis
RUN_REDIS_TESTS=1 node --env-file=.env.local node_modules/jest/bin/jest.js packages/messaging --runInBand
```
