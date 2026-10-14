# Kubeconform CRD schemas

These files are extracted OpenAPI v3 schemas used by CI for CRDs that the
default kubeconform schema source does not validate.

| File | Source | Source/ref SHA | File SHA-256 |
| --- | --- | --- | --- |
| `InferencePool-v1.json` | `spec.versions[name=v1].schema.openAPIV3Schema` from the Gateway API Inference Extension v1.6.0 release manifest, `https://github.com/kubernetes-sigs/gateway-api-inference-extension/releases/download/v1.6.0/v1-manifests.yaml` | manifest `8f8fd05fa7369abbe99fd149d8ff3995bfa4aa87455003e78dc144201ec8f1c8` | `38bc4d575d4025481a7cf428e9a7d0361f01be74d8a4bcd67d966d60bd6ea367` |
| `ScaledObject.json` | `spec.versions[name=v1alpha1].schema.openAPIV3Schema` from the KEDA 2.21.0 CRD chart template, `keda/keda` | chart `sha256:a7da56bf41a33dad9d2fc82a6fdecee552fff947d80bf1e1dbcf4db0f9e26dee` | `87b41524f960902bc03b2966c7d2be0043b9e27c39efa5913bab9de192efd33f` |
| `TriggerAuthentication.json` | `spec.versions[name=v1alpha1].schema.openAPIV3Schema` from the KEDA 2.21.0 CRD chart template, `keda/keda` | chart `sha256:a7da56bf41a33dad9d2fc82a6fdecee552fff947d80bf1e1dbcf4db0f9e26dee` | `dc233f5b5e96a3ac8634ef62ea9be1851837af40ebe39619d4a6f25192815d83` |
| `ServiceMonitor.json` | `spec.versions[name=v1].schema.openAPIV3Schema` from the Prometheus Operator CRD bundled in `prometheus-community/kube-prometheus-stack` 92.3.1 | chart `sha256:5c976ae9562ec3b28b571f38e109e5d3f2ea3355573da416cd06be52dce6bd6a` | `f8bb3b3e1e68b9354b606c8e78400030336fc0e7b59942a5bb7a3d642752b426` |

Keep the file names stable because `.github/workflows/ci.yml` maps expected
rendered kinds to these files.
