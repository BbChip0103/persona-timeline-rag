import {RateLimiterMemory,RateLimiterRedis,RateLimiterRes} from 'rate-limiter-flexible';
import {CoreError} from '../../../packages/core/src/ports';
import type {createRedisConnection} from '../../../packages/messaging/src/redis';

type RedisConnection=ReturnType<typeof createRedisConnection>;

/** The split runtime supplies its existing Redis connection; synthetic fixtures use memory. */
export function createDraftLimiter(points:number,client?:RedisConnection):(owner:string)=>Promise<void> {
  const options={points,duration:60,blockDuration:0,execEvenly:false,keyPrefix:'ptr:ratelimit:draft'};
  const limiter=client?new RateLimiterRedis({...options,storeClient:client}):new RateLimiterMemory(options);
  return async owner=>{
    try {await limiter.consume(owner,1);}
    catch(error) {if(error instanceof RateLimiterRes)throw new CoreError('QUEUE_FULL');throw error;}
  };
}
