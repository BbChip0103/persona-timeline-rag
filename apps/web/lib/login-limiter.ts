import IORedis, { type Redis } from 'ioredis';
import { assertLocalRedisUrl } from '../../../packages/messaging/src/local-guard';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';

const clusterMode=(env:NodeJS.ProcessEnv)=>env.PTR_NETWORK_MODE==='cluster'||!!env.KUBERNETES_SERVICE_HOST;
const options={points:10,duration:60,blockDuration:0,execEvenly:false,keyPrefix:'ptr:ratelimit:login'};
type LoginLimiter=Pick<RateLimiterMemory,'consume'|'penalty'|'get'|'set'|'delete'>;

export function createLoginLimiter(env:NodeJS.ProcessEnv=process.env,client?:Redis):LoginLimiter {
  const url=env.PTR_WEB_REDIS_URL;
  if(!url) {
    if(clusterMode(env)) throw new Error('PTR_WEB_REDIS_URL is required in cluster mode');
    return new RateLimiterMemory(options);
  }
  const guardedUrl=assertLocalRedisUrl(url,env);
  const redis=client??new IORedis(guardedUrl,{maxRetriesPerRequest:1,commandTimeout:3000,connectionName:'ptr-web'});
  redis.on('error',()=>undefined); // Fail-fast commands surface connection failures to callers.
  return new RateLimiterRedis({...options,storeClient:redis}) as LoginLimiter;
}

/** Single private-user/process key; native storage owns counting and fixed-window expiry. */
export const loginFailures=createLoginLimiter();
const KEY='local-owner';
export async function loginBlocked():Promise<boolean> {
  // Even malformed/config-unavailable/successful requests initialize the existing window.
  try{return (await loginFailures.consume(KEY,0)).consumedPoints>=10;}catch{return true;}
}
export async function failedLogin():Promise<void> {await loginFailures.penalty(KEY,1);}
export async function successfulLogin():Promise<void> {
  const readAt=Date.now();const current=await loginFailures.get(KEY);
  if(current&&current.msBeforeNext>0) {
    // Reset count, not the anchored TTL. Native timer expiry normalizes the old > boundary.
    const remaining=current.msBeforeNext-(Date.now()-readAt);
    if(remaining>0)await loginFailures.set(KEY,0,remaining/1000);
  }
}
