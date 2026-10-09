import type { INestApplication } from '@nestjs/common';
import type { Persona, ChatSession, ChatTurn, ChatMessage } from '@ptr/contracts';
import { ChatService, InMemoryConversationStore, InMemoryPersonaRepository, SAFETY_CATEGORIES, SAFETY_DEFLECTION_NOTE, createLocalChat, safetyReply, type SafetyAssessInput, type SafetyScores, type TurnEvent } from '@ptr/core';
const ChatServiceGetTurn=ChatService.prototype.getTurn;
import { FakeTextProvider } from '@ptr/providers';
import { createApiApplication } from '../src/app';
import type { ApiRuntime, CreativeArtifact } from '../src/runtime';
// Two owner spaces : the web's production token sends `local-<40 hex>` owners only; this harness token
// (PTR_API_SYNTHETIC_TOKEN) sends synthetic owners only. Most tests use the harness token.
const token='synthetic_api_token_abcdefghijklmnop';
const productionToken='production_api_token_abcdefghijklmnop';
const webOwner='local-0123456789abcdef0123456789abcdef01234567';
const persona:Persona={id:'persona_synthetic_a',personId:'person_synthetic_a',label:'Synthetic Painter',language:'ko',revision:'synthetic-v1',reviewStatus:'synthetic',identity:'Fictional',concept:'Synthetic conversation',style:['brief'],boundaries:['AI disclosure'],sourceRefs:[],greeting:'안녕하세요.'};
let app:INestApplication;let base:string;let runtime:ApiRuntime;let artifacts:CreativeArtifact[];
async function call(path:string,options:{method?:string;body?:unknown;owner?:string;auth?:string}={}) {
  const response=await fetch(`${base}/api/${path}`,{method:options.method??'GET',headers:{Authorization:options.auth??`Bearer ${token}`,'X-PTR-Owner':options.owner??'owner_synthetic_a','Content-Type':'application/json'},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
  return {status:response.status,body:await response.json() as {session:ChatSession;turn:ChatTurn;personas:(Persona & {aiDisclosure:string})[];history:ChatMessage[];sessions:ChatSession[];artifact:CreativeArtifact;image:{code:string};cancelled:boolean}};
}
async function waitTurn(id:string):Promise<ChatTurn> {
  for(let i=0;i<100;i++) {const result=await call(`turns/${id}`);if(['completed','cancelled','failed'].includes(result.body.turn.state)) return result.body.turn;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('Synthetic turn did not settle');
}
beforeEach(async()=>{
  const store=new InMemoryConversationStore();const personas=new InMemoryPersonaRepository([persona]);const provider=new FakeTextProvider();artifacts=[];
  const chat=createLocalChat({store,personas,provider});runtime={chat,leases:store,delivery:chat.delivery,events:chat.events,eventSource:chat.events,personas,provider,providerName:'fake',model:'synthetic/fake',listPersonas:async()=>[persona],saveArtifact:async artifact=>{artifacts.push(artifact);}};
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token});await app.listen(0,'127.0.0.1');base=await app.getUrl();
});
afterEach(async()=>{await app.close();});
test('health safe; authentication required and invalid owner rejected',async()=>{
  expect((await call('health',{auth:'bad'})).body).toEqual({ok:true,service:'persona-timeline-rag',liveEnabled:false});
  expect((await call('personas',{auth:'Bearer wrong'})).status).toBe(403);
  expect((await call('personas',{owner:'../unsafe'})).status).toBe(403);
  const listed=await call('personas');expect(listed.status).toBe(200);expect(listed.body.personas[0].aiDisclosure).toContain('AI');expect(listed.body.personas[0].identity).toBeUndefined();
});
test('owner spaces: the production token takes only web owners, the harness token only synthetic owners ',async()=>{
  const production=`Bearer ${productionToken}`;
  expect((await call('personas',{auth:production,owner:webOwner})).status).toBe(200);
  for(const owner of ['lt-x','owner_synthetic_a','local-'+'0'.repeat(39),'local-'+'A'.repeat(40),'local-'+'0'.repeat(41),'../unsafe'])
    expect([owner,(await call('personas',{auth:production,owner})).status]).toEqual([owner,403]);
  for(const owner of ['lt-x','lt-1a2b3c4d','owner_synthetic_a','owner_synthetic_other']) expect([owner,(await call('personas',{owner})).status]).toEqual([owner,200]);
  for(const owner of [webOwner,'lt-','lt-UPPER','owner_synthetic_','smoke-owner-1','lt-'+'a'.repeat(41)])
    expect([owner,(await call('personas',{owner})).status]).toEqual([owner,403]);
  const refused=await call('personas',{auth:production,owner:'lt-x'});expect(refused.body).toEqual({error:{code:'UNAUTHORIZED'}});
  // Without a harness token only the production space exists.
  await app.close();
  app=await createApiApplication(runtime,productionToken);await app.listen(0,'127.0.0.1');base=await app.getUrl();
  expect((await call('personas',{owner:'owner_synthetic_a'})).status).toBe(403);
  expect((await call('personas',{auth:production,owner:webOwner})).status).toBe(200);
});
test('the harness token must differ from the production token and pass the token length rule',async()=>{
  await expect(createApiApplication(runtime,productionToken,{syntheticToken:productionToken})).rejects.toThrow();
  await expect(createApiApplication(runtime,productionToken,{syntheticToken:'short'})).rejects.toThrow();
});
test('sessions pin server persona revision, owner isolation and completed history',async()=>{
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId}});expect(created.status).toBe(201);
  const id=created.body.session.id;expect(created.body.session.ownerId).toBeUndefined();expect(created.body.session.personaRevision).toBe(persona.revision);expect(created.body.session.retrievalMode).toBe('off');
  const sent=await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'synthetic_request_1',text:'안녕'}});const final=await waitTurn(sent.body.turn.id);expect(final.state).toBe('completed');expect(sent.body.turn.ownerId).toBeUndefined();
  const repeated=await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'synthetic_request_1',text:'안녕'}});expect(repeated.body.turn.id).toBe(sent.body.turn.id);
  expect((await call(`sessions/${id}`)).body.history).toHaveLength(3);
  expect((await call(`sessions/${id}`,{owner:'owner_synthetic_b'})).status).toBe(404);
  expect((await call(`turns/${sent.body.turn.id}`,{owner:'owner_synthetic_b'})).status).toBe(404);
  expect((await call('sessions',{owner:'owner_synthetic_b'})).body.sessions).toEqual([]);
});
test('owner/person/revision spoofing and invalid range reject without provider calls',async()=>{
  expect((await call('sessions',{method:'POST',body:{personId:persona.personId,ownerId:'other'}})).status).toBe(400);
  expect((await call('sessions',{method:'POST',body:{personId:persona.personId,personaRevision:'spoof'}})).status).toBe(400);
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId}});const id=created.body.session.id;
  expect((await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'x',text:'hi',sessionId:'other'}})).status).toBe(400);
  expect((await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'x',text:'hi',ownerId:'other'}})).status).toBe(400);
  expect((await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'x',text:'게시',timeline:{dateBasis:'posted',start:'2020-02-30',end:'2020-03-01'}}})).status).toBe(400);
  expect((runtime.provider as FakeTextProvider).calls).toBe(0);
});
test('off factual query abstains without provider; turn and cancelled terminal state projection',async()=>{
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId,executionProfile:'legacy'}});const id=created.body.session.id;
  const sent=await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'x',text:'2020년 어디 여행했어?'}});
  const final=await waitTurn(sent.body.turn.id);expect(final.reply?.status).toBe('insufficient_evidence');expect((runtime.provider as FakeTextProvider).calls).toBe(0);
  expect((await call(`turns/${sent.body.turn.id}/cancel`,{method:'POST',body:{}})).body.cancelled).toBe(false);
});
test('fictional draft saved outside source corpus, private owner omitted; no image calls',async()=>{
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId}});const id=created.body.session.id;
  const drafted=await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'합성 그림 전시 소개'}});
  expect(drafted.status).toBe(201);expect(drafted.body.artifact.origin).toBe('generated');expect(drafted.body.artifact.fictional).toBe(true);expect(drafted.body.artifact.content).toContain('가상 포스트');expect(drafted.body.artifact.ownerId).toBeUndefined();
  expect(artifacts).toHaveLength(1);expect(artifacts[0].ownerId).toBe('owner_synthetic_a');expect(drafted.body.image.code).toBe('IMAGE_RUNNER_ONLY');
  expect((await call(`sessions/${id}`)).body.history).toHaveLength(1);
  expect((await call(`sessions/${id}/drafts`,{method:'POST',owner:'owner_synthetic_b',body:{brief:'hi'}})).status).toBe(404);
});
test('malformed/oversize body and provider errors do not reveal raw data',async()=>{
  const bad=await fetch(`${base}/api/sessions`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-PTR-Owner':'owner_synthetic_a'},body:'{bad json'});expect(bad.status).toBe(400);expect(await bad.text()).not.toContain('bad json');
  const huge=await call('sessions',{method:'POST',body:{personId:'a'.repeat(20000)}});expect(huge.status).toBe(413);expect(JSON.stringify(huge.body)).not.toContain('aaaa');
  runtime.listPersonas=async()=>{throw new Error('postgres://private credentials raw');};const failed=await call('personas');expect(failed.status).toBe(500);expect(failed.body).toEqual({error:{code:'INTERNAL_ERROR'}});
});
test('pending-start API supports poll/cancel, and late provider output never reaches history',async()=>{
  let resolve!:(value:string)=>void;let signal!:AbortSignal;
  const provider={generate:(_messages:unknown,_options:{signal:AbortSignal})=>{signal=_options.signal;return new Promise<string>(r=>{resolve=r;});}};
  runtime.chat=createLocalChat({store:new InMemoryConversationStore(),personas:runtime.personas,provider});
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId}});const id=created.body.session.id;
  const pending=await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'pending_synthetic',text:'안녕'}});
  expect(['pending','generating']).toContain(pending.body.turn.state);expect(pending.body.turn.reply).toBeUndefined();
  expect((await call(`turns/${pending.body.turn.id}/cancel`,{method:'POST',body:{}})).body.cancelled).toBe(true);expect(signal.aborted).toBe(true);
  resolve('late result');await new Promise(r=>setTimeout(r,5));
  expect((await call(`turns/${pending.body.turn.id}`)).body.turn.state).toBe('cancelled');expect((await call(`sessions/${id}`)).body.history).toHaveLength(1);
});
test('draft provider failure is sanitized 502; credential-like input rejected before storage/model',async()=>{
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId}});const id=created.body.session.id;
  expect((await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'secret',text:'api_key=synthetic_secret'}})).status).toBe(400);
  expect((await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'api_key=synthetic_secret'}})).status).toBe(400);
  expect((runtime.provider as FakeTextProvider).calls).toBe(0);
  runtime.provider={generate:async()=>{throw new Error('sk-synthetic_secret_do_not_expose');}};
  const failed=await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'합성 그림 이야기'}});expect(failed.status).toBe(502);expect(failed.body).toEqual({error:{code:'TURN_FAILED'}});expect(artifacts).toEqual([]);
});

test('explicit conditions persist, default algorithm consistently, reject contradictions and stay owner-private',async()=>{
  for(const ragCondition of ['off','caption','caption_image']) {
    const created=await call('sessions',{method:'POST',body:{personId:persona.personId,ragCondition}});
    expect(created.status).toBe(201);expect(created.body.session.ragCondition).toBe(ragCondition);
    expect(created.body.session.retrievalMode).toBe(ragCondition==='off'?'off':'semantic');
    expect((await call(`sessions/${created.body.session.id}`)).body.session.ragCondition).toBe(ragCondition);
    expect((await call(`sessions/${created.body.session.id}`,{owner:'owner_synthetic_other'})).status).toBe(404);
  }
  for(const body of [{ragCondition:'off',retrievalMode:'semantic'},{ragCondition:'caption',retrievalMode:'off'},{ragCondition:'caption_image',retrievalMode:'off'}]) expect((await call('sessions',{method:'POST',body:{personId:persona.personId,...body}})).status).toBe(400);
});
test('explicit off invokes provider for factual comparison and exposes unverified actual answer without evidence',async()=>{
  const provider={generate:jest.fn(async()=>JSON.stringify({status:'answered',answer:'이 모델 응답은 실제 방문 사실로 검증되지 않았습니다.',evidenceRefs:[]}))};
  const retrieval={search:jest.fn(async()=>[])};
  runtime.chat=createLocalChat({store:new InMemoryConversationStore(),personas:runtime.personas,provider,retrieval});
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId,ragCondition:'off',executionProfile:'legacy'}});const id=created.body.session.id;
  const sent=await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'experiment-off',text:'2020년 어디 여행했어?'}});
  const final=await waitTurn(sent.body.turn.id);
  expect(final.reply?.content).toContain('이 모델 응답');expect(final.reply?.grounding).toBe('unverified_model');expect(final.reply?.evidence).toEqual([]);expect(final.reply?.claims).toEqual([]);
  expect(provider.generate).toHaveBeenCalledTimes(1);expect(retrieval.search).not.toHaveBeenCalled();
  expect((await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'override',text:'hello',ragCondition:'caption_image'}})).status).toBe(400);
});

test('new API sessions default agent_loop; explicit legacy remains pinned; internal agent fields never leave poll/replay/history',async()=>{
  const secretSummary='synthetic-internal-summary';const privateTopic='synthetic-internal-topic';
  const provider={generate:async()=>JSON.stringify({status:'answered',message:'안녕! 편하게 이야기해요.',evidenceRefs:[],reasoning:secretSummary,variableUpdates:{conversationTopic:privateTopic,tone:'warm'}})};
  runtime.chat=createLocalChat({store:new InMemoryConversationStore(),personas:runtime.personas,provider});
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId,ragCondition:'off'}});
  expect(created.body.session.executionProfile).toBe('agent_loop');const sessionId=created.body.session.id;
  const input={clientRequestId:'internal-fields',text:'안녕'};
  const sent=await call(`sessions/${sessionId}/turns`,{method:'POST',body:input});const finished=await waitTurn(sent.body.turn.id);
  const internal=await runtime.chat.getTurn('owner_synthetic_a',finished.id);
  expect(internal.reply?.agent?.decisionSummary).toBe(secretSummary);expect(internal.reply?.agent?.variables.conversationTopic).toBe(privateTopic);
  for(const result of [finished,(await call(`turns/${finished.id}`)).body,(await call(`sessions/${sessionId}/turns`,{method:'POST',body:input})).body,(await call(`sessions/${sessionId}`)).body]) {
    expect(JSON.stringify(result)).not.toContain(secretSummary);expect(JSON.stringify(result)).not.toContain(privateTopic);expect(JSON.stringify(result)).not.toContain('"agent"');
  }
  const legacy=await call('sessions',{method:'POST',body:{personId:persona.personId,executionProfile:'legacy'}});
  expect(legacy.body.session.executionProfile).toBe('legacy');
  expect((await call(`sessions/${sessionId}/turns`,{method:'POST',body:{clientRequestId:'bad-profile',text:'안녕',executionProfile:'legacy'}})).status).toBe(400);
});

type SseEvent={event:string;data:{state?:string;id?:string;reply?:{content?:string};[key:string]:unknown}};
/** Reads an SSE response to its end (or until limitMs) and parses `event:`/`data:` frames; comments are skipped. */
async function readSse(url:string,owner='owner_synthetic_a',limitMs=3000):Promise<{status:number;type:string|null;events:SseEvent[];closed:boolean}> {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),limitMs);
  const response=await fetch(url,{headers:{Authorization:`Bearer ${token}`,'X-PTR-Owner':owner},signal:controller.signal});
  const events:SseEvent[]=[];let closed=false;let text='';
  if(response.headers.get('content-type')?.startsWith('text/event-stream')) {
    const reader=response.body!.getReader();const decoder=new TextDecoder();
    try {for(;;){const {done,value}=await reader.read();if(done){closed=true;break;}text+=decoder.decode(value,{stream:true});}} catch {/* aborted at limit */}
    for(const frame of text.split('\n\n')) {
      const lines=frame.split('\n').filter(line=>line&&!line.startsWith(':'));
      const event=lines.find(line=>line.startsWith('event: '))?.slice(7);const data=lines.find(line=>line.startsWith('data: '))?.slice(6);
      if(event&&data) events.push({event,data:JSON.parse(data)});
    }
  } else await response.text();
  clearTimeout(timer);
  return {status:response.status,type:response.headers.get('content-type'),events,closed};
}
function blockedProvider() {
  let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  return {provider:{generate:async()=>{await gate;return '반가워요.';}},release};
}
function useChat(chat:ReturnType<typeof createLocalChat>,store:InMemoryConversationStore) {
  Object.assign(runtime,{chat,leases:store,delivery:chat.delivery,events:chat.events,eventSource:chat.events});
}
test('SSE: a turn streams its state changes and the final public turn, then the server closes the stream',async()=>{
  const store=new InMemoryConversationStore();const {provider,release}=blockedProvider();
  useChat(createLocalChat({store,personas:runtime.personas,provider}),store);
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId,executionProfile:'legacy'}});const id=created.body.session.id;
  const sent=await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'sse_1',text:'안녕'}});
  const reading=readSse(`${base}/api/turns/${sent.body.turn.id}/events`);
  await new Promise(r=>setTimeout(r,50));release();
  const {status,type,events,closed}=await reading;
  expect(status).toBe(200);expect(type).toMatch(/^text\/event-stream/);expect(closed).toBe(true);
  expect(events[0]!.event).toBe('turn');
  const last=events.at(-1)!;expect(last.event).toBe('turn');expect(last.data.state).toBe('completed');expect(last.data.reply?.content).toBe('반가워요.');
  const states=events.filter(e=>e.event==='state');expect(states.length).toBeGreaterThan(0);
  for(const e of states) expect(Object.keys(e.data).sort()).toEqual(['state']);
  expect(JSON.stringify(events)).not.toContain('"agent"');expect(JSON.stringify(events)).not.toContain('ownerId');
});
test('SSE: an already ended turn yields one snapshot and closes; another owner gets a plain 404',async()=>{
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId}});const id=created.body.session.id;
  const sent=await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'sse_2',text:'안녕'}});const final=await waitTurn(sent.body.turn.id);
  const done=await readSse(`${base}/api/turns/${final.id}/events`);
  expect(done.closed).toBe(true);expect(done.events).toHaveLength(1);expect(done.events[0]!.data.state).toBe('completed');
  const other=await readSse(`${base}/api/turns/${final.id}/events`,'owner_synthetic_b');
  expect(other.status).toBe(404);expect(other.type).toMatch(/^application\/json/);
});
test('SSE: if pub/sub notices are lost, the periodic store re-check still delivers the end of the turn',async()=>{
  const store=new InMemoryConversationStore();const {provider,release}=blockedProvider();
  const chat=createLocalChat({store,personas:runtime.personas,provider});
  const silent:ApiRuntime={...runtime,chat,leases:store,delivery:chat.delivery,events:chat.events,eventSource:{subscribe:async()=>()=>undefined}};
  const quiet=await createApiApplication(silent,productionToken,{syntheticToken:token,sse:{recheckMs:50}});await quiet.listen(0,'127.0.0.1');const quietBase=await quiet.getUrl();
  try {
    const session=await chat.createSession('owner_synthetic_a',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC',executionProfile:'legacy'});
    const turn=await chat.startTurn('owner_synthetic_a',{sessionId:session.id,clientRequestId:'sse_3',text:'안녕'});
    const reading=readSse(`${quietBase}/api/turns/${turn.id}/events`);
    await new Promise(r=>setTimeout(r,30));release();
    const {events,closed}=await reading;
    expect(closed).toBe(true);expect(events.at(-1)!.data.state).toBe('completed');
  } finally {await quiet.close();}
});

test('SSE: a client gone during the ownership check leaves no subscription behind; a failing subscribe still streams via store re-checks',async()=>{
  const store=new InMemoryConversationStore();const {provider,release}=blockedProvider();
  const chat=createLocalChat({store,personas:runtime.personas,provider});
  let active=0,subscribes=0;let failSubscribe=false;
  const counting={subscribe:async(turnId:string,listener:(e:TurnEvent)=>void)=>{
    subscribes++;if(failSubscribe)throw new Error('redis down');active++;const off=await chat.events.subscribe(turnId,listener);return ()=>{active--;off();};}};
  const app2=await createApiApplication({...runtime,chat,leases:store,delivery:chat.delivery,events:chat.events,eventSource:counting},productionToken,{syntheticToken:token,sse:{recheckMs:40}});
  await app2.listen(0,'127.0.0.1');const base2=await app2.getUrl();
  try {
    const session=await chat.createSession('owner_synthetic_a',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC',executionProfile:'legacy'});
    const turn=await chat.startTurn('owner_synthetic_a',{sessionId:session.id,clientRequestId:'sse_gone',text:'안녕'});
    const slow=jest.spyOn(chat,'getTurn');slow.mockImplementationOnce(async(owner,id)=>{await new Promise(r=>setTimeout(r,150));return ChatServiceGetTurn.call(chat,owner,id);});
    const controller=new AbortController();
    const gone=fetch(`${base2}/api/turns/${turn.id}/events`,{headers:{Authorization:`Bearer ${token}`,'X-PTR-Owner':'owner_synthetic_a'},signal:controller.signal}).catch(()=>undefined);
    await new Promise(r=>setTimeout(r,30));controller.abort();await gone;
    await new Promise(r=>setTimeout(r,250));
    expect(active).toBe(0);expect(subscribes).toBe(0); // it left before subscribing, so nothing was opened
    failSubscribe=true;
    const reading=readSse(`${base2}/api/turns/${turn.id}/events`);
    await new Promise(r=>setTimeout(r,60));release();
    const {events,closed}=await reading;
    expect(subscribes).toBe(1);expect(closed).toBe(true);expect(events.at(-1)!.data.state).toBe('completed');
  } finally {await app2.close();}
});

test('draft briefs pass the input safety filter when it is on: refuse/support without model or storage, deflect with the note',async()=>{
  await app.close();
  const score=(text:string):Partial<SafetyScores>=>Object.fromEntries(SAFETY_CATEGORIES.map(category=>[category,
    category==='sexual'&&text.includes('REFUSE_ME')||category==='self_harm'&&text.includes('SUPPORT_ME')||category==='prompt_injection'&&text.includes('INJECT_ME')?0.95:0.01]));
  const assess=jest.fn(async(input:SafetyAssessInput)=>({safety:score(input.text)}));
  const onSafetyFallback=jest.fn();
  const store=new InMemoryConversationStore();const personas=new InMemoryPersonaRepository([persona]);
  const calls:unknown[]=[];const provider={generate:async(messages:unknown)=>{calls.push(messages);return '합성 초안';}};
  const chat=createLocalChat({store,personas,provider,inputSafety:{classifier:{name:'synthetic/safety-v1',assess},thresholds:{prompt_injection:0.5,sexual:0.5,violence_gore:0.5,self_harm:0.2,hate_harassment:0.5,illegal_dangerous:0.6,private_info:0.5},timeoutMs:200},onSafetyFallback});
  runtime={...runtime,chat,personas,provider};
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token});await app.listen(0,'127.0.0.1');base=await app.getUrl();
  const id=(await call('sessions',{method:'POST',body:{personId:persona.personId}})).body.session.id;
  const refused=await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'REFUSE_ME 초안'}});
  expect(refused.status).toBe(201);expect(refused.body).toMatchObject({notice:{status:'out_of_scope',content:safetyReply('sexual','ko'),limitations:[]},image:{code:'IMAGE_RUNNER_ONLY'}});
  expect(Object.keys(refused.body).sort()).toEqual(['image','notice']);expect(JSON.stringify(refused.body)).not.toMatch(/sexual|probabilit|synthetic\/safety/);
  const support=await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'SUPPORT_ME'}});
  expect(support.body).toMatchObject({notice:{content:safetyReply('self_harm','ko'),limitations:['SAFETY_SUPPORT']}});
  expect(calls).toHaveLength(0);expect(artifacts).toHaveLength(0);
  const deflected=await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'INJECT_ME 초안'}});
  expect(deflected.status).toBe(201);expect(calls).toHaveLength(1);expect(JSON.stringify(calls[0])).toContain(SAFETY_DEFLECTION_NOTE);
  // The draft id seeds the check and names the artifact; the whole brief is checked.
  expect(assess.mock.calls.at(-1)![0]).toMatchObject({seed:deflected.body.artifact.id,recentUserTurns:[],intent:false,text:'INJECT_ME 초안'});
  expect(artifacts).toHaveLength(1);
  // Fail-open: an unavailable filter keeps drafting and is reported without text.
  assess.mockRejectedValueOnce(Object.assign(new Error('raw'),{code:'BUDGET_EXCEEDED'}));
  expect((await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'평범한 초안'}})).status).toBe(201);
  expect(onSafetyFallback).toHaveBeenCalledWith({scope:'draft',reason:'budget'});
});

test('draft cap applies only with the safety filter on; filter-off drafting is unchanged',async()=>{
  await app.close();
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token,draftsPerOwnerPerMinute:1});await app.listen(0,'127.0.0.1');base=await app.getUrl();
  const off=(await call('sessions',{method:'POST',body:{personId:persona.personId}})).body.session.id;
  for(let i=0;i<3;i++) expect((await call(`sessions/${off}/drafts`,{method:'POST',body:{brief:'합성 초안'}})).status).toBe(201);
});
test('with the safety filter on, draft requests are capped per owner per minute before any safety check or model call',async()=>{
  await app.close();
  const assess=jest.fn(async(input:SafetyAssessInput)=>({safety:Object.fromEntries(input.categories.map(category=>[category,0.01]))}));
  const store=new InMemoryConversationStore();const personas=new InMemoryPersonaRepository([persona]);const provider=new FakeTextProvider();
  const chat=createLocalChat({store,personas,provider,inputSafety:{classifier:{name:'synthetic/safety-v1',assess},thresholds:{prompt_injection:0.5,sexual:0.5,violence_gore:0.5,self_harm:0.2,hate_harassment:0.5,illegal_dangerous:0.6,private_info:0.5},timeoutMs:200}});
  runtime={...runtime,chat,personas,provider};
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token,draftsPerOwnerPerMinute:2});await app.listen(0,'127.0.0.1');base=await app.getUrl();
  const id=(await call('sessions',{method:'POST',body:{personId:persona.personId}})).body.session.id;
  for(let i=0;i<2;i++) expect((await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'합성 초안'}})).status).toBe(201);
  const calls=(runtime.provider as FakeTextProvider).calls;
  const limited=await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'합성 초안'}});
  expect(limited.status).toBe(503);expect(limited.body).toEqual({error:{code:'QUEUE_FULL'}});expect((runtime.provider as FakeTextProvider).calls).toBe(calls);expect(assess).toHaveBeenCalledTimes(2);
  const other=(await call('sessions',{method:'POST',owner:'owner_synthetic_b',body:{personId:persona.personId}})).body.session.id;
  expect((await call(`sessions/${other}/drafts`,{method:'POST',owner:'owner_synthetic_b',body:{brief:'합성 초안'}})).status).toBe(201);
  await expect(createApiApplication(runtime,productionToken,{syntheticToken:token,draftsPerOwnerPerMinute:0})).rejects.toThrow();
});
test(': the fictional draft path renders the same four persona fields for a persona card (no new field reaches it)',async()=>{
  await app.close();
  const card:Persona={...persona,alternateGreetings:['다른 인사'],personality:{summary:'UNIQUE-PERSONALITY',traits:[],values:[],speechHabits:[]},
    background:{text:'UNIQUE-BACKGROUND',sourceRefs:['web:1']},exampleDialogues:[{turns:[{speaker:'user',text:'UNIQUE-EXAMPLE'},{speaker:'character',text:'b'}]}],
    lore:[{id:'UNIQUE-LORE',keys:['그림'],content:'UNIQUE-LORE-CONTENT',priority:50,sourceRefs:['web:1']}],meta:{creatorNotes:'UNIQUE-META'}};
  const store=new InMemoryConversationStore();const personas=new InMemoryPersonaRepository([card]);const provider=new FakeTextProvider();
  const generate=jest.spyOn(provider,'generate');
  const chat=createLocalChat({store,personas,provider});
  runtime={chat,leases:store,delivery:chat.delivery,events:chat.events,eventSource:chat.events,personas,provider,providerName:'fake',model:'synthetic/fake',listPersonas:async()=>[card],saveArtifact:async()=>undefined};
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token});await app.listen(0,'127.0.0.1');base=await app.getUrl();
  const id=(await call('sessions',{method:'POST',body:{personId:card.personId}})).body.session.id;
  expect((await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'합성 그림 전시 소개'}})).status).toBe(201);
  const messages=generate.mock.calls[0]![0];
  expect(messages[1]).toEqual({role:'system',content:JSON.stringify({language:persona.language,concept:persona.concept,style:persona.style,boundaries:persona.boundaries})});
  expect(JSON.stringify(messages)).not.toMatch(/UNIQUE-|다른 인사/);
});
