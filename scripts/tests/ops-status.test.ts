import { renderFamilies, type Family } from '@ptr/ops';
import { ROLE_TARGETS, run } from '../ops-status';

// Synthetic /metrics/prom bodies per role, before and after the window .
type Counts={served?:Record<string,number>;breakers?:Record<string,0|1>;queueTimeoutGateway?:number;queueTimeoutDispatcher?:number;
  finished?:Record<string,number>;safety?:number};
const family=(name:string,type:Family['type'],samples:Family['samples']):Family=>({name,help:'synthetic',type,samples});
function bodies(c:Counts):Record<string,string> {
  return {
    api:renderFamilies([family('ptr_turns_created_total','counter',[{value:1}])]),
    worker:renderFamilies([family('ptr_turns_finished_total','counter',Object.entries(c.finished??{}).map(([key,value])=>{
      const [outcome,code]=key.split(':');return {labels:{outcome:outcome!,code:code!},value};})),
      family('ptr_safety_fallback_total','counter',c.safety===undefined?[]:[{labels:{scope:'turn',reason:'timeout'},value:c.safety}])]),
    dispatcher:renderFamilies([family('ptr_dispatch_failed_total','counter',[{labels:{code:'QUEUE_TIMEOUT'},value:c.queueTimeoutDispatcher??0}])]),
    gateway:renderFamilies([family('ptr_gateway_served_total','counter',Object.entries(c.served??{}).map(([upstream,value])=>({labels:{upstream},value}))),
      family('ptr_gateway_breaker_open','gauge',Object.entries(c.breakers??{}).map(([upstream,value])=>({labels:{upstream},value}))),
      family('ptr_gateway_rejected_total','counter',[{labels:{reason:'queue_timeout'},value:c.queueTimeoutGateway??0}])]),
  };
}
async function status(before:Counts,after:Counts,options:{down?:string[];argv?:string[]}={}) {
  const lines:string[]=[];let phase=0;const slept:number[]=[];
  const urls=new Map<string,string>(ROLE_TARGETS.map(target=>[target.url,target.role]));
  const code=await run(options.argv??[],{
    fetch:async url=>{
      const role=urls.get(String(url))!;
      if(options.down?.includes(role)) throw new TypeError('fetch failed');
      return new Response((phase===0?bodies(before):bodies(after))[role]!,{status:200});
    },
    sleep:async ms=>{slept.push(ms);phase=1;},
    write:line=>lines.push(line),
  });
  return {code,text:lines.join('\n'),lines,slept};
}
const healthy:Counts={served:{primary:10},breakers:{'gpu-a':0},finished:{'completed:none':10},safety:0};

test('the four roles: api 56441, worker 56442, dispatcher 56443, gateway 56460',()=>{
  expect(ROLE_TARGETS.map(target=>`${target.role} ${target.url}`)).toEqual(['api http://127.0.0.1:56441/metrics/prom',
    'worker http://127.0.0.1:56442/metrics/prom','dispatcher http://127.0.0.1:56443/metrics/prom','gateway http://127.0.0.1:56460/metrics/prom']);
});
test('all quiet: every role up, no ALERT, exit 0; the window defaults to 30 s and is read twice',async()=>{
  const {code,text,slept}=await status(healthy,{...healthy,served:{primary:30},finished:{'completed:none':30}});
  expect(code).toBe(0);expect(slept).toEqual([30000]);
  expect(text).toMatch(/api\s+up/);expect(text).toMatch(/gateway\s+up/);
  expect(text).toMatch(/secondary ratio\s+0\.0% \(0\/20\)\s+ok/);
  expect(text).not.toContain('ALERT ');expect(text).toContain('summary: 0 ALERT');
});
test('an open breaker is information (engine unreachable), never an ALERT',async()=>{
  const {code,text}=await status(healthy,{...healthy,breakers:{'gpu-a':1},served:{primary:20},finished:{'completed:none':20}});
  expect(code).toBe(0);
  expect(text).toMatch(/breaker gpu-a\s+open\s+INFO engine unreachable/);
  expect(text).not.toMatch(/ALERT .*breaker/);
});
test('ALERT: secondary ratio above 20%, any queue timeout, TURN_TIMEOUT above 5%, any safety fallback',async()=>{
  const after:Counts={served:{primary:12,secondary:8},breakers:{'gpu-a':1},queueTimeoutGateway:0,queueTimeoutDispatcher:1,
    finished:{'completed:none':16,'failed:TURN_TIMEOUT':4},safety:2};
  const {code,lines}=await status(healthy,after);
  expect(code).toBe(1);
  const alerts=lines.filter(line=>line.includes('ALERT'));
  expect(alerts.find(line=>line.startsWith('secondary ratio'))).toMatch(/80\.0% \(8\/10\)\s+ALERT > 20%/);
  expect(alerts.find(line=>line.startsWith('queue timeouts'))).toMatch(/1 \(QUEUE_TIMEOUT 1, gateway 0\)\s+ALERT > 0/);
  expect(alerts.find(line=>line.startsWith('TURN_TIMEOUT rate'))).toMatch(/40\.0% \(4\/10\)\s+ALERT > 5%/);
  expect(alerts.find(line=>line.startsWith('safety fallback'))).toMatch(/2\s+ALERT > 0/);
  expect(lines.at(-1)).toBe('summary: 4 ALERT');
  // At the limits nothing fires: 20% secondary, 5% TURN_TIMEOUT.
  const edge=await status(healthy,{served:{primary:18,secondary:2},breakers:{'gpu-a':0},finished:{'completed:none':29,'failed:TURN_TIMEOUT':1},safety:0});
  expect(edge.code).toBe(0);
});
test('gateway queue timeouts alone raise the queue ALERT',async()=>{
  const {code,text}=await status(healthy,{...healthy,queueTimeoutGateway:3});
  expect(code).toBe(1);expect(text).toMatch(/queue timeouts\s+3 \(QUEUE_TIMEOUT 0, gateway 3\)\s+ALERT > 0/);
});
test('a role that does not answer is down; its checks are n/a, not ALERT',async()=>{
  const {code,text}=await status(healthy,healthy,{down:['gateway','worker']});
  expect(code).toBe(0);
  expect(text).toMatch(/gateway\s+down/);expect(text).toMatch(/worker\s+down/);expect(text).toMatch(/api\s+up/);
  expect(text).toMatch(/secondary ratio\s+n\/a \(gateway down\)/);expect(text).toMatch(/TURN_TIMEOUT rate\s+n\/a \(worker down\)/);
});
test('a role that did not answer the first read has no baseline: its checks are n/a, never an ALERT from lifetime totals',async()=>{
  const lines:string[]=[];let phase=0;
  const urls=new Map<string,string>(ROLE_TARGETS.map(target=>[target.url,target.role]));
  const after=bodies({served:{primary:5,secondary:50},finished:{'failed:TURN_TIMEOUT':40},safety:9,queueTimeoutDispatcher:3,queueTimeoutGateway:2});
  const code=await run([],{fetch:async url=>{const role=urls.get(String(url))!;if(phase===0) throw new TypeError('fetch failed');return new Response(after[role]!,{status:200});},
    sleep:async()=>{phase=1;},write:line=>lines.push(line)});
  const text=lines.join('\n');
  expect(code).toBe(0);expect(text).toContain('summary: 0 ALERT');
  expect(text).toMatch(/secondary ratio\s+n\/a \(no baseline\)/);expect(text).toMatch(/TURN_TIMEOUT rate\s+n\/a \(no baseline\)/);
  expect(text).toMatch(/safety fallback\s+n\/a \(no baseline\)/);expect(text).toMatch(/queue timeouts\s+n\/a \(no baseline\)/);
});
test('a counter that went back (restart) counts from zero; --window sets the wait; a bad window is refused',async()=>{
  const {code,text,slept}=await status({...healthy,served:{primary:500}},{...healthy,served:{primary:10,secondary:0}},{argv:['--window','5']});
  expect(code).toBe(0);expect(slept).toEqual([5000]);expect(text).toMatch(/secondary ratio\s+0\.0% \(0\/10\)/);
  for(const argv of [['--window','0'],['--window','x'],['--window=601'],['--other']]) expect((await status(healthy,healthy,{argv})).code).toBe(2);
});
