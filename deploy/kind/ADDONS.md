# kind add-ons

`deploy/kind/up.sh` installs these official Helm charts into `kind-ptr-k8s` with
exact chart versions. Running it again upgrades the same releases idempotently.

| Release | Chart version | Namespace | Official source | Chart SHA-256 |
| --- | --- | --- | --- | --- |
| `ptr-keda` | `keda/keda` 2.21.0 | `ptr-keda` | https://github.com/kedacore/charts/tree/v2.21.0/keda | `sha256:a7da56bf41a33dad9d2fc82a6fdecee552fff947d80bf1e1dbcf4db0f9e26dee` |
| `ptr-metrics-server` | `metrics-server/metrics-server` 3.14.0 (app 0.9.0) | `kube-system` | https://github.com/kubernetes-sigs/metrics-server/releases/tag/metrics-server-helm-chart-3.14.0 | `sha256:c2ca1185c01e6e7f53dd1b7d131f0c9b3fa50e003ed068b784563a1b5a3422a1` |
| `ptr-monitoring` | `prometheus-community/kube-prometheus-stack` 92.3.1 | `ptr-monitoring` | https://github.com/prometheus-community/helm-charts/tree/kube-prometheus-stack-92.3.1/charts/kube-prometheus-stack | `sha256:5c976ae9562ec3b28b571f38e109e5d3f2ea3355573da416cd06be52dce6bd6a` |

The repository URLs used by the installer are the official chart repositories:
`https://kedacore.github.io/charts`,
`https://kubernetes-sigs.github.io/metrics-server/`, and
`https://prometheus-community.github.io/helm-charts`.
`deploy/kind/up.sh` pulls the chart archives first, checks these SHA-256
digests, and installs the verified local archives.

The Prometheus profile retains Prometheus Operator, Prometheus, and the
chart-pinned kube-state-metrics subchart (8.6.0). The latter collects only
Deployment metrics in `ptr-inference` with a namespace Role and RoleBinding
(`rbac.useClusterRole: false`), so worker scaling can compare desired and ready
engine replicas without cluster-wide kube-state-metrics access. It disables
Grafana, Alertmanager, node-exporter,
bundled rules, and Kubernetes control-plane scraping, and requests small
resources.
The metrics-server profile sets `--kubelet-insecure-tls` for kind kubelets.
This flag is restricted to this local kind profile.
