# Historical framework configuration cleanup plan

This plan belongs to the archived framework/LiteLLM migration. The current
configuration surface is the split API/worker/web path, with no active LiteLLM
readiness probe.

1. Keep `web.ts`'s public authentication, fixed API target and build-time behavior.
2. Lock operator safety: key/rule-only errors, explicit-file env checking, no startup
   connections, no hidden demo bypass, API/worker-only production roles.
3. Delete old gateway/dispatcher/API/worker schema files. API and worker operator
   validation delegates to the existing `loadFrameworkConfig`; no alternate
   production configuration schema or legacy registry/capacity defaults remain.
4. Reduce the environment registry to active framework/web controls and explicit
   tool/system names. Remove fleet/gateway/capacity demo macros and numeric caps
   on the historical production-key count. Preserve meaningful unknown-key,
   deprecated execution and conflicting DB-alias checks.
5. Update `ops:check-env` to require `--file` and validate only api/worker/web. It
   never auto-reads `.env*`, never prints rejected values, and starts no service.
6. Preserve the Prometheus parse/read-facing status utility, replace synthetic
   fixtures with genuine Registry/Counter collectors, and stop probing obsolete
   dispatcher/gateway roles or their bespoke metrics. Default probes are API and
   worker. Historical configured LiteLLM/Langfuse readiness checks made no model
   calls or credential-bearing requests.

Web authentication and synthetic target isolation have existing regression tests;
operator/status contracts use synthetic values and transport doubles only.

Historical readiness sources: [LiteLLM probes](https://docs.litellm.ai/docs/proxy/health)
(`/health/readiness`, never the billable model-testing `/health`) and
[Langfuse readiness](https://langfuse.com/self-hosting/configuration/health-readiness-endpoints)
(`/api/public/ready`). These probes prove process readiness, not successful model
inference, trace ingestion, experiments or human-review workflows.
