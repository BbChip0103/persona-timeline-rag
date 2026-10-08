import { randomUUID } from 'node:crypto';
import { CapacityController, POOL_NAME, REGISTRY_PREFIX, RedisCapacityStore, RedisUpstreamRegistry, assertRegistryPrefix, capacityControllerMode,
  createRedisConnection, openTurnQueue, parseUpstreamAllow } from '@ptr/messaging';

/**
 * Capacity controller wiring . Runs in the dispatcher; one leader per Redis acts. Mode:
 * PTR_CAPACITY_CONTROLLER=on|off|clear, default on when PTR_GATEWAY_DISCOVERY=redis (there is a registry to read),
 * off otherwise (static upstreams: G would only mirror a file; the S1 startup warning stays the guard).
 */
export function capacitySettings(env:NodeJS.ProcessEnv) {
  const number=(name:string,fallback:number,min:number,max:number,integer=true)=>{
    const value=Number(env[name]??fallback);
    if(!Number.isFinite(value)||(integer&&!Number.isInteger(value))||value<min||value>max) throw new Error(`INVALID_${name}`);
    return value;
  };
  const mode=capacityControllerMode(env);
  const pool=env.PTR_CAPACITY_POOL??env.PTR_GATEWAY_POOL??env.PTR_SELFHOSTED_MODEL??'';
  if(mode==='on'&&!POOL_NAME.test(pool)) throw new Error('INVALID_PTR_CAPACITY_POOL');
  const queueName=env.PTR_TURN_QUEUE??'turns';
  if(!/^[a-z0-9-]{1,40}$/.test(queueName)) throw new Error('INVALID_PTR_TURN_QUEUE');
  return {mode,pool,queueName,prefix:assertRegistryPrefix(env.PTR_REGISTRY_PREFIX??REGISTRY_PREFIX),
    headroom:number('PTR_CAPACITY_HEADROOM',0.25,0,4,false),floor:number('PTR_CAPACITY_FLOOR',1,1,4096),
    intervalMs:number('PTR_CAPACITY_INTERVAL_MS',5000,500,60000),q:number('PTR_GATEWAY_MAX_QUEUE',256,0,100000),
    allow:parseUpstreamAllow(env.PTR_GATEWAY_UPSTREAM_ALLOW)};
}

/** Starts the controller when on; `clear` removes a G left by an earlier run; off only warns about a leftover G. */
export async function startCapacityController(env:NodeJS.ProcessEnv,log:(line:string)=>void):Promise<{stop():Promise<void>}> {
  const settings=capacitySettings(env), url=env.PTR_REDIS_URL??'';
  const {queue,close}=openTurnQueue(url,settings.queueName);
  if(settings.mode!=='on') {
    try {
      const current=await queue.getGlobalConcurrency();
      if(settings.mode==='clear'&&current!==null) {await queue.removeGlobalConcurrency();log(`capacity controller clear: removed global concurrency ${current}`);}
      else if(current!==null) log(`WARNING capacity controller off but global concurrency ${current} is still set on ${settings.queueName}; PTR_CAPACITY_CONTROLLER=clear removes it`);
    } catch {log('capacity check skipped: Redis unavailable');}
    await close();
    return {stop:async()=>undefined};
  }
  const redis=createRedisConnection(url);redis.on('error',()=>undefined);
  const controller=new CapacityController({registry:new RedisUpstreamRegistry(redis,settings.prefix),queue,store:new RedisCapacityStore(redis,settings.prefix),
    pool:settings.pool,allow:settings.allow,id:`dispatcher-${randomUUID().slice(0,8)}`,q:settings.q,headroom:settings.headroom,floor:settings.floor,
    intervalMs:settings.intervalMs,log});
  controller.start();
  return {stop:async()=>{await controller.stop();await close();redis.disconnect();}};
}

/** Worker startup: with the controller on, one line with the current G replaces the S1 Σ-concurrency warning. */
export function workerCapacityLine(input:{mode:'on'|'off'|'clear';globalConcurrency:number|null}):string|null {
  return input.mode==='on'?`capacity controller on: global concurrency G=${input.globalConcurrency??'unset'} (PTR_WORKER_CONCURRENCY is a local cap only)`:null;
}
export async function readGlobalConcurrency(env:NodeJS.ProcessEnv):Promise<number|null> {
  const {queue,close}=openTurnQueue(env.PTR_REDIS_URL??'',env.PTR_TURN_QUEUE??'turns');
  try {return await queue.getGlobalConcurrency();} finally {await close();}
}
