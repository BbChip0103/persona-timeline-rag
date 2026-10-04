import type { INestApplication } from '@nestjs/common';
import type { Persona, ChatSession, ChatTurn, ChatMessage } from '@ptr/contracts';
import { ChatService, InMemoryConversationStore, InMemoryPersonaRepository } from '@ptr/core';
import { FakeTextProvider } from '@ptr/providers';
import { createApiApplication } from '../src/app';
import type { ApiRuntime, CreativeArtifact } from '../src/runtime';
const token='synthetic_api_token_abcdefghijklmnop';
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
  runtime={chat:new ChatService({store,personas,provider}),personas,provider,providerName:'fake',model:'synthetic/fake',listPersonas:async()=>[persona],saveArtifact:async artifact=>{artifacts.push(artifact);}};
  app=await createApiApplication(runtime,token);await app.listen(0,'127.0.0.1');base=await app.getUrl();
});
afterEach(async()=>{await app.close();});
test('health safe; authentication required and invalid owner rejected',async()=>{
  expect((await call('health',{auth:'bad'})).body).toEqual({ok:true,service:'persona-timeline-rag',liveEnabled:false});
  expect((await call('personas',{auth:'Bearer wrong'})).status).toBe(403);
  expect((await call('personas',{owner:'../unsafe'})).status).toBe(403);
  const listed=await call('personas');expect(listed.status).toBe(200);expect(listed.body.personas[0].aiDisclosure).toContain('AI');expect(listed.body.personas[0].identity).toBeUndefined();
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
  runtime.chat=new ChatService({store:new InMemoryConversationStore(),personas:runtime.personas,provider});
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
    expect((await call(`sessions/${created.body.session.id}`,{owner:'synthetic-other'})).status).toBe(404);
  }
  for(const body of [{ragCondition:'off',retrievalMode:'semantic'},{ragCondition:'caption',retrievalMode:'off'},{ragCondition:'caption_image',retrievalMode:'off'}]) expect((await call('sessions',{method:'POST',body:{personId:persona.personId,...body}})).status).toBe(400);
});
test('explicit off invokes provider for factual comparison and exposes unverified actual answer without evidence',async()=>{
  const provider={generate:jest.fn(async()=>JSON.stringify({status:'answered',answer:'이 모델 응답은 실제 방문 사실로 검증되지 않았습니다.',evidenceRefs:[]}))};
  const retrieval={search:jest.fn(async()=>[])};
  runtime.chat=new ChatService({store:new InMemoryConversationStore(),personas:runtime.personas,provider,retrieval});
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
  runtime.chat=new ChatService({store:new InMemoryConversationStore(),personas:runtime.personas,provider});
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
