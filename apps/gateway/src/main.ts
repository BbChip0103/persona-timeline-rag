import { DEFAULT_TEXT_MODEL, FakeTextProvider, ProviderError, LatencyInjectedTextProvider, OpenRouterClient, PostgresBudgetLedger, liveOptionsFromEnvironment, parseLatencyProfile } from '@ptr/providers';
import { createLocalPool } from '@ptr/storage';
import { createGateway } from './server';
import { DEFAULT_FAILOVER, FailoverUpstream, type FailoverOptions } from './failover';
import { OpenAICompatibleUpstream, TextProviderUpstream, type Upstream } from './upstreams';

/**
 * LLM gateway process. One upstream per process, chosen by PTR_GATEWAY_UPSTREAM; a self-hosted primary may add a
 * failover secondary (PTR_GATEWAY_FAILOVER=openrouter, or fake for load tests) used only when the primary certainly
 * did not receive the request (see FailoverUpstream). Default off.
 */
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
export function upstreamFromEnvironment(env:NodeJS.ProcessEnv):{upstream:Upstream;close?:()=>Promise<void>} {
  const kind=env.PTR_GATEWAY_UPSTREAM??'fake', failover=env.PTR_GATEWAY_FAILOVER??'off';
  if(!['off','openrouter','fake'].includes(failover)) throw new Error('INVALID_PTR_GATEWAY_FAILOVER');
  if(failover!=='off'&&kind!=='selfhosted') throw new Error('FAILOVER_REQUIRES_SELFHOSTED');
  if(kind==='fake') return {upstream:fakeUpstream(env)};
  // Latency injection only ever wraps the fake model (here: the load-test fake failover secondary).
  if(env.PTR_FAKE_LATENCY!==undefined&&failover!=='fake') throw new Error('LATENCY_INJECTION_ONLY_FOR_FAKE');
  if(kind==='selfhosted') {
    if(!env.PTR_SELFHOSTED_BASE_URL||!env.PTR_SELFHOSTED_MODEL) throw new Error('SELFHOSTED_NOT_CONFIGURED');
    const primary=new OpenAICompatibleUpstream({baseUrl:env.PTR_SELFHOSTED_BASE_URL,model:env.PTR_SELFHOSTED_MODEL});
    if(failover==='off') return {upstream:primary};
    // The primary here is always self-hosted (not billed per request), so a close before any response fails over by default.
    const onClose=env.PTR_GATEWAY_FAILOVER_ON_CLOSE??'true';
    if(onClose!=='true'&&onClose!=='false') throw new Error('INVALID_PTR_GATEWAY_FAILOVER_ON_CLOSE');
    const options:FailoverOptions={failureThreshold:integer(env,'PTR_GATEWAY_BREAKER_FAILURES',DEFAULT_FAILOVER.failureThreshold,1,100),
      timeoutThreshold:integer(env,'PTR_GATEWAY_BREAKER_TIMEOUTS',DEFAULT_FAILOVER.timeoutThreshold,1,100),
      cooldownMs:integer(env,'PTR_GATEWAY_BREAKER_COOLDOWN_MS',DEFAULT_FAILOVER.cooldownMs,1000,3600000),
      probeTimeoutMs:integer(env,'PTR_GATEWAY_BREAKER_PROBE_TIMEOUT_MS',DEFAULT_FAILOVER.probeTimeoutMs,100,30000),
      headersTimeoutMs:integer(env,'PTR_GATEWAY_PRIMARY_HEADERS_TIMEOUT_MS',DEFAULT_FAILOVER.headersTimeoutMs,0,600000),
      maxPerMinute:integer(env,'PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE',DEFAULT_FAILOVER.maxPerMinute,1,100000),
      failOverOnClose:onClose==='true'};
    if(failover==='fake') return {upstream:new FailoverUpstream(primary,fakeUpstream(env),options)};
    const secondary=openRouterUpstream(env,FAILOVER_MODEL,true);
    return {upstream:new FailoverUpstream(primary,secondary.upstream,options),close:secondary.close};
  }
  if(kind==='openrouter') return openRouterUpstream(env,env.GOAL1_TEXT_MODEL??env.PTR_MODEL??env.TEXT_MODEL);
  throw new Error('INVALID_PTR_GATEWAY_UPSTREAM');
}
async function main() {
  const env=process.env;
  const {upstream,close}=upstreamFromEnvironment(env);
  // Failover: the secondary must be usable (ledger readable, price verified) before any traffic is accepted.
  try {await upstream.ready?.(AbortSignal.timeout(30000));} catch(error) {await close?.();throw error;}
  const {server}=createGateway({token:env.PTR_GATEWAY_TOKEN??'',upstream,limits:{
    maxConcurrent:integer(env,'PTR_GATEWAY_MAX_CONCURRENCY',32,1,4096),maxQueue:integer(env,'PTR_GATEWAY_MAX_QUEUE',256,0,100000),
    queueTimeoutMs:integer(env,'PTR_GATEWAY_QUEUE_TIMEOUT_MS',10000,1,600000),upstreamTimeoutMs:integer(env,'PTR_GATEWAY_UPSTREAM_TIMEOUT_MS',60000,1000,600000)}});
  const port=integer(env,'PTR_GATEWAY_PORT',56460,1024,65535);
  const shutdownMs=integer(env,'PTR_GATEWAY_SHUTDOWN_MS',30000,0,600000); // validated at startup, not in the signal handler
  await new Promise<void>(resolve=>server.listen(port,'127.0.0.1',resolve));
  // No tokens, URLs or upstream details in startup output.
  process.stdout.write(`LLM gateway listening on 127.0.0.1:${port}\n`);
  // Stop accepting, let in-flight calls finish (bounded), then release the ledger pool: paid calls are not cut off.
  const shutdown=()=>{
    const drained=new Promise<void>(resolve=>server.close(()=>resolve()));
    const deadline=new Promise<void>(resolve=>setTimeout(resolve,shutdownMs).unref());
    void Promise.race([drained,deadline]).then(()=>close?.()).finally(()=>process.exit(0));
  };
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
if(require.main===module) void main().catch(()=>{process.stderr.write('GATEWAY_STARTUP_FAILED\n');process.exitCode=1;});
