import IORedis, { type Redis } from 'ioredis';
import { assertLocalRedisUrl } from './local-guard.js';

/** Key/channel namespace for everything this project writes into Redis. */
export const REDIS_PREFIX = 'ptr';

/**
 * `blocking` is for BullMQ Worker connections only: they need maxRetriesPerRequest=null so blocking commands survive
 * reconnects. Every other connection (queue add/counts, publish, subscribe) fails fast while Redis is unreachable,
 * so callers reach their fallbacks (outbox re-publish, SSE store re-check, lease heartbeat) instead of hanging.
 */
export function createRedisConnection(url: string, options: { blocking?: boolean } = {}): Redis {
  return new IORedis(assertLocalRedisUrl(url), options.blocking
    ? { maxRetriesPerRequest: null, connectionName: 'ptr' }
    : { maxRetriesPerRequest: 1, commandTimeout: 3000, connectionName: 'ptr' });
}
