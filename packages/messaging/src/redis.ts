import IORedis, { type Redis } from 'ioredis';
import { assertLocalRedisUrl } from './local-guard.js';

/** Key/channel namespace for everything this project writes into Redis. */
export const REDIS_PREFIX = 'ptr';

/** BullMQ workers need maxRetriesPerRequest=null so blocking commands survive reconnects. */
export function createRedisConnection(url: string): Redis {
  return new IORedis(assertLocalRedisUrl(url), { maxRetriesPerRequest: null, lazyConnect: false, connectionName: 'ptr' });
}
