# InferencePool v1 schema

`InferencePool-v1.json` is the `spec.versions[name=v1].schema.openAPIV3Schema`
from the [Gateway API Inference Extension v1.6.0 release manifest](https://github.com/kubernetes-sigs/gateway-api-inference-extension/releases/download/v1.6.0/v1-manifests.yaml).
The manifest SHA-256 is
`8f8fd05fa7369abbe99fd149d8ff3995bfa4aa87455003e78dc144201ec8f1c8`.
Kubeconform uses this schema only when the standard Kubernetes schema source has
no schema for `InferencePool`; other resources use its standard source.
