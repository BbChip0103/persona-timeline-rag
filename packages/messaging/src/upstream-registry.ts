import type { Redis } from 'ioredis';
import { REDIS_PREFIX } from './redis.js';

/**
 * GPU server (upstream) registry in Redis (routing ). Each engine's `ptr-upstream-agent` publishes one
 * HASH with a TTL and refreshes it by heartbeat; gateways poll the per-pool ZSET index (score = expiry) and are nudged
 * over pub/sub. Layout, under `ptr:llm` (BullMQ uses `ptr:turns:*`, turn events `ptr:events:*`):
 *
 *   <prefix>:up:<pool>:<id>   HASH {pool,id,baseUrl,maxSeqs,kvCapacityTokens,weight,state,epoch,seq}  PEXPIRE ttl
 *   <prefix>:ups:<pool>       ZSET member=<id> score=expiresAtMs (index without SCAN; expired entries are trimmed by writers)
 *   <prefix>:reg:ver          INCR on every membership or field change
 *   <prefix>:reg              PUB/SUB channel, empty message: "poll now"
 *
 * Records are not signed (single host; anyone with the Redis password can register). Gateways therefore check every
 * record's `baseUrl` against their own loopback + port allowlist before sending anything to it (§13.4).
 */
export const REGISTRY_PREFIX = `${REDIS_PREFIX}:llm`;
export const REGISTRY_TTL_MS = 10000;
export const REGISTRY_HEARTBEAT_MS = 2000;

export type UpstreamState = 'active' | 'draining';
export interface UpstreamRecord {
  pool: string; id: string; baseUrl: string;
  /** Concurrent sequences the gateway may send (pool default 12). */
  maxSeqs: number;
  /** KV cache capacity read from the engine, null when unknown (used by credit admission, a later stage). */
  kvCapacityTokens: number | null;
  weight: number; state: UpstreamState;
  /** New for every engine process start: a new epoch is a new upstream (fresh breaker, slow start). */
  epoch: string;
  /** Heartbeat counter of the publishing agent. */
  seq: number;
}
export type HeartbeatResult = 'created' | 'changed' | 'active' | 'draining';

/** What a gateway needs: the live records of one pool (raw HASH fields; parse and validate them) and change nudges. */
export interface RegistryReader {
  list(pool: string): Promise<{ records: Record<string, string>[]; version: number }>;
  /** Resolves once subscribed; the returned function unsubscribes. */
  subscribe(onNudge: () => void): Promise<() => Promise<void>>;
}
/** What the agent and the operator CLI need. */
export interface RegistryWriter {
  /**
   * Publish/refresh `record` (with its own `state`) with `ttlMs`. A record already set to draining for the same epoch
   * keeps `state=draining` (only its TTL and seq are refreshed) and the result is 'draining'; a draining agent sends
   * `state:'draining'`, so a record that expired meanwhile is recreated draining, never active. 'created': new id or new
   * epoch; 'changed': a field other than seq changed (including active → draining); both bump the version and nudge.
   */
  heartbeat(record: UpstreamRecord, ttlMs: number): Promise<HeartbeatResult>;
  /** Mark a live record draining; false when there is none. */
  setState(pool: string, id: string, state: 'draining'): Promise<boolean>;
  /** Delete a record, only if its epoch matches when `epoch` is given. */
  remove(pool: string, id: string, epoch?: string): Promise<boolean>;
  /** Pools with at least one live index entry. */
  pools(): Promise<string[]>;
}

export const POOL_NAME = /^[A-Za-z0-9._/-]{1,128}$/;
export const UPSTREAM_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const EPOCH = /^[A-Za-z0-9._-]{1,64}$/;
const FIELDS = ['pool', 'id', 'baseUrl', 'maxSeqs', 'kvCapacityTokens', 'weight', 'state', 'epoch', 'seq'] as const;

/** `ptr:llm` or a dedicated test namespace such as `ptrtest:<run>:llm`; always ends in `:llm`, so it can never touch BullMQ keys. */
export function assertRegistryPrefix(prefix: string): string {
  if (prefix.length > 64 || !/^(?:[A-Za-z0-9_-]+:)+llm$/.test(prefix)) throw new Error('INVALID_REGISTRY_PREFIX');
  return prefix;
}
export function registryKeys(prefix = REGISTRY_PREFIX) {
  assertRegistryPrefix(prefix);
  return {
    record: (pool: string, id: string) => `${prefix}:up:${pool}:${id}`,
    index: (pool: string) => `${prefix}:ups:${pool}`,
    indexPattern: `${prefix}:ups:*`,
    version: `${prefix}:reg:ver`,
    channel: `${prefix}:reg`,
  };
}

export function serializeUpstreamRecord(record: UpstreamRecord): Record<string, string> {
  return { pool: record.pool, id: record.id, baseUrl: record.baseUrl, maxSeqs: String(record.maxSeqs),
    kvCapacityTokens: record.kvCapacityTokens === null ? '' : String(record.kvCapacityTokens), weight: String(record.weight),
    state: record.state, epoch: record.epoch, seq: String(record.seq) };
}
const integer = (raw: string | undefined, min: number, max: number) => {
  const value = Number(raw);
  return raw !== undefined && raw !== '' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
};
/** Structure only: the gateway separately decides whether it may send to `baseUrl` (loopback + allowlist). */
export function parseUpstreamRecord(hash: Record<string, string>): UpstreamRecord {
  const invalid = () => new Error('INVALID_UPSTREAM_RECORD');
  if (FIELDS.some((field) => typeof hash[field] !== 'string')) throw invalid();
  const { pool, id, baseUrl, state, epoch } = hash as Record<(typeof FIELDS)[number], string>;
  if (!POOL_NAME.test(pool) || !UPSTREAM_ID.test(id) || !EPOCH.test(epoch) || (state !== 'active' && state !== 'draining')) throw invalid();
  if (baseUrl.length > 512 || !URL.canParse(baseUrl)) throw invalid();
  const maxSeqs = integer(hash.maxSeqs, 1, 4096), seq = integer(hash.seq, 0, Number.MAX_SAFE_INTEGER);
  const kv = hash.kvCapacityTokens === '' ? null : integer(hash.kvCapacityTokens, 1, 1e10);
  const weight = Number(hash.weight);
  if (maxSeqs === undefined || seq === undefined || kv === undefined || !(weight > 0 && weight <= 100)) throw invalid();
  return { pool, id, baseUrl, maxSeqs, kvCapacityTokens: kv, weight, state, epoch, seq };
}

// KEYS: record, index, version. ARGV: ttlMs, nowMs, epoch, id, channel, field/value pairs (the publisher's state included).
const HEARTBEAT = `
local state = redis.call('HGET', KEYS[1], 'state')
local epoch = redis.call('HGET', KEYS[1], 'epoch')
local ttl = tonumber(ARGV[1])
local expires = tonumber(ARGV[2]) + ttl
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', '(' .. ARGV[2])
if state == 'draining' and epoch == ARGV[3] then
  for i = 6, #ARGV, 2 do if ARGV[i] == 'seq' then redis.call('HSET', KEYS[1], 'seq', ARGV[i + 1]) end end
  redis.call('PEXPIRE', KEYS[1], ttl)
  redis.call('ZADD', KEYS[2], expires, ARGV[4])
  return 'draining'
end
local result = 'active'
if not state or epoch ~= ARGV[3] then
  result = 'created'
else
  for i = 6, #ARGV, 2 do
    if ARGV[i] ~= 'seq' and redis.call('HGET', KEYS[1], ARGV[i]) ~= ARGV[i + 1] then result = 'changed' end
  end
end
if result == 'created' then redis.call('DEL', KEYS[1]) end
redis.call('HSET', KEYS[1], unpack(ARGV, 6))
redis.call('PEXPIRE', KEYS[1], ttl)
redis.call('ZADD', KEYS[2], expires, ARGV[4])
if result ~= 'active' then
  redis.call('INCR', KEYS[3])
  redis.call('PUBLISH', ARGV[5], '')
end
return result`;
// KEYS: record, version. ARGV: channel.
const SET_DRAINING = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('HSET', KEYS[1], 'state', 'draining')
redis.call('INCR', KEYS[2])
redis.call('PUBLISH', ARGV[1], '')
return 1`;
// KEYS: record, index, version. ARGV: id, channel, epoch ('' = any).
const REMOVE = `
local epoch = redis.call('HGET', KEYS[1], 'epoch')
if not epoch then redis.call('ZREM', KEYS[2], ARGV[1]) return 0 end
if ARGV[3] ~= '' and epoch ~= ARGV[3] then return 0 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('INCR', KEYS[3])
redis.call('PUBLISH', ARGV[2], '')
return 1`;

/**
 * Redis store. Use a non-blocking connection (`createRedisConnection`, fail fast) so a Redis outage surfaces as a
 * rejected call: gateways then freeze their membership and agents keep retrying.
 */
export class RedisUpstreamRegistry implements RegistryReader, RegistryWriter {
  private readonly keys: ReturnType<typeof registryKeys>;
  constructor(private readonly redis: Redis, prefix = REGISTRY_PREFIX, private readonly now: () => number = Date.now) {
    this.keys = registryKeys(prefix);
  }
  async heartbeat(record: UpstreamRecord, ttlMs: number): Promise<HeartbeatResult> {
    const fields = Object.entries(serializeUpstreamRecord(record)).flat();
    return (await this.redis.eval(HEARTBEAT, 3, this.keys.record(record.pool, record.id), this.keys.index(record.pool), this.keys.version,
      String(ttlMs), String(this.now()), record.epoch, record.id, this.keys.channel, ...fields)) as HeartbeatResult;
  }
  async setState(pool: string, id: string, _state: 'draining'): Promise<boolean> {
    return (await this.redis.eval(SET_DRAINING, 2, this.keys.record(pool, id), this.keys.version, this.keys.channel)) === 1;
  }
  async remove(pool: string, id: string, epoch?: string): Promise<boolean> {
    return (await this.redis.eval(REMOVE, 3, this.keys.record(pool, id), this.keys.index(pool), this.keys.version,
      id, this.keys.channel, epoch ?? '')) === 1;
  }
  async list(pool: string): Promise<{ records: Record<string, string>[]; version: number }> {
    const ids = await this.redis.zrangebyscore(this.keys.index(pool), this.now(), '+inf');
    const pipeline = this.redis.pipeline();
    for (const id of ids) pipeline.hgetall(this.keys.record(pool, id));
    pipeline.get(this.keys.version);
    const results = (await pipeline.exec()) ?? [];
    const failed = results.find(([error]) => error);
    if (failed) throw failed[0];
    const version = Number(results.at(-1)?.[1] ?? 0) || 0;
    const records = results.slice(0, -1).map(([, value]) => value as Record<string, string>).filter((hash) => Object.keys(hash).length > 0);
    return { records, version };
  }
  async subscribe(onNudge: () => void): Promise<() => Promise<void>> {
    // Subscriber mode needs its own connection; ioredis re-subscribes after reconnecting.
    const subscriber = this.redis.duplicate();
    const channel = this.keys.channel;
    subscriber.on('message', (received: string) => { if (received === channel) onNudge(); });
    subscriber.on('error', () => undefined); // reconnects on its own; polling covers lost nudges
    try { await subscriber.subscribe(channel); } catch (error) { subscriber.disconnect(); throw error; }
    return async () => { subscriber.disconnect(); };
  }
  async pools(): Promise<string[]> {
    const pools = new Set<string>();
    let cursor = '0';
    const at = this.keys.index('').length;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', this.keys.indexPattern, 'COUNT', 100);
      cursor = next;
      for (const key of keys) if (await this.redis.zcount(key, this.now(), '+inf')) pools.add(key.slice(at));
    } while (cursor !== '0');
    return [...pools];
  }
}

/**
 * In-memory store with the same semantics, for unit tests and the zero-cost acceptance harness. `advance` moves its
 * clock; `down` makes every call reject like an unreachable Redis.
 */
export class MemoryUpstreamRegistry implements RegistryReader, RegistryWriter {
  down = false;
  private clock = 0;
  private version = 0;
  private readonly records = new Map<string, { hash: Record<string, string>; expiresAt: number }>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly clockSource?: () => number) {}
  now(): number { return this.clockSource ? this.clockSource() : this.clock; }
  advance(ms: number): void { this.clock += ms; }
  private check(): void { if (this.down) throw new Error('REGISTRY_UNAVAILABLE'); }
  private live(key: string) {
    const entry = this.records.get(key);
    if (entry && entry.expiresAt <= this.now()) { this.records.delete(key); return undefined; }
    return entry;
  }
  private changed(): void { this.version++; for (const listener of [...this.listeners]) queueMicrotask(listener); }
  async heartbeat(record: UpstreamRecord, ttlMs: number): Promise<HeartbeatResult> {
    this.check();
    const key = `${record.pool}\u0000${record.id}`, existing = this.live(key);
    const hash = serializeUpstreamRecord(record);
    const expiresAt = this.now() + ttlMs;
    if (existing?.hash.state === 'draining' && existing.hash.epoch === record.epoch) {
      existing.hash.seq = hash.seq!; existing.expiresAt = expiresAt;
      return 'draining';
    }
    const result: HeartbeatResult = !existing || existing.hash.epoch !== record.epoch ? 'created'
      : Object.entries(hash).some(([field, value]) => field !== 'seq' && existing.hash[field] !== value) ? 'changed' : 'active';
    this.records.set(key, { hash, expiresAt });
    if (result !== 'active') this.changed();
    return result;
  }
  async setState(pool: string, id: string, state: 'draining'): Promise<boolean> {
    this.check();
    const entry = this.live(`${pool}\u0000${id}`);
    if (!entry) return false;
    entry.hash.state = state; this.changed();
    return true;
  }
  async remove(pool: string, id: string, epoch?: string): Promise<boolean> {
    this.check();
    const key = `${pool}\u0000${id}`, entry = this.live(key);
    if (!entry || (epoch !== undefined && entry.hash.epoch !== epoch)) return false;
    this.records.delete(key); this.changed();
    return true;
  }
  async list(pool: string): Promise<{ records: Record<string, string>[]; version: number }> {
    this.check();
    const records: Record<string, string>[] = [];
    for (const key of [...this.records.keys()]) {
      const entry = this.live(key);
      if (entry && entry.hash.pool === pool) records.push({ ...entry.hash });
    }
    return { records, version: this.version };
  }
  async subscribe(onNudge: () => void): Promise<() => Promise<void>> {
    this.check();
    this.listeners.add(onNudge);
    return async () => { this.listeners.delete(onNudge); };
  }
  async pools(): Promise<string[]> {
    this.check();
    const pools = new Set<string>();
    for (const key of [...this.records.keys()]) { const entry = this.live(key); if (entry) pools.add(entry.hash.pool!); }
    return [...pools];
  }
}
