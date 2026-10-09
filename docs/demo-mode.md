# Demo mode: scaling features behind `PTR_DEMO_SCALING=1`

The production profile ([configuration.md](configuration.md)) is one process per role: a static upstreams
file, `least_inflight` routing, credit admission (FIFO with priority bands), a breaker per engine with a 10 s headers
wait, optional OpenRouter failover and drain. The scaling features measured in goal2 stay in the code and in the tests,
but a role refuses to start with any of their settings unless `PTR_DEMO_SCALING=1` is set. With the switch on, the
demo-layer keys (class D in `packages/ops/src/env-registry.ts`) are accepted and the production value rules are
skipped; each setting is still checked by its own parser. The load and acceptance harnesses (`scripts/loadtest.ts`,
`scripts/gateway-ha-acceptance.ts`) set the switch for the processes they start.

| Feature | Production (default) | Demo (`PTR_DEMO_SCALING=1`) |
| --- | --- | --- |
| Routing `scored`, `round_robin` | `least_inflight` | selectable (`PTR_GATEWAY_ROUTING`) |
| Cache affinity | off | `PTR_GATEWAY_AFFINITY=on` |
| DRR fairness / early `saturated` refusal | FIFO + bands / off | `PTR_GATEWAY_FAIRNESS=drr`, `PTR_GATEWAY_REJECT_SATURATED=true` |
| Prefix table | the global policy block G only (credit); member tables recorded | TTL and affinity settings |
| Engine telemetry filter | off | `PTR_GATEWAY_METRICS_INTERVAL_MS` |
| Upstream registry, `scripts/upstream-agent.ts`, capacity controller | static file + SIGHUP | `PTR_GATEWAY_DISCOVERY=redis`, `PTR_CAPACITY_*` |
| Gateway registry, several gateways | one gateway (drain kept) | `PTR_GATEWAY_REGISTRY`, `PTR_GATEWAY_URLS` |
| H2 per-replica credit split | no code | text only (below) |
| Env-only single-engine gateway | not used (one engine is a one-line file) | `PTR_GATEWAY_UPSTREAM=selfhosted` + `PTR_SELFHOSTED_*` (load tests, acceptance) |
| Several workers | one | `PTR_WORKER_REPLICAS_HINT`, `PTR_METRICS_PORT` |
| Chat providers `fake`, `selfhosted` | `gateway` or `openrouter` | allowed |
| Harness API token (`PTR_API_SYNTHETIC_TOKEN`) | none: the API takes only the web's `local-<40 hex>` owners | a second Bearer token for synthetic owners only (`lt-*`, `owner_synthetic_*`); see [runbook.md](runbook.md#authentication-and-owner-spaces) |

Numeric knobs (leases, dispatch intervals, queue limits, breaker thresholds, timeouts) are constants in production and
can be changed only here. The sections below were moved from [goal2-serving.md](goal2-serving.md) unchanged; "above" and
"below" inside them may refer to that file.

## Several gateway URLs and the capacity rule

From "Worker gateway client" in goal2-serving.md (the retry table stays there).

- Gateway URLs: every call starts at the first URL and moves on as in the table; there is no sticky failover state.
  All URLs must be loopback, so a standby gateway is another port on the same host (it covers a process crash or a
  deploy, not a host failure). With `PTR_GATEWAY_DISCOVERY=redis` the list comes from the gateway registry and these
  URLs become its seed and fallback (see "Gateway registry and several gateways" below); with Kubernetes a single Service address in
  `PTR_GATEWAY_URLS` and `static` discovery replace both (in the cluster profile).
- Every gateway in `PTR_GATEWAY_URLS` must use the **same Postgres ledger database** (`GOAL1_DATABASE_URL`) when a
  billable secondary (`PTR_GATEWAY_FAILOVER=openrouter`) is on. A reset retry that lands on another gateway is safe
  only because both see the same ledger entry for the turn key; with separate ledgers the second gateway could pay for
  the same turn again.
- `PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE` is counted per gateway process. Without the gateway registry, up to twice the
  cap can reach the secondary during an active–standby switchover. With it, each gateway uses cap / k, where k is the
  number of active gateways registered (see "Gateway registry and several gateways" below).

Capacity rule: **Σ worker concurrency ≤ Σ upstream caps + gateway max queue**
(`PTR_WORKER_CONCURRENCY × replicas ≤ PTR_GATEWAY_MAX_CONCURRENCY + PTR_GATEWAY_MAX_QUEUE` today, one upstream).
A turn makes one model call at a time, so this bounds what can reach the gateway at once. Within the rule, count
rejections (429) do not happen in steady state, waits end only by the queue timeout (503), and further turns wait in
BullMQ, which is durable. **With the capacity controller on** (below; default with `PTR_GATEWAY_DISCOVERY=redis`) the
rule is enforced automatically through BullMQ's global concurrency, and a worker only logs the current G at startup.
**With it off**, at startup a gateway worker reads `capacity` from the first gateway whose `/metrics` answers
and writes one stderr line if `PTR_WORKER_CONCURRENCY × PTR_WORKER_REPLICAS_HINT` exceeds it (a warning, never a
startup failure; `gateway capacity check skipped` when no gateway answers). Breaking the rule does not fail turns
outright: the excess calls get 429 and wait in jittered client retries until the turn deadline, instead of waiting in
BullMQ. Example: gateway defaults 32 + 256 = 288;
4 workers × 32 = 128 is fine, 4 × 128 = 512 warns:
`WARNING gateway capacity: worker concurrency 128 x replicas 4 = 512 > gateway capacity 288 (upstream caps 32 + queue 256); calls above it are refused with 429 and wait in client retries ...`.
The load harness prints the same check (`report.capacityCheck`). Its fake-model defaults (gateway 1024 + 4096) are
sized so the gateway is never the bottleneck. The S9 setting of 4 workers × 512 broke the rule; it measured fake
throughput only.

With an upstream pool (below) each upstream also has its own cap `maxSeqs` (default 12), and the rule becomes
Σ worker concurrency ≤ min(`PTR_GATEWAY_MAX_CONCURRENCY`, Σ_u maxSeqs_u) + max queue. `/metrics` `capacity` still
reports the gateway-wide numbers only; the capacity controller (next section) enforces the rule from the registry.

## Capacity controller (stage S2b)

The dispatcher keeps BullMQ's **global concurrency G** of the turn queue (`ptr:<PTR_TURN_QUEUE>:meta` field
`concurrency`) at

```text
S_live = Σ maxSeqs of the pool's active, unexpired registry records that pass the gateway's record policy
         (allowlist, loopback, one id per origin; draining excluded; slow start ignored: the gateway absorbs the ramp)
Q      = Σ maxQueue of the active gateways in the gateway registry that pass PTR_GATEWAY_ALLOW (S6),
         else PTR_GATEWAY_MAX_QUEUE (256) when none is registered or the registry cannot be read
G*     = max(PTR_CAPACITY_FLOOR (1), min(ceil(S_live × (1 + PTR_CAPACITY_HEADROOM (0.25))), S_live + Q))
```

BullMQ checks G in its Lua when a worker takes the next job, so active turns ≤ G ≤ Σ caps + queue: the capacity rule
holds by construction, whatever the number of workers. `PTR_WORKER_CONCURRENCY` is only a local cap now (64 is a good
value); in-flight turns = min(Σ local caps, G).

- **Leader:** any number of dispatchers may run; one holds `ptr:llm:cap:leader` (`SET NX PX max(15 s, 3 × interval)`,
  renewed every tick) and acts every `PTR_CAPACITY_INTERVAL_MS` (5000). It writes G only when it changes. A dispatcher
  that (re)gains leadership starts with fresh hysteresis, and records that are already draining are its starting point
  (not a new drain that would lower G at once).
- **Hysteresis:** increases apply at once (a new server raises G within one tick). A decrease applies only after 3
  consecutive ticks (15 s) with a lower target, then at most 25% (at least 1) per tick, so a record flapping on its TTL
  never moves G. A newly **draining** upstream (planned shrink) lowers G at once. Lowering G never interrupts active
  turns: BullMQ only stops handing out new jobs (verified by the opt-in BullMQ test), so `active` may exceed G briefly
  and converges as turns finish.
- **Registry unreachable:** G is held and those ticks never count toward a decrease (§13.2 freeze); BullMQ is down
  with it anyway. A readable but empty registry goes to FLOOR (1) through the hysteresis: never 0, which would stop
  every worker silently. With failover on, OpenRouter's 120/min ceiling is the minimum path; turns beyond G wait in
  BullMQ, durably.
- **Misconfiguration guard (`hold_suspect`):** S_live = 0 while registry records were **rejected** by the record
  policy (allowlist, loopback, duplicate origin), or while live records exist **only in other pools** (a wrong
  `PTR_CAPACITY_POOL` / `PTR_GATEWAY_POOL`), is treated as a configuration error: G is held, not decayed to FLOOR, and a
  `WARNING capacity: S_live=0 but …` line names the reasons and what to check for each (`not_allowed` →
  `PTR_GATEWAY_UPSTREAM_ALLOW`, which must equal the gateways' value; `not_loopback`; `invalid_record`;
  `pool_mismatch`). The registry prefix is never the suspect here: the records were found under it. On a **first
  start** (G unset) the same guard leaves G unset instead of writing FLOOR (`leaving G unset` in the warning), so a typo
  cannot throttle every worker to one turn; it stays unset for as long as the configuration looks wrong. A set G is
  held for at most 5 minutes; after that the planner follows the registry again (an empty pool then goes to FLOOR). Rejected records next to live ones are counted
  (`rejected` in the status) and logged once (`capacity: N registry record(s) rejected (…)`).
- **Status:** `ptr:llm:cap` HASH {target, sLive, q, qSource (registry | env), g, active, wait, computedAt, reason, writes,
  leader, registryStale, workerShortage} (expires 60 s after the last tick), and one dispatcher stderr line whenever G,
  Q or registry staleness changes: `capacity G=30 target=30 S_live=24 Q=256 active=… wait=… reason=increase` (`Q=512(gateways)`
  when Q comes from the gateway registry). `reason` is one of init, increase,
  hold, decrease_pending, decrease, draining, registry_stale, hold_suspect.
- **worker_shortage:** `wait > 0` while `active < G` for 15 s logs `WARNING worker_shortage …` once per episode (add
  workers or raise `PTR_WORKER_CONCURRENCY`).
- **capacity_floor:** G at FLOOR while turns wait for 15 s logs `WARNING capacity_floor …` once per episode: no upstream
  capacity is registered for the pool.
- **Startup errors:** a controller configuration error (bad env, unknown mode) is logged as `WARNING capacity
  controller disabled (CODE) …` and the dispatcher runs without it: turn dispatch, lease recovery and the outbox never
  depend on the controller.
- **Known limits:** a crashed worker's job holds its active slot until BullMQ's stall check (about 30–60 s); one queue
  = one pool (several pools need one turn queue each).
- **Headroom:** part of a turn runs outside the gateway (Jev intent p50 0.39 s × 0.594 calls/turn, the safety filter
  about 0.4 s when on; the measured workload), so the GPUs stay busy only if G ≥ S_live / share, i.e. headroom ≈ 1/share − 1, where
  share = time in gateway calls / turn time. From the measured parts: share ≈ 1.0 with both Jev features off (the
  fake-model path's turn e2e p50 1.94 s vs gateway call p50 1.99 s), ≈ 0.86 with intent only and ≈ 0.69 with intent +
  safety at an E4B call of 1.4 s (the measured safety step), so headroom 0 – 0.45. The default 0.25 stays; set 0.5 with both Jev features
  on, and re-measure with real engines (S8). Too much headroom only lengthens gateway waits (bounded by Q); too little
  leaves GPU slots idle (the acceptance harness shows it: share 0.6, G = 15 keeps about 9 of 12 slots busy).

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_CAPACITY_CONTROLLER` | `on` with `PTR_GATEWAY_DISCOVERY=redis`, else `off` | `on`; `off` (the dispatcher removes any G at startup, so switching the controller off never leaves a stale cap; `clear`, the earlier name, means the same); `keep` (never touch G, e.g. a G set by hand). All dispatchers on one queue must use the same mode. |
| `PTR_CAPACITY_POOL` | `PTR_GATEWAY_POOL`, else `PTR_SELFHOSTED_MODEL` | pool whose registry records count (required when on) |
| `PTR_CAPACITY_HEADROOM` | 0.25 (0–4) | see above |
| `PTR_CAPACITY_FLOOR` | 1 (1–4096) | lowest G (user decision; the design draft had 4) |
| `PTR_CAPACITY_INTERVAL_MS` | 5000 (500–60000) | tick |
| `PTR_GATEWAY_MAX_QUEUE` | 256 | Q when no gateway is registered (the same value the gateway uses) |
| `PTR_GATEWAY_ALLOW` | `127.0.0.1:56460-56469` | gateway records that count toward Q (the workers' rule) |
| `PTR_TURN_QUEUE`, `PTR_REGISTRY_PREFIX`, `PTR_GATEWAY_UPSTREAM_ALLOW` | as elsewhere | queue to control, registry namespace, record allowlist |

Static discovery (env or file) keeps the controller off by default: G would only mirror a fixed file, and the startup
warning stays the guard.

**Workers** read G and whether a controller leader is alive (`ptr:llm:cap:leader`) once at startup. On a worker only an
explicit `PTR_CAPACITY_CONTROLLER` counts. Workers now often set `PTR_GATEWAY_DISCOVERY=redis` to read the gateway
registry (S6), which derives `on`, but that says nothing about a controller. So without an explicit setting the line
follows the leader lock and never warns: a running leader is reported as `capacity controller running elsewhere: G=…`,
a set G without a leader as an info line. Warnings come only from an explicit setting that disagrees:
`PTR_CAPACITY_CONTROLLER=off|keep` while a leader runs (mixed modes), or `off` while a G is still set. The S1
Σ-concurrency check against the gateways' `/metrics` runs unless `PTR_CAPACITY_CONTROLLER=on` is set here or a leader
is running.

**Mode changes and rolling restarts:** every dispatcher sharing a queue should use the same mode. During a rolling
restart they briefly differ, which is safe:
- off → on: the first `on` dispatcher becomes leader and sets G on its first tick; old `off` dispatchers only act at
  their own startup.
- on → off: an `off` dispatcher removes G at startup only when no leader is alive. While an `on` dispatcher still holds
  the lease it warns once and re-checks every lease interval (max(15 s, 3 × `PTR_CAPACITY_INTERVAL_MS`)), removing G as
  soon as the last `on` dispatcher has stopped and its lease expired. Until then the old leader keeps G current. A check
  that fails because Redis is unavailable is logged and repeated one lease interval later.
- `keep` never touches G; use it for a G set by hand (`off` would remove it).

## Upstream registry and agent

From "Upstream pools" in goal2-serving.md (the file source, selection, drain, breakers and connection failures
stay there).

Sources:
- **redis** (`PTR_GATEWAY_DISCOVERY=redis`, `PTR_REDIS_URL`): the registry below. The file (or else
  `PTR_SELFHOSTED_BASE_URL` as one entry `selfhosted`) is only the seed: the membership until the registry has been
  read once (Redis unreachable at startup). On that first read the seed entries the registry lacks get the TTL grace
  (their agents may not have re-published yet); after it the registry is the only authority, so a drained or removed
  upstream never comes back from the seed, and the seed's id never doubles an engine that its agent registers under
  another id (one id per origin).

Registry layout (`packages/messaging/src/upstream-registry.ts`, prefix `PTR_REGISTRY_PREFIX`, default `ptr:llm`; it must
end in `:llm`, so it can never touch `ptr:turns:*` or `ptr:events:*`):

```text
ptr:llm:up:<pool>:<id>   HASH {pool,id,baseUrl,maxSeqs,kvCapacityTokens,weight,state(active|draining),epoch,seq}  PEXPIRE 10000
ptr:llm:ups:<pool>       ZSET member=<id> score=expiresAtMs   (read with ZRANGEBYSCORE now +inf; writers trim expired entries)
ptr:llm:reg:ver          INCR on every new record, field change, drain or removal
ptr:llm:reg              PUB/SUB, empty message = "poll now"
ptr:llm:drain:<pool>:<id> STRING epoch, PX the record's drainMaxMs + TTL: the drain tombstone
ptr:llm:cap / :cap:leader HASH status / leader lock of the capacity controller (S2b)
```

Expiry scores and the live listing use the Redis server clock (`TIME` inside the scripts). Pool names and ids are
validated before any key or SCAN pattern is built. The gateway and the agent import `@ptr/messaging/registry` (registry +
guarded Redis connection), which never loads BullMQ.

Writes are Lua scripts (atomic): a heartbeat carries the publisher's state and refreshes TTL, index and `seq`; it never
turns a `draining` record of the same epoch back to `active`, and a draining agent's heartbeat recreates an expired
record as draining; a new id or epoch, or a changed field, bumps the version and publishes. The optional fields
`drainMaxMs` and `prefillTokensPerSec` are removed when a heartbeat no longer carries them (also a change), so a
withdrawn R_u calibration cannot linger; gateways compare both fields too, so a changed R_u applies on the next poll. Marking a record draining
also writes a **drain tombstone** for its epoch: if the record expires before its agent deletes it (agent crash, Redis
blip) and an agent comes back on the same engine (same epoch), its heartbeat recreates the record draining and the
agent finishes the drain, so a drain started from the CLI cannot be undone by an expiry. A new epoch (new engine
process) is not affected. The tombstone lives the publishing agent's own drain bound (`drainMaxMs`, which every agent
puts in its record) + the TTL, or the CLI's `PTR_UPSTREAM_DRAIN_MAX_MS` + TTL for a record without one. Removing the
record **with its epoch** (the agent finishing the drain) deletes the tombstone too, so a later start of the same engine
is active; a forced `deregister` (no epoch) leaves it, so a crashed agent still resumes the drain.

Gateway behaviour with the registry (`RedisRegistrySource`):
- **Discovery:** polls every `PTR_GATEWAY_REGISTRY_POLL_MS` (2000) and at once on a nudge; lost nudges are covered by
  the next poll. A new id, or a new **epoch** for a known id (the engine restarted), is a new upstream: fresh breaker,
  slow start. Upstreams present when the gateway starts begin at full capacity.
- **Redis unreachable:** the membership is **frozen** (no additions, no expiry; dead engines are left to the breakers),
  `registry.stale=true`. Once readable again, records missing from the registry are kept for
  `PTR_GATEWAY_REGISTRY_GRACE_MS` (10000 = the TTL) before they are dropped, because the agents' next heartbeat may not
  have landed yet or Redis expired the records during the outage. One failed poll is enough to arm the grace, so an
  upstream removed right after a short blip may stay listed for up to 10 s (its breaker covers it). BullMQ shares this
  Redis, so no new turns start during the outage anyway.

Security (single host): anyone with the Redis password can write a record, and a record decides where
prompts (user data) are sent. The gateway therefore applies the existing loopback rule to every record's `baseUrl`
(`http`, `127.0.0.1`, no credentials, query or fragment) **and** `PTR_GATEWAY_UPSTREAM_ALLOW`, a comma list of
`127.0.0.1:<port>` or `127.0.0.1:<from>-<to>` (default `127.0.0.1:18000-18999`; anything else is a startup error).
Records that fail are ignored and counted once per record version in `registry.rejected` / `rejectedReasons`
(`not_loopback`, `not_allowed`, `invalid_record`, `pool_mismatch`, and `duplicate_url`: a second id on an origin
(host:port) already listed, which would double that engine's `maxSeqs`; the lower id wins); they are never logged with their URL. File and env
entries are operator config and need only the loopback rule. Records are not signed; multi-host operation (TLS, Redis
ACL users, HMAC-signed records, a host/CIDR allowlist) is a later, separately approved stage.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_DISCOVERY` | `static` | `static` (env or file) or `redis` |
| `PTR_GATEWAY_UPSTREAM_ALLOW` | `127.0.0.1:18000-18999` | ports registry records may use |
| `PTR_GATEWAY_REGISTRY_POLL_MS` | 2000 (100–60000) | registry poll interval |
| `PTR_GATEWAY_REGISTRY_GRACE_MS` | 10000 (0–600000) | keep-missing-records grace after Redis comes back |
| `PTR_REGISTRY_PREFIX` | `ptr:llm` | registry namespace (`…:llm`; tests use `ptrtest:<run>:llm`) |
| `PTR_UPSTREAM_HEARTBEAT_MS` / `PTR_UPSTREAM_TTL_MS` | 2000 / 10000 | agent heartbeat and record TTL (TTL ≥ 2 × heartbeat) |
| `PTR_UPSTREAM_DRAIN_SETTLE_MS` | 4000 | agent drain: minimum wait before checking the engine is idle (two gateway polls) |
| `PTR_UPSTREAM_DRAIN_MAX_MS` | 120000 | agent drain: upper bound before the record is deleted anyway; the CLI's drain tombstone lives this + TTL |
| `PTR_UPSTREAM_HEALTH_TIMEOUT_MS` | 2500 (100–30000, and < TTL − heartbeat) | agent: timeout of one engine `/health` check (a busy engine may answer slowly); it must leave a heartbeat inside the TTL |

Agent and CLI (`scripts/upstream-agent.ts`, needs `PTR_REDIS_URL`; prints JSON lines, never the Redis URL):

```bash
# foreground agent next to the engine's SSH tunnel; SIGTERM drains and deregisters
pnpm exec tsx scripts/upstream-agent.ts register --pool=gemma-4-e4b-fp8 --id=pod-a --base-url=http://127.0.0.1:18000/v1 \
  [--max-seqs=12] [--kv-capacity-tokens=347000] [--weight=1] [--epoch=<id>]
pnpm exec tsx scripts/upstream-agent.ts drain --pool=gemma-4-e4b-fp8 --id=pod-a        # exit 0 once the record is gone
pnpm exec tsx scripts/upstream-agent.ts deregister --pool=gemma-4-e4b-fp8 --id=pod-a   # immediate; a running agent re-registers
pnpm exec tsx scripts/upstream-agent.ts list [--pool=gemma-4-e4b-fp8]
```

- `register` waits for the engine's `/health` = 200, reads `/metrics` once: KV capacity from
  `vllm:cache_config_info` (`num_gpu_blocks × block_size`, else `--kv-capacity-tokens`, else null) and
  `process_start_time_seconds` for the epoch (a hash of id, URL and start time: a restarted agent keeps the epoch, a
  restarted engine gets a new one; `--epoch` overrides; without either the epoch is random). Both metric names are
  unverified against the deployed vLLM (); the fallbacks keep the agent working either way.
  It then heartbeats; three failed `/health` checks in a row deregister the engine until it is healthy again.
- Drain (`SIGTERM`/`SIGINT` to the agent, or `drain` from anywhere): the agent heartbeats `state=draining` (every
  tick until a write succeeds), waits `PTR_UPSTREAM_DRAIN_SETTLE_MS` counted from that confirmed write, then until `vllm:num_requests_running + vllm:num_requests_waiting = 0` on two checks in a
  row (an unreachable engine counts as idle), bounded by `PTR_UPSTREAM_DRAIN_MAX_MS`; then the record is deleted
  (`remove_failed` if Redis refuses: it then expires by TTL) and the agent exits. A second signal exits at once; a
  drain requested before the first registration publishes nothing.

Runbook:
- **Scale up:** start the engine and its SSH tunnel on a port inside `PTR_GATEWAY_UPSTREAM_ALLOW`, then `register`. Within
  one poll (usually at once, by nudge) every gateway adds it and ramps it over 30 s. Check `pool.upstreams[]` in
  `/metrics`.
- **Scale down:** `drain` (or `SIGTERM` the agent). New calls stop within a poll, in-flight calls finish, the record is
  deleted, then stop the engine and the tunnel.
- **Engine crash:** in-flight streams break (workers retry them with the turn key), new calls get connection errors and
  move to another upstream, the breaker opens (within a few calls), and the record expires ≤ 10 s after the agent's
  last heartbeat, i.e. a gateway drops it ≤ 12 s (TTL + one poll) after the crash.
- **Agent crash only:** the engine keeps serving its in-flight calls but takes no new ones once the record expires
  (capacity drops); restart the agent and it returns with the same epoch (slow start again).
- **Redis outage:** nothing to do; check `registry.stale` and that `members` did not drop after it came back.
- **Rejected records:** `registry.rejected` rising means someone registered a URL outside the allowlist; `list` shows it.

## Routing policies and the comparison

From "Credit admission, central queue and routing" in goal2-serving.md.

**Selection** (`PTR_GATEWAY_ROUTING`) among the fitting upstreams:
- `round_robin`: rotate;
- `least_inflight`: fewest in flight, ties rotate (the S2 rule);
- `scored` (§4.3): least cost (U + (1 − h_u)·T̂) / (R_u · T_max) + (N + 1) / S_eff (h_u·T̂ = G, or the prefix-table
  match when longer, S5), with R_u = weight × 10000 until calibrated; ties go to the rendezvous-hash order of
  hash(policy ‖ persona). Cache affinity (`PTR_GATEWAY_AFFINITY`, S5) can come before any of the three.

The default is `least_inflight`; `scored` stays selectable. It has not met the §9.1 acceptance bar (fixed before the
first run: heterogeneous W2 and W3, one of {max throughput with TTFT p95 ≤ 2 s, TTFT p95 at the knee} ≥ 10% better and
the other ≤ 5% worse; homogeneous W1 both ≤ 5% worse), so there is no evidence to change the default:

- **S3 run** (single seed, fixed rate grid, partly overloaded): heterogeneous W2 had no rate meeting the 2 s TTFT p95
  for either policy, so that half of the bar could not be evaluated and the other did not reach 10%; in heterogeneous
  W3 `scored` was worse (TTFT p95 894 vs 667 ms at the nominal rate, throughput −2.3%). Homogeneous W1 within 5%.
- **S4 re-run with the revised method** (below; `reports/routing-compare-muzx6c629836.json`, merged from three runs
  made in parallel as three processes on one 12-core host, so they shared CPU; knees 7.5 / 6 / 9 req/s for homogeneous
  W1 / heterogeneous W2 / W3, each from a single seed-0 sweep (the script now takes the median over 3 seeds); 3 seeds;
  means with 95% t intervals, descriptive only (3 seeds, no significance test); paired = per-seed relative
  difference, positive = `scored` better; re-evaluated with the ∞ rule below, verdict unchanged):

| Combination | Max throughput with TTFT p95 ≤ 2 s (req/s): scored vs least_inflight | TTFT p95 at the knee (ms) | Verdict |
| --- | --- | --- | --- |
| heterogeneous W2 | 4.11 vs 4.11 (both [−4.8, 13.0]; per seed 5.87 / 0 / 6.47 for both) → +0% | 2672 vs 2801 → +4.6%; paired −5.1% [−58%, +48%] | not ≥ 10% better: FAIL |
| heterogeneous W3 | 2.36 vs 4.91 (per seed 0 / 7.07 / 0 vs 0 / 7.07 / 7.67) → −52% | ∞ for both in seed 1 → no comparison; paired (2 seeds) −0.6% | FAIL (worse) |
| homogeneous W1 | 8.49 vs 8.49 → +0% | 1245 vs 1444 → +13.8%; paired +15.1% [−5.3%, +35.4%] | not worse: PASS |

  How to read it: in an open loop with no failures the completed throughput equals the offered rate for every policy,
  so the throughput metric only moves when a policy's TTFT p95 crosses 2 s at some grid point; with 15 s windows the
  seed-to-seed spread is far larger than the policy difference (heterogeneous W2 TTFT p95 at the knee: 929–5603 ms
  across seeds; between the two policies on the same seed and rate the median gap is 124 ms, under 300 ms in 10 of 15 cells), and a single crossing moves a seed's
  value by a whole grid step or to 0. The W3 "−52%" is one seed where `scored` crossed 2 s at 0.8 × knee (2035 vs
  1531 ms). Every interval includes 0, so the data show no reliable difference in either direction on the
  heterogeneous configs. The one consistent signal is homogeneous W1, where `scored` had the lower TTFT p95 in 11 of
  15 seed × rate cells (it also counts uncached prefill tokens, which least in-flight ignores), not part of the bar.
  Re-run after the prefix table and affinity (S5) and real-engine R_u / S_u calibration (S8), with longer windows or
  more seeds, before revisiting the default.

**Comparison method** (`scripts/routing-compare.ts`, revised in S4): per (config, workload) a knee sweep with
`least_inflight` on `--knee-seeds` seeds (default 3; per seed the highest rate of the monotone prefix with TTFT p95
≤ 2 s; the grid uses their median); a grid of knee ×
0.8/0.9/1/1.1/1.2; 3 seeds per point, every random choice (arrival times, token lengths, outputs, flows) from the
seeded RNG; open-loop arrivals by default (W3 turns scheduled up front every 2.5 s, sessions already running at t = 0),
so every policy sees byte-identical requests; order seed → rate → policy; after the last arrival every request is
awaited (60 s client timeout) and requests still open are counted as unfinished; TTFT p95 counts failed, rejected and
unfinished requests as ∞. In the acceptance an infinite mean TTFT p95 (any seed over 5% failures) is a loss: only
`scored` ∞ → gain −∞ (fails both "better" and "not worse"), only `least_inflight` ∞ → +∞, both → no comparison; gains
are written as the strings "Infinity" / "-Infinity" in the JSON. `--merge=a.json,b.json` combines runs made in
parallel into one verdict; the same point twice is an error (`MERGE_DUPLICATE_POINT`), and so are runs whose stored
`method` differs in anything that shapes points or knees — grid, seeds, `kneeSeeds`, windows, drain, arrivals, SLO, knee
sweep, prompt layout (`MERGE_METHOD_MISMATCH`; reports written before `kneeSeeds` was stored never merge with new ones).
`--policies` also takes `<policy>+affinity` variants (S5).

Limits: `drr` needs `X-PTR-Flow` (the worker does not send one yet, so all traffic is one flow = FIFO with LOOKAHEAD);
for non-streaming requests the first chunk is the whole reply, so U stays reserved to the end; requests waiting on a
half-open probe (with a secondary) are not counted against the queue bound; a waiting band-1 retry that excludes the
only upstream with credit still holds back lower bands (strict bands, as designed).

Comparison harness: `scripts/fake-engine.ts` (FakeEngineUpstream: slots, prefill rate on one lane, batch-dependent
TPOT, KV capacity, prefix LRU over message-chain hashes, vLLM-named `/metrics`, `/health`, telemetry controls) and
`scripts/routing-compare.ts` (W1–W4 × homogeneous / heterogeneous × the three policies, method above, report in
`reports/routing-compare-<run>.json`).

## Engine telemetry (stage S4)

From "Engine telemetry, slow start after recovery, restarts" in goal2-serving.md (slow start after recovery,
restarts and the primary-to-primary retry stay there).

Pools only (file or registry; the env-only single upstream and the failover wrapper are unchanged).

**Telemetry polling (off by default):** `PTR_GATEWAY_METRICS_INTERVAL_MS` defaults to 0 until the metric names and
meanings are verified on the real engines (S8); with e.g. 1000 the gateway reads each member's `GET {origin}/metrics`
at that interval (one poll times out after `PTR_GATEWAY_METRICS_TIMEOUT_MS`, default min(500 ms, interval), overlapping polls collapse, a body over 1 MiB is
dropped as a failed poll). Parsed (vLLM v1 names,
checked against vLLM's metrics docs and `v1/metrics/loggers.py` upstream, **not against the deployed build**; design
[확인 필요]):

| Name | Use |
| --- | --- |
| `vllm:num_requests_waiting`, `vllm:num_requests_running` (gauges, summed over label sets) | filter, credit_model_miss, metrics |
| `vllm:kv_cache_usage_perc` (gauge 0–1; older builds `vllm:gpu_cache_usage_perc`; highest label set) | filter |
| `vllm:prefix_cache_queries[_total]`, `vllm:prefix_cache_hits[_total]` (counters; older `vllm:gpu_prefix_cache_*`) | `prefixHitRate` between two polls (metrics only; vLLM counts tokens) |
| `process_start_time_seconds` (prometheus_client process collector; may be absent) | engine restart detection |

Parsing skips comments, NaN and ±Inf, takes the first value token (a timestamp or an OpenMetrics exemplar after it is
ignored) and reads label values containing `}` or escaped quotes. Impossible values (KV usage outside [0, 1], negative
counts) are treated as unknown, never as a block, and counted (`telemetry.implausible`).

**Filter only, never a score input** (§4.4: delayed telemetry in a closed loop oscillates). While the last good poll is
at most 3 × the interval old, a member whose engine reports KV usage ≥ `PTR_GATEWAY_ENGINE_KV_HIGH` (0.95) or waiting >
`PTR_GATEWAY_ENGINE_WAITING_MAX` (2) gets no new request: the request is treated like "no credit" and waits in the
queue (no failover, no spillover); it is re-dispatched as soon as a poll clears the condition. **Fallback (agent
decision, beyond the design text):** selection takes the fitting non-blocked members first; only when none fits does a
blocked member with nothing of this gateway's in flight take one request, like the KV credit's idle rule. Without it, a
misread or stuck metric (the names and semantics are unverified on the deployed vLLM) would remove an idle server
completely, and with several gateways another gateway's load could starve this one; with it the worst case is one call
at a time on that server. The rule is per gateway: with k gateways a blocked engine may get up to k such calls. Older
than 3 × the interval (or never read, or `/metrics` not 200) the filter is ignored and only the gateway's ledger decides
(fail-open, `telemetry.stale`). A member blocked for 10 polls in a row while its engine runs fewer than maxSeqs / 4
sequences logs `WARNING gateway upstream <id>: blocked by engine telemetry …` once per episode
(`telemetry.suspectBlocked`): the metric probably does not mean what the filter assumes.

**credit_model_miss:** waiting > 0 on 3 fresh polls in a row counts one episode per upstream (`telemetry.creditModelMiss`):
the gateway's credits (`maxSeqs`, KV) let more in than the engine runs at once, or other gateways (or other clients)
also load that engine: the engine's queue does not say whose requests wait. Nothing is corrected automatically
(feedback oscillation); lower that upstream's `maxSeqs` or check `kvCapacityTokens`.

**Keep-alive pinning (limit of the "several processes" check):** the gateway reads `/metrics` and sends calls through
Node's default fetch agent, which keeps connections alive (undici closes an idle one after about 4 s unless the server
says otherwise). With several processes behind one port (e.g. `SO_REUSEPORT` API servers) the kernel picks the
process per **connection**, not per request, so a 1 s poll that keeps reusing one connection keeps reading one
process. The second process's start time then shows only when that connection is replaced (idle timeout, a reset, an
engine restart), so detection may turn off late, or not at all, and a restart of the process the poller does not see
is caught by the breaker only. Calls are pinned the same way (by connection, not by the gateway's choice of upstream
id), which is harmless for routing because the API server processes share one engine and one prefix cache.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_METRICS_INTERVAL_MS` | 0 = off (else 100–60000, e.g. 1000) | telemetry poll interval; stale after 3 ×; off until verified on real engines (S8) |
| `PTR_GATEWAY_METRICS_TIMEOUT_MS` | 500 (the interval when shorter; 50–60000, at most 3 × the interval when telemetry is on) | one poll's timeout. Use 2000 for engines behind an SSH tunnel: S8 measured 0.6–1.2 s for `/metrics` on a new tunnel connection (3 ms on the host), so 500 ms polls failed and the member went stale; with 2000 the real-engine acceptance passed |
| `PTR_GATEWAY_ENGINE_KV_HIGH` | 0.95 (0.1–1) | KV usage at or above it filters a member out |
| `PTR_GATEWAY_ENGINE_WAITING_MAX` | 2 (0–100000) | engine waiting above it filters a member out |

**Metrics:** per upstream `rampReason` and `telemetry` {stale, ageMs, staleEpisodes, failedPolls, running, waiting,
kvUsage, prefixHitRate, blocked, blockedPolls, creditModelMiss, waitingStreak, restarts, restartDetectionDisabled, implausible, suspectBlocked}
(null when off); `members`
adds `telemetryBlocked` and `telemetryStale`; `events.restarted`; pool `telemetry` {intervalMs, kvHigh, waitingMax} or
null.

**Acceptance (fake engines, `scripts/telemetry-acceptance.ts`, telemetry explicitly on at 1000 ms, open-loop W1 at
8 req/s for 15 s, one run each; `reports/telemetry-acceptance-muzxeyw8c96c.json`):**

| Scenario | Result |
| --- | --- |
| A1 b reports KV 0.97 (engine actually idle) | telemetry on: b 16 / a 105 dispatches (b only when a had no room), 0 failed, TTFT p95 8.6 s, one suspect-block warning; off: b 57 / a 64, TTFT p95 1.6 s. The filter works; a false high report concentrates load on a (without the fallback an earlier run had 15 queue timeouts) |
| A1b b has 3 engine slots but maxSeqs 12 | on: b 35 dispatches, TTFT p95 5.7 s, credit_model_miss 2; off: b 41, TTFT p95 7.6 s. Peak engine waiting 9 in both: with a 1 s poll the gateway overfills b before the first report. Small gain, single run |
| A2 b blocked, then its /metrics hangs at 5 s | stale 2.8 s after the hang (3 × interval minus the poll phase); b dispatches 2 before 5 s, 1 until stale, 47 after; 0 failed |
| A3 b's engine down 2–5 s (telemetry off) | breaker open at 2.2 s, closed at 5.2 s (3 s cooldown), b's limit 1 → 2 → 5 → 8 → 12 at +0/2.5/5/7.5/10 s (10 s ramp), at most 2 in flight in the first 2 s; 5 failed = the streams on b cut when it stopped (the worker retries those) |
| A4 b's engine restarts at 5 s (same port and epoch) | restart confirmed at 6.8 s (two polls), b's limit 1 then 5 after 5 s, breaker closed, `events.restarted` 1; 4 failed = streams cut by the restart |

## Prefix table, cache affinity, routing log and §8 metrics (–4.3, §8, stage S5)

Pools only (file or registry).

**Prefix table (always kept).** Every request carries its message-boundary chain H_k = sha256(salt ‖ message 1 ‖ … ‖
message k) (one running hash, each message's role and content length-prefixed, first 128 bits; the salt is random per
gateway process, so the in-memory hashes cannot be checked against guessed content) for k = 1..m−1 (the last message,
the new user turn, is never a cached prefix), each with the
cumulative token estimate ceil(bytes / `PTR_GATEWAY_BYTES_PER_TOKEN`), the same rule as T̂ and G. Each upstream has a
table of the chains the gateway has seen it serve: a request's chain is recorded at its **first 2xx body chunk** (its
prefill is done, so the engine holds it; refused, failed and non-2xx calls are not recorded), tail first so that a
request's longest prefixes are the least recently seen and evicted first (vLLM frees a sequence's tail blocks first).
Entries expire after `PTR_GATEWAY_PREFIX_TTL_MS` (120000, Dynamo's approximate-mode default). Size: the own tokens of
the resident entries (H_k counts only message k, so a shared policy block counts once) stay within the upstream's
`kvCapacityTokens`, like the engine's prefix cache, which lives in the KV pool; and at most 4096 entries in any case. **Agent decision (deviation):** the design's bound "K_u / mean request tokens × 4 entries" counts requests,
but the table stores one entry per message; a token bound measures the same thing at that granularity. A table is
emptied when its upstream's breaker opens, when an engine restart is detected, and once when restart detection turns
off (several processes on the port, one may be a fresh engine); a new member (new id, epoch or address) starts empty. h_u(r) = the cumulative tokens of the longest fresh H_k in u's table / T̂.

**What the table changes (only with affinity on):** the cached share of a request on upstream u becomes
max(policy-block share G, its table match on u) for **prefill only**: the prefill ledger U, the calibrated prefill gate
and the §4.3 cost (and so `scored`'s choice) use (1 − h_u)·T̂. The **KV reservation stays (T̂ − G) + M**: a prefix hit
saves prefill compute, but KV only for blocks that a *running* request holds, and a session's history is held by none
(one turn per session at a time), so vLLM allocates those blocks again (its free cached blocks move into use). The
policy block is the one prefix that running requests always share. With affinity off the table is not consulted at all
(matched = 0), so credit, `scored` cost and selection are exactly as in S4; the table is still kept, but only its
size metrics fill in (`prefix.entries`, `prefix.tokens`, `prefix.cleared`): `extraHits` and the `affinity` outcome
counters need a lookup and stay 0, so with affinity off the metrics do not show what affinity would have picked.

**Cache affinity (`PTR_GATEWAY_AFFINITY=off|on`, default `off`).** Among the candidates whose credit fits:
g_u = matched_u − G (cached tokens beyond the policy block, which every warm server holds). The member with the largest
g (the cheapest of those, then the rendezvous order) is picked if g ≥ `PTR_GATEWAY_AFFINITY_MIN_TOKENS` (256) and its
cost_u ≤ min cost + `PTR_GATEWAY_AFFINITY_SLACK` (0.5), with cost_u = (U_u + (1 − h_u)·T̂) / (R_u·T_max) + (N_u + 1) /
S_eff (R_u = weight × 10000 until calibrated). Otherwise the configured `PTR_GATEWAY_ROUTING` decides. **Composition
(agent decision):** the slack is measured with the §4.3 cost whatever the routing policy, so its meaning ("at most
0.5 more occupancy / prefill pressure than the least loaded candidate") is the same for every policy; the fallback is
the policy itself — `least_inflight` (fewest in flight; with affinity on its ties go to the rendezvous order of
hash(policy ‖ persona) instead of rotating, so a persona's cold-start requests gather on one server), `scored` (least
cost, rendezvous ties) or `round_robin`. With today's prompts persona-only matches give g ≈ 220 < 256: only a
session's own history makes a server sticky, as the design intends.

**Routing decision log** (sampled, `PTR_GATEWAY_ROUTE_LOG_SAMPLE`, default 0.01, 0 = off; no message text, the
request key only as sha256[:12], member ids not URLs; to the gateway's stderr):

```text
route rk=3f2a9c0d1b7e pool=gemma-4-e4b-fp8 band=0 est=1912 h={a:0.71,b:0.59} cost={a:0.42,b:0.3} pick=a reason=affinity affinity=picked wait=12ms
```

`rk` is salted per process (comparable within one gateway's log, not across processes). `reason`: `affinity`, `load`
(the policy's pick), `tie` (the policy's tie-break), `retry` (another primary after a
connection failure), `failover` (`pick=secondary`, h and cost empty); `affinity=` (picked | brokenBySlack | none) only
when affinity is on; h and cost list the candidates that fit.

**Metrics (§8)** added to `pool` in `/metrics`: per upstream `ttftMs` and `e2eMs` {p50, p95} (2xx calls, from dispatch
to the first body chunk / to the end of a completed stream; a stream the caller closed early counts for TTFT only), `estOverActualTokens` {p50, p95, n} (T̂ / `usage.prompt_tokens` read from the
end of the answer; the worker asks for usage with `stream_options.include_usage`), `prefix` {entries, tokens, cleared,
extraHits (affinity on: dispatches whose table match exceeded G)}; per pool `latency` {ttftMs, e2eMs} (from arrival at the pool,
queue wait included), `affinity` {mode, minTokens, slack, picked, brokenBySlack, none} (counted only when on),
`prefixTtlMs`. Already present and named differently from §8: `retriedOnOtherPrimary` (= primaryRetries),
`failover.failovers` by reason, `queue.queued` by band, `queue.rejected` by reason (`draining` since S6),
`seqUtil`, `kvUtil`, `telemetry`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_AFFINITY` | `off` | `on` = cache affinity before the routing policy |
| `PTR_GATEWAY_AFFINITY_MIN_TOKENS` | 256 (0–1000000) | g needed to stick |
| `PTR_GATEWAY_AFFINITY_SLACK` | 0.5 (0–100) | cost over the cheapest candidate that still sticks |
| `PTR_GATEWAY_PREFIX_TTL_MS` | 120000 (1000–3600000) | prefix-table entry lifetime |
| `PTR_GATEWAY_ROUTE_LOG_SAMPLE` | 0.01 (0–1) | share of routing decisions logged |

**Affinity evaluation — pre-registered before the first run** (`scripts/routing-compare.ts`, `affinityAcceptance`):
`least_inflight+affinity` (256 / 0.5) against `least_inflight` (the default), homogeneous and heterogeneous configs,
W3 and W1, the S4 method (median knee of `least_inflight` over 3 knee seeds, grid 0.8–1.2 × knee, open loop, 15 s
windows, failures = ∞) with **5 seeds**. Affinity becomes the default only if **all** hold, on seed means:
W3 on both configs — TTFT p95 at the knee ≥ 10% better and max throughput with TTFT p95 ≤ 2 s ≤ 5% worse; W1 on both
configs — both ≤ 5% worse. Reported next to it, not part of the bar: TTFT p50, engine prefix hit rate (requests and
tokens), dispatch imbalance (max / mean per upstream), affinity outcomes. Workload change for this run: W3 requests put
the agent state after the history (the approved S7 P2 layout), so a session's turns share a prefix that grows with
its history; with the layout of that time (state before the history) the shared prefix stopped at the persona and
affinity had nothing to act on. S7 (below) made the app use that layout. The fake engine now models vLLM's KV: a request holds prompt − (prefix shared with running
requests) + output, so a cached history saves prefill but not KV, and cached prefixes live in the free KV (capacity −
KV in use, so load evicts them; the old model was 2000 entries and subtracted every cached token from KV). It counts
hit tokens. **Fixed after the runs below (S6, Part A):** the shared blocks were charged to the request that allocated
them only, so when that request ended first its sharer's history dropped out of the KV in use (under-counted KV:
the fake engine admitted somewhat more than vLLM would under sharing). Shared blocks are now counted once and freed by
their last running holder. Every run below was affected (all requests share at least the policy block), both arms
alike: the fake engine's own KV limit was looser than intended, which matters only where that limit binds (KV-bound
configs near the knee). The runs were not repeated: the bar failed by a wide margin, and the fix tightens the engine
for both arms, not one. The fake cache has the gateway table's message-boundary granularity and sees exactly the gateway's
requests, so these runs do not exercise table staleness (other clients, engine eviction policy, real tokenization). Expectation from the design (§0, §1.2): small, because the
policy block (~60% of a prompt) is cached on every server whatever the routing.

**Result.** Two runs; the second is the one that counts for W3. Both: 5 seeds per point, knees from 3 seeds, seed
means with 95% t intervals, gains positive = affinity better, paired = mean of the per-seed relative differences,
runs made in parallel (one process per config × workload, one 12-core host, shared CPU).

1. `reports/routing-compare-muzzck15899f.json` (all four combinations) used the first S5 code: the KV reservation
   subtracted the table match and the fake engine subtracted every cached token from KV. Both overstated what a
   history hit saves (review finding; fixed above).
2. `reports/routing-compare-mv00vpea57e4.json` (W3 only, after the fix: KV = (T̂ − G) + M, table off when affinity is
   off, fake engine KV = prompt − prefix shared with running requests + output). W1 was not re-run: it has no history,
   so affinity changes only its tie-break, and the bar fails on W3 whatever W1 shows.

| Combination | Knee (req/s; per seed) | Max throughput with TTFT p95 ≤ 2 s: on vs off | TTFT p95 at the knee (ms): on vs off | Bar |
| --- | --- | --- | --- | --- |
| homogeneous W3 (run 2) | 10.5 (15, 10.5, 10.5) | 11.99 vs 11.99 [10.84, 13.14] → 0% | 1255 [118, 2392] vs 1263 [169, 2357] → +0.6%; paired +7.3% [−15.2, +29.7] | needs ≥ 10%: **FAIL** |
| heterogeneous W3 (run 2) | 7 (9, 5, 7) | 7.47 [6.45, 8.49] vs 7.25 [6.33, 8.17] → +2.9% | 1838 [−342, 4018] vs 1893 [−215, 4001] → +2.9%; paired +8.4% [−13.7, +30.5] | needs ≥ 10%: **FAIL** |
| homogeneous W1 (run 1) | 7.5 (7.5 × 3) | 7.99 [6.57, 9.40] vs 8.15 [7.02, 9.27] → −2.0% | 1558 [990, 2126] vs 1539 [896, 2182] → −1.2% | ≤ 5% worse: PASS |
| heterogeneous W1 (run 1) | 5 (5 × 3) | 4.63 [3.68, 5.58] vs 4.69 [3.81, 5.58] → −1.4% | 1955 [559, 3352] vs 1884 [560, 3208] → −3.8% | ≤ 5% worse: PASS |

Run 1's W3 rows were +1.4% and +4.2% (also FAIL).

**Verdict: the bar is not met (W3 fails on both configs in both runs), so `PTR_GATEWAY_AFFINITY` stays `off` by
default.** Supporting numbers (run 2, at the knee unless noted; not part of the bar):

- Engine prompt tokens served from cache, on vs off: homogeneous W3 0.772 vs 0.756, heterogeneous W3 0.777 vs 0.768
  (median paired difference over the 25 seed × rate cells +1.0 and +0.6 points). As the design expected, most cached
  tokens are the policy block that every server holds.
- Affinity outcomes: about half the W3 decisions `picked` (homogeneous: 512 picked / 512 none over 5 seeds; `none` =
  a session's first or second turn or a persona-only match); `brokenBySlack` 1 in heterogeneous, 0 in homogeneous.
- TTFT p50: homogeneous 840 vs 846 ms, heterogeneous 717 vs 759. Dispatch imbalance (max / mean): 1.03 vs 1.03 and
  1.51 vs 1.54: affinity did not concentrate load.
- Over the 25 seed × rate cells affinity had the lower TTFT p95 in 12 (homogeneous) and 12 (heterogeneous), median
  paired gain 0.0% in both: run 1's heterogeneous lean (19 of 25) did not survive the KV fix. The seed spread is far
  larger than the difference; as in S4, throughput in an open loop equals the offered rate unless a policy crosses
  2 s somewhere on the grid, so that half of the bar barely moves.

Revisit only with a reason to expect more: the approved S7 prompt reordering in the app (this run assumed it), longer
histories (more prefill saved per sticky turn), or real-engine calibration (S8). Reusing history never saves KV.

## Gateway registry and several gateways

From "Gateway HA" in goal2-serving.md (the graceful drain stays there).

**Gateway registry (§13.6, G2).** `PTR_GATEWAY_REGISTRY=on|off` (default `on` with `PTR_GATEWAY_DISCOVERY=redis`,
else `off`) publishes, under the registry prefix (`PTR_REGISTRY_PREFIX`, default `ptr:llm`):

```text
ptr:llm:gw:<id>      HASH {id,url,maxQueue,state(active|draining),startedAt,seq,beatAt}  PEXPIRE 10000 (heartbeat 2000)
ptr:llm:gws          ZSET member=<id> score=expiresAtMs (trimmed by every heartbeat; Redis server clock)
ptr:llm:gw:leader    STRING <id>  SET … PX 5000, renewed by its holder's heartbeat
```

- `PTR_GATEWAY_ID`: default `gw-<port>-<random8>`. `leader` is reserved.
- `PTR_GATEWAY_ADVERTISE_URL`: default `http://127.0.0.1:<port>/v1`. It must pass the workers' own rule (startup
  error otherwise).
- `maxQueue` is `PTR_GATEWAY_MAX_QUEUE`. `startedAt` is the process start; `beatAt` is the registry clock of the last
  heartbeat.
- The record is published once the gateway listens. It is deleted at the end of a drain, and a crashed gateway's
  record expires 10 s after its last heartbeat.

**Leader hint (agent decision, refines the design):** a free hint goes to the **oldest** active gateway whose
`beatAt` is within the hint's 5 s lease, not to whichever gateway heartbeats first. In the first T6 run, a gateway
that had just started took the free hint ahead of the running standby, and every worker moved to the cold newcomer.
A gateway also takes a free hint only after one lease (5 s) of successful heartbeats in a row (a failed heartbeat
restarts the wait), so a gateway that just started or just got Redis back cannot take it on its first beat; it renews a
hint it already holds on every beat. Index members that are not gateway ids (the hint's own name, a stray key) or whose
key is not a hash are skipped by the heartbeat script and the list read. The hint is only an optimisation: a request
sent to a standby is served there just the same.

**Same ledger:** every gateway a worker can reach through the registry (like every URL in `PTR_GATEWAY_URLS`) must use
the same Postgres ledger database (`GOAL1_DATABASE_URL`) when a billable secondary is on. A reset retry or a drain
rejection moves a turn to another gateway with the same request key; only a shared ledger turns that into a replay or
an unresolved refusal instead of a second paid call.

**Upgrade note:** with `PTR_GATEWAY_DISCOVERY=redis` the gateway registry is on by default, and the advertised URL must
be on a port in `PTR_GATEWAY_ALLOW` (default 56460–56469). A gateway on another port then fails at startup with
`INVALID_PTR_GATEWAY_ADVERTISE_URL`, and workers and the capacity controller ignore records outside the allowlist: set
`PTR_GATEWAY_ALLOW` to the same value on gateways, workers and dispatchers (or `PTR_GATEWAY_REGISTRY=off`).

**Workers (`PTR_CHAT_PROVIDER=gateway` with `PTR_GATEWAY_DISCOVERY=redis`):**
- A `GatewayDirectory` reads the registry every 2 s.
- Each call walks a list read at its start: active gateways first, the leader at the head, then by oldest `startedAt`,
  then by id. After them come any `PTR_GATEWAY_URLS` seed URLs that the registry does not list as active or draining
  (for example a gateway running without the registry).
- Before the first read, and whenever the registry has no usable active gateway, the seed is the whole list.
- A failed read keeps the last list (Redis outage fallback), so the list is never empty.
- Registry URLs must be `http://127.0.0.1:<port>/v1` with no credentials, query or fragment, on a port in
  `PTR_GATEWAY_ALLOW` (default `127.0.0.1:56460-56469`; same syntax as `PTR_GATEWAY_UPSTREAM_ALLOW`). This is the same
  §13.4 guard as for engines: anyone with the Redis password can register, and a prompt must never go to an
  unlisted port.
- If two ids share a URL, the later start wins.
- Ignored records are logged once per record version, with the reason only and no URLs: `WARNING gateway registry: N
  record(s) ignored (not_allowed) …`.
- The client checks each listed URL again (loopback and duplicates) at every call.

**Capacity controller Q:** Σ `maxQueue` of the active registered gateways that pass `PTR_GATEWAY_ALLOW`, read every tick;
`PTR_GATEWAY_MAX_QUEUE` when none is active or the read fails (status `qSource`). With H1 (one active gateway) the
standby's queue is counted although only the active one queues in steady state. Q only binds when S_live × headroom
exceeds it (S_live 24 at headroom 0.25 adds 6, far below 256), so this over-count does not matter in practice.

**Per-replica limits (§6.2 amendment):**
- **Failover per-minute ceiling:** each gateway uses floor(`PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE` / k), at least 1.
  k = the active gateways in the registry that pass `PTR_GATEWAY_ALLOW` at its last successful read, itself always
  included (also while draining). In H1 this halves the active gateway's own share while a standby is registered
  (60/min each at the default 120). `failover.perMinuteCap` shows the value in force.
  - **The k-fold bound holds only while k is steady.** Each gateway counts its own rolling minute, so around a change
    of k the sum can exceed one ceiling. Example: a gateway that ran at cap / 2 sees its peer die and moves to cap / 1
    within the minute; a newcomer starts its own empty minute. Expect up to about 1.5–2× one ceiling over the minute
    around a membership change. A dead gateway counts until its record expires (≤ 10 s), and a Redis outage keeps the
    last k.
  - **k is unknown until the first successful registry read**, for example on a cold start during a Redis outage.
    Until then the ceiling is 1 per minute, the most conservative value. BullMQ shares that Redis, so no new turns
    run then anyway (§13.2).
  - A global per-minute check in the Postgres ledger (design S9) would remove both limits.
  - **Registry heartbeat failures are visible (S7 Part A).** A wrong `PTR_REDIS_URL` or password on a gateway used
    to leave k unknown, so the ceiling stayed at 1 per minute without any sign. The gateway now writes one line to
    stderr on the first failed heartbeat and then at most one a minute while failures go on (a flapping Redis is
    limited the same way): `WARNING gateway registry heartbeat failed (<code or error class>): N in a row, M in total; k
    unknown, so the failover per-minute cap is 1` (or `k <n> (last read), so … stays at cap/<n>`). The line carries no
    URL and no error message. `/metrics` has a `registry` object when the gateway is registered: `{id, state, leader,
    active (k, null before the first read), failedBeats, consecutiveFailedBeats}`; `leader` is whether this gateway
    holds the leader hint after its last heartbeat.
- **Telemetry fallback** (one call on a blocked engine with nothing of this gateway in flight) is still per gateway:
  up to k such calls.
- **H2 per-replica credit split S_u / k (`PTR_GATEWAY_SPLIT_CREDIT`): deferred, not implemented (agent decision).**
  Splitting credits on the gateways is a few lines, but on its own it is harmful. Workers send everything to the
  leader (H1 order), so the leader would run at S_u / k and throughput would drop by (k − 1)/k. It needs worker-side
  spreading (hash of the turn id over the active gateways), a credit rule for while k changes (a dead gateway counts
  until its TTL, so the survivors would run at S_u / 2 for up to 10 s), and its own acceptance tests. The design adopts
  it only when gateway CPU is the bottleneck, and nothing has measured that. Active–standby H1 stays the only topology.

| Variable | Default | Meaning |
| --- | --- | --- |
| `PTR_GATEWAY_REGISTRY` | `on` with `PTR_GATEWAY_DISCOVERY=redis`, else `off` | gateway publishes itself (needs `PTR_REDIS_URL`) |
| `PTR_GATEWAY_ID` | `gw-<port>-<random8>` | registry id |
| `PTR_GATEWAY_ADVERTISE_URL` | `http://127.0.0.1:<port>/v1` | URL workers use; checked against `PTR_GATEWAY_ALLOW` |
| `PTR_GATEWAY_ALLOW` | `127.0.0.1:56460-56469` | ports a registry gateway URL may use (gateways, workers, capacity controller) |
| `PTR_GATEWAY_DISCOVERY` (worker) | `static` | `redis`: worker reads the gateway registry; `PTR_GATEWAY_URLS` becomes seed + fallback |
| `PTR_GATEWAY_SHUTDOWN_MS` | 30000 | drain bound for calls already sent upstream |

**Acceptance (zero cost).** Two harnesses were used.

`scripts/gateway-ha-acceptance.ts` runs real gateway processes (pool mode, registry on) in front of in-process fake
engines (2 × 12 slots, about 1.5 s per call). It runs closed-loop worker clients, one client per user, with request
keys and the S1 retry settings, and two `GatewayDirectory`s over the real Redis registry in a `ptrtest:s6<run>:llm`
namespace, deleted afterwards. Each scenario runs for 30 s, and the leader is killed at 10 s.

For D, the gateways run `PTR_GATEWAY_FAILOVER=openrouter` with the real `OpenRouterClient` and Postgres ledger
(tables created in `ptr_loadtest` for the run and dropped afterwards). A preload (`scripts/ha-openrouter-redirect.ts`)
sends openrouter.ai fetches to a fake on loopback and refuses any other external fetch, and the API key is synthetic.
The primary engine is down, so every call goes to the secondary (1.5 s).

`scripts/loadtest.ts crash` runs the full stack (2 APIs, workers, dispatcher, Postgres turns, static
`PTR_GATEWAY_URLS`, 16 users).

Report: `reports/gateway-ha-acceptance-be804406.json` and `reports/loadtest/…-crash/report.json` (private).

| Test | Setup | Result | Bar |
| --- | --- | --- | --- |
| C (HA harness) | 2 gateways, leader SIGKILL, no restart, 16 users | 320 calls, **0 failed**. The 16 in flight were retried on gw-2 (16 engine generations regenerated, no billing). Kill window e2e p95 1518 ms. Leader hint moved after 6.0 s; gw-1's record left the lists after 10.0 s (TTL), until then a refused connect took ~0 ms per call. Q 512 → 256 | 0 failed: **PASS** |
| C (loadtest, full stack) | `--target=gateway --standby-gateway=1 --restart=0` | 231 turns, **0 failed**, 0 orphaned, 16 generating at the kill | **PASS** |
| D (HA harness) | primary engines down, fake billable secondary + ledger, leader SIGKILL during secondary calls | 336 secondary POSTs for 336 distinct bodies: **0 posted twice (no double billing)**. **16 unresolved refusals** (`REQUEST_UNRESOLVED_NO_RESUBMIT` → 502 → the turn fails), exactly the calls in flight on gw-1; their ledger rows stay `submitted`, the other 320 are `settled`. 0 other failures | double billing 0: **PASS**; refusals counted (16) |
| E (HA harness) | SIGTERM drain of the leader with 12 in flight + 12 queued (credit 12/gateway, 24 users) | 282 calls, **0 failed**, 0 regenerated. The 12 queued and 11 later arrivals got `draining` and were served by gw-2 at once. gw-1 exited 0 after 1.55 s (its in-flight calls done). Lists dropped gw-1 and the hint moved after 2.0 s. Q 512 → 256 | 0 failed: **PASS** |
| E (loadtest, full stack) | `--signal=SIGTERM --gateway-concurrency=8`, static URLs | 132 turns, **0 failed**, 0 orphaned. Drain: 8 in flight, 8 queued refused at once, 25 refused while draining in total (static lists keep trying the draining gateway first until it exits) | **PASS** |
| T6 (HA harness) | leader SIGKILL at 10 s, gw-3 registers at 15 s | 320 calls, **0 failed**. Hint moved to gw-2 (the oldest beating) after 6.0 s, and gw-3 stayed standby (0 calls). gw-3 was in the workers' lists 0.8 s after it started. gw-1 left them after 10.0 s. Q 512 → 768 → 512 | workers switch, lists update, 0 failed: **PASS** |

Notes:
- Before the registry record expires, the killed gateway stays at the head of the list. Each call pays one refused
  connect (S1: no wait before an untried URL; 48 of 96 calls in the C kill window show 2 attempts).
- After a drain the deleted record's URL can reappear at the end of the list as a seed URL, which is harmless.
- One run per scenario on one host. These results describe the failover mechanics, not multi-host fault tolerance.

## Sources

-  (operations round 2, §2 demo-mode freeze) and the measurements behind each feature:  (scale
  architecture plan), 35 (scale results), 37 (request routing survey), 38 (multi-server routing design) and 39
  (multi-server routing results), all in the `private design notes` repo under `<private-design-notes>/`.
