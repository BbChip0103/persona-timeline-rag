import { DEFAULT_TEXT_MODEL, FakeTextProvider, LatencyInjectedTextProvider, OpenRouterClient, PostgresBudgetLedger, liveOptionsFromEnvironment, parseLatencyProfile } from '@ptr/providers';
import { createLocalPool } from '@ptr/storage';
import { createGateway } from './server';
import { OpenAICompatibleUpstream, TextProviderUpstream, type Upstream } from './upstreams';

/** LLM gateway process. One upstream per process, chosen by PTR_GATEWAY_UPSTREAM (no fallback between upstreams). */
function integer(env:NodeJS.ProcessEnv,name:string,fallback:number,min:number,max:number):number {
  const value=Number(env[name]??fallback);
  if(!Number.isInteger(value)||value<min||value>max) throw new Error(`INVALID_${name}`);
  return value;
}
export function upstreamFromEnvironment(env:NodeJS.ProcessEnv):{upstream:Upstream;close?:()=>Promise<void>} {
  const kind=env.PTR_GATEWAY_UPSTREAM??'fake';
  if(kind==='fake') {
    // Load tests: the deterministic fake model, optionally with the seeded latency profile.
    const fake=new FakeTextProvider();
    return {upstream:env.PTR_FAKE_LATENCY!==undefined
      ?new TextProviderUpstream(new LatencyInjectedTextProvider(fake,parseLatencyProfile(env.PTR_FAKE_LATENCY)),'synthetic/fake-text-v1+latency')
      :new TextProviderUpstream(fake,'synthetic/fake-text-v1')};
  }
  if(env.PTR_FAKE_LATENCY!==undefined) throw new Error('LATENCY_INJECTION_ONLY_FOR_FAKE');
  if(kind==='selfhosted') {
    if(!env.PTR_SELFHOSTED_BASE_URL||!env.PTR_SELFHOSTED_MODEL) throw new Error('SELFHOSTED_NOT_CONFIGURED');
    return {upstream:new OpenAICompatibleUpstream({baseUrl:env.PTR_SELFHOSTED_BASE_URL,model:env.PTR_SELFHOSTED_MODEL})};
  }
  if(kind==='openrouter') {
    // Billable: the shared budget ledger (idempotent, never resubmits an unresolved request) lives in the gateway.
    const databaseUrl=env.GOAL1_DATABASE_URL??env.DATABASE_URL??'';const pool=createLocalPool(databaseUrl);
    const liveEnv={...env,GOAL1_DATABASE_URL:databaseUrl,GOAL1_TEXT_MODEL:env.GOAL1_TEXT_MODEL??env.PTR_MODEL??env.TEXT_MODEL};
    const client=new OpenRouterClient(liveOptionsFromEnvironment(liveEnv,new PostgresBudgetLedger(pool,databaseUrl)));
    return {upstream:new TextProviderUpstream(client,liveEnv.GOAL1_TEXT_MODEL??DEFAULT_TEXT_MODEL),close:()=>pool.end()};
  }
  throw new Error('INVALID_PTR_GATEWAY_UPSTREAM');
}
async function main() {
  const env=process.env;
  const {upstream,close}=upstreamFromEnvironment(env);
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
