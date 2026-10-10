import { RateLimiterMemory } from 'rate-limiter-flexible';
/** Single private-user/process key; native storage owns counting and fixed-window expiry. */
export const loginFailures=new RateLimiterMemory({points:10,duration:60,blockDuration:0,execEvenly:false,keyPrefix:'ptr-login'});
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
