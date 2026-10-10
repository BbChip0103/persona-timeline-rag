# Thin service-backend/web image

The final root Docker image uses this **separate production manifest and frozen lock**. The historical workspace
lock remains available for legacy CLI/tests and the disposable Next.js build stage; its dependencies are never
copied into the runtime image. The profile pins reviewed native web/session/query/logging/CRUD dependencies alongside existing versions.

The final image contains only split API control/queue/storage code, shared wire contracts, narrow policy/log/config
helpers, the compiled web application, and this production dependency closure. No LangChain, OpenAI or Langfuse
SDK, provider implementations, Node LLM worker, Python package, private configuration, data or reports are included.
`packaged-main.ts` always runs split mode and rejects `PTR_LLM_SERVICE_MODE=legacy` before any resource connection.
Historical comparison helpers require their archived reference checkout; retired serving/worker commands are not available in the current checkout.

```sh
docker build -t ptr-backend:split .
# Runs as uid900; actual HTTP startup and shutdown with synthetic in-memory dependencies, no external calls.
docker run --rm ptr-backend:split node --import tsx infra/backend/image-smoke.ts
# Web role, using the same thin root dependency directory:
docker run --rm --env-file /absolute/private-web.env ptr-backend:split \
  node /app/node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 56440 /app/apps/web
```

When changing dependencies, update this explicit profile/lock separately and run the packaging tests plus image
probe. Never copy the full workspace `node_modules` into the final stage. Build layers may contain legacy development
dependencies; the final deployed image does not.
