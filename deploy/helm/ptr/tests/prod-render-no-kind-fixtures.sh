#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
chart_dir="$(cd -- "$script_dir/.." && pwd)"
repo_dir="$(cd -- "$chart_dir/../../.." && pwd)"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT

timeout 60s helm template ptr "$chart_dir" \
  --namespace ptr-system \
  --values "$repo_dir/deploy/helm/ptr/values-prod.yaml" >"$rendered"

if timeout 30s rg -n 'PTR_LLM_SYNTHETIC_PROVIDER_FIXTURE|PTR_LLM_OPENROUTER_BASE_URL' "$rendered"; then
  printf 'prod render contains kind-only OpenRouter fixture settings\n' >&2
  exit 1
fi
