import {RateLimiterMemory,RateLimiterRes} from 'rate-limiter-flexible';
import {CoreError} from '../../../packages/core/src/ports';

/** Native process-local fixed windows; owner authorization remains the caller's responsibility. */
export function createDraftLimiter(points:number):(owner:string)=>Promise<void> {
  const limiter=new RateLimiterMemory({points,duration:60,blockDuration:0,execEvenly:false});
  return async owner=>{
    try {await limiter.consume(owner,1);}
    catch(error) {if(error instanceof RateLimiterRes)throw new CoreError('QUEUE_FULL');throw error;}
  };
}
