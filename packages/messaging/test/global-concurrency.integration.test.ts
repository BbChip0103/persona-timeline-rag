import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { createRedisConnection } from '../src/redis';

const url = process.env.PTR_REDIS_URL ?? '';
const run = process.env.RUN_REDIS_TESTS === '1' ? describe : describe.skip;
const until = async (check: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (check()) return Date.now(); await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('condition not met');
};

// BullMQ global concurrency on isolated Redis; independent of the removed custom capacity controller.
// Uses
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

});
