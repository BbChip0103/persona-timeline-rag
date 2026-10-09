import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpstreamRecord } from '@ptr/messaging';
import { createGateway, TextProviderUpstream, UpstreamConnectError, UpstreamPool, type GatewayOptions, type Upstream, type UpstreamResult, type UpstreamSource } from '../src';
import { upstreamFromEnvironment } from '../src/main';
import { closedPort } from './closed-port';

const token='synthetic_gateway_token_abcdefghij';
const messages=[{role:'user',content:'안녕'}];
const servers:Server[]=[];
afterEach(async()=>{
  jest.useRealTimers();
  await Promise.all(servers.splice(0).map(server=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}));
});
async function listen(server:Server):Promise<string> {servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
const sse=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\ndata: [DONE]\n\n`;
/** Fake engine whose completions are held until released one by one (FIFO). */
function heldEngine(name:string) {
  const pending:ServerResponse[]=[];const calls={completions:0,health:0};
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{
    if(req.url==='/health'){calls.health++;res.writeHead(200);res.end();return;}
    calls.completions++;pending.push(res);
  });});
  const release=()=>{const res=pending.shift();if(res){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(sse(name));}};
  return {server,calls,release,held:()=>pending.length};
}
function instantEngine(text='엔진') {
  const calls={completions:0};
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{
    if(req.url==='/health'){res.writeHead(200);res.end();return;}
    calls.completions++;res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(sse(text));
  });});
  return {server,calls};
}
/** Test source: membership changes when the test says so. */
class TestSource implements UpstreamSource {
  private records:UpstreamRecord[];private readonly listeners=new Set<()=>void>();
  constructor(records:UpstreamRecord[]=[]) {this.records=records;}
  snapshot() {return this.records;}
  onChange(listener:()=>void) {this.listeners.add(listener);return ()=>{this.listeners.delete(listener);};}
  set(records:UpstreamRecord[]) {this.records=records;for(const listener of this.listeners) listener();}
}
const rec=(id:string,base:string,extra:Partial<UpstreamRecord>={}):UpstreamRecord=>({pool:'m',id,baseUrl:`${base}/v1`,maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active',epoch:'e1',seq:0,...extra});
async function gateway(upstream:Upstream,limits:Partial<GatewayOptions['limits']>={}) {
  const g=createGateway({token,upstream,limits:{maxConcurrent:64,maxQueue:64,queueTimeoutMs:2000,upstreamTimeoutMs:5000,...limits}});
  return {g,base:await listen(g.server)};
}
const post=(base:string,body:unknown=({messages,stream:true}),signal?:AbortSignal)=>fetch(`${base}/v1/chat/completions`,
  {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body),signal});
const until=async(check:()=>boolean,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not met');};
const member=(pool:UpstreamPool,id:string)=>pool.poolMetrics().upstreams.find(u=>u.id===id);

describe('N=1: env-only PTR_SELFHOSTED_* behaves as a one-entry upstreams file',()=>{
  const relevant=(response:Response)=>({status:response.status,type:response.headers.get('content-type'),cache:response.headers.get('cache-control'),
    upstream:response.headers.get('x-ptr-upstream'),marker:response.headers.get('x-ptr-gateway')});
  async function compare(env:NodeJS.ProcessEnv,engineBase:string) {
    const dir=mkdtempSync(join(tmpdir(),'ptr-upstreams-'));const file=join(dir,'upstreams.json');
    writeFileSync(file,JSON.stringify({pools:{m:{upstreams:[{id:'selfhosted',baseUrl:`${engineBase}/v1`,maxSeqs:64}]}}}));
    const envOnly=upstreamFromEnvironment({...env,PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_SELFHOSTED_BASE_URL:`${engineBase}/v1`,PTR_SELFHOSTED_MODEL:'m'});
    const fromFile=upstreamFromEnvironment({...env,PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_GATEWAY_UPSTREAMS_FILE:file,PTR_SELFHOSTED_MODEL:'m'});
    expect(fromFile.upstream).toBeInstanceOf(UpstreamPool);
    await fromFile.upstream.ready?.(AbortSignal.timeout(1000));
    const a=await gateway(envOnly.upstream),b=await gateway(fromFile.upstream);
    const [x,y]=[await post(a.base),await post(b.base)];
    // The fake secondary stamps `created` in seconds: the only byte that may differ between two calls.
    const bytes=async(response:Response)=>Buffer.from(Buffer.from(await response.arrayBuffer()).toString('latin1').replace(/"created":\d+/g,'"created":0'),'latin1').toString('base64');
    const result={same:{...relevant(x),body:await bytes(x)},other:{...relevant(y),body:await bytes(y)}};
    await fromFile.close?.();
    return result;
  }
  test('a healthy engine: same status, headers and bytes',async()=>{
    const up=instantEngine('주 엔진');const engineBase=await listen(up.server);
    const {same,other}=await compare({},engineBase);
    // X-PTR-Upstream is always sent : `primary` from both.
    expect(other).toEqual(same);expect(same.upstream).toBe('primary');
  });
  test('a refused engine: the same 502 UPSTREAM_UNAVAILABLE',async()=>{
    const {same,other}=await compare({},await closedPort());
    expect(other).toEqual(same);expect(Buffer.from(same.body,'base64').toString()).toBe('{"error":{"code":"UPSTREAM_UNAVAILABLE"}}');
  });
  test('with the fake failover secondary: the same secondary answer and X-PTR-Upstream marker',async()=>{
    const {same,other}=await compare({PTR_GATEWAY_FAILOVER:'fake'},await closedPort());
    // The fake secondary names itself `fake`, not `secondary` (fake answers are never recorded as real).
    expect(other).toEqual(same);expect(same.upstream).toBe('fake');
  });
  test('without a breaker alternative a single upstream is still tried (recovers at once, like the plain upstream)',async()=>{
    // A freed ephemeral port, not closedPort(): the engine comes back on this same port below, and port 2 cannot be bound.
    const probe=createServer();const closed=await listen(probe);servers.splice(servers.indexOf(probe),1);await new Promise(r=>probe.close(r));
    const port=Number(new URL(closed).port);
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',closed)]),failover:{failureThreshold:1}});
    const {base}=await gateway(pool);
    for(let i=0;i<3;i++) expect((await post(base)).status).toBe(502);
    expect(member(pool,'a')!.breaker).toBe('open');
    const back=instantEngine('복구');servers.push(back.server);await new Promise<void>(r=>back.server.listen(port,'127.0.0.1',r));
    const ok=await post(base);expect(ok.status).toBe(200);expect(await ok.text()).toBe(sse('복구'));
    expect(member(pool,'a')!.breaker).toBe('closed');
  });
});

describe('upstream pool: dynamic membership',()=>{
  test('least in-flight pick, each upstream capped at its maxSeqs; the excess waits and runs as a slot frees',async()=>{
    const a=heldEngine('A'),b=heldEngine('B');
    const source=new TestSource([rec('a',await listen(a.server),{maxSeqs:2}),rec('b',await listen(b.server),{maxSeqs:2})]);
    const pool=new UpstreamPool({model:'m',source});const {base}=await gateway(pool);
    const requests=Array.from({length:5},()=>post(base));
    await until(()=>a.held()+b.held()===4&&pool.poolMetrics().waiting===1);
    expect([a.held(),b.held()]).toEqual([2,2]);
    expect(member(pool,'a')).toMatchObject({inFlight:2,limit:2});
    a.release();await until(()=>a.held()===2&&pool.poolMetrics().waiting===0);
    for(let i=0;i<2;i++){a.release();b.release();}
    const responses=await Promise.all(requests);
    expect(responses.map(r=>r.status)).toEqual([200,200,200,200,200]);
    await Promise.all(responses.map(r=>r.text()));
    await until(()=>member(pool,'a')!.inFlight===0&&member(pool,'b')!.inFlight===0);
    expect(member(pool,'a')!.dispatched+member(pool,'b')!.dispatched).toBe(5);
  });
  test('waiting for a free upstream is bounded by the queue timeout: a marked 503 (nothing was sent)',async()=>{
    const a=heldEngine('A');
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',await listen(a.server),{maxSeqs:1})]),queueTimeoutMs:100});
    const {base,g}=await gateway(pool);
    const first=post(base);await until(()=>a.held()===1);
    const late=await post(base);
    expect(late.status).toBe(503);expect(late.headers.get('x-ptr-gateway')).toBe('rejected');
    expect(late.headers.get('x-ptr-gateway-reason')).toBe('queue_timeout');expect(await late.json()).toEqual({error:{code:'GATEWAY_QUEUE_TIMEOUT'}});
    expect(a.calls.completions).toBe(1);expect(g.metrics().rejected.queueTimeout).toBe(1);
    expect(pool.poolMetrics().queueTimeouts).toBe(1); // the share of queue timeouts spent waiting for an upstream slot
    a.release();expect((await first).status).toBe(200);
  });
  test('an empty pool waits for a member to appear (no secondary)',async()=>{
    const source=new TestSource([]);const pool=new UpstreamPool({model:'m',source,queueTimeoutMs:2000});
    const {base}=await gateway(pool);
    const pending=post(base);await until(()=>pool.poolMetrics().waiting===1);
    const up=instantEngine('새 서버');source.set([rec('a',await listen(up.server))]);
    const response=await pending;expect(response.status).toBe(200);expect(await response.text()).toBe(sse('새 서버'));
  });
  test('slow start: a member added later ramps max(1, floor(S·Δt/30 s)); members present at startup start at full capacity',()=>{
    let now=1000;const source=new TestSource([rec('a','http://127.0.0.1:18000')]);
    const pool=new UpstreamPool({model:'m',source,now:()=>now,slowStartMs:30000});
    expect(member(pool,'a')).toMatchObject({limit:12,slowStart:false});
    source.set([rec('a','http://127.0.0.1:18000'),rec('b','http://127.0.0.1:18001')]);
    expect(member(pool,'b')).toMatchObject({limit:1,slowStart:true});
    now+=15000;expect(member(pool,'b')).toMatchObject({limit:6,slowStart:true});
    now+=14999;expect(member(pool,'b')!.limit).toBe(11);
    now+=1;expect(member(pool,'b')).toMatchObject({limit:12,slowStart:false});
    expect(pool.poolMetrics().members).toMatchObject({active:2,ramping:0});
  });
  test('slow start limits dispatch: a newly added upstream gets one call at first, the rest go to the warm one',async()=>{
    const a=heldEngine('A'),b=heldEngine('B');const aBase=await listen(a.server),bBase=await listen(b.server);
    const source=new TestSource([rec('a',aBase)]);const pool=new UpstreamPool({model:'m',source});const {base}=await gateway(pool);
    source.set([rec('a',aBase),rec('b',bBase)]);
    const requests=Array.from({length:6},()=>post(base));
    await until(()=>a.held()+b.held()===6);
    expect([a.held(),b.held()]).toEqual([5,1]);
    for(let i=0;i<5;i++) a.release();b.release();
    await Promise.all((await Promise.all(requests)).map(r=>r.text()));
  });
  test('draining: no new calls to it, its in-flight call completes; once gone it leaves the metrics when idle',async()=>{
    const a=heldEngine('A'),b=heldEngine('B');const aBase=await listen(a.server),bBase=await listen(b.server);
    const source=new TestSource([rec('a',aBase),rec('b',bBase)]);const pool=new UpstreamPool({model:'m',source});const {base}=await gateway(pool);
    const first=post(base),second=post(base);await until(()=>a.held()===1&&b.held()===1);
    source.set([rec('a',aBase),rec('b',bBase,{state:'draining'})]);
    expect(member(pool,'b')).toMatchObject({state:'draining',inFlight:1});
    expect(pool.poolMetrics().members).toMatchObject({active:1,draining:1});
    const third=post(base);await until(()=>a.held()===2);expect(b.calls.completions).toBe(1);
    source.set([rec('a',aBase)]);
    expect(member(pool,'b')).toMatchObject({state:'gone',inFlight:1});
    b.release();a.release();a.release();
    expect((await Promise.all([first,second,third])).map(r=>r.status)).toEqual([200,200,200]);
    await until(()=>member(pool,'b')===undefined);
    expect(pool.poolMetrics().events).toMatchObject({removed:1});
  });
  test('a new epoch for the same id is a new upstream: the old one finishes its call, the new one starts cold',async()=>{
    let now=0;const a=heldEngine('A');const aBase=await listen(a.server);
    const source=new TestSource([rec('a',aBase)]);const pool=new UpstreamPool({model:'m',source,now:()=>now});const {base}=await gateway(pool);
    const first=post(base);await until(()=>a.held()===1);
    source.set([rec('a',aBase,{epoch:'e2'})]);
    const upstreams=pool.poolMetrics().upstreams;
    expect(upstreams.map(u=>[u.epoch,u.state,u.inFlight])).toEqual([['e2','active',0],['e1','gone',1]]);
    expect(member(pool,'a')).toMatchObject({epoch:'e2',slowStart:true,limit:1});
    a.release();expect((await first).status).toBe(200);
    await until(()=>pool.poolMetrics().upstreams.length===1);
    expect(pool.poolMetrics().events).toMatchObject({replaced:1});
  });
  test('a lowered maxSeqs applies to the next dispatch; in-flight calls are kept',async()=>{
    const a=heldEngine('A');const aBase=await listen(a.server);
    const source=new TestSource([rec('a',aBase,{maxSeqs:3})]);const pool=new UpstreamPool({model:'m',source,queueTimeoutMs:3000});const {base}=await gateway(pool);
    const calls=[post(base),post(base),post(base)];await until(()=>a.held()===3);
    source.set([rec('a',aBase,{maxSeqs:1})]);
    expect(member(pool,'a')).toMatchObject({inFlight:3,limit:1});
    const late=post(base);await until(()=>pool.poolMetrics().waiting===1);
    a.release();a.release();await new Promise(r=>setTimeout(r,50));expect(a.held()).toBe(1); // still 1 in flight ≥ limit
    a.release();await until(()=>a.held()===1&&pool.poolMetrics().waiting===0);a.release();
    expect((await Promise.all([...calls,late])).map(r=>r.status)).toEqual([200,200,200,200]);
  });
  test('the slot is released when the stream ends, and when the client disconnects mid-stream',async()=>{
    const chunk=`data: ${JSON.stringify({choices:[{delta:{content:'x'}}]})}\n\n`;
    const slow=createServer((req,res)=>{req.resume();req.on('end',()=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(chunk);});});
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',await listen(slow))])});const {base}=await gateway(pool);
    const controller=new AbortController();
    const response=await post(base,undefined,controller.signal);await response.body!.getReader().read();
    expect(member(pool,'a')!.inFlight).toBe(1);
    controller.abort();await until(()=>member(pool,'a')!.inFlight===0);
  });
});

describe('upstream pool: per-upstream breaker and retry on another primary',()=>{
  /** Scripted primary for one member: each call pops an outcome. */
  function scripted(name:string) {
    const outcomes:('ok'|'refused'|'closed')[]=[];const calls={complete:0,health:0};let healthy=true;
    const primary={model:'m',health:async()=>{calls.health++;return healthy;},
      complete:async():Promise<UpstreamResult>=>{calls.complete++;const next=outcomes.shift()??'ok';
        if(next==='refused') throw new UpstreamConnectError('connect_refused',true);
        if(next==='closed') throw new UpstreamConnectError('closed_before_response',false);
        return {status:200,contentType:'application/json',body:`{"from":"${name}"}`};}};
    return {primary,outcomes,calls,setHealthy:(value:boolean)=>{healthy=value;}};
  }
  const signal=()=>new AbortController().signal;
  function twoMembers(options:Partial<ConstructorParameters<typeof UpstreamPool>[0]>={}) {
    const a=scripted('a'),b=scripted('b');const byId:Record<string,ReturnType<typeof scripted>>={a,b};
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a','http://127.0.0.1:18000'),rec('b','http://127.0.0.1:18001')]),
      create:record=>byId[record.id]!.primary,failover:{failureThreshold:2,cooldownMs:30000},...options});
    return {pool,a,b};
  }
  test('a refused connection is retried on another primary (nothing was sent); the breaker counts per upstream',async()=>{
    const {pool,a,b}=twoMembers();
    a.outcomes.push('refused','refused');b.outcomes.push('ok','ok');
    // Least in-flight with equal load alternates; force both calls to start on a by making a the first pick.
    const results:string[]=[];
    for(let i=0;i<4;i++) results.push(String((await pool.complete({messages},signal())).body));
    expect(results.every(body=>body.includes('"from"'))).toBe(true);
    expect(member(pool,'a')!.breaker).toBe('open');expect(member(pool,'b')!.breaker).toBe('closed');
    expect(pool.poolMetrics().retriedOnOtherPrimary).toBe(2);
    const before=a.calls.complete;
    for(let i=0;i<3;i++) expect(String((await pool.complete({messages},signal())).body)).toContain('"b"');
    expect(a.calls.complete).toBe(before); // skipped while open
    expect(pool.poolMetrics().members.breakerOpen).toBe(1);
  });
  test('closed before response moves to another primary only when failOverOnClose is on; at most primaryAttempts upstreams per request',async()=>{
    const off=twoMembers({failover:{failOverOnClose:false,failureThreshold:5}});
    off.a.outcomes.push('closed');off.b.outcomes.push('closed');
    await expect(off.pool.complete({messages},signal())).rejects.toMatchObject({reason:'closed_before_response'});
    expect(off.a.calls.complete+off.b.calls.complete).toBe(1);
    const on=twoMembers({primaryAttempts:2,failover:{failureThreshold:5}});
    on.a.outcomes.push('refused');on.b.outcomes.push('refused');
    await expect(on.pool.complete({messages},signal())).rejects.toMatchObject({reason:'connect_refused'});
    expect(on.a.calls.complete+on.b.calls.complete).toBe(2);
  });
  test('the secondary is used only when every primary is unavailable (breaker open, or none registered)',async()=>{
    const secondaryCalls={n:0};
    const secondary=new TextProviderUpstream({generate:async()=>{secondaryCalls.n++;return '보조';}},'secondary/model');
    const {pool,a,b}=twoMembers({secondary,failover:{failureThreshold:1,cooldownMs:30000}});
    a.outcomes.push('refused');b.outcomes.push('refused');a.setHealthy(false);b.setHealthy(false);
    expect((await pool.complete({messages},signal())).upstream).toBe('secondary'); // a refused → b refused → secondary
    expect((await pool.complete({messages},signal())).upstream).toBe('secondary'); // both open
    expect(pool.failoverMetrics!()).toMatchObject({failovers:{connect_refused:1,breaker_open:1},breaker:{state:'open'}});
    const empty=new UpstreamPool({model:'m',source:new TestSource([]),secondary});
    expect((await empty.complete({messages},signal())).upstream).toBe('secondary');
    expect(empty.failoverMetrics!().failovers).toEqual({no_upstream:1});
    expect(secondaryCalls.n).toBe(3);
  });
  test('a waiting request is served as soon as another upstream\'s breaker closes (not only when a slot frees)',async()=>{
    let releaseA:(()=>void)|undefined;
    const a={model:'m',health:async()=>true,complete:()=>new Promise<UpstreamResult>(resolve=>{releaseA=()=>resolve({status:200,contentType:'application/json',body:'{"from":"a"}'});})};
    let bRefuses=true;
    const b={model:'m',health:async()=>true,complete:async():Promise<UpstreamResult>=>{
      if(bRefuses){bRefuses=false;throw new UpstreamConnectError('connect_refused',true);}return {status:200,contentType:'application/json',body:'{"from":"b"}'};}};
    const byId:Record<string,typeof a>={a,b};
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a','http://127.0.0.1:18000',{maxSeqs:1}),rec('b','http://127.0.0.1:18001',{maxSeqs:1})]),
      create:record=>byId[record.id]!,failover:{failureThreshold:1,cooldownMs:300},queueTimeoutMs:3000,primaryAttempts:1});
    // First call: tie → a (held). Second: b refuses → b's breaker opens; the error surfaces (one attempt).
    const first=pool.complete({messages},signal());
    await expect(pool.complete({messages},signal())).rejects.toBeInstanceOf(UpstreamConnectError);
    expect(member(pool,'b')!.breaker).toBe('open');
    const started=Date.now();
    const waiting=await pool.complete({messages},signal()); // a is full, b open: waits until b's probe closes it
    expect(String(waiting.body)).toContain('"b"');expect(Date.now()-started).toBeLessThan(1500);
    releaseA!();await first;
  });
  test('after a failed connect, no free upstream left is not a "nothing was sent" rejection: the connect error surfaces',async()=>{
    let releaseB:(()=>void)|undefined;
    const a={model:'m',health:async()=>true,complete:async():Promise<UpstreamResult>=>{throw new UpstreamConnectError('closed_before_response',false);}};
    const b={model:'m',health:async()=>true,complete:()=>new Promise<UpstreamResult>(resolve=>{releaseB=()=>resolve({status:200,contentType:'application/json',body:'{}'});})};
    const byId:Record<string,typeof a>={a,b};
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a','http://127.0.0.1:18000',{maxSeqs:4}),rec('b','http://127.0.0.1:18001',{maxSeqs:1})]),
      create:record=>byId[record.id]!,failover:{failureThreshold:5},queueTimeoutMs:200});
    const held=pool.complete({messages},signal());await until(()=>member(pool,'b')!.inFlight===1||member(pool,'a')!.connectFailures>0);
    // b is full now (or the first call already moved there); the next request fails on a and cannot get b in time.
    await until(()=>member(pool,'b')!.inFlight===1);
    await expect(pool.complete({messages},signal())).rejects.toMatchObject({reason:'closed_before_response'});
    releaseB!();await held;
  });
  test('half-open upstreams are probed in parallel: a hung probe does not hold the request while another one is healthy',async()=>{
    const answer=(name:string)=>async():Promise<UpstreamResult>=>({status:200,contentType:'application/json',body:`{"from":"${name}"}`});
    const refusedOnce=(name:string)=>{let first=true;return async():Promise<UpstreamResult>=>{if(first){first=false;throw new UpstreamConnectError('connect_refused',true);}return answer(name)();};};
    const a={model:'m',health:()=>new Promise<boolean>(()=>{}),complete:refusedOnce('a')};
    const b={model:'m',health:async()=>{await new Promise(r=>setTimeout(r,50));return true;},complete:refusedOnce('b')};
    const byId:Record<string,typeof a>={a,b};
    const secondary=new TextProviderUpstream({generate:async()=>'보조'},'secondary/model');
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a','http://127.0.0.1:18000'),rec('b','http://127.0.0.1:18001')]),
      create:record=>byId[record.id]!,secondary,failover:{failureThreshold:1,cooldownMs:100,probeTimeoutMs:2000}});
    expect((await pool.complete({messages},signal())).upstream).toBe('secondary'); // both refused → both open
    await new Promise(r=>setTimeout(r,120)); // both half-open now
    const started=Date.now();
    const result=await pool.complete({messages},signal());
    expect(String(result.body)).toContain('"b"');expect(Date.now()-started).toBeLessThan(1000);
  });
  test('a pool without a secondary has no failover metrics; the answering upstream is still marked primary (D21)',async()=>{
    const {pool}=twoMembers();
    expect(pool.failoverMetrics).toBeUndefined();
    expect((await pool.complete({messages},signal())).upstream).toBe('primary');
  });
});
