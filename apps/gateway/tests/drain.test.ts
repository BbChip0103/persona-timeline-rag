import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { UpstreamRecord } from '@ptr/messaging/registry';
import type { TextProvider } from '@ptr/core';
import { OpenAICompatibleTextProvider } from '@ptr/providers';
import { createGateway, TextProviderUpstream, UpstreamConnectError, UpstreamPool, type GatewayOptions, type UpstreamSource } from '../src';
import { gatewayRegistrySettings } from '../src/main';

const token='synthetic_gateway_token_abcdefghij';
const servers:Server[]=[];
afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}));});
async function listen(server:Server):Promise<string> {servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
const until=async(check:()=>boolean,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not met');};
const post=(base:string,user='x')=>fetch(`${base}/v1/chat/completions`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
  body:JSON.stringify({messages:[{role:'system',content:'P'.repeat(390)},{role:'user',content:user}],stream:true})});
/** Text provider whose calls are held until released. */
function held() {
  const waiting:(()=>void)[]=[];let calls=0;
  const provider:TextProvider={generate:async(_m,{signal})=>{calls++;await new Promise<void>((resolve,reject)=>{waiting.push(resolve);
    signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});return 'held reply';}};
  return {provider,release:()=>{for(const w of waiting.splice(0)) w();},held:()=>waiting.length,calls:()=>calls};
}
async function gateway(upstream:GatewayOptions['upstream'],limits:Partial<GatewayOptions['limits']>={}) {
  const g=createGateway({token,upstream,limits:{maxConcurrent:2,maxQueue:8,queueTimeoutMs:5000,upstreamTimeoutMs:10000,...limits}});
  return {g,base:await listen(g.server)};
}
const sse=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\ndata: [DONE]\n\n`;
function heldEngine() {
  const pending:ServerResponse[]=[];let calls=0;
  const server=createServer((req,res)=>{let raw='';req.on('data',c=>raw+=c);req.on('end',()=>{
    if(req.url==='/health'){res.writeHead(200);res.end();return;}calls++;pending.push(res);});});
  return {server,held:()=>pending.length,calls:()=>calls,release:()=>{for(const res of pending.splice(0)){res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(sse('ok'));}}};
}
class TestSource implements UpstreamSource {
  constructor(private readonly records:UpstreamRecord[]) {}
  snapshot() {return this.records;}
  onChange() {return ()=>undefined;}
}

describe('graceful drain ',()=>{
  test('limiter gateway: /healthz 503, queued and new requests get the marked 503 draining at once (never sent upstream), in-flight calls finish',async()=>{
    const h=held();const {g,base}=await gateway(new TextProviderUpstream(h.provider,'fake'),{maxConcurrent:2});
    const running=[post(base),post(base)];await until(()=>h.held()===2);
    const queued=[post(base),post(base),post(base)];await until(()=>g.metrics().queued===3);
    g.drain();
    for(const response of await Promise.all(queued)) {
      expect(response.status).toBe(503);
      expect(response.headers.get('x-ptr-gateway')).toBe('rejected');expect(response.headers.get('x-ptr-gateway-reason')).toBe('draining');
      expect(response.headers.get('retry-after')).toBe('1');expect(response.headers.get('connection')).toBe('close');
      expect(await response.json()).toEqual({error:{code:'GATEWAY_DRAINING'}});
    }
    const late=await post(base);
    expect(late.status).toBe(503);expect(late.headers.get('x-ptr-gateway-reason')).toBe('draining');
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
    expect(h.calls()).toBe(2);
    let idle=false;void g.idle().then(()=>{idle=true;});
    await new Promise(r=>setTimeout(r,50));expect(idle).toBe(false);
    h.release();
    expect((await Promise.all(running)).map(r=>r.status)).toEqual([200,200]);
    await until(()=>idle);
    expect(g.metrics()).toMatchObject({draining:true,rejected:{draining:4}});
  });
  test('pool gateway: the pool queue is emptied with the draining rejection; in-flight streams finish; idle() resolves after them',async()=>{
    const e=heldEngine();
    const pool=new UpstreamPool({model:'m',source:new TestSource([{pool:'m',id:'a',baseUrl:`${await listen(e.server)}/v1`,maxSeqs:2,kvCapacityTokens:null,weight:1,state:'active',epoch:'e',seq:0}]),admission:true});
    const {g,base}=await gateway(pool);
    const running=[post(base,'a'),post(base,'b')];await until(()=>e.held()===2);
    const queued=[post(base,'c'),post(base,'d')];await until(()=>pool.poolMetrics().waiting===2);
    g.drain();
    for(const response of await Promise.all(queued)) {expect(response.status).toBe(503);expect(response.headers.get('x-ptr-gateway-reason')).toBe('draining');}
    expect(pool.poolMetrics().queue.rejected).toMatchObject({draining:2});
    expect((await post(base,'e')).status).toBe(503);
    expect(e.calls()).toBe(2);
    e.release();
    for(const response of await Promise.all(running)) {expect(response.status).toBe(200);await response.text();}
    await g.idle();
    await pool.close();
  });
  test('a retry on another primary that is queued when the drain starts is neither marked nor failed: it waits for credit and is served',async()=>{
    // a refuses every connection; b serves one call at a time and holds it until released.
    const gates:(()=>void)[]=[];let bCalls=0;
    const refusing={model:'m',health:async()=>true,complete:async():Promise<never>=>{throw new UpstreamConnectError('connect_refused',true);}};
    const holding={model:'m',health:async()=>true,complete:async()=>{bCalls++;await new Promise<void>(resolve=>gates.push(resolve));
      return {status:200,contentType:'text/event-stream',body:sse('ok')};}};
    const rec=(id:string,maxSeqs:number):UpstreamRecord=>({pool:'m',id,baseUrl:`http://127.0.0.1:${id==='a'?18000:18001}/v1`,maxSeqs,kvCapacityTokens:null,weight:1,state:'active',epoch:'e',seq:0});
    const pool=new UpstreamPool({model:'m',source:new TestSource([rec('a',12),rec('b',1)]),create:record=>record.id==='a'?refusing:holding,admission:true,
      failover:{failureThreshold:100}});
    const call=()=>pool.complete({messages:[{role:'user',content:'x'}]},new AbortController().signal);
    const first=call();await until(()=>gates.length===1); // on b (directly, or after a refused it)
    const second=call().catch((error:unknown)=>error); // settled either way, so a wrong rejection fails the assertion below
    await until(()=>pool.poolMetrics().waiting===1); // a refused it: a retry waiting for b
    pool.drain();
    await expect(call()).rejects.toMatchObject({code:'GATEWAY_DRAINING'}); // a new request is refused
    expect(pool.poolMetrics()).toMatchObject({waiting:1,queue:{rejected:{draining:1}}});
    gates.shift()!();expect((await first).status).toBe(200);
    await until(()=>gates.length===1);gates.shift()!();
    expect(await second).toMatchObject({status:200});
    expect(bCalls).toBe(2);
    await pool.close();
  });
  test('a worker client with two gateways moves the drained gateway\'s queued calls to the standby at once: 0 failed',async()=>{
    const first=held(), second=held();
    const a=await gateway(new TextProviderUpstream(first.provider,'fake'),{maxConcurrent:1});
    const b=await gateway(new TextProviderUpstream(second.provider,'fake'),{maxConcurrent:8});
    const client=new OpenAICompatibleTextProvider({baseUrl:[`${a.base}/v1`,`${b.base}/v1`],model:'gateway',apiKey:token,resetRetries:2,retryMinRemainingMs:0});
    const calls=Array.from({length:4},(_,i)=>client.generate([{role:'user',content:`q${i}`}],{signal:new AbortController().signal,requestKey:`turn-${i}`}));
    await until(()=>first.held()===1&&a.g.metrics().queued===3);
    const started=Date.now();
    a.g.drain();
    await until(()=>second.held()===3);
    expect(Date.now()-started).toBeLessThan(500); // no backoff: the draining rejection sends them to the next URL
    first.release();second.release();
    expect(await Promise.all(calls)).toEqual(['held reply','held reply','held reply','held reply']);
  });
  test('drain is idempotent; a gateway that is not draining reports draining:false and healthz 200',async()=>{
    const {g,base}=await gateway(new TextProviderUpstream({generate:async()=>'ok'},'fake'));
    expect(g.metrics().draining).toBe(false);expect((await fetch(`${base}/healthz`)).status).toBe(200);
    g.drain();g.drain();
    await g.idle();
    expect((await fetch(`${base}/healthz`)).status).toBe(503);
  });
});

describe('gateway registry settings and per-replica limits ( amendment)',()=>{
  test('PTR_GATEWAY_REGISTRY defaults to on with PTR_GATEWAY_DISCOVERY=redis; id, advertised URL and allowlist are validated',()=>{
    expect(gatewayRegistrySettings({},56460)).toBeNull();
    const on=gatewayRegistrySettings({PTR_GATEWAY_DISCOVERY:'redis',PTR_GATEWAY_MAX_QUEUE:'64'},56461,1234)!;
    expect(on).toMatchObject({url:'http://127.0.0.1:56461/v1',maxQueue:64,startedAt:1234,prefix:'ptr:llm'});
    expect(on.id).toMatch(/^gw-56461-[0-9a-f]{8}$/);
    expect(gatewayRegistrySettings({PTR_GATEWAY_REGISTRY:'on',PTR_GATEWAY_ID:'gw-a',PTR_GATEWAY_ALLOW:'127.0.0.1:56501-56502',PTR_REGISTRY_PREFIX:'ptrtest:x:llm'},56501))
      .toMatchObject({id:'gw-a',url:'http://127.0.0.1:56501/v1',prefix:'ptrtest:x:llm'});
    expect(gatewayRegistrySettings({PTR_GATEWAY_REGISTRY:'off',PTR_GATEWAY_DISCOVERY:'redis'},56460)).toBeNull();
    for(const [env,code] of [[{PTR_GATEWAY_REGISTRY:'yes'},'INVALID_PTR_GATEWAY_REGISTRY'],[{PTR_GATEWAY_REGISTRY:'on',PTR_GATEWAY_ID:'leader'},'INVALID_PTR_GATEWAY_ID'],
      [{PTR_GATEWAY_REGISTRY:'on'},'INVALID_PTR_GATEWAY_ADVERTISE_URL'],[{PTR_GATEWAY_REGISTRY:'on',PTR_GATEWAY_ALLOW:'x'},'INVALID_PTR_GATEWAY_ALLOW'],
      [{PTR_GATEWAY_REGISTRY:'on',PTR_GATEWAY_ADVERTISE_URL:'http://127.0.0.1:56460/v1?x'},'INVALID_PTR_GATEWAY_ADVERTISE_URL']] as const)
      expect(()=>gatewayRegistrySettings(env,56470)).toThrow(code);
  });
  test('k active gateways split the failover per-minute ceiling: floor(max / k), at least 1',async()=>{
    let k=2;let secondaryCalls=0;
    const dead={model:'m',health:async()=>false,complete:async():Promise<never>=>{throw new UpstreamConnectError('connect_refused',true);}};
    const pool=new UpstreamPool({model:'m',source:new TestSource([{pool:'m',id:'a',baseUrl:'http://127.0.0.1:18000/v1',maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active',epoch:'e',seq:0}]),
      create:()=>dead,secondary:new TextProviderUpstream({generate:async()=>{secondaryCalls++;return 'secondary';}},'fake-secondary'),
      failover:{maxPerMinute:5},replicas:()=>k});
    const call=()=>pool.complete({messages:[{role:'user',content:'x'}]},new AbortController().signal);
    for(let i=0;i<2;i++) expect((await call()).upstream).toBe('secondary');
    await expect(call()).rejects.toThrow('FAILOVER_RATE_LIMITED');
    expect(pool.failoverMetrics!()).toMatchObject({perMinuteCap:2,rateLimited:1});
    k=1;
    expect((await call()).upstream).toBe('secondary');
    expect(pool.failoverMetrics!().perMinuteCap).toBe(5);
    k=100;expect(pool.failoverMetrics!().perMinuteCap).toBe(1);
    k=Infinity;expect(pool.failoverMetrics!().perMinuteCap).toBe(1); // k unknown (no registry read yet): the most conservative ceiling
    expect(secondaryCalls).toBe(3);
    await pool.close();
  });
});
