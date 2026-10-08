import { createServer, type Server, type ServerResponse } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { TextProvider } from '@ptr/core';
import { OpenAICompatibleTextProvider, OpenRouterClient, ProviderError, type BudgetLedger, type BudgetRequest, type CallMetrics } from '@ptr/providers';
import { classifyTransportError, createGateway, FailoverUpstream, OpenAICompatibleUpstream, TextProviderUpstream, UpstreamConnectError, type FailoverOptions, type GatewayOptions, type Upstream, type UpstreamResult } from '../src';
import { ledgerReady, secondaryReady, upstreamFromEnvironment } from '../src/main';

const token='synthetic_gateway_token_abcdefghij';
const messages=[{role:'user',content:'안녕'}];
const servers:(Server|TcpServer)[]=[];
afterEach(async()=>{
  jest.useRealTimers();
  await Promise.all(servers.splice(0).map(server=>{(server as Server).closeAllConnections?.();return new Promise(resolve=>server.close(resolve));}));
});
async function listen(server:Server|TcpServer):Promise<string> {servers.push(server);await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;}
/** A loopback port nothing listens on: connecting is refused, so nothing is ever sent. */
async function closedPort():Promise<string> {
  const probe=createServer();const base=await listen(probe);servers.splice(servers.indexOf(probe),1);
  await new Promise(r=>probe.close(r));return base;
}
/** Accepts, reads the request, closes without a response byte (a dead engine behind an SSH tunnel looks like this). */
const closingServer=()=>createTcpServer(socket=>socket.once('data',()=>socket.destroy()));
const sse=(text:string)=>`data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\n\ndata: [DONE]\n\n`;
/** Fake OpenAI-compatible engine: `/health` answers `health` (or hangs); completions go to `handle`. */
function engine(handle:(res:ServerResponse)=>void,health:number|'hang'=200) {
  const calls={completions:0,health:0};
  const server=createServer((req,res)=>{req.resume();req.on('end',()=>{
    if(req.url==='/health'){calls.health++;if(health!=='hang'){res.writeHead(health);res.end();}return;}
    calls.completions++;handle(res);
  });});
  return {server,calls};
}
const healthy=(res:ServerResponse)=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(sse('주 엔진'));};
function countingSecondary(reply='보조 응답') {
  const calls={n:0};
  const provider:TextProvider={generate:async()=>{calls.n++;return reply;}};
  return {upstream:new TextProviderUpstream(provider,'secondary/model'),calls};
}
async function gateway(upstream:Upstream,limits:Partial<GatewayOptions['limits']>={}) {
  const g=createGateway({token,upstream,limits:{maxConcurrent:2,maxQueue:2,queueTimeoutMs:2000,upstreamTimeoutMs:5000,...limits}});
  return {g,base:await listen(g.server)};
}
const post=(base:string,body:unknown=({messages,stream:true}),headers:Record<string,string>={},signal?:AbortSignal)=>fetch(`${base}/v1/chat/completions`,
  {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:JSON.stringify(body),signal});
const primaryAt=(base:string)=>new OpenAICompatibleUpstream({baseUrl:`${base}/v1`,model:'gemma-4-e4b-fp8'});
const until=async(check:()=>boolean,ms=2000)=>{const end=Date.now()+ms;while(Date.now()<end){if(check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not met');};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

describe('primary transport failure classification',()=>{
  const failure=(cause:Record<string,string>)=>Object.assign(new TypeError('fetch failed'),{cause});
  test.each([
    [{code:'ECONNREFUSED',syscall:'connect'},'connect_refused',true],
    [{code:'UND_ERR_CONNECT_TIMEOUT'},'connect_timeout',true],
    [{code:'ECONNRESET',syscall:'connect'},'connect_error',true],
    [{code:'EHOSTUNREACH',syscall:'connect'},'connect_error',true],
    [{code:'ENOTFOUND',syscall:'getaddrinfo'},'dns',true],
    [{code:'UND_ERR_SOCKET'},'closed_before_response',false],
    [{code:'ECONNRESET',syscall:'read'},'closed_before_response',false],
    [{code:'EPIPE',syscall:'write'},'closed_before_response',false],
  ])('%j → %s (certain: %s)',(cause,reason,certain)=>{
    expect(classifyTransportError(failure(cause))).toMatchObject({reason,certain});
  });
  test('undici headers/body timeouts may follow a fully sent request: a TimeoutError, never a connect failure',async()=>{
    expect(classifyTransportError(failure({code:'UND_ERR_HEADERS_TIMEOUT'}))).toBeUndefined();
    expect(classifyTransportError(failure({code:'UND_ERR_BODY_TIMEOUT'}))).toBeUndefined();
    const spy=jest.spyOn(globalThis,'fetch').mockRejectedValueOnce(failure({code:'UND_ERR_HEADERS_TIMEOUT'}));
    try {await expect(primaryAt('http://127.0.0.1:18000').complete({messages},new AbortController().signal)).rejects.toMatchObject({name:'TimeoutError'});}
    finally {spy.mockRestore();}
  });
  test('aborts and timeouts are not transport failures (the request may be in the model)',()=>{
    expect(classifyTransportError(new DOMException('aborted','AbortError'))).toBeUndefined();
    expect(classifyTransportError(new DOMException('timeout','TimeoutError'))).toBeUndefined();
  });
  test('a refused primary throws a certain UpstreamConnectError; /health reports the engine state',async()=>{
    const closed=await closedPort();
    await expect(primaryAt(closed).complete({messages},new AbortController().signal)).rejects.toMatchObject({reason:'connect_refused',certain:true});
    expect(await primaryAt(closed).health(AbortSignal.timeout(1000))).toBe(false);
    const up=engine(healthy);expect(await primaryAt(await listen(up.server)).health(AbortSignal.timeout(1000))).toBe(true);
    const dead=engine(healthy,503);expect(await primaryAt(await listen(dead.server)).health(AbortSignal.timeout(1000))).toBe(false);
  });
});

describe('gateway failover by primary failure',()=>{
  test('connection refused (nothing sent) is served by the secondary and marked; the worker client reads it',async()=>{
    const secondary=countingSecondary();
    const {base,g}=await gateway(new FailoverUpstream(primaryAt(await closedPort()),secondary.upstream));
    const response=await post(base);
    expect(response.status).toBe(200);expect(response.headers.get('x-ptr-upstream')).toBe('secondary');
    expect(response.headers.get('x-ptr-gateway')).toBeNull();await response.body?.cancel();
    const client=new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token});
    expect(await client.generate([{role:'user',content:'안녕'}],{signal:new AbortController().signal})).toBe('보조 응답');
    expect(secondary.calls.n).toBe(2);
    expect(g.metrics().failover).toMatchObject({secondary:'secondary/model',failovers:{connect_refused:2},answered:{primary:0,secondary:2},closedNotFailedOver:0});
  });
  test('a healthy primary serves and is marked primary; the secondary is never called',async()=>{
    const secondary=countingSecondary();const up=engine(healthy);
    const {base}=await gateway(new FailoverUpstream(primaryAt(await listen(up.server)),secondary.upstream));
    const response=await post(base);
    expect(response.headers.get('x-ptr-upstream')).toBe('primary');expect(await response.text()).toBe(sse('주 엔진'));
    expect(secondary.calls.n).toBe(0);
  });
  test('closed before any response (self-hosted primary): failed over by default, a 502 when failOverOnClose is off',async()=>{
    const secondary=countingSecondary();const closing=await listen(closingServer());
    const on=await gateway(new FailoverUpstream(primaryAt(closing),secondary.upstream));
    const served=await post(on.base);
    expect(served.status).toBe(200);expect(served.headers.get('x-ptr-upstream')).toBe('secondary');await served.body?.cancel();
    expect(on.g.metrics().failover).toMatchObject({failovers:{closed_before_response:1},closedNotFailedOver:0});
    const off=await gateway(new FailoverUpstream(primaryAt(closing),secondary.upstream,{failOverOnClose:false}));
    const failed=await post(off.base);
    expect(failed.status).toBe(502);expect(await failed.json()).toEqual({error:{code:'UPSTREAM_UNAVAILABLE'}});
    expect(secondary.calls.n).toBe(1);expect(off.g.metrics().failover).toMatchObject({failovers:{},closedNotFailedOver:1});
  });
  test('a pooled keep-alive connection the engine closes on reuse is failed over, not surfaced',async()=>{
    const secondary=countingSecondary();const used=new WeakSet<Socket>();
    const reuse=createServer((req,res)=>{req.resume();req.on('end',()=>{
      if(used.has(req.socket)){req.socket.destroy();return;}
      used.add(req.socket);healthy(res);
    });});
    const {base}=await gateway(new FailoverUpstream(primaryAt(await listen(reuse)),secondary.upstream));
    const first=await post(base);expect(first.headers.get('x-ptr-upstream')).toBe('primary');await first.text();
    const second=await post(base);
    expect(second.status).toBe(200);expect(second.headers.get('x-ptr-upstream')).toBe('secondary');await second.text();
  });
  test('a 503 from the engine may follow processing (vLLM RetryableRequestError) or mean overload: 502, no failover',async()=>{
    const secondary=countingSecondary();
    const busy=engine(res=>{res.writeHead(503,{'Content-Type':'application/json'});res.end('{"error":"busy"}');});
    const {base}=await gateway(new FailoverUpstream(primaryAt(await listen(busy.server)),secondary.upstream));
    const response=await post(base);
    expect(response.status).toBe(502);expect(await response.json()).toEqual({error:{code:'UPSTREAM_HTTP_503'}});
    expect(response.headers.get('x-ptr-upstream')).toBe('primary');expect(secondary.calls.n).toBe(0);
  });
  test('a primary that accepts and then hangs times out (504); no failover',async()=>{
    const secondary=countingSecondary();const hang=engine(()=>undefined);
    const {base}=await gateway(new FailoverUpstream(primaryAt(await listen(hang.server)),secondary.upstream),{upstreamTimeoutMs:300});
    const response=await post(base);
    expect(response.status).toBe(504);expect(await response.json()).toEqual({error:{code:'UPSTREAM_TIMEOUT'}});
    expect(secondary.calls.n).toBe(0);
  });
  test('the optional headers timeout ends a hung primary early (504, no failover) and never cuts a slow stream once headers arrived',async()=>{
    const secondary=countingSecondary();const hang=engine(()=>undefined);
    const {base,g}=await gateway(new FailoverUpstream(primaryAt(await listen(hang.server)),secondary.upstream,{headersTimeoutMs:150}),{upstreamTimeoutMs:5000});
    const started=Date.now();const response=await post(base);
    expect(response.status).toBe(504);expect(Date.now()-started).toBeLessThan(2000);
    expect(secondary.calls.n).toBe(0);expect(g.metrics().failover!.breaker.consecutiveTimeouts).toBe(1);
    const slow=engine(res=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.flushHeaders();setTimeout(()=>res.end(sse('느린 스트림')),400);});
    const second=await gateway(new FailoverUpstream(primaryAt(await listen(slow.server)),secondary.upstream,{headersTimeoutMs:150}));
    const streamed=await post(second.base);expect(await streamed.text()).toBe(sse('느린 스트림'));
  });
  test('a stream cut mid-response is not failed over: the client sees a broken stream',async()=>{
    const secondary=countingSecondary();
    const cut=engine(res=>{res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({choices:[{delta:{content:'반쯤'}}]})}\n\n`);setTimeout(()=>res.destroy(),50);});
    const {base}=await gateway(new FailoverUpstream(primaryAt(await listen(cut.server)),secondary.upstream));
    const client=new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token});
    await expect(client.generate([{role:'user',content:'안녕'}],{signal:new AbortController().signal})).rejects.toBeInstanceOf(ProviderError);
    expect(secondary.calls.n).toBe(0);
  });
});

describe('circuit breaker',()=>{
  /** Scripted primary: each call pops the next outcome; `health` answers the probe (or hangs). */
  function scripted() {
    const outcomes:('ok'|'refused'|'closed'|'timeout')[]=[];let healthy:boolean|'hang'=false;const calls={complete:0,health:0};
    const primary={model:'primary',health:async()=>{calls.health++;if(healthy==='hang')return new Promise<boolean>(()=>{});return healthy;},
      complete:async():Promise<UpstreamResult>=>{calls.complete++;const next=outcomes.shift()??'ok';
        if(next==='refused') throw new UpstreamConnectError('connect_refused',true);
        if(next==='closed') throw new UpstreamConnectError('closed_before_response',false);
        if(next==='timeout') throw new DOMException('timeout','TimeoutError');
        return {status:200,contentType:'application/json',body:'{}'};}};
    return {primary,outcomes,calls,setHealthy:(value:boolean|'hang')=>{healthy=value;}};
  }
  const signal=()=>new AbortController().signal;
  const timedOut=()=>AbortSignal.abort(new DOMException('timeout','TimeoutError'));
  const flush=()=>new Promise(r=>setImmediate(r));
  const fake=()=>jest.useFakeTimers({now:0,doNotFake:['setImmediate']});
  const create=(p:ReturnType<typeof scripted>,secondary:ReturnType<typeof countingSecondary>,options:Partial<FailoverOptions>={})=>
    new FailoverUpstream(p.primary,secondary.upstream,{failureThreshold:3,cooldownMs:30000,probeTimeoutMs:2000,...options});
  test('opens after N consecutive failures, skips the primary while open, then probes /health half-open',async()=>{
    fake();
    const p=scripted();const secondary=countingSecondary();const failover=create(p,secondary);
    p.outcomes.push('refused','refused','refused');
    for(let i=0;i<3;i++) expect((await failover.complete({messages},signal())).upstream).toBe('secondary');
    expect(failover.failoverMetrics().breaker).toMatchObject({state:'open',consecutiveFailures:3,opened:1});
    expect((await failover.complete({messages},signal())).upstream).toBe('secondary');
    expect(p.calls.complete).toBe(3);expect(failover.failoverMetrics().failovers).toEqual({connect_refused:3,breaker_open:1});
    jest.setSystemTime(29999);
    await failover.complete({messages},signal());expect(p.calls.health).toBe(0);
    jest.setSystemTime(30000);expect(failover.failoverMetrics().breaker.state).toBe('half_open');
    // Probe fails: the request goes to the secondary (it never reached the primary) and the cooldown restarts.
    expect((await failover.complete({messages},signal())).upstream).toBe('secondary');
    expect(p.calls.health).toBe(1);expect(failover.failoverMetrics().breaker).toMatchObject({state:'open',probesFailed:1});
    jest.setSystemTime(59999);await failover.complete({messages},signal());expect(p.calls.health).toBe(1);
    jest.setSystemTime(60000);p.setHealthy(true);
    expect((await failover.complete({messages},signal())).upstream).toBe('primary');
    expect(failover.failoverMetrics().breaker).toMatchObject({state:'closed',consecutiveFailures:0,probesOk:1});
  });
  test('any primary answer resets the streak; closes count toward opening; the streak stops counting while open',async()=>{
    fake();
    const p=scripted();const secondary=countingSecondary();const failover=create(p,secondary);
    p.outcomes.push('refused','refused','ok','refused','refused');
    for(let i=0;i<5;i++) await failover.complete({messages},signal());
    expect(failover.failoverMetrics().breaker.state).toBe('closed');
    p.outcomes.push('closed');
    expect((await failover.complete({messages},signal())).upstream).toBe('secondary');
    expect(failover.failoverMetrics().breaker).toMatchObject({state:'open',consecutiveFailures:3});
    expect(failover.failoverMetrics().failovers).toEqual({connect_refused:4,closed_before_response:1});
  });
  test('consecutive primary timeouts trigger a /health probe while closed: only a failed probe opens the breaker; timed-out requests never fail over',async()=>{
    fake();
    const p=scripted();const secondary=countingSecondary();const failover=create(p,secondary,{timeoutThreshold:3});
    p.setHealthy(true);p.outcomes.push('timeout','timeout','timeout');
    for(let i=0;i<3;i++) await expect(failover.complete({messages},timedOut())).rejects.toMatchObject({name:'TimeoutError'});
    await flush();
    // Overloaded but healthy: the probe passes and the breaker stays closed.
    expect(p.calls.health).toBe(1);expect(failover.failoverMetrics().breaker).toMatchObject({state:'closed',consecutiveTimeouts:0,probesOk:1});
    p.setHealthy(false);p.outcomes.push('timeout','timeout','ok','timeout','timeout');
    await expect(failover.complete({messages},timedOut())).rejects.toThrow();await expect(failover.complete({messages},timedOut())).rejects.toThrow();
    await failover.complete({messages},signal()); // an answer resets the timeout streak
    await expect(failover.complete({messages},timedOut())).rejects.toThrow();await expect(failover.complete({messages},timedOut())).rejects.toThrow();
    await flush();expect(p.calls.health).toBe(1);expect(failover.failoverMetrics().breaker.state).toBe('closed');
    p.outcomes.push('timeout');await expect(failover.complete({messages},timedOut())).rejects.toThrow();
    await flush();
    expect(p.calls.health).toBe(2);expect(failover.failoverMetrics().breaker).toMatchObject({state:'open',opened:1,probesFailed:1});
    expect(secondary.calls.n).toBe(0);
    expect((await failover.complete({messages},signal())).upstream).toBe('secondary');
  });
  test('a timeout raised by the client itself (no aborted signal, e.g. undici headers timeout) counts as a timeout, never a failover',async()=>{
    fake();
    const p=scripted();const secondary=countingSecondary();const failover=create(p,secondary,{timeoutThreshold:3});
    p.outcomes.push('timeout');
    await expect(failover.complete({messages},signal())).rejects.toMatchObject({name:'TimeoutError'});
    expect(secondary.calls.n).toBe(0);expect(failover.failoverMetrics().breaker.consecutiveTimeouts).toBe(1);
  });
  test('a probe started while closed never closes a breaker that opened meanwhile',async()=>{
    fake();
    let answer:((ok:boolean)=>void)|undefined;const secondary=countingSecondary();const outcomes=['timeout','refused','refused','refused'];
    const primary={model:'p',health:()=>new Promise<boolean>(resolve=>{answer=resolve;}),
      complete:async():Promise<UpstreamResult>=>{if(outcomes.shift()==='timeout') throw new DOMException('timeout','TimeoutError');throw new UpstreamConnectError('connect_refused',true);}};
    const failover=new FailoverUpstream(primary,secondary.upstream,{timeoutThreshold:1,failureThreshold:3,cooldownMs:30000});
    await expect(failover.complete({messages},signal())).rejects.toMatchObject({name:'TimeoutError'}); // starts a probe
    for(let i=0;i<3;i++) await failover.complete({messages},signal()); // the breaker opens meanwhile
    expect(failover.failoverMetrics().breaker).toMatchObject({state:'open',opened:1});
    answer!(true);await flush();
    expect(failover.failoverMetrics().breaker).toMatchObject({state:'open',opened:1});
  });
  test('concurrent requests in half-open share one probe',async()=>{
    fake();
    const p=scripted();const secondary=countingSecondary();const failover=create(p,secondary,{failureThreshold:1,cooldownMs:1000});
    p.outcomes.push('refused');await failover.complete({messages},signal());
    jest.setSystemTime(1000);p.setHealthy(true);
    const served=await Promise.all([1,2,3].map(()=>failover.complete({messages},signal())));
    expect(p.calls.health).toBe(1);expect(served.map(r=>r.upstream)).toEqual(['primary','primary','primary']);
  });
  test('a caller waiting on the half-open probe can abort',async()=>{
    fake();
    const p=scripted();const secondary=countingSecondary();const failover=create(p,secondary,{failureThreshold:1,cooldownMs:1000});
    p.outcomes.push('refused');await failover.complete({messages},signal());
    jest.setSystemTime(1000);p.setHealthy('hang');
    const controller=new AbortController();const waiting=failover.complete({messages},controller.signal);
    await flush();expect(p.calls.health).toBe(1);
    controller.abort();
    await expect(waiting).rejects.toMatchObject({name:'AbortError'});
    expect(secondary.calls.n).toBe(1);expect(failover.failoverMetrics().failovers).toEqual({connect_refused:1});
  });
  test('a hung /health probe counts as failed after the probe timeout',async()=>{
    const secondary=countingSecondary();
    const tunnel=createServer(req=>{req.resume();req.on('end',()=>{if(req.url!=='/health')req.socket.destroy();});});
    const failover=new FailoverUpstream(primaryAt(await listen(tunnel)),secondary.upstream,{failureThreshold:1,cooldownMs:50,probeTimeoutMs:100});
    expect((await failover.complete({messages},signal())).upstream).toBe('secondary');
    await sleep(60);
    const started=Date.now();
    expect((await failover.complete({messages},signal())).upstream).toBe('secondary');
    expect(Date.now()-started).toBeGreaterThanOrEqual(90);
    expect(failover.failoverMetrics().breaker).toMatchObject({state:'open',probesFailed:1});
  });
  test('cancelled callers are never sent to the secondary and are not counted',async()=>{
    fake();
    const p=scripted();let secondaryCalls=0;
    const provider:TextProvider={generate:async(_m,{signal})=>{secondaryCalls++;await new Promise<void>((_r,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))));return '';}};
    const failover=new FailoverUpstream(p.primary,new TextProviderUpstream(provider,'secondary/model'),{failureThreshold:1,cooldownMs:30000});
    const gone=new AbortController();gone.abort();p.outcomes.push('refused');
    await expect(failover.complete({messages},gone.signal)).rejects.toBeInstanceOf(UpstreamConnectError);
    await expect(failover.complete({messages},gone.signal)).rejects.toMatchObject({name:'AbortError'}); // breaker open
    expect(secondaryCalls).toBe(0);expect(failover.failoverMetrics().failovers).toEqual({});
    const leaving=new AbortController();const pending=failover.complete({messages},leaving.signal);
    await flush();leaving.abort();await expect(pending).rejects.toThrow();
    expect(failover.failoverMetrics()).toMatchObject({secondaryErrors:0,failovers:{breaker_open:1}});
  });
  test('the secondary is held to a rolling per-minute ceiling',async()=>{
    fake();
    const p=scripted();const secondary=countingSecondary();const failover=create(p,secondary,{maxPerMinute:2});
    p.outcomes.push('refused','refused','refused');
    await failover.complete({messages},signal());await failover.complete({messages},signal());
    await expect(failover.complete({messages},signal())).rejects.toThrow('FAILOVER_RATE_LIMITED');
    expect(secondary.calls.n).toBe(2);expect(failover.failoverMetrics()).toMatchObject({rateLimited:1,failovers:{connect_refused:2}});
    jest.setSystemTime(60000);
    expect((await failover.complete({messages},signal())).upstream).toBe('secondary');
  });
});

describe('no spillover',()=>{
  test('a full gateway queue or a queue timeout is still rejected (429/503 marked) and never reaches the secondary',async()=>{
    const secondary=countingSecondary();let release:(()=>void)|undefined;
    const slow=engine(res=>{release=()=>healthy(res);});
    const {base,g}=await gateway(new FailoverUpstream(primaryAt(await listen(slow.server)),secondary.upstream),{maxConcurrent:1,maxQueue:1,queueTimeoutMs:300});
    const first=post(base);await until(()=>slow.calls.completions===1);
    const queued=post(base);await until(()=>g.metrics().queued===1);
    const full=await post(base);
    expect(full.status).toBe(429);expect(full.headers.get('x-ptr-gateway')).toBe('rejected');expect(full.headers.get('x-ptr-upstream')).toBeNull();
    const timedOut=await queued;expect(timedOut.status).toBe(503);expect(timedOut.headers.get('x-ptr-gateway')).toBe('rejected');
    release!();expect((await first).headers.get('x-ptr-upstream')).toBe('primary');
    expect(secondary.calls.n).toBe(0);expect(g.metrics().failover).toMatchObject({failovers:{},answered:{secondary:0}});
  });
});

class MemoryLedger implements BudgetLedger {
  readonly requests=new Map<string,BudgetRequest>();
  constructor(private readonly cap=1_000_000) {}
  async reserve(key:string,amount:number) {
    const previous=this.requests.get(key);if(previous) return {created:false,request:previous};
    if(amount>this.cap) throw new ProviderError('BUDGET_EXCEEDED');
    const request:BudgetRequest={key,state:'reserved',reservedMicrousd:amount,actualMicrousd:null,response:null,generationId:null};
    this.requests.set(key,request);return {created:true,request};
  }
  async submitted(key:string) {this.requests.get(key)!.state='submitted';}
  async finish(key:string,actual:number|null,response:unknown|null,generationId:string|null) {
    const row=this.requests.get(key)!;if(row.state==='settled') return;
    Object.assign(row,{state:actual===null?'unknown':'settled',actualMicrousd:actual,response:response??row.response,generationId:generationId??row.generationId});
  }
  async get(key:string) {return this.requests.get(key);}
}
const gemma='google/gemma-4-26b-a4b-it';
const databaseUrl='postgresql://ptr_researcher:synthetic@127.0.0.1:56432/ptr_research';
const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
function openRouter(ledger:BudgetLedger,post:(body:Record<string,unknown>,init?:RequestInit)=>Response|Promise<Response>,price='0.00000009') {
  const posts:Record<string,unknown>[]=[];
  const fetcher=jest.fn(async(url:string|URL|Request,init?:RequestInit)=>{
    if(String(url).endsWith('/embeddings/models')) return json({data:[{id:'openai/text-embedding-3-small',pricing:{prompt:'0.00000002',completion:'0',request:'0'}}]});
    if(String(url).endsWith('/models')) return json({data:[{id:gemma,pricing:{prompt:price,completion:'0.0000003'},supported_parameters:['response_format','structured_outputs']}]});
    const body=JSON.parse(String(init?.body));posts.push(body);return post(body,init);
  });
  const client=new OpenRouterClient({apiKey:'synthetic-key',liveEnabled:true,allowExternalData:true,databaseUrl,ledger,textModel:gemma,fetch:fetcher as typeof fetch});
  return {upstream:new TextProviderUpstream(client,gemma),posts,client};
}
const answer=(body:Record<string,unknown>)=>json({id:'gen-synthetic',model:body.model,choices:[{message:{content:'{"status":"answered","answer":"보조","evidenceRefs":[]}'}}],usage:{cost:0.00001,prompt_tokens:42,completion_tokens:7}});
const agent={messages:[{role:'system',content:'AGENT_JSON_REPLY'},{role:'user',content:'재시도'}],stream:true};

describe('secondary through the OpenRouter client and budget ledger',()=>{
  test('a budget refusal on the secondary surfaces as today\'s provider failure (502, unmarked); nothing is sent',async()=>{
    const secondary=openRouter(new MemoryLedger(0),answer);
    const {base}=await gateway(new FailoverUpstream(primaryAt(await closedPort()),secondary.upstream));
    const response=await post(base);
    expect(response.status).toBe(502);expect(response.headers.get('x-ptr-gateway')).toBeNull();expect(await response.json()).toEqual({error:{code:'UPSTREAM_UNAVAILABLE'}});
    const client=new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token});
    await expect(client.generate([{role:'user',content:'안녕'}],{signal:new AbortController().signal})).rejects.toMatchObject({code:'PROVIDER_HTTP_502'});
    expect(secondary.posts).toHaveLength(0);
  });
  test('without a request key: a retried request replays the settled call, and an unresolved one is never resubmitted',async()=>{
    const ledger=new MemoryLedger();const secondary=openRouter(ledger,answer);
    const {base}=await gateway(new FailoverUpstream(primaryAt(await closedPort()),secondary.upstream));
    const [a,b]=[await (await post(base,agent)).text(),await (await post(base,agent)).text()];
    expect(a).toContain('보조');expect(b).toContain('보조');
    expect(secondary.posts).toHaveLength(1);expect(ledger.requests.size).toBe(1);
    // Structured output: the client's own json_schema for gemma agent replies, with data-collection/ZDR guards.
    expect(secondary.posts[0]).toMatchObject({model:gemma,stream:false,response_format:{type:'json_schema'},provider:{data_collection:'deny',zdr:true}});
    const failing=openRouter(new MemoryLedger(),()=>{throw new Error('network dropped after submit');});
    const second=await gateway(new FailoverUpstream(primaryAt(await closedPort()),failing.upstream));
    expect((await post(second.base,agent)).status).toBe(502);
    expect((await post(second.base,agent)).status).toBe(502); // REQUEST_UNRESOLVED_NO_RESUBMIT
    expect(failing.posts).toHaveLength(1);
  });
  test('X-PTR-Request-Key scopes the ledger entry: identical bodies of different turns are both served, the same turn replays',async()=>{
    const ledger=new MemoryLedger();const secondary=openRouter(ledger,answer);
    const {base}=await gateway(new FailoverUpstream(primaryAt(await closedPort()),secondary.upstream));
    const [a,b]=await Promise.all([post(base,agent,{'X-PTR-Request-Key':'turn-a'}),post(base,agent,{'X-PTR-Request-Key':'turn-b'})]);
    expect([a.status,b.status]).toEqual([200,200]);await a.text();await b.text();
    expect(secondary.posts).toHaveLength(2);
    const again=await post(base,agent,{'X-PTR-Request-Key':'turn-a'});expect(again.status).toBe(200);await again.text();
    expect(secondary.posts).toHaveLength(2);expect(ledger.requests.size).toBe(2);
    expect((await post(base,agent,{'X-PTR-Request-Key':'bad key!'})).status).toBe(400);
    // The worker's client sends its turn id as the key.
    const client=new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token});
    await client.generate(agent.messages as never,{signal:new AbortController().signal,requestKey:'turn-c'});
    expect(secondary.posts).toHaveLength(3);
  });
  test('a worker that aborts mid secondary call leaves the ledger entry unknown; the retried turn is refused, never resubmitted',async()=>{
    const ledger=new MemoryLedger();
    const secondary=openRouter(ledger,(_body,init)=>new Promise<Response>((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')))));
    const {base}=await gateway(new FailoverUpstream(primaryAt(await closedPort()),secondary.upstream));
    const controller=new AbortController();
    const pending=post(base,agent,{'X-PTR-Request-Key':'turn-x'},controller.signal).catch(()=>undefined);
    await until(()=>secondary.posts.length===1);controller.abort();await pending;
    await until(()=>[...ledger.requests.values()][0]?.state==='unknown');
    expect((await post(base,agent,{'X-PTR-Request-Key':'turn-x'})).status).toBe(502);
    expect(secondary.posts).toHaveLength(1);
  });
  test('max_tokens passes through within the client cap; reported usage reaches the worker client',async()=>{
    const secondary=openRouter(new MemoryLedger(),answer);
    const {base}=await gateway(new FailoverUpstream(primaryAt(await closedPort()),secondary.upstream));
    await (await post(base,{...agent,max_tokens:100})).text();await (await post(base,{...agent,max_tokens:4096,messages:[...agent.messages,{role:'user',content:'더'}]})).text();
    expect(secondary.posts.map(body=>body.max_tokens)).toEqual([100,512]);
    const metrics:CallMetrics[]=[];
    const client=new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token,onMetrics:m=>metrics.push(m)});
    await client.generate(agent.messages as never,{signal:new AbortController().signal,requestKey:'turn-u'});
    expect(metrics[0]).toMatchObject({ok:true,promptTokens:42,completionTokens:7});
  });
  test('startup readiness: the ledger must be readable and the secondary price verified',async()=>{
    const ok=openRouter(new MemoryLedger(),answer);const fine=async()=>undefined;
    await expect(secondaryReady(ok.client,fine)(AbortSignal.timeout(1000))).resolves.toBeUndefined();
    await expect(secondaryReady(ok.client,async()=>{throw new Error('relation does not exist');})(AbortSignal.timeout(1000))).rejects.toThrow();
    const repriced=openRouter(new MemoryLedger(),answer,'0.00000050');
    await expect(secondaryReady(repriced.client,fine)(AbortSignal.timeout(1000))).rejects.toThrow('PRICING_CHANGED_OR_UNKNOWN_FEE');
    // The ledger check reads both tables; a missing global budget row fails startup.
    const pool=(budgetRows:number)=>({query:jest.fn(async(sql:string)=>({rowCount:sql.includes('ptr_provider_budget')?budgetRows:0}))});
    const initialized=pool(1);await expect(ledgerReady(initialized)()).resolves.toBeUndefined();
    expect(initialized.query.mock.calls.map(([sql])=>sql)).toEqual([expect.stringContaining('ptr_provider_requests'),expect.stringContaining("id='global'")]);
    await expect(ledgerReady(pool(0))()).rejects.toThrow('BUDGET_NOT_INITIALIZED');
    await expect(ledgerReady({query:async()=>{throw new Error('relation does not exist');}})()).rejects.toThrow();
    const ready=jest.fn(async()=>undefined);
    const failover=new FailoverUpstream(primaryAt(await closedPort()),new TextProviderUpstream({generate:async()=>'x'},'m',ready));
    await failover.ready(AbortSignal.timeout(1000));expect(ready).toHaveBeenCalledTimes(1);
  });
});

describe('failover off (default)',()=>{
  test('responses are byte-identical to the single-upstream gateway: no upstream header, no failover metrics',async()=>{
    const up=engine(healthy);const engineBase=await listen(up.server);
    const configured=upstreamFromEnvironment({PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_SELFHOSTED_BASE_URL:`${engineBase}/v1`,PTR_SELFHOSTED_MODEL:'m'});
    expect(configured.upstream).toBeInstanceOf(OpenAICompatibleUpstream);
    const {base,g}=await gateway(configured.upstream);
    const response=await post(base);
    expect(response.headers.get('x-ptr-upstream')).toBeNull();expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from(sse('주 엔진')));
    expect(Object.keys(g.metrics()).sort()).toEqual(['accepted','capacity','completed','inFlight','queueWaitMs','queued','rejected','upstream','upstreamErrors','upstreamMs']);
    const refused=await gateway(primaryAt(await closedPort()));
    const failed=await post(refused.base);
    expect(failed.status).toBe(502);expect(failed.headers.get('x-ptr-upstream')).toBeNull();expect(await failed.text()).toBe('{"error":{"code":"UPSTREAM_UNAVAILABLE"}}');
  });
});

describe('failover configuration',()=>{
  const selfhosted={PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_SELFHOSTED_BASE_URL:'http://127.0.0.1:18000/v1',PTR_SELFHOSTED_MODEL:'m'};
  test('fake secondary (load tests) may carry the latency profile; settings are validated',()=>{
    const {upstream}=upstreamFromEnvironment({...selfhosted,PTR_GATEWAY_FAILOVER:'fake',PTR_FAKE_LATENCY:'{"medianMs":1,"p95Ms":2}',PTR_GATEWAY_BREAKER_FAILURES:'2',PTR_GATEWAY_FAILOVER_ON_CLOSE:'false'});
    expect(upstream).toBeInstanceOf(FailoverUpstream);
    expect((upstream as FailoverUpstream).failoverMetrics()).toMatchObject({secondary:'synthetic/fake-text-v1+latency',breaker:{state:'closed'}});
    for(const [name,value] of [['PTR_GATEWAY_BREAKER_FAILURES','0'],['PTR_GATEWAY_BREAKER_COOLDOWN_MS','5'],['PTR_GATEWAY_BREAKER_TIMEOUTS','0'],
      ['PTR_GATEWAY_PRIMARY_HEADERS_TIMEOUT_MS','-1'],['PTR_GATEWAY_FAILOVER_MAX_PER_MINUTE','0'],['PTR_GATEWAY_FAILOVER_ON_CLOSE','yes']] as const)
      expect(()=>upstreamFromEnvironment({...selfhosted,PTR_GATEWAY_FAILOVER:'fake',[name]:value})).toThrow(`INVALID_${name}`);
  });
  test('failover needs a self-hosted primary, a known kind, and the live gates for OpenRouter; latency never wraps it',async()=>{
    expect(()=>upstreamFromEnvironment({PTR_GATEWAY_FAILOVER:'fake'})).toThrow('FAILOVER_REQUIRES_SELFHOSTED');
    expect(()=>upstreamFromEnvironment({...selfhosted,PTR_GATEWAY_FAILOVER:'anthropic'})).toThrow('INVALID_PTR_GATEWAY_FAILOVER');
    expect(()=>upstreamFromEnvironment({...selfhosted,PTR_GATEWAY_FAILOVER:'openrouter',PTR_FAKE_LATENCY:'{"medianMs":1,"p95Ms":2}'})).toThrow('LATENCY_INJECTION_ONLY_FOR_FAKE');
    expect(()=>upstreamFromEnvironment({...selfhosted,PTR_GATEWAY_FAILOVER:'openrouter',GOAL1_DATABASE_URL:databaseUrl})).toThrow('LIVE_DISABLED');
    const live=upstreamFromEnvironment({...selfhosted,PTR_GATEWAY_FAILOVER:'openrouter',GOAL1_DATABASE_URL:databaseUrl,GOAL1_LIVE_ENABLED:'true',GOAL1_ALLOW_EXTERNAL_DATA:'true',OPENROUTER_API_KEY:'synthetic-key'});
    expect(typeof live.upstream.ready).toBe('function');expect(live.upstream.failoverMetrics?.().secondary).toBe(gemma);
    await live.close?.();
  });
});
