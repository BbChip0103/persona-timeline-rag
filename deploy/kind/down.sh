#!/usr/bin/env bash
set -euo pipefail

cluster_name="${KIND_CLUSTER_NAME:-ptr-k8s}"
kind_bin="${KIND:-kind}"

if [ "$cluster_name" != "ptr-k8s" ]; then
  printf 'Refusing to delete unexpected kind cluster: %s\n' "$cluster_name" >&2
  exit 1
fi

"$kind_bin" delete cluster --name "$cluster_name"
