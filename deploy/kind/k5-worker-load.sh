#!/usr/bin/env bash
set -euo pipefail

context="${KUBE_CONTEXT:-kind-ptr-k8s}"
if [[ "$context" != "kind-ptr-k8s" ]]; then
  echo "Refusing to run outside kind-ptr-k8s" >&2
  exit 1
fi

app_namespace="${PTR_APP_NAMESPACE:-ptr-app}"
api_label="${PTR_API_LABEL:-app.kubernetes.io/component=api}"
worker_deployment="${PTR_WORKER_DEPLOYMENT:-ptr-worker}"
engine_namespace="ptr-inference"
engine_deployment="ptr-sim"
turn_count="${TURN_COUNT:-200}"
submit_concurrency="${SUBMIT_CONCURRENCY:-80}"
poll_ms="${POLL_MS:-1000}"
timeout_seconds="${TIMEOUT_SECONDS:-900}"
scale_down_wait_seconds="${SCALE_DOWN_WAIT_SECONDS:-900}"
prefix="${K5_PREFIX:-k5-load-$(date +%s)}"
host_python="$(if command -v python3 >/dev/null 2>&1; then command -v python3; else command -v python; fi)"

engine_min="$(timeout 20s kubectl --context "$context" -n "$engine_namespace" get scaledobject "$engine_deployment" -o jsonpath='{.spec.minReplicaCount}')"
engine_ready="$(timeout 20s kubectl --context "$context" -n "$engine_namespace" get deployment "$engine_deployment" -o jsonpath='{.status.readyReplicas}')"
if [[ "$engine_min" != "2" || "${engine_ready:-0}" -lt 2 ]]; then
  echo "engine ScaledObject must be pinned to two replicas for V5" >&2
  exit 1
fi

pod_name() {
  local namespace="$1"
  local label="$2"
  timeout 20s kubectl --context "$context" -n "$namespace" get pod -l "$label" \
    -o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' \
    | awk '{print $1}'
}

api_pod="$(pod_name "$app_namespace" "$api_label")"
if [[ -z "$api_pod" ]]; then
  echo "missing running api pod" >&2
  exit 1
fi

work_dir="$(mktemp -d)"
node_out="$work_dir/node.out"
node_err="$work_dir/node.err"
replicas_jsonl="$work_dir/worker-replicas.jsonl"
started_epoch="$(date +%s)"

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT

sample_worker_replicas() {
  local elapsed
  local sample
  local desired
  local replicas
  local ready
  local available
  elapsed="$(($(date +%s) - started_epoch))"
  sample="$(
    timeout 20s kubectl --context "$context" -n "$app_namespace" get "deployment/$worker_deployment" -o jsonpath='{.spec.replicas}{" "}{.status.replicas}{" "}{.status.readyReplicas}{" "}{.status.availableReplicas}' 2>/dev/null || true
  )"
  if [[ -z "$sample" ]]; then
    return 1
  fi
  read -r desired replicas ready available <<<"$sample"
  "$host_python" - "$elapsed" "${desired:-0}" "${replicas:-0}" "${ready:-0}" "${available:-0}" >>"$replicas_jsonl" <<'PY'
import json
import sys
elapsed, desired, replicas, ready, available = sys.argv[1:]
def number(value):
    try:
        return int(value)
    except ValueError:
        return 0
print(json.dumps({
    "elapsedSeconds": int(elapsed),
    "desired": number(desired),
    "replicas": number(replicas),
    "ready": number(ready),
    "available": number(available),
}))
PY
  printf '%s\n' "${desired:-0}"
}

run_node_probe() {
  timeout "${timeout_seconds}s" kubectl --context "$context" -n "$app_namespace" exec -i "$api_pod" -- \
    env \
      K5_PREFIX="$prefix" \
      TURN_COUNT="$turn_count" \
      SUBMIT_CONCURRENCY="$submit_concurrency" \
      POLL_MS="$poll_ms" \
      node --input-type=module - <<'NODE'
import net from 'node:net';
import pg from 'pg';

const { Client } = pg;

const terminalStates = new Set(['completed', 'failed', 'cancelled']);
const prefix = process.env.K5_PREFIX;
const turnCount = Number(process.env.TURN_COUNT || '200');
const submitConcurrency = Number(process.env.SUBMIT_CONCURRENCY || '80');
const pollMs = Number(process.env.POLL_MS || '1000');
const owner = 'lt-k5-synthetic';
const started = Date.now();

function elapsedSeconds() {
  return Number(((Date.now() - started) / 1000).toFixed(3));
}

function event(name, body = {}) {
  console.log(JSON.stringify({ event: name, elapsedSeconds: elapsedSeconds(), ...body }));
}

function assertSafeConfig() {
  if (!prefix || !/^[A-Za-z0-9_-]+$/.test(prefix)) throw new Error('INVALID_PREFIX');
  if (!Number.isInteger(turnCount) || turnCount < 1 || turnCount > 1000) throw new Error('INVALID_TURN_COUNT');
  if (!Number.isInteger(submitConcurrency) || submitConcurrency < 1 || submitConcurrency > 200) throw new Error('INVALID_SUBMIT_CONCURRENCY');
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 10000) throw new Error('INVALID_POLL_MS');
}

async function request(path, body) {
  const response = await fetch(`http://127.0.0.1:56441/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${process.env.PTR_API_SYNTHETIC_TOKEN}`,
      'X-PTR-Owner': owner,
      'Content-Type': 'application/json',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  return response.json();
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function submitTurn(index) {
  const session = await request('sessions', {
    personId: 'synthetic-split-person',
    retrievalMode: 'off',
    ragCondition: 'off',
    executionProfile: 'agent_loop',
  });
  const clientRequestId = `${prefix}-${String(index).padStart(4, '0')}`;
  const turn = await request(`sessions/${session.session.id}/turns`, {
    clientRequestId,
    text: JSON.stringify({
      message: `K4_ID:${clientRequestId}`,
      status: 'answered',
      evidenceRefs: [],
      variableUpdates: {},
    }),
  });
  return turn.turn.id;
}

function encodeRedisCommand(args) {
  return `*${args.length}\r\n${args.map(arg => {
    const value = String(arg);
    return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }).join('')}`;
}

function parseRedisResponse(buffer, offset = 0) {
  const type = buffer[offset];
  const lineEnd = buffer.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;
  const line = buffer.slice(offset + 1, lineEnd).toString('utf8');
  if (type === 43) return { value: line, offset: lineEnd + 2 };
  if (type === 58) return { value: Number(line), offset: lineEnd + 2 };
  if (type === 45) throw new Error('REDIS_ERROR');
  if (type === 36) {
    const length = Number(line);
    if (length < 0) return { value: null, offset: lineEnd + 2 };
    const start = lineEnd + 2;
    const end = start + length;
    if (buffer.length < end + 2) return null;
    return { value: buffer.slice(start, end).toString('utf8'), offset: end + 2 };
  }
  throw new Error('REDIS_UNSUPPORTED_RESPONSE');
}

async function redisCommand(args) {
  const redisUrl = new URL(process.env.PTR_REDIS_URL);
  const commands = [];
  if (redisUrl.password) {
    const username = decodeURIComponent(redisUrl.username || 'default');
    const password = decodeURIComponent(redisUrl.password);
    commands.push(['AUTH', username, password]);
  }
  commands.push(args);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: redisUrl.hostname,
      port: Number(redisUrl.port || '6379'),
    });
    let buffer = Buffer.alloc(0);
    let expected = commands.length;
    let lastValue;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('REDIS_TIMEOUT'));
    }, 5000);
    socket.on('connect', () => {
      socket.write(commands.map(encodeRedisCommand).join(''));
    });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        while (expected > 0) {
          const parsed = parseRedisResponse(buffer);
          if (!parsed) return;
          lastValue = parsed.value;
          buffer = buffer.slice(parsed.offset);
          expected -= 1;
        }
        clearTimeout(timer);
        socket.end();
        resolve(lastValue);
      } catch (error) {
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      }
    });
    socket.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function sampleQueues() {
  const [wait, active] = await Promise.all([
    redisCommand(['LLEN', 'ptr:turns:wait']).catch(() => null),
    redisCommand(['LLEN', 'ptr:turns:active']).catch(() => null),
  ]);
  event('queue_sample', { wait, active });
  return { wait, active };
}

async function states(client, turnIds) {
  const result = await client.query(
    `SELECT state, count(*)::int AS n
       FROM app.turns
      WHERE id = ANY($1::text[])
      GROUP BY state
      ORDER BY state`,
    [turnIds],
  );
  const counts = Object.fromEntries(result.rows.map(row => [row.state, row.n]));
  const terminal = Object.entries(counts)
    .filter(([state]) => terminalStates.has(state))
    .reduce((sum, [, n]) => sum + n, 0);
  return { counts, terminal };
}

async function proof(client, turnIds) {
  const result = await client.query(
    `WITH target AS (
       SELECT id, state, error_code
         FROM app.turns
        WHERE id = ANY($1::text[])
     ), assistant_counts AS (
       SELECT t.id, count(m.*)::int AS n
         FROM target t
         LEFT JOIN app.messages m ON m.turn_id = t.id AND m.role = 'assistant'
        GROUP BY t.id
     ), grant_counts AS (
       SELECT t.id, count(g.*)::int AS n
         FROM target t
         LEFT JOIN app.turn_execution_grants g ON g.turn_id = t.id AND g.result_hash IS NOT NULL
        GROUP BY t.id
     )
     SELECT
       count(*)::int AS observed,
       (count(*) FILTER (WHERE t.state IN ('completed','failed','cancelled')))::int AS terminal,
       (count(*) FILTER (WHERE t.state = 'completed'))::int AS completed,
       (count(*) FILTER (WHERE t.state = 'failed'))::int AS failed,
       (count(*) FILTER (WHERE t.state = 'cancelled'))::int AS cancelled,
       COALESCE((SELECT count(*)::int FROM app.turn_outbox o WHERE o.turn_id = ANY($1::text[])), 0)::int AS outbox,
       (count(*) FILTER (WHERE t.state = 'completed' AND a.n <> 1))::int AS assistant_not_exactly_once,
       (count(*) FILTER (WHERE t.state = 'completed' AND g.n <> 1))::int AS grants_not_exactly_once,
       (count(*) FILTER (WHERE t.state = 'completed' AND (a.n > 1 OR g.n > 1)))::int AS duplicate_completion_rows,
       jsonb_object_agg(COALESCE(t.error_code, 'none'), c.n) FILTER (WHERE c.n IS NOT NULL) AS error_codes
      FROM target t
      JOIN assistant_counts a ON a.id = t.id
      JOIN grant_counts g ON g.id = t.id
      LEFT JOIN (
        SELECT COALESCE(error_code, 'none') AS code, count(*)::int AS n
          FROM target
         GROUP BY COALESCE(error_code, 'none')
      ) c ON c.code = COALESCE(t.error_code, 'none')`,
    [turnIds],
  );
  return result.rows[0];
}

async function main() {
  assertSafeConfig();
  event('start', { prefix, turnCount, submitConcurrency });
  await sampleQueues();
  const turnIds = await mapLimit(Array.from({ length: turnCount }, (_, index) => index), submitConcurrency, submitTurn);
  event('submitted', { submitted: turnIds.length });

  const client = new Client({ connectionString: process.env.PTR_APP_DATABASE_URL });
  await client.connect();
  try {
    const deadline = Date.now() + 840000;
    let current = { counts: {}, terminal: 0 };
    while (Date.now() < deadline) {
      current = await states(client, turnIds);
      await sampleQueues();
      event('state_sample', { terminal: current.terminal, states: current.counts });
      if (current.terminal === turnIds.length) break;
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
    const final = await proof(client, turnIds);
    const passed = final.observed === turnIds.length
      && final.terminal === turnIds.length
      && final.completed > turnIds.length / 2
      && Number(final.error_codes?.PROVIDER_BUDGET_EXCEEDED ?? 0) === 0
      && final.outbox === 0
      && final.duplicate_completion_rows === 0
      && final.assistant_not_exactly_once === 0
      && final.grants_not_exactly_once === 0;
    event('result', {
      passed,
      prefix,
      expected: turnIds.length,
      observed: final.observed,
      terminal: final.terminal,
      completed: final.completed,
      failed: final.failed,
      cancelled: final.cancelled,
      outbox: final.outbox,
      assistantNotExactlyOnce: final.assistant_not_exactly_once,
      grantsNotExactlyOnce: final.grants_not_exactly_once,
      duplicateCompletionRows: final.duplicate_completion_rows,
      errorCodes: final.error_codes || {},
    });
    if (!passed) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch(error => {
  const code = /^[A-Z0-9_]+$/.test(error?.message || '') ? error.message : error?.name || 'K5_WORKER_LOAD_FAILED';
  console.error(JSON.stringify({ event: 'error', elapsedSeconds: elapsedSeconds(), code }));
  process.exitCode = 1;
});
NODE
}

run_node_probe >"$node_out" 2>"$node_err" &
probe_pid="$!"

while ps -p "$probe_pid" >/dev/null 2>&1; do
  sample_worker_replicas >/dev/null || true
  sleep 2
done

set +e
wait "$probe_pid"
probe_status="$?"
set -e

scale_down_deadline="$(($(date +%s) + scale_down_wait_seconds))"
while [[ "$(date +%s)" -lt "$scale_down_deadline" ]]; do
  desired="$(sample_worker_replicas || true)"
  if [[ "${desired:-0}" =~ ^[0-9]+$ ]] && [[ "$desired" -le 2 ]]; then
    break
  fi
  sleep 5
done

cat "$node_out"
if [[ -s "$node_err" ]]; then
  sed 's/^/stderr /' "$node_err" >&2
fi

"$host_python" - "$replicas_jsonl" "$node_out" "$probe_status" <<'PY'
import json
import sys
from pathlib import Path

replicas_path = Path(sys.argv[1])
node_path = Path(sys.argv[2])
probe_status = int(sys.argv[3])

replicas = [json.loads(line) for line in replicas_path.read_text().splitlines() if line.strip()] if replicas_path.exists() else []
events = [json.loads(line) for line in node_path.read_text().splitlines() if line.strip()]
submitted = next((event for event in events if event.get("event") == "submitted"), None)
result = next((event for event in events if event.get("event") == "result"), None)
queue_samples = [event for event in events if event.get("event") == "queue_sample"]

submitted_at = submitted.get("elapsedSeconds") if submitted else None
scale_deadline = submitted_at + 60 if isinstance(submitted_at, (int, float)) else 60
within_60 = [row for row in replicas if row["elapsedSeconds"] <= scale_deadline]
active_samples = [row for row in queue_samples if isinstance(row.get("active"), int) and row["active"] > 0]
active_max = max((row["active"] for row in active_samples), default=0)
wait_max = max((row.get("wait") for row in queue_samples if isinstance(row.get("wait"), int)), default=0)
active_first = min((row["elapsedSeconds"] for row in active_samples), default=None)
active_last = max((row["elapsedSeconds"] for row in active_samples), default=None)
desired_start = replicas[0]["desired"] if replicas else None
ready_start = replicas[0]["ready"] if replicas else None
desired_peak_60 = max((row["desired"] for row in within_60), default=0)
ready_peak_60 = max((row["ready"] for row in within_60), default=0)
desired_final = replicas[-1]["desired"] if replicas else None
ready_final = replicas[-1]["ready"] if replicas else None
while_active = [
    row for row in replicas
    if active_first is not None and active_last is not None and active_first <= row["elapsedSeconds"] <= active_last
]
desired_min_while_active = min((row["desired"] for row in while_active), default=None)
downsteps_while_active = sum(
    current["desired"] < previous["desired"]
    for previous, current in zip(while_active, while_active[1:])
)
scale_up_passed = desired_start == 2 and ready_start == 2 and desired_peak_60 >= 6 and ready_peak_60 >= 6
active_hold_passed = bool(active_samples) and downsteps_while_active == 0
scale_down_passed = desired_final == 2 and ready_final == 2

summary = {
    "event": "host_summary",
    "probeExitCode": probe_status,
    "replicaSamples": len(replicas),
    "desiredStart": desired_start,
    "readyStart": ready_start,
    "desiredPeakWithin60sAfterSubmit": desired_peak_60,
    "readyPeakWithin60sAfterSubmit": ready_peak_60,
    "desiredFinal": desired_final,
    "readyFinal": ready_final,
    "scaleDownToMinObserved": desired_final is not None and desired_final <= 2,
    "waitListMax": wait_max,
    "activeListMax": active_max,
    "desiredMinWhileActiveApprox": desired_min_while_active,
    "desiredDownstepsWhileActiveApprox": downsteps_while_active,
    "scaleUpWithin60sPassed": scale_up_passed,
    "activeHoldPassed": active_hold_passed,
    "scaleDownPassed": scale_down_passed,
    "terminalProofPassed": bool(result and result.get("passed")),
}
print(json.dumps(summary))

if (probe_status != 0 or not result or not result.get("passed")
        or not scale_up_passed or not active_hold_passed or not scale_down_passed):
    raise SystemExit(1)
PY
