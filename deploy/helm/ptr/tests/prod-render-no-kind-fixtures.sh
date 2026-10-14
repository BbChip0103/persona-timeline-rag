#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
chart_dir="$(cd -- "$script_dir/.." && pwd)"
repo_dir="$(cd -- "$chart_dir/../../.." && pwd)"
values_file="${1:-$repo_dir/deploy/helm/ptr/values-prod.yaml}"
rendered="$(mktemp)"
trap 'rm -f "$rendered"' EXIT

timeout 60s helm template ptr "$chart_dir" \
  --namespace ptr-system \
  --values "$values_file" >"$rendered"

set +e
timeout 30s grep -E -n 'PTR_LLM_SYNTHETIC_PROVIDER_FIXTURE|PTR_LLM_OPENROUTER_BASE_URL' "$rendered"
status=$?
set -e
case "$status" in
  0)
    printf 'prod render contains kind-only OpenRouter fixture settings\n' >&2
    exit 1
    ;;
  1)
    ;;
  *)
    printf 'prod fixture render check failed with exit %s\n' "$status" >&2
    exit "$status"
    ;;
esac
