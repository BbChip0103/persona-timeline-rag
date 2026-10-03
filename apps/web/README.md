# Private local chat UI

Run `pnpm --filter @ptr/web dev` (or build, then start). Both server commands bind
only `127.0.0.1:56440`. The API must be at `http://127.0.0.1:56441`.

Private `apps/web/.env.local` holds `PTR_API_URL`, `PTR_API_TOKEN`,
`PTR_UI_PASSWORD` (at least 12 characters), and `PTR_SESSION_SECRET` (at least
32 characters). Do not use `NEXT_PUBLIC_*` for secrets. Missing settings fail
closed. This app does not locate credentials or contact model providers.

Login issues an HMAC-signed, expiring HttpOnly / SameSite=Strict cookie. Owner
identity derives from the private signing secret, so logging in again preserves
single-user history. Rotate that secret intentionally: changing it changes the
owner identity. `Secure=false` is exclusively for the required HTTP loopback
origin; this is not an internet deployment configuration. Requests validate the
actual Host header (Next normalizes internal Request URLs). Mutations also
require the exact loopback Origin. The BFF allows only fixed API route shapes,
sets the Bearer credential server-side, and never takes ownership from browser
headers. All upstream responses are uncached and errors are sanitized.

The UI distinguishes selected settings for a **new** session from the current
session's pinned persona revision / retrieval mode. Timeline filters are explicit
UTC `[start,end)` values, never guessed from prose. Sources render plain text,
separate posted and event dates, and link only HTTP(S) URLs without credentials.
shown rather than paid or web-cookie execution.

Verification:

- `pnpm --filter @ptr/web build`
- `pnpm --filter @ptr/web exec tsc --noEmit`
- `pnpm exec eslint apps/web e2e`
- `pnpm exec playwright test --config=e2e/playwright.config.ts`

Playwright uses explicit synthetic credentials and browser-intercepted synthetic
API fixtures. It tests five turns, reload, pinned mode, cancellation, same-ID
retry, UTC filters, source URL safety and fictional draft boundaries. Separate
real BFF checks verify cookie/origin/fixed-route/tamper behavior without model
calls. These browser fixtures are **not** proof of real-person chat quality or
live model integration. Traces/screenshots are disabled to prevent private UI
artifacts. Install the matching Chromium browser if needed. Run browser tests
and production builds sequentially: both use Next's `.next` directory.
