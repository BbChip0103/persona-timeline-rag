import IORedis from 'ioredis';
import { createRedisConnection } from '../src/redis';

const url = process.env.PTR_REDIS_URL ?? '';
const run = process.env.RUN_REDIS_TESTS === '1' ? describe : describe.skip;

// Redis ACL: the app user `ptr` (keys and channels `ptr:*` / `ptrtest:*`, every command but the
// @dangerous ones, plus INFO for BullMQ); the default user is off and there is no admin user.
run('isolated Redis (opt-in RUN_REDIS_TESTS=1)', () => {
  it('connects as ptr and is configured for BullMQ (noeviction, read through INFO)', async () => {
    expect(new URL(url).username).toBe('ptr');
    const redis = createRedisConnection(url);
    try {
      expect(await redis.ping()).toBe('PONG');
      expect(await redis.call('ACL', 'WHOAMI')).toBe('ptr');
      expect(await redis.info('memory')).toMatch(/^maxmemory_policy:noeviction\r?$/m);
    } finally { redis.disconnect(); }
  });
  it('refuses @dangerous commands and keys outside the namespaces to ptr', async () => {
    const redis = createRedisConnection(url);
    try {
      await expect(redis.config('GET', 'maxmemory-policy')).rejects.toThrow(/NOPERM/);
      await expect(redis.keys('ptrtest:*')).rejects.toThrow(/NOPERM/);
      // FLUSHALL only inside a transaction that is always discarded: the ACL refuses it when queued, and a server that
      // allowed it would merely answer QUEUED, so it can never run.
      await redis.call('MULTI');
      try { await expect(redis.call('FLUSHALL')).rejects.toThrow(/NOPERM/); } finally { await redis.call('DISCARD'); }
      await expect(redis.get('other:key')).rejects.toThrow(/NOPERM/);
      await expect(redis.publish('other:channel', '')).rejects.toThrow(/NOPERM/);
    } finally { redis.disconnect(); }
  });
  it('the default user cannot log in, with or without the password', async () => {
    const attempts = [Object.assign(new URL(url), { username: 'default' }).href, Object.assign(new URL(url), { username: '', password: '' }).href];
    for (const target of attempts) {
      const client = new IORedis(target, { lazyConnect: true, enableReadyCheck: false, maxRetriesPerRequest: 0, retryStrategy: () => null });
      // ioredis rejects connect() with "Connection is closed"; the server's reply arrives as an error event.
      const errors: string[] = [];
      client.on('error', (error: Error) => errors.push(error.message));
      try {
        const rejection = await client.connect().then(() => client.ping()).then(() => undefined, (error: Error) => error.message);
        expect(rejection).toBeDefined();
        expect([rejection, ...errors].join(' ')).toMatch(/WRONGPASS|NOAUTH/);
      } finally { client.disconnect(); }
    }
  });
});
