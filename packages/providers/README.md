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

Chat defaults to `google/gemini-2.5-flash-lite`; selecting
`openai/gpt-4.1-nano` is explicit. Embeddings use
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
retry recovers them through a new POST. This text/embedding package has no paid image adapter. The separate
`packages/images` module contains the narrowly authorized free-only account experiment;
it is not a supported general production integration and never switches to credit mode.

Official contracts checked for this implementation:
- [Provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting)
- [Embedding request/response](https://openrouter.ai/docs/api/api-reference/embeddings/submit-an-embedding-request)
- [Reasoning billing/disable settings](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
