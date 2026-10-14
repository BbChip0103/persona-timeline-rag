# Backend/web image only. Historical Node LLM packages remain development-only.
# Python orchestration has its own apps/llm-service/Dockerfile and dependency lock.
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8 AS node-base
ENV NEXT_TELEMETRY_DISABLED=1 COREPACK_HOME=/opt/corepack
RUN corepack enable pnpm && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app

# The web builder can use the historical workspace; none of its node_modules enter runtime.
FROM node-base AS web-builder
COPY --chmod=0755 package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --chmod=0755 apps/api/package.json apps/api/
COPY --chmod=0755 apps/web/package.json apps/web/
COPY --chmod=0755 packages/contracts/package.json packages/contracts/
COPY --chmod=0755 packages/core/package.json packages/core/
COPY --chmod=0755 packages/images/package.json packages/images/
COPY --chmod=0755 packages/messaging/package.json packages/messaging/
COPY --chmod=0755 packages/ops/package.json packages/ops/
COPY --chmod=0755 packages/providers/package.json packages/providers/
COPY --chmod=0755 packages/storage/package.json packages/storage/
RUN --mount=type=cache,id=ptr-pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY --chmod=0755 apps/web ./apps/web
COPY --chmod=0755 packages ./packages
COPY --chmod=0755 tsconfig.json tsconfig.base.json ./
RUN pnpm build:web

# Independent explicit production closure: no LLM SDKs, providers or worker packages.
FROM node-base AS backend-deps
COPY --chmod=0755 infra/backend/package.json infra/backend/pnpm-lock.yaml ./
RUN --mount=type=cache,id=ptr-backend-pnpm-store,target=/pnpm-store pnpm install --prod --frozen-lockfile --store-dir /pnpm-store

FROM node-base AS runtime
ENV NODE_ENV=production \
    HOME=/tmp \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp/.cache
RUN apt-get update && apt-get install -y --no-install-recommends python3=3.11.2-1+b1 && rm -rf /var/lib/apt/lists/*
COPY --from=backend-deps /app/node_modules ./node_modules
COPY --chmod=0755 infra/backend/package.json infra/backend/pnpm-lock.yaml ./
COPY --chmod=0755 tsconfig.json tsconfig.base.json ./
COPY --chmod=0755 apps/api/src/app.ts apps/api/src/bind-host.ts apps/api/src/draft-limiter.ts apps/api/src/creative-artifact.ts apps/api/src/schema-pipes.ts apps/api/src/observability.ts apps/api/src/public-turn.ts apps/api/src/split-chat.ts apps/api/src/split-runtime.ts apps/api/src/turn-sse.ts apps/api/src/packaged-main.ts ./apps/api/src/
COPY --chmod=0755 packages/core/src/ports.ts packages/core/src/safety.ts packages/core/src/reply-texts.ts packages/core/src/turn-worker.ts packages/core/src/request-fingerprint.ts packages/core/src/persona-card.ts ./packages/core/src/
COPY --chmod=0755 packages/storage/src/pool.ts packages/storage/src/local-guard.ts packages/storage/src/conversations.ts packages/storage/src/creative-artifacts.ts packages/storage/src/database.ts packages/storage/src/llm-control.ts ./packages/storage/src/
COPY --chmod=0755 packages/messaging/src/bullmq-delivery.ts packages/messaging/src/turn-events.ts packages/messaging/src/redis.ts packages/messaging/src/local-guard.ts ./packages/messaging/src/
COPY --chmod=0755 packages/ops/src/log.ts packages/ops/src/bounded.ts packages/ops/src/http-metrics.ts packages/ops/src/metrics.ts ./packages/ops/src/
COPY --chmod=0755 packages/ops/src/langfuse.ts packages/ops/src/production-review-transport.ts ./packages/ops/src/
COPY --chmod=0755 packages/ops/src/config/web.ts ./packages/ops/src/config/
COPY --chmod=0755 infra/backend/ops-package.json ./packages/ops/package.json
COPY --chmod=0755 packages/contracts/package.json ./packages/contracts/
COPY --chmod=0755 packages/contracts/src/index.ts ./packages/contracts/src/
COPY --chmod=0755 infra/backend/storage-package.json ./packages/storage/package.json
COPY --chmod=0755 scripts/split-maintenance.py scripts/framework-retention.ts scripts/framework-evaluate.ts scripts/review-sample.ts scripts/production-review.ts ./scripts/
COPY --chmod=0755 infra/backend/storage-index.ts ./packages/storage/src/index.ts
COPY --chmod=0755 contracts/llm/v1 ./contracts/llm/v1
RUN mkdir -p node_modules/@ptr && ln -s ../../packages/contracts node_modules/@ptr/contracts && ln -s ../../packages/ops node_modules/@ptr/ops && ln -s ../../packages/storage node_modules/@ptr/storage
COPY --from=web-builder --chmod=0755 /app/apps/web/.next ./apps/web/.next
COPY --chmod=0755 apps/web/package.json apps/web/next.config.mjs ./apps/web/
COPY --chmod=0755 infra/backend/image-smoke.ts ./infra/backend/
RUN rm -rf apps/web/.next/cache && ln -s /tmp apps/web/.next/cache
# Runtime roles are non-root and image code stays immutable. Compose supplies private role-specific env files.
USER 900:2000
CMD ["node", "--import", "tsx", "apps/api/src/packaged-main.ts"]
