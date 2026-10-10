import { Counter, Registry } from '@ptr/ops';
import { ROLE_TARGETS, run } from '../ops-status';

type Counts={finished?:Record<string,number>;safety?:number};
/** Fixtures are produced by genuine standard collectors, not a hand-written exposition renderer. */
async function bodies(counts:Counts):Promise<Record<string,string>> {
  const api=new Registry(Registry.PROMETHEUS_CONTENT_TYPE);
  new Counter({name:'ptr_turns_created_total',help:'Synthetic created turns',registers:[api]}).inc(1);
  const worker=new Registry(Registry.PROMETHEUS_CONTENT_TYPE);
  const finished=new Counter({name:'ptr_turns_finished_total',help:'Synthetic finished turns',labelNames:['outcome','code'],registers:[worker]});
  for(const [key,value] of Object.entries(counts.finished??{})) {
    const [outcome,code]=key.split(':');finished.inc({outcome:outcome!,code:code!},value);
  }
  const safety=new Counter({name:'ptr_safety_fallback_total',help:'Synthetic safety fallbacks',labelNames:['scope','reason'],registers:[worker]});
  if(counts.safety!==undefined)safety.inc({scope:'turn',reason:'timeout'},counts.safety);
  return {api:await api.metrics(),worker:await worker.metrics()};
}
const healthy:Counts={finished:{'completed:none':10},safety:0};
async function status(before:Counts,after:Counts,options:{down?:string[];argv?:string[];env?:NodeJS.ProcessEnv;readyStatus?:number}={}) {
  const lines:string[]=[],requests:{url:string;init:unknown}[]=[],slept:number[]=[];let phase=0;
  const snapshots=[await bodies(before),await bodies(after)];
  const urls=new Map<string,string>(ROLE_TARGETS.map(target=>[target.url,target.role]));
  const code=await run(options.argv??[],{env:options.env,
    fetch:async(url,init)=>{
      requests.push({url,init});const role=urls.get(url);
      if(!role)return new Response('PRIVATE_READINESS_BODY_SENTINEL',{status:options.readyStatus??200});
      if(options.down?.includes(role))throw new TypeError('PRIVATE_FETCH_ERROR_SENTINEL');
      return new Response(snapshots[phase]![role],{status:200});
    },sleep:async ms=>{slept.push(ms);phase=1;},write:line=>lines.push(line)});
  return {code,text:lines.join('\n'),lines,slept,requests};
}
test('only API/worker metric targets; no old gateway or standalone dispatcher',()=>{
  expect(ROLE_TARGETS.map(target=>`${target.role} ${target.url}`)).toEqual([
    'api http://127.0.0.1:56441/metrics/prom','worker http://127.0.0.1:56442/metrics/prom']);
});
test('quiet standard counters: both roles up, default window30seconds and no legacy routing assumptions',async()=>{
  const {code,text,slept,requests}=await status(healthy,{finished:{'completed:none':30},safety:0});
  expect(code).toBe(0);expect(slept).toEqual([30000]);expect(requests).toHaveLength(4);
  expect(text).toMatch(/api\s+up/);expect(text).toMatch(/worker\s+up/);
  expect(text).not.toMatch(/secondary ratio|breaker|dispatcher|gateway/u);expect(text).toContain('summary: 0 ALERT');
});
test('queue timeout, safety fallback and TURN_TIMEOUT rate retain alerts using worker counters',async()=>{
  const after:Counts={finished:{'completed:none':16,'failed:TURN_TIMEOUT':3,'failed:QUEUE_TIMEOUT':1},safety:2};
  const {code,text,lines}=await status(healthy,after);
  expect(code).toBe(1);expect(text).toMatch(/queue timeouts\s+1\s+ALERT > 0/u);
  expect(text).toMatch(/safety fallback\s+2\s+ALERT > 0/u);expect(text).toMatch(/TURN_TIMEOUT rate\s+30\.0% \(3\/10\)\s+ALERT > 5%/u);
  expect(lines.at(-1)).toBe('summary: 3 ALERT');
  expect((await status(healthy,{finished:{'completed:none':29,'failed:TURN_TIMEOUT':1},safety:0})).code).toBe(0);
});
test('role down means missing-baseline rate checks are n/a, not lifetime-total alerts',async()=>{
  const {code,text}=await status(healthy,healthy,{down:['worker']});
  expect(code).toBe(0);expect(text).toMatch(/worker\s+down/u);expect(text).toMatch(/TURN_TIMEOUT rate\s+n\/a \(worker down\)/u);
  expect(text).not.toContain('PRIVATE_FETCH_ERROR_SENTINEL');
});
test('missing first scrape cannot promote lifetime totals to window increments',async()=>{
  const snapshots=await bodies({finished:{'failed:TURN_TIMEOUT':40,'failed:QUEUE_TIMEOUT':3},safety:9});
  const lines:string[]=[];let phase=0;
  const urls=new Map<string,string>(ROLE_TARGETS.map(target=>[target.url,target.role]));
  const code=await run([],{fetch:async url=>{if(phase===0)throw new TypeError('synthetic down');return new Response(snapshots[urls.get(url)!]);},
    sleep:async()=>{phase=1;},write:line=>lines.push(line)});
  expect(code).toBe(0);for(const name of ['queue timeouts','safety fallback','TURN_TIMEOUT rate'])expect(lines.find(line=>line.startsWith(name))).toContain('n/a (no baseline)');
});
test('counter reset counts from zero and explicit window changes only the observation interval',async()=>{
  const {code,text,slept}=await status({finished:{'completed:none':500},safety:0},{finished:{'completed:none':10},safety:0},{argv:['--window','5']});
  expect(code).toBe(0);expect(slept).toEqual([5000]);expect(text).toMatch(/TURN_TIMEOUT rate\s+0\.0% \(0\/10\)/u);
});
test('usage validation makes no requests and prints no raw arguments',async()=>{
  for(const argv of [['--window','0'],['--window','x'],['--window=601'],['--PRIVATE_SENTINEL']]) {
    const result=await status(healthy,healthy,{argv});expect(result.code).toBe(2);expect(result.requests).toEqual([]);expect(result.text).not.toContain('PRIVATE_SENTINEL');
  }
});
test('explicit LiteLLM and Langfuse check only free readiness, without transferring credentials or outputting payloads',async()=>{
  const env={PTR_LITELLM_BASE_URL:'http://127.0.0.1:59000/v1',LANGFUSE_BASE_URL:'http://127.0.0.1:59001',
    PTR_LITELLM_API_KEY:'PRIVATE_KEY_SENTINEL',LANGFUSE_SECRET_KEY:'PRIVATE_SECRET_SENTINEL'};
  const {code,text,requests}=await status(healthy,healthy,{env});
  expect(code).toBe(0);expect(requests.slice(-2).map(request=>request.url)).toEqual([
    'http://127.0.0.1:59000/health/readiness','http://127.0.0.1:59001/api/public/ready']);
  expect(text).toMatch(/litellm readiness\s+ready/u);expect(text).toMatch(/langfuse readiness\s+ready/u);
  expect(text).not.toMatch(/PRIVATE_|59000|59001/u);
  for(const request of requests)expect(Object.keys(request.init as object).sort()).toEqual(['redirect','signal']);
});
test('explicit unavailable dependency readiness is visible as an alert, without leaking response body',async()=>{
  const {code,text}=await status(healthy,healthy,{env:{PTR_LITELLM_BASE_URL:'http://127.0.0.1:59000/v1'},readyStatus:503});
  expect(code).toBe(1);expect(text).toMatch(/litellm readiness\s+unavailable\s+ALERT unavailable/u);expect(text).not.toContain('PRIVATE_READINESS_BODY_SENTINEL');
});
test('explicit unsafe targets fail before any request; no credential-bearing URL prints',async()=>{
  for(const env of [{PTR_LITELLM_BASE_URL:'https://u:PRIVATE_SENTINEL@host.invalid/v1'},
    {LANGFUSE_BASE_URL:'https://cloud.langfuse.com'},{PTR_OPS_API_METRICS_URL:'file:///PRIVATE_SENTINEL'}]) {
    const result=await status(healthy,healthy,{env});expect(result.code).toBe(2);expect(result.requests).toEqual([]);expect(result.text).toBe('usage invalid_status_target');
  }
});
test('metrics probes remain bounded when a transport ignores cancellation',async()=>{
  jest.useFakeTimers();const lines:string[]=[];
  const requests:{signal:AbortSignal}[]=[];
  try {
    const promise=run([],{fetch:async(_url,init)=>{requests.push(init);return new Promise<Response>(()=>undefined);},
      sleep:async()=>undefined,write:line=>lines.push(line)});
    await jest.advanceTimersByTimeAsync(4001);
    expect(await promise).toBe(0);expect(requests).toHaveLength(4);expect(requests.every(request=>request.signal.aborted)).toBe(true);
    expect(lines.join('\n')).toMatch(/worker\s+down/u);
  } finally {jest.useRealTimers();}
});
