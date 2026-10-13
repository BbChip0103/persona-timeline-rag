#!/usr/bin/env bash
set -euo pipefail
set +x

cluster_name="${KIND_CLUSTER_NAME:-ptr-k8s}"
kubectl_bin="${KUBECTL:-kubectl}"
kubectl_cmd=("$kubectl_bin" --context "kind-$cluster_name")

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
redis_password="$(rand_hex)"
redis_keda_password="$(rand_hex)"
redis_url="redis://ptr:${redis_password}@ptr-redis.ptr-data.svc:6379/0"
control_token="$(rand_hex)"
api_token="$(rand_hex)"
synthetic_token="$(rand_hex)"
maintenance_token="$(rand_hex)"
session_secret="$(rand_hex)"
ui_password="$(rand_hex)"

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
  name: ptr-maintenance
  namespace: ptr-app
type: Opaque
stringData:
  PTR_MAINTENANCE_DATABASE_URL: "$app_database_url"
  PTR_MAINTENANCE_REDIS_URL: "$redis_url"
  PTR_MAINTENANCE_TOKEN: "$maintenance_token"
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
fi

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
  name: ptr-maintenance
  keys:
  - PTR_MAINTENANCE_DATABASE_URL
  - PTR_MAINTENANCE_REDIS_URL
  - PTR_MAINTENANCE_TOKEN
- namespace: ptr-app
  name: ptr-personas
  keys:
  - PTR_PERSONA_FIXTURE
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
