# Private, disabled-by-default model adapters

Fake providers never use the network. Live construction requires explicit
`GOAL1_LIVE_ENABLED=true`, `GOAL1_ALLOW_EXTERNAL_DATA=true`, an explicitly supplied
`OPENROUTER_API_KEY`, and the dedicated loopback research database URL
`GOAL1_DATABASE_URL`. This package never discovers or reads credential files.
Construct one `OpenRouterClient` per run; `verifyPricing(signal)` fetches the public
text and embedding catalogs before any billable POST. Unknown fees or higher
prices fail closed; no automatic model/provider fallback or HTTP retries exist.

Use `PostgresBudgetLedger(pool, databaseUrl).initialize()` once to create its
private shared budget ledger. All text, embedding and optional judge callers must
use this same ledger/database. Its durable global US$1 / 1,000-call cap does not
reset between runs. Integer microUSD rounds reservations and actual charges up.
Reservations include conservative UTF-8 byte token bounds, envelope overhead and
bounded output, and a full extra input cache-write allowance. Known optional
image/audio/search catalog rates are ignored only because their request features
are unavailable here; unknown nonzero charges fail closed. Gemini reasoning is
explicitly disabled. A crash, missing cost, cancellation after submit or failed request
retains the reservation. Identical model/input/settings/schema requests reuse a
stored response or reject an unresolved request; they never automatically submit
again. Response caches and ledger rows belong only in the private research DB,
not public fixtures, browser output, or traces. No key/input/body is logged here.

Chat defaults to `google/gemini-3-flash-preview` (reasoning effort `minimal`);
selecting `google/gemini-2.5-flash-lite` (earlier Goal1 baseline), `google/gemma-4-26b-a4b-it` (reasoning off) or
`openai/gpt-4.1-nano` is explicit. Price ceilings are per model. For Gemma 4 26B only (per-model opt-in), agent replies
(`AGENT_JSON_REPLY`) are sent with `response_format: json_schema` (strict, the shared
`AGENT_RESPONSE_JSON_SCHEMA` also used by the self-hosted adapter: 180-codepoint message,
96-character quotes, no extra keys) when the verified catalog entry lists `structured_outputs`;
`require_parameters` keeps routes that cannot honour it out. Other models, and the legacy
`TIMELINE_JSON_REPLY` path (no schema exists), keep `json_object`. Embeddings use
`openai/text-embedding-3-small`, float vectors, 1536 dimensions, validated index
ordering/count/finiteness. Embedding API schema does not promise `usage.cost`: an explicitly returned finite,
nonnegative numeric cost settles the ledger (rounded up to integer microUSD), while
missing/invalid costs retain the reservation. The exact observed response alias
`text-embedding-3-small` normalizes to the canonical model; other vendors/suffixes
are rejected. Existing cached responses may settle their reported cost locally,
without another POST. Requests enforce
ZDR, denied data collection, supported parameters, disabled fallbacks and maximum
prices. Unsupported combinations fail rather than weaken restrictions.

A generation with a known id may be explicitly reconciled using GET-only
`reconcile(requestKey, signal)`. Missing ids need manual accounting; no restart or
retry recovers them through a new POST. This text/embedding package has no image adapter. Image generation is disabled in the public build.

`decide(request, {signal, idempotencyKey})` calls the Decisions API (`POST /api/alpha/decisions`)
for pinned decision models only (`typesafe/jev-1.13`). It verifies only that model's public endpoint
pricing (input within the ceiling, every other fee zero; text/embedding catalogs are not read),
reserves a conservative input-token bound, settles from `usage.cost`, sends ZDR, denied data
collection, no fallbacks and `max_price` (documented `ProviderPreferences` in the Decisions
request schema), accepts only the exact id or its dated `-YYYYMMDD` snapshot in the response
`model`, and follows the same no-resubmission rule (a 429 or transport failure keeps the
reservation and is not retried). The optional `idempotencyKey` is added to the ledger key but
never sent. `JevIntentClassifier` builds the single Choice question used by optional intent
routing, keys the ledger by turn id, and rejects answers whose choice is not the most probable
label or whose confidence differs from 2p−1 by more than 0.03. A failed catalog or endpoint
price check is not cached, so the next call verifies again.

Official contracts checked for this implementation:
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [Embedding request/response](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request)
- [Reasoning billing/disable settings](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [Jev hub](https://openrouter.ai/docs/guides/community/jev) and [tutorial](https://openrouter.ai/docs/guides/community/jev-tutorial) (Decisions request/response, `usage.cost`)
- [TypeSafe confidence](https://docs.typesafe.ai/confidence) (Choice confidence formula)
