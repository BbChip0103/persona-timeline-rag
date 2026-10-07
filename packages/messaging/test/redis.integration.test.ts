import { createRedisConnection } from '../src/redis';

const url = process.env.PTR_REDIS_URL ?? '';
const run = process.env.RUN_REDIS_TESTS === '1' ? describe : describe.skip;

run('isolated Redis (opt-in RUN_REDIS_TESTS=1)', () => {
  it('connects with auth and is configured for BullMQ (noeviction)', async () => {
    const redis = createRedisConnection(url);
    try {
      expect(await redis.ping()).toBe('PONG');
      expect(await redis.config('GET', 'maxmemory-policy')).toEqual(['maxmemory-policy', 'noeviction']);
    } finally { redis.disconnect(); }
  });
});
