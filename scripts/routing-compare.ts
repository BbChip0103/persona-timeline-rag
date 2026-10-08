/**
 * Routing comparison : round_robin vs least_inflight vs scored, each optionally `+affinity` (S5 cache
 * affinity at 256 tokens / slack 0.5), behind the real gateway + UpstreamPool (credit admission, central queue, prefix
 * tables), in front of FakeEngineUpstream engines. Zero cost.
 *
 *   pnpm exec tsx scripts/routing-compare.ts [--configs=homogeneous,heterogeneous] [--workloads=W1,W2,W3,W4]
 *       [--policies=round_robin,least_inflight,scored] [--seeds=3] [--grid=0.8,0.9,1,1.1,1.2] [--seconds=15]
 *       [--warmup=3] [--arrivals=open|closed] [--knees=homogeneous/W1=9.5,...] [--knee-seeds=3] [--drain=65]
 *   pnpm exec tsx scripts/routing-compare.ts --merge=reports/a.json,reports/b.json   # one verdict over runs made in parallel
 *
 * Configs: homogeneous = 2 × (1.0×: prefill 8000 tok/s, TPOT 8 ms, KV 43k); heterogeneous = 1.0× + 0.5× (prefill 4000,
 * TPOT 16 ms, KV ¼ = 10.75k, registered weight 0.5). Every engine: 12 slots, gateway maxSeqs 12, kvCapacityTokens = its KV.
 * Workloads (requests built like the app's: 5029 B policy, 858 B persona, history, state, user — the state after the
 * history as in the approved S7 layout, so a W3 session's turns share a prefix that grows with its history):
 *   W1 measured lengths (lognormal, p50 1886 / p95 7155 tokens); W2 80% short / 20% long; W3 50 personas Zipf(1.2),
 *   sessions of 5–10 turns whose history grows (open loop: a turn every 2.5 s, sessions already running at t = 0); W4 a 20 s burst at 2× the rate (supplementary, not in the verdict).
 *
 * Method (revised after the S3 review):
 * 1. Knee: per (config, workload), a coarse sweep with least_inflight (the incumbent default) on `--knee-seeds` seeds
 *    (default 3, seeds 0, 101, 202…; the S4 report used one) finds per seed the highest rate of the monotone prefix whose
 *    TTFT p95 (failures counted as ∞) is ≤ 2 s; the grid uses their median. `--knees` skips it.
 * 2. Grid: knee × `--grid` (default 0.8…1.2). "Rate 1.0" in the acceptance = the measured knee, not a nominal guess.
 * 3. Seeds: every point runs `--seeds` seeds (default 3); arrivals, token lengths, outputs and flows all come from the
 *    seeded RNG, and with `--arrivals=open` (default) W3's turns are scheduled up front at 2.5 s spacing, so every
 *    policy sees byte-identical workloads. `--arrivals=closed` keeps the earlier closed-loop sessions (next turn
 *    300 ms after the answer), which is realistic but makes the workload depend on the policy.
 *    Order: seed → rate → policy, so slow drift of the host affects the policies alike.
 * 4. Drain: after the last arrival every request is awaited (each has a 60 s client timeout, bounded by `--drain`);
 *    requests still open then are counted as unfinished. Every request started in the measured window counts:
 *    rejected, failed and unfinished requests are failures, and TTFT p95 is computed with failures as ∞ (a point with
 *    more than 5% failures has an infinite p95). Throughput = completed requests started in the window / window.
 * 5. Acceptance (thresholds fixed before the first S3 run, unchanged): scored vs least_inflight — heterogeneous W2 and
 *    W3: one of (max throughput with TTFT p95 ≤ 2 s across the grid, TTFT p95 at the knee) ≥ 10% better with the other
 *    ≤ 5% worse; homogeneous W1: both ≤ 5% worse. Evaluated on the seed means; per-seed paired gains with 95% t
 *    intervals are reported next to them. The default changes only if all three hold (`verdict.scored`).
 * 6. Affinity acceptance (pre-registered in S5 before its first run): least_inflight+affinity vs least_inflight — W3 on
 *    both configs: TTFT p95 at the knee ≥ 10% better with max throughput under the SLO ≤ 5% worse; W1 on both configs:
 *    both ≤ 5% worse (`verdict.affinity`, affinityAcceptance). Points also report the engine prefix hit rate (requests
 *    and tokens), dispatch imbalance and affinity outcomes.
 * Writes reports/routing-compare-<run>.json.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpstreamRecord } from '@ptr/messaging/registry';
import { createGateway } from '../apps/gateway/src/server';
import { UpstreamPool } from '../apps/gateway/src/pool';
import { StaticUpstreamSource } from '../apps/gateway/src/sources';
import { ROUTING_POLICIES, type RoutingPolicy } from '../apps/gateway/src/admission';
import { FakeEngine, type FakeEngineConfig } from './fake-engine';

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** `maxSeqs`: what the operator registers for the gateway (default 12, the engine's slots stay 12). */
type EngineSpec=FakeEngineConfig&{weight:number;maxSeqs?:number};
const FULL={slots:12,prefillTokensPerSec:8000,tpotMs:8,kvCapacityTokens:43000};
const HALF={slots:12,prefillTokensPerSec:4000,tpotMs:16,kvCapacityTokens:10750};
/** `nominal`: the earlier guess of capacity (req/s); only the start of the knee sweep now. */
export const CONFIGS:Record<string,{engines:EngineSpec[];nominal:number}>={
  homogeneous:{engines:[{name:'a',...FULL,weight:1},{name:'b',...FULL,weight:1}],nominal:12},
  heterogeneous:{engines:[{name:'a',...FULL,weight:1},{name:'b',...HALF,weight:0.5}],nominal:8},
  /** Supplementary (not in the acceptance verdict): the half-speed server registered with maxSeqs 6 (S_u matched to its speed). */
  heterogeneous_s6:{engines:[{name:'a',...FULL,weight:1},{name:'b',...HALF,weight:0.5,maxSeqs:6}],nominal:8},
};
const SLO_MS=2000, FAILURE_SHARE=0.05, W3_TURN_SPACING_MS=2500;
const KNEE_SWEEP=[0.5,0.625,0.75,0.875,1,1.125,1.25,1.5];

/** Seeded PRNG (mulberry32). */
function rng(seed:number):()=>number {
  let a=seed>>>0;
  return ()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
const normal=(random:()=>number)=>Math.sqrt(-2*Math.log(Math.max(1e-12,random())))*Math.cos(2*Math.PI*random());
const hex=(random:()=>number,digits:number)=>Array.from({length:digits},()=>Math.floor(random()*16).toString(16)).join('');
const BYTES_PER_TOKEN=4.45;
const POLICY='정책 '.repeat(1).padEnd(5029,'P');
const PERSONAS=Array.from({length:50},(_,i)=>`persona-${i} `.padEnd(858,String.fromCharCode(97+(i%26))));
const ANSWER='답변 '.padEnd(600,'a');
interface Message {role:string;content:string}
/** App-shaped request of about `tokens` engine tokens; `history` is reused verbatim across a session's turns. */
/**
 * Layout (S5): policy, persona, history, agent state, user — the state after the history as in the approved prompt
 * reordering ( P2, stage S7), so a session's turns share a prefix that grows with its history. With the
 * current app layout (state before the history, changing with topic/tone) the shared prefix would stop at the persona.
 */
function buildMessages(persona:number,history:Message[],tokens:number,random:()=>number):Message[] {
  const fixed=5029+858+120+history.reduce((sum,m)=>sum+Buffer.byteLength(m.content),0);
  const userBytes=Math.max(40,Math.round(tokens*BYTES_PER_TOKEN-fixed));
  const state=`AGENT_STATE_JSON_DATA {"topic":"t${Math.floor(random()*9)}"}`.padEnd(120,' ');
  return [{role:'system',content:POLICY},{role:'system',content:PERSONAS[persona]!},...history,{role:'system',content:state},{role:'user',content:'질문 '.padEnd(userBytes,'q')}];
}
const outputTokens=(random:()=>number)=>Math.max(20,Math.min(400,Math.round(150*Math.exp(0.5*normal(random)))));

export interface Arrival {at:number;flow:string;messages:Message[];output:number;session?:{persona:number;turns:number;seed:number}}
/**
 * Arrival plan for one point, entirely from `seed`. W3 open: every turn is an arrival at session start + k × 2.5 s with
 * its history built up front; W3 closed: one arrival per session whose turns are generated after each answer.
 */
export function plan(workload:string,rate:number,durationMs:number,seed:number,mode:'open'|'closed'):Arrival[] {
  const random=rng(seed), arrivals:Arrival[]=[];
  if(workload==='W3') {
    // Sessions start at rate/7.5 per second (7.5 turns each on average); Zipf(1.2) over 50 personas.
    const weights=PERSONAS.map((_,i)=>1/Math.pow(i+1,1.2)), total=weights.reduce((a,b)=>a+b,0);
    const zipf=()=>{let x=random()*total;for(let i=0;i<weights.length;i++){x-=weights[i]!;if(x<=0) return i;}return weights.length-1;};
    // Open loop: sessions also start before 0 (up to one longest session earlier), so turns arrive at the steady rate
    // from the first second instead of ramping up over a session's lifetime; turns before 0 are not sent.
    for(let t=mode==='open'?-9*W3_TURN_SPACING_MS:0;t<durationMs;) {
      t+=-Math.log(Math.max(1e-12,random()))/(rate/7.5)*1000;if(t>=durationMs) break;
      const persona=zipf(), turns=5+Math.floor(random()*6), flow=hex(random,8), sessionSeed=Math.floor(random()*2**31);
      if(mode==='closed') {arrivals.push({at:t,flow,messages:[],output:0,session:{persona,turns,seed:sessionSeed}});continue;}
      const own=rng(sessionSeed), history:Message[]=[];
      for(let turn=0;turn<turns;turn++) {
        const at=t+turn*W3_TURN_SPACING_MS;if(at>=durationMs) break;
        const messages=buildMessages(persona,history,1500+own()*300,own), output=outputTokens(own);
        if(at>=0) arrivals.push({at,flow,messages,output});
        history.push({role:'user',content:messages.at(-1)!.content},{role:'assistant',content:ANSWER});
      }
    }
    return arrivals.sort((a,b)=>a.at-b.at);
  }
  const until=workload==='W4'?20000:durationMs, lambda=workload==='W4'?rate*2:rate;
  for(let t=0;t<until;) {
    t+=-Math.log(Math.max(1e-12,random()))/lambda*1000;if(t>=until) break;
    const tokens=workload==='W2'?(random()<0.8?1400+random()*400:6000+random()*2000)
      :Math.max(1400,Math.min(14000,1886*Math.exp(0.81*normal(random))));
    arrivals.push({at:t,flow:hex(random,2),messages:buildMessages(Math.floor(random()*4),[],tokens,random),output:outputTokens(random)});
  }
  return arrivals;
}

export interface Sample {start:number;ttft:number|null;e2e:number|null;status:number;flow:string}
async function call(base:string,token:string,messages:Message[],output:number,flow:string,t0:number):Promise<Sample> {
  const start=Date.now();let ttft:number|null=null,text='';
  try {
    const response=await fetch(`${base}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-PTR-Flow':flow},
      body:JSON.stringify({messages,stream:true,max_tokens:512,ptr_fake_output_tokens:output}),signal:AbortSignal.timeout(60000)});
    if(response.status!==200) {await response.body?.cancel();return {start:start-t0,ttft:null,e2e:null,status:response.status,flow};}
    const reader=response.body!.getReader();const decoder=new TextDecoder();
    for(;;) {const {done,value}=await reader.read();if(done) break;if(ttft===null) ttft=Date.now()-start;text+=decoder.decode(value,{stream:true});}
    return {start:start-t0,ttft,e2e:Date.now()-start,status:text.includes('[DONE]')?200:599,flow};
  } catch {return {start:start-t0,ttft:null,e2e:null,status:599,flow};}
}
const pct=(values:number[],p:number)=>{if(!values.length) return null;const s=[...values].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(p*s.length)-1)]!;};
function jain(values:number[]):number|null {
  if(!values.length) return null;const sum=values.reduce((a,b)=>a+b,0),squares=values.reduce((a,b)=>a+b*b,0);
  return squares?Math.round(sum*sum/(values.length*squares)*1000)/1000:null;
}

/** Statistics of one point over the requests started in [windowStart, windowEnd); `unfinished` were still open at the cut-off. */
export function pointStats(samples:Sample[],window:{windowStart:number;windowEnd:number;unfinished:number}) {
  const measured=samples.filter(s=>s.start>=window.windowStart&&s.start<window.windowEnd);
  const ok=measured.filter(s=>s.status===200), requests=measured.length+window.unfinished, failed=requests-ok.length;
  const ttfts=ok.map(s=>s.ttft!), e2es=ok.map(s=>s.e2e!);
  // Failures as +∞: the p95 index falls on a failure once more than 5% of the requests failed.
  const all=[...ttfts].sort((a,b)=>a-b), index=Math.min(requests-1,Math.ceil(0.95*requests)-1);
  const ttftP95All=requests&&index<all.length?all[index]!:null;
  const byFlow=new Map<string,number[]>();for(const s of ok) byFlow.set(s.flow,[...(byFlow.get(s.flow)??[]),s.ttft!]);
  return {requests,completed:ok.length,failed,unfinished:window.unfinished,
    throughput:Math.round(ok.length/((window.windowEnd-window.windowStart)/1000)*1000)/1000,
    ttftP50:pct(ttfts,0.5),ttftP95Completed:pct(ttfts,0.95),ttftP95All,e2eP50:pct(e2es,0.5),e2eP95:pct(e2es,0.95),
    rejected:{queue_full:measured.filter(s=>s.status===429).length,queue_timeout:measured.filter(s=>s.status===503).length,
      errors:measured.filter(s=>s.status!==200&&s.status!==429&&s.status!==503).length},
    jain:jain([...byFlow.values()].map(v=>v.reduce((a,b)=>a+b,0)/v.length))};
}
/** The grid's knee: the median of the per-seed knees (one seed's knee does not hold for other seeds). */
export function medianKnee(knees:number[]):number {
  const sorted=[...knees].sort((a,b)=>a-b), mid=Math.floor(sorted.length/2);
  return sorted.length%2?sorted[mid]!:(sorted[mid-1]!+sorted[mid]!)/2;
}
type RunOptions={measureMs:number;warmupMs:number;drainMs:number;arrivals:'open'|'closed'};
/** What a report stores as its method: everything that shapes the points and knees (--merge requires it to be equal). */
export function reportMethod(input:{grid:number[];seeds:number;kneeSeeds:number;o:RunOptions}) {
  const {grid,seeds,kneeSeeds,o}=input;
  return {grid,seeds,kneeSeeds,measureMs:o.measureMs,warmupMs:o.warmupMs,drainMs:o.drainMs,arrivals:o.arrivals,slo:SLO_MS,failureShare:FAILURE_SHARE,kneeSweep:KNEE_SWEEP,
    promptLayout:'state_after_history' as const,
    /** S5 review: engine KV = prompt − prefix shared with running requests + output; cache in the free KV only. */
    fakeEngine:'kv-shared-running' as const};
}
/** A compared variant: a routing policy, optionally with cache affinity (`least_inflight+affinity`, at the design defaults 256 / 0.5). */
export function parseVariant(variant:string):{routing:RoutingPolicy;affinity:boolean} {
  const [routing,extra,...rest]=variant.split('+');
  if(!(ROUTING_POLICIES as readonly string[]).includes(routing!)||(extra!==undefined&&extra!=='affinity')||rest.length) throw new Error('INVALID_VARIANT');
  return {routing:routing as RoutingPolicy,affinity:extra==='affinity'};
}
/** max / mean of the dispatches per upstream (1 = even); null without dispatches. */
export function imbalance(dispatched:Record<string,number>):number|null {
  const counts=Object.values(dispatched), total=counts.reduce((a,b)=>a+b,0);
  return total?r3(Math.max(...counts)/(total/counts.length)):null;
}
/** --merge combines only runs of the same method (a report without a field the current one has differs too). */
export function assertSameMethod(methods:object[]):void {
  if(new Set(methods.map(method=>JSON.stringify(method))).size>1) throw new Error('MERGE_METHOD_MISMATCH');
}
/** Points of several runs; the same (config, workload, policy, seed, factor) twice is an error, never silently averaged. */
export function mergePoints<T extends {config:string;workload:string;policy:string;seed:number;factor?:number}>(runs:T[][]):T[] {
  const seen=new Set<string>(), out:T[]=[];
  for(const point of runs.flat()) {
    const key=`${point.config}|${point.workload}|${point.policy}|${point.seed}|${point.factor}`;
    if(seen.has(key)) throw new Error('MERGE_DUPLICATE_POINT');
    seen.add(key);out.push(point);
  }
  return out;
}
/** Highest rate of the monotone prefix (ascending rates) with a finite TTFT p95 ≤ 2 s; the lowest rate if none. */
export function findKnee(points:{rate:number;ttftP95All:number|null}[]):number {
  const sorted=[...points].sort((a,b)=>a.rate-b.rate);let knee=sorted[0]!.rate;
  for(const p of sorted) {if(p.ttftP95All===null||p.ttftP95All>SLO_MS) break;knee=p.rate;}
  return knee;
}
const T95=[NaN,12.706,4.303,3.182,2.776,2.571,2.447,2.365,2.306,2.262];
const r3=(x:number)=>Math.round(x*1000)/1000;
/** Mean and 95% t interval (n − 1 degrees of freedom); no interval for one value. */
export function meanInterval(values:number[]):{mean:number;low:number|null;high:number|null;n:number}|null {
  const n=values.length;if(!n) return null;
  const mean=values.reduce((a,b)=>a+b,0)/n;
  if(n<2) return {mean:r3(mean),low:null,high:null,n};
  const sd=Math.sqrt(values.reduce((a,b)=>a+(b-mean)**2,0)/(n-1)), half=(T95[n-1]??1.96)*sd/Math.sqrt(n);
  return {mean:r3(mean),low:r3(mean-half),high:r3(mean+half),n};
}

/** Per policy and seed: max throughput meeting the SLO across the grid (0 if none), TTFT p95 (failures ∞) at the knee (null = ∞). */
export interface PolicySeries {maxThroughputUnderSlo:number[];ttftP95AtKnee:(number|null)[]}
type Combo={scored:PolicySeries;least_inflight:PolicySeries};
/** A candidate against the incumbent (the current default). Gains: positive = candidate better. */
function compareCombo(c:{candidate:PolicySeries;incumbent:PolicySeries}) {
  const mean=(xs:number[])=>xs.reduce((a,b)=>a+b,0)/xs.length;
  const finite=(xs:(number|null)[])=>xs.every(x=>x!==null)?xs as number[]:null;
  const sThr=mean(c.candidate.maxThroughputUnderSlo), lThr=mean(c.incumbent.maxThroughputUnderSlo);
  const sTtft=finite(c.candidate.ttftP95AtKnee), lTtft=finite(c.incumbent.ttftP95AtKnee);
  const throughputGain=lThr>0?r3((sThr-lThr)/lThr):null;
  // A seed with an infinite p95 (> 5% failures) makes that policy's mean infinite: a loss for it, never neutral.
  // Positive = candidate better; only candidate ∞ → −∞, only incumbent ∞ → +∞, both ∞ → null (no comparison).
  const ttftP95Gain=!sTtft&&!lTtft?null:!sTtft?-Infinity:!lTtft?Infinity:mean(lTtft)>0?r3((mean(lTtft)-mean(sTtft))/mean(lTtft)):null;
  const seeds=Math.min(c.candidate.maxThroughputUnderSlo.length,c.incumbent.maxThroughputUnderSlo.length);
  const pairedThr:number[]=[], pairedTtft:number[]=[];
  for(let i=0;i<seeds;i++) {
    const l=c.incumbent.maxThroughputUnderSlo[i]!, s=c.candidate.maxThroughputUnderSlo[i]!;if(l>0) pairedThr.push((s-l)/l);
    const lt=c.incumbent.ttftP95AtKnee[i], st=c.candidate.ttftP95AtKnee[i];if(lt&&st!==null&&st!==undefined) pairedTtft.push((lt-st)/lt);
  }
  return {throughputGain,ttftP95Gain,candidate:{maxThroughputUnderSlo:meanInterval(c.candidate.maxThroughputUnderSlo),ttftP95AtKnee:sTtft?meanInterval(sTtft):null},
    incumbent:{maxThroughputUnderSlo:meanInterval(c.incumbent.maxThroughputUnderSlo),ttftP95AtKnee:lTtft?meanInterval(lTtft):null},
    paired:{throughputGain:meanInterval(pairedThr),ttftP95Gain:meanInterval(pairedTtft)}};
}
const scoredPair=(c:Combo)=>({candidate:c.scored,incumbent:c.least_inflight});
type Gains={throughputGain:number|null;ttftP95Gain:number|null};
const better=(c:Gains)=>((c.throughputGain??-1)>=0.10&&(c.ttftP95Gain??0)>=-0.05)||((c.ttftP95Gain??-1)>=0.10&&(c.throughputGain??0)>=-0.05);
const notWorse=(c:Gains)=>(c.throughputGain??0)>=-0.05&&(c.ttftP95Gain??0)>=-0.05;
/** The pre-registered acceptance on seed means. */
export function acceptance(input:{heterogeneousW2:Combo;heterogeneousW3:Combo;homogeneousW1:Combo}) {
  const comparisons={heterogeneousW2:compareCombo(scoredPair(input.heterogeneousW2)),heterogeneousW3:compareCombo(scoredPair(input.heterogeneousW3)),
    homogeneousW1:compareCombo(scoredPair(input.homogeneousW1))};
  const verdict={heterogeneousW2:better(comparisons.heterogeneousW2),heterogeneousW3:better(comparisons.heterogeneousW3),homogeneousW1:notWorse(comparisons.homogeneousW1)};
  return {comparisons,verdict:{...verdict,scoredBecomesDefault:verdict.heterogeneousW2&&verdict.heterogeneousW3&&verdict.homogeneousW1}};
}
type OnOff={on:PolicySeries;off:PolicySeries};
/**
 * Cache affinity bar, pre-registered in S5 before the first affinity run (least_inflight+affinity vs least_inflight, the
 * same seed-mean gains and ∞ rule as above): W3 on both configs — TTFT p95 at the knee ≥ 10% better and max throughput
 * under the SLO ≤ 5% worse; W1 on both configs — both ≤ 5% worse. Affinity becomes the default only if all four hold.
 */
export function affinityAcceptance(input:{homogeneousW3:OnOff;heterogeneousW3:OnOff;homogeneousW1:OnOff;heterogeneousW1:OnOff}) {
  const compare=(c:OnOff)=>compareCombo({candidate:c.on,incumbent:c.off});
  const comparisons={homogeneousW3:compare(input.homogeneousW3),heterogeneousW3:compare(input.heterogeneousW3),
    homogeneousW1:compare(input.homogeneousW1),heterogeneousW1:compare(input.heterogeneousW1)};
  const faster=(c:Gains)=>(c.ttftP95Gain??-1)>=0.10&&(c.throughputGain??0)>=-0.05;
  const verdict={homogeneousW3:faster(comparisons.homogeneousW3),heterogeneousW3:faster(comparisons.heterogeneousW3),
    homogeneousW1:notWorse(comparisons.homogeneousW1),heterogeneousW1:notWorse(comparisons.heterogeneousW1)};
  return {comparisons,verdict:{...verdict,affinityBecomesDefault:Object.values(verdict).every(Boolean)}};
}

async function point(configName:string,workload:string,policy:string,rate:number,seed:number,o:RunOptions) {
  const variant=parseVariant(policy);
  const config=CONFIGS[configName]!, token=randomBytes(24).toString('hex');
  const engines=config.engines.map(spec=>new FakeEngine(spec));
  for(const engine of engines) await engine.start();
  const records:UpstreamRecord[]=config.engines.map((spec,i)=>({pool:'fake',id:spec.name,baseUrl:engines[i]!.baseUrl,maxSeqs:spec.maxSeqs??12,kvCapacityTokens:spec.kvCapacityTokens,
    weight:spec.weight,state:'active',epoch:'e',seq:0}));
  const pool=new UpstreamPool({model:'fake',source:new StaticUpstreamSource(records),admission:true,routing:variant.routing,maxQueue:256,queueTimeoutMs:10000,slowStartMs:0,
    routeLogSample:0,...(variant.affinity?{affinity:{minTokens:256,slack:0.5}}:{})});
  const {server}=createGateway({token,upstream:pool,limits:{maxConcurrent:4096,maxQueue:4096,queueTimeoutMs:10000,upstreamTimeoutMs:60000}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
  const durationMs=o.warmupMs+o.measureMs;
  const arrivals=plan(workload,rate,durationMs,seed,o.arrivals);
  const samples:Sample[]=[];const t0=Date.now();const inflight:Promise<void>[]=[];
  // Requests still open, by id → start (ms after t0): those started in the window are counted as unfinished at the cut-off.
  const open=new Map<number,number>();let nextId=0;
  const send=(messages:Message[],output:number,flow:string)=>{
    const id=nextId++;open.set(id,Date.now()-t0);
    return call(base,token,messages,output,flow,t0).then(sample=>{open.delete(id);samples.push(sample);});
  };
  for(const arrival of arrivals) {
    const wait=t0+arrival.at-Date.now();if(wait>0) await sleep(wait);
    if(arrival.session) {
      const s=arrival.session, random=rng(s.seed), history:Message[]=[];
      inflight.push((async()=>{
        for(let turn=0;turn<s.turns&&Date.now()-t0<durationMs;turn++) {
          const messages=buildMessages(s.persona,history,1500+random()*300,random);
          await send(messages,outputTokens(random),arrival.flow);
          history.push({role:'user',content:messages.at(-1)!.content},{role:'assistant',content:ANSWER});
          await sleep(300);
        }
      })());
    } else inflight.push(send(arrival.messages,arrival.output,arrival.flow));
  }
  // Drain: wait for every request (60 s client timeout each), bounded by drainMs after the last arrival.
  await Promise.race([Promise.all(inflight),sleep(o.drainMs)]);
  const windowEnd=workload==='W4'?20000:durationMs, windowStart=workload==='W4'?0:o.warmupMs;
  const unfinished=[...open.values()].filter(start=>start>=windowStart&&start<windowEnd).length;
  const metrics=pool.poolMetrics();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.close();
  const prefix=engines.reduce((acc,e)=>({q:acc.q+e.stats.prefixQueries,h:acc.h+e.stats.prefixHits,prompt:acc.prompt+e.stats.promptTokens,cached:acc.cached+e.stats.cachedTokens}),
    {q:0,h:0,prompt:0,cached:0});
  for(const engine of engines) await engine.stop();
  const dispatched=Object.fromEntries(metrics.upstreams.map(u=>[u.id,u.dispatched]));
  // Engine-side: requests with any prefix hit, and the share of prompt tokens served from the cache (whole run, warm-up included).
  return {config:configName,workload,policy,rate:Math.round(rate*1000)/1000,seed,...pointStats(samples,{windowStart,windowEnd,unfinished}),
    prefixHitRate:prefix.q?Math.round(prefix.h/prefix.q*1000)/1000:null,prefixTokenHitRate:prefix.prompt?Math.round(prefix.cached/prefix.prompt*1000)/1000:null,
    dispatched,imbalance:imbalance(dispatched),affinity:{picked:metrics.affinity.picked,brokenBySlack:metrics.affinity.brokenBySlack,none:metrics.affinity.none}};
}
type Point=Awaited<ReturnType<typeof point>>&{factor?:number};

async function main():Promise<void> {
  const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...rest]=arg.replace(/^--/,'').split('=');return [key!,rest.join('=')];}));
  const run=`${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  // --merge: reports of the same method run in parallel (e.g. one process per config/workload) → one summary and verdict.
  const merged=args.merge?await Promise.all(args.merge.split(',').map(async file=>JSON.parse(await readFile(file,'utf8')) as
    {run:string;method:ReturnType<typeof reportMethod>;knees:Record<string,number>;calibration:Point[];points:Point[]})):undefined;
  if(merged) assertSameMethod(merged.map(m=>m.method));
  const unique=(values:string[])=>[...new Set(values)];
  const configs=merged?unique(merged.flatMap(m=>m.points.map(p=>p.config))):(args.configs??'homogeneous,heterogeneous').split(',');
  const workloads=merged?unique(merged.flatMap(m=>m.points.map(p=>p.workload))):(args.workloads??'W1,W2,W3,W4').split(',');
  const policies=merged?unique(merged.flatMap(m=>m.points.map(p=>p.policy))):(args.policies??'round_robin,least_inflight,scored').split(',');
  for(const policy of policies) parseVariant(policy);
  const grid=merged?merged[0]!.method.grid:(args.grid??'0.8,0.9,1,1.1,1.2').split(',').map(Number), seeds=merged?merged[0]!.method.seeds:Number(args.seeds??3);
  const arrivalsMode=(args.arrivals??'open') as 'open'|'closed';
  if(arrivalsMode!=='open'&&arrivalsMode!=='closed') throw new Error('INVALID_ARRIVALS');
  const o=merged?merged[0]!.method:{measureMs:Number(args.seconds??15)*1000,warmupMs:Number(args.warmup??3)*1000,drainMs:Number(args.drain??65)*1000,arrivals:arrivalsMode};
  const kneeSeeds=merged?merged[0]!.method.kneeSeeds:Number(args['knee-seeds']??3);
  const given=Object.fromEntries((args.knees??'').split(',').filter(Boolean).map(entry=>{const [key,value]=entry.split('=');return [key!,Number(value)];}));
  const log=(line:string)=>process.stderr.write(`${line}\n`);
  const knees:Record<string,number>=merged?Object.assign({},...merged.map(m=>m.knees)):{}, calibration:Point[]=merged?merged.flatMap(m=>m.calibration):[];
  for(const config of configs) for(const workload of workloads) {
    const key=`${config}/${workload}`;
    if(merged) continue;
    if(given[key]) {knees[key]=given[key]!;continue;}
    if(workload==='W4') continue; // uses the W1 knee
    const perSeed:number[]=[];
    for(let k=0;k<kneeSeeds;k++) {
      const sweep:Point[]=[];
      for(const factor of KNEE_SWEEP) {
        const p=await point(config,workload,'least_inflight',CONFIGS[config]!.nominal*factor,k*101,o);sweep.push(p);calibration.push(p);
        log(`knee ${key} seed=${k*101} rate=${p.rate} ttftP95All=${p.ttftP95All} failed=${p.failed}`);
        if(p.ttftP95All===null||p.ttftP95All>SLO_MS) break;
      }
      perSeed.push(findKnee(sweep));
    }
    knees[key]=medianKnee(perSeed);log(`knee ${key} = ${knees[key]} req/s (per seed ${perSeed.join(', ')})`);
  }
  for(const config of configs) if(workloads.includes('W4')) knees[`${config}/W4`]??=knees[`${config}/W1`]??CONFIGS[config]!.nominal;
  const points:Point[]=merged?mergePoints(merged.map(m=>m.points)):[];
  for(const config of configs) for(const workload of workloads) {
    if(merged) break;
    const knee=knees[`${config}/${workload}`]!;
    for(let seed=1;seed<=seeds;seed++) for(const factor of workload==='W4'?[1]:grid) for(const policy of policies) {
      const p={...await point(config,workload,policy,knee*factor,seed,o),factor};points.push(p);
      log(`${config} ${workload} ${policy} ×${factor} seed=${seed}: thr=${p.throughput}/s ttft p95=${p.ttftP95All??'∞'} failed=${p.failed} unfinished=${p.unfinished}`);
    }
  }
  // Per (config, workload, policy, factor): seed means with intervals.
  const summary=[] as Record<string,unknown>[];
  const series=(config:string,workload:string,policy:string):PolicySeries=>{
    const per:PolicySeries={maxThroughputUnderSlo:[],ttftP95AtKnee:[]};
    for(let seed=1;seed<=seeds;seed++) {
      const ps=points.filter(p=>p.config===config&&p.workload===workload&&p.policy===policy&&p.seed===seed);
      if(!ps.length) continue;
      const under=ps.filter(p=>p.ttftP95All!==null&&p.ttftP95All<=SLO_MS);
      per.maxThroughputUnderSlo.push(under.length?Math.max(...under.map(p=>p.throughput)):0);
      per.ttftP95AtKnee.push(ps.find(p=>p.factor===1)?.ttftP95All??null);
    }
    return per;
  };
  for(const config of configs) for(const workload of workloads) for(const policy of policies) {
    const ps=points.filter(p=>p.config===config&&p.workload===workload&&p.policy===policy);
    if(!ps.length) continue; // a merge of separate runs covers only the combinations each run measured
    for(const factor of workload==='W4'?[1]:grid) {
      const at=ps.filter(p=>p.factor===factor);
      const infinite=at.filter(p=>p.ttftP95All===null).length;
      summary.push({config,workload,policy,factor,rate:at[0]?.rate,throughput:meanInterval(at.map(p=>p.throughput)),
        ttftP95All:infinite?{infiniteSeeds:infinite,finite:meanInterval(at.filter(p=>p.ttftP95All!==null).map(p=>p.ttftP95All!))}:meanInterval(at.map(p=>p.ttftP95All!)),
        ttftP50:meanInterval(at.map(p=>p.ttftP50??0)),failed:at.reduce((a,p)=>a+p.failed,0),unfinished:at.reduce((a,p)=>a+p.unfinished,0),
        requests:at.reduce((a,p)=>a+p.requests,0),prefixTokenHitRate:meanInterval(at.map(p=>p.prefixTokenHitRate??0)),
        imbalance:meanInterval(at.map(p=>p.imbalance??1)),affinityPicked:at.reduce((a,p)=>a+p.affinity.picked,0),
        affinityBrokenBySlack:at.reduce((a,p)=>a+p.affinity.brokenBySlack,0),affinityNone:at.reduce((a,p)=>a+p.affinity.none,0)});
    }
    const s=series(config,workload,policy);
    summary.push({config,workload,policy,maxThroughputUnderSlo:meanInterval(s.maxThroughputUnderSlo),perSeed:s});
  }
  // Two bars: scored vs least_inflight (S3) and least_inflight+affinity vs least_inflight (S5), each over the
  // combinations it names; a run that covers only some of them reports those comparisons as partial.
  const has=(config:string,workload:string,variants:string[])=>variants.every(policy=>points.some(p=>p.config===config&&p.workload===workload&&p.policy===policy));
  type Pair={candidate:PolicySeries;incumbent:PolicySeries};
  const bar=(candidate:string,incumbent:string,cells:[string,string][],full:(pairs:Record<string,Pair>)=>unknown)=>{
    const present=cells.filter(([c,w])=>has(c,w,[candidate,incumbent]));
    if(!present.length) return undefined;
    const pairs:Record<string,Pair>=Object.fromEntries(present.map(([c,w])=>[`${c}${w}`,{candidate:series(c,w,candidate),incumbent:series(c,w,incumbent)}]));
    return present.length===cells.length?full(pairs):{partial:Object.fromEntries(Object.entries(pairs).map(([key,pair])=>[key,compareCombo(pair)]))};
  };
  const remap=<T>(pairs:Record<string,Pair>,to:(pair:Pair)=>T)=>Object.fromEntries(Object.entries(pairs).map(([key,pair])=>[key,to(pair)]));
  const scoredVerdict=bar('scored','least_inflight',[['heterogeneous','W2'],['heterogeneous','W3'],['homogeneous','W1']],
    pairs=>acceptance(remap(pairs,pair=>({scored:pair.candidate,least_inflight:pair.incumbent})) as Parameters<typeof acceptance>[0]));
  const affinityVerdict=bar('least_inflight+affinity','least_inflight',[['homogeneous','W3'],['heterogeneous','W3'],['homogeneous','W1'],['heterogeneous','W1']],
    pairs=>affinityAcceptance(remap(pairs,pair=>({on:pair.candidate,off:pair.incumbent})) as Parameters<typeof affinityAcceptance>[0]));
  const verdict={...(scoredVerdict?{scored:scoredVerdict}:{}),...(affinityVerdict?{affinity:affinityVerdict}:{})};
  const directory=join(process.cwd(),'reports');await mkdir(directory,{recursive:true});
  const file=join(directory,`routing-compare-${run}.json`);
  // ±∞ gains are written as strings (JSON has no Infinity).
  const infinity=(_key:string,value:unknown)=>value===Infinity?'Infinity':value===-Infinity?'-Infinity':value;
  await writeFile(file,JSON.stringify({run,...(merged?{mergedFrom:merged.map(m=>m.run)}:{}),method:reportMethod({grid,seeds,kneeSeeds,o}),
    configs:CONFIGS,knees,calibration,points,summary,verdict},infinity,2));
  process.stdout.write(`${JSON.stringify({file,knees,verdict},infinity,2)}\n`);
}
if(require.main===module) void main().catch(error=>{process.stderr.write(`ROUTING_COMPARE_FAILED ${(error as Error).message}\n`);process.exitCode=1;});
