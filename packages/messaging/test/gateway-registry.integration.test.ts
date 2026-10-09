import { randomUUID } from 'node:crypto';
import { createRedisConnection } from '../src/redis';
import { RedisGatewayRegistry } from '../src/gateway-registry';
import { gatewayRegistryContract } from './gateway-registry.contract';

const url = process.env.PTR_REDIS_URL ?? '';
const enabled = process.env.RUN_REDIS_TESTS === '1';

// Opt-in (RUN_REDIS_TESTS=1): the gateway registry Lua scripts against the isolated Redis, each test in its own
// `ptrtest:<uuid>:llm` namespace (never the live `ptr:llm`), deleted afterwards.
if (enabled) {
  gatewayRegistryContract('redis (opt-in RUN_REDIS_TESTS=1)', async () => {
    const redis = createRedisConnection(url);
    const prefix = `ptrtest:${randomUUID().replace(/-/g, '')}:llm`;
    return {
      store: new RedisGatewayRegistry(redis, prefix),
      wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      cleanup: async () => {
        // SCAN, not KEYS: KEYS is @dangerous and refused to the ACL user ptr .
        for await (const keys of redis.scanStream({ match: `${prefix}:*`, count: 500 }) as AsyncIterable<string[]>) if (keys.length) await redis.del(...keys);
        redis.disconnect();
      },
    };
  });
  test('stray index members (the hint key, a non-hash key, a bad id) never break a heartbeat or a list (opt-in RUN_REDIS_TESTS=1)', async () => {
    const redis = createRedisConnection(url);
    const prefix = `ptrtest:${randomUUID().replace(/-/g, '')}:llm`;
    const store = new RedisGatewayRegistry(redis, prefix);
    try {
      const future = Date.now() + 60000;
      await redis.set(`${prefix}:gw:junk`, 'x');
      await redis.zadd(`${prefix}:gws`, future, 'leader', future, 'junk', future, 'bad id!');
      await redis.set(`${prefix}:gw:leader`, 'nobody', 'PX', 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await store.heartbeat({ id: 'gw-a', url: 'http://127.0.0.1:56460/v1', maxQueue: 256, state: 'active', startedAt: 1, seq: 0 }, 10000, 5000)).toBe('gw-a');
      expect((await store.list()).records.map((r) => r.id)).toEqual(['gw-a']);
    } finally {
      // SCAN, not KEYS: KEYS is @dangerous and refused to the ACL user ptr .
      for await (const keys of redis.scanStream({ match: `${prefix}:*`, count: 500 }) as AsyncIterable<string[]>) if (keys.length) await redis.del(...keys);
      redis.disconnect();
    }
  });
} else {
  describe.skip('gateway registry contract: redis (opt-in RUN_REDIS_TESTS=1)', () => { it('skipped', () => undefined); });
}
