# Generic framework ownership

General-purpose mechanisms use native libraries. Domain authority is not delegated to SDK defaults.

| Function | Native owner | Retained policy |
| --- | --- | --- |
| Web session encryption/read/save | iron-session | Stable HMAC-derived owner, exact seven-day payload expiry, loopback/origin restrictions, non-sliding reads |
| Logout cookie removal | Next.js response cookies | Clear even if session configuration is unavailable |
| Login failures / per-owner drafts | rate-limiter-flexible memory storage | Ten login failures/minute; successful reset keeps window expiry; owned-session check before draft admission |
| Browser server data / mutations | TanStack Query | No query retries/focus/reconnect refresh; mutations `retry:false, networkMode:'always'`; explicit stable request IDs; owner/view invalidation |
| Browser SSE parsing/reconnect | fetch-event-source | GET only; terminal/auth/unmount abort; EOF300ms and failed-open1–10s retry; never generation replay |
| JSON-line serialization/delivery | Pino | Fresh scalar projection, sensitive-key exclusion, redaction, approved turn-ID correlation, no raw requests/errors |
| Bounded health/gauge/status waits | RxJS | Existing deadlines/safe outcomes; owned AbortController finalized even if work ignores cancellation |
| Conversation reads / session creation | Kysely PostgreSQL dialect | Existing guarded shared pool, bound owner predicates, DTO/date conversion, transactional greeting creation |
| OpenRouter standard chat orchestration | ChatOpenAI | Metered async bridge restores exact approved wire/receipt semantics; raw response/cost remains authoritative |
| OpenRouter connections | HTTPX shared AsyncClient | No cookies/redirects/retries; request-local cancellation; receipt drain before owned pool/DB shutdown |
| Public Drive transfers | HTTPX streaming | Header/range/byte limits, original repeat/distinct-target redirect bounds, no cookies, atomic files and source provenance |
| Drive retry scheduling / HTML traversal | Tenacity / BeautifulSoup | Retry classifications/nested attempt boundaries; download-form region/domain/ID policy |

## Operational changes

Old HMAC cookie encoding is not retained as a dual reader. Existing browsers must log in once after this change;
the deterministic owner is unchanged, so history ownership is unchanged. Reads do not extend expiry. Native
login timer expiry normalizes the old strict `now > expiry` edge to expiry at the boundary.

Logs retain the same JSON fields, with constant `role` emitted first by Pino. No numeric level/message/process
bindings are introduced. The string-shape gate is not a universal guarantee against arbitrary ASCII secrets;
callers must pass approved identifiers/codes, not private text. Turn IDs are log correlation only, not metric labels.

Both API entrypoints are split-only. The current Node LLM worker entrypoint and published legacy worker/evaluation/
smoke/loadtest/harness commands are removed. Python `dev:worker`, `evaluate`, and `persona` remain supported.
Historical Node runtime/core/provider/queue-processor/research/retention helpers remain where synthetic oracles,
archived O/C comparison or project-scoped retention still depend on them. They are not a second serving backend.
Archived experiments require their archived reference checkout; current P runs the Python worker.

## Explicit non-equivalent boundaries

- **Multipart ZIP/ZIP64:** native `zipfile` excludes multipart archives; concatenation does not resolve disk-relative
  offsets. Bounded remote directory scanning/extraction/CRC remains a specialized adapter, not a claimed library migration.
- **Drive warning region:** native HTML tree repair differs from the historical malformed-form region policy. A minimal
  standard-library closing-position collector retains that policy; BeautifulSoup owns attributes/entities/tag traversal.
- **Prometheus exposition:** collectors already use the native client. The small strict selected-family reader retains
  rejection semantics that available third-party decoders do not preserve.
- **Migration history:** immutable SQL files self-wrap transactions and register their names, including split history.
  Native migration engines have incompatible registries/locks. Existing explicit maintenance/bootstrap adapters remain;
  there is no startup DDL, history adoption, registry mutation or schema cutover here.
- **Business authority:** costs/unknown receipts/no-resubmit, ownership/deletion, fencing/outbox, strict JSON/wire,
  immutable source provenance and whole-post30KB budgeting remain project policy.

Native invocation spies and synthetic wire/DTO/lifecycle regressions prove library ownership. They do not prove
deployment, real-provider quality, production retention/erasure or performance improvement. Framework upgrades
must rerun the metered-client, privacy, session, lifecycle and packaging contracts.

## Verification of this local migration

- Full working-tree TypeScript check: 1,690 tests plus 18 isolated OTel tests passed; 110 skipped. Includes another session's separately owned changes.
- Python service: 1,368 passed / 22 skipped; Ruff and mypy (54 sources) passed.
- Root ingestion: 115 tests, Ruff and mypy (16 sources) passed after redirect-limit correction.
- Latest native web regressions: 26 passed; browser component/BFF scenarios: 13 passed. Root/web typechecks and lint passed after restoring generated Next config.
- Final backend image rebuilt from the final web sources; non-root UID900 startup/shutdown probe passed with zero installed or loaded LLM SDKs.
- Frozen workspace/backend locks and service lock check passed. Independent plan/code reviews found no remaining blocker in the selected scope.

Synthetic regressions found and fixed logout-stale observer data, delayed owner callbacks, terminal-history hydration replay controls,
Pino enumerable projection, exact chat-wire validation and Drive redirect exhaustion. These checks did not call paid models,
read private review rows, alter stored vectors/DDL, deploy services or push commits. Actual PostgreSQL CRUD/provider qualification,
production cutover and throughput/quality measurement are not claimed. Necessary historical comparison/retention fixtures remain.
