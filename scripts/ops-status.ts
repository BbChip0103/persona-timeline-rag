/** Read-only framework status. API/worker counters come from standard collectors.
 * Optional LiteLLM/Langfuse readiness probes never call models or transfer credentials.
 */
import { parseExposition, type ParsedExposition } from '@ptr/ops';
import {bounded as nativeBounded} from '../packages/ops/src/bounded';

export const ROLE_TARGETS=[{role:'api',url:'http://127.0.0.1:56441/metrics/prom'},
  {role:'worker',url:'http://127.0.0.1:56442/metrics/prom'}] as const;
type Role=(typeof ROLE_TARGETS)[number]['role'];
type Scrape=Partial<Record<Role,ParsedExposition>>;
export interface Deps {
  fetch:(url:string,init:{signal:AbortSignal;redirect:'error'})=>Promise<Response>;
  sleep:(ms:number)=>Promise<void>;write:(line:string)=>void;env?:NodeJS.ProcessEnv;
}

/** No URL credentials, query secrets or fragments. Explicit endpoints are never printed. */
function base(raw:string):URL {
  const parsed=new URL(raw);
  if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password||parsed.search||parsed.hash)throw new Error('invalid_status_target');
  return parsed;
}
function targets(env:NodeJS.ProcessEnv) {
  const metrics=ROLE_TARGETS.map(target=>({role:target.role,url:base(env[target.role==='api'?'PTR_OPS_API_METRICS_URL':'PTR_OPS_WORKER_METRICS_URL']??target.url).href}));
  const readiness:{role:'litellm'|'langfuse';url:string}[]=[];
  if(env.PTR_LITELLM_BASE_URL) {
    const url=base(env.PTR_LITELLM_BASE_URL);url.pathname=`${url.pathname.replace(/\/v1\/?$/u,'').replace(/\/$/u,'')}/health/readiness`;
    readiness.push({role:'litellm',url:url.href});
  }
  if(env.LANGFUSE_BASE_URL) {
    const url=base(env.LANGFUSE_BASE_URL);
    if(url.hostname==='langfuse.com'||url.hostname.endsWith('.langfuse.com'))throw new Error('selfhost_status_target_required');
    url.pathname=`${url.pathname.replace(/\/$/u,'')}/api/public/ready`;readiness.push({role:'langfuse',url:url.href});
  }
  return {metrics,readiness};
}

async function bounded<T>(work:(signal:AbortSignal)=>Promise<T>):Promise<T> {
  return nativeBounded(work,2000);
}
async function scrape(deps:Deps,metrics:ReturnType<typeof targets>['metrics']):Promise<Scrape> {
  const entries=await Promise.all(metrics.map(async({role,url})=>{
    try {
      const parsed=await bounded(async signal=>{
        const response=await deps.fetch(url,{signal,redirect:'error'});
        if(!response.ok) {await response.body?.cancel();return undefined;}
        const body=await response.text();if(body.length>2_000_000)throw new Error('status_body_too_large');
        return parseExposition(body);
      });
      return parsed?[[role,parsed] as const]:[];
    } catch {return [];}
  }));
  return Object.fromEntries(entries.flat()) as Scrape;
}
function delta(before:ParsedExposition|undefined,after:ParsedExposition,name:string,labels:Record<string,string>={}):number {
  const matches=(sample:ParsedExposition['samples'][number])=>sample.name===name&&Object.entries(labels).every(([label,value])=>sample.labels[label]===value);
  const previous=new Map((before?.samples??[]).filter(matches).map(sample=>[JSON.stringify(sample.labels),sample.value]));
  return after.samples.filter(matches).reduce((total,sample)=>{
    const then=previous.get(JSON.stringify(sample.labels))??0;
    return total+(sample.value>=then?sample.value-then:sample.value);
  },0);
}
const percent=(part:number,whole:number)=>`${(part/whole*100).toFixed(1)}% (${part}/${whole})`;
const row=(name:string,value:string,state:string)=>`${name.padEnd(23)} ${value.padEnd(34)} ${state}`.trimEnd();

export async function run(argv:string[],deps:Deps):Promise<number> {
  let window=30;
  for(let index=0;index<argv.length;index++) {
    const [flag,inline]=argv[index]!.split('=',2);
    if(flag!=='--window') {deps.write('usage unknown_argument');return 2;}
    const raw=inline??argv[++index];
    if(!raw||!/^\d+$/u.test(raw)||Number(raw)<1||Number(raw)>600) {deps.write('usage invalid_window');return 2;}
    window=Number(raw);
  }
  let configured:ReturnType<typeof targets>;
  try {configured=targets(deps.env??{});}catch {deps.write('usage invalid_status_target');return 2;}
  const before=await scrape(deps,configured.metrics);await deps.sleep(window*1000);const after=await scrape(deps,configured.metrics);
  deps.write(`ops:status window ${window}s`);
  for(const {role} of configured.metrics)deps.write(row(role,after[role]?'up':'down',''));
  let alerts=0;
  const check=(name:string,value:string,alert:string|false)=>{if(alert)alerts++;deps.write(row(name,value,alert?`ALERT ${alert}`:'ok'));};
  for(const {role,url} of configured.readiness) {
    let ready=false;
    try {ready=await bounded(async signal=>{const response=await deps.fetch(url,{signal,redirect:'error'});await response.body?.cancel();return response.ok;});}catch {ready=false;}
    check(`${role} readiness`,ready?'ready':'unavailable',!ready&&'unavailable');
  }
  const worker=before.worker&&after.worker?after.worker:undefined;
  if(worker) {
    const queueTimeouts=delta(before.worker,worker,'ptr_turns_finished_total',{code:'QUEUE_TIMEOUT'});
    check('queue timeouts',String(queueTimeouts),queueTimeouts>0&&'> 0');
    const fallbacks=delta(before.worker,worker,'ptr_safety_fallback_total');check('safety fallback',String(fallbacks),fallbacks>0&&'> 0');
    const timeouts=delta(before.worker,worker,'ptr_turns_finished_total',{code:'TURN_TIMEOUT'});
    const finished=delta(before.worker,worker,'ptr_turns_finished_total');
    if(finished)check('TURN_TIMEOUT rate',percent(timeouts,finished),timeouts/finished>0.05&&'> 5%');
    else deps.write(row('TURN_TIMEOUT rate','n/a (no finished turns)','ok'));
  } else {
    const missing=after.worker?'no baseline':'worker down';
    for(const name of ['queue timeouts','safety fallback','TURN_TIMEOUT rate'])deps.write(row(name,`n/a (${missing})`,''));
  }
  deps.write(`summary: ${alerts} ALERT`);return alerts?1:0;
}
if(require.main===module)void run(process.argv.slice(2),{fetch:(url,init)=>fetch(url,init),env:process.env,
  sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),write:line=>process.stdout.write(`${line}\n`)}).then(code=>{process.exitCode=code;});
