import { DEFAULT_TEXT_MODEL, FakeTextProvider, ProviderError, LatencyInjectedTextProvider, OpenRouterClient, PostgresBudgetLedger, liveOptionsFromEnvironment, parseLatencyProfile } from '@ptr/providers';
import { createLocalPool } from '@ptr/storage';
import { randomUUID } from 'node:crypto';
import { GATEWAY_ID, GatewayPublisher, POOL_NAME, RedisGatewayRegistry, RedisUpstreamRegistry, checkGatewayUrl, createRedisConnection, parseGatewayAllow,
  registryPrefixFromEnv, type AllowRule, type UpstreamRecord } from '@ptr/messaging/registry';
import { createGateway } from './server';
import { FailoverUpstream } from './failover';
import { DEFAULT_FAILOVER, UpstreamPool, type FailoverOptions } from './pool';
import { ROUTING_POLICIES, type RoutingPolicy } from './admission';
import { FileUpstreamSource, RedisRegistrySource, StaticUpstreamSource, checkUpstreamUrl, parseUpstreamAllow, type UpstreamSource } from './sources';
import { OpenAICompatibleUpstream, TextProviderUpstream, type Upstream } from './upstreams';

/**
 * LLM gateway process. PTR_GATEWAY_UPSTREAM picks the upstream kind. A self-hosted primary is either one engine
 * (PTR_SELFHOSTED_BASE_URL, unchanged behaviour) or a pool whose members come from PTR_GATEWAY_UPSTREAMS_FILE and/or the
 * Redis registry (PTR_GATEWAY_DISCOVERY=redis), see UpstreamPool. Either may add a failover secondary
 * (PTR_GATEWAY_FAILOVER=openrouter, or fake for load tests) used only when no primary received the request. Default off.
 */
function decimal(env:NodeJS.ProcessEnv,name:string,fallback:number,min:number,max:number):number {
  const value=Number(env[name]??fallback);
  if(!Number.isFinite(value)||value<min||value>max) throw new Error(`INVALID_${name}`);
  return value;
}
/** PTR_GATEWAY_ROUTING default for pools (decided by the §9.1 comparison, see docs/goal2-serving.md). */
export const DEFAULT_ROUTING:RoutingPolicy='least_inflight';
function integer(env:NodeJS.ProcessEnv,name:string,fallback:number,min:number,max:number):number {
  const value=Number(env[name]??fallback);
  if(!Number.isInteger(value)||value<min||value>max) throw new Error(`INVALID_${name}`);
  return value;
}
/** OpenRouter failover model: allowlisted in the client with json_schema agent replies. */
export const FAILOVER_MODEL='google/gemma-4-26b-a4b-it';
function fakeUpstream(env:NodeJS.ProcessEnv):Upstream {
  // Load tests: the deterministic fake model, optionally with the seeded latency profile.
  const fake=new FakeTextProvider();
  return env.PTR_FAKE_LATENCY!==undefined
    ?new TextProviderUpstream(new LatencyInjectedTextProvider(fake,parseLatencyProfile(env.PTR_FAKE_LATENCY)),'synthetic/fake-text-v1+latency')
    :new TextProviderUpstream(fake,'synthetic/fake-text-v1');
}
/** Startup check for the failover secondary: the ledger is usable and the model's catalog price still verifies. */
export function secondaryReady(client:{verifyPricing(signal:AbortSignal):Promise<void>},ledger:()=>Promise<void>):(signal:AbortSignal)=>Promise<void> {
  return async signal=>{await ledger();await client.verifyPricing(signal);};
}
/** The ledger tables are readable and the global budget row exists (otherwise every paid call would fail). */
export function ledgerReady(pool:{query(sql:string):Promise<{rowCount:number|null}>}):()=>Promise<void> {
  return async()=>{
    await pool.query('SELECT 1 FROM ptr_provider_requests LIMIT 1');
    if(!(await pool.query("SELECT 1 FROM ptr_provider_budget WHERE id='global'")).rowCount) throw new ProviderError('BUDGET_NOT_INITIALIZED');
  };
}
function openRouterUpstream(env:NodeJS.ProcessEnv,model:string|undefined,checkAtStartup=false):{upstream:Upstream;close:()=>Promise<void>} {
  // Billable: the shared budget ledger (idempotent, never resubmits an unresolved request) lives in the gateway.
  const databaseUrl=env.GOAL1_DATABASE_URL??env.DATABASE_URL??'';const pool=createLocalPool(databaseUrl);
  try {
    const liveEnv={...env,GOAL1_DATABASE_URL:databaseUrl,GOAL1_TEXT_MODEL:model};
    const ledger=new PostgresBudgetLedger(pool,databaseUrl);
    const client=new OpenRouterClient(liveOptionsFromEnvironment(liveEnv,ledger));
    return {upstream:new TextProviderUpstream(client,model??DEFAULT_TEXT_MODEL,checkAtStartup?secondaryReady(client,ledgerReady(pool)):undefined),close:()=>pool.end()};
  } catch(error) {void pool.end();throw error;}
}
/** Breaker / failover settings (self-hosted primaries). */
function failoverOptions(env:NodeJS.ProcessEnv):FailoverOptions {
  // The primary here is always self-hosted (not billed per request), so a close before any response fails over by default.
  const onClose=env.PTR_GATEWAY_FAILOVER_ON_CLOSE??'true';
  if(onClose!=='true'&&onClose!=='false') throw new Error('INVALID_PTR_GATEWAY_FAILOVER_ON_CLOSE');
  return {failureThreshold:integer(env,'PTR_GATEWAY_BREAKER_FAILURES',DEFAULT_FAILOVER.failureThreshold,1,100),
    timeoutThreshold:integer(env,'PTR_GATEWAY_BREAKER_TIMEOUTS',DEFAULT_FAILOVER.timeoutThreshold,1,100),
    cooldownMs:integer(env,'PTR_GATEWAY_BREAKER_COOLDOWN_MS',DEFAULT_FAILOVER.cooldownMs,1000,3600000),
    probeTimeoutMs:integer(env,'PTR_GATEWAY_BREAKER_PROBE_TIMEOUT_MS',DEFAULT_FAILOVER.probeTimeoutMs,100,30000),
    headersTimeoutMs:integer(env,'PTR_GATEWAY_PRIMARY_HEADERS_TIMEOUT_MS',DEFAULT_FAILOVER.headersTimeoutMs,0,600000),
    maxPerMinute:integer(env,'PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE',DEFAULT_FAILOVER.maxPerMinute,1,100000),
    failOverOnClose:onClose==='true'};
}
type Configured={upstream:Upstream;close?:()=>Promise<void>;reload?:()=>void};
/**
 * Engine telemetry filter  for pools: off by default (PTR_GATEWAY_METRICS_INTERVAL_MS=0) until the metric
 * names and meanings are verified on the real engines (S8); e.g. 1000 turns it on.
 */
function engineTelemetry(env:NodeJS.ProcessEnv):{telemetry?:{intervalMs:number;kvHigh:number;waitingMax:number;timeoutMs:number}} {
  const intervalMs=integer(env,'PTR_GATEWAY_METRICS_INTERVAL_MS',0,0,60000);
  if(intervalMs!==0&&intervalMs<100) throw new Error('INVALID_PTR_GATEWAY_METRICS_INTERVAL_MS');
  const kvHigh=decimal(env,'PTR_GATEWAY_ENGINE_KV_HIGH',0.95,0.1,1), waitingMax=integer(env,'PTR_GATEWAY_ENGINE_WAITING_MAX',2,0,100000);
  // One poll's timeout: 500 ms (the interval when shorter) by default; engines behind an SSH tunnel need ~2000 (S8).
  const timeoutMs=integer(env,'PTR_GATEWAY_METRICS_TIMEOUT_MS',Math.min(500,intervalMs||500),50,60000);
  // Data older than 3 × the interval counts as stale; a poll allowed to run longer would defeat that.
  if(intervalMs&&timeoutMs>3*intervalMs) throw new Error('INVALID_PTR_GATEWAY_METRICS_TIMEOUT_MS');
  return intervalMs?{telemetry:{intervalMs,kvHigh,waitingMax,timeoutMs}}:{};
}
/**
 * Pool of self-hosted engines : static discovery reads PTR_GATEWAY_UPSTREAMS_FILE (mtime + SIGHUP);
 * redis discovery polls the registry and uses the file (or PTR_SELFHOSTED_BASE_URL as one entry) as its seed.
 */
function poolFromEnvironment(env:NodeJS.ProcessEnv,discovery:string,failover:string,replicas?:()=>number):Configured {
  const model=env.PTR_GATEWAY_POOL??env.PTR_SELFHOSTED_MODEL;
  if(!model) throw new Error('POOL_NOT_CONFIGURED');
  if(!POOL_NAME.test(model)) throw new Error('INVALID_PTR_GATEWAY_POOL');
  if(env.PTR_GATEWAY_UPSTREAMS_FILE&&env.PTR_SELFHOSTED_BASE_URL) throw new Error('SELFHOSTED_BASE_URL_WITH_UPSTREAMS_FILE');
  const routing=env.PTR_GATEWAY_ROUTING??DEFAULT_ROUTING, fairness=env.PTR_GATEWAY_FAIRNESS??'fifo', saturated=env.PTR_GATEWAY_REJECT_SATURATED??'false';
  if(!(ROUTING_POLICIES as readonly string[]).includes(routing)) throw new Error('INVALID_PTR_GATEWAY_ROUTING');
  if(fairness!=='fifo'&&fairness!=='drr') throw new Error('INVALID_PTR_GATEWAY_FAIRNESS');
  if(saturated!=='true'&&saturated!=='false') throw new Error('INVALID_PTR_GATEWAY_REJECT_SATURATED');
  // Cache affinity (§4.3, S5): off by default — the §9.1 comparison did not meet its pre-registered bar (docs/goal2-serving.md).
  const affinity=env.PTR_GATEWAY_AFFINITY??'off';
  if(affinity!=='off'&&affinity!=='on') throw new Error('INVALID_PTR_GATEWAY_AFFINITY');
  const affinityOptions={minTokens:integer(env,'PTR_GATEWAY_AFFINITY_MIN_TOKENS',256,0,1000000),slack:decimal(env,'PTR_GATEWAY_AFFINITY_SLACK',0.5,0,100)};
  // The pool owns admission (S3): credits per upstream, one band queue; PTR_GATEWAY_MAX_CONCURRENCY does not apply.
  const options={failover:failoverOptions(env),primaryAttempts:integer(env,'PTR_GATEWAY_PRIMARY_ATTEMPTS',2,1,8),
    slowStartMs:integer(env,'PTR_GATEWAY_SLOW_START_MS',30000,0,600000),queueTimeoutMs:integer(env,'PTR_GATEWAY_QUEUE_TIMEOUT_MS',10000,1,600000),
    admission:true,maxQueue:integer(env,'PTR_GATEWAY_MAX_QUEUE',256,0,100000),routing:routing as RoutingPolicy,fairness:fairness as 'fifo'|'drr',
    kappa:decimal(env,'PTR_GATEWAY_KV_OVERCOMMIT',0.9,0.1,1),bytesPerToken:decimal(env,'PTR_GATEWAY_BYTES_PER_TOKEN',3.9,0.5,20),
    ttftPenaltyMs:integer(env,'PTR_GATEWAY_TTFT_PENALTY_MS',1000,1,60000),lookahead:integer(env,'PTR_GATEWAY_LOOKAHEAD',8,1,256),
    starvationMs:integer(env,'PTR_GATEWAY_STARVATION_MS',2000,0,600000),drrQuantum:integer(env,'PTR_GATEWAY_DRR_QUANTUM_TOKENS',4096,1,1000000),
    rejectSaturated:saturated==='true',...engineTelemetry(env),...(affinity==='on'?{affinity:affinityOptions}:{}),
    prefixTtlMs:integer(env,'PTR_GATEWAY_PREFIX_TTL_MS',120000,1000,3600000),routeLogSample:decimal(env,'PTR_GATEWAY_ROUTE_LOG_SAMPLE',0.01,0,1)};
  // The upstream deadline starts once the request is admitted, and the wait for a free upstream (up to the queue
  // timeout) runs inside it: if it were not longer, that wait would end as an unmarked 504 instead of the retryable 503.
  if(integer(env,'PTR_GATEWAY_UPSTREAM_TIMEOUT_MS',60000,1000,600000)<=options.queueTimeoutMs) throw new Error('INVALID_PTR_GATEWAY_UPSTREAM_TIMEOUT_MS');
  const allow=parseUpstreamAllow(env.PTR_GATEWAY_UPSTREAM_ALLOW);
  const pollMs=integer(env,'PTR_GATEWAY_REGISTRY_POLL_MS',2000,100,60000), graceMs=integer(env,'PTR_GATEWAY_REGISTRY_GRACE_MS',10000,0,600000);
  const prefix=registryPrefixFromEnv(env);
  const file=env.PTR_GATEWAY_UPSTREAMS_FILE?new FileUpstreamSource(env.PTR_GATEWAY_UPSTREAMS_FILE,model):undefined;
  let seed:UpstreamSource|undefined=file;
  if(env.PTR_SELFHOSTED_BASE_URL) {
    if(checkUpstreamUrl(env.PTR_SELFHOSTED_BASE_URL)) throw new Error('UPSTREAM_NOT_LOOPBACK');
    const one:UpstreamRecord={pool:model,id:'selfhosted',baseUrl:env.PTR_SELFHOSTED_BASE_URL,maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active',epoch:'env',seq:0};
    seed=new StaticUpstreamSource([one]);
  }
  let source:UpstreamSource, redis:ReturnType<typeof createRedisConnection>|undefined;
  if(discovery==='redis') {
    redis=createRedisConnection(env.PTR_REDIS_URL??'');
    redis.on('error',()=>undefined); // reconnects on its own; an outage shows as registry_stale
    source=new RedisRegistrySource(new RedisUpstreamRegistry(redis,prefix),{pool:model,allow,pollMs,graceMs,seed});
  } else source=file!;
  let secondary:{upstream:Upstream;close?:()=>Promise<void>}|undefined;
  try {
    if(failover==='fake') secondary={upstream:fakeUpstream(env)};
    else if(failover==='openrouter') secondary=openRouterUpstream(env,FAILOVER_MODEL,true);
  } catch(error) {redis?.disconnect();throw error;}
  const pool=new UpstreamPool({model,source,...options,...(secondary?{secondary:secondary.upstream}:{}),...(replicas?{replicas}:{})});
  return {upstream:pool,
    close:async()=>{await pool.close();redis?.disconnect();await secondary?.close?.();},
    ...(file?{reload:()=>file.reload()}:{})};
}
/**
 * `replicas`: k = active gateways in the gateway registry (S6). A failover secondary's per-minute ceiling is split by
 * it (PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE / k), so k gateways together stay within one ceiling.
 */
export function upstreamFromEnvironment(env:NodeJS.ProcessEnv,replicas?:()=>number):Configured {
  const kind=env.PTR_GATEWAY_UPSTREAM??'fake', failover=env.PTR_GATEWAY_FAILOVER??'off', discovery=env.PTR_GATEWAY_DISCOVERY??'static';
  if(!['off','openrouter','fake'].includes(failover)) throw new Error('INVALID_PTR_GATEWAY_FAILOVER');
  if(!['static','redis'].includes(discovery)) throw new Error('INVALID_PTR_GATEWAY_DISCOVERY');
  const pooled=discovery==='redis'||!!env.PTR_GATEWAY_UPSTREAMS_FILE;
  if(pooled&&kind!=='selfhosted') throw new Error('UPSTREAMS_REQUIRE_SELFHOSTED');
  if(failover!=='off'&&kind!=='selfhosted') throw new Error('FAILOVER_REQUIRES_SELFHOSTED');
  if(kind==='fake') return {upstream:fakeUpstream(env)};
  // Latency injection only ever wraps the fake model (here: the load-test fake failover secondary).
  if(env.PTR_FAKE_LATENCY!==undefined&&failover!=='fake') throw new Error('LATENCY_INJECTION_ONLY_FOR_FAKE');
  if(kind==='selfhosted') {
    if(pooled) return poolFromEnvironment(env,discovery,failover,replicas);
    if(!env.PTR_SELFHOSTED_BASE_URL||!env.PTR_SELFHOSTED_MODEL) throw new Error('SELFHOSTED_NOT_CONFIGURED');
    const primary=new OpenAICompatibleUpstream({baseUrl:env.PTR_SELFHOSTED_BASE_URL,model:env.PTR_SELFHOSTED_MODEL});
    if(failover==='off') return {upstream:primary};
    const options=failoverOptions(env);
    if(failover==='fake') return {upstream:new FailoverUpstream(primary,fakeUpstream(env),options,replicas)};
    const secondary=openRouterUpstream(env,FAILOVER_MODEL,true);
    return {upstream:new FailoverUpstream(primary,secondary.upstream,options,replicas),close:secondary.close};
  }
  if(kind==='openrouter') return openRouterUpstream(env,env.GOAL1_TEXT_MODEL??env.PTR_MODEL??env.TEXT_MODEL);
  throw new Error('INVALID_PTR_GATEWAY_UPSTREAM');
}
/**
 * Gateway registry (S6): PTR_GATEWAY_REGISTRY=on|off, default on with PTR_GATEWAY_DISCOVERY=redis
 * (Redis is there already), else off. The record: PTR_GATEWAY_ID (default gw-<port>-<random>), the URL workers use
 * (PTR_GATEWAY_ADVERTISE_URL, default http://127.0.0.1:<port>/v1, which must pass the workers' rule: loopback, /v1 and
 * PTR_GATEWAY_ALLOW), PTR_GATEWAY_MAX_QUEUE and the process start time.
 */
export function gatewayRegistrySettings(env:NodeJS.ProcessEnv,port:number,startedAt=Date.now()):
  {id:string;url:string;maxQueue:number;startedAt:number;prefix:string;allow:AllowRule[]}|null {
  const mode=env.PTR_GATEWAY_REGISTRY??(env.PTR_GATEWAY_DISCOVERY==='redis'?'on':'off');
  if(mode!=='on'&&mode!=='off') throw new Error('INVALID_PTR_GATEWAY_REGISTRY');
  if(mode==='off') return null;
  const id=env.PTR_GATEWAY_ID??`gw-${port}-${randomUUID().slice(0,8)}`;
  if(!GATEWAY_ID.test(id)) throw new Error('INVALID_PTR_GATEWAY_ID');
  const url=env.PTR_GATEWAY_ADVERTISE_URL??`http://127.0.0.1:${port}/v1`, allow=parseGatewayAllow(env.PTR_GATEWAY_ALLOW);
  if(checkGatewayUrl(url,allow)) throw new Error('INVALID_PTR_GATEWAY_ADVERTISE_URL');
  return {id,url,maxQueue:integer(env,'PTR_GATEWAY_MAX_QUEUE',256,0,100000),startedAt,prefix:registryPrefixFromEnv(env),allow};
}
async function main() {
  const env=process.env;
  const port=integer(env,'PTR_GATEWAY_PORT',56460,1024,65535);
  const shutdownMs=integer(env,'PTR_GATEWAY_SHUTDOWN_MS',30000,0,600000); // validated at startup, not in the signal handler
  const registered=gatewayRegistrySettings(env,port);
  let publisher:GatewayPublisher|undefined, registryRedis:ReturnType<typeof createRedisConnection>|undefined;
  if(registered) {
    registryRedis=createRedisConnection(env.PTR_REDIS_URL??'');registryRedis.on('error',()=>undefined); // heartbeats retry; the record expires after 10 s
    publisher=new GatewayPublisher(new RedisGatewayRegistry(registryRedis,registered.prefix),{...registered,onWarning:line=>process.stderr.write(`${line}\n`)});
  }
  // k unknown until the first registry read (Infinity): the failover ceiling is then 1 per minute, the most conservative.
  const {upstream,close,reload}=upstreamFromEnvironment(env,publisher?()=>publisher!.activeGateways()??Infinity:undefined);
  // Failover: the secondary must be usable (ledger readable, price verified) before any traffic is accepted.
  try {await upstream.ready?.(AbortSignal.timeout(30000));} catch(error) {await close?.();registryRedis?.disconnect();throw error;}
  const gateway=createGateway({token:env.PTR_GATEWAY_TOKEN??'',upstream,limits:{
    maxConcurrent:integer(env,'PTR_GATEWAY_MAX_CONCURRENCY',32,1,4096),maxQueue:integer(env,'PTR_GATEWAY_MAX_QUEUE',256,0,100000),
    queueTimeoutMs:integer(env,'PTR_GATEWAY_QUEUE_TIMEOUT_MS',10000,1,600000),upstreamTimeoutMs:integer(env,'PTR_GATEWAY_UPSTREAM_TIMEOUT_MS',60000,1000,600000)},
    ...(publisher?{registry:()=>publisher!.metrics()}:{})});
  const {server}=gateway;
  await new Promise<void>(resolve=>server.listen(port,'127.0.0.1',resolve));
  // Registered only once it listens: a worker that reads the record can connect at once.
  await publisher?.start();
  // No tokens, URLs or upstream details in startup output.
  process.stdout.write(`LLM gateway listening on 127.0.0.1:${port}${publisher?` (registry id ${registered!.id})`:''}\n`);
  // Graceful drain : queued and new requests are refused at once with the marked 503 `draining` (never
  // sent upstream: workers resend them to their next gateway), /healthz 503, the registry record says draining; calls
  // already sent finish for up to PTR_GATEWAY_SHUTDOWN_MS (paid calls are not cut off), then the listener and every
  // connection close, the record is deleted and the ledger pool released.
  let stopping=false;
  const shutdown=()=>{
    if(stopping) return;stopping=true;
    const before=gateway.metrics();
    gateway.drain();
    process.stderr.write(`gateway draining: ${before.inFlight} in flight, ${before.queued} queued (refused now)\n`);
    const deadline=new Promise<'deadline'>(resolve=>setTimeout(()=>resolve('deadline'),shutdownMs).unref());
    // Exit 0 only for a clean drain: no call cut by the deadline and every cleanup step done (a supervisor can tell).
    void (async():Promise<number>=>{
      const marking=publisher?.setDraining().catch(()=>undefined);
      const ended=await Promise.race([gateway.idle().then(()=>'idle' as const),deadline]);
      await marking;
      const after=gateway.metrics();
      process.stderr.write(`gateway drained (${ended}): ${after.rejected.draining} request(s) refused while draining, ${after.inFlight} still in flight\n`);
      server.close();server.closeAllConnections();
      let clean=ended==='idle'||after.inFlight===0;
      if(publisher&&!await publisher.stop()) clean=false;
      registryRedis?.disconnect();
      try {await close?.();} catch {clean=false;}
      if(!clean) process.stderr.write('gateway stopped uncleanly: calls cut at PTR_GATEWAY_SHUTDOWN_MS or a cleanup step failed\n');
      return clean?0:1;
    })().then(code=>process.exit(code),()=>process.exit(1));
  };
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  // PTR_GATEWAY_UPSTREAMS_FILE is re-read on SIGHUP (and when its mtime changes).
  if(reload) process.on('SIGHUP',reload);
}
if(require.main===module) void main().catch(()=>{process.stderr.write('GATEWAY_STARTUP_FAILED\n');process.exitCode=1;});
