#!/bin/sh
set -eu
mc alias set ptr http://langfuse-blob:9000 "$PTR_LANGFUSE_BLOB_USER" "$PTR_LANGFUSE_BLOB_PASSWORD" >/dev/null
# S3 lifecycle alone does not remove ClickHouse/PG copies. See the retention CLI/runbook.
mc mb --ignore-existing ptr/ptr-langfuse >/dev/null
mc ilm import ptr/ptr-langfuse < /policy/blob-lifecycle.json
mc anonymous set none ptr/ptr-langfuse >/dev/null
mc ilm ls ptr/ptr-langfuse
