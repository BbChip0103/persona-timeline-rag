import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpstreamRecord } from '@ptr/messaging/registry';
import { OpenAICompatibleUpstream, TextProviderUpstream, UpstreamConnectError, UpstreamPool, type UpstreamResult, type UpstreamSource } from '../src';
import { upstreamFromEnvironment } from '../src/main';

const messages=[{role:'user',content:'안녕'}];
const signal=()=>new AbortController().signal;
const until=async(check:()=>boolean,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not met');};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
class TestSource implements UpstreamSource {
  constructor(private readonly records:UpstreamRecord[]) {}
  snapshot() {return this.records;}
  onChange() {return ()=>undefined;}
}
const rec=(id:string,port:number,extra:Partial<UpstreamRecord>={}):UpstreamRecord=>({pool:'m',id,baseUrl:`http://127.0.0.1:${port}/v1`,maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active',epoch:'file',seq:0,...extra});
const metricsText=(v:{waiting?:number;kv?:number;start?:number})=>`vllm:num_requests_running{model_name="m"} 1\nvllm:num_requests_waiting{model_name="m"} ${v.waiting??0}\nvllm:kv_cache_usage_perc{model_name="m"} ${v.kv??0.1}\n${v.start!==undefined?`process_start_time_seconds ${v.start}\n`:''}`;
/** Scripted member: held or instant completions, scripted refusals, and a /metrics body the test sets. */
function engine(name:string) {
  const held:(()=>void)[]=[];let hold=false;let refuse=0;let metrics:string|null=metricsText({start:100});let metricsFail=false;
  const calls={complete:0,metrics:0};
  const primary={model:'m',health:async()=>true,
    metrics:async()=>{calls.metrics++;if(metricsFail) throw new Error('timeout');return metrics;},
    complete:(): Promise<UpstreamResult>=>{
      calls.complete++;
      if(refuse>0) {refuse--;return Promise.reject(new UpstreamConnectError('connect_refused',true));}
      const result={status:200,contentType:'application/json',body:`{"from":"${name}"}`};
      return hold?new Promise(resolve=>held.push(()=>resolve(result))):Promise.resolve(result);
    }};
  return {primary,calls,held,setHold:(v:boolean)=>{hold=v;},refuse:(n:number)=>{refuse=n;},setMetrics:(v:string|null)=>{metrics=v;},failMetrics:(v:boolean)=>{metricsFail=v;},
    releaseAll:()=>{for(const r of held.splice(0)) r();}};
}
const pools:UpstreamPool[]=[];
afterEach(async()=>{await Promise.all(pools.splice(0).map(pool=>pool.close()));});
function twoEngines(options:Partial<ConstructorParameters<typeof UpstreamPool>[0]>={},records?:UpstreamRecord[]) {
  const a=engine('a'),b=engine('b');const byId:Record<string,ReturnType<typeof engine>>={a,b};
  const pool=new UpstreamPool({model:'m',source:new TestSource(records??[rec('a',18000),rec('b',18001)]),create:record=>byId[record.id]!.primary,admission:true,
    telemetry:{intervalMs:40,kvHigh:0.95,waitingMax:2},...options});
  pools.push(pool);
  return {pool,a,b};
}
const member=(pool:UpstreamPool,id:string)=>pool.poolMetrics().upstreams.find(u=>u.id===id)!;
const from=async(pool:UpstreamPool)=>JSON.parse(String((await pool.complete({messages},signal())).body)).from as string;

describe('engine telemetry as a filter in the pool (S4, §3.1 item 5)',()=>{
  test('an upstream whose engine reports KV usage ≥ 0.95 gets no dispatches while fresh; when it clears it is used again',async()=>{
    const {pool,a,b}=twoEngines();
    b.setMetrics(metricsText({kv:0.97,start:100}));
    await until(()=>member(pool,'b').telemetry?.blocked===true);
    a.setHold(true);b.setHold(true);
    const calls=Array.from({length:7},()=>pool.complete({messages},signal()));
    // Non-blocked members first: a has room, so the idle blocked b gets nothing.
    await until(()=>a.calls.complete+b.calls.complete===7);
    expect([a.calls.complete,b.calls.complete]).toEqual([7,0]);
    b.setMetrics(metricsText({kv:0.5,start:100}));
    await until(()=>member(pool,'b').telemetry?.blocked===false);
    b.setHold(false);
    expect(await from(pool)).toBe('b'); // least in flight again
    a.releaseAll();b.releaseAll();await Promise.all(calls);
    expect(pool.poolMetrics().members).toMatchObject({telemetryBlocked:0,telemetryStale:0});
  });
  test('waiting > 2 blocks too; with every upstream blocked the request waits in the queue (no failover) and runs once one clears',async()=>{
    const secondaryCalls={n:0};
    const secondary=new TextProviderUpstream({generate:async()=>{secondaryCalls.n++;return '보조';}},'secondary/model');
    const {pool,a,b}=twoEngines({secondary,queueTimeoutMs:3000});
    a.setMetrics(metricsText({waiting:3,start:100}));b.setMetrics(metricsText({waiting:5,start:100}));
    await until(()=>member(pool,'a').telemetry?.blocked===true&&member(pool,'b').telemetry?.blocked===true);
    a.setHold(true);b.setHold(true);
    const busy=[pool.complete({messages},signal()),pool.complete({messages},signal())]; // nothing else fits: one request on each idle blocked member
    await until(()=>a.calls.complete===1&&b.calls.complete===1);
    const waiting=pool.complete({messages},signal());
    await sleep(150);
    expect(pool.poolMetrics().waiting).toBe(1);expect(a.calls.complete+b.calls.complete).toBe(2);
    a.setHold(false);a.setMetrics(metricsText({waiting:0,start:100}));
    expect(String((await waiting).body)).toContain('"a"');
    a.releaseAll();b.releaseAll();await Promise.all(busy);
    expect(secondaryCalls.n).toBe(0);
    expect(member(pool,'b').telemetry).toMatchObject({creditModelMiss:1}); // waiting > 0 on 3+ polls in a row
  });
  test('stale telemetry (no good poll for 3 × the interval) is ignored: the blocked upstream is used again (fail-open)',async()=>{
    let now=1_000_000;
    const {pool,a,b}=twoEngines({now:()=>now,telemetry:{intervalMs:1000,kvHigh:0.95,waitingMax:2}});
    b.setMetrics(metricsText({kv:0.99,start:100}));
    await until(()=>member(pool,'b').telemetry?.blocked===true);
    a.setHold(true);b.setHold(true);
    const held=[pool.complete({messages},signal()),pool.complete({messages},signal()),pool.complete({messages},signal())];
    await until(()=>a.calls.complete+b.calls.complete===3);expect(b.calls.complete).toBe(0); // a has room: b is not used
    b.setHold(false);b.failMetrics(true);now+=3001;
    expect(member(pool,'b').telemetry).toMatchObject({stale:true,blocked:false});
    expect(pool.poolMetrics().members.telemetryStale).toBe(2); // a's last poll is as old on this clock
    expect(await from(pool)).toBe('b');
    a.releaseAll();b.releaseAll();await Promise.all(held);
  });
  test('blocked for 10 polls while the engine runs < maxSeqs / 4: one warning naming the upstream id (a metric that may not mean what we assume)',async()=>{
    const lines:string[]=[];
    const {pool,b}=twoEngines({log:line=>lines.push(line)});
    b.setMetrics(metricsText({kv:0.97,start:100})); // running 1 of maxSeqs 12
    await until(()=>member(pool,'b').telemetry?.suspectBlocked===1,3000);
    expect(lines.filter(l=>l.startsWith('WARNING gateway upstream b: blocked by engine telemetry for 10 polls'))).toHaveLength(1);
  });
  test('telemetry off (no option): no /metrics polls and no telemetry block in the metrics',async()=>{
    const {pool,a}=twoEngines({telemetry:undefined});
    await from(pool);await sleep(60);
    expect(a.calls.metrics).toBe(0);expect(member(pool,'a').telemetry).toBeNull();
  });
});

describe('slow start after a breaker closes, and engine restarts (S4, §5 / §4.2)',()=>{
  test('a breaker that closes again starts the upstream at limit 1 and ramps it over the slow-start time',async()=>{
    let now=1_000_000;
    const {pool,a,b}=twoEngines({now:()=>now,slowStartMs:30000,telemetry:undefined,failover:{failureThreshold:1,cooldownMs:50}});
    expect(member(pool,'b')).toMatchObject({limit:12,slowStart:false,rampReason:null});
    // a holds the first call (tie → a); the second goes to b, which refuses: b's breaker opens and the call moves to a.
    a.setHold(true);b.refuse(1);
    const first=pool.complete({messages},signal());await until(()=>a.calls.complete===1);
    const second=pool.complete({messages},signal());await until(()=>a.calls.complete===2);
    expect(member(pool,'b').breaker).not.toBe('closed');
    a.setHold(false);a.releaseAll();await Promise.all([first,second]);
    await sleep(60); // cooldown over: the next dispatch pass probes b (healthy) and closes the breaker
    await from(pool);
    await until(()=>member(pool,'b').breaker==='closed');
    expect(member(pool,'b')).toMatchObject({limit:1,slowStart:true,rampReason:'breaker_closed'});
    now+=15000;expect(member(pool,'b').limit).toBe(6);
    now+=15000;expect(member(pool,'b')).toMatchObject({limit:12,slowStart:false,rampReason:null});
  });
  test('a changed process_start_time_seconds (file/env source: the epoch never changes) clears the upstream: fresh breaker, slow start again',async()=>{
    let now=1_000_000;
    const {pool,b}=twoEngines({now:()=>now,slowStartMs:30000,failover:{failureThreshold:1,cooldownMs:60000}});
    await until(()=>member(pool,'b').telemetry?.ageMs!==null);
    b.refuse(5);
    for(let i=0;i<3;i++) await from(pool);
    expect(member(pool,'b').breaker).toBe('open');
    b.refuse(0);b.setMetrics(metricsText({start:200}));
    await until(()=>member(pool,'b').telemetry?.restarts===1);
    expect(member(pool,'b')).toMatchObject({breaker:'closed',limit:1,slowStart:true,rampReason:'restarted',epoch:'file'});
    expect(pool.poolMetrics().events.restarted).toBe(1);
    now+=30000;expect(member(pool,'b')).toMatchObject({limit:12,rampReason:null});
  });
});

describe('single upstream: a breaker closed by an answer (sent while open, no alternative)',()=>{
  test('does not ramp: the only upstream just served, and slow start would throttle the whole pool',async()=>{
    let now=1_000_000;const a=engine('a');
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',18000)]),create:()=>a.primary,admission:true,now:()=>now,slowStartMs:30000,
      failover:{failureThreshold:1,cooldownMs:60000}});
    pools.push(pool);
    a.refuse(1);
    await expect(pool.complete({messages},signal())).rejects.toBeInstanceOf(UpstreamConnectError);
    expect(member(pool,'a').breaker).toBe('open');
    expect(await from(pool)).toBe('a'); // sent while open (no alternative), answered → closed
    expect(member(pool,'a')).toMatchObject({breaker:'closed',limit:12,slowStart:false,rampReason:null});
  });
});

describe('primary-to-primary retry and failover rule (§5) with telemetry on',()=>{
  test('after a refused connection the retry waits for another primary\'s credit (telemetry-blocked = busy), never the secondary while a primary is usable',async()=>{
    const secondaryCalls={n:0};
    const secondary=new TextProviderUpstream({generate:async()=>{secondaryCalls.n++;return '보조';}},'secondary/model');
    const {pool,a,b}=twoEngines({secondary,queueTimeoutMs:3000,failover:{failureThreshold:5}});
    // One held call on each (tie → a, then b), then b's engine reports a full KV cache: b is blocked and not idle.
    await until(()=>member(pool,'b').telemetry?.ageMs!==null);
    a.setHold(true);b.setHold(true);
    const busy=[pool.complete({messages},signal()),pool.complete({messages},signal())];await until(()=>a.calls.complete===1&&b.calls.complete===1);
    b.setMetrics(metricsText({kv:0.99,start:100}));
    await until(()=>member(pool,'b').telemetry?.blocked===true);
    a.refuse(1);
    const result=pool.complete({messages},signal()); // a refuses → retry waits for b's credit (blocked), not the secondary
    await sleep(150);expect(secondaryCalls.n).toBe(0);
    b.setHold(false);b.setMetrics(metricsText({kv:0.5,start:100}));
    expect(String((await result).body)).toContain('"b"');
    a.releaseAll();b.releaseAll();await Promise.all(busy);
    expect(pool.poolMetrics().retriedOnOtherPrimary).toBe(1);expect(secondaryCalls.n).toBe(0);
  });
});

describe('OpenAICompatibleUpstream /metrics and the gateway environment',()=>{
  const servers:Server[]=[];
  afterEach(async()=>{await Promise.all(servers.splice(0).map(s=>{s.closeAllConnections();return new Promise(r=>s.close(r));}));});
  async function listen(server:Server) {servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return (server.address() as AddressInfo).port;}
  test('metrics() reads {origin}/metrics; a non-200 answer or a body over 1 MiB is null',async()=>{
    let status=200, body=metricsText({start:1});
    const port=await listen(createServer((req,res)=>{res.writeHead(req.url==='/metrics'?status:404);res.end(req.url==='/metrics'?body:'');}));
    const upstream=new OpenAICompatibleUpstream({baseUrl:`http://127.0.0.1:${port}/v1`,model:'m'});
    expect(await upstream.metrics(signal())).toContain('vllm:num_requests_waiting');
    status=503;expect(await upstream.metrics(signal())).toBeNull();
    status=200;body='# '+'x'.repeat(1024*1024+10)+'\n';expect(await upstream.metrics(signal())).toBeNull();
  });
  test('PTR_GATEWAY_METRICS_INTERVAL_MS (default 0 = off until verified on real engines; e.g. 1000), PTR_GATEWAY_METRICS_TIMEOUT_MS (500, capped by the interval when unset), PTR_GATEWAY_ENGINE_KV_HIGH (0.95), PTR_GATEWAY_ENGINE_WAITING_MAX (2)',async()=>{
    const port=await listen(createServer((req,res)=>{res.writeHead(req.url==='/metrics'?200:404);res.end(req.url==='/metrics'?metricsText({kv:0.97,start:1}):'');}));
    const dir=mkdtempSync(join(tmpdir(),'ptr-upstreams-'));const file=join(dir,'upstreams.json');
    writeFileSync(file,JSON.stringify({pools:{m:{upstreams:[{id:'a',baseUrl:`http://127.0.0.1:${port}/v1`}]}}}));
    const env={PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_GATEWAY_UPSTREAMS_FILE:file,PTR_GATEWAY_POOL:'m'};
    const byDefault=upstreamFromEnvironment(env);
    try {expect(byDefault.upstream.poolMetrics!()).toMatchObject({telemetry:null,upstreams:[{telemetry:null}]});} finally {await byDefault.close?.();}
    const on=upstreamFromEnvironment({...env,PTR_GATEWAY_METRICS_INTERVAL_MS:'1000'});
    try {
      await until(()=>on.upstream.poolMetrics!().upstreams[0]!.telemetry?.ageMs!==null);
      expect(on.upstream.poolMetrics!()).toMatchObject({telemetry:{intervalMs:1000,kvHigh:0.95,waitingMax:2,timeoutMs:500},upstreams:[{telemetry:{kvUsage:0.97,blocked:true}}]});
    } finally {await on.close?.();}
    // Over an SSH tunnel /metrics took 0.6-1.2 s on a new connection (S8): the poll timeout is configurable.
    const slow=upstreamFromEnvironment({...env,PTR_GATEWAY_METRICS_INTERVAL_MS:'1000',PTR_GATEWAY_METRICS_TIMEOUT_MS:'2000'});
    try {expect(slow.upstream.poolMetrics!()).toMatchObject({telemetry:{intervalMs:1000,timeoutMs:2000}});} finally {await slow.close?.();}
    // A timeout above 3 × the interval would keep the member fresh-looking on stale data: rejected when telemetry is on.
    expect(()=>upstreamFromEnvironment({...env,PTR_GATEWAY_METRICS_INTERVAL_MS:'500',PTR_GATEWAY_METRICS_TIMEOUT_MS:'1501'})).toThrow('INVALID_PTR_GATEWAY_METRICS_TIMEOUT_MS');
    const edge=upstreamFromEnvironment({...env,PTR_GATEWAY_METRICS_INTERVAL_MS:'500',PTR_GATEWAY_METRICS_TIMEOUT_MS:'1500'});
    try {expect(edge.upstream.poolMetrics!()).toMatchObject({telemetry:{timeoutMs:1500}});} finally {await edge.close?.();}
    const fast=upstreamFromEnvironment({...env,PTR_GATEWAY_METRICS_INTERVAL_MS:'200'});
    try {expect(fast.upstream.poolMetrics!()).toMatchObject({telemetry:{intervalMs:200,timeoutMs:200}});} finally {await fast.close?.();}
    const off=upstreamFromEnvironment({...env,PTR_GATEWAY_METRICS_INTERVAL_MS:'0',PTR_GATEWAY_ENGINE_KV_HIGH:'0.9',PTR_GATEWAY_ENGINE_WAITING_MAX:'0'});
    try {expect(off.upstream.poolMetrics!()).toMatchObject({telemetry:null,upstreams:[{telemetry:null}]});} finally {await off.close?.();}
    expect(()=>upstreamFromEnvironment({...env,PTR_GATEWAY_DISCOVERY:'redis',PTR_REGISTRY_PREFIX:'ptr:turns'})).toThrow('INVALID_PTR_REGISTRY_PREFIX');
    for(const [name,value] of [['PTR_GATEWAY_METRICS_INTERVAL_MS','50'],['PTR_GATEWAY_METRICS_TIMEOUT_MS','10'],['PTR_GATEWAY_METRICS_TIMEOUT_MS','60001'],['PTR_GATEWAY_ENGINE_KV_HIGH','1.5'],['PTR_GATEWAY_ENGINE_WAITING_MAX','-1']] as const)
      expect(()=>upstreamFromEnvironment({...env,[name]:value})).toThrow(`INVALID_${name}`);
  });
});
