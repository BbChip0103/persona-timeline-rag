# Owned three-tier operational deployment

Use `infra/compose.app.yml` with `infra/split/compose.operational.yml` for the
private Linux deployment. The override does not provision or recreate the approved
research database/queue. Validate their identities, durable storage, schema and
role grants first. Runtime credentials must never be migration-owner credentials.

## Configuration and supervision

Select a new owned Compose project/nonce, immutable verified backend and worker
image IDs, separate private environment files and loopback ports in a `0600`
operator Compose environment. Keep its directory `0700`. Do not print resolved
Compose configuration: it can contain secrets. Validate with `config -q`.

```sh
docker compose --env-file /private/compose.env \
  -f infra/compose.app.yml -f infra/split/compose.operational.yml config -q
# Only after identity, grants, image and configuration verification:
docker compose --env-file /private/compose.env \
  -f infra/compose.app.yml -f infra/split/compose.operational.yml up -d --no-build
```

Web receives only UI/session/API credentials and no corpus mount. Backend receives
the app role/control credentials; Python receives the LLM role, approved model key
and explicitly consented auxiliary-provider configuration. The gateway receives
no app/LLM database credentials. Its own PostgreSQL/Redis use owned durable volumes,
native health checks and bounded logs. All roles restart `unless-stopped`.

Gateway configuration must retain the pinned native scored/cache-affinity routing
extension, a self-hosted primary only, zero automatic retries and no paid fallback.
Set `turn_off_message_logging`, `redact_messages_in_exceptions` and
`store_prompts_in_spend_logs=false`, including `STORE_PROMPTS_IN_SPEND_LOGS=false`.
Use `/health/readiness`, not `/health`, which can invoke models. Give Python a
model-constrained native gateway key rather than the gateway master key.

Run the existing GPU engine through an authenticated private endpoint. When native
remote process supervision is unavailable, an operator-owned user-systemd unit can
supervise foreground SSH plus its loopback forward. Keep its environment, key,
script and cached model location durable, with native restart/backoff. Do not add a
TTL to a persistent service. Enable user linger only when persistent execution is
authorized. Native supervision is not proof of host reboot, instance recreation,
network availability or multi-engine performance.

Apply `supabase/split/0004_cumulative_budget_cap.sql` with the selected research
owner before live work. It makes the cumulative US$1 budget operator-controlled;
runtime cannot raise or delete/recreate the global cap. Preserve existing ledger,
immutable migration baseline and unknown reservations. GPU qualification call
limits and gateway-key budgets are **not** this monetary cap.

## Bounded acceptance and recovery

`scripts/operational-smoke.ts` requires explicit private configuration and an
owned deployment manifest. Default mode performs only identity, readiness,
unauthenticated-access and native idle-counter checks: no catalogue/model calls.
The operational qualification artifact root is fixed in the harness; another
qualification must intentionally update/review that boundary rather than reuse
stale phase markers.

```sh
pnpm exec tsx scripts/operational-smoke.ts --env-file /private/e2e.env
# Explicit approved live qualification only:
pnpm exec tsx scripts/operational-smoke.ts --env-file /private/e2e.env \
  --execute --owner-nonce <owned-nonce>
```

Live acceptance uses a synthetic API actor with an existing published persona,
RAG off, at most three distinct turn submissions, disabled retrieval tools and
one generation per attempt. Verify backend `PTR_MAX_ATTEMPTS<=3` and gateway/SDK
retries zero before live work: this bounds generation calls per turn to three,
within a 12-call qualification ceiling and 512 output tokens.
It verifies reply structure, owner isolation, idempotence, queued cancellation,
backend restart recovery, single assistant persistence, outbox drain and receipt
ACK. It stores only counts/state/private hashes, never persona IDs/labels/replies.
Native success counters corroborate successful generations; they do not prove an
atomic provider admission hard cap or unsupported error counters. Semantic
retrieval/Jev and human answer quality are separate acceptance stages.

The parent operator handles requested phases only after checking exact container
ID, owner label, Compose service/project and immutable image. Stop/drain the owned
worker first, keep backend/gateway alive, then restart only the owned backend and
resume the same worker. Acknowledge each phase atomically in a `0600` metadata file
with the exact fresh request nonce. Never use pattern process/container kills.
The override allows 90 seconds for worker shutdown and uses native dependency
ordering. Preserve failed proofs before another explicitly bounded qualification.

Rollback changes images/configuration, not post-cutover databases, queues, provider
ledger or receipts. Never restore an old snapshot over completed work. Public
ingress/TLS, historical hard-erasure and human quality decisions are not established
by operational acceptance; private central review export stays disabled unless
separately authorized.
