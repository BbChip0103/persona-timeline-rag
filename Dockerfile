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
ENV NODE_ENV=production
COPY --from=backend-deps /app/node_modules ./node_modules
COPY --chmod=0755 infra/backend/package.json infra/backend/pnpm-lock.yaml ./
COPY --chmod=0755 tsconfig.json tsconfig.base.json ./
COPY --chmod=0755 apps/api/src/app.ts apps/api/src/schema-pipes.ts apps/api/src/observability.ts apps/api/src/public-turn.ts apps/api/src/split-chat.ts apps/api/src/split-runtime.ts apps/api/src/turn-sse.ts apps/api/src/packaged-main.ts ./apps/api/src/
COPY --chmod=0755 packages/core/src/ports.ts packages/core/src/safety.ts packages/core/src/reply-texts.ts packages/core/src/turn-worker.ts packages/core/src/request-fingerprint.ts packages/core/src/persona-card.ts ./packages/core/src/
COPY --chmod=0755 packages/storage/src/pool.ts packages/storage/src/local-guard.ts packages/storage/src/conversations.ts packages/storage/src/llm-control.ts ./packages/storage/src/
COPY --chmod=0755 packages/messaging/src/bullmq-delivery.ts packages/messaging/src/turn-events.ts packages/messaging/src/redis.ts packages/messaging/src/local-guard.ts ./packages/messaging/src/
COPY --chmod=0755 packages/ops/src/log.ts packages/ops/src/http-metrics.ts packages/ops/src/metrics.ts ./packages/ops/src/
COPY --chmod=0755 packages/ops/src/config/web.ts ./packages/ops/src/config/
COPY --chmod=0755 infra/backend/ops-package.json ./packages/ops/package.json
COPY --chmod=0755 packages/contracts/package.json ./packages/contracts/
COPY --chmod=0755 packages/contracts/src/index.ts ./packages/contracts/src/
COPY --chmod=0755 contracts/llm/v1 ./contracts/llm/v1
RUN mkdir -p node_modules/@ptr && ln -s ../../packages/contracts node_modules/@ptr/contracts && ln -s ../../packages/ops node_modules/@ptr/ops
COPY --from=web-builder --chmod=0755 /app/apps/web/.next ./apps/web/.next
COPY --chmod=0755 apps/web/package.json apps/web/next.config.mjs ./apps/web/
COPY --chmod=0755 infra/backend/image-smoke.ts ./infra/backend/
# Runtime roles are non-root and image code stays immutable. Compose supplies private role-specific env files.
USER 900:2000
CMD ["node", "--import", "tsx", "apps/api/src/packaged-main.ts"]
