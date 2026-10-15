# Owned three-tier operational deployment

Use `infra/compose.app.yml` with `infra/split/compose.operational.yml` for the
private Linux deployment. The override does not provision or recreate the approved
research database/queue. Validate their identities, durable storage, schema and
role grants first. Runtime credentials must never be migration-owner credentials.

For Kubernetes installation and operations, use [kubernetes.md](kubernetes.md).
The Compose path here remains independent. The K6 fixes to the API `pg.Pool`
idle-error listener, worker drain and K4 pass-through validation need an
operational Compose redeploy before that deployment benefits from them; obtain
user approval for that redeploy. Apply
`supabase/split/0005_generated_artifacts.sql` before the API, and roll out the
API reader before workers that emit the new receipt wire schema. Check durable
ACKs and readiness after each role rollout. Ship the API and worker images from
the same source revision; the API must understand every receipt label the worker
can write.

## Configuration and supervision

Reuse the existing owned Compose project name and owner nonce, immutable verified
backend and worker image IDs, separate private environment files and loopback ports in a `0600`
operator Compose environment. Keep its directory `0700`. Do not print resolved
Compose configuration: it can contain secrets. Validate with `config -q`.
Set `PTR_OPERATIONAL_DATA_DIR` to the parent of the live API `generated` bind
source recorded in the rollback snapshot. Keep the research data in place.
In the worker-only env file set `PTR_LLM_PROVIDER=local`,
`PTR_LLM_LOCAL_BASE_URL=http://127.0.0.1:<vLLM tunnel port>/v1`,
`PTR_LLM_LOCAL_MODEL=<served model ID>`, `PTR_LLM_LOCAL_API_KEY=<vLLM key>` and
`PTR_LLM_LOCAL_AUTH_REQUIRED=1` and `PTR_LLM_SPILLOVER=off`. The base URL is the
authenticated loopback SSH-tunnel endpoint that the old gateway used for vLLM.
Spillover defaults to off. To enable it during the redeploy preparation below,
set `PTR_LLM_SPILLOVER=openrouter`, `PTR_LLM_LOCAL_SLOTS` (1–256) and
`PTR_LLM_SPILLOVER_WAIT_MS=2000` (100–10000 ms). The Redis shared slot count
must match the operating vLLM `max-num-seqs`; inspect the owned GPU deployment
record without changing RunPod/vLLM. If the value cannot be established, start
with 8 and review the metrics. Set worker concurrency to ceil(slots × 1.25),
for example 10 for 8 slots; concurrency at or below slots cannot create overflow
and produces a startup warning. Only the worker receives the dedicated
OpenRouter key. Set the backend's `PTR_CHAT_PROVIDER=local` and `PTR_MODEL` to
the same served model ID, and `PTR_PAID_SPILLOVER=1` when enabling spillover so
paid-capable drafts require `clientRequestId` (`0` when spillover is off).
The SPLIT API does not call a provider; its flag marks drafts billable and the
worker owns the spill ledger. Set `PTR_LLM_LIVE_ENABLED=1` and
`PTR_LLM_ALLOW_EXTERNAL_DATA=1` in the worker file for an approved spillover
run, and keep both `0` when spillover is off.

Compose waits for a Redis slot for two seconds before considering OpenRouter.
Only actual GPU capacity overflow permits paid submission; Redis errors and
other local failures do not. Before submission, unavailable spillover (including
budget, price, key or DeepInfra ZDR checks) returns to local slot waiting until
the turn deadline. After submission, failure or unknown results retain their
existing accounting and are never resubmitted locally or externally. The
cumulative ledger cap is US$1, with a separate dedicated key lifetime credit
limit no greater than US$1; check current cumulative usage before enabling.
DeepInfra is pinned, with prompt/completion price caps of US$0.1/US$0.5 per
million tokens. DeepInfra must appear in the ZDR endpoint list; absence disables
spillover. Key, price and ZDR availability are rechecked every 60 seconds.

```sh
docker compose --env-file /private/compose.env \
  -f infra/compose.app.yml -f infra/split/compose.operational.yml config -q
```

For an existing deployment, use the ordered redeploy procedure below; do not
start the new worker before its migration and API reader are ready.

Web receives only UI/session/API credentials and no corpus mount. Backend receives
the app role/control credentials; Python receives the LLM role and local vLLM
key. The worker calls vLLM directly through the authenticated loopback tunnel.
The Compose services are api, web and worker; no gateway database or Redis is
provisioned. All roles restart `unless-stopped`. LiteLLM routing code is not
part of the current repository after L4; rollback material lives in the private
operational snapshot captured before cutover.

Run the existing GPU engine through an authenticated private endpoint. When native
remote process supervision is unavailable, an operator-owned user-systemd unit can
supervise foreground SSH plus its loopback forward. Keep its environment, key,
script and cached model location durable, with native restart/backoff. Do not add a
TTL to a persistent service. Enable user linger only when persistent execution is
authorized. Native supervision is not proof of host reboot, instance recreation,
network availability or multi-engine performance.

### Why no LLM gateway

 (`private design notes` repo `<private-design-notes>` §1, §4 L4, §6.4)
removes the gateway from the active operational path. The durable provider
ledger and the provider key's credit limit enforce paid budget, the EPP owns
local routing/admission in Kubernetes, and the paid key lives only in the
worker. Compose uses Redis shared slots for admission; Kubernetes uses EPP. Rollback restores the old gateway from
the private snapshot rather than from this checkout.

Apply `supabase/split/0004_cumulative_budget_cap.sql` with the selected research
owner before live work. It makes the cumulative US$1 budget operator-controlled;
runtime cannot raise or delete/recreate the global cap. Preserve existing ledger,
immutable migration baseline and unknown reservations. GPU qualification call
limits and provider-key budgets are **not** this monetary cap.

For a repeatable kind-only synthetic load run after the split ledger fills,
drain the kind API and workers, rename the old `ptr_split_test` database to a
distinct archive name, create an empty `ptr_split_test`, and run the existing
kind bootstrap Job before restoring the deployments. The archived database
retains all prior `unknown` reservations; never resubmit those requests. The
bootstrap rejects a nonempty target and re-applies the ordinary synthetic
US$1 cap. The kind-only `llm.billing.maxCallMicrousd: 5000` limits the
reservation exposure of a 200-turn V5 run to US$1.00 even if all receipts are
`unknown`; it does not change the production setting or ledger rules. Do not
use this procedure for the research or production database.

When paid spillover is enabled, the constrained worker-only OpenRouter key must
not be the first bottleneck during worker scale-out. Its provider-side rate and
credit limits must cover `autoscaling.worker.maxReplicaCount *
app.worker.concurrency`, plus operational headroom, while staying within the
approved maximum credit limit. The worker active-list scaler threshold derives
from `app.worker.concurrency`, so the active trigger tracks that same capacity
instead of a separate stale value.
The kind EPP queue TTL is two seconds. The V5 synthetic run slows the simulator
instead of widening the router TTL, so the flow-control timeout matches the
production contract.
For V5, apply `deploy/kind/k5-worker-values.yaml` after `values-kind.yaml` to
keep the two allowed synthetic engines warm, then restore the ordinary kind
values after the run so V6 can check engine scale-up from one. The kind API
allows ten minutes of synthetic queue wait; the production default remains one
minute. This avoids expiring unclaimed V5 turns while the 200-turn burst drains.

Kubernetes maintenance CronJobs use `concurrencyPolicy: Forbid` for scheduled
overlap only. Operators must not start a manual Job while a scheduled or manual
run is active, or start two manual runs together. Concurrent SQL apply runs are
still row-safe: native split retention and the legacy checkpoint and receipt
retention select candidates with `SKIP LOCKED`, then mutate those locked rows
in the same transaction. These retention steps remain valid Kubernetes CronJobs.

The weekly human-review steps are host/systemd-only in production.
`review-sample` writes private review sheets under the repo root, which is
read-only in the Kubernetes image, and `production-review` uses a lock and
journal that must live in a shared durable private directory. A Kubernetes
`emptyDir` would make that state per pod run. The production chart values
therefore disable `weekly-review-sample` and `weekly-production-review`; run
them only through the operator-owned host timers described in
`infra/split/maintenance`. Kind keeps those two CronJobs enabled only as
synthetic smoke tests, labelled `ptr.io/synthetic-smoke=true` and
`ptr.io/host-only-production-step=true`, with `/tmp` state and no private review
sheet output.

Redis classifies KEDA 2.21's `EVAL` with a declared key as write-capable even
when the script only calls `TYPE` and `LLEN`. The kind Redis ACL therefore uses
`%R~ptr:turns:*` for direct reads and a second queue-key selector for `EVAL`;
neither selector grants `SET` or another write command. Verify script-write
denial after changing KEDA or Redis versions.
For production `rediss` with a private CA, the worker scaler's Secret must
provide `REDIS_CA` and `REDIS_TLS_MODE=enable`. KEDA uses these together in
`TriggerAuthentication`; its `enableTLS` trigger field is reserved for the
system-CA path without a custom CA.

Apply `supabase/split/0005_generated_artifacts.sql` before deploying the new API;
draft requests fail without its table. No backfill of old `data/generated/*.json`
is needed because `loadArtifact` has no caller; leave those files in place.

When rolling out receipt labels that can report the `local-pool` upstream, roll
the API before workers that emit those receipts. This keeps the durable ACK schema
reader ahead of the worker receipt writer during mixed-version deployments.

## Bounded acceptance and recovery

`scripts/operational-smoke.ts` requires explicit private configuration and an
owned deployment manifest. Default mode performs only identity, readiness,
unauthenticated-access and native idle-counter checks: no catalogue/model calls.
The operational qualification artifact root is fixed in the harness; another
qualification must intentionally update/review that boundary rather than reuse
stale phase markers.

```sh
pnpm exec tsx scripts/operational-smoke.ts --env-file /private/e2e.env \
  --regenerate-manifest --project '<existing-compose-project>'
pnpm exec tsx scripts/operational-smoke.ts --env-file /private/e2e.env
# Explicit approved live qualification only:
pnpm exec tsx scripts/operational-smoke.ts --env-file /private/e2e.env \
  --execute --owner-nonce '<owned-nonce>'
```

Manifest regeneration writes the private file named by
`PTR_OPERATIONAL_DEPLOYMENT_MANIFEST` in the private env. For the gateway-less
stack it records `api`, `worker` and `web`; it must not require `model-gateway` or
`gatewayRetries`, and it does not make live model calls.

Live acceptance uses a synthetic API actor with an existing published persona,
RAG off, at most three distinct turn submissions, disabled retrieval tools and
one generation per attempt. Verify backend `PTR_MAX_ATTEMPTS<=3` and SDK
retries zero before live work: this bounds generation calls per turn to three,
within a 12-call qualification ceiling and 512 output tokens.
It verifies reply structure, owner isolation, idempotence, queued cancellation,
backend restart recovery, single assistant persistence, outbox drain and receipt
ACK. It stores only counts/state/private hashes, never persona IDs/labels/replies.
Native success counters corroborate successful generations; they do not prove an
atomic provider admission hard cap or unsupported error counters. Semantic
retrieval/Jev and human answer quality are separate acceptance stages.
Compose workers do not run Jev, OpenRouter embeddings or the direct `openrouter`
provider. Their local provider can use explicitly enabled paid spillover. Use the Kubernetes path for Jev and semantic acceptance.

## Direct-path redeploy procedure

This procedure changes only the Compose application stack. It does not touch
RunPod, vLLM itself or the SSH tunnel.

Save the following block and numbered commands as a private shell script, or
run them inside a subshell (`bash` in a separate terminal process). Do not paste
`set -euo pipefail` into the current interactive shell: an expected failed check
would close it. Use placeholders only until the operator fills them from the
private deployment record. Do not print private env files or expanded Compose
output.

```sh
PROJECT='<existing-compose-project>'
OWNER_NONCE='<existing-owner-nonce>'
OP_ENV='<private-operational-compose-env-file>'
NEW_COMPOSE=infra/split/compose.operational.yml
NEW_OP_ENV='<new-private-operational-compose-env-file>'
OLD_BACKEND_ENV='<old-backend-env-file>'
OLD_WEB_ENV='<old-web-env-file>'
OLD_WORKER_ENV='<old-worker-env-file>'
NEW_BACKEND_ENV='<new-private-backend-env-file>'
NEW_WEB_ENV='<new-private-web-env-file>'
NEW_WORKER_ENV='<new-private-worker-env-file>'
GATEWAY_ENV='<gateway-env-file>'
GATEWAY_DB_ENV='<gateway-database-env-file>'
GATEWAY_REDIS_ENV='<gateway-redis-env-file>'
GATEWAY_CONFIG='<gateway-config-file>'
SNAPSHOT='<private-snapshot-directory>'
OWNER_DB_ENV='<private-owner-maintenance-env-file>'
E2E_ENV='<private-e2e-env-file>'
APP_BASE='http://127.0.0.1:<api-port>'
WORKER_BASE='http://127.0.0.1:<worker-port>'
```

Before step 1, check the required host tools. Compose must be v5.0.0 or later
so the rollback snapshot can read service `env_file` paths from `config --no-env-resolution`.
This preflight reads no private configuration and stops before changing the stack.

```sh
(
  set -euo pipefail
  command -v python3 >/dev/null
  command -v docker >/dev/null
  command -v timeout >/dev/null
  COMPOSE_VERSION="$(timeout 10 docker compose version --short)"
  python3 - "${COMPOSE_VERSION}" <<'PY'
import re
import sys
match = re.fullmatch(r'v?(\d+)\.(\d+)\.(\d+)', sys.argv[1])
if match is None or tuple(map(int, match.groups())) < (5, 0, 0):
    raise SystemExit('Docker Compose v5.0.0 or later is required for rollback snapshots')
PY
  echo host_tools_ok
)
```

1. Preflight the existing project and owner. The redeploy must reuse the same
   Compose project name because Compose orphans are scoped only inside one
   project. A new project name would leave the old stack running on the host
   network, creating port collisions and two workers consuming one queue.

   ```sh
   docker ps -a \
     --filter "label=com.docker.compose.project=${PROJECT}" \
     --format '{{.ID}} {{.Names}} {{.Label "com.docker.compose.service"}} {{.Label "ptr.operational.owner"}}'
   docker ps -a \
     --filter "label=com.docker.compose.project=${PROJECT}" \
     --format '{{.ID}} {{.Names}} {{.Label "com.docker.compose.service"}} {{.Label "ptr.operational.owner"}}' \
     | awk -v expected="${OWNER_NONCE}" '$4 != expected {print; bad=1} END {exit bad}'
   ```

   The first command must show the expected old `api`, `web`, `worker` and
   `model-gateway*` services with the same owner label. The second command must
   print nothing and exit zero. If it prints a container or fails, stop: the
   project contains a different or missing owner label.

2. Create the rollback set before changing anything. Set `SNAPSHOT` to persistent
   host storage. Never use `/tmp` or a path beneath
   it: a reboot can remove the only rollback set. The live stack from the
   2026-10-11 cutover has a group whose working directory and bind mounts are
   under `/tmp`; a host reboot can wipe those sources. This redeploy moves the
   stack to the repository checkout.

   The snapshot helper reads Docker labels, bind mount paths, image references
   and running state. Use a new private snapshot path: older manifests lack the
   API and worker bind source records required in step 3. The helper uses
   each service's labeled working directory, Compose file paths and
   `com.docker.compose.project.environment_file` to group services. From each
   group's working directory, it runs
   `docker compose --env-file <group-env> -p <project> -f <group-file>... config --hash '<comma-separated-group-services>'`
   and compares the exact service/hash set with those containers'
   `com.docker.compose.config-hash` labels. A mismatch or dirty labeled git checkout
   in any group stops capture. The checkout HEAD
   alone is not evidence of what was deployed. The helper also refuses a missing
   service, unexpected service, owner mismatch, or a snapshot directory inside a
   captured source tree. It skips Docker named volumes and allowlisted data bind
   mounts, including `/app/data/generated`, which remain in place. Unknown bind
   mount targets stop capture until classified in the helper. It copies allowlisted
   config/code bind mounts, every group's labeled Compose files and env file,
   and file references from `env_file` and Compose `configs` discovered through
   captured `docker compose config --format json --no-env-resolution` output.
   It never prints that output or env values. It does not copy the working
   directory tree or generated `node_modules`, `.venv`, `__pycache__`, `.next`,
   `dist` or `build` directories. These sources go into
   `${SNAPSHOT}/root/<absolute-path-without-leading-slash>` with `0700`
   directories and `0600` files, writes a private
   manifest, including the data bind source paths (which are not copied),
   copies the restore helper into the snapshot, records each saved image ID
   with its container `Config.Image` reference, and saves the
   current images by immutable image ID. It also writes
   `rollback-images.yml` with dedicated snapshot tags; rollback tags each saved
   image ID with those tags before Compose starts. This also supports images
   whose original reference is a registry digest. It prints only
   key names, paths and counts; never env values.

   ```sh
   (
     set -euo pipefail
     umask 077
     python3 - "${SNAPSHOT}" <<'PY'
   import sys
   from pathlib import Path
   path = Path(sys.argv[1]).resolve()
   if path == Path('/tmp') or Path('/tmp') in path.parents:
       raise SystemExit('SNAPSHOT must be on persistent storage outside /tmp')
   PY
     python3 scripts/operational-snapshot.py capture \
       --project "${PROJECT}" \
       --owner "${OWNER_NONCE}" \
       --output "${SNAPSHOT}"
     python3 "${SNAPSHOT}/tools/operational-snapshot.py" restore \
       --snapshot "${SNAPSHOT}" --dry-run >/dev/null
     test -s "${SNAPSHOT}/manifest.json"
     test -s "${SNAPSHOT}/image-ids.txt"
     test -s "${SNAPSHOT}/rollback-images.yml"
     test -s "${SNAPSHOT}/images/operational-images.tar"
   )
   ```

   The rollback source paths are now the manifest, not the current checkout. The
   Compose file references capture the private role env/config files; the
   labeled env file and config mounts are captured as well. The helper restores
   these paths from the same manifest. The
   `compose_groups` entries record each group's services, working directory,
   Compose files, labeled env file and git state (`none` or `clean@<rev>`).
   The capture summary prints rollback order.
   Restore only the snapshot's config/code sources; data mounts stay untouched.

   The research DB, ledger, receipts and queue are not snapshotted or reset.
   This redeploy applies only `split/0005`; it does not backfill, erase or replay
   provider accounting.
   After the rollback window closes, an operator may manually delete old
   oversized snapshots from private storage. Keep the current snapshot until
   then; this procedure does not remove it.

3. Prepare the new private configuration from the snapshots before migration.
   Keep the old files untouched. The default helper removes LiteLLM/gateway and
   OpenRouter key names and adds the direct-local keys
   with empty fields for operator-supplied values. It creates `0600` files and
   prints key names only. Fill the empty fields with a private editor; do not
   display file contents. In `NEW_WORKER_ENV`, fill
   `PTR_LLM_LOCAL_BASE_URL`, `PTR_LLM_LOCAL_MODEL` and
   `PTR_LLM_LOCAL_API_KEY`; the helper sets `PTR_LLM_PROVIDER=local`,
   `PTR_LLM_LOCAL_AUTH_REQUIRED=1`, `PTR_LLM_SPILLOVER=off`,
   `PTR_LLM_EMBEDDING_PROVIDER=off`, `PTR_LLM_INTENT_CLASSIFIER=off` and
   `PTR_LLM_SAFETY_FILTER=off`. In `NEW_BACKEND_ENV`, fill `PTR_MODEL`
   with that same served model ID; `PTR_CHAT_PROVIDER=local` is set. In
   `NEW_OP_ENV`, fill the two new immutable image IDs and the exact three new
   role-env paths. Set `PTR_OPERATIONAL_DATA_DIR` to the parent of the API's
   live `/app/data/generated` bind source from the snapshot manifest using
   the `data-dir` command below. Do not copy or move `research/` or `generated/`.
   Preserve `PTR_OPERATIONAL_PROJECT`, `PTR_OPERATIONAL_OWNER`
   and `PTR_OPERATIONAL_PUBLISHED_PERSONAS_FILE` from the snapshot; verify the
   first two still match `PROJECT` and `OWNER_NONCE`. If any required old env
   file is absent under `${SNAPSHOT}/root`, stop: the snapshot is incomplete.

   ```sh
   (
     set -euo pipefail
     SNAPSHOT_OP_ENV="${SNAPSHOT}/root${OP_ENV}"
     SNAPSHOT_BACKEND_ENV="${SNAPSHOT}/root${OLD_BACKEND_ENV}"
     SNAPSHOT_WEB_ENV="${SNAPSHOT}/root${OLD_WEB_ENV}"
     SNAPSHOT_WORKER_ENV="${SNAPSHOT}/root${OLD_WORKER_ENV}"
     test -s "${SNAPSHOT_OP_ENV}"
     test -s "${SNAPSHOT_BACKEND_ENV}"
     test -s "${SNAPSHOT_WEB_ENV}"
     test -s "${SNAPSHOT_WORKER_ENV}"
     python3 scripts/operational-env-migrate.py prepare worker "${SNAPSHOT_WORKER_ENV}" "${NEW_WORKER_ENV}"
     python3 scripts/operational-env-migrate.py prepare backend "${SNAPSHOT_BACKEND_ENV}" "${NEW_BACKEND_ENV}"
     test ! -e "${NEW_WEB_ENV}"
     install -m 0600 "${SNAPSHOT_WEB_ENV}" "${NEW_WEB_ENV}"
     python3 scripts/operational-env-migrate.py prepare compose "${SNAPSHOT_OP_ENV}" "${NEW_OP_ENV}"
     timeout 10 python3 scripts/operational-snapshot.py data-dir --snapshot "${SNAPSHOT}"
   )
   ```

   Set `PTR_OPERATIONAL_DATA_DIR` in `NEW_OP_ENV` to the path printed by
   `data-dir`; the path itself is the only value this command prints. Then
   check the files and rendered bind sources:

   ```sh
   ${EDITOR:?select a private editor} "${NEW_WORKER_ENV}" "${NEW_BACKEND_ENV}" "${NEW_OP_ENV}"
   python3 scripts/operational-env-migrate.py check worker "${NEW_WORKER_ENV}"
   python3 scripts/operational-env-migrate.py check backend "${NEW_BACKEND_ENV}"
   python3 scripts/operational-env-migrate.py check compose "${NEW_OP_ENV}"
   timeout 15 docker compose --env-file "${NEW_OP_ENV}" -p "${PROJECT}" \
     -f infra/compose.app.yml -f "${NEW_COMPOSE}" config -q
   (
     set -euo pipefail
     timeout 15 docker compose --env-file "${NEW_OP_ENV}" -p "${PROJECT}" \
       -f infra/compose.app.yml -f "${NEW_COMPOSE}" \
       config --format json --no-env-resolution \
       | timeout 15 python3 scripts/operational-snapshot.py check-data-mounts \
           --snapshot "${SNAPSHOT}" --rendered-config -
   )
   ```

   These are the split deployment checks. `pnpm ops:check-env` validates the
   historical framework profile and is not part of the operational Compose
   startup path.

   To enable Compose spillover, prepare the worker using the helper's explicit
   spillover option and the snapshotted old gateway env as the dedicated-key
   source. Choose this command instead of the default `prepare worker` command
   above, before the new file exists. Set `SNAPSHOT_GATEWAY_ENV` to the captured
   gateway env path under `${SNAPSHOT}/root` from the manifest:

   ```sh
   python3 scripts/operational-env-migrate.py prepare worker \
     "${SNAPSHOT_WORKER_ENV}" "${NEW_WORKER_ENV}" \
     --spillover-openrouter --openrouter-source "${SNAPSHOT_GATEWAY_ENV}"
   ```

   Transfer only that approved research key by name without printing its
   value. Set `PTR_LLM_SPILLOVER=openrouter`, `PTR_LLM_LOCAL_SLOTS`, the wait
   threshold and worker concurrency as above. Set matching
   `PTR_LLM_LOCAL_SLOTS`, `PTR_LLM_SPILLOVER_WAIT_MS` and
   `PTR_LLM_CONCURRENCY` in `NEW_OP_ENV` when they differ from 8, 2000 and 10;
   the operational Compose override supplies those effective defaults. Set
   `PTR_PAID_SPILLOVER=1` in `NEW_BACKEND_ENV`. The explicit worker preparation
   command sets `PTR_LLM_LIVE_ENABLED=1` and `PTR_LLM_ALLOW_EXTERNAL_DATA=1`;
   `check worker` and `check compose` require both while spillover is on. Keep
   these gates enabled only for the approved research run. Check the worker,
   backend and Compose env files again
   after these edits. The helper must reject a missing/duplicate key, slots
   outside 1–256, waits outside 100–10000 ms, a paid key while spillover is off,
   and `PTR_LLM_SYNTHETIC_PROVIDER_FIXTURE=1` in operational configuration.
   Startup separately verifies the dedicated key lifetime limit ≤ US$1, prices
   and DeepInfra ZDR. Tests use synthetic fixtures only; never enable that flag
   against `ptr_split_research`.

   Check that the `NEW_OP_ENV` path entries point to these new private files.
   `config -q` and `data_mounts_match=true` must pass without printing expanded
   configuration. The comparison checks each API and worker bind by service,
   target and source against the live snapshot: API `generated` and worker
   published-personas only. Extra binds also fail. Do not proceed
   with blank fields, old image IDs or a mismatched project/owner.

4. Apply `split/0005` with the documented owner role first, then verify it. The
   owner URL must be `PTR_LLM_MAINTENANCE_DATABASE_URL` in a private file, and
   it must point to the `ptr_split_owner` role for `ptr_split_research`.

   The private owner file must be a Docker `--env-file` with a plain
   `PTR_LLM_MAINTENANCE_DATABASE_URL=...` entry. Its value is passed only to
   the container. Run the pinned PostgreSQL 17.6 client already used by this
   repository; the SQL mount is read-only. The client uses host networking to
   reach the verified loopback owner URL.

   ```sh
   (
     set -euo pipefail
     test -r "${OWNER_DB_ENV}"
     test -r supabase/split/0005_generated_artifacts.sql
     PG_IMAGE='postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94'
     timeout 45 docker run --rm --network host \
       --env-file "${OWNER_DB_ENV}" -e PGCONNECT_TIMEOUT=5 \
       --mount "type=bind,src=${PWD}/supabase/split/0005_generated_artifacts.sql,dst=/migration.sql,readonly" \
       --entrypoint sh "${PG_IMAGE}" -c \
       'exec psql --no-psqlrc "$PTR_LLM_MAINTENANCE_DATABASE_URL" -v ON_ERROR_STOP=1 -f /migration.sql'
     timeout 20 docker run --rm --network host \
       --env-file "${OWNER_DB_ENV}" -e PGCONNECT_TIMEOUT=5 \
       --entrypoint sh "${PG_IMAGE}" -c \
       'exec psql --no-psqlrc "$PTR_LLM_MAINTENANCE_DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc "SELECT current_database(), current_user, to_regclass('\''app.generated_artifacts'\'') IS NOT NULL, EXISTS (SELECT 1 FROM public.ptr_schema_migrations WHERE name='\''split/0005_generated_artifacts.sql'\'')"'
   )
   ```

   The last command must show `ptr_split_research`, `ptr_split_owner`, `t` and
   `t`. Do not run it with runtime app or LLM credentials.

5. Deploy the API only and wait for health and readiness.

   ```sh
   docker compose --env-file "${NEW_OP_ENV}" -p "${PROJECT}" \
     -f infra/compose.app.yml -f "${NEW_COMPOSE}" \
     up -d --no-deps --no-build api
   for attempt in $(seq 1 45); do
     if curl --fail --silent --max-time 2 --output /dev/null "${APP_BASE}/api/readyz"; then break; fi
     sleep 2
   done
   curl --fail --silent --show-error --max-time 10 --output /dev/null "${APP_BASE}/api/health"
   curl --fail --silent --show-error --max-time 10 --output /dev/null "${APP_BASE}/api/readyz"
   ```

6. Drain the old worker, then deploy worker and web. The worker stop uses the
   configured 90 second grace period so it stops accepting work before Compose
   replaces it. Take its exact container ID from the snapshot and recheck its
   project, service and owner labels immediately before stopping it.

   ```sh
   (
     set -euo pipefail
     OLD_WORKER_ID="$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); print(next(row["id"] for row in m["services"] if row["service"] == "worker"))' "${SNAPSHOT}/manifest.json")"
     test "$(docker inspect "${OLD_WORKER_ID}" --format \
       '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}} {{index .Config.Labels "ptr.operational.owner"}}')" \
       = "${PROJECT} worker ${OWNER_NONCE}"
     docker stop -t 90 "${OLD_WORKER_ID}" >/dev/null
     docker compose --env-file "${NEW_OP_ENV}" -p "${PROJECT}" \
       -f infra/compose.app.yml -f "${NEW_COMPOSE}" \
       up -d --no-deps --no-build worker web
   )
   for attempt in $(seq 1 45); do
     if curl --fail --silent --max-time 2 --output /dev/null "${WORKER_BASE}/health/ready"; then break; fi
     sleep 2
   done
   curl --fail --silent --show-error --max-time 10 --output /dev/null "${WORKER_BASE}/health/ready"
   env PTR_LLM_LOCAL_BASE_URL="http://127.0.0.1:<vLLM-tunnel-port>/v1" \
     PTR_OPS_API_METRICS_URL="${APP_BASE}/metrics/prom" \
     pnpm ops:status --window 5
   pnpm exec tsx scripts/operational-smoke.ts --env-file "${E2E_ENV}" \
     --regenerate-manifest --project "${PROJECT}"
   pnpm exec tsx scripts/operational-smoke.ts --env-file "${E2E_ENV}" \
     --execute --single-turn --owner-nonce "${OWNER_NONCE}"
   ```

   The smoke must be one synthetic RAG-off turn against local vLLM, with local
   chat cost `0`, no embedding rows and no paid provider rows. The one-turn
   mode does not pause or restart either service. `ops:status` checks the local
   model readiness. Check worker `/metrics` (not API `/metrics/prom`) for
   `ptr_llm_spillover_available`, and inspect the redacted startup event
   `OPENROUTER_SPILLOVER_ENABLED` including DeepInfra ZDR verification. A gauge
   of 1 means verified spillover and enough ledger balance for one maximum
   reservation; a gauge of 0 means unavailable and local waiting continues.
   It refreshes every 60 seconds and drops immediately on budget refusal.
   Inspect only the Redis `{queue_prefix}:llm:local-slots` ZSET's cardinality and
   expiry scores; ensure the smoke releases its lease. Deployment proof is this
   startup event, one local smoke and the slot state. Never saturate the GPU or
   make a real paid call deliberately for deployment verification.

7. Remove the old gateway orphans with the same project name. The same project
   name is required for `--remove-orphans` to see the old `model-gateway*`
   containers. This removes orphaned containers only; Compose named volumes for
   the old gateway database/Redis remain.

   ```sh
   docker compose --env-file "${NEW_OP_ENV}" -p "${PROJECT}" \
     -f infra/compose.app.yml -f "${NEW_COMPOSE}" \
     up -d --no-build --remove-orphans
   docker ps -a \
     --filter "label=com.docker.compose.project=${PROJECT}" \
     --format '{{.ID}} {{.Names}} {{.Label "com.docker.compose.service"}}' \
     | awk '$3 ~ /^model-gateway/ {print}'
   ```

   Keep the gateway volumes until rollback is no longer needed.

8. To disable spillover while keeping the current direct path, set
   `PTR_LLM_SPILLOVER=off`, remove the OpenRouter key from the private worker env,
   set worker `PTR_LLM_LIVE_ENABLED=0` and `PTR_LLM_ALLOW_EXTERNAL_DATA=0`,
   set backend `PTR_PAID_SPILLOVER=0`, check both env files and `config -q`, then
   drain/recreate only the owned worker (and recreate the API for its changed
   flag). A plain container restart does not reload an env file: use
   `up -d --no-deps --no-build --force-recreate worker api` after the owned
   worker drain. Verify readiness, gauge 0 and a local-only smoke. Preserve all
   ledger rows, unknown reservations and receipts.

   For a full rollback, roll back from the snapshot alone. Load the saved images, restore captured
   config/code bind-mounted sources, private env/config files, Compose files and working
   directory paths for every group to their original absolute locations with the
   helper copied into the snapshot, then bring each group's services back under
   the one saved project name.
   Compose reads the restored files at their original paths so its relative bind
   mounts resolve to the same host paths as before cutover. This step needs only
   the private `SNAPSHOT` path; it reads every group's working directory, files,
   env path and service list from the manifest, not the current checkout.
   The old gateway named volumes still exist because step 7 did not remove them.
   Ledger, receipts and queue are not reset.

   ```sh
   (
     set -euo pipefail
     docker image load -i "${SNAPSHOT}/images/operational-images.tar" >/dev/null
     python3 "${SNAPSHOT}/tools/operational-snapshot.py" tag-images \
       --snapshot "${SNAPSHOT}" >/dev/null
     python3 "${SNAPSHOT}/tools/operational-snapshot.py" restore \
       --snapshot "${SNAPSHOT}" --dry-run >/dev/null
     python3 "${SNAPSHOT}/tools/operational-snapshot.py" restore \
       --snapshot "${SNAPSHOT}" --apply >/dev/null
     python3 - "${SNAPSHOT}" <<'PY'
   import json
   import subprocess
   import sys
   from pathlib import Path

   snapshot = Path(sys.argv[1]).resolve()
   manifest = json.loads((snapshot / "manifest.json").read_text(encoding="utf-8"))
   project = manifest["project"]
   groups = manifest["compose_groups"]
   primary = {"api", "model-gateway-db", "model-gateway-redis"}
   first = [group for group in groups if primary <= set(group["services"])]
   assert len(first) == 1
   groups = first + sorted(
       (group for group in groups if group is not first[0]),
       key=lambda group: (group["working_dir"], group["services"]),
   )
   override = snapshot / "rollback-images.yml"
   assert override.is_file()
   wait_flags = ["--wait"] if "--wait" in subprocess.run(
       ["docker", "compose", "up", "--help"], check=True, text=True,
       capture_output=True, timeout=30,
   ).stdout else []
   for group in groups:
       workdir = Path(group["working_dir"])
       env_file = Path(group["compose_env_file"])
       files = [Path(path) for path in group["compose_config_files"]]
       services = group["services"]
       assert workdir.is_dir() and env_file.is_file() and files and services
       assert all(path.is_file() for path in files)
       command = [
           "docker", "compose", "--env-file", str(env_file), "-p", project,
           "--project-directory", str(workdir),
       ]
       for path in files:
           command.extend(["-f", str(path)])
       command.extend(["-f", str(override)])
       subprocess.run([*command, "config", "-q"], cwd=workdir, check=True, timeout=120)
       subprocess.run(
           [*command, "up", "-d", *wait_flags, "--no-deps", "--no-build", *services],
           cwd=workdir, check=True, timeout=300,
       )
   PY
   )
   ```

   The group with `model-gateway-db`, `model-gateway-redis` and `api` starts first;
   the other group follows. Compose waits for health where `--wait` is supported.
   Each `up` uses the same `-p <project>`, that group's restored files and env
   path, and the saved rollback image tags. `--no-deps` limits it to the group's
   listed services; do not remove orphans while the other groups share that project.

9. Only after the rollback window closes without a rollback, remove the old
   gateway named volumes by their exact names. Never use `down -v` here.

   ```sh
   docker volume rm "${PROJECT}_model_gateway_postgres" "${PROJECT}_model_gateway_redis"
   ```

The parent operator handles acceptance recovery phases only after checking exact
container ID, owner label, Compose service/project and immutable image. Stop and
drain the owned worker, keep the backend alive, restart only the owned backend,
then resume the same worker. Acknowledge each phase atomically in a `0600`
metadata file with the exact fresh request nonce. Never use pattern
process/container kills.
The override allows 90 seconds for worker shutdown and uses native dependency
ordering. Preserve failed proofs before another explicitly bounded qualification.

Rollback changes images/configuration, not post-cutover databases, queues, provider
ledger or receipts. Never restore an old snapshot over completed work. Public
ingress/TLS, historical hard-erasure and human quality decisions are not established
by operational acceptance; private central review export stays disabled unless
separately authorized.
