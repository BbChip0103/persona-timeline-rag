#  (D22): one image for every role (api, worker, web), run by infra/compose.app.yml.
# TypeScript runs through tsx; only the web is built (`next build`). Private configuration, research data and reports
# never enter the image (.dockerignore): Compose selects a new explicit private env_file and bind-mounts data/.
FROM node:24.14.0-bookworm-slim@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8

ENV NEXT_TELEMETRY_DISABLED=1 COREPACK_HOME=/opt/corepack
RUN corepack enable pnpm && corepack prepare pnpm@10.32.1 --activate

WORKDIR /app
# Manifests first, so a code change does not reinstall the dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/core/package.json packages/core/
COPY packages/images/package.json packages/images/
COPY packages/messaging/package.json packages/messaging/
COPY packages/ops/package.json packages/ops/
COPY packages/providers/package.json packages/providers/
COPY packages/storage/package.json packages/storage/
RUN --mount=type=cache,id=ptr-pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store

COPY . .
# The build phase skips the web's startup config check (NEXT_PHASE), so no secret is needed here.
RUN pnpm build:web
# After the install (tsx is a devDependency) and the build; the harnesses run the roles with the same value.
ENV NODE_ENV=production

# Compose sets the same default (PTR_UID / PTR_GID); the files stay root-owned and read-only to the roles.
USER 900:2000
