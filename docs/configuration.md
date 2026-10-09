# Configuration: the production profile and `ops:check-env`

Production is one process per role (api, worker, dispatcher, web, and gateway when the chat provider is `gateway`) with
**19 environment variables**. Every other knob is a constant; the scaling features measured in goal2 stay in the code
behind `PTR_DEMO_SCALING=1` ([demo-mode.md](demo-mode.md)). Design:  (decisions D3–D9).

## Startup check

Each entry point calls `loadConfig(role, process.env)` (`packages/ops`) before it opens any connection. The web has no
workspace dependency: `apps/web/instrumentation.ts` `register()` checks only its own keys and `PTR_API_URL` (skipped
while `next build` runs); `pnpm ops:check-env --roles web` applies every step to it. Problems are listed together
in one stderr line and the process exits 1:

```json
{"event":"config_invalid","role":"api","problems":[{"key":"PTR_CHAT_PROVIDER","rule":"production_provider"}]}
```

Warnings use `"event":"config_warning"`. Lines name keys and rule ids only, never values or URLs. Tests and harness
code that call `createRuntime(env)` directly are not gated. The order of the checks:

1. a `PTR_*` or `GOAL1_*` name the registry (`packages/ops/src/env-registry.ts`) does not know → `unknown_key`;
2. another role's keys, and test/harness (H), infra/tool (I) and system (S) names → ignored;
3. a demo-layer key (D) without `PTR_DEMO_SCALING=1` → `demo_key`;
4. removed and derived keys (R): see the migration table;
5. renamed keys: warning `renamed_key` for one release; a different value under the old and the new name → `alias_conflict`;
6. the role's production keys (below). With `PTR_DEMO_SCALING=1` this step is skipped, except that api and worker
   still need an explicit `PTR_CHAT_PROVIDER`; each demo setting is checked by its own parser when the role starts.
   In either mode the api refuses a harness token equal to the production token (`synthetic_token_reuse`).

## The 19 production variables

| Variable | Roles | Rule (rule id) |
| --- | --- | --- |
| `DATABASE_URL` | api, worker, dispatcher; gateway with OpenRouter failover | required (`missing`); the isolated loopback database (`database_url_guard`) |
| `PTR_REDIS_URL` | api, worker, dispatcher | required; the isolated loopback Redis (`redis_url_guard`) as the ACL user `ptr`: `redis://ptr:<password>@127.0.0.1:56479/0` (`redis_username_ptr`) |
| `PTR_CHAT_PROVIDER` | api, worker | required; `gateway` or `openrouter` (`production_provider`) |
| `PTR_MODEL` | api, worker | required with `openrouter`; an allowlisted OpenRouter chat model (`model_allowlist`) |
| `PTR_API_TOKEN` | api, web | required; 24–512 characters (`token_length`) |
| `PTR_SESSION_SECRET` | web | required; at least 32 characters (`secret_length`) |
| `PTR_UI_PASSWORD` | web | required; at least 12 characters, the login route's own minimum (`password_length`) |
| `PTR_GATEWAY_TOKEN` | gateway; api and worker with the `gateway` provider | required there; 24–512 characters |
| `PTR_GATEWAY_UPSTREAMS_FILE` | gateway | required; the file exists (`file_missing`), parses (`upstreams_file_invalid`) and holds exactly one pool (`upstreams_pool_count`), whose name is the served model; repo-relative for Compose |
| `PTR_GATEWAY_FAILOVER` | gateway | `off` (default) or `openrouter` (`invalid_value`) |
| `PTR_WORKER_CONCURRENCY` | worker | 1–1024, default 32 (`invalid_value`) |
| `PTR_PERSONAS_FILE`, `PTR_AUTHORED_PERSONAS_FILE` | api, worker | optional; a regular file when set (`file_missing`) |
| `PTR_INTENT_CLASSIFIER`, `PTR_SAFETY_FILTER` | api, worker | `off` or `jev` (`invalid_value`) |
| `GOAL1_LIVE_ENABLED`, `GOAL1_ALLOW_EXTERNAL_DATA`, `OPENROUTER_API_KEY` | api, worker, gateway | all three needed (`true`, `true`, a key) when the `openrouter` provider, a `jev` helper or OpenRouter failover is on (`live_trio`) |
| `PTR_DEMO_SCALING` | all | `1` opens the demo layer; `0` or unset = production (`invalid_value` otherwise) |

Behaviour fixed by the production profile: the gateway asks for structured agent replies (guided decoding) by default;
the dispatcher runs without a chat provider (leases, delivery and events only); the gateway serves the single pool of
its upstreams file; the web proxy always targets `http://127.0.0.1:56441`.

## `pnpm ops:check-env`

```bash
pnpm ops:check-env                       # .env.local, roles api,worker,dispatcher,web (+ gateway when PTR_CHAT_PROVIDER=gateway)
pnpm ops:check-env --file <path> --roles gateway
```

The file is parsed like `node --env-file`. Output: one line per problem, `warning|error <role|all> <rule> <KEY>`, then
`errors N warnings M`; exit 0 without errors, 1 with errors, 2 for a usage error. Problems that do not depend on the
role (steps 1, 3–5) are printed once as `all`; role problems once per role. It also flags persona and upstreams file
paths that are absolute (`path_not_repo_relative`, a warning): Compose runs the roles from the repo root inside the
container and mounts the upstreams file at the same relative path, so only repo-relative paths reach the same file there
([Deploy with Compose](runbook.md#deploy-with-compose-production-profile)). Run it from the checkout that holds `data/`,
since relative paths are resolved against the current directory.

## Migration from the earlier `.env.local`

| Key | Class | Action | `ops:check-env` |
| --- | --- | --- | --- |
| `DATABASE_URL`, `PTR_API_TOKEN`, `PTR_UI_PASSWORD`, `PTR_SESSION_SECRET` | P | keep | nothing (the value rule's id if it fails) |
| `PTR_PERSONAS_FILE` | P | keep; repo-relative for Compose | `path_not_repo_relative` if absolute |
| `PTR_CHAT_PROVIDER` | P | must be `gateway` or `openrouter`; `fake` and `selfhosted` need `PTR_DEMO_SCALING=1` | `production_provider` otherwise |
| `PTR_MODEL` | P | keep (now a production key) | `model_allowlist` if not allowlisted |
| `GOAL1_LIVE_ENABLED`, `GOAL1_ALLOW_EXTERNAL_DATA`, `OPENROUTER_API_KEY` | P | keep | `live_trio` when needed and incomplete |
| `PTR_REDIS_URL` | P | add the user name `ptr` when Redis moves to the ACL ([runbook](runbook.md#redis-acl-migration-and-rollback)) | `redis_username_ptr` without it |
| `PTR_API_URL` | R | can be deleted: the proxy uses the constant | warning `constant_ignored`; error `api_url_constant` if it differs |
| `GOAL1_BUDGET_USD`, `PTR_EMBEDDING_MODEL`, `REPLICATE_API_TOKEN`, `INSTAGRAM_DATASET_FOLDER_URL` | R | can be deleted (the budget is the Postgres `ptr_provider_budget` row) | warning `unused_key` |
| `GOAL1_DATABASE_URL`; `GOAL1_TEXT_MODEL`, `TEXT_MODEL` | R | rename to `DATABASE_URL`; `PTR_MODEL` (removed in the next round) | warning `renamed_key`; `alias_conflict` if both differ |
| `PTR_EXECUTION` | R | delete | error `removed_key` |
| `PTR_DB_PASSWORD`, `PTR_REDIS_PASSWORD` | I | keep (Compose and tools only) | nothing |
| `PTR_LOADTEST_DB_PASSWORD`, `PTR_LOADTEST_DATABASE_URL` | H | keep (load tests) | nothing |

With the keys of the current `.env.local` and the default roles, the expected result is no errors and four warnings:
`constant_ignored PTR_API_URL` and `unused_key` for `GOAL1_BUDGET_USD`, `PTR_EMBEDDING_MODEL`, `REPLICATE_API_TOKEN`.
Value-dependent rules (`production_provider`, `model_allowlist`, `live_trio`, `api_url_constant`,
`path_not_repo_relative`, `file_missing`, `password_length`, `redis_username_ptr`) can add lines. With `PTR_CHAT_PROVIDER=gateway` the gateway role is added and
reports `missing PTR_GATEWAY_TOKEN` and `missing PTR_GATEWAY_UPSTREAMS_FILE`; api and worker report
`missing PTR_GATEWAY_TOKEN` too.

## Other names

The registry lists every name the code, harness and infra files read; a test (`packages/ops/test/env-scan.test.ts`)
fails when a file reads a name it does not list. Classes besides P: D (demo layer: gateway, capacity, registry and
upstream-agent knobs, leases, queues, Jev and safety tuning, ports), H (tests, harness and research scripts), R (above),
I (Compose, psql and redis-cli: database and Redis passwords, `PTR_UID`/`PTR_GID`), S (`HOME`, `PATH`, `NODE_ENV`,
`VIRTUAL_ENV`, `NEXT_PHASE`).

## Sources

-  (operations round 2) §3 and decisions D3–D9, `private design notes` repo
  `<private-design-notes>`.
- Node.js `util.parseEnv` (the `--env-file` parser): https://nodejs.org/api/util.html#utilparseenvcontent
- Next.js `instrumentation.ts` `register()`: https://nextjs.org/docs/app/guides/instrumentation
