import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { CapacityController, RedisCapacityStore } from '../src/capacity-controller';
import { createRedisConnection } from '../src/redis';
import { RedisUpstreamRegistry, parseUpstreamAllow } from '../src/upstream-registry';

const url = process.env.PTR_REDIS_URL ?? '';
const run = process.env.RUN_REDIS_TESTS === '1' ? describe : describe.skip;
const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return Date.now(); await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('condition not met');
};

// BullMQ 6.3.11 global concurrency, the capacity controller's actuator , on the real isolated Redis in
// a throwaway queue under the `ptrtest` prefix (never `ptr:turns`), obliterated afterwards.
run('BullMQ global concurrency (opt-in RUN_REDIS_TESTS=1)', () => {
  it('caps active jobs across a worker; lowering never stops active jobs; raising is picked up within drainDelay', async () => {
    const name = `cap-${randomUUID().slice(0, 8)}`;
    const connection = createRedisConnection(url), blocking = createRedisConnection(url, { blocking: true });
    const queue = new Queue(name, { connection, prefix: 'ptrtest' });
    let running = 0, peak = 0, completed = 0;
    const gates: (() => void)[] = [];
    const worker = new Worker(name, async () => {
      running++; peak = Math.max(peak, running);
      await new Promise<void>((resolve) => gates.push(resolve));
      running--; completed++;
    }, { connection: blocking, prefix: 'ptrtest', concurrency: 8 });
    try {
      expect(await queue.getGlobalConcurrency()).toBeNull(); // no field = unlimited
      await queue.setGlobalConcurrency(2);
      expect(await queue.getGlobalConcurrency()).toBe(2);
      await queue.addBulk(Array.from({ length: 10 }, (_, i) => ({ name: 'job', data: { i } })));
      await until(() => running === 2, 5000);
      await new Promise((r) => setTimeout(r, 1000));
      expect(running).toBe(2); expect(peak).toBe(2);

      // Lower below the active count: nothing is interrupted, no new job starts.
      await queue.setGlobalConcurrency(1);
      await new Promise((r) => setTimeout(r, 1000));
      expect(running).toBe(2);
      gates.shift()!();
      await until(() => completed === 1, 3000);
      await new Promise((r) => setTimeout(r, 1000));
      expect(running).toBe(1); // 1 active = the new limit: no replacement started
      gates.shift()!();
      await until(() => completed === 2 && running === 1, 7000); // the next job starts once below the limit

      // Raise while jobs wait and the worker is held back by the limit.
      const raisedAt = Date.now();
      await queue.setGlobalConcurrency(4);
      const reached = await until(() => running === 4, 7000);
      expect(reached - raisedAt).toBeLessThanOrEqual(5000 + 1500); // drainDelay 5 s + scheduling slack
      expect((await queue.getJobCounts('active')).active).toBe(4);
    } finally {
      for (const gate of gates.splice(0)) gate();
      await worker.close(true);
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close(); connection.disconnect(); blocking.disconnect();
    }
  }, 40000);

  it('controller: one leader writes G to the real queue and the ptr:llm:cap status; the other takes over on release', async () => {
    const run = randomUUID().replace(/-/g, '').slice(0, 12), prefix = `ptrtest:${run}:llm`;
    const redis = createRedisConnection(url);
    const queue = new Queue(`cap-${run}`, { connection: redis, prefix: 'ptrtest' });
    const registry = new RedisUpstreamRegistry(redis, prefix), store = new RedisCapacityStore(redis, prefix);
    const make = (id: string) => new CapacityController({ registry, queue, store, pool: 'm', allow: parseUpstreamAllow(undefined), id, q: 256, log: () => undefined });
    try {
      await registry.heartbeat({ pool: 'm', id: 'a', baseUrl: 'http://127.0.0.1:18000/v1', maxSeqs: 12, kvCapacityTokens: null, weight: 1, state: 'active', epoch: 'e', seq: 0 }, 60000);
      const first = make('d1'), second = make('d2');
      expect(await first.tick()).toMatchObject({ leader: true, g: 15, reason: 'init' });
      expect(await second.tick()).toMatchObject({ leader: false, reason: 'not_leader' });
      expect(await queue.getGlobalConcurrency()).toBe(15);
      expect(await redis.hgetall(`${prefix}:cap`)).toMatchObject({ g: '15', sLive: '12', leader: 'd1', reason: 'init' });
      await first.stop();
      expect(await second.tick()).toMatchObject({ leader: true, g: 15, reason: 'hold' });
      await second.stop();
    } finally {
      await queue.obliterate({ force: true }).catch(() => undefined); await queue.close();
      const keys = await redis.keys(`${prefix}:*`); if (keys.length) await redis.del(...keys);
      redis.disconnect();
    }
  });
});
