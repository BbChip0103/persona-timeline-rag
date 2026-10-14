#!/usr/bin/env bash
set -euo pipefail

cluster_name="${KIND_CLUSTER_NAME:-ptr-k8s}"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"

kind_bin="${KIND:-kind}"
kubectl_bin="${KUBECTL:-kubectl}"
docker_bin="${DOCKER:-docker}"
helm_bin="${HELM:-helm}"
kubectl_cmd=("$kubectl_bin" --context "kind-$cluster_name")

if [ "$cluster_name" != "ptr-k8s" ]; then
  printf 'Refusing to manage unexpected kind cluster: %s\n' "$cluster_name" >&2
  exit 1
fi

if [ "${1:-}" != "" ] && [ "$1" != "--prune-only" ]; then
  printf 'Unexpected argument: %s\n' "$1" >&2
  exit 1
fi

prune_old_images() {
  local keep_backend="${1:-}" keep_worker="${2:-}" image node
  local active_images
  active_images="$("${kubectl_cmd[@]}" get pods -A -o json | jq -r '.items[].spec.containers[].image' | sort -u)"
  for node in $("$kind_bin" get nodes --name "$cluster_name"); do
    while IFS= read -r image; do
      case "$image" in
        docker.io/library/ptr-backend:k2-*|docker.io/library/ptr-worker:k2-*) ;;
        *) continue ;;
      esac
      if [ "$image" = "docker.io/library/$keep_backend" ] || [ "$image" = "docker.io/library/$keep_worker" ]; then
        continue
      fi
      if printf '%s\n' "$active_images" | grep -Fxq "${image#docker.io/library/}"; then
        continue
      fi
      "$docker_bin" exec "$node" crictl rmi "$image"
    done < <("$docker_bin" exec "$node" crictl images --output json | jq -r '.images[].repoTags[]?')
  done
  while IFS= read -r image; do
    case "$image" in
      ptr-backend:k2-*|ptr-worker:k2-*) ;;
      *) continue ;;
    esac
    if [ "$image" = "$keep_backend" ] || [ "$image" = "$keep_worker" ]; then
      continue
    fi
    if printf '%s\n' "$active_images" | grep -Fxq "$image"; then
      continue
    fi
    "$docker_bin" image rm "$image"
  done < <("$docker_bin" image ls --format '{{.Repository}}:{{.Tag}}')
}

if [ "${1:-}" = "--prune-only" ]; then
  prune_old_images
  exit 0
fi

if ! "$kind_bin" get clusters | grep -Fxq "$cluster_name"; then
  "$kind_bin" create cluster --config "$script_dir/cluster.yaml" --name "$cluster_name"
fi

# Exact official chart versions; the values files bound kind resource use.
addon_dir="$(mktemp -d)"
gie_manifest=""
cleanup() {
  rm -rf -- "$addon_dir"
  if [ -n "$gie_manifest" ]; then
    rm -f -- "$gie_manifest"
  fi
}
trap cleanup EXIT

pull_pinned_chart() {
  local repo="$1" chart="$2" version="$3" sha256="$4" archive
  archive="$addon_dir/${chart}-${version}.tgz"
  "$helm_bin" pull "$repo/$chart" --version "$version" --destination "$addon_dir" >/dev/null
  printf '%s  %s\n' "$sha256" "$archive" | sha256sum -c - >/dev/null
  printf '%s\n' "$archive"
}

"$helm_bin" repo add keda https://kedacore.github.io/charts --force-update >/dev/null
"$helm_bin" repo add metrics-server https://kubernetes-sigs.github.io/metrics-server/ --force-update >/dev/null
"$helm_bin" repo add prometheus-community https://prometheus-community.github.io/helm-charts --force-update >/dev/null
"$helm_bin" repo update >/dev/null
keda_chart="$(pull_pinned_chart keda keda 2.21.0 a7da56bf41a33dad9d2fc82a6fdecee552fff947d80bf1e1dbcf4db0f9e26dee)"
metrics_server_chart="$(pull_pinned_chart metrics-server metrics-server 3.14.0 c2ca1185c01e6e7f53dd1b7d131f0c9b3fa50e003ed068b784563a1b5a3422a1)"
prometheus_chart="$(pull_pinned_chart prometheus-community kube-prometheus-stack 92.3.1 5c976ae9562ec3b28b571f38e109e5d3f2ea3355573da416cd06be52dce6bd6a)"
"$helm_bin" --kube-context "kind-$cluster_name" upgrade --install ptr-keda "$keda_chart" \
  --version 2.21.0 --namespace ptr-keda --create-namespace --values "$script_dir/keda-values.yaml" \
  --wait --timeout 5m >/dev/null
"$helm_bin" --kube-context "kind-$cluster_name" upgrade --install ptr-metrics-server "$metrics_server_chart" \
  --version 3.14.0 --namespace kube-system --values "$script_dir/metrics-server-values.yaml" \
  --wait --timeout 5m >/dev/null
"$helm_bin" --kube-context "kind-$cluster_name" upgrade --install ptr-monitoring "$prometheus_chart" \
  --version 92.3.1 --namespace ptr-monitoring --create-namespace --values "$script_dir/prometheus-values.yaml" \
  --wait --timeout 5m >/dev/null

# Gateway API Inference Extension v1.6.0 release asset (InferencePool v1 CRD only).
gie_version="v1.6.0"
gie_sha256="8f8fd05fa7369abbe99fd149d8ff3995bfa4aa87455003e78dc144201ec8f1c8"
gie_manifest="$(mktemp)"
curl -fsSL --retry 3 "https://github.com/kubernetes-sigs/gateway-api-inference-extension/releases/download/${gie_version}/v1-manifests.yaml" -o "$gie_manifest"
printf '%s  %s\n' "$gie_sha256" "$gie_manifest" | sha256sum -c - >/dev/null
"${kubectl_cmd[@]}" apply --server-side -f "$gie_manifest" >/dev/null
"${kubectl_cmd[@]}" wait --for=condition=Established --timeout=60s crd/inferencepools.inference.networking.k8s.io >/dev/null
"${kubectl_cmd[@]}" get crd inferencepools.inference.networking.k8s.io -o json |
  jq -e '.spec.versions[] | select(.name == "v1" and .served == true)' >/dev/null
"${kubectl_cmd[@]}" create namespace ptr-inference --dry-run=client -o yaml |
  "${kubectl_cmd[@]}" label --local -f - ptr.io/namespace=inference -o yaml |
  "${kubectl_cmd[@]}" apply -f - >/dev/null

stamp="$(date -u +%Y%m%d%H%M%S%N)-$(openssl rand -hex 4)"
git_rev="$(git -C "$repo_root" rev-parse --short=12 HEAD 2>/dev/null || printf 'nogit')"
backend_tag="k2-${git_rev}-${stamp}"
worker_tag="k2-${git_rev}-${stamp}"
backend_image="ptr-backend:${backend_tag}"
worker_image="ptr-worker:${worker_tag}"

"$docker_bin" build -t "$backend_image" "$repo_root"
"$docker_bin" build -t "$worker_image" -f "$repo_root/apps/llm-service/Dockerfile" "$repo_root"

"$kind_bin" load docker-image --name "$cluster_name" "$backend_image"
"$kind_bin" load docker-image --name "$cluster_name" "$worker_image"
prune_old_images "$backend_image" "$worker_image"

gpu_nodes=("${cluster_name}-worker2" "${cluster_name}-worker3")
for node in "${gpu_nodes[@]}"; do
  "${kubectl_cmd[@]}" label node "$node" ptr.io/fake-gpu=true accelerator=fake-gpu --overwrite >/dev/null
  "${kubectl_cmd[@]}" taint node "$node" nvidia.com/gpu=synthetic:NoSchedule --overwrite >/dev/null
  "${kubectl_cmd[@]}" patch node "$node" --subresource=status --type=merge \
    -p='{"status":{"capacity":{"ptr.io/fake-gpu":"1","nvidia.com/gpu":"1"},"allocatable":{"ptr.io/fake-gpu":"1","nvidia.com/gpu":"1"}}}' >/dev/null
done

control_plane_ip="$("$docker_bin" inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "${cluster_name}-control-plane")"
if [ -z "$control_plane_ip" ]; then
  printf 'Could not determine kind control-plane IP\n' >&2
  exit 1
fi

cat <<EOF
cluster=$cluster_name
backend_image=$backend_image
worker_image=$worker_image
helm_namespace=ptr-system
helm_set_args=--set images.backend.repository=ptr-backend --set images.backend.tag=$backend_tag --set images.worker.repository=ptr-worker --set images.worker.tag=$worker_tag --set-string inference.apiServerCIDRs[1]=$control_plane_ip/32
EOF
