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
ACKs and readiness after each role rollout.

## Configuration and supervision

Reuse the existing owned Compose project name and owner nonce, immutable verified
backend and worker image IDs, separate private environment files and loopback ports in a `0600`
operator Compose environment. Keep its directory `0700`. Do not print resolved
Compose configuration: it can contain secrets. Validate with `config -q`.
In the worker-only env file set `PTR_LLM_PROVIDER=local`,
`PTR_LLM_LOCAL_BASE_URL=http://127.0.0.1:<vLLM tunnel port>/v1`,
`PTR_LLM_LOCAL_MODEL=<served model ID>`, `PTR_LLM_LOCAL_API_KEY=<vLLM key>` and
`PTR_LLM_LOCAL_AUTH_REQUIRED=1` and `PTR_LLM_SPILLOVER=off`. The base URL is the
authenticated loopback SSH-tunnel endpoint that the old gateway used for vLLM.
Keep both OpenRouter key names out of the worker env. Compose has no central EPP
admission signal, so excess work waits in local vLLM instead of spilling into
paid calls. Set the backend's `PTR_CHAT_PROVIDER=local` and `PTR_MODEL` to the
same served model ID. Leave the legacy `PTR_LITELLM_BILLABLE` API switch unset
(or `0`): local chat costs zero and drafts require `clientRequestId` only when
billable.

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
provisioned. All roles restart `unless-stopped`. The `infra/litellm` routing
code and checks are retained only as rollback material until L4 deletes them;
they are no longer part of operational CI for this direct path.

Run the existing GPU engine through an authenticated private endpoint. When native
remote process supervision is unavailable, an operator-owned user-systemd unit can
supervise foreground SSH plus its loopback forward. Keep its environment, key,
script and cached model location durable, with native restart/backoff. Do not add a
TTL to a persistent service. Enable user linger only when persistent execution is
authorized. Native supervision is not proof of host reboot, instance recreation,
network availability or multi-engine performance.

Apply `supabase/split/0004_cumulative_budget_cap.sql` with the selected research
owner before live work. It makes the cumulative US$1 budget operator-controlled;
runtime cannot raise or delete/recreate the global cap. Preserve existing ledger,
immutable migration baseline and unknown reservations. GPU qualification call
limits and gateway-key budgets are **not** this monetary cap.

For a repeatable kind-only synthetic load run after the split ledger fills,
drain the kind API and workers, rename the old `ptr_split_test` database to a
distinct archive name, create an empty `ptr_split_test`, and run the existing
kind bootstrap Job before restoring the deployments. The archived database
retains all prior `unknown` reservations; never resubmit those requests. The
bootstrap rejects a nonempty target and re-applies the ordinary synthetic
US$1 cap. The kind-only `gateway.billing.maxCallMicrousd: 5000` limits the
reservation exposure of a 200-turn V5 run to US$1.00 even if all receipts are
`unknown`; it does not change the production setting or ledger rules. Do not
use this procedure for the research or production database.

The constrained LiteLLM application key must not be the first bottleneck during
worker scale-out. Set `gateway.bootstrap.rpm` to at least
`autoscaling.worker.maxReplicaCount * app.worker.concurrency`, plus operational
headroom. The production floor is `40 * 4 * 1.25 = 200 rpm`; the configured
`5000 rpm` also accommodates repeated short turns. The kind profile uses
`1000 rpm` and four in-flight turns per worker. The worker active-list scaler
threshold derives from `app.worker.concurrency`, so the active trigger tracks
that same capacity instead of a separate stale value.
The kind EPP queue TTL is 30 seconds because the simulator's first token takes
eight seconds; the queue size remains eight. Production retains its two-second
flow-control TTL.
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

When rolling out gateway receipts that can report the `local-pool` upstream, roll
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
Compose workers no longer run Jev, OpenRouter embeddings or the `openrouter`
provider (design §3.3). Use the Kubernetes path for Jev and semantic acceptance.

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

2. Create the rollback set before changing anything. The snapshot helper reads
   Docker labels, bind mount paths, image references and running state. It uses
   the labeled `com.docker.compose.project.environment_file` and Compose file
   paths to run `docker compose config --hash '*'`, then compares every service
   hash with its running container's `com.docker.compose.config-hash` label.
   A mismatch or dirty labeled git checkout stops capture. The checkout HEAD
   alone is not evidence of what was deployed. The helper also refuses a missing
   service, unexpected service, owner mismatch, or a snapshot directory inside a
   captured source tree. It skips Docker named volumes and allowlisted data bind
   mounts, including `/app/data/generated`, which remain in place. Unknown bind
   mount targets stop capture until classified in the helper. It copies allowlisted
   config/code bind mounts, every file from the
   `com.docker.compose.project.config_files` label, and the labeled
   `com.docker.compose.project.working_dir` tree except `data/` into
   `${SNAPSHOT}/root/<absolute-path-without-leading-slash>` with `0700`
   directories and `0600` files, writes a private
   manifest, copies the restore helper into the snapshot, records each saved
   image ID with its container `Config.Image` reference, and saves the
   current images by immutable image ID. It also writes
   `rollback-images.yml` with dedicated snapshot tags; rollback tags each saved
   image ID with those tags before Compose starts. This also supports images
   whose original reference is a registry digest. It prints only
   key names, paths and counts; never env values.

   ```sh
   (
     set -euo pipefail
     umask 077
     python3 scripts/operational-snapshot.py capture \
       --project "${PROJECT}" \
       --owner "${OWNER_NONCE}" \
       --extra-path "${OP_ENV}" \
       --extra-path "${OLD_BACKEND_ENV}" \
       --extra-path "${OLD_WEB_ENV}" \
       --extra-path "${OLD_WORKER_ENV}" \
       --extra-path "${GATEWAY_ENV}" \
       --extra-path "${GATEWAY_DB_ENV}" \
       --extra-path "${GATEWAY_REDIS_ENV}" \
       --extra-path "${GATEWAY_CONFIG}" \
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
   explicit extra paths capture the private Compose and role env files, which
   Docker does not necessarily expose as bind mounts. Each input path must be
   absolute. The helper restores these paths from the same manifest.
   The manifest records the labeled Compose env file separately from extra paths.
   Restore only the snapshot's config/code sources; data mounts stay untouched.

   The research DB, ledger, receipts and queue are not snapshotted or reset.
   This redeploy applies only `split/0005`; it does not backfill, erase or replay
   provider accounting.

3. Prepare the new private configuration from the snapshots before migration.
   Keep the old files untouched. The helper copies existing keys, removes the
   LiteLLM/gateway and both OpenRouter key names, and adds the direct-local keys
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
   role-env paths. Preserve `PTR_OPERATIONAL_PROJECT`, `PTR_OPERATIONAL_OWNER`
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
   )
   ${EDITOR:?select a private editor} "${NEW_WORKER_ENV}" "${NEW_BACKEND_ENV}" "${NEW_OP_ENV}"
   python3 scripts/operational-env-migrate.py check worker "${NEW_WORKER_ENV}"
   python3 scripts/operational-env-migrate.py check backend "${NEW_BACKEND_ENV}"
   python3 scripts/operational-env-migrate.py check compose "${NEW_OP_ENV}"
   docker compose --env-file "${NEW_OP_ENV}" -p "${PROJECT}" \
     -f infra/compose.app.yml -f "${NEW_COMPOSE}" config -q
   ```

   Check that the `NEW_OP_ENV` path entries point to these new private files.
   `config -q` must pass without printing expanded configuration. Do not proceed
   with blank fields, old image IDs or a mismatched project/owner.

4. Apply `split/0005` with the documented owner role first, then verify it. The
   owner URL must be `PTR_LLM_MAINTENANCE_DATABASE_URL` in a private file, and
   it must point to the `ptr_split_owner` role for `ptr_split_research`.

   ```sh
   set -a
   . "${OWNER_DB_ENV}"
   set +a
   OWNER_DATABASE_URL="${PTR_LLM_MAINTENANCE_DATABASE_URL:?}"
   PGCONNECT_TIMEOUT=5 timeout 30 psql "${OWNER_DATABASE_URL}" -v ON_ERROR_STOP=1 \
     --file supabase/split/0005_generated_artifacts.sql
   PGCONNECT_TIMEOUT=5 timeout 10 psql "${OWNER_DATABASE_URL}" -v ON_ERROR_STOP=1 -Atqc \
     "SELECT current_database(), current_user, to_regclass('app.generated_artifacts') IS NOT NULL, EXISTS (SELECT 1 FROM public.ptr_schema_migrations WHERE name='split/0005_generated_artifacts.sql')"
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
   model readiness; the Python worker has no `/metrics/prom` endpoint, so use
   its `/health/ready` check and the completed smoke turn for worker proof.

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

8. Roll back from the snapshot alone. Load the saved images, restore captured
   config/code bind-mounted sources, private env/config files, Compose files and working
   directory paths to their original absolute locations with the helper copied
   into the snapshot, then bring the old stack back under the same project name.
   Compose reads the restored files at their original paths so its relative bind
   mounts resolve to the same host paths as before cutover. This step needs only
   the private `SNAPSHOT` path; it reads the old project and Compose env path
   from the manifest, not the current checkout.
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
     OLD_PROJECT="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["project"])' "${SNAPSHOT}/manifest.json")"
     OLD_OP_ENV="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["compose_env_file"])' "${SNAPSHOT}/manifest.json")"
     OLD_WORKDIR="$(python3 -c 'import json,sys; m=json.load(open(sys.argv[1])); assert len(m["working_dirs"]) == 1; print(m["working_dirs"][0])' "${SNAPSHOT}/manifest.json")"
     mapfile -d '' -t OLD_CONFIGS < <(python3 -c 'import json,os,sys; m=json.load(open(sys.argv[1])); [sys.stdout.buffer.write(os.fsencode(p)+b"\0") for p in m["compose_config_files"]]' "${SNAPSHOT}/manifest.json")
     test "${#OLD_CONFIGS[@]}" -ge 2
     OLD_FLAGS=()
     for file in "${OLD_CONFIGS[@]}"; do
       test -s "${file}"
       OLD_FLAGS+=(-f "${file}")
     done
     OLD_FLAGS+=(-f "${SNAPSHOT}/rollback-images.yml")
     docker compose --env-file "${OLD_OP_ENV}" -p "${OLD_PROJECT}" \
       --project-directory "${OLD_WORKDIR}" "${OLD_FLAGS[@]}" config -q
     docker compose --env-file "${OLD_OP_ENV}" -p "${OLD_PROJECT}" \
       --project-directory "${OLD_WORKDIR}" "${OLD_FLAGS[@]}" \
       up -d --no-build --remove-orphans
   )
   ```

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
