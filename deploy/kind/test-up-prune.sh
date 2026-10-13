#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

cat > "$test_dir/kind" <<'EOF'
#!/usr/bin/env bash
printf 'ptr-k8s-worker\n'
EOF
cat > "$test_dir/kubectl" <<'EOF'
#!/usr/bin/env bash
printf '{"items":[{"spec":{"containers":[{"image":"ptr-backend:k2-active"}]}}]}\n'
EOF
cat > "$test_dir/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1 $3 $4" = 'exec crictl images' ]; then
  printf '{"images":[{"repoTags":["docker.io/library/ptr-backend:k2-old","docker.io/library/ptr-backend:k2-active","docker.io/library/ptr-worker:k2-old","docker.io/library/ptr-backend:unrelated","elsewhere/ptr-worker:k2-old"]}]}\n'
elif [ "$1 $2" = 'image ls' ]; then
  printf 'ptr-backend:k2-old\nptr-backend:k2-active\nptr-worker:k2-old\nptr-backend:unrelated\nelsewhere/ptr-worker:k2-old\n'
else
  printf '%s\n' "$*" >> "$TEST_IMAGE_LOG"
fi
EOF
chmod +x "$test_dir/kind" "$test_dir/kubectl" "$test_dir/docker"
TEST_IMAGE_LOG="$test_dir/log" KIND="$test_dir/kind" KUBECTL="$test_dir/kubectl" DOCKER="$test_dir/docker" \
  "$script_dir/up.sh" --prune-only
cat > "$test_dir/expected" <<'EOF'
exec ptr-k8s-worker crictl rmi docker.io/library/ptr-backend:k2-old
exec ptr-k8s-worker crictl rmi docker.io/library/ptr-worker:k2-old
image rm ptr-backend:k2-old
image rm ptr-worker:k2-old
EOF
diff -u "$test_dir/expected" "$test_dir/log"
