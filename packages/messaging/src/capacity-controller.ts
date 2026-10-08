import type { Redis } from 'ioredis';
import { REGISTRY_PREFIX, registryKeys, screenUpstreamRecords, type AllowRule, type RegistryReader } from './upstream-registry.js';

/**
 * Capacity controller (routing ): keeps BullMQ's global concurrency G of the turn queue at
 *
 *   G* = max(FLOOR, min(ceil(S_live × (1 + headroom)), S_live + Q))
 *
 * where S_live = Σ maxSeqs of the pool's active, unexpired, allowlisted registry records (draining excluded, slow start
 * ignored: the gateway absorbs the ramp in its own wait) and Q = the gateway queue bound. A turn makes one model call at
 * a time, so active turns ≤ G ≤ Σ caps + queue: the operating rule holds by construction. G is checked in BullMQ's
 * Lua when a worker takes a job, and lowering it never interrupts active jobs (verified by the opt-in BullMQ test).
 */
export type CapacityReason = 'init' | 'increase' | 'hold' | 'decrease_pending' | 'decrease' | 'draining' | 'registry_stale';
export interface CapacityDecision { target: number | null; next: number | null; reason: CapacityReason }

export function capacityTarget(input: { sLive: number; q: number; headroom: number; floor: number }): number {
  return Math.max(input.floor, Math.min(Math.ceil(input.sLive * (1 + input.headroom)), input.sLive + input.q));
}

/**
 * Hysteresis: increases apply at once; a decrease applies only after `decreaseTicks` (3) consecutive ticks with a lower
 * target, then at most `maxDecreaseFraction` (25%, at least 1) per tick, so a record flapping on its TTL never makes
 * throughput oscillate. A newly draining upstream (a planned shrink) lowers G at once. Ticks without a readable registry
 * hold G and never count toward a decrease (§13.2 freeze).
 */
export class CapacityPlanner {
  private lowTicks = 0;
  private draining = new Set<string>();
  private readonly options: { q: number; headroom: number; floor: number; decreaseTicks: number; maxDecreaseFraction: number };
  constructor(options: { q: number; headroom?: number; floor?: number; decreaseTicks?: number; maxDecreaseFraction?: number }) {
    // `undefined` (an unset option passed through) must not override a default.
    this.options = { q: options.q, headroom: options.headroom ?? 0.25, floor: options.floor ?? 1, decreaseTicks: options.decreaseTicks ?? 3,
      maxDecreaseFraction: options.maxDecreaseFraction ?? 0.25 };
  }
  step(input: { sLive: number | null; draining: string[]; current: number | null }): CapacityDecision {
    if (input.sLive === null) return { target: null, next: input.current, reason: 'registry_stale' };
    const target = capacityTarget({ sLive: input.sLive, q: this.options.q, headroom: this.options.headroom, floor: this.options.floor });
    const newlyDraining = input.draining.some((id) => !this.draining.has(id));
    this.draining = new Set(input.draining);
    const { current } = input;
    if (current === null) { this.lowTicks = 0; return { target, next: target, reason: 'init' }; }
    if (target > current) { this.lowTicks = 0; return { target, next: target, reason: 'increase' }; }
    if (target === current) { this.lowTicks = 0; return { target, next: current, reason: 'hold' }; }
    if (newlyDraining) { this.lowTicks = 0; return { target, next: target, reason: 'draining' }; }
    if (++this.lowTicks < this.options.decreaseTicks) return { target, next: current, reason: 'decrease_pending' };
    const step = Math.min(current - 1, Math.ceil(current * (1 - this.options.maxDecreaseFraction)));
    return { target, next: Math.max(target, step), reason: 'decrease' };
  }
}

/** The BullMQ Queue methods the controller uses. */
export interface CapacityQueue {
  getGlobalConcurrency(): Promise<number | null>;
  setGlobalConcurrency(concurrency: number): Promise<unknown>;
  getJobCounts(...types: ('active' | 'wait')[]): Promise<Record<string, number>>;
}
/** Leader lock and status hash. */
export interface CapacityStore {
  acquireLeader(id: string, ttlMs: number): Promise<boolean>;
  releaseLeader(id: string): Promise<void>;
  writeStatus(fields: Record<string, string>): Promise<void>;
}
// KEYS: lock. ARGV: id, ttlMs. Take a free lock or renew our own.
const ACQUIRE = `
local holder = redis.call('GET', KEYS[1])
if holder == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]) return 1 end
if not holder then redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]) return 1 end
return 0`;
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end return 1`;
/** `<prefix>:cap:leader` (SET NX PX) and `<prefix>:cap` HASH {target,sLive,q,g,active,wait,computedAt,reason,writes,leader,...}. */
export class RedisCapacityStore implements CapacityStore {
  private readonly lock: string; private readonly status: string;
  constructor(private readonly redis: Redis, prefix = REGISTRY_PREFIX) {
    registryKeys(prefix); // validates the prefix
    this.lock = `${prefix}:cap:leader`; this.status = `${prefix}:cap`;
  }
  async acquireLeader(id: string, ttlMs: number): Promise<boolean> {
    return (await this.redis.eval(ACQUIRE, 1, this.lock, id, String(ttlMs))) === 1;
  }
  async releaseLeader(id: string): Promise<void> { await this.redis.eval(RELEASE, 1, this.lock, id); }
  async writeStatus(fields: Record<string, string>): Promise<void> {
    // Ages out if no controller runs any more (a stale status would look current).
    await this.redis.multi().hset(this.status, fields).pexpire(this.status, 60000).exec();
  }
}
export class MemoryCapacityStore implements CapacityStore {
  leader: string | undefined;
  status: Record<string, string> = {};
  async acquireLeader(id: string): Promise<boolean> { if (this.leader === undefined || this.leader === id) { this.leader = id; return true; } return false; }
  async releaseLeader(id: string): Promise<void> { if (this.leader === id) this.leader = undefined; }
  async writeStatus(fields: Record<string, string>): Promise<void> { this.status = { ...this.status, ...fields }; }
}

export interface CapacityStatus {
  leader: boolean; sLive: number | null; target: number | null; g: number | null; q: number;
  active: number | null; wait: number | null; reason: CapacityReason | 'not_leader' | 'redis_unavailable';
  writes: number; registryStale: boolean; workerShortage: boolean; computedAt: number;
}
export interface CapacityControllerOptions {
  registry: RegistryReader; queue: CapacityQueue; store: CapacityStore;
  pool: string; allow: AllowRule[]; id: string;
  q: number; headroom?: number; floor?: number; intervalMs?: number; leaderTtlMs?: number;
  /** `wait > 0` while `active < G` this long raises worker_shortage (default 15 s): add workers. */
  shortageMs?: number;
  log?: (line: string) => void; now?: () => number;
}
/** One controller per pool/queue; any number may run (one leader acts). `tick` runs every `intervalMs` (5 s). */
export class CapacityController {
  private readonly planner: CapacityPlanner;
  private readonly now: () => number;
  private writes = 0; private shortageSince: number | undefined; private shortageLogged = false;
  private lastLogged: string | undefined; private timer: NodeJS.Timeout | undefined; private running: Promise<unknown> | undefined;
  constructor(private readonly options: CapacityControllerOptions) {
    this.planner = new CapacityPlanner({ q: options.q, headroom: options.headroom, floor: options.floor });
    this.now = options.now ?? Date.now;
  }
  private log(line: string): void { (this.options.log ?? ((text: string) => process.stderr.write(`${text}\n`)))(line); }
  async tick(): Promise<CapacityStatus> {
    const o = this.options, now = this.now();
    const base = { q: o.q, writes: this.writes, computedAt: now, workerShortage: false };
    let leader: boolean;
    try { leader = await o.store.acquireLeader(o.id, o.leaderTtlMs ?? 15000); }
    catch { return { ...base, leader: false, sLive: null, target: null, g: null, active: null, wait: null, reason: 'redis_unavailable', registryStale: true }; }
    if (!leader) return { ...base, leader: false, sLive: null, target: null, g: null, active: null, wait: null, reason: 'not_leader', registryStale: false };
    let sLive: number | null = null, draining: string[] = [];
    try {
      const { records } = screenUpstreamRecords((await o.registry.list(o.pool)).records, o.pool, o.allow);
      sLive = records.filter((r) => r.state === 'active').reduce((sum, r) => sum + r.maxSeqs, 0);
      draining = records.filter((r) => r.state === 'draining').map((r) => r.id);
    } catch { sLive = null; }
    const current = await o.queue.getGlobalConcurrency();
    const counts = await o.queue.getJobCounts('active', 'wait');
    const decision = this.planner.step({ sLive, draining, current });
    if (decision.next !== null && decision.next !== current) { await o.queue.setGlobalConcurrency(decision.next); this.writes++; }
    const g = decision.next ?? current, active = counts.active ?? 0, wait = counts.wait ?? 0;
    if (wait > 0 && g !== null && active < g) this.shortageSince ??= now; else { this.shortageSince = undefined; this.shortageLogged = false; }
    const workerShortage = this.shortageSince !== undefined && now - this.shortageSince >= (o.shortageMs ?? 15000);
    if (workerShortage && !this.shortageLogged) {
      this.shortageLogged = true;
      this.log(`WARNING worker_shortage: ${wait} turns wait while ${active} < G=${g} run (15 s+): add workers or raise PTR_WORKER_CONCURRENCY`);
    }
    const status: CapacityStatus = { ...base, writes: this.writes, leader: true, sLive, target: decision.target, g, active, wait,
      reason: decision.reason, registryStale: sLive === null, workerShortage };
    const summary = `capacity G=${g ?? 'unset'} target=${decision.target ?? '-'} S_live=${sLive ?? '-'} Q=${o.q} active=${active} wait=${wait} reason=${decision.reason}`;
    const key = `${g}|${sLive === null}`;
    if (key !== this.lastLogged) { this.lastLogged = key; this.log(summary); }
    await o.store.writeStatus({ target: String(decision.target ?? ''), sLive: String(sLive ?? ''), q: String(o.q), g: String(g ?? ''),
      active: String(active), wait: String(wait), computedAt: String(now), reason: decision.reason, writes: String(this.writes),
      leader: o.id, registryStale: String(sLive === null), workerShortage: String(workerShortage) }).catch(() => undefined);
    return status;
  }
  start(): void {
    if (this.timer) return;
    const run = () => { if (this.running) return; this.running = this.tick().catch(() => undefined).finally(() => { this.running = undefined; }); };
    run();
    this.timer = setInterval(run, this.options.intervalMs ?? 5000); this.timer.unref();
  }
  async stop(): Promise<void> {
    clearInterval(this.timer); this.timer = undefined;
    await this.running;
    await this.options.store.releaseLeader(this.options.id).catch(() => undefined);
  }
}

/** PTR_CAPACITY_CONTROLLER: on | off | clear (remove a previously set G); default on with PTR_GATEWAY_DISCOVERY=redis, else off. */
export function capacityControllerMode(env: NodeJS.ProcessEnv): 'on' | 'off' | 'clear' {
  const value = env.PTR_CAPACITY_CONTROLLER ?? (env.PTR_GATEWAY_DISCOVERY === 'redis' ? 'on' : 'off');
  if (value !== 'on' && value !== 'off' && value !== 'clear') throw new Error('INVALID_PTR_CAPACITY_CONTROLLER');
  return value;
}
