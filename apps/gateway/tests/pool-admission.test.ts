import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UpstreamRecord } from '@ptr/messaging/registry';
import { createGateway, UpstreamPool, type GatewayOptions, type UpstreamSource } from '../src';
import { upstreamFromEnvironment } from '../src/main';

const token='synthetic_gateway_token_abcdefghij';
const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}));});
async function listen(server:Server):Promise<string> {servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
const sse=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\ndata: [DONE]\n\n`;
/** Engine that holds completions until released; records the user message of each call in arrival order. */
function heldEngine() {
  const pending:{res:ServerResponse;user:string}[]=[];const order:string[]=[];
  const server=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    if(req.url==='/health'){res.writeHead(200);res.end();return;}
    const body=JSON.parse(raw) as {messages:{content:string}[]};const user=body.messages.at(-1)!.content;order.push(user);pending.push({res,user});
  });});
  const release=()=>{const next=pending.shift();if(next){next.res.writeHead(200,{'Content-Type':'text/event-stream'});next.res.end(sse(next.user));}};
  return {server,order,release,held:()=>pending.length};
}
class TestSource implements UpstreamSource {
  constructor(private readonly records:UpstreamRecord[]) {}
  snapshot() {return this.records;}
  onChange() {return ()=>undefined;}
}
const rec=(id:string,base:string,extra:Partial<UpstreamRecord>={}):UpstreamRecord=>({pool:'m',id,baseUrl:`${base}/v1`,maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active',epoch:'e1',seq:0,...extra});
async function gateway(pool:UpstreamPool,limits:Partial<GatewayOptions['limits']>={}) {
  const g=createGateway({token,upstream:pool,limits:{maxConcurrent:64,maxQueue:64,queueTimeoutMs:3000,upstreamTimeoutMs:10000,...limits}});
  return {g,base:await listen(g.server)};
}
const post=(base:string,user:string,headers:Record<string,string>={},extra:Record<string,unknown>={})=>fetch(`${base}/v1/chat/completions`,{method:'POST',
  headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:JSON.stringify({messages:[{role:'system',content:'P'.repeat(390)},{role:'user',content:user}],stream:true,...extra})});
const until=async(check:()=>boolean,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not met');};
const member=(pool:UpstreamPool,id:string)=>pool.poolMetrics().upstreams.find(u=>u.id===id)!;

describe('central queue in the gateway (S3)',()=>{
  test('X-PTR-Priority 1 (a running turn\'s follow-up) is dispatched before earlier band-0 requests',async()=>{
    const e=heldEngine();const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',await listen(e.server),{maxSeqs:1})]),admission:true});
    const {base}=await gateway(pool);
    const first=post(base,'first');await until(()=>e.held()===1);
    const zero=post(base,'band0');await until(()=>pool.poolMetrics().queue.queued['0']===1);
    const one=post(base,'band1',{'X-PTR-Priority':'1'});await until(()=>pool.poolMetrics().queue.queued['1']===1);
    e.release();await until(()=>e.held()===1&&e.order.length===2);e.release();await until(()=>e.order.length===3);e.release();
    await Promise.all([first,zero,one].map(async r=>(await r).text()));
    expect(e.order).toEqual(['first','band1','band0']);
  });
  test('invalid priority or flow headers are refused (400)',async()=>{
    const e=heldEngine();const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',await listen(e.server))]),admission:true});
    const {base}=await gateway(pool);
    expect((await post(base,'x',{'X-PTR-Priority':'2'})).status).toBe(400);
    expect((await post(base,'x',{'X-PTR-Flow':'not hex!'})).status).toBe(400);
  });
  test('KV credit: a second request waits while the first holds the upstream\'s KV budget, then runs',async()=>{
    const e=heldEngine();
    // ~100 + 512 reserved per request; κ·K − G = 0.9·1000 − 100 = 800: one fits, two do not.
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',await listen(e.server),{kvCapacityTokens:1000})]),admission:true});
    const {base}=await gateway(pool);
    const a=post(base,'a');await until(()=>e.held()===1);
    const b=post(base,'b');await until(()=>pool.poolMetrics().queue.queued['0']===1);
    expect(member(pool,'a')).toMatchObject({inFlight:1,reservedKvTokens:expect.any(Number)});
    e.release();await until(()=>e.held()===1);e.release();
    expect((await Promise.all([a,b])).map(r=>r.status)).toEqual([200,200]);
  });
  test('the gateway admission limiter is bypassed: the pool\'s credits bound concurrency, not PTR_GATEWAY_MAX_CONCURRENCY',async()=>{
    const e1=heldEngine(),e2=heldEngine();
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',await listen(e1.server),{maxSeqs:2}),rec('b',await listen(e2.server),{maxSeqs:2})]),admission:true});
    const {base,g}=await gateway(pool,{maxConcurrent:1,maxQueue:0});
    const calls=['1','2','3','4'].map(user=>post(base,user));
    await until(()=>e1.held()+e2.held()===4);
    expect(g.metrics().capacity).toEqual({maxConcurrent:4,maxQueue:256,total:260}); // Σ maxSeqs + the pool's queue bound
    for(let i=0;i<2;i++){e1.release();e2.release();}
    await Promise.all(calls.map(async r=>(await r).text()));
  });
  test('a full queue is a marked 429 queue_full whose Retry-After comes from the queued tokens',async()=>{
    const e=heldEngine();const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',await listen(e.server),{maxSeqs:1})]),admission:true,maxQueue:1});
    const {base,g}=await gateway(pool);
    const a=post(base,'a');await until(()=>e.held()===1);
    const b=post(base,'b');await until(()=>pool.poolMetrics().queue.queued['0']===1);
    const full=await post(base,'c');
    expect(full.status).toBe(429);expect(full.headers.get('x-ptr-gateway')).toBe('rejected');
    expect(full.headers.get('x-ptr-gateway-reason')).toBe('queue_full');expect(full.headers.get('retry-after')).toBe('1'); // no rate yet
    expect(g.metrics().rejected.queueFull).toBe(1);expect(pool.poolMetrics().queue.rejected.queue_full).toBe(1);
    e.release();await until(()=>e.held()===1);e.release();await Promise.all([a,b]);
  });
  test('PTR_GATEWAY_MAX_QUEUE=0 still runs a request that has credit (no waiting allowed, as the old limiter)',async()=>{
    const e=heldEngine();const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',await listen(e.server),{maxSeqs:1})]),admission:true,maxQueue:0});
    const {base}=await gateway(pool);
    const a=post(base,'a');await until(()=>e.held()===1);
    const b=await post(base,'b');expect(b.status).toBe(429);
    e.release();expect((await a).status).toBe(200);
  });
  test('a full queue makes room for a higher band: the newest lowest-band request is refused instead',async()=>{
    const e=heldEngine();const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',await listen(e.server),{maxSeqs:1})]),admission:true,maxQueue:1});
    const {base}=await gateway(pool);
    const a=post(base,'a');await until(()=>e.held()===1);
    const batch=post(base,'batch',{'X-PTR-Priority':'-1'});await until(()=>pool.poolMetrics().queue.queued['-1']===1);
    const followUp=post(base,'follow-up',{'X-PTR-Priority':'1'});
    const refused=await batch;
    expect(refused.status).toBe(429);expect(refused.headers.get('x-ptr-gateway-reason')).toBe('queue_full');
    e.release();await until(()=>e.held()===1);e.release();
    expect((await followUp).status).toBe(200);await a;
    expect(e.order).toEqual(['a','follow-up']);
  });
  test('G is the most common policy block: a first request with another system message does not set it for good',async()=>{
    const e=heldEngine();const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',await listen(e.server))]),admission:true});
    const {base}=await gateway(pool);
    const probe=fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({messages:[{role:'system',content:'x'.repeat(39000)},{role:'user',content:'probe'}],stream:true})});
    await until(()=>e.held()===1);
    const calls=['1','2','3'].map(user=>post(base,user));await until(()=>e.held()===4);
    expect(pool.poolMetrics().queue.globalPrefixTokens).toBe(100); // 390 B / 3.9, the block three requests share
    for(let i=0;i<4;i++) e.release();await Promise.all([probe,...calls]);
  });
  test('G counts decay (half-life 256 requests): after a policy-prompt deploy the new block becomes G; a short run of odd requests does not',async()=>{
    const answer={model:'m',health:async()=>true,complete:async()=>({status:200,contentType:'application/json',body:'{}'})};
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a','http://127.0.0.1:18000',{maxSeqs:1000})]),create:()=>answer,admission:true});
    const send=(policyBytes:number)=>pool.complete({messages:[{role:'system',content:'P'.repeat(policyBytes)},{role:'user',content:'u'}]},new AbortController().signal);
    for(let i=0;i<1000;i++) await send(390);
    expect(pool.poolMetrics().queue.globalPrefixTokens).toBe(100);
    for(let i=0;i<100;i++) await send(780); // a batch with another system message: not the policy block
    expect(pool.poolMetrics().queue.globalPrefixTokens).toBe(100);
    let switched=0;
    for(let i=1;i<=400&&!switched;i++) {await send(780);if(pool.poolMetrics().queue.globalPrefixTokens===200) switched=i;}
    expect(switched).toBeGreaterThan(0);expect(switched).toBeLessThanOrEqual(300); // the old block's weight halves every 256
  });
  test('prefill tokens (U) are released at the first body chunk, the sequence and KV at the end',async()=>{
    let finish:(()=>void)|undefined;
    const engine=createServer((req,res)=>{req.resume();req.on('end',()=>{
      res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:'첫'}}]})}\n\n`);
      finish=()=>res.end('data: [DONE]\n\n');
    });});
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',await listen(engine))]),admission:true});
    const {base}=await gateway(pool);
    const response=await post(base,'x');const reader=response.body!.getReader();await reader.read();
    await until(()=>member(pool,'a').prefillTokens===0);
    expect(member(pool,'a')).toMatchObject({inFlight:1});expect(member(pool,'a').reservedKvTokens).toBeGreaterThan(0);
    finish!();while(!(await reader.read()).done);
    await until(()=>member(pool,'a').inFlight===0&&member(pool,'a').reservedKvTokens===0);
  });
  test('routing policy: scored prefers the upstream with more prefill capacity (weight); round_robin alternates',async()=>{
    const fast=heldEngine(),slow=heldEngine();const fastBase=await listen(fast.server),slowBase=await listen(slow.server);
    const records=[rec('fast',fastBase,{weight:1}),rec('slow',slowBase,{weight:0.25})];
    const scored=new UpstreamPool({model:'m',source:new TestSource(records),admission:true,routing:'scored'});
    const {base}=await gateway(scored);
    // Long prompts (~10k uncached tokens): the prefill term (U + uncached) / (weight × 10000) dominates the cost.
    const calls=['1','2','3'].map(user=>post(base,user+'u'.repeat(39000)));await until(()=>fast.held()+slow.held()===3);
    expect([fast.held(),slow.held()]).toEqual([3,0]);
    for(let i=0;i<3;i++) fast.release();await Promise.all(calls);
    const rr=new UpstreamPool({model:'m',source:new TestSource(records),admission:true,routing:'round_robin'});
    const second=await gateway(rr);
    const more=['1','2','3','4'].map(user=>post(second.base,user));await until(()=>fast.held()+slow.held()===4);
    expect([fast.held(),slow.held()]).toEqual([2,2]);
    for(let i=0;i<2;i++){fast.release();slow.release();}await Promise.all(more);
  });
});

describe('S3 configuration',()=>{
  const file=()=>{const f=join(mkdtempSync(join(tmpdir(),'ptr-up-')),'u.json');writeFileSync(f,JSON.stringify({pools:{m:{upstreams:[{id:'a',baseUrl:'http://127.0.0.1:18000/v1',prefillTokensPerSec:20000}]}}}));return f;};
  const base={PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_SELFHOSTED_MODEL:'m'};
  test('a pool from a file or the registry owns admission; knobs are validated',async()=>{
    const configured=upstreamFromEnvironment({...base,PTR_GATEWAY_UPSTREAMS_FILE:file(),PTR_GATEWAY_ROUTING:'round_robin'});
    const pool=configured.upstream as UpstreamPool;
    expect(pool.admits).toBe(true);
    expect(pool.poolMetrics().queue).toMatchObject({routing:'round_robin',fairness:'fifo'});
    expect(pool.poolMetrics().upstreams[0]).toMatchObject({prefillTokensPerSec:20000});
    await configured.close?.();
    for(const [name,value] of [['PTR_GATEWAY_ROUTING','random'],['PTR_GATEWAY_FAIRNESS','wfq'],['PTR_GATEWAY_KV_OVERCOMMIT','1.5'],['PTR_GATEWAY_BYTES_PER_TOKEN','0'],
      ['PTR_GATEWAY_LOOKAHEAD','0'],['PTR_GATEWAY_STARVATION_MS','-1'],['PTR_GATEWAY_TTFT_PENALTY_MS','0']] as const)
      expect(()=>upstreamFromEnvironment({...base,PTR_GATEWAY_UPSTREAMS_FILE:file(),[name]:value})).toThrow(`INVALID_${name}`);
  });
});
