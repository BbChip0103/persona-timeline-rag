/**
 * S4 acceptance (routing ) with FakeEngineUpstream engines behind the real gateway + UpstreamPool.
 * Zero cost; no Redis (static source: epoch never changes, like a file or env upstream).
 *
 *   pnpm exec tsx scripts/telemetry-acceptance.ts [--rate=8] [--seconds=15] [--seed=1]
 *
 * Scenarios (two engines a, b of the same speed unless noted; open-loop W1 arrivals from routing-compare's seeded plan):
 *   A1  b reports KV usage 0.97 the whole run: telemetry on vs off → b's dispatches.
 *   A1b b has 3 engine slots but is registered with maxSeqs 12 (credit model too loose): on vs off → b's dispatches,
 *       b's peak engine waiting, TTFT p95, credit_model_miss.
 *   A2  b reports KV 0.97; at 5 s its /metrics stops answering → after 3 × interval the filter is ignored (fail-open)
 *       and b gets dispatches again.
 *   A3  telemetry off; b's engine stops at 2 s (refused connections open its breaker), comes back at 5 s; after the
 *       cooldown the probe closes the breaker and b's limit ramps from 1 over the slow-start time (10 s here).
 *   A4  telemetry on; b's engine restarts at 5 s (new process_start_time_seconds, same port and epoch) → b's state is
 *       cleared: restart event, fresh breaker, slow start again.
 * Writes reports/telemetry-acceptance-<run>.json and prints the table.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpstreamRecord } from '@ptr/messaging/registry';
import { createGateway } from '../apps/gateway/src/server';
import { UpstreamPool, type PoolOptions } from '../apps/gateway/src/pool';
import { StaticUpstreamSource } from '../apps/gateway/src/sources';
import { FakeEngine, type FakeEngineConfig } from './fake-engine';
import { plan } from './routing-compare';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const FULL={slots:12,prefillTokensPerSec:8000,tpotMs:8,kvCapacityTokens:43000};
const TELEMETRY={intervalMs:1000,kvHigh:0.95,waitingMax:2};
const pct=(values:number[],p:number)=>{if(!values.length) return null;const s=[...values].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(p*s.length)-1)]!;};

interface Sample {at:number;b:{limit:number|null;inFlight:number;breaker:string;blocked:boolean|null;stale:boolean|null;rampReason:string|null};bWaiting:number|null;bDispatched:number}
interface Run {
  engines:FakeEngine[];pool:UpstreamPool;base:string;token:string;
  results:{start:number;ttft:number|null;status:number}[];samples:Sample[];
}
async function setup(specs:(FakeEngineConfig&{maxSeqs?:number})[],options:Partial<PoolOptions>):Promise<Run&{close():Promise<void>}> {
  const engines=specs.map(spec=>new FakeEngine(spec));
  for(const engine of engines) await engine.start();
  const records:UpstreamRecord[]=specs.map((spec,i)=>({pool:'fake',id:spec.name,baseUrl:engines[i]!.baseUrl,maxSeqs:spec.maxSeqs??12,kvCapacityTokens:spec.kvCapacityTokens,
    weight:1,state:'active',epoch:'file',seq:0}));
  // The fake engines send headers with the first token (after queueing/prefill), unlike vLLM, which sends them at once: the
  // default primary headers timeout (10 s) would count their queueing as hung-engine timeouts, so it is off here as before.
  const pool=new UpstreamPool({model:'fake',source:new StaticUpstreamSource(records),admission:true,maxQueue:256,queueTimeoutMs:10000,slowStartMs:0,...options,failover:{headersTimeoutMs:0,...options.failover}});
  const token=randomBytes(24).toString('hex');
  const {server}=createGateway({token,upstream:pool,limits:{maxConcurrent:4096,maxQueue:4096,queueTimeoutMs:10000,upstreamTimeoutMs:60000}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
  return {engines,pool,base,token,results:[],samples:[],close:async()=>{
    server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.close();for(const e of engines) await e.stop();
  }};
}
async function call(run:Run,messages:unknown,output:number,t0:number):Promise<void> {
  const start=Date.now();let ttft:number|null=null,text='';
  try {
    const response=await fetch(`${run.base}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${run.token}`,'Content-Type':'application/json'},
      body:JSON.stringify({messages,stream:true,max_tokens:512,ptr_fake_output_tokens:output}),signal:AbortSignal.timeout(60000)});
    if(response.status!==200) {await response.body?.cancel();run.results.push({start:start-t0,ttft:null,status:response.status});return;}
    const reader=response.body!.getReader();const decoder=new TextDecoder();
    for(;;) {const {done,value}=await reader.read();if(done) break;if(ttft===null) ttft=Date.now()-start;text+=decoder.decode(value,{stream:true});}
    run.results.push({start:start-t0,ttft,status:text.includes('[DONE]')?200:599});
  } catch {run.results.push({start:start-t0,ttft:null,status:599});}
}
/** Open-loop load for `seconds`, sampling b every 100 ms; `events` run at their times (ms). */
async function load(run:Run,o:{rate:number;seconds:number;seed:number},events:[number,()=>void|Promise<void>][]=[]):Promise<void> {
  const t0=Date.now(), arrivals=plan('W1',o.rate,o.seconds*1000,o.seed,'open'), inflight:Promise<void>[]=[];
  const sampler=setInterval(()=>{
    const b=run.pool.poolMetrics().upstreams.find(u=>u.id==='b');if(!b) return;
    run.samples.push({at:Date.now()-t0,b:{limit:b.limit,inFlight:b.inFlight,breaker:b.breaker,blocked:b.telemetry?.blocked??null,stale:b.telemetry?.stale??null,rampReason:b.rampReason},
      bWaiting:run.engines[1]!.waitingCount,bDispatched:b.dispatched});
  },100);
  const timers=events.map(([at,fn])=>setTimeout(()=>void fn(),at));
  try {
    for(const arrival of arrivals) {
      const wait=t0+arrival.at-Date.now();if(wait>0) await sleep(wait);
      inflight.push(call(run,arrival.messages,arrival.output,t0));
    }
    await Promise.all(inflight);
  } finally {clearInterval(sampler);for(const timer of timers) clearTimeout(timer);}
}
const summary=(run:Run)=>{
  const ok=run.results.filter(r=>r.status===200), metrics=run.pool.poolMetrics();
  const up=(id:string)=>metrics.upstreams.find(u=>u.id===id);
  return {requests:run.results.length,failed:run.results.length-ok.length,ttftP95:pct(ok.map(r=>r.ttft!),0.95),
    dispatched:{a:up('a')?.dispatched??0,b:up('b')?.dispatched??0},bPeakEngineWaiting:Math.max(0,...run.samples.map(s=>s.bWaiting??0)),
    bTelemetry:up('b')?.telemetry??null,events:metrics.events};
};
/** b's dispatches inside [from, to) ms, from the sampled counter. */
const dispatchedBetween=(run:Run,from:number,to:number)=>{
  const at=(t:number)=>run.samples.filter(s=>s.at<=t).at(-1)?.bDispatched??0;
  return at(to)-at(from);
};

async function main():Promise<void> {
  const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...rest]=arg.replace(/^--/,'').split('=');return [key!,rest.join('=')];}));
  const o={rate:Number(args.rate??8),seconds:Number(args.seconds??15),seed:Number(args.seed??1)};
  const log=(line:string)=>process.stderr.write(`${line}\n`);
  const report:Record<string,unknown>={};

  // A1: forced high KV on b.
  for(const telemetry of [true,false]) {
    const run=await setup([{name:'a',...FULL},{name:'b',...FULL}],telemetry?{telemetry:TELEMETRY}:{});
    run.engines[1]!.report({kvUsage:0.97});
    await sleep(1200); // first polls
    await load(run,o);
    report[`A1_highKv_telemetry_${telemetry?'on':'off'}`]=summary(run);await run.close();
    log(`A1 telemetry ${telemetry?'on':'off'}: ${JSON.stringify(report[`A1_highKv_telemetry_${telemetry?'on':'off'}`])}`);
  }
  // A1b: b's engine has 3 slots but maxSeqs 12 is registered.
  for(const telemetry of [true,false]) {
    const run=await setup([{name:'a',...FULL},{name:'b',...FULL,slots:3}],telemetry?{telemetry:TELEMETRY}:{});
    await sleep(1200);
    await load(run,o);
    report[`A1b_engineQueue_telemetry_${telemetry?'on':'off'}`]=summary(run);await run.close();
    log(`A1b telemetry ${telemetry?'on':'off'}: ${JSON.stringify(report[`A1b_engineQueue_telemetry_${telemetry?'on':'off'}`])}`);
  }
  // A2: stale telemetry falls back to the ledger.
  {
    const run=await setup([{name:'a',...FULL},{name:'b',...FULL}],{telemetry:TELEMETRY});
    run.engines[1]!.report({kvUsage:0.97});
    await sleep(1200);
    await load(run,o,[[5000,()=>run.engines[1]!.hangMetrics(true)]]);
    const staleAt=run.samples.find(s=>s.at>=5000&&s.b.stale)?.at??null;
    const firstAfter=staleAt===null?null:run.samples.find(s=>s.at>=staleAt&&s.bDispatched>(run.samples.find(x=>x.at>=staleAt)?.bDispatched??0))?.at??null;
    report.A2_stale={...summary(run),bDispatchedBefore5s:dispatchedBetween(run,0,5000),bDispatched5sToStale:staleAt===null?null:dispatchedBetween(run,5000,staleAt),
      staleAtMs:staleAt,staleAfterHangMs:staleAt===null?null:staleAt-5000,bDispatchedAfterStale:staleAt===null?null:dispatchedBetween(run,staleAt,o.seconds*1000+60000),firstBDispatchAfterStaleMs:firstAfter};
    await run.close();log(`A2: ${JSON.stringify(report.A2_stale)}`);
  }
  // A3: breaker close → slow start (telemetry off to isolate it).
  {
    const run=await setup([{name:'a',...FULL},{name:'b',...FULL}],{slowStartMs:10000,failover:{failureThreshold:3,cooldownMs:3000,probeTimeoutMs:1000}});
    const b=run.engines[1]!, port=()=>b.port;let bPort=0;
    await load(run,{...o,seconds:Math.max(o.seconds,20)},[[2000,async()=>{bPort=port();await b.stop();}],[5000,async()=>{await b.start(bPort);}]]);
    const opened=run.samples.find(s=>s.b.breaker!=='closed')?.at??null;
    const closed=opened===null?null:run.samples.find(s=>s.at>opened&&s.b.breaker==='closed')?.at??null;
    const limitAt=(offset:number)=>closed===null?null:run.samples.filter(s=>s.at<=closed+offset).at(-1)?.b.limit??null;
    report.A3_breakerSlowStart={...summary(run),breakerOpenedAtMs:opened,breakerClosedAtMs:closed,rampReasonAtClose:closed===null?null:run.samples.find(s=>s.at>=closed)?.b.rampReason??null,
      limitAfterClose:{'0s':limitAt(100),'2.5s':limitAt(2500),'5s':limitAt(5000),'7.5s':limitAt(7500),'10s':limitAt(10100)},
      maxBInFlightFirst2sAfterClose:closed===null?null:Math.max(0,...run.samples.filter(s=>s.at>=closed&&s.at<closed+2000).map(s=>s.b.inFlight))};
    await run.close();log(`A3: ${JSON.stringify(report.A3_breakerSlowStart)}`);
  }
  // A4: engine restart detected from process_start_time_seconds (static source: same epoch).
  {
    const run=await setup([{name:'a',...FULL},{name:'b',...FULL}],{slowStartMs:10000,telemetry:TELEMETRY});
    await sleep(1200);
    await load(run,o,[[5000,()=>run.engines[1]!.restart()]]);
    const restartSeen=run.samples.find(s=>s.at>=5000&&s.b.rampReason==='restarted')?.at??null;
    report.A4_restart={...summary(run),restartAtMs:5000,restartSeenAtMs:restartSeen,limitAtRestartSeen:restartSeen===null?null:run.samples.find(s=>s.at>=restartSeen)?.b.limit??null,
      limit5sLater:restartSeen===null?null:run.samples.filter(s=>s.at<=restartSeen+5000).at(-1)?.b.limit??null,breakerAfter:run.samples.at(-1)?.b.breaker??null};
    await run.close();log(`A4: ${JSON.stringify(report.A4_restart)}`);
  }
  const run=`${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const directory=join(process.cwd(),'reports');await mkdir(directory,{recursive:true});
  const file=join(directory,`telemetry-acceptance-${run}.json`);
  await writeFile(file,JSON.stringify({run,options:o,telemetry:TELEMETRY,report},null,2));
  process.stdout.write(`${JSON.stringify({file,report},null,2)}\n`);
}
if(require.main===module) void main().catch(error=>{process.stderr.write(`TELEMETRY_ACCEPTANCE_FAILED ${(error as Error).message}\n`);process.exitCode=1;});
