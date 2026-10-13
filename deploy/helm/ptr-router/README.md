# Standalone inference router

This chart vendors the unmodified official
[`llm-d-router-standalone` v0.11.0](https://github.com/llm-d/llm-d-router/releases/tag/v0.11.0)
OCI chart (`oci://ghcr.io/llm-d/charts/llm-d-router-standalone`, digest
`sha256:56a5635f5fd6e1252f802e06186cf9c4c60bcb95b7911b0867660a7db4d04c1c`).
The vendored archive's sha256 is checked by `llm-d-router-standalone.sha256` in CI.
The EPP and proxy images are pinned through the upstream image values. Each
profile sets a literal `maxRequests` based on its maximum engine replicas × 4.
The parent chart has an
empty dependency repository: Helm uses the checked in archive. Running
`helm dependency build` fails closed because there is no remote source or
unpacked source directory; the archive remains unchanged.
It is a separate Helm release in `ptr-inference`, because the existing `ptr`
release remains in `ptr-system` and Helm subcharts use their parent release
namespace. The `ptr` chart owns the `InferencePool`, engine Deployment, and
NetworkPolicies. The router's standalone endpoint selector targets the same
`pool=chat-primary` label as the `InferencePool`.

```sh
timeout 10s bash -lc 'cd deploy/helm/ptr-router && sha256sum -c llm-d-router-standalone.sha256'
timeout 120s helm upgrade --install chat-primary deploy/helm/ptr-router \
  --wait --timeout 90s \
  --namespace ptr-inference --values deploy/helm/ptr-router/values-kind.yaml
```

The router has one EPP replica, with no leader election or router PodDisruptionBudget.
The EPP pod tolerates node NotReady and Unreachable taints for 30 seconds.
The one-replica Deployment supports `helm --wait`; losing its node still leaves
a recovery gap while the replacement starts.

The router configuration keeps the upstream default scorer weights (queue 2,
KV 2, prefix 3) and adds flow control. Its Envoy route has no `retry_policy`,
so HTTP route retries are disabled; the upstream config's `max_retries` circuit
breaker is a capacity limit, not a route retry setting. Keep
`maxConcurrency` in the router profile aligned with the engine's `maxNumSeqs`
in the corresponding `ptr` profile.

Production disables EPP metrics endpoint auth because the `ptr` chart's
`ptr-inference` NetworkPolicies already deny ingress to the router pod except
for Envoy's serving port and explicitly labelled test clients. This avoids
installing cluster-wide TokenReview/SubjectAccessReview RBAC for metrics.
