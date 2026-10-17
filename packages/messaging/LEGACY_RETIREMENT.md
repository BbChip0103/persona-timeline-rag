# Historical framework migration: obsolete gateway/fleet retirement

This is a historical deletion record for the earlier framework migration. The LiteLLM proxy path is retired; active serving uses direct
local vLLM through Compose or Kubernetes EPP/InferencePool, with optional
worker-only direct OpenRouter spillover in Kubernetes.

## Deletion plan and rationale

Plan44 selected LiteLLM Proxy for model routing and NestJS BullMQ processors for
queue execution at that time. Keeping the previous gateway application, Redis fleet registry,
credit/DRR/prefix admission controller, capacity leader or separate dispatcher
would retain an active parallel runtime instead of the approved big-bang change.
This is deletion of superseded orchestration, not permission to delete domain
source binding, safety, request-ledger, outbox or stale-result write protections.

1. Pin the existing pure vLLM metrics parser using its existing synthetic tests.
2. Preserve that parser only as `src/engine-metrics.ts` with transferred tests;
   remove the associated gateway polling/admission logic.
3. Delete `apps/gateway` application/source/tests, the separate API dispatcher and
   its now-unused capacity wiring, messaging fleet/capacity registry implementations
   and their implementation-specific tests.
4. Delete dedicated old routing/registry/gateway/telemetry acceptance harnesses and
   the upstream registration agent. General evaluation/load/persona tools remain
   leader-owned and must be migrated to new framework endpoints, not retained as
   a second gateway runtime.
5. Remove registry/capacity exports. Preserve the narrow `messaging/registry`
   package entrypoint only for the existing Redis loopback guard/connection users;
   it will export no fleet registry or discovery implementation.
6. Run transferred parser and retained messaging/domain tests. The leader owns
   runtime/config/manifest/infra cleanup and whole-worktree verification.

## Obsolete surfaces

- `apps/gateway/**`: custom HTTP gateway, failover/health/pool, limiter, DRR
  admission, prefix affinity and engine telemetry scheduler.
- `apps/api/src/dispatcher.ts`, `apps/api/src/capacity.ts`, capacity wiring tests.
- `packages/messaging/src/{upstream-registry,gateway-registry,capacity-controller}.ts`
  and their registry/controller contract/unit/integration tests.
- `scripts/{upstream-agent,registry-acceptance,gateway-ha-acceptance,routing-compare,telemetry-acceptance,ha-openrouter-redirect}.ts`
  and dedicated agent/routing comparison tests.

## Explicit preserved responsibilities

- BullMQ delivery, Redis/local target isolation and event transport.
- Core/storage domain tests and recovery/result-ledger behavior (leader-owned).
- `scripts/ops-status.ts` Prometheus parse/read-facing status utility.
- `parseEngineMetrics`: read-only extraction of vLLM running/waiting/cache/prefix
  counters and process start time. It makes no routing/admission decisions and
  no network calls; no gateway application remains behind it.

Validation was synthetic. Deletion did not demonstrate live LiteLLM capacity or
real-model quality; those were separate historical framework integration gates.
