/**
 * ptr-upstream-agent: registers one self-hosted engine (vLLM/SGLang) in the Redis upstream registry and keeps it there
 * by heartbeat (routing ). The same file is the operator CLI.
 *
 *   pnpm exec tsx scripts/upstream-agent.ts register --pool=<served model> --id=<id> --base-url=http://127.0.0.1:<port>/v1
 *       [--max-seqs=12] [--kv-capacity-tokens=<n>] [--weight=1] [--epoch=<id>]   # foreground agent; SIGTERM drains
 *   pnpm exec tsx scripts/upstream-agent.ts drain --pool=<pool> --id=<id>          # mark draining, wait until removed
 *   pnpm exec tsx scripts/upstream-agent.ts deregister --pool=<pool> --id=<id>     # remove now (a running agent re-registers)
 *   pnpm exec tsx scripts/upstream-agent.ts list [--pool=<pool>]
 *
 * Needs PTR_REDIS_URL (the isolated loopback Redis); PTR_REGISTRY_PREFIX (default ptr:llm) selects the namespace.
 * The agent runs on the gateway host next to the SSH tunnel, so `--base-url` is the tunnel's loopback port. It waits for
 * the engine's `/health` = 200, reads `/metrics` once for the KV capacity (`vllm:cache_config_info` num_gpu_blocks ×
 * block_size, else `--kv-capacity-tokens`) and the process start time (the epoch, so a restarted agent keeps the epoch
 * and a restarted engine gets a new one), then heartbeats every PTR_UPSTREAM_HEARTBEAT_MS (2000) with a
 * PTR_UPSTREAM_TTL_MS (10000) TTL. A dead engine (`/health` failing 3 times in a row) is deregistered until it is back.
 * Drain (SIGTERM, or `drain` from anywhere): heartbeat state=draining, wait PTR_UPSTREAM_DRAIN_SETTLE_MS (4000, two
 * gateway polls) counted from the first successful draining write, and then until the engine reports running + waiting = 0 twice in a row, at most PTR_UPSTREAM_DRAIN_MAX_MS
 * (120000), then delete the record and exit. Output never contains the Redis URL.
 */
import { createHash, randomUUID } from 'node:crypto';
import { EPOCH, POOL_NAME, REGISTRY_HEARTBEAT_MS, REGISTRY_TTL_MS, RedisUpstreamRegistry, UPSTREAM_ID, registryPrefixFromEnv,
  createRedisConnection, parseUpstreamRecord, type RegistryReader, type RegistryWriter, type UpstreamRecord } from '@ptr/messaging/registry';

export interface EngineStatus { running:number|null; waiting:number|null; kvCapacityTokens:number|null; startTimeSeconds:number|null }
/** vLLM Prometheus text: running/waiting summed over label sets (one per engine core / model). */
export function parseEngineMetrics(text:string):EngineStatus {
  let running:number|null=null, waiting:number|null=null, kv:number|null=null, start:number|null=null;
  for(const line of text.split('\n')) {
    const match=/^([A-Za-z_:][A-Za-z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line.trim());
    if(!match) continue;
    const [,name,labels='',raw]=match;const value=Number(raw);
    if(!Number.isFinite(value)) continue;
    if(name==='vllm:num_requests_running') running=(running??0)+value;
    else if(name==='vllm:num_requests_waiting') waiting=(waiting??0)+value;
    else if(name==='process_start_time_seconds') start=value;
    else if(name==='vllm:cache_config_info') {
      // Whole label names only (`kv_block_size` is not `block_size`).
      const label=(key:string)=>Number(new RegExp(`[{,]\\s*${key}="(\\d+)"`).exec(labels)?.[1]);
      const blocks=label('num_gpu_blocks'), size=label('block_size');
      if(Number.isInteger(blocks)&&Number.isInteger(size)&&blocks>0&&size>0) kv=blocks*size;
    }
  }
  return {running,waiting,kvCapacityTokens:kv,startTimeSeconds:start};
}
/** Same engine process → same epoch, whichever agent instance computes it. */
export function engineEpoch(id:string,baseUrl:string,startTimeSeconds:number):string {
  return createHash('sha256').update(`${id}\n${baseUrl}\n${startTimeSeconds}`).digest('hex').slice(0,32);
}
const origin=(baseUrl:string)=>new URL(baseUrl).origin;
async function engineHealthy(baseUrl:string,fetcher:typeof fetch,timeoutMs:number):Promise<boolean> {
  try {const response=await fetcher(`${origin(baseUrl)}/health`,{signal:AbortSignal.timeout(timeoutMs),redirect:'error'});await response.body?.cancel().catch(()=>undefined);return response.ok;}
  catch {return false;}
}
/** null when the engine cannot be reached at all. */
async function engineStatus(baseUrl:string,fetcher:typeof fetch):Promise<EngineStatus|null> {
  try {
    const response=await fetcher(`${origin(baseUrl)}/metrics`,{signal:AbortSignal.timeout(2000),redirect:'error'});
    if(!response.ok) {await response.body?.cancel().catch(()=>undefined);return {running:null,waiting:null,kvCapacityTokens:null,startTimeSeconds:null};}
    return parseEngineMetrics(await response.text());
  } catch {return null;}
}

export interface AgentOptions {
  pool:string; id:string; baseUrl:string;
  maxSeqs?:number; weight?:number; kvCapacityTokens?:number|null; epoch?:string;
  heartbeatMs?:number; ttlMs?:number; drainMaxMs?:number; drainSettleMs?:number;
  /** Consecutive failed engine health checks (one per heartbeat) before the record is removed. */
  engineFailures?:number; healthPollMs?:number;
  /** Timeout of one engine `/health` check (PTR_UPSTREAM_HEALTH_TIMEOUT_MS, default 2500: a busy engine may answer slowly). */
  healthTimeoutMs?:number;
  fetch?:typeof fetch; log?:(line:string)=>void;
}
export type AgentPhase='waiting'|'active'|'draining'|'done';
export interface AgentHandle {
  done:Promise<'drained'|'stopped'|'killed'>;
  /** Graceful stop (SIGTERM): drain, then delete the record. Before registration it just stops. */
  drain():void;
  /** Stop at once without touching the registry (simulates SIGKILL; the record expires by TTL). */
  kill():void;
  status():{phase:AgentPhase;epoch?:string;firstPublishedAt?:number};
}

/** The agent loop; `store` is the registry (Redis in production, in memory in tests). */
export function runAgent(store:RegistryWriter,options:AgentOptions):AgentHandle {
  const fetcher=options.fetch??fetch, log=options.log??((line:string)=>process.stderr.write(`${line}\n`));
  const heartbeatMs=options.heartbeatMs??REGISTRY_HEARTBEAT_MS, ttlMs=options.ttlMs??REGISTRY_TTL_MS;
  const drainMaxMs=options.drainMaxMs??120000, settleMs=options.drainSettleMs??4000, healthTimeoutMs=options.healthTimeoutMs??2500;
  let phase:AgentPhase='waiting', killed=false, drainRequested=false, epoch:string|undefined, firstPublishedAt:number|undefined;
  let wake:(()=>void)|undefined;
  const sleep=(ms:number)=>new Promise<void>(resolve=>{const timer=setTimeout(()=>{wake=undefined;resolve();},ms);wake=()=>{clearTimeout(timer);wake=undefined;resolve();};});
  const event=(name:string,extra:Record<string,unknown>={})=>log(JSON.stringify({event:name,pool:options.pool,id:options.id,...extra}));

  async function register():Promise<UpstreamRecord|undefined> {
    while(!killed&&!drainRequested) {
      if(await engineHealthy(options.baseUrl,fetcher,healthTimeoutMs)) {
        const status=await engineStatus(options.baseUrl,fetcher);
        epoch=options.epoch??(status?.startTimeSeconds?engineEpoch(options.id,options.baseUrl,status.startTimeSeconds):randomUUID());
        if(!options.epoch&&!status?.startTimeSeconds) event('epoch_random',{note:'no process_start_time_seconds: an agent restart will look like a new engine'});
        return {pool:options.pool,id:options.id,baseUrl:options.baseUrl,maxSeqs:options.maxSeqs??12,weight:options.weight??1,
          kvCapacityTokens:status?.kvCapacityTokens??options.kvCapacityTokens??null,state:'active',epoch,seq:0,
          // A CLI drain sizes its tombstone from this agent's own bound (+ TTL), not the operator shell's env.
          drainMaxMs};
      }
      await sleep(options.healthPollMs??1000);
    }
    return undefined;
  }
  async function run():Promise<'drained'|'stopped'|'killed'> {
    for(;;) {
      phase='waiting';
      const record=await register();
      if(killed) return 'killed';
      if(!record||drainRequested) return 'stopped'; // asked to stop while registering: never publish
      phase='active';event('registering',{epoch:record.epoch,maxSeqs:record.maxSeqs,kvCapacityTokens:record.kvCapacityTokens});
      let unhealthy=0, registryDown=false, lastBeat=-Infinity, drainStarted:number|undefined, drainConfirmed:number|undefined, idleChecks=0;
      const startDrain=(by:string)=>{drainStarted=Date.now();phase='draining';record.state='draining';lastBeat=-Infinity;event('draining',{by});};
      for(;;) {
        if(killed) return 'killed';
        if(drainRequested&&drainStarted===undefined) startDrain('signal');
        // Until the registry holds state=draining, heartbeat on every tick: that write is the drain itself.
        if(Date.now()-lastBeat>=heartbeatMs||(drainStarted!==undefined&&drainConfirmed===undefined)) {
          lastBeat=Date.now();record.seq++;
          try {
            // A draining agent publishes state=draining, so even a record that expired meanwhile is recreated draining.
            const result=await store.heartbeat(record,ttlMs);
            if(killed) return 'killed';
            if(registryDown) {registryDown=false;event('registry_back');}
            firstPublishedAt??=Date.now();
            if(result==='draining'&&drainStarted===undefined) {drainRequested=true;startDrain('registry');}
            if(drainStarted!==undefined) drainConfirmed??=Date.now();
          } catch {if(!registryDown) {registryDown=true;event('registry_unreachable');}}
          if(drainStarted===undefined) {
            if(await engineHealthy(record.baseUrl,fetcher,healthTimeoutMs)) unhealthy=0;
            else if(++unhealthy>=(options.engineFailures??3)) {
              event('engine_down');
              try {await store.remove(record.pool,record.id,record.epoch);} catch {/* expires by TTL */}
              break; // back to waiting for /health; a restarted engine gets a new epoch
            }
          }
        }
        const timedOut=drainStarted!==undefined&&Date.now()-drainStarted>=drainMaxMs;
        // The settle time counts from the moment gateways can see draining, not from the request to drain.
        if(timedOut||(drainConfirmed!==undefined&&Date.now()-drainConfirmed>=settleMs)) {
          const status=await engineStatus(record.baseUrl,fetcher);
          // Unreachable engine: nothing can still be running on it.
          const idle=status===null||(status.running!==null&&status.waiting!==null&&status.running+status.waiting===0);
          idleChecks=idle?idleChecks+1:0;
          if(idleChecks>=2||timedOut) {
            if(idleChecks<2) event('drain_timeout');
            let removed=false;
            for(let attempt=0;attempt<5&&!removed;attempt++) {
              try {await store.remove(record.pool,record.id,record.epoch);removed=true;} catch {await sleep(Math.min(heartbeatMs,500));}
            }
            if(!removed) event('remove_failed',{note:'the record expires by its TTL'});
            phase='done';event('drained');
            return 'drained';
          }
        }
        await sleep(drainStarted!==undefined?Math.min(heartbeatMs,250):Math.max(1,heartbeatMs-(Date.now()-lastBeat)));
      }
    }
  }
  const done=run().finally(()=>{phase='done';});
  return {
    done,
    drain:()=>{drainRequested=true;wake?.();},
    kill:()=>{killed=true;wake?.();},
    status:()=>({phase,...(epoch?{epoch}:{}),...(firstPublishedAt!==undefined?{firstPublishedAt}:{})}),
  };
}

/**
 * CLI `drain`: mark the record draining (with a tombstone for its epoch, living the agent's drain bound from the record
 * + TTL, or `tombstone.fallbackMs` for a record without one, so an agent
 * that crashes and comes back on the same engine resumes the drain) and wait until it is gone.
 */
export async function drainUpstream(store:RegistryReader&RegistryWriter,pool:string,id:string,
  options:{timeoutMs:number;pollMs?:number;tombstone?:{fallbackMs?:number;ttlMs?:number}}):Promise<'drained'|'not_found'|'timeout'> {
  if(!await store.setState(pool,id,'draining',options.tombstone)) return 'not_found';
  const end=Date.now()+options.timeoutMs;
  while(Date.now()<end) {
    await new Promise(resolve=>setTimeout(resolve,options.pollMs??1000));
    try {if(!(await store.list(pool)).records.some(hash=>hash.id===id)) return 'drained';} catch {/* Redis blip: keep waiting */}
  }
  return 'timeout';
}

export type AgentCommand=
  |{command:'register';pool:string;id:string;baseUrl:string;maxSeqs:number;weight:number;kvCapacityTokens:number|null;epoch?:string}
  |{command:'drain'|'deregister';pool:string;id:string}
  |{command:'list';pool?:string};
export function parseAgentArgs(argv:string[]):AgentCommand {
  const invalid=()=>new Error('INVALID_AGENT_ARGS');
  const [command,...rest]=argv;
  const args:Record<string,string>={};
  for(const arg of rest) {const match=/^--([a-z-]+)=(.*)$/.exec(arg);if(!match) throw invalid();args[match[1]!]=match[2]!;}
  const allowed:Record<string,string[]>={register:['pool','id','base-url','max-seqs','kv-capacity-tokens','weight','epoch'],drain:['pool','id'],deregister:['pool','id'],list:['pool']};
  if(!command||!allowed[command]||Object.keys(args).some(key=>!allowed[command]!.includes(key))) throw invalid();
  if(args.pool!==undefined&&!POOL_NAME.test(args.pool)) throw invalid();
  if(command==='list') return {command,...(args.pool?{pool:args.pool}:{})};
  if(!args.pool||!args.id||!UPSTREAM_ID.test(args.id)) throw invalid();
  if(command!=='register') return {command:command as 'drain'|'deregister',pool:args.pool,id:args.id};
  const url=URL.canParse(args['base-url']??'')?new URL(args['base-url']!):undefined;
  if(!url||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.username||url.password||url.search||url.hash) throw invalid();
  const int=(raw:string|undefined,fallback:number|null,min:number,max:number)=>{
    if(raw===undefined) return fallback;const value=Number(raw);
    if(!Number.isInteger(value)||value<min||value>max) throw invalid();return value;
  };
  const weight=args.weight===undefined?1:Number(args.weight);
  if(!(weight>0&&weight<=100)) throw invalid();
  if(args.epoch!==undefined&&!EPOCH.test(args.epoch)) throw invalid();
  return {command,pool:args.pool,id:args.id,baseUrl:args['base-url']!,maxSeqs:int(args['max-seqs'],12,1,4096)!,weight,
    kvCapacityTokens:int(args['kv-capacity-tokens'],null,1,1e10),...(args.epoch?{epoch:args.epoch}:{})};
}
/**
 * Agent timing settings. A `/health` check must finish with a heartbeat still inside the TTL, so its timeout must be
 * below TTL − heartbeat; and the TTL must cover two heartbeats.
 */
export function agentTimings(env:NodeJS.ProcessEnv) {
  const int=(name:string,fallback:number,min:number,max:number)=>{
    const value=Number(env[name]??fallback);
    if(!Number.isInteger(value)||value<min||value>max) throw new Error(`INVALID_${name}`);
    return value;
  };
  const heartbeatMs=int('PTR_UPSTREAM_HEARTBEAT_MS',REGISTRY_HEARTBEAT_MS,200,60000), ttlMs=int('PTR_UPSTREAM_TTL_MS',REGISTRY_TTL_MS,1000,120000);
  if(ttlMs<2*heartbeatMs) throw new Error('INVALID_PTR_UPSTREAM_TTL_MS');
  const healthTimeoutMs=int('PTR_UPSTREAM_HEALTH_TIMEOUT_MS',2500,100,30000);
  if(healthTimeoutMs>=ttlMs-heartbeatMs) throw new Error('INVALID_PTR_UPSTREAM_HEALTH_TIMEOUT_MS');
  return {heartbeatMs,ttlMs,drainMaxMs:int('PTR_UPSTREAM_DRAIN_MAX_MS',120000,1000,3600000),drainSettleMs:int('PTR_UPSTREAM_DRAIN_SETTLE_MS',4000,0,600000),healthTimeoutMs};
}

async function main():Promise<number> {
  const parsed=parseAgentArgs(process.argv.slice(2));
  const prefix=registryPrefixFromEnv(process.env);
  const redis=createRedisConnection(process.env.PTR_REDIS_URL??'');
  redis.on('error',()=>undefined); // reconnects on its own; the agent logs registry_unreachable instead
  const store=new RedisUpstreamRegistry(redis,prefix);
  const print=(value:unknown)=>process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    const timings=agentTimings(process.env), {drainMaxMs,ttlMs}=timings;
    if(parsed.command==='register') {
      const handle=runAgent(store,{...parsed,...timings});
      let signals=0;
      const stop=()=>{if(++signals>1) process.exit(1);handle.drain();};
      process.on('SIGTERM',stop);process.on('SIGINT',stop);
      const result=await handle.done;print({result});
      return 0;
    }
    if(parsed.command==='drain') {
      // Wait as long as the agent's own drain can take (its bound is in the record), not only this shell's setting.
      const record=(await store.list(parsed.pool)).records.find(hash=>hash.id===parsed.id);
      const bound=Math.max(drainMaxMs,Number(record?.drainMaxMs)||0);
      const result=await drainUpstream(store,parsed.pool,parsed.id,{timeoutMs:bound+ttlMs+5000,tombstone:{fallbackMs:drainMaxMs+ttlMs,ttlMs}});
      print({pool:parsed.pool,id:parsed.id,result});return result==='drained'?0:1;
    }
    if(parsed.command==='deregister') {
      const removed=await store.remove(parsed.pool,parsed.id);
      print({pool:parsed.pool,id:parsed.id,result:removed?'removed':'not_found'});return removed?0:1;
    }
    for(const pool of parsed.pool?[parsed.pool]:(await store.pools()).sort()) {
      for(const hash of (await store.list(pool)).records) {
        try {const r=parseUpstreamRecord(hash);print({pool:r.pool,id:r.id,state:r.state,baseUrl:r.baseUrl,maxSeqs:r.maxSeqs,kvCapacityTokens:r.kvCapacityTokens,weight:r.weight,epoch:r.epoch,seq:r.seq});}
        catch {print({pool,id:hash.id??null,invalid:true});}
      }
    }
    return 0;
  } finally {redis.disconnect();}
}
if(require.main===module) void main().then(code=>{process.exitCode=code;},error=>{
  const code=error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'UPSTREAM_AGENT_FAILED';
  process.stderr.write(`${code}\n`);process.exitCode=2;
});
