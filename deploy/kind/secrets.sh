#!/usr/bin/env bash
set -euo pipefail
set +x

cluster_name="${KIND_CLUSTER_NAME:-ptr-k8s}"
kubectl_bin="${KUBECTL:-kubectl}"
kubectl_cmd=("$kubectl_bin" --context "kind-$cluster_name")
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

if [ "$cluster_name" != "ptr-k8s" ]; then
  printf 'Refusing to manage unexpected kind cluster: %s\n' "$cluster_name" >&2
  exit 1
fi

"${kubectl_cmd[@]}" create namespace ptr-app --dry-run=client -o yaml | "${kubectl_cmd[@]}" apply -f - >/dev/null
"${kubectl_cmd[@]}" create namespace ptr-data --dry-run=client -o yaml | "${kubectl_cmd[@]}" apply -f - >/dev/null
"${kubectl_cmd[@]}" create namespace ptr-system --dry-run=client -o yaml | "${kubectl_cmd[@]}" apply -f - >/dev/null

rand_hex() {
  openssl rand -hex 32
}

postgres_owner_password="$(rand_hex)"
postgres_app_password="$(rand_hex)"
postgres_worker_password="$(rand_hex)"
app_database_url="postgresql://ptr_split_app:${postgres_app_password}@ptr-postgres.ptr-data.svc:5432/ptr_split_test"
worker_database_url="postgresql://ptr_split_llm:${postgres_worker_password}@ptr-postgres.ptr-data.svc:5432/ptr_split_test"
maintenance_database_url="postgresql://ptr_split_owner:${postgres_owner_password}@ptr-postgres.ptr-data.svc:5432/ptr_split_test"
redis_password="$(rand_hex)"
redis_keda_password="$(rand_hex)"
redis_url="redis://ptr:${redis_password}@ptr-redis.ptr-data.svc:6379/0"
control_token="$(rand_hex)"
api_token="$(rand_hex)"
synthetic_token="$(rand_hex)"
maintenance_token="$(rand_hex)"
session_secret="$(rand_hex)"
ui_password="$(rand_hex)"
openrouter_api_key="synthetic-$(rand_hex)"

existing=0
for spec in ptr-app:ptr-api ptr-app:ptr-worker ptr-app:ptr-maintenance ptr-app:ptr-personas ptr-data:ptr-data; do
  namespace="${spec%%:*}"
  name="${spec#*:}"
  if "${kubectl_cmd[@]}" get secret "$name" -n "$namespace" >/dev/null 2>&1; then
    existing=$((existing + 1))
  fi
done
if [ "$existing" -gt 0 ] && [ "$existing" -lt 5 ]; then
  printf 'Refusing to replace a partial synthetic Secret set\n' >&2
  exit 1
fi

apply_keda_redis_secret() {
  if "${kubectl_cmd[@]}" get secret ptr-keda-redis -n ptr-app >/dev/null 2>&1; then
    return
  fi
  local password="$1"
  if ! "${kubectl_cmd[@]}" apply -f - >/dev/null 2>&1 <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ptr-keda-redis
  namespace: ptr-app
type: Opaque
stringData:
  REDIS_ADDRESS: "ptr-redis.ptr-data.svc:6379"
  REDIS_USERNAME: "keda"
  REDIS_PASSWORD: "$password"
EOF
  then
    printf 'Synthetic KEDA Redis Secret apply failed (values withheld)\n' >&2
    exit 1
  fi
}

patch_existing_maintenance_secret() {
  if ! "${kubectl_cmd[@]}" get secret ptr-maintenance -n ptr-app >/dev/null 2>&1; then
    return
  fi
  local owner_database_url="$1"
  if ! "${kubectl_cmd[@]}" get secret ptr-maintenance -n ptr-app -o json |
    OWNER_DATABASE_URL="$owner_database_url" jq '
      .data.PTR_LLM_MAINTENANCE_DATABASE_URL = (env.OWNER_DATABASE_URL | @base64) |
      .data.PTR_MAINTENANCE_DATABASE_URL = (env.OWNER_DATABASE_URL | @base64) |
      .data.PTR_MAINTENANCE_SYNTHETIC_ONLY = ("1" | @base64) |
      .data.PTR_MAINTENANCE_APPLY = ("0" | @base64) |
      .data.PTR_MAINTENANCE_TIMEOUT_SECONDS = ("300" | @base64) |
      .data.PTR_MAINTENANCE_DAILY_LIMIT = ("100" | @base64) |
      .data.PTR_MAINTENANCE_WEEKLY_SINCE_DAYS = ("7" | @base64)
    ' |
    "${kubectl_cmd[@]}" replace -f - >/dev/null 2>&1
  then
    printf 'Synthetic maintenance Secret patch failed (values withheld)\n' >&2
    exit 1
  fi
}

if [ "$existing" -eq 0 ]; then
if ! "${kubectl_cmd[@]}" apply -f - >/dev/null 2>&1 <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ptr-api
  namespace: ptr-app
type: Opaque
stringData:
  PTR_APP_DATABASE_URL: "$app_database_url"
  PTR_REDIS_URL: "$redis_url"
  PTR_LLM_CONTROL_TOKEN: "$control_token"
  PTR_API_TOKEN: "$api_token"
  PTR_API_SYNTHETIC_TOKEN: "$synthetic_token"
  PTR_SESSION_SECRET: "$session_secret"
  PTR_UI_PASSWORD: "$ui_password"
---
apiVersion: v1
kind: Secret
metadata:
  name: ptr-worker
  namespace: ptr-app
type: Opaque
stringData:
  PTR_LLM_DATABASE_URL: "$worker_database_url"
  PTR_LLM_REDIS_URL: "$redis_url"
  PTR_LLM_CONTROL_TOKEN: "$control_token"
---
apiVersion: v1
kind: Secret
metadata:
  name: ptr-worker-openrouter
  namespace: ptr-app
type: Opaque
stringData:
  OPENROUTER_API_KEY: "$openrouter_api_key"
---
apiVersion: v1
kind: Secret
metadata:
  name: ptr-maintenance
  namespace: ptr-app
type: Opaque
stringData:
  PTR_LLM_MAINTENANCE_DATABASE_URL: "$maintenance_database_url"
  PTR_MAINTENANCE_DATABASE_URL: "$maintenance_database_url"
  PTR_MAINTENANCE_REDIS_URL: "$redis_url"
  PTR_MAINTENANCE_TOKEN: "$maintenance_token"
  PTR_MAINTENANCE_SYNTHETIC_ONLY: "1"
  PTR_MAINTENANCE_APPLY: "0"
  PTR_MAINTENANCE_TIMEOUT_SECONDS: "300"
  PTR_MAINTENANCE_DAILY_LIMIT: "100"
  PTR_MAINTENANCE_WEEKLY_SINCE_DAYS: "7"
---
apiVersion: v1
kind: Secret
metadata:
  name: ptr-personas
  namespace: ptr-app
type: Opaque
stringData:
  PTR_PERSONA_FIXTURE: "synthetic"
---
apiVersion: v1
kind: Secret
metadata:
  name: ptr-data
  namespace: ptr-data
type: Opaque
stringData:
  POSTGRES_DB: "ptr_split_test"
  POSTGRES_USER: "ptr_split_owner"
  POSTGRES_PASSWORD: "$postgres_owner_password"
  PTR_SPLIT_APP_PASSWORD: "$postgres_app_password"
  PTR_SPLIT_LLM_PASSWORD: "$postgres_worker_password"
  REDIS_PASSWORD: "$redis_password"
  REDIS_KEDA_PASSWORD: "$redis_keda_password"
EOF
then
  printf 'Synthetic Secret apply failed (values withheld)\n' >&2
  exit 1
fi
apply_keda_redis_secret "$redis_keda_password"
patch_existing_maintenance_secret "$maintenance_database_url"
else
  existing_redis_keda_password="$("${kubectl_cmd[@]}" get secret ptr-data -n ptr-data -o jsonpath='{.data.REDIS_KEDA_PASSWORD}' | base64 -d)"
  existing_postgres_owner_password="$("${kubectl_cmd[@]}" get secret ptr-data -n ptr-data -o jsonpath='{.data.POSTGRES_PASSWORD}' | base64 -d)"
  existing_maintenance_database_url="postgresql://ptr_split_owner:${existing_postgres_owner_password}@ptr-postgres.ptr-data.svc:5432/ptr_split_test"
  apply_keda_redis_secret "$existing_redis_keda_password"
  patch_existing_maintenance_secret "$existing_maintenance_database_url"
fi

if ! "${kubectl_cmd[@]}" get secret ptr-worker-openrouter -n ptr-app >/dev/null 2>&1; then
if ! "${kubectl_cmd[@]}" apply -f - >/dev/null 2>&1 <<EOF
apiVersion: v1
kind: Secret
metadata:
  name: ptr-worker-openrouter
  namespace: ptr-app
type: Opaque
stringData:
  OPENROUTER_API_KEY: "$openrouter_api_key"
EOF
then
  printf 'Synthetic worker OpenRouter Secret apply failed (values withheld)\n' >&2
  exit 1
fi
fi

if ! "${kubectl_cmd[@]}" get secret ptr-worker-openrouter -n ptr-app -o json |
  jq -e '.data.OPENROUTER_API_KEY != null' >/dev/null; then
  printf 'Synthetic worker OpenRouter Secret key names are incomplete (values withheld)\n' >&2
  exit 1
fi

# This file contains only the public synthetic persona seeded by the kind bootstrap.
"${kubectl_cmd[@]}" create secret generic ptr-personas -n ptr-app \
  --from-literal=PTR_PERSONA_FIXTURE=synthetic \
  --from-file="PTR_LLM_PUBLISHED_PERSONAS_JSON=$script_dir/synthetic-personas.json" \
  --dry-run=client -o yaml | "${kubectl_cmd[@]}" apply -f - >/dev/null 2>&1

cat <<'EOF'
synthetic_secret_keys:
- namespace: ptr-app
  name: ptr-api
  keys:
  - PTR_APP_DATABASE_URL
  - PTR_REDIS_URL
  - PTR_LLM_CONTROL_TOKEN
  - PTR_API_TOKEN
  - PTR_API_SYNTHETIC_TOKEN
  - PTR_SESSION_SECRET
  - PTR_UI_PASSWORD
- namespace: ptr-app
  name: ptr-worker
  keys:
  - PTR_LLM_DATABASE_URL
  - PTR_LLM_REDIS_URL
  - PTR_LLM_CONTROL_TOKEN
- namespace: ptr-app
  name: ptr-worker-openrouter
  keys:
  - OPENROUTER_API_KEY
- namespace: ptr-app
  name: ptr-maintenance
  keys:
  - PTR_LLM_MAINTENANCE_DATABASE_URL
  - PTR_MAINTENANCE_DATABASE_URL
  - PTR_MAINTENANCE_REDIS_URL
  - PTR_MAINTENANCE_TOKEN
  - PTR_MAINTENANCE_SYNTHETIC_ONLY
  - PTR_MAINTENANCE_APPLY
  - PTR_MAINTENANCE_TIMEOUT_SECONDS
  - PTR_MAINTENANCE_DAILY_LIMIT
  - PTR_MAINTENANCE_WEEKLY_SINCE_DAYS
- namespace: ptr-app
  name: ptr-personas
  keys:
  - PTR_PERSONA_FIXTURE
  - PTR_LLM_PUBLISHED_PERSONAS_JSON
- namespace: ptr-app
  name: ptr-keda-redis
  keys:
  - REDIS_ADDRESS
  - REDIS_USERNAME
  - REDIS_PASSWORD
- namespace: ptr-data
  name: ptr-data
  keys:
  - POSTGRES_DB
  - POSTGRES_USER
  - POSTGRES_PASSWORD
  - PTR_SPLIT_APP_PASSWORD
  - PTR_SPLIT_LLM_PASSWORD
  - REDIS_PASSWORD
  - REDIS_KEDA_PASSWORD
EOF
