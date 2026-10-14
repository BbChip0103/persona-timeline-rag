# PTR Helm Chart

This chart renders the synthetic kind profile and the production template profile
for the persona timeline RAG PoC. It does not create application credentials;
named Secrets must already exist before install.

## Maintenance CronJobs

Set `maintenance.enabled=true` to render maintenance CronJobs.

- `daily-split-retention` and `daily-framework-retention` are Kubernetes-safe
  retention jobs and remain enabled in kind and production values.
- `weekly-review-sample` and `weekly-production-review` handle private human
  review files and shared review state. They are disabled in `values-prod.yaml`
  and must run from the host/systemd maintenance units in production.
- Kind keeps the two weekly review jobs only as synthetic smoke tests. They are
  labelled `ptr.io/synthetic-smoke=true` and
  `ptr.io/host-only-production-step=true`.

Production runs these weekly review steps through host/systemd maintenance
only; the chart does not provide their private review root or durable shared
lock and journal.

## Profiles

- `values-kind.yaml` enables local data stores, the fake OpenRouter fixture and
  synthetic maintenance smoke coverage.
- `values-prod.yaml` is a template-only profile for externally provisioned
  Secrets, data stores and model weights.
