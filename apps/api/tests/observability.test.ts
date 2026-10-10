import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import type { Persona } from '@ptr/contracts';
import { ChatService, InMemoryConversationStore, InMemoryPersonaRepository, TurnWorker, type TextProvider } from '@ptr/core';
import { LiteLLMTextProvider } from '@ptr/providers';
import { parseExposition, PROM_CONTENT_TYPE } from '@ptr/ops';
import { createApiApplication } from '../src/app';
import { workerMaintenanceObservability, workerObservability } from '../src/observability';
import { publicTurn } from '../src/public-turn';
import type {SplitApiRuntime} from '../src/split-runtime';
import {splitRuntimeFixture} from './split-runtime-fixture';

// : exact /metrics/prom names per role (plus the common pair).
const COMMON=['ptr_build_info','process_start_time_seconds'];
const API_NAMES=[...COMMON,'ptr_http_requests_total','ptr_turns_created_total','ptr_sse_streams_open','ptr_owner_rejected_total'];
const WORKER_NAMES=[...COMMON,'ptr_turns_finished_total','ptr_turn_duration_seconds','ptr_turn_queue_wait_seconds','ptr_turns_inflight',
  'ptr_safety_fallback_total','ptr_reply_guard_total','ptr_model_calls_total'];
const MAINTENANCE_NAMES=[...COMMON,'ptr_dispatch_requeued_total','ptr_dispatch_failed_total','ptr_outbox_republished_total','ptr_queue_waiting',
  'ptr_oldest_pending_age_seconds'];
const SENTINEL='SENTINEL-사용자-문장';
const token='synthetic_api_token_abcdefghijklmnop', productionToken='production_api_token_abcdefghijklmnop';
const persona:Persona={id:'persona_synthetic_o',personId:'person_synthetic_o',label:'Synthetic O',language:'ko',revision:'v1',reviewStatus:'synthetic',
  identity:'Fictional',concept:'Observability test',style:['brief'],boundaries:['AI disclosure'],sourceRefs:[],greeting:'안녕하세요.'};
const names=(text:string)=>[...parseExposition(text).types.keys()].sort();
const value=(text:string,name:string,labels:Record<string,string>={})=>parseExposition(text).samples
  .find(sample=>sample.name===name&&Object.entries(labels).every(([key,v])=>sample.labels[key]===v))?.value;
const until=async(check:()=>boolean|Promise<boolean>,ms=3000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not met');};

describe('api /metrics/prom and health ',()=>{
  let app:INestApplication;let base:string;let runtime:SplitApiRuntime;let health:{database:boolean;redis:boolean};let fixture:ReturnType<typeof splitRuntimeFixture>;
  beforeEach(async()=>{
    fixture=splitRuntimeFixture(persona);runtime=fixture.runtime;health={database:true,redis:true};runtime.health=async()=>health;
    app=await createApiApplication(runtime,productionToken,{syntheticToken:token});await app.listen(0,'127.0.0.1');base=await app.getUrl();
  });
  afterEach(async()=>{await app.close();});
  const call=(path:string,options:{method?:string;body?:unknown;owner?:string;auth?:string}={})=>fetch(`${base}/api/${path}`,{method:options.method??'GET',
    headers:{Authorization:options.auth??`Bearer ${token}`,'X-PTR-Owner':options.owner??'lt-obs','Content-Type':'application/json'},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
  const scrape=async()=>{const response=await fetch(`${base}/metrics/prom`);expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe(PROM_CONTENT_TYPE);return response.text();};

  test('no token needed; exact names; requests by route and status class, turns created, owner rejections by reason; no text',async()=>{
    expect(names(await scrape())).toEqual([...API_NAMES].sort());
    const session=await (await call('sessions',{method:'POST',body:{personId:persona.personId}})).json() as {session:{id:string}};
    const sent=await (await call(`sessions/${session.session.id}/turns`,{method:'POST',body:{clientRequestId:'c1',text:SENTINEL}})).json() as {turn:{id:string}};
    await call(`sessions/${session.session.id}/turns`,{method:'POST',body:{clientRequestId:'c1',text:SENTINEL}}); // idempotent repeat: not a new turn
    expect((await call('personas',{owner:'local-'+'0'.repeat(40)})).status).toBe(403); // web owner on the harness token
    expect((await call('personas',{owner:'../x'})).status).toBe(403);
    expect((await fetch(`${base}/api/personas`,{headers:{Authorization:`Bearer ${token}`}})).status).toBe(403);
    expect((await call('personas',{auth:'Bearer wrong'})).status).toBe(403);
    const text=await scrape();
    expect(text).not.toContain('SENTINEL');expect(text).not.toContain(sent.turn.id);
    expect(value(text,'ptr_turns_created_total')).toBe(1);
    expect(value(text,'ptr_http_requests_total',{route:'send_turn',status_class:'2xx'})).toBe(2);
    expect(value(text,'ptr_http_requests_total',{route:'sessions',status_class:'2xx'})).toBe(1);
    expect(value(text,'ptr_http_requests_total',{route:'personas',status_class:'4xx'})).toBe(4);
    expect(value(text,'ptr_owner_rejected_total',{reason:'space'})).toBe(1);
    expect(value(text,'ptr_owner_rejected_total',{reason:'format'})).toBe(1);
    expect(value(text,'ptr_owner_rejected_total',{reason:'missing'})).toBe(1);
  });
  test('SSE streams open are a gauge that falls back when the client leaves',async()=>{
    const session=await (await call('sessions',{method:'POST',body:{personId:persona.personId}})).json() as {session:{id:string}};
    fixture.hold=true; // Synthetic Python job waits, so the stream stays open
    const sent=await (await call(`sessions/${session.session.id}/turns`,{method:'POST',body:{clientRequestId:'c2',text:'안녕'}})).json() as {turn:{id:string}};
    const controller=new AbortController();
    const stream=await fetch(`${base}/api/turns/${sent.turn.id}/events`,{headers:{Authorization:`Bearer ${token}`,'X-PTR-Owner':'lt-obs'},signal:controller.signal});
    expect(stream.status).toBe(200);
    await until(async()=>value(await scrape(),'ptr_sse_streams_open')===1);
    controller.abort();
    await until(async()=>value(await scrape(),'ptr_sse_streams_open')===0);
    await call(`turns/${sent.turn.id}/cancel`,{method:'POST',body:{}});
  });
  test('/api/health is 503 when the database or Redis check fails (D23); the body names which',async()=>{
    expect((await call('health')).status).toBe(200);
    health={database:false,redis:true};
    const down=await call('health');expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ok:false,service:'persona-timeline-rag',liveEnabled:false,checks:{database:'down',redis:'ok'}});
    health={database:true,redis:false};
    expect((await call('health')).status).toBe(503);
  });
  test.each([true,false])('health reports the actual LiteLLM billable flag (%s), not the retired provider route',async billable=>{
    runtime.providerName='litellm';runtime.billable=billable;
    expect((await (await call('health')).json()).liveEnabled).toBe(billable);
  });
});

describe('worker and outbox observability',()=>{
  test('worker: exact names; finished by outcome and code, durations, model calls by upstream, reply guard, safety fallback; JSON logs with turnId only',async()=>{
    const lines:string[]=[];
    const observed=workerObservability({activeTurns:()=>2,write:line=>lines.push(line)});
    expect(names(await observed.render())).toEqual([...WORKER_NAMES].sort());
    const store=new InMemoryConversationStore();
    let fail=false;
    const provider:TextProvider={generate:async(_messages,options)=>{if(fail) throw Object.assign(new Error(SENTINEL),{code:'PROVIDER_TRANSPORT'});options.onServed?.('secondary');return '반가워요.';}};
    const chat=new ChatService({store,personas:new InMemoryPersonaRepository([persona]),provider,timeoutMs:1000,leases:store,delivery:{publish:async()=>undefined,backlog:async()=>0},
      ...observed.chatHooks});
    const worker=new TurnWorker({chat,leases:store,workerId:'w',leaseMs:500,onFinished:observed.onFinished});
    const session=await chat.createSession('lt-obs',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
    const ok=await chat.submitTurn('lt-obs',{sessionId:session.id,clientRequestId:'a',text:SENTINEL});await worker.handle(ok.dispatch!);
    fail=true;
    const bad=await chat.submitTurn('lt-obs',{sessionId:session.id,clientRequestId:'b',text:SENTINEL});await worker.handle(bad.dispatch!);
    observed.chatHooks.onSafetyFallback({scope:'turn',reason:'timeout'});
    const text=await observed.render();
    expect(value(text,'ptr_turns_finished_total',{outcome:'completed',code:'none'})).toBe(1);
    expect(value(text,'ptr_turns_finished_total',{outcome:'failed',code:'PROVIDER_TRANSPORT'})).toBe(1);
    expect(value(text,'ptr_turn_duration_seconds_count')).toBe(2);expect(value(text,'ptr_turn_queue_wait_seconds_count')).toBe(2);
    expect(value(text,'ptr_turns_inflight')).toBe(2);
    expect(value(text,'ptr_model_calls_total',{upstream_kind:'secondary'})).toBe(1);
    expect(value(text,'ptr_safety_fallback_total',{scope:'turn',reason:'timeout'})).toBe(1);
    expect(text).not.toContain('SENTINEL');
    const events=lines.map(line=>JSON.parse(line));
    expect(events.filter(event=>event.event==='turn_finished').map(event=>[event.turnId,event.outcome,event.code])).toEqual([[ok.turn.id,'completed','none'],[bad.turn.id,'failed','PROVIDER_TRANSPORT']]);
    expect(events).toContainEqual(expect.objectContaining({role:'worker',event:'input_safety_fallback',scope:'turn',reason:'timeout'}));
    expect(lines.join('')).not.toContain('SENTINEL');expect(lines.join('')).not.toContain('사용자');
  });
  test('reply guard outcomes are counted by action and reason',async()=>{
    const observed=workerObservability({activeTurns:()=>0,write:()=>undefined});
    const reply=(replyGuard?:{revision:string;action:'none'|'replaced'|'edited';reason?:'meta_talk'})=>({sessionId:'s',turnId:'t',messageId:'m',personId:'p',personaRevision:'v',
      responseKind:'small_talk' as const,status:'answered' as const,content:SENTINEL,claims:[],evidence:[],limitations:[],...(replyGuard?{replyGuard}:{})});
    observed.chatHooks.onTurnCompleted({turnId:'t1',reply:reply({revision:'r',action:'edited',reason:'meta_talk'})});
    observed.chatHooks.onTurnCompleted({turnId:'t2',reply:reply({revision:'r',action:'none'})});
    observed.chatHooks.onTurnCompleted({turnId:'t3',reply:reply()});
    const text=await observed.render();
    expect(value(text,'ptr_reply_guard_total',{action:'edited',reason:'meta_talk'})).toBe(1);
    expect(value(text,'ptr_reply_guard_total',{action:'none',reason:'none'})).toBe(1);
    expect(parseExposition(text).samples.filter(sample=>sample.name==='ptr_reply_guard_total')).toHaveLength(2);
  });
  test('worker maintenance: exact names; requeues, failures by code, republished; queue gauges read at scrape time, a failing source is left out',async()=>{
    const lines:string[]=[];let backlog:number|Error=7;
    const observed=workerMaintenanceObservability(workerObservability({activeTurns:()=>0}).registry,{queueWaiting:async()=>{if(backlog instanceof Error) throw backlog;return backlog;},oldestPendingAgeSeconds:async()=>12.5,write:line=>lines.push(line)});
    expect(names(await observed.render())).toEqual([...new Set([...WORKER_NAMES,...MAINTENANCE_NAMES])].sort());
    observed.onEvent({type:'requeued',turnId:'t1'});observed.onEvent({type:'failed',turnId:'t2',errorCode:'QUEUE_TIMEOUT'});
    observed.onEvent({type:'failed',turnId:'t3',errorCode:'WORKER_LOST'});observed.onEvent({type:'republished',turnId:'t4'});
    let text=await observed.render();
    expect(value(text,'ptr_dispatch_requeued_total')).toBe(1);expect(value(text,'ptr_outbox_republished_total')).toBe(1);
    expect(value(text,'ptr_dispatch_failed_total',{code:'QUEUE_TIMEOUT'})).toBe(1);expect(value(text,'ptr_dispatch_failed_total',{code:'WORKER_LOST'})).toBe(1);
    expect(value(text,'ptr_queue_waiting')).toBe(7);expect(value(text,'ptr_oldest_pending_age_seconds')).toBe(12.5);
    backlog=new Error('redis down');text=await observed.render();
    expect(value(text,'ptr_queue_waiting')).toBeUndefined();expect(text).toContain('# TYPE ptr_queue_waiting gauge');
    expect(lines.map(line=>JSON.parse(line)).map(({event,turnId,code})=>[event,turnId,code])).toEqual([['turn_requeued','t1',undefined],
      ['turn_failed','t2','QUEUE_TIMEOUT'],['turn_failed','t3','WORKER_LOST'],['turn_republished','t4',undefined]]);
  });
});

describe('turnId correlation through the real LangChain proxy transport',()=>{
  const servers:Server[]=[];
  afterEach(async()=>{await Promise.all(servers.splice(0).map(server=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));}));});
  test('worker records LiteLLM serving and sanitized logs while public DTO omits serving',async()=>{
    const workerLines:string[]=[];let requests=0;
    const proxy=createServer((_req,res)=>{
      requests++;res.writeHead(200,{'content-type':'application/json'});
      res.end(JSON.stringify({id:'synthetic-1',object:'chat.completion',created:1,model:'synthetic-model',
        choices:[{index:0,message:{role:'assistant',content:'반가워요.'},finish_reason:'stop'}],
        usage:{prompt_tokens:12,completion_tokens:4,total_tokens:16}}));
    });
    servers.push(proxy);await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    const provider=new LiteLLMTextProvider({baseUrl:`http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1`,model:'synthetic-model',apiKey:'synthetic-token'});
    const observed=workerObservability({activeTurns:()=>0,write:line=>workerLines.push(line)});
    const store=new InMemoryConversationStore();
    const chat=new ChatService({store,personas:new InMemoryPersonaRepository([persona]),provider,leases:store,delivery:{publish:async()=>undefined,backlog:async()=>0},...observed.chatHooks});
    const session=await chat.createSession('lt-obs',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
    const {turn,dispatch}=await chat.submitTurn('lt-obs',{sessionId:session.id,clientRequestId:'corr',text:SENTINEL});
    await new TurnWorker({chat,leases:store,workerId:'w',leaseMs:1000,onFinished:observed.onFinished}).handle(dispatch!);
    const finished=workerLines.map(line=>JSON.parse(line)).find(event=>event.event==='turn_finished')!;
    expect(finished.turnId).toBe(turn.id);expect(requests).toBe(1);
    const done=await chat.getTurn('lt-obs',turn.id);
    expect(done.reply?.serving).toEqual({calls:1,upstreams:['litellm'],secondaryCalls:0});
    expect(publicTurn(done).reply).not.toHaveProperty('serving');
    expect(JSON.stringify(publicTurn(done))).not.toContain('serving');
    expect(workerLines.join('')).not.toContain('SENTINEL');
    expect(value(await observed.render(),'ptr_model_calls_total',{upstream_kind:'litellm'})).toBe(1);
  });
});

test('metric registries are isolated and reject model/user sentinels as outcome labels',async()=>{
  const first=workerObservability({activeTurns:()=>1,write:()=>undefined});
  const second=workerObservability({activeTurns:()=>0,write:()=>undefined});
  first.chatHooks.onTurnFailure({turnId:'synthetic-turn',code:SENTINEL});
  first.chatHooks.onSafetyFallback({scope:'turn',reason:SENTINEL});
  first.onFinished({turnId:'synthetic-turn',durationMs:NaN,queueWaitMs:Infinity});
  const text=await first.render(), other=await second.render();
  expect(text).not.toContain('SENTINEL');expect(text).not.toContain('synthetic-turn');
  expect(value(text,'ptr_turns_finished_total',{outcome:'failed',code:'UNSPECIFIED'})).toBe(1);
  expect(value(other,'ptr_turns_finished_total')).toBeUndefined();
  expect(value(text,'ptr_turn_duration_seconds_count')).toBe(0);
  expect(value(text,'ptr_turn_queue_wait_seconds_count')).toBe(0);
});
