# Private free-image experiment


## Boundaries

- Only an explicitly authorized, External image-domain cookie export supplied through `PTR_EXTERNAL_IMAGE_COOKIE_FILE` is used. Cookie values and account identifiers are never printed.
- A read-only authenticated account query must confirm the exact `gpt-image-2` model's unlimited entitlement at 1K. Unknown/unavailable entitlement stops before submission.
- Both board-task creation and generation require `useExternalMode=true`. Model, medium quality, 1K resolution, one image, and no reference upload are fixed. There is no paid/model fallback or automatic conversion to credit mode.
- Polling revalidates server model/quality/resolution/free-mode parameters, zero reported image-credit cost, and unchanged account balance. Unexpected cost or unverifiable state stops the run.
- A local exclusive run lock prevents concurrent local runners. Only read-only status requests have bounded transient retries. Download requests contain no authentication headers, require approved HTTPS CDN hosts, and do not follow redirects.

## Run and resume

With the authorized cookie-file environment variable set and four private persona records in `data/research/personas.json`:

```bash
PTR_IMAGE_READ_ONLY=true pnpm exec tsx scripts/generate-images.ts
pnpm exec tsx scripts/generate-images.ts
```

The second command also resumes known tasks. It does not resubmit them. Output contains only aggregate completion or a sanitized error code. Free queues can be slow; an unfinished run exits with `IMAGE_PENDING_RESUME` while preserving its private task ledger.

## Evidence and limitations

The runner records exact generation parameters, source-independent prompts, persona revision, generated/fictional provenance, server-reported credit cost, observed account balance, and image SHA-256. These checks are not a proof of image quality, identity/style fidelity, real activity, or human review.

External image's [public pricing](https://www.external-image.ai/pricing) excludes automation from website free/unlimited plan terms; this user-authorized account experiment is not a provider-supported general integration. [API billing rules](https://docs.external-image.ai/docs/billing-rules) also distinguish eligible API balances from website/Ultra credits. Public pricing alone cannot establish account entitlement or authorize a paid fallback.

Synthetic regression: `pnpm exec jest packages/images/tests/external-image.test.ts --runInBand`.
