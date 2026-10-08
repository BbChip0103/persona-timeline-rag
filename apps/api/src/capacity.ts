import { randomUUID } from 'node:crypto';
import { CapacityController, POOL_NAME, RedisCapacityStore, RedisUpstreamRegistry, registryPrefixFromEnv, capacityControllerMode,
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
  return {mode,pool,queueName,prefix:registryPrefixFromEnv(env),
    headroom:number('PTR_CAPACITY_HEADROOM',0.25,0,4,false),floor:number('PTR_CAPACITY_FLOOR',1,1,4096),
    intervalMs:number('PTR_CAPACITY_INTERVAL_MS',5000,500,60000),q:number('PTR_GATEWAY_MAX_QUEUE',256,0,100000),
    allow:parseUpstreamAllow(env.PTR_GATEWAY_UPSTREAM_ALLOW)};
}

async function leaderAlive(url:string,prefix:string):Promise<boolean> {
  const redis=createRedisConnection(url);redis.on('error',()=>undefined);
  try {return (await redis.exists(`${prefix}:cap:leader`))===1;} finally {redis.disconnect();}
}
/**
 * `off` mode: removes a G left by an earlier run, but never while a controller leader is alive (a rolling restart from
 * on to off, or a dispatcher missing PTR_GATEWAY_DISCOVERY in an `on` fleet): then it warns once and re-checks every
 * lease interval, removing G once no leader is alive. A check that fails (Redis unavailable) is logged and repeated one
 * lease interval later. `started` resolves after the first check and never rejects.
 */
export function clearWhenNoLeader(input:{queue:{getGlobalConcurrency():Promise<number|null>;removeGlobalConcurrency():Promise<unknown>};queueName:string;
  leaderAlive:()=>Promise<boolean>;log:(line:string)=>void;recheckMs:number;schedule?:(fn:()=>void,ms:number)=>()=>void}):{started:Promise<void>;stop():void} {
  const schedule=input.schedule??((fn:()=>void,ms:number)=>{const timer=setTimeout(fn,ms);timer.unref();return ()=>clearTimeout(timer);});
  let cancel:(()=>void)|undefined, stopped=false, warned=false;
  const check=async():Promise<void>=>{
    const current=await input.queue.getGlobalConcurrency();
    if(current===null||stopped) return;
    if(await input.leaderAlive()) {
      if(!warned) input.log(`WARNING capacity controller off here, but another dispatcher leads the controller: global concurrency ${current} left as set; re-checking every ${Math.round(input.recheckMs/1000)} s and removing it once no leader is alive (use the same PTR_CAPACITY_CONTROLLER everywhere)`);
      warned=true;
      again();
      return;
    }
    await input.queue.removeGlobalConcurrency();
    input.log(`capacity controller off: removed global concurrency ${current} from ${input.queueName}`);
  };
  const run=():Promise<void>=>check().catch(()=>{input.log('capacity check skipped: Redis unavailable');again();});
  const again=()=>{if(!stopped) cancel=schedule(()=>void run(),input.recheckMs);};
  return {started:run(),stop:()=>{stopped=true;cancel?.();}};
}
/** Starts the controller when on; `off` removes a G left by an earlier run (see clearWhenNoLeader); `keep` only reports it. */
export async function startCapacityController(env:NodeJS.ProcessEnv,log:(line:string)=>void):Promise<{stop():Promise<void>}> {
  const settings=capacitySettings(env), url=env.PTR_REDIS_URL??'';
  const {queue,close}=openTurnQueue(url,settings.queueName);
  if(settings.mode==='off') {
    const clearing=clearWhenNoLeader({queue,queueName:settings.queueName,leaderAlive:()=>leaderAlive(url,settings.prefix),log,
      recheckMs:Math.max(15000,3*settings.intervalMs)});
    await clearing.started;
    return {stop:async()=>{clearing.stop();await close();}};
  }
  if(settings.mode==='keep') {
    try {
      const current=await queue.getGlobalConcurrency();
      if(current!==null) log(`capacity controller keep: global concurrency ${current} left as set on ${settings.queueName}`);
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

/**
 * Worker startup line. Workers do not need PTR_CAPACITY_CONTROLLER or PTR_GATEWAY_DISCOVERY, so a worker whose mode is
 * only the derived default (`explicit` false) never warns: a running controller leader or a set G is reported as
 * information. A warning means this process explicitly says off/keep while a leader runs (mixed modes), or explicitly
 * says off while a G is still set.
 */
export function workerCapacityLine(input:{mode:'on'|'off'|'keep';explicit:boolean;globalConcurrency:number|null;controllerRunning:boolean}):string|null {
  const g=input.globalConcurrency;
  if(input.mode==='on') return `capacity controller on: global concurrency G=${g??'unset'} (PTR_WORKER_CONCURRENCY is a local cap only)`;
  if(input.controllerRunning) return input.explicit
    ?`WARNING PTR_CAPACITY_CONTROLLER=${input.mode} here, but a capacity controller leader is running (G=${g??'unset'}): use the same mode in every process`
    :`capacity controller running elsewhere: global concurrency G=${g??'unset'} (PTR_WORKER_CONCURRENCY is a local cap only)`;
  if(g===null) return null;
  if(!input.explicit) return `capacity: global concurrency G=${g} is set on the turn queue and no controller leader is alive (PTR_CAPACITY_CONTROLLER unset here): at most ${g} turns run`;
  return input.mode==='off'
    ?`WARNING capacity controller off but global concurrency G=${g} is set on the turn queue: a dispatcher in off mode clears it at startup; until then at most ${g} turns run`
    :`capacity controller keep: global concurrency G=${g} left as set (nothing adjusts it)`;
}
/** G of the turn queue and whether a controller leader is alive (its lock), read once at worker startup. */
export async function readCapacityState(env:NodeJS.ProcessEnv):Promise<{globalConcurrency:number|null;controllerRunning:boolean}> {
  const url=env.PTR_REDIS_URL??'';
  const {queue,close}=openTurnQueue(url,env.PTR_TURN_QUEUE??'turns');
  try {
    return {globalConcurrency:await queue.getGlobalConcurrency(),
      controllerRunning:await leaderAlive(url,registryPrefixFromEnv(env))};
  } finally {await close();}
}
