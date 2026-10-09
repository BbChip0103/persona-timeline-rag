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
secret/API token/API URL; provider keys/database credentials stay server-side. Fake is default;
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
