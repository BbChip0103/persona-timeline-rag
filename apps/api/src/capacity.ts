import { randomUUID } from 'node:crypto';
import { CapacityController, POOL_NAME, REGISTRY_PREFIX, RedisCapacityStore, RedisUpstreamRegistry, assertRegistryPrefix, capacityControllerMode,
  createRedisConnection, openTurnQueue, parseUpstreamAllow } from '@ptr/messaging';

/**
 * Capacity controller wiring . Runs in the dispatcher; one leader per Redis acts. Mode:
 * PTR_CAPACITY_CONTROLLER=on|off|keep, default on when PTR_GATEWAY_DISCOVERY=redis (there is a registry to read),
 * off otherwise (static upstreams: G would only mirror a file; the S1 startup warning stays the guard). `off` removes a
 * G left by an earlier run at startup; `keep` leaves G alone. All dispatchers sharing a queue must use the same mode.
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

async function leaderAlive(url:string,prefix:string):Promise<boolean> {
  const redis=createRedisConnection(url);redis.on('error',()=>undefined);
  try {return (await redis.exists(`${prefix}:cap:leader`))===1;} finally {redis.disconnect();}
}
/** Starts the controller when on; `off` removes a G left by an earlier run; `keep` only reports it. */
export async function startCapacityController(env:NodeJS.ProcessEnv,log:(line:string)=>void):Promise<{stop():Promise<void>}> {
  const settings=capacitySettings(env), url=env.PTR_REDIS_URL??'';
  const {queue,close}=openTurnQueue(url,settings.queueName);
  if(settings.mode!=='on') {
    try {
      const current=await queue.getGlobalConcurrency();
      // Never clear while a controller leader is alive (a dispatcher missing PTR_GATEWAY_DISCOVERY in an `on` fleet).
      const leader=settings.mode==='off'&&current!==null?await leaderAlive(url,settings.prefix):false;
      if(settings.mode==='off'&&current!==null&&leader) log(`WARNING capacity controller off here, but another dispatcher leads the controller: global concurrency ${current} left as set; use the same PTR_CAPACITY_CONTROLLER everywhere`);
      else if(settings.mode==='off'&&current!==null) {await queue.removeGlobalConcurrency();log(`capacity controller off: removed global concurrency ${current} from ${settings.queueName}`);}
      else if(current!==null) log(`capacity controller keep: global concurrency ${current} left as set on ${settings.queueName}`);
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

/**
 * Startup with a configuration error (bad env, unknown mode): log it and run without the controller, so turn dispatch,
 * lease recovery and the outbox are never taken down by it.
 */
export async function startCapacityControllerSafely(env:NodeJS.ProcessEnv,log:(line:string)=>void):Promise<{stop():Promise<void>}> {
  try {return await startCapacityController(env,log);}
  catch(error) {
    const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'CAPACITY_CONTROLLER_FAILED';
    log(`WARNING capacity controller disabled (${code}): turn dispatch, lease recovery and the outbox continue without it`);
    return {stop:async()=>undefined};
  }
}

/** Worker startup: on → the current G (replaces the S1 Σ-concurrency warning); off with a G still set → a warning; keep → a note. */
export function workerCapacityLine(input:{mode:'on'|'off'|'keep';globalConcurrency:number|null}):string|null {
  const g=input.globalConcurrency;
  if(input.mode==='on') return `capacity controller on: global concurrency G=${g??'unset'} (PTR_WORKER_CONCURRENCY is a local cap only)`;
  if(g===null) return null;
  return input.mode==='off'
    ?`WARNING capacity controller off but global concurrency G=${g} is set on the turn queue: a dispatcher in off mode clears it at startup; until then at most ${g} turns run`
    :`capacity controller keep: global concurrency G=${g} left as set (nothing adjusts it)`;
}
export async function readGlobalConcurrency(env:NodeJS.ProcessEnv):Promise<number|null> {
  const {queue,close}=openTurnQueue(env.PTR_REDIS_URL??'',env.PTR_TURN_QUEUE??'turns');
  try {return await queue.getGlobalConcurrency();} finally {await close();}
}
