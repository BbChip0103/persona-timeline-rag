/**
 * `pnpm ops:status [--window 30]` : reads `/metrics/prom` of the four roles twice, `--window` seconds
 * apart, and prints one health table. No Prometheus server and no alert rules: this is the whole alerting.
 *
 * - ALERT: secondary share of gateway answers > 20%, any queue timeout (dispatcher QUEUE_TIMEOUT or gateway
 *   queue_timeout), TURN_TIMEOUT share of finished turns > 5%, any input-safety fallback.
 * - INFO: an open breaker is `engine unreachable` (the GPU pod is often off), never an ALERT.
 * - A role that does not answer is `down`; checks that need it are n/a, as are checks of a role that missed the first
 *   read (no baseline). Breakers are read from the second read alone.
 *
 * Exit 0 without ALERT, 1 with one, 2 on bad arguments. Output is counts and fixed names only.
 */
import { parseExposition, type ParsedExposition } from '@ptr/ops';

export const ROLE_TARGETS=[{role:'api',url:'http://127.0.0.1:56441/metrics/prom'},{role:'worker',url:'http://127.0.0.1:56442/metrics/prom'},
  {role:'dispatcher',url:'http://127.0.0.1:56443/metrics/prom'},{role:'gateway',url:'http://127.0.0.1:56460/metrics/prom'}] as const;
type Role=(typeof ROLE_TARGETS)[number]['role'];
type Scrape=Partial<Record<Role,ParsedExposition>>;
export interface Deps {fetch:(url:string,init:{signal:AbortSignal})=>Promise<Response>;sleep:(ms:number)=>Promise<void>;write:(line:string)=>void}

const SECONDARY_MAX=0.2, TURN_TIMEOUT_MAX=0.05;
async function scrape(deps:Deps):Promise<Scrape> {
  const entries=await Promise.all(ROLE_TARGETS.map(async({role,url})=>{
    try {
      const response=await deps.fetch(url,{signal:AbortSignal.timeout(2000)});
      return response.ok?[[role,parseExposition(await response.text())]]:[];
    } catch {return [];}
  }));
  return Object.fromEntries(entries.flat()) as Scrape;
}
/** Increase of a counter over the window, summed over the series that match `labels`; a series that went back (process restart) counts from zero. */
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
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i]!;const [flag,inline]=arg.split('=',2) as [string,string|undefined];
    if(flag!=='--window') {deps.write(`ops-status: unknown argument`);return 2;}
    const raw=inline??argv[++i];
    if(!raw||!/^\d+$/.test(raw)||Number(raw)<1||Number(raw)>600) {deps.write('ops-status: --window must be 1-600 seconds');return 2;}
    window=Number(raw);
  }
  const before=await scrape(deps);await deps.sleep(window*1000);const after=await scrape(deps);
  deps.write(`ops:status window ${window}s`);
  for(const {role} of ROLE_TARGETS) deps.write(row(role,after[role]?'up':'down',''));
  let alerts=0;
  const check=(name:string,value:string,alert:string|false)=>{if(alert) alerts++;deps.write(row(name,value,alert?`ALERT ${alert}`:'ok'));};
  // A role needs both reads: without the first, its lifetime totals would look like the window's increase.
  const both=(role:Role)=>before[role]&&after[role];
  const gateway=both('gateway')?after.gateway:undefined, worker=both('worker')?after.worker:undefined, dispatcher=both('dispatcher')?after.dispatcher:undefined;
  const missing=(role:Role)=>after[role]?'no baseline':`${role} down`;
  for(const sample of (after.gateway?.samples??[]).filter(sample=>sample.name==='ptr_gateway_breaker_open'))
    deps.write(row(`breaker ${sample.labels.upstream??'-'}`,sample.value?'open':'closed',sample.value?'INFO engine unreachable':'ok'));
  if(gateway) {
    const secondary=delta(before.gateway,gateway,'ptr_gateway_served_total',{upstream:'secondary'}), served=delta(before.gateway,gateway,'ptr_gateway_served_total');
    if(served) check('secondary ratio',percent(secondary,served),secondary/served>SECONDARY_MAX&&'> 20%');
    else deps.write(row('secondary ratio','n/a (no answers)','ok'));
  } else deps.write(row('secondary ratio',`n/a (${missing('gateway')})`,''));
  if(dispatcher||gateway) {
    const queued=dispatcher?delta(before.dispatcher,dispatcher,'ptr_dispatch_failed_total',{code:'QUEUE_TIMEOUT'}):0;
    const refused=gateway?delta(before.gateway,gateway,'ptr_gateway_rejected_total',{reason:'queue_timeout'}):0;
    check('queue timeouts',`${queued+refused} (QUEUE_TIMEOUT ${dispatcher?queued:'n/a'}, gateway ${gateway?refused:'n/a'})`,queued+refused>0&&'> 0');
  } else deps.write(row('queue timeouts',`n/a (${after.dispatcher||after.gateway?'no baseline':'dispatcher and gateway down'})`,''));
  if(worker) {
    const fallbacks=delta(before.worker,worker,'ptr_safety_fallback_total');
    check('safety fallback',String(fallbacks),fallbacks>0&&'> 0');
    const timeouts=delta(before.worker,worker,'ptr_turns_finished_total',{code:'TURN_TIMEOUT'}), finished=delta(before.worker,worker,'ptr_turns_finished_total');
    if(finished) check('TURN_TIMEOUT rate',percent(timeouts,finished),timeouts/finished>TURN_TIMEOUT_MAX&&'> 5%');
    else deps.write(row('TURN_TIMEOUT rate','n/a (no finished turns)','ok'));
  } else {deps.write(row('safety fallback',`n/a (${missing('worker')})`,''));deps.write(row('TURN_TIMEOUT rate',`n/a (${missing('worker')})`,''));}
  deps.write(`summary: ${alerts} ALERT`);
  return alerts?1:0;
}

if(require.main===module) void run(process.argv.slice(2),{fetch:(url,init)=>fetch(url,{...init,redirect:'error'}),
  sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),write:line=>process.stdout.write(`${line}\n`)}).then(code=>{process.exitCode=code;});
