import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Persona } from '@ptr/contracts';
import { createLocalChat, InMemoryConversationStore, InMemoryPersonaRepository, type TextProvider } from '@ptr/core';
import { OpenAICompatibleTextProvider, ProviderError } from '@ptr/providers';
import { AdmissionLimiter, createGateway, DEADLINE_MARGIN_MS, FailoverUpstream, GatewayRejection, SECONDARY_MIN_REMAINING_MS, StaticUpstreamSource,
  TextProviderUpstream, UpstreamConnectError, UpstreamPool, type GatewayOptions, type Primary, type Upstream, type UpstreamResult } from '../src';

//  (O2): X-PTR-Deadline, the turn's deadline as absolute epoch ms. Numbered as the doc's O2 tests.
const token='synthetic_gateway_token_abcdefghij';
const messages=[{role:'user',content:'안녕'}];
const servers:Server[]=[];
afterEach(async()=>{
  jest.useRealTimers();
  await Promise.all(servers.splice(0).map(server=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}));
});
async function gateway(upstream:Upstream,limits:Partial<GatewayOptions['limits']>={}) {
  const g=createGateway({token,upstream,limits:{maxConcurrent:2,maxQueue:2,queueTimeoutMs:2000,upstreamTimeoutMs:30000,...limits}});
  servers.push(g.server);await new Promise<void>(r=>g.server.listen(0,'127.0.0.1',r));
  return {g,base:`http://127.0.0.1:${(g.server.address() as AddressInfo).port}`};
}
const post=(base:string,headers:Record<string,string>={})=>fetch(`${base}/v1/chat/completions`,
  {method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json',...headers},body:JSON.stringify({messages,stream:true})});
function countingSecondary() {
  const calls={n:0};
  const provider:TextProvider={generate:async()=>{calls.n++;return '보조 응답';}};
  return {upstream:new TextProviderUpstream(provider,'secondary/model'),calls};
}
/**
 * Scripted primary: `hang` never answers until its signal aborts (the reason is kept); `refused` fails to connect after
 * `costMs` of (fake) time; `closed` closes before any response byte after `costMs`; `ok` answers at once.
 */
function scripted() {
  const outcomes:{kind:'hang'|'refused'|'closed'|'ok'|'stream';costMs?:number}[]=[];const calls={complete:0,health:0};const reasons:string[]=[];
  let healthy=false;
  const primary:Primary={model:'m',health:async()=>{calls.health++;return healthy;},
    complete:(_request,signal)=>{
      calls.complete++;const next=outcomes.shift()??{kind:'ok'};
      if(next.costMs) jest.setSystemTime(Date.now()+next.costMs);
      if(next.kind==='refused') return Promise.reject(new UpstreamConnectError('connect_refused',true));
      if(next.kind==='closed') return Promise.reject(new UpstreamConnectError('closed_before_response',false));
      if(next.kind==='ok') return Promise.resolve<UpstreamResult>({status:200,contentType:'application/json',body:'{}'});
      const aborted=()=>new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>{reasons.push(String((signal.reason as {name?:unknown})?.name));reject(signal.reason);},{once:true}));
      if(next.kind==='hang') return aborted();
      // Headers arrive at once; the stream then stalls until the call is aborted.
      const body:AsyncIterable<Uint8Array>={[Symbol.asyncIterator]:()=>{let sent=false;
        return {next:async()=>{if(!sent) {sent=true;return {done:false,value:Buffer.from('data: {}\n\n')};}return aborted();}};}};
      return Promise.resolve<UpstreamResult>({status:200,contentType:'text/event-stream',body});
    }};
  return {primary,outcomes,calls,reasons,setHealthy:(value:boolean)=>{healthy=value;}};
}
const record=(id:string,maxSeqs=4)=>({pool:'m',id,baseUrl:`static:${id}`,maxSeqs,kvCapacityTokens:null,weight:1,state:'active' as const,epoch:'e1',seq:0});
const flush=()=>new Promise(r=>setImmediate(r));
const fake=()=>jest.useFakeTimers({now:1_000_000,doNotFake:['setImmediate']});
const deadlineError=()=>new DOMException('turn deadline','DeadlineExceeded');
const persona:Persona={id:'persona_synthetic_d',personId:'person_synthetic_d',label:'Synthetic D',language:'ko',revision:'v1',reviewStatus:'synthetic',
  identity:'Fictional',concept:'Deadline test',style:['brief'],boundaries:['AI disclosure'],sourceRefs:[],greeting:'안녕하세요.'};

describe('X-PTR-Deadline at the gateway ',()=>{
  test('the margins are the design constants: 5 s before the deadline for a send, 3.5 s left for the secondary',()=>{
    expect(DEADLINE_MARGIN_MS).toBe(5000);expect(SECONDARY_MIN_REMAINING_MS).toBe(3500);
  });
  test('1: no header keeps the current behaviour; a malformed one is a 400 and never reaches the upstream',async()=>{
    const secondary=countingSecondary();const {base,g}=await gateway(secondary.upstream);
    const plain=await post(base);expect(plain.status).toBe(200);await plain.text();
    for(const value of ['soon','-1','1.5','','1e15','1234567890123456']) {
      const bad=await post(base,{'X-PTR-Deadline':value});
      expect(bad.status).toBe(400);expect(await bad.json()).toEqual({error:{code:'INVALID_INPUT'}});
    }
    expect(secondary.calls.n).toBe(1);expect(g.metrics().rejected.deadline).toBe(0);
    const later=await post(base,{'X-PTR-Deadline':String(Date.now()+30000)});expect(later.status).toBe(200);await later.text();
    // Far beyond the upstream timeout (and 2^31−1 ms): no deadline timer, so nothing is cut early.
    const far=await post(base,{'X-PTR-Deadline':String(Date.now()+30*86_400_000)});expect(far.status).toBe(200);await far.text();
    expect(g.metrics().deadlineAborts).toBe(0);
  });
  test('2: less than 5 s left is a marked 503 `deadline` with no upstream call, on the limiter and the pool path; the client does not retry it',async()=>{
    const limited=countingSecondary();const {base,g}=await gateway(limited.upstream);
    for(const deadlineAt of [Date.now()+4900,Date.now()-1]) {
      const refused=await post(base,{'X-PTR-Deadline':String(deadlineAt)});
      expect(refused.status).toBe(503);expect(refused.headers.get('x-ptr-gateway')).toBe('rejected');
      expect(refused.headers.get('x-ptr-gateway-reason')).toBe('deadline');expect(await refused.json()).toEqual({error:{code:'GATEWAY_DEADLINE'}});
    }
    expect(limited.calls.n).toBe(0);expect(g.metrics().rejected.deadline).toBe(2);
    // The worker's client: PROVIDER_DEADLINE at once, a single request (a retry would be refused the same way).
    const client=new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token,resetRetries:2});
    await expect(client.generate(messages as never,{signal:new AbortController().signal,requestKey:'turn-1',deadlineAt:Date.now()+4000}))
      .rejects.toEqual(new ProviderError('PROVIDER_DEADLINE'));
    expect(g.metrics().rejected.deadline).toBe(3);expect(limited.calls.n).toBe(0);
    const p=scripted();
    const pool=new UpstreamPool({model:'m',source:new StaticUpstreamSource([record('a')]),create:()=>p.primary,admission:true});
    const pooled=await gateway(pool);
    const refused=await post(pooled.base,{'X-PTR-Deadline':String(Date.now()+4900)});
    expect(refused.status).toBe(503);expect(refused.headers.get('x-ptr-gateway-reason')).toBe('deadline');await refused.text();
    expect(p.calls.complete).toBe(0);
    await pool.close();
  });
  test('2: a pool called directly also refuses to send inside the margin (credit at once, nothing sent)',async()=>{
    fake();
    const p=scripted();
    const pool=new UpstreamPool({model:'m',source:new StaticUpstreamSource([record('a')]),create:()=>p.primary,admission:true});
    await expect(pool.complete({messages},new AbortController().signal,{deadlineAt:Date.now()+4999})).rejects.toMatchObject({code:'GATEWAY_DEADLINE'});
    expect(p.calls.complete).toBe(0);expect(pool.poolMetrics().queue.rejected.deadline).toBe(1);
    expect(pool.poolMetrics().upstreams[0]).toMatchObject({inFlight:0,reservedKvTokens:0,prefillTokens:0,dispatched:0});
    await pool.close();
  });
  test('3: the gateway limiter waits min(queue timeout, deadline − 5 s); the deadline bound ends as `deadline`, the queue bound as before',async()=>{
    fake();
    const limiter=new AdmissionLimiter({maxConcurrent:1,maxQueue:4,queueTimeoutMs:10000});
    const signal=new AbortController().signal;
    const release=await limiter.acquire(signal);
    const byDeadline=limiter.acquire(signal,3000).catch(error=>error);
    const byQueue=limiter.acquire(signal,20000).catch(error=>error);
    const plain=limiter.acquire(signal).catch(error=>error);
    await jest.advanceTimersByTimeAsync(2999);expect(limiter.queued).toBe(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(await byDeadline).toMatchObject({code:'GATEWAY_DEADLINE'});expect(limiter.queued).toBe(2);
    await jest.advanceTimersByTimeAsync(6999);expect(limiter.queued).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(await byQueue).toMatchObject({code:'GATEWAY_QUEUE_TIMEOUT'});expect(await plain).toMatchObject({code:'GATEWAY_QUEUE_TIMEOUT'});
    release();
  });
  test('3: through the server, a limiter wait bounded by the deadline ends as a marked 503 `deadline`, the held slot untouched',async()=>{
    let release:(()=>void)|undefined;let calls=0;
    const upstream=new TextProviderUpstream({generate:async()=>{calls++;await new Promise<void>(r=>{release=r;});return 'ok';}},'fake');
    const {base,g}=await gateway(upstream,{maxConcurrent:1,maxQueue:2,queueTimeoutMs:10000});
    const first=post(base);
    while(!release) await new Promise(r=>setTimeout(r,5));
    const started=Date.now();
    const late=await post(base,{'X-PTR-Deadline':String(Date.now()+DEADLINE_MARGIN_MS+300)});
    expect(Date.now()-started).toBeLessThan(2000);
    expect(late.status).toBe(503);expect(late.headers.get('x-ptr-gateway-reason')).toBe('deadline');await late.text();
    expect(calls).toBe(1);expect(g.metrics().rejected).toMatchObject({deadline:1,queueTimeout:0});
    release!();expect((await first).status).toBe(200);
  });
  test('3: a pool queue waits min(queue timeout, deadline − 5 s) as well',async()=>{
    fake();
    const p=scripted();p.outcomes.push({kind:'hang'});
    // Headers timeout off: the held call must keep its slot past the 10 s queue bound.
    const pool=new UpstreamPool({model:'m',source:new StaticUpstreamSource([record('a',1)]),create:()=>p.primary,admission:true,queueTimeoutMs:10000,
      failover:{headersTimeoutMs:0}});
    const holder=new AbortController();const held=pool.complete({messages},holder.signal).catch(error=>error);
    const start=Date.now();
    const byDeadline=pool.complete({messages},new AbortController().signal,{deadlineAt:start+8000}).catch(error=>error);
    const byQueue=pool.complete({messages},new AbortController().signal,{deadlineAt:start+60000}).catch(error=>error);
    await jest.advanceTimersByTimeAsync(2999);expect(pool.poolMetrics().waiting).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    const first=await byDeadline;expect(first).toBeInstanceOf(GatewayRejection);expect(first).toMatchObject({code:'GATEWAY_DEADLINE'});
    await jest.advanceTimersByTimeAsync(7000);
    expect(await byQueue).toMatchObject({code:'GATEWAY_QUEUE_TIMEOUT'});
    expect(pool.poolMetrics().queue.rejected).toMatchObject({deadline:1,queue_timeout:1});expect(p.calls.complete).toBe(1);
    holder.abort();await held;await pool.close();
  });
  test('4: a deadline refusal on a second primary attempt is unmarked (the first may have reached an engine)',async()=>{
    fake();
    const a=scripted(), b=scripted();a.outcomes.push({kind:'closed',costMs:3500});
    const pool=new UpstreamPool({model:'m',source:new StaticUpstreamSource([record('a'),record('b')]),create:r=>r.id==='a'?a.primary:b.primary,
      admission:true,routing:'round_robin'});
    const error=await pool.complete({messages},new AbortController().signal,{deadlineAt:Date.now()+8000}).catch(caught=>caught);
    expect(error).toBeInstanceOf(UpstreamConnectError);expect(error).not.toBeInstanceOf(GatewayRejection);
    expect(a.calls.complete).toBe(1);expect(b.calls.complete).toBe(0);expect(pool.poolMetrics().queue.rejected.deadline).toBe(0);
    expect(pool.poolMetrics().upstreams.every(u=>u.inFlight===0)).toBe(true);
    // The refused retry is not a dispatch: b's count and the round-robin turn stay where they were (the next call goes to b).
    expect(pool.poolMetrics().upstreams.map(u=>[u.id,u.dispatched])).toEqual([['a',1],['b',0]]);
    expect(await pool.complete({messages},new AbortController().signal,{deadlineAt:Date.now()+8000})).toMatchObject({status:200});
    expect(a.calls.complete).toBe(1);expect(b.calls.complete).toBe(1);
    // With time to spare the same failure is still retried on the other primary.
    a.outcomes.push({kind:'closed',costMs:1000});
    expect(await pool.complete({messages},new AbortController().signal,{deadlineAt:Date.now()+8000})).toMatchObject({status:200});
    expect(a.calls.complete).toBe(2);expect(b.calls.complete).toBe(2);
    await pool.close();
  });
  // Test 11 reduced (coordinator decision): this client + gateway run over real HTTP covers the abort, the breaker and the
  // secondary; the turn outcome (TURN_TIMEOUT) is covered by the chat-service test below and in core's turn-worker tests.
  test('5 + 11: a dispatched call to a hung engine is aborted at the deadline with DeadlineExceeded; the client fails by then, the breaker stays closed, no secondary',async()=>{
    const p=scripted();p.outcomes.push({kind:'hang'});const secondary=countingSecondary();
    // timeoutThreshold 1: a single abort counted as an engine timeout would already run a /health probe.
    const failover=new FailoverUpstream(p.primary,secondary.upstream,{headersTimeoutMs:10000,timeoutThreshold:1,failureThreshold:1});
    const {base,g}=await gateway(failover);
    const client=new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token,timeoutMs:30000,resetRetries:2});
    const started=Date.now();
    // 1.5 s of slack before the send margin, so a busy machine still dispatches it.
    await expect(client.generate(messages as never,{signal:new AbortController().signal,requestKey:'turn-5',deadlineAt:started+DEADLINE_MARGIN_MS+1500}))
      .rejects.toEqual(new ProviderError('PROVIDER_DEADLINE'));
    const elapsed=Date.now()-started;
    expect(elapsed).toBeGreaterThanOrEqual(6400);expect(elapsed).toBeLessThan(8500);
    expect(p.reasons).toEqual(['DeadlineExceeded']);expect(p.calls).toEqual({complete:1,health:0});
    expect(secondary.calls.n).toBe(0);
    expect(failover.failoverMetrics().breaker).toMatchObject({state:'closed',consecutiveTimeouts:0});
    expect(g.metrics()).toMatchObject({deadlineAborts:1,rejected:{deadline:0}});
  },15000);
  test('11 (turn level): a chat turn whose provider gets the gateway\'s marked `deadline` refusal ends as TURN_TIMEOUT, nothing sent upstream',async()=>{
    const upstream=countingSecondary();const {base,g}=await gateway(upstream.upstream);
    const failures:{turnId:string;code:string}[]=[];
    // A 3 s turn is inside the 5 s send margin, so the gateway refuses its first call at once.
    const chat=createLocalChat({store:new InMemoryConversationStore(),personas:new InMemoryPersonaRepository([persona]),timeoutMs:3000,
      provider:new OpenAICompatibleTextProvider({baseUrl:`${base}/v1`,model:'gateway',apiKey:token,resetRetries:2}),onTurnFailure:failure=>failures.push(failure)});
    const session=await chat.createSession('owner_synthetic_d',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
    const started=Date.now();
    const turn=await chat.sendTurn('owner_synthetic_d',{sessionId:session.id,clientRequestId:'deadline-turn',text:'안녕'});
    expect(Date.now()-started).toBeLessThan(2000); // refused, not waited out
    expect(turn).toMatchObject({state:'failed',errorCode:'TURN_FAILED'});expect(failures).toEqual([{turnId:turn.id,code:'TURN_TIMEOUT'}]);
    expect(upstream.calls.n).toBe(0);expect(g.metrics().rejected.deadline).toBe(1);
  });
  test('6: three deadline aborts before the headers timeout, or after headers arrived, leave the breaker closed',async()=>{
    fake();
    const p=scripted();const secondary=countingSecondary();
    const failover=new FailoverUpstream(p.primary,secondary.upstream,{headersTimeoutMs:10000,timeoutThreshold:3,failureThreshold:3});
    for(let i=0;i<3;i++) {
      p.outcomes.push({kind:'hang'});
      const controller=new AbortController();const call=failover.complete({messages},controller.signal,{deadlineAt:Date.now()+30000});
      await flush();jest.setSystemTime(Date.now()+9999);controller.abort(deadlineError());
      await expect(call).rejects.toMatchObject({name:'DeadlineExceeded'});await flush();
    }
    for(let i=0;i<3;i++) {
      p.outcomes.push({kind:'stream'});
      const controller=new AbortController();
      const result=await failover.complete({messages},controller.signal,{deadlineAt:Date.now()+30000});
      const iterator=(result.body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator]();
      expect((await iterator.next()).done).toBe(false);
      const stalled=iterator.next();jest.setSystemTime(Date.now()+15000);controller.abort(deadlineError());
      await expect(stalled).rejects.toMatchObject({name:'DeadlineExceeded'});await flush();
    }
    expect(p.calls).toEqual({complete:6,health:0});expect(secondary.calls.n).toBe(0);
    expect(failover.failoverMetrics().breaker).toMatchObject({state:'closed',consecutiveTimeouts:0,opened:0});
  });
  test('7: three deadline aborts after ≥ 10 s without headers count (gaveUp): the /health probe runs and a failed one opens the breaker',async()=>{
    fake();
    const p=scripted();const secondary=countingSecondary();
    const failover=new FailoverUpstream(p.primary,secondary.upstream,{headersTimeoutMs:10000,timeoutThreshold:3,failureThreshold:3});
    for(let i=0;i<3;i++) {
      p.outcomes.push({kind:'hang'});
      const controller=new AbortController();const call=failover.complete({messages},controller.signal,{deadlineAt:Date.now()+30000});
      await flush();jest.setSystemTime(Date.now()+10000);controller.abort(deadlineError());
      await expect(call).rejects.toMatchObject({name:'DeadlineExceeded'});await flush();
    }
    expect(p.calls.health).toBe(1);expect(failover.failoverMetrics().breaker).toMatchObject({state:'open',opened:1});
    expect(secondary.calls.n).toBe(0);
  });
  test('8: the secondary is used only with ≥ 3.5 s left; without it nothing is sent (marked) or the primary failure stands (unmarked)',async()=>{
    fake();
    const p=scripted();const secondary=countingSecondary();
    const failover=new FailoverUpstream(p.primary,secondary.upstream,{failureThreshold:1,cooldownMs:600000});
    p.outcomes.push({kind:'refused'});
    expect((await failover.complete({messages},new AbortController().signal)).upstream).toBe('secondary'); // breaker opens
    expect(secondary.calls.n).toBe(1);
    // Breaker open, nothing tried: too little time is a marked refusal.
    await expect(failover.complete({messages},new AbortController().signal,{deadlineAt:Date.now()+3499})).rejects.toMatchObject({code:'GATEWAY_DEADLINE'});
    expect(secondary.calls.n).toBe(1);
    expect((await failover.complete({messages},new AbortController().signal,{deadlineAt:Date.now()+3500})).upstream).toBe('secondary');
    expect(secondary.calls.n).toBe(2);
    // A primary connect failure that took 5 s: 3.4 s left → no secondary, the connect error stands; 3.6 s left → secondary.
    const slow=scripted();const second=countingSecondary();
    const pool=new FailoverUpstream(slow.primary,second.upstream,{failureThreshold:10});
    slow.outcomes.push({kind:'refused',costMs:5000},{kind:'refused',costMs:5000});
    await expect(pool.complete({messages},new AbortController().signal,{deadlineAt:Date.now()+8400})).rejects.toBeInstanceOf(UpstreamConnectError);
    expect(second.calls.n).toBe(0);
    expect((await pool.complete({messages},new AbortController().signal,{deadlineAt:Date.now()+8600})).upstream).toBe('secondary');
    expect(second.calls.n).toBe(1);expect(pool.failoverMetrics().failovers).toEqual({connect_refused:1});
  });
});
