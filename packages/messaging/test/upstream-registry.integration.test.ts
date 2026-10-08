import { randomUUID } from 'node:crypto';
import { createRedisConnection } from '../src/redis';
import { RedisUpstreamRegistry } from '../src/upstream-registry';
import { registryContract } from './upstream-registry.contract';

const url = process.env.PTR_REDIS_URL ?? '';
const enabled = process.env.RUN_REDIS_TESTS === '1';

// Opt-in (RUN_REDIS_TESTS=1): the Lua heartbeat / drain / remove scripts against the real isolated Redis, each test in
// its own `ptrtest:<uuid>:llm` namespace (never the live `ptr:llm`), deleted afterwards.
if (enabled) {
  registryContract('redis (opt-in RUN_REDIS_TESTS=1)', async () => {
    const redis = createRedisConnection(url);
    const prefix = `ptrtest:${randomUUID().replace(/-/g, '')}:llm`;
    const store = new RedisUpstreamRegistry(redis, prefix);
    return {
      store,
      wait: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      cleanup: async () => {
        const keys = await redis.keys(`${prefix}:*`);
        if (keys.length) await redis.del(...keys);
        redis.disconnect();
      },
    };
  });
} else {
  describe.skip('upstream registry contract: redis (opt-in RUN_REDIS_TESTS=1)', () => { it('skipped', () => undefined); });
}
