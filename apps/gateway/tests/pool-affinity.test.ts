import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpstreamRecord } from '@ptr/messaging/registry';
import { UpstreamConnectError, UpstreamPool, type ChatCompletionRequest, type Upstream, type UpstreamResult, type UpstreamSource } from '../src';
import { upstreamFromEnvironment } from '../src/main';

const signal=()=>new AbortController().signal;
const until=async(check:()=>boolean,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not met');};
class MutableSource implements UpstreamSource {
  private readonly listeners=new Set<()=>void>();
  constructor(private records:UpstreamRecord[]) {}
  snapshot() {return this.records;}
  onChange(callback:()=>void) {this.listeners.add(callback);return ()=>{this.listeners.delete(callback);};}
  set(records:UpstreamRecord[]) {this.records=records;for(const listener of this.listeners) listener();}
}
const rec=(id:string,extra:Partial<UpstreamRecord>={}):UpstreamRecord=>({pool:'m',id,baseUrl:`http://127.0.0.1:${id==='a'?18000:18001}/v1`,maxSeqs:12,
  kvCapacityTokens:null,weight:1,state:'active',epoch:'file',seq:0,...extra});
const encoder=new TextEncoder();
/** Streaming engine: first chunk at once; with hold the rest (usage + [DONE]) waits for release. Records each call's messages. */
function engine() {
  const gates:(()=>void)[]=[];let hold=false;let holdFirst=false;let refuse=0;let metrics=`process_start_time_seconds 100\n`;
  const seen:ChatCompletionRequest[]=[];
  const primary={model:'m',health:async()=>true,metrics:async()=>metrics,
    complete:async(request:ChatCompletionRequest):Promise<UpstreamResult>=>{
      if(refuse>0) {refuse--;throw new UpstreamConnectError('connect_refused',true);}
      seen.push(request);
      const gate=hold||holdFirst?new Promise<void>(resolve=>gates.push(resolve)):Promise.resolve();
      const before=holdFirst;
      async function* body() {
        if(before) await gate;
        yield encoder.encode(`data: ${JSON.stringify({choices:[{delta:{content:'tok'}}]})}\n\n`);
        await gate;
        yield encoder.encode(`data: ${JSON.stringify({choices:[],usage:{prompt_tokens:1000,completion_tokens:1}})}\n\ndata: [DONE]\n\n`);
      }
      return {status:200,contentType:'text/event-stream',body:body()};
    }};
  return {primary,seen,setHold:(v:boolean)=>{hold=v;},setHoldFirst:(v:boolean)=>{holdFirst=v;},refuse:(n:number)=>{refuse=n;},setStart:(s:number)=>{metrics=`process_start_time_seconds ${s}\n`;},
    release:()=>{for(const g of gates.splice(0)) g();}};
}
async function readAll(result:UpstreamResult):Promise<string> {
  if(typeof result.body==='string') return result.body;
  let text='';for await (const chunk of result.body) text+=new TextDecoder().decode(chunk);return text;
}
/** Starts a call and reads its first chunk (prefill done: the prefix is now in the engine's cache); `finish` reads the rest. */
async function started(pool:UpstreamPool,request:ChatCompletionRequest,context?:{requestKey?:string}) {
  const result=await pool.complete(request,signal(),context);
  const iterator=(result.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
  await iterator.next();
  return {finish:async()=>{while(!(await iterator.next()).done);}};
}
// Policy block 1000 tokens (3900 B), persona 200, each user turn 300, each answer 100 (bytes / 3.9).
const P='P'.repeat(3900), S='S'.repeat(780);
const user=(i:number)=>`u${i}`.padEnd(1170,'x'), answer=(i:number)=>`a${i}`.padEnd(390,'y');
/** Turn k of one session: policy, persona, the k − 1 earlier exchanges, the new user message. */
const turn=(k:number,persona=S):ChatCompletionRequest=>({stream:true,messages:[{role:'system',content:P},{role:'system',content:persona},
  ...Array.from({length:k-1},(_,i)=>[{role:'user',content:user(i+1)},{role:'assistant',content:answer(i+1)}]).flat(),{role:'user',content:user(k)}]});
const pools:UpstreamPool[]=[];
afterEach(async()=>{await Promise.all(pools.splice(0).map(pool=>pool.close()));});
function setup(options:Partial<ConstructorParameters<typeof UpstreamPool>[0]>={},records=[rec('a')]) {
  const a=engine(),b=engine(), byId:Record<string,ReturnType<typeof engine>>={a,b}, source=new MutableSource(records), lines:string[]=[];
  const pool=new UpstreamPool({model:'m',source,create:record=>byId[record.id]!.primary,admission:true,slowStartMs:0,routeLogSample:0,
    log:line=>lines.push(line),...options});
  pools.push(pool);
  return {pool,a,b,source,lines};
}
const member=(pool:UpstreamPool,id:string)=>pool.poolMetrics().upstreams.find(u=>u.id===id)!;

describe('prefix table and cache affinity in the pool (S5, §4.2–4.3)',()=>{
  test('affinity on: a session\'s next turn goes back to the upstream holding its history although the other one is idle (least_inflight would not)',async()=>{
    for(const mode of ['on','off'] as const) {
      const {pool,a,b,source}=setup({...(mode==='on'?{affinity:{minTokens:256,slack:0.5}}:{}),routing:'least_inflight'});
      a.setHold(true);b.setHold(true);
      const first=await started(pool,turn(2)); // on a, the only member; held in decode
      await until(()=>member(pool,'a').prefix.entries===4); // P, S, u1, a1 recorded at the first chunk
      source.set([rec('a'),rec('b')]);
      const second=await started(pool,turn(3));
      // a holds P+S+u1+a1 = 1600 tokens of turn 3: g = 1600 − G(1000) = 600 ≥ 256, cost a 0.24 vs b 0.21 (slack 0.5).
      expect([a.seen.length,b.seen.length]).toEqual(mode==='on'?[2,0]:[1,1]);
      expect(pool.poolMetrics().affinity).toMatchObject(mode==='on'?{mode:'on',picked:1,brokenBySlack:0,none:1}:{mode:'off',picked:0,brokenBySlack:0,none:0});
      a.release();b.release();await first.finish();await second.finish();
    }
  });
  test('KV reservation = (T̂ − G) + M whatever the table says; the table match lowers only the prefill ledger U (affinity on)',async()=>{
    const {pool,a}=setup({affinity:{minTokens:256,slack:0.5}},[rec('a',{kvCapacityTokens:100000})]);
    await readAll(await pool.complete(turn(2),signal())); // the table now holds P, S, u1, a1 (1600 tokens)
    a.setHoldFirst(true);
    const pending=await pool.complete(turn(3),signal()); // headers only: still in prefill
    // T̂ 2300: KV (2300 − 1000) + 512 = 1812 (the history is cached but not held by a running request: no KV saved);
    // U = 2300 − 1600 = 700 (the cached history is not prefilled again).
    expect(member(pool,'a')).toMatchObject({reservedKvTokens:1812,prefillTokens:700,prefix:{extraHits:1}});
    a.release();await readAll(pending);
    expect(member(pool,'a')).toMatchObject({reservedKvTokens:0,prefillTokens:0});
  });
  test('affinity off: the table is not consulted at all (exactly the S4 credit and scored cost); it is still kept for the metrics',async()=>{
    const {pool,a,lines}=setup({routing:'scored',routeLogSample:1},[rec('a',{kvCapacityTokens:100000})]);
    await readAll(await pool.complete(turn(2),signal()));
    a.setHoldFirst(true);
    const pending=await pool.complete(turn(3),signal());
    expect(member(pool,'a')).toMatchObject({reservedKvTokens:1812,prefillTokens:1300,prefix:{entries:4,extraHits:0}});
    expect(lines.at(-1)).toMatch(/h=\{a:0\.435\} cost=\{a:0\.213\}/); // h = G / T̂ = 1000 / 2300; cost 1300 / 10000 + 1 / 12
    a.release();await readAll(pending);
  });
  test('only answered calls are recorded (at the first chunk): a refused connection leaves the table as it was',async()=>{
    const {pool,a,b}=setup({},[rec('a'),rec('b')]);
    a.refuse(1);
    await readAll(await pool.complete(turn(2),signal())); // a refuses, retried on b
    expect([member(pool,'a').prefix.entries,member(pool,'b').prefix.entries]).toEqual([0,4]);
    expect(b.seen).toHaveLength(1);
  });
  test('the table is cleared when the upstream\'s breaker opens and when its engine restarts',async()=>{
    const {pool,a}=setup({failover:{failureThreshold:1},telemetry:{intervalMs:30,kvHigh:0.95,waitingMax:2}});
    await readAll(await pool.complete(turn(2),signal()));
    expect(member(pool,'a').prefix).toMatchObject({entries:4,cleared:0});
    a.refuse(1);
    await expect(pool.complete(turn(2),signal())).rejects.toThrow('connect_refused');
    expect(member(pool,'a')).toMatchObject({breaker:'open',prefix:{entries:0,cleared:1}});
    const {pool:restarting,a:engineA}=setup({telemetry:{intervalMs:30,kvHigh:0.95,waitingMax:2}});
    await until(()=>member(restarting,'a').telemetry?.ageMs!==null);
    await readAll(await restarting.complete(turn(2),signal()));
    engineA.setStart(200);
    await until(()=>restarting.poolMetrics().events.restarted===1);
    expect(member(restarting,'a').prefix).toMatchObject({entries:0,cleared:1});
    // Several processes on the port (an earlier start time appears): detection off, and the table is cleared once.
    await readAll(await restarting.complete(turn(2),signal()));
    engineA.setStart(150);
    await until(()=>member(restarting,'a').telemetry?.restartDetectionDisabled===true);
    expect(member(restarting,'a').prefix).toMatchObject({entries:0,cleared:2});
    engineA.setStart(200);await new Promise(r=>setTimeout(r,100));
    expect(member(restarting,'a').prefix.cleared).toBe(2);
    // Re-armed on a start time other than the baseline before it went off (200): the process left may be another engine.
    await readAll(await restarting.complete(turn(2),signal()));
    engineA.setStart(150);
    await until(()=>member(restarting,'a').telemetry?.restartDetectionDisabled===false);
    expect(member(restarting,'a').prefix).toMatchObject({entries:0,cleared:3});
  });
  test('§8 metrics: per upstream TTFT / e2e quantiles and est/actual prompt tokens from the stream\'s usage; pool latency; affinity counters',async()=>{
    const {pool}=setup({affinity:{minTokens:256,slack:0.5}});
    for(const k of [2,3]) await readAll(await pool.complete(turn(k),signal()));
    const metrics=pool.poolMetrics(), a=member(pool,'a');
    expect(a.ttftMs.p50).toEqual(expect.any(Number));expect(a.e2eMs.p95).toEqual(expect.any(Number));
    // T̂ 1900 and 2300 against the engine's 1000 prompt tokens.
    expect(a.estOverActualTokens).toEqual({p50:1.9,p95:2.3,n:2});
    expect(metrics.latency.ttftMs.p50).toEqual(expect.any(Number));expect(metrics.latency.e2eMs.p50).toEqual(expect.any(Number));
    expect(metrics.affinity).toEqual({mode:'on',minTokens:256,slack:0.5,picked:1,brokenBySlack:0,none:1});
    expect(metrics.prefixTtlMs).toBe(120000);
    expect(a.prefix).toMatchObject({entries:6,extraHits:1});
  });
});

describe('latency samples',()=>{
  test('e2e is recorded only for streams that completed; a stream the caller closed early counts for TTFT only',async()=>{
    const {pool}=setup();
    const result=await pool.complete(turn(2),signal());
    const iterator=(result.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
    await iterator.next();await iterator.return!();
    expect(member(pool,'a')).toMatchObject({inFlight:0,ttftMs:{p50:expect.any(Number)},e2eMs:{p50:null}});
    await readAll(await pool.complete(turn(2),signal()));
    expect(member(pool,'a').e2eMs.p50).toEqual(expect.any(Number));
  });
});

describe('sampled routing decision log (§8, no text)',()=>{
  test('PTR_GATEWAY_ROUTE_LOG_SAMPLE 1: one line per decision with the hashed request key, est, h and cost per candidate, pick, reason, wait',async()=>{
    const {pool,lines}=setup({routeLogSample:1},[rec('a'),rec('b')]);
    await readAll(await pool.complete(turn(2),signal(),{requestKey:'turn-0001'}));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^route rk=[0-9a-f]{12} pool=m band=0 est=1900 h=\{a:0\.526,b:0\.526\} cost=\{a:0\.173,b:0\.173\} pick=a reason=tie wait=\d+ms$/);
    expect(lines[0]).not.toContain('turn-0001');expect(lines[0]).not.toMatch(/PPP|xxx/);
    // Salted per process: not the plain sha256 of the key (a guessable key cannot be confirmed from the log).
    expect(lines[0]).not.toContain(`rk=${createHash('sha256').update('turn-0001').digest('hex').slice(0,12)}`);
    await readAll(await pool.complete(turn(2),signal()));
    expect(lines[1]).toMatch(/^route rk=- /);
  });
  test('sampling 0 logs nothing; a fraction samples by the random source',async()=>{
    const none=setup({routeLogSample:0});
    await readAll(await none.pool.complete(turn(2),signal()));
    expect(none.lines).toHaveLength(0);
    let next=0.7;const half=setup({routeLogSample:0.5,random:()=>next});
    await readAll(await half.pool.complete(turn(2),signal()));next=0.2;await readAll(await half.pool.complete(turn(2),signal()));
    expect(half.lines).toHaveLength(1);
  });
  test('a retry on another primary is logged as reason=retry; a secondary call as pick=secondary reason=failover; affinity outcome when on',async()=>{
    const {pool,a,lines}=setup({routeLogSample:1},[rec('a'),rec('b')]);
    a.refuse(1);
    await readAll(await pool.complete(turn(2),signal()));
    expect(lines.map(line=>/pick=(\S+) reason=(\S+)/.exec(line)!.slice(1).join(' '))).toEqual(['a tie','b retry']);
    const secondary:Upstream={model:'s',complete:async()=>({status:200,contentType:'application/json',body:'{}'})};
    const withSecondary=setup({routeLogSample:1,secondary});
    withSecondary.a.refuse(1);
    await readAll(await withSecondary.pool.complete(turn(2),signal()));
    expect(withSecondary.lines.at(-1)).toMatch(/^route rk=- pool=m band=0 est=1900 h=\{\} cost=\{\} pick=secondary reason=failover wait=\d+ms$/);
    const sticky=setup({routeLogSample:1,affinity:{minTokens:256,slack:0.5}});
    for(const k of [2,3]) await readAll(await sticky.pool.complete(turn(k),signal()));
    expect(sticky.lines.map(line=>/reason=(\S+)(?: affinity=(\S+))?/.exec(line)!.slice(1).join(' '))).toEqual(['load none','affinity picked']);
  });
});

describe('configuration',()=>{
  test('PTR_GATEWAY_AFFINITY off (default) | on, _MIN_TOKENS (256), _SLACK (0.5), PTR_GATEWAY_PREFIX_TTL_MS (120000), PTR_GATEWAY_ROUTE_LOG_SAMPLE (0.01)',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'ptr-upstreams-'));const file=join(dir,'upstreams.json');
    writeFileSync(file,JSON.stringify({pools:{m:{upstreams:[{id:'a',baseUrl:'http://127.0.0.1:18000/v1'}]}}}));
    const env={PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_GATEWAY_UPSTREAMS_FILE:file,PTR_GATEWAY_POOL:'m'};
    const byDefault=upstreamFromEnvironment(env);
    try {expect(byDefault.upstream.poolMetrics!()).toMatchObject({affinity:{mode:'off',minTokens:256,slack:0.5},prefixTtlMs:120000});} finally {await byDefault.close?.();}
    const on=upstreamFromEnvironment({...env,PTR_GATEWAY_AFFINITY:'on',PTR_GATEWAY_AFFINITY_MIN_TOKENS:'512',PTR_GATEWAY_AFFINITY_SLACK:'0.25',PTR_GATEWAY_PREFIX_TTL_MS:'60000'});
    try {expect(on.upstream.poolMetrics!()).toMatchObject({affinity:{mode:'on',minTokens:512,slack:0.25},prefixTtlMs:60000});} finally {await on.close?.();}
    for(const [name,value] of [['PTR_GATEWAY_AFFINITY','yes'],['PTR_GATEWAY_AFFINITY_MIN_TOKENS','-1'],['PTR_GATEWAY_AFFINITY_SLACK','x'],
      ['PTR_GATEWAY_PREFIX_TTL_MS','10'],['PTR_GATEWAY_ROUTE_LOG_SAMPLE','1.5']] as const)
      expect(()=>upstreamFromEnvironment({...env,[name]:value})).toThrow(`INVALID_${name}`);
  });
});
