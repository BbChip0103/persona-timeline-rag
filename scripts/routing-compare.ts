/**
 * Routing comparison (stage S3): round_robin vs least_inflight vs scored (affinity off) behind the real
 * gateway + UpstreamPool (credit admission, central queue), in front of FakeEngineUpstream engines. Zero cost.
 *
 *   pnpm exec tsx scripts/routing-compare.ts [--configs=homogeneous,heterogeneous] [--workloads=W1,W2,W3,W4]
 *       [--policies=round_robin,least_inflight,scored] [--rates=0.5,0.75,1,1.25] [--seconds=20]
 *
 * Configs: homogeneous = 2 × (1.0×: prefill 8000 tok/s, TPOT 8 ms, KV 43k); heterogeneous = 1.0× + 0.5× (prefill 4000,
 * TPOT 16 ms, KV ¼ = 10.75k, registered weight 0.5). Every engine: 12 slots, gateway maxSeqs 12, kvCapacityTokens = its KV.
 * Workloads (requests built like the app's: 5029 B policy, 858 B persona, state, history, user):
 *   W1 measured lengths (lognormal, p50 1886 / p95 7155 tokens); W2 80% short / 20% long; W3 50 personas Zipf(1.2),
 *   sessions of 5–10 turns whose history grows; W4 a 20 s burst at 2× the nominal rate.
 * Open-loop Poisson arrivals at rate × nominal capacity (homogeneous 12/s, heterogeneous 8/s), the same seeded
 * sequence for every policy. Per point: 3 s warm-up, `--seconds` measured; requests started in the window count.
 * Metrics: TTFT / e2e p50 / p95, throughput, max throughput with TTFT p95 ≤ 2 s across the rates, rejections, the
 * engines' prefix hit rate, and Jain's index over per-flow mean TTFT.
 * Acceptance (fixed before any run): scored vs least_inflight — heterogeneous W2 and W3: one of (max throughput under
 * TTFT p95 ≤ 2 s, TTFT p95 at rate 1.0) ≥ 10% better with the other ≤ 5% worse; homogeneous W1: both ≤ 5% worse.
 * Writes reports/routing-compare-<run>.json.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { UpstreamRecord } from '@ptr/messaging/registry';
import { createGateway } from '../apps/gateway/src/server';
import { UpstreamPool } from '../apps/gateway/src/pool';
import { StaticUpstreamSource } from '../apps/gateway/src/sources';
import type { RoutingPolicy } from '../apps/gateway/src/admission';
import { FakeEngine, type FakeEngineConfig } from './fake-engine';

const args=Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...rest]=arg.replace(/^--/,'').split('=');return [key!,rest.join('=')];}));
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** `maxSeqs`: what the operator registers for the gateway (default 12, the engine's slots stay 12). */
type EngineSpec=FakeEngineConfig&{weight:number;maxSeqs?:number};
const FULL={slots:12,prefillTokensPerSec:8000,tpotMs:8,kvCapacityTokens:43000};
const HALF={slots:12,prefillTokensPerSec:4000,tpotMs:16,kvCapacityTokens:10750};
const CONFIGS:Record<string,{engines:EngineSpec[];nominal:number}>={
  homogeneous:{engines:[{name:'a',...FULL,weight:1},{name:'b',...FULL,weight:1}],nominal:12},
  heterogeneous:{engines:[{name:'a',...FULL,weight:1},{name:'b',...HALF,weight:0.5}],nominal:8},
  /** Supplementary (not in the acceptance verdict): the half-speed server registered with maxSeqs 6 (S_u matched to its speed). */
  heterogeneous_s6:{engines:[{name:'a',...FULL,weight:1},{name:'b',...HALF,weight:0.5,maxSeqs:6}],nominal:8},
};

/** Seeded PRNG (mulberry32) so every policy sees the same arrivals. */
function rng(seed:number):()=>number {
  let a=seed>>>0;
  return ()=>{a=(a+0x6D2B79F5)>>>0;let t=a;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return ((t^(t>>>14))>>>0)/4294967296;};
}
const normal=(random:()=>number)=>Math.sqrt(-2*Math.log(Math.max(1e-12,random())))*Math.cos(2*Math.PI*random());
const BYTES_PER_TOKEN=4.45;
const POLICY='정책 '.repeat(1).padEnd(5029,'P');
const PERSONAS=Array.from({length:50},(_,i)=>`persona-${i} `.padEnd(858,String.fromCharCode(97+(i%26))));
interface Message {role:string;content:string}
/** App-shaped request of about `tokens` engine tokens; `history` is reused verbatim across a session's turns. */
function buildMessages(persona:number,history:Message[],tokens:number,random:()=>number):Message[] {
  const fixed=5029+858+120+history.reduce((sum,m)=>sum+Buffer.byteLength(m.content),0);
  const userBytes=Math.max(40,Math.round(tokens*BYTES_PER_TOKEN-fixed));
  return [{role:'system',content:POLICY},{role:'system',content:PERSONAS[persona]!},{role:'system',content:`AGENT_STATE_JSON_DATA {"topic":"t${Math.floor(random()*9)}"}`.padEnd(120,' ')},
    ...history,{role:'user',content:'질문 '.padEnd(userBytes,'q')}];
}
const outputTokens=(random:()=>number)=>Math.max(20,Math.min(400,Math.round(150*Math.exp(0.5*normal(random)))));

interface Sample {start:number;ttft:number|null;e2e:number|null;status:number;flow:string}
interface Arrival {at:number;flow:string;messages:Message[];output:number;session?:{persona:number;turns:number;history:Message[]}}
/** Arrival plan for one point (W3 sessions emit follow-up turns themselves, after each answer). */
function plan(workload:string,rate:number,durationMs:number,seed:number):Arrival[] {
  const random=rng(seed), arrivals:Arrival[]=[];
  if(workload==='W3') {
    // Sessions start at rate/7.5 per second (7.5 turns each on average); Zipf(1.2) over 50 personas.
    const weights=PERSONAS.map((_,i)=>1/Math.pow(i+1,1.2)), total=weights.reduce((a,b)=>a+b,0);
    const zipf=()=>{let x=random()*total;for(let i=0;i<weights.length;i++){x-=weights[i]!;if(x<=0) return i;}return weights.length-1;};
    for(let t=0;t<durationMs;) {
      t+=-Math.log(Math.max(1e-12,random()))/(rate/7.5)*1000;if(t>=durationMs) break;
      const persona=zipf(), turns=5+Math.floor(random()*6);
      arrivals.push({at:t,flow:randomBytes(4).toString('hex'),messages:[],output:outputTokens(random),session:{persona,turns,history:[]}});
    }
    return arrivals;
  }
  const until=workload==='W4'?20000:durationMs, lambda=workload==='W4'?rate*2:rate;
  for(let t=0;t<until;) {
    t+=-Math.log(Math.max(1e-12,random()))/lambda*1000;if(t>=until) break;
    const tokens=workload==='W2'?(random()<0.8?1400+random()*400:6000+random()*2000)
      :Math.max(1400,Math.min(14000,1886*Math.exp(0.81*normal(random))));
    arrivals.push({at:t,flow:(Math.floor(random()*32)).toString(16),messages:buildMessages(Math.floor(random()*4),[],tokens,random),output:outputTokens(random)});
  }
  return arrivals;
}

async function call(base:string,token:string,messages:Message[],output:number,flow:string,t0:number):Promise<Sample&{text:string}> {
  const start=Date.now();let ttft:number|null=null,text='';
  try {
    const response=await fetch(`${base}/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-PTR-Flow':flow},
      body:JSON.stringify({messages,stream:true,max_tokens:512,ptr_fake_output_tokens:output}),signal:AbortSignal.timeout(60000)});
    if(response.status!==200) {await response.body?.cancel();return {start:start-t0,ttft:null,e2e:null,status:response.status,flow,text};}
    const reader=response.body!.getReader();const decoder=new TextDecoder();
    for(;;) {const {done,value}=await reader.read();if(done) break;if(ttft===null) ttft=Date.now()-start;text+=decoder.decode(value,{stream:true});}
    return {start:start-t0,ttft,e2e:Date.now()-start,status:text.includes('[DONE]')?200:599,flow,text};
  } catch {return {start:start-t0,ttft:null,e2e:null,status:599,flow,text};}
}
const pct=(values:number[],p:number)=>{if(!values.length) return null;const s=[...values].sort((a,b)=>a-b);return s[Math.min(s.length-1,Math.ceil(p*s.length)-1)]!;};
function jain(values:number[]):number|null {
  if(!values.length) return null;const sum=values.reduce((a,b)=>a+b,0),squares=values.reduce((a,b)=>a+b*b,0);
  return squares?Math.round(sum*sum/(values.length*squares)*1000)/1000:null;
}

async function point(configName:string,workload:string,policy:RoutingPolicy,rateFactor:number,measureMs:number) {
  const config=CONFIGS[configName]!, token=randomBytes(24).toString('hex');
  const engines=config.engines.map(spec=>new FakeEngine(spec));
  for(const engine of engines) await engine.start();
  const records:UpstreamRecord[]=config.engines.map((spec,i)=>({pool:'fake',id:spec.name,baseUrl:engines[i]!.baseUrl,maxSeqs:spec.maxSeqs??12,kvCapacityTokens:spec.kvCapacityTokens,
    weight:spec.weight,state:'active',epoch:'e',seq:0}));
  const pool=new UpstreamPool({model:'fake',source:new StaticUpstreamSource(records),admission:true,routing:policy,maxQueue:256,queueTimeoutMs:10000,slowStartMs:0});
  const {server}=createGateway({token,upstream:pool,limits:{maxConcurrent:4096,maxQueue:4096,queueTimeoutMs:10000,upstreamTimeoutMs:60000}});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',()=>resolve()));
  const base=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1`;
  const warmupMs=3000, rate=config.nominal*rateFactor;
  const arrivals=plan(workload,rate,warmupMs+measureMs,Math.round(rateFactor*1000)+workload.charCodeAt(1)*7919);
  const samples:Sample[]=[];const t0=Date.now();const inflight:Promise<void>[]=[];
  for(const arrival of arrivals) {
    const wait=t0+arrival.at-Date.now();if(wait>0) await sleep(wait);
    if(arrival.session) {
      const s=arrival.session, random=rng(arrival.at|0);
      inflight.push((async()=>{
        for(let turn=0;turn<s.turns&&Date.now()-t0<warmupMs+measureMs;turn++) {
          const messages=buildMessages(s.persona,s.history,1500+Math.random()*300,random);
          const sample=await call(base,token,messages,outputTokens(random),arrival.flow,t0);samples.push(sample);
          s.history.push({role:'user',content:messages.at(-1)!.content},{role:'assistant',content:'답변 '.padEnd(600,'a')});
          await sleep(300);
        }
      })());
    } else inflight.push(call(base,token,arrival.messages,arrival.output,arrival.flow,t0).then(sample=>{samples.push(sample);}));
  }
  await Promise.race([Promise.all(inflight),sleep(20000)]);
  const metrics=pool.poolMetrics();
  server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.close();
  const prefix=engines.reduce((acc,e)=>({q:acc.q+e.stats.prefixQueries,h:acc.h+e.stats.prefixHits}),{q:0,h:0});
  for(const engine of engines) await engine.stop();
  const windowEnd=workload==='W4'?20000:warmupMs+measureMs, windowStart=workload==='W4'?0:warmupMs;
  const measured=samples.filter(s=>s.start>=windowStart&&s.start<windowEnd);
  const ok=measured.filter(s=>s.status===200);
  const ttfts=ok.map(s=>s.ttft!), e2es=ok.map(s=>s.e2e!);
  const byFlow=new Map<string,number[]>();for(const s of ok) byFlow.set(s.flow,[...(byFlow.get(s.flow)??[]),s.ttft!]);
  const flowMeans=[...byFlow.values()].map(v=>v.reduce((a,b)=>a+b,0)/v.length);
  return {config:configName,workload,policy,rateFactor,rate:Math.round(rate*100)/100,requests:measured.length,completed:ok.length,
    throughput:Math.round(ok.length/((windowEnd-windowStart)/1000)*100)/100,
    ttft:{p50:pct(ttfts,0.5),p95:pct(ttfts,0.95)},e2e:{p50:pct(e2es,0.5),p95:pct(e2es,0.95)},
    rejected:{queue_full:measured.filter(s=>s.status===429).length,queue_timeout:measured.filter(s=>s.status===503).length,errors:measured.filter(s=>s.status===599||(s.status!==200&&s.status!==429&&s.status!==503)).length},
    prefixHitRate:prefix.q?Math.round(prefix.h/prefix.q*1000)/1000:null,jain:jain(flowMeans),
    dispatched:Object.fromEntries(metrics.upstreams.map(u=>[u.id,u.dispatched]))};
}

async function main():Promise<void> {
  const run=`${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
  const configs=(args.configs??'homogeneous,heterogeneous').split(','), workloads=(args.workloads??'W1,W2,W3,W4').split(',');
  const policies=(args.policies??'round_robin,least_inflight,scored').split(',') as RoutingPolicy[];
  const rates=(args.rates??'0.5,0.75,1,1.25').split(',').map(Number), measureMs=Number(args.seconds??20)*1000;
  const points:Awaited<ReturnType<typeof point>>[]=[];
  for(const config of configs) for(const workload of workloads) for(const policy of policies) for(const rate of workload==='W4'?[1]:rates) {
    const result=await point(config,workload,policy,rate,measureMs);points.push(result);
    process.stderr.write(`${config} ${workload} ${policy} ×${rate}: thr=${result.throughput}/s ttft p95=${result.ttft.p95} rej=${JSON.stringify(result.rejected)}\n`);
  }
  // Per (config, workload, policy) summary.
  const summary=[] as Record<string,unknown>[];
  for(const config of configs) for(const workload of workloads) for(const policy of policies) {
    const ps=points.filter(p=>p.config===config&&p.workload===workload&&p.policy===policy);
    const under=ps.filter(p=>p.ttft.p95!==null&&p.ttft.p95<=2000);
    const at1=ps.find(p=>p.rateFactor===1)??ps[0];
    summary.push({config,workload,policy,maxThroughputTtftP95Le2s:under.length?Math.max(...under.map(p=>p.throughput)):null,
      atRate1:at1&&{throughput:at1.throughput,ttft:at1.ttft,e2e:at1.e2e,rejected:at1.rejected,jain:at1.jain,prefixHitRate:at1.prefixHitRate}});
  }
  const get=(config:string,workload:string,policy:string)=>summary.find(s=>s.config===config&&s.workload===workload&&s.policy===policy) as
    {maxThroughputTtftP95Le2s:number|null;atRate1:{ttft:{p95:number|null}}}|undefined;
  const compare=(config:string,workload:string)=>{
    const s=get(config,workload,'scored'), l=get(config,workload,'least_inflight');if(!s||!l) return null;
    const thr=s.maxThroughputTtftP95Le2s!==null&&l.maxThroughputTtftP95Le2s?(s.maxThroughputTtftP95Le2s-l.maxThroughputTtftP95Le2s)/l.maxThroughputTtftP95Le2s:null;
    const ttft=s.atRate1.ttft.p95!==null&&l.atRate1.ttft.p95?(l.atRate1.ttft.p95-s.atRate1.ttft.p95)/l.atRate1.ttft.p95:null; // positive = scored better
    return {throughputGain:thr===null?null:Math.round(thr*1000)/1000,ttftP95Gain:ttft===null?null:Math.round(ttft*1000)/1000};
  };
  const better=(c:{throughputGain:number|null;ttftP95Gain:number|null}|null)=>!!c&&((c.throughputGain??-1)>=0.10&&(c.ttftP95Gain??0)>=-0.05||(c.ttftP95Gain??-1)>=0.10&&(c.throughputGain??0)>=-0.05);
  const notWorse=(c:{throughputGain:number|null;ttftP95Gain:number|null}|null)=>!!c&&(c.throughputGain??0)>=-0.05&&(c.ttftP95Gain??0)>=-0.05;
  const acceptance={heterogeneousW2:compare('heterogeneous','W2'),heterogeneousW3:compare('heterogeneous','W3'),homogeneousW1:compare('homogeneous','W1')};
  const verdict={heterogeneousW2:better(acceptance.heterogeneousW2),heterogeneousW3:better(acceptance.heterogeneousW3),homogeneousW1:notWorse(acceptance.homogeneousW1)};
  const directory=join(process.cwd(),'reports');await mkdir(directory,{recursive:true});
  const file=join(directory,`routing-compare-${run}.json`);
  await writeFile(file,JSON.stringify({run,configs:CONFIGS,points,summary,acceptance,verdict},null,2));
  process.stdout.write(`${JSON.stringify({file,summary,acceptance,verdict},null,2)}\n`);
}
if(require.main===module) void main().catch(error=>{process.stderr.write(`ROUTING_COMPARE_FAILED ${(error as Error).message}\n`);process.exitCode=1;});
