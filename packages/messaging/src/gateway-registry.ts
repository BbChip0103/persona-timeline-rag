import type { Redis } from 'ioredis';
import { REGISTRY_PREFIX, assertRegistryPrefix, parseAllowRules, type AllowRule } from './upstream-registry.js';

/**
 * LLM gateway registry (routing ; stage S6). Each gateway publishes itself; workers read the list
 * and use it in place of (in front of) the static PTR_GATEWAY_URLS. Layout, under the same `ptr:llm` prefix as the
 * upstream registry (BullMQ uses `ptr:turns:*`):
 *
 *   <prefix>:gw:<id>      HASH {id,url,maxQueue,state(active|draining),startedAt,seq,beatAt}  PEXPIRE ttl (10 s, heartbeat 2 s)
 *   <prefix>:gws          ZSET member=<id> score=expiresAtMs (index without SCAN; writers trim expired entries)
 *   <prefix>:gw:leader    STRING <id>, SET NX PX 5000: the active–standby "use me first" hint (H1). Renewed by its
 *                         holder's heartbeat, given up at once when it drains. Once free it is taken by the OLDEST
 *                         active gateway that is still beating (beatAt within the hint's lease), so a gateway that
 *                         just started never takes over from a running standby (S6 T6 run 1 showed the race).
 *
 * The leader is a hint only: a request sent to a standby is served there just the same. Expiry uses the Redis server
 * clock (TIME in the scripts). Records are not signed (single host): workers check every URL against loopback + the
 * PTR_GATEWAY_ALLOW port allowlist before sending a prompt to it (§13.4), as gateways do for upstream records.
 */
export const GATEWAY_TTL_MS = 10000;
export const GATEWAY_HEARTBEAT_MS = 2000;
export const GATEWAY_LEADER_MS = 5000;
export type GatewayState = 'active' | 'draining';
export interface GatewayRecord {
  id: string;
  /** Base URL workers use (`http://127.0.0.1:<port>/v1`). */
  url: string;
  /** PTR_GATEWAY_MAX_QUEUE of that gateway (the capacity controller's Q sums the active ones). */
  maxQueue: number;
  state: GatewayState;
  /** Process start (ms since epoch): standbys are tried oldest first. */
  startedAt: number;
  seq: number;
  /** Registry clock of the last heartbeat (written by the store; absent in what a gateway sends). */
  beatAt?: number;
}
/** `leader` is the hint's key suffix, so it can never be a gateway id. */
export const GATEWAY_ID = /^(?!leader$)[A-Za-z0-9._-]{1,64}$/;

export function gatewayKeys(prefix = REGISTRY_PREFIX) {
  assertRegistryPrefix(prefix);
  return { record: (id: string) => `${prefix}:gw:${id}`, index: `${prefix}:gws`, leader: `${prefix}:gw:leader` };
}
export function serializeGatewayRecord(record: GatewayRecord): Record<string, string> {
  return { id: record.id, url: record.url, maxQueue: String(record.maxQueue), state: record.state, startedAt: String(record.startedAt), seq: String(record.seq) };
}
const integer = (raw: string | undefined, min: number, max: number) => {
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
};
/** Structure only: whether a worker may send to `url` is checkGatewayUrl's decision. */
export function parseGatewayRecord(hash: Record<string, string>): GatewayRecord {
  const invalid = () => new Error('INVALID_GATEWAY_RECORD');
  const { id, url, state } = hash;
  if (typeof id !== 'string' || !GATEWAY_ID.test(id) || typeof url !== 'string' || url.length > 512 || !URL.canParse(url)
    || (state !== 'active' && state !== 'draining')) throw invalid();
  const maxQueue = integer(hash.maxQueue, 0, 100000), startedAt = integer(hash.startedAt, 0, Number.MAX_SAFE_INTEGER), seq = integer(hash.seq, 0, Number.MAX_SAFE_INTEGER);
  const beatAt = hash.beatAt === undefined ? undefined : integer(hash.beatAt, 0, Number.MAX_SAFE_INTEGER);
  if (maxQueue === undefined || startedAt === undefined || seq === undefined || (hash.beatAt !== undefined && beatAt === undefined)) throw invalid();
  return { id, url, maxQueue, state, startedAt, seq, ...(beatAt !== undefined ? { beatAt } : {}) };
}
/** PTR_GATEWAY_ALLOW: ports a registry gateway URL may use (default 127.0.0.1:56460-56469; the gateway's default port is 56460). */
export function parseGatewayAllow(value: string | undefined): AllowRule[] {
  return parseAllowRules(value ?? '127.0.0.1:56460-56469', 'INVALID_PTR_GATEWAY_ALLOW');
}
/** http://127.0.0.1:<allowlisted port>/v1, no credentials, query or fragment (the worker client's own loopback rule + allowlist). */
export function checkGatewayUrl(raw: string, allow: AllowRule[]): 'not_loopback' | 'not_allowed' | null {
  let url: URL; try { url = new URL(raw); } catch { return 'not_loopback'; }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash
    || !/^\/v1\/?$/.test(url.pathname)) return 'not_loopback';
  const port = Number(url.port);
  return url.port && allow.some((rule) => rule.host === url.hostname && port >= rule.from && port <= rule.to) ? null : 'not_allowed';
}
const origin = (url: string) => new URL(url).origin;
/**
 * Parse + loopback/allowlist + one id per URL: the latest start wins (a gateway restarted on its port under a new id; the
 * old record lingers until its TTL), then the lower id. Sorted by id. `key` counts a rejection once per record version.
 */
export function screenGatewayRecords(hashes: Record<string, string>[], allow: AllowRule[]):
  { records: GatewayRecord[]; rejections: { key: string; reason: string }[] } {
  const parsed: GatewayRecord[] = [], rejections: { key: string; reason: string }[] = [];
  for (const hash of hashes) {
    const key = `${hash.id}\u0000${hash.url}\u0000${hash.startedAt}`;
    let record: GatewayRecord;
    try { record = parseGatewayRecord(hash); } catch { rejections.push({ key, reason: 'invalid_record' }); continue; }
    const reason = checkGatewayUrl(record.url, allow);
    if (reason) { rejections.push({ key, reason }); continue; }
    parsed.push(record);
  }
  const records: GatewayRecord[] = [], seen = new Set<string>();
  const byId = (a: GatewayRecord, b: GatewayRecord) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  for (const record of parsed.sort((a, b) => b.startedAt - a.startedAt || byId(a, b))) {
    if (seen.has(origin(record.url))) { rejections.push({ key: `${record.id}\u0000${record.url}\u0000${record.startedAt}`, reason: 'duplicate_url' }); continue; }
    seen.add(origin(record.url)); records.push(record);
  }
  return { records: records.sort(byId), rejections };
}
/** Active gateways in the order workers try them: the leader hint first, then the oldest start, then the id. */
export function orderGateways(records: GatewayRecord[], leader: string | null): GatewayRecord[] {
  return records.filter((record) => record.state === 'active')
    .sort((a, b) => Number(b.id === leader) - Number(a.id === leader) || a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Store operations shared by gateways (heartbeat, remove) and readers (workers, the capacity controller). */
export interface GatewayRegistryReader { list(): Promise<{ records: Record<string, string>[]; leader: string | null }> }
export interface GatewayRegistryStore extends GatewayRegistryReader {
  /**
   * Publish/refresh with `ttlMs`; an active gateway renews its own leader hint (PX `leaderMs`) or, with `claim` (default
   * true), takes a free one when no older active gateway is still beating; a draining one gives it up. Returns the leader now.
   */
  heartbeat(record: GatewayRecord, ttlMs: number, leaderMs: number, claim?: boolean): Promise<string | null>;
  remove(id: string): Promise<void>;
}

const NOW = `local t = redis.call('TIME') local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)`;
// KEYS: record, index, leader. ARGV: ttlMs, leaderMs, id, state, record key prefix (`<prefix>:gw:`), claim ('1'|'0'),
// field/value pairs. The other records are read by key from the index (one Redis instance; not cluster-safe, like the rest
// of the registry); index members that are not gateway ids (the hint's own name, anything with characters an id cannot
// have) or whose key is not a hash are skipped, so a stray entry can never fail a heartbeat (WRONGTYPE).
const HEARTBEAT = `
${NOW}
local ttl = tonumber(ARGV[1])
local lease = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', '(' .. now)
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], unpack(ARGV, 7))
redis.call('HSET', KEYS[1], 'beatAt', now)
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('ZADD', KEYS[2], now + ttl, ARGV[3])
local leader = redis.call('GET', KEYS[3])
if ARGV[4] == 'active' then
  if not leader and ARGV[6] == '1' then
    local mine = tonumber(redis.call('HGET', KEYS[1], 'startedAt'))
    local older = false
    for _, other in ipairs(redis.call('ZRANGEBYSCORE', KEYS[2], now, '+inf')) do
      if other ~= ARGV[3] and other ~= 'leader' and string.match(other, '^[A-Za-z0-9._-]+$')
        and redis.call('TYPE', ARGV[5] .. other)['ok'] == 'hash' then
        local f = redis.call('HMGET', ARGV[5] .. other, 'state', 'startedAt', 'beatAt')
        local started, beat = tonumber(f[2] or ''), tonumber(f[3] or '')
        if f[1] == 'active' and started and beat and beat >= now - lease and (started < mine or (started == mine and other < ARGV[3])) then older = true break end
      end
    end
    if not older then redis.call('SET', KEYS[3], ARGV[3], 'PX', lease) leader = ARGV[3] end
  elseif leader == ARGV[3] then redis.call('PEXPIRE', KEYS[3], lease) end
elseif leader == ARGV[3] then redis.call('DEL', KEYS[3]) leader = false end
if leader then return leader end
return ''`;
// KEYS: record, index, leader. ARGV: id.
const REMOVE = `
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
if redis.call('GET', KEYS[3]) == ARGV[1] then redis.call('DEL', KEYS[3]) end
return 1`;
// KEYS: index. Live ids by the server clock.
const LIVE = `
${NOW}
return redis.call('ZRANGEBYSCORE', KEYS[1], now, '+inf')`;

/** Redis store; use a fail-fast connection (`createRedisConnection`) so an outage is a rejected call (readers then keep their last list). */
export class RedisGatewayRegistry implements GatewayRegistryStore {
  private readonly keys: ReturnType<typeof gatewayKeys>;
  constructor(private readonly redis: Redis, prefix = REGISTRY_PREFIX) { this.keys = gatewayKeys(prefix); }
  async heartbeat(record: GatewayRecord, ttlMs: number, leaderMs: number, claim = true): Promise<string | null> {
    if (!GATEWAY_ID.test(record.id)) throw new Error('INVALID_GATEWAY_RECORD');
    const leader = (await this.redis.eval(HEARTBEAT, 3, this.keys.record(record.id), this.keys.index, this.keys.leader, String(ttlMs), String(leaderMs),
      record.id, record.state, this.keys.record(''), claim ? '1' : '0', ...Object.entries(serializeGatewayRecord(record)).flat())) as string;
    return leader || null;
  }
  async remove(id: string): Promise<void> {
    if (!GATEWAY_ID.test(id)) throw new Error('INVALID_GATEWAY_RECORD');
    await this.redis.eval(REMOVE, 3, this.keys.record(id), this.keys.index, this.keys.leader, id);
  }
  async list(): Promise<{ records: Record<string, string>[]; leader: string | null }> {
    // Only gateway ids: a stray index member (the hint's name, a bad id) is never read as a record.
    const ids = ((await this.redis.eval(LIVE, 1, this.keys.index)) as string[]).filter((id) => GATEWAY_ID.test(id));
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(this.keys.record(id));
    pipeline.get(this.keys.leader);
    const results = (await pipeline.exec()) ?? [];
    // A non-hash key under a gateway id (WRONGTYPE) is skipped like a missing record; only the hint's GET may fail the read.
    const last = results.at(-1);
    if (last?.[0]) throw last[0];
    const leader = (last?.[1] as string | null) ?? null;
    return { records: results.slice(0, -1).filter(([error]) => !error).map(([, value]) => value as Record<string, string>)
      .filter((hash) => hash && Object.keys(hash).length > 0), leader };
  }
}

/** In-memory store with the same semantics (unit tests, zero-cost harnesses). `advance` moves its clock; `down` fails every call. */
export class MemoryGatewayRegistry implements GatewayRegistryStore {
  down = false;
  private clock = 0;
  private readonly records = new Map<string, { hash: Record<string, string>; expiresAt: number }>();
  private leader: { id: string; expiresAt: number } | undefined;
  advance(ms: number): void { this.clock += ms; }
  private check(): void { if (this.down) throw new Error('REGISTRY_UNAVAILABLE'); }
  private currentLeader(): string | null {
    if (this.leader && this.leader.expiresAt <= this.clock) this.leader = undefined;
    return this.leader?.id ?? null;
  }
  async heartbeat(record: GatewayRecord, ttlMs: number, leaderMs: number, claim = true): Promise<string | null> {
    this.check();
    if (!GATEWAY_ID.test(record.id)) throw new Error('INVALID_GATEWAY_RECORD');
    this.records.set(record.id, { hash: { ...serializeGatewayRecord(record), beatAt: String(this.clock) }, expiresAt: this.clock + ttlMs });
    const leader = this.currentLeader();
    if (record.state === 'active') {
      // A free hint goes to the oldest active gateway still beating (see the key layout above).
      const older = () => [...this.records.entries()].some(([id, entry]) => id !== record.id && entry.expiresAt > this.clock && entry.hash.state === 'active'
        && Number(entry.hash.beatAt) >= this.clock - leaderMs
        && (Number(entry.hash.startedAt) < record.startedAt || (Number(entry.hash.startedAt) === record.startedAt && id < record.id)));
      if (leader === record.id || (leader === null && claim && !older())) this.leader = { id: record.id, expiresAt: this.clock + leaderMs };
    } else if (leader === record.id) this.leader = undefined;
    return this.currentLeader();
  }
  async remove(id: string): Promise<void> {
    this.check();
    this.records.delete(id);
    if (this.currentLeader() === id) this.leader = undefined;
  }
  async list(): Promise<{ records: Record<string, string>[]; leader: string | null }> {
    this.check();
    const records: Record<string, string>[] = [];
    for (const [id, entry] of [...this.records]) {
      if (entry.expiresAt <= this.clock) { this.records.delete(id); continue; }
      records.push({ ...entry.hash });
    }
    return { records, leader: this.currentLeader() };
  }
}

export interface GatewayDirectoryOptions {
  /** Static PTR_GATEWAY_URLS (or PTR_GATEWAY_URL): the list until the registry was read, the fallback when it has no active gateway, appended last otherwise. */
  seed: string[];
  /** PTR_GATEWAY_ALLOW. */
  allow: AllowRule[];
  /** Refresh interval (default 2000). */
  pollMs?: number;
  /** Operator lines (default stderr); reasons only, never URLs. */
  log?: (line: string) => void;
}
export interface GatewayDirectoryMetrics {
  stale: boolean; failedPolls: number; rejected: number; leader: string | null;
  /** Active registry gateways in the current list. */
  active: number;
}
/**
 * Worker side (PTR_GATEWAY_DISCOVERY=redis): `urls()` is the gateway list a call walks in order. Registry gateways that
 * pass the policy come first (leader → oldest start), then any seed URL the registry does not know (a gateway without
 * the registry, or a K8s Service address); a seed URL whose gateway is draining is left out. Before the first read
 * and while the registry lists no usable active gateway the seed is the list. A failed read keeps the last list
 * (Redis outage): the list is never empty.
 */
export class GatewayDirectory {
  private current: string[];
  private timer: NodeJS.Timeout | undefined;
  private polling: Promise<void> | undefined;
  private stale = false; private failedPolls = 0; private rejected = 0; private leader: string | null = null; private active = 0;
  private readonly rejectedKeys = new Set<string>();
  constructor(private readonly reader: GatewayRegistryReader, private readonly options: GatewayDirectoryOptions) {
    if (!options.seed.length) throw new Error('GATEWAY_SEED_REQUIRED');
    this.current = [...options.seed];
  }
  urls(): string[] { return this.current; }
  async start(): Promise<void> {
    await this.poll();
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.options.pollMs ?? GATEWAY_HEARTBEAT_MS); this.timer.unref();
  }
  /** One read; overlapping calls join the running one. */
  poll(): Promise<void> {
    this.polling ??= this.pollOnce().finally(() => { this.polling = undefined; });
    return this.polling;
  }
  private async pollOnce(): Promise<void> {
    let listed: { records: Record<string, string>[]; leader: string | null };
    try { listed = await this.reader.list(); } catch { this.failedPolls++; this.stale = true; return; }
    this.stale = false;
    const { records, rejections } = screenGatewayRecords(listed.records, this.options.allow);
    const fresh = rejections.filter(({ key }) => !this.rejectedKeys.has(key));
    for (const { key } of fresh) { if (this.rejectedKeys.size >= 10000) this.rejectedKeys.clear(); this.rejectedKeys.add(key); }
    if (fresh.length) {
      this.rejected += fresh.length;
      (this.options.log ?? ((line: string) => process.stderr.write(`${line}\n`)))(
        `WARNING gateway registry: ${fresh.length} record(s) ignored (${[...new Set(fresh.map((r) => r.reason))].sort().join(',')}); check PTR_GATEWAY_ALLOW`);
    }
    const ordered = orderGateways(records, listed.leader);
    const draining = new Set(records.filter((record) => record.state === 'draining').map((record) => origin(record.url)));
    const listedOrigins = new Set(ordered.map((record) => origin(record.url)));
    const seeds = this.options.seed.filter((url) => !listedOrigins.has(origin(url)) && !draining.has(origin(url)));
    this.leader = ordered.some((record) => record.id === listed.leader) ? listed.leader : null;
    this.active = ordered.length;
    const next = ordered.length ? [...ordered.map((record) => record.url), ...seeds] : seeds.length ? seeds : [...this.options.seed];
    if (next.length !== this.current.length || next.some((url, i) => url !== this.current[i])) this.current = next;
  }
  async close(): Promise<void> { clearInterval(this.timer); this.timer = undefined; await this.polling?.catch(() => undefined); }
  metrics(): GatewayDirectoryMetrics {
    return { stale: this.stale, failedPolls: this.failedPolls, rejected: this.rejected, leader: this.leader, active: this.active };
  }
}

export interface GatewayPublisherOptions {
  id: string; url: string; maxQueue: number; startedAt: number;
  /** PTR_GATEWAY_ALLOW: k counts only gateway records the workers would use. */
  allow: AllowRule[];
  ttlMs?: number; heartbeatMs?: number; leaderMs?: number;
  /**
   * Successful heartbeats in a row (by time) before this gateway may take a FREE leader hint (default: the hint's lease,
   * `leaderMs`). A gateway that just started, or just got Redis back, first proves it can keep the hint alive.
   */
  claimAfterMs?: number;
  now?: () => number;
}
/**
 * Gateway side: publishes this gateway every `heartbeatMs` (2 s, TTL 10 s), takes or renews the leader hint while
 * active (a free one only after `claimAfterMs` of successful heartbeats), and after each heartbeat reads the list to know
 * k = the active gateways that pass PTR_GATEWAY_ALLOW (itself always counted), which splits per-process limits such as
 * the failover per-minute cap. k is null (unknown) until the first successful read. A registry error never throws from
 * a heartbeat: the gateway keeps serving, k stays at its last value, and the record expires if the outage outlasts the TTL.
 */
export class GatewayPublisher {
  private state: GatewayState = 'active';
  private seq = 0; private k: number | null = null; private leading = false; private failedBeats = 0;
  /** Start of the current run of successful heartbeats (undefined after a failure). */
  private goodSince: number | undefined;
  private timer: NodeJS.Timeout | undefined; private beating: Promise<void> | undefined; private stopped = false;
  constructor(private readonly store: GatewayRegistryStore, private readonly options: GatewayPublisherOptions) {
    if (!GATEWAY_ID.test(options.id)) throw new Error('INVALID_PTR_GATEWAY_ID');
  }
  async start(): Promise<void> {
    await this.beat();
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => void this.beat(), this.options.heartbeatMs ?? GATEWAY_HEARTBEAT_MS); this.timer.unref();
  }
  /** One heartbeat + list read; overlapping calls join. */
  beat(): Promise<void> {
    this.beating ??= this.beatOnce().finally(() => { this.beating = undefined; });
    return this.beating;
  }
  private async beatOnce(): Promise<void> {
    if (this.stopped) return;
    const record: GatewayRecord = { id: this.options.id, url: this.options.url, maxQueue: this.options.maxQueue, state: this.state,
      startedAt: this.options.startedAt, seq: this.seq++ };
    const now = (this.options.now ?? Date.now)(), leaderMs = this.options.leaderMs ?? GATEWAY_LEADER_MS;
    try {
      const claim = now - (this.goodSince ?? now) >= (this.options.claimAfterMs ?? leaderMs);
      const leader = await this.store.heartbeat(record, this.options.ttlMs ?? GATEWAY_TTL_MS, leaderMs, claim);
      this.goodSince ??= now;
      this.leading = leader === this.options.id;
      const { records } = await this.store.list();
      const active = new Set<string>([this.options.id]);
      for (const parsed of screenGatewayRecords(records, this.options.allow).records) if (parsed.state === 'active') active.add(parsed.id);
      this.k = active.size;
    } catch { this.failedBeats++; this.goodSince = undefined; }
  }
  /** Drain: the record says draining (workers drop it on their next read) and the leader hint is given up now. */
  async setDraining(): Promise<void> {
    this.state = 'draining';
    await this.beating?.catch(() => undefined);
    await this.beat();
  }
  /**
   * Stops heartbeats and deletes the record (workers drop it on their next read instead of after the TTL). False when
   * the delete failed (the record then expires after its TTL); never throws.
   */
  async stop(): Promise<boolean> {
    clearInterval(this.timer); this.timer = undefined;
    await this.beating?.catch(() => undefined);
    this.stopped = true;
    return this.store.remove(this.options.id).then(() => true, () => false);
  }
  /** k: active gateways in the registry at the last successful read, this one always included; null before the first. */
  activeGateways(): number | null { return this.k; }
  metrics(): { id: string; state: GatewayState; leader: boolean; active: number | null; failedBeats: number } {
    return { id: this.options.id, state: this.state, leader: this.leading, active: this.k, failedBeats: this.failedBeats };
  }
}
