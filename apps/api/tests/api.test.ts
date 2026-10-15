import type { INestApplication } from '@nestjs/common';
import type { Persona, ChatSession, ChatTurn, ChatMessage } from '@ptr/contracts';
import type {TurnEvent} from '../../../packages/core/src/ports';
import {createApiApplication} from '../src/app';
import {SplitChatService} from '../src/split-chat';
import type {SplitApiRuntime} from '../src/split-runtime';
import type {CreativeArtifact} from '../src/creative-artifact';
import {splitRuntimeFixture} from './split-runtime-fixture';
import {ZodSchemaPipe} from '../src/schema-pipes';
const ChatServiceGetTurn=SplitChatService.prototype.getTurn;
// Two owner spaces : the web's production token sends `local-<40 hex>` owners only; this harness token
// (PTR_API_SYNTHETIC_TOKEN) sends synthetic owners only. Most tests use the harness token.
const token='synthetic_api_token_abcdefghijklmnop';
const productionToken='production_api_token_abcdefghijklmnop';
const webOwner='local-0123456789abcdef0123456789abcdef01234567';
const persona:Persona={id:'persona_synthetic_a',personId:'person_synthetic_a',label:'Synthetic Painter',tagline:'A fictional painter who likes warm colors',starters:['좋아하는 색은?','오늘 뭐 그렸어?'],language:'ko',revision:'synthetic-v1',reviewStatus:'synthetic',identity:'Fictional',concept:'Synthetic conversation',style:['brief'],boundaries:['AI disclosure'],sourceRefs:[],greeting:'안녕하세요.'};
let app:INestApplication;let base:string;let runtime:SplitApiRuntime;let fixture:ReturnType<typeof splitRuntimeFixture>;let artifacts:CreativeArtifact[];
async function call(path:string,options:{method?:string;body?:unknown;owner?:string;auth?:string}={}) {
  const response=await fetch(`${base}/api/${path}`,{method:options.method??'GET',headers:{Authorization:options.auth??`Bearer ${token}`,'X-PTR-Owner':options.owner??'owner_synthetic_a','Content-Type':'application/json'},...(options.body===undefined?{}:{body:JSON.stringify(options.body)})});
  return {status:response.status,body:await response.json() as {session:ChatSession;turn:ChatTurn;personas:(Persona & {aiDisclosure:string})[];operatorMode:boolean;operatorOptionsAvailable?:boolean;history:ChatMessage[];sessions:ChatSession[];artifact:CreativeArtifact;image:{code:string};cancelled:boolean}};
}
async function waitTurn(id:string):Promise<ChatTurn> {
  for(let i=0;i<100;i++) {const result=await call(`turns/${id}`);if(['completed','cancelled','failed'].includes(result.body.turn.state)) return result.body.turn;await new Promise(resolve=>setTimeout(resolve,5));}
  throw new Error('Synthetic turn did not settle');
}
beforeEach(async()=>{
  fixture=splitRuntimeFixture(persona);runtime=fixture.runtime;artifacts=fixture.artifacts;
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token});await app.listen(0,'127.0.0.1');base=await app.getUrl();
});
afterEach(async()=>{await app.close();});
test('Nest executes schema pipes after owner authorization; invalid owner stays 403 before schema errors',async()=>{
  const pipe=jest.spyOn(ZodSchemaPipe.prototype,'transform');
  try {
    expect((await call('sessions',{method:'POST',owner:'../invalid',body:{bad:true}})).status).toBe(403);
    expect(pipe).not.toHaveBeenCalled();
    const created=await call('sessions',{method:'POST',body:{personId:persona.personId}});
    expect(created.status).toBe(201);expect(pipe).toHaveBeenCalled();
    const count=pipe.mock.calls.length;
    expect((await call(`sessions/${created.body.session.id}/drafts`,{method:'POST',owner:'../invalid',body:{bad:true}})).status).toBe(403);
    expect(pipe).toHaveBeenCalledTimes(count);
  } finally {pipe.mockRestore();}
});
test('Nest application shutdown owns runtime cleanup once even when app close is repeated',async()=>{
  runtime.close=jest.fn(async()=>undefined);
  await app.close();await app.close();
  expect(runtime.close).toHaveBeenCalledTimes(1);
});
test('health safe; authentication required and invalid owner rejected',async()=>{
  expect((await call('health',{auth:'bad'})).body).toEqual({ok:true,service:'persona-timeline-rag',liveEnabled:false,checks:{database:'ok',redis:'ok'}});
  expect((await call('personas',{auth:'Bearer wrong'})).status).toBe(403);
  expect((await call('personas',{owner:'../unsafe'})).status).toBe(403);
  const listed=await call('personas');expect(listed.status).toBe(200);expect(listed.body.personas[0].aiDisclosure).toBe(`AI 캐릭터 · 실제 ${persona.label} 아님`);expect(listed.body.personas[0].identity).toBeUndefined();
});
test('public catalogue carries approved card copy and operator mode is off by default',async()=>{
  const listed=(await call('personas')).body;
  expect(listed.operatorMode).toBe(false);
  expect(listed.operatorOptionsAvailable).toBeUndefined();
  expect(listed.personas[0]).toMatchObject({label:persona.label,tagline:persona.tagline,starters:persona.starters});
  expect(listed.personas[0].reviewStatus).toBeUndefined();
});
test('server-only operator flag enables the catalogue operator projection',async()=>{
  await app.close();
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token,operatorMode:true});
  await app.listen(0,'127.0.0.1');base=await app.getUrl();
  const listed=(await call('personas')).body;
  expect(listed.operatorMode).toBe(true);
  expect(listed.operatorOptionsAvailable).toBe(false);
  expect(listed.personas[0].reviewStatus).toBe('synthetic');
  await app.close();
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token,operatorMode:true,operatorOptions:true});
  await app.listen(0,'127.0.0.1');base=await app.getUrl();
  expect((await call('personas')).body.operatorOptionsAvailable).toBe(true);
});
test('production token cannot submit operator-only options unless the API flag is enabled',async()=>{
  const production=`Bearer ${productionToken}`;
  for(const body of [
    {personId:persona.personId,ragCondition:'caption_image'},
    {personId:persona.personId,executionProfile:'legacy'},
  ]) expect((await call('sessions',{method:'POST',auth:production,owner:webOwner,body})).status).toBe(400);
  const created=await call('sessions',{method:'POST',auth:production,owner:webOwner,body:{personId:persona.personId}});
  expect(created.status).toBe(201);
  for(const extra of [{intent:'timeline'},{timeline:{dateBasis:'posted',limit:5}}])
    expect((await call(`sessions/${created.body.session.id}/turns`,{method:'POST',auth:production,owner:webOwner,
      body:{clientRequestId:`forbidden-${Object.keys(extra)[0]}`,text:'synthetic turn',...extra}})).status).toBe(400);
  expect((await call('sessions',{method:'POST',body:{personId:persona.personId,ragCondition:'caption_image'}})).status).toBe(201);

  await app.close();
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token,operatorOptions:true});
  await app.listen(0,'127.0.0.1');base=await app.getUrl();
  const allowed=await call('sessions',{method:'POST',auth:production,owner:webOwner,body:{personId:persona.personId,ragCondition:'caption_image'}});
  expect(allowed.status).toBe(201);
  expect((await call(`sessions/${allowed.body.session.id}/turns`,{method:'POST',auth:production,owner:webOwner,
    body:{clientRequestId:'operator-turn',text:'synthetic turn',intent:'timeline',timeline:{dateBasis:'posted',limit:5}}})).status).toBe(201);
});
test('authentication runs before malformed or oversized JSON parsing',async()=>{
  for(const body of ['{bad json',' '.repeat(20000)+'{}']) {
    const response=await fetch(`${base}/api/sessions`,{method:'POST',headers:{Authorization:'Bearer wrong','Content-Type':'application/json','X-PTR-Owner':'owner_synthetic_a'},body});
    expect(response.status).toBe(403);expect(await response.json()).toEqual({error:{code:'UNAUTHORIZED'}});
  }
  expect(fixture.dispatches).toHaveLength(0);expect(runtime.draftRemote).not.toHaveBeenCalled();
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
test('web token hides research fields in poll and replay; harness token keeps them',async()=>{
  fixture.reply={responseKind:'timeline',grounding:'source_bound_quotes',claims:[{text:'합성 주장',evidenceRefs:[{sourceId:'source',quote:'합성 인용',start:0,end:5}]}],
    evidence:[{sourceId:'source',personId:persona.personId,sourceUrl:'https://example.invalid/source',postedAt:'2024-01-01T00:00:00Z',eventDate:null,snapshot:'합성',hash:'hash',quote:'합성 인용'}],
    limitations:['합성 한계'],promptEvidence:{sourceIds:['source'],annotationIds:[],omittedAnnotations:0,promptBytes:1}};
  for(const [auth,owner,hidden] of [[`Bearer ${productionToken}`,webOwner,true],[`Bearer ${token}`,'owner_synthetic_a',false]] as const) {
    const session=(await call('sessions',{method:'POST',auth,owner,body:{personId:persona.personId}})).body.session;
    const input={clientRequestId:`request_${owner}`,text:'합성 질문'};
    const submitted=await call(`sessions/${session.id}/turns`,{method:'POST',auth,owner,body:input});
    const final=await (async()=>{for(let i=0;i<100;i++){const result=await call(`turns/${submitted.body.turn.id}`,{auth,owner});if(result.body.turn.state==='completed')return result.body.turn;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Synthetic turn did not settle');})();
    const replay=(await call(`sessions/${session.id}/turns`,{method:'POST',auth,owner,body:input})).body.turn;
    for(const turn of [final,replay]) {
      for(const field of ['evidence','limitations','grounding','claims','promptEvidence'])expect(Object.hasOwn(turn.reply??{},field)).toBe(!hidden);
      expect(JSON.stringify(turn).includes('합성 인용')).toBe(!hidden);
    }
  }
});
test('sessions pin server persona revision, owner isolation and completed history',async()=>{
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId}});expect(created.status).toBe(201);
  const id=created.body.session.id;expect(created.body.session.ownerId).toBeUndefined();expect(created.body.session.personaRevision).toBe(persona.revision);
  expect(created.body.session).toMatchObject({retrievalMode:'lexical',ragCondition:'caption'});
  expect((await call(`sessions/${id}`)).body.history[0]?.content).toBe(persona.greeting);
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
  expect(fixture.dispatches).toHaveLength(0);expect(runtime.draftRemote).not.toHaveBeenCalled();
});
test('remote factual abstention and completed cancellation are projected without backend model work',async()=>{
  fixture.reply={status:'insufficient_evidence',responseKind:'timeline',content:'근거가 부족합니다.'};
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId,executionProfile:'legacy'}});const id=created.body.session.id;
  const sent=await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'x',text:'2020년 어디 여행했어?'}});
  const final=await waitTurn(sent.body.turn.id);expect(final.reply?.status).toBe('insufficient_evidence');expect(fixture.dispatches).toHaveLength(1);
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
test('pending split job supports poll/cancel, and late remote output never reaches history',async()=>{
  fixture.hold=true;
  const id=(await call('sessions',{method:'POST',body:{personId:persona.personId}})).body.session.id;
  const pending=await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'pending_synthetic',text:'안녕'}});
  expect(['pending','generating']).toContain(pending.body.turn.state);expect(pending.body.turn.reply).toBeUndefined();
  expect((await call(`turns/${pending.body.turn.id}/cancel`,{method:'POST',body:{}})).body.cancelled).toBe(true);
  await fixture.complete(pending.body.turn.id,{content:'late result'});
  expect((await call(`turns/${pending.body.turn.id}`)).body.turn.state).toBe('cancelled');expect((await call(`sessions/${id}`)).body.history).toHaveLength(1);
});

test('draft provider failure is sanitized 502; credential-like input rejected before storage/model',async()=>{
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId}});const id=created.body.session.id;
  expect((await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'secret',text:'api_key=synthetic_secret'}})).status).toBe(400);
  expect((await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'api_key=synthetic_secret'}})).status).toBe(400);
  expect(fixture.dispatches).toHaveLength(0);expect(runtime.draftRemote).not.toHaveBeenCalled();
  runtime.draftRemote=jest.fn(async()=>{throw new Error('sk-synthetic_secret_do_not_expose');});
  const failed=await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'합성 그림 이야기'}});expect(failed.status).toBe(502);expect(failed.body).toEqual({error:{code:'TURN_FAILED'}});expect(artifacts).toEqual([]);
});

test('explicit conditions persist, default algorithm consistently, reject contradictions and stay owner-private',async()=>{
  for(const ragCondition of ['off','caption','caption_image']) {
    const created=await call('sessions',{method:'POST',body:{personId:persona.personId,ragCondition}});
    expect(created.status).toBe(201);expect(created.body.session.ragCondition).toBe(ragCondition);
    expect(created.body.session.retrievalMode).toBe(ragCondition==='off'?'off':'lexical');
    expect((await call(`sessions/${created.body.session.id}`)).body.session.ragCondition).toBe(ragCondition);
    expect((await call(`sessions/${created.body.session.id}`,{owner:'owner_synthetic_other'})).status).toBe(404);
  }
  for(const body of [{ragCondition:'off',retrievalMode:'semantic'},{ragCondition:'caption',retrievalMode:'off'},{ragCondition:'caption_image',retrievalMode:'off'}]) expect((await call('sessions',{method:'POST',body:{personId:persona.personId,...body}})).status).toBe(400);
});
test('explicit off pins the remote job condition and exposes unverified answer projection without evidence',async()=>{
  fixture.reply={responseKind:'timeline',content:'이 모델 응답은 실제 방문 사실로 검증되지 않았습니다.',grounding:'unverified_model'};
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId,ragCondition:'off',executionProfile:'legacy'}});const id=created.body.session.id;
  const sent=await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'experiment-off',text:'2020년 어디 여행했어?'}});
  const final=await waitTurn(sent.body.turn.id);
  expect(final.reply?.content).toContain('이 모델 응답');expect(final.reply?.grounding).toBe('unverified_model');expect(final.reply?.evidence).toEqual([]);expect(final.reply?.claims).toEqual([]);expect(fixture.dispatches).toHaveLength(1);
  expect((await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'override',text:'hello',ragCondition:'caption_image'}})).status).toBe(400);
});

test('new API sessions default agent_loop; explicit legacy remains pinned; internal agent fields never leave poll/replay/history',async()=>{
  const secretSummary='synthetic-internal-summary';const privateTopic='synthetic-internal-topic';
  fixture.reply={agent:{revision:'synthetic',promptRevision:'synthetic',modelCalls:1,toolCalls:0,validator:'accepted',decisionSummary:secretSummary,variables:{conversationTopic:privateTopic,tone:'warm'},steps:[]}};
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
async function readSse(url:string,owner='owner_synthetic_a',limitMs=3000,auth=`Bearer ${token}`):Promise<{status:number;type:string|null;events:SseEvent[];closed:boolean;wire:string}> {
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),limitMs);
  const response=await fetch(url,{headers:{Authorization:auth,'X-PTR-Owner':owner},signal:controller.signal});
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
  return {status:response.status,type:response.headers.get('content-type'),events,closed,wire:text};
}
function heldSplit() {
  const held=splitRuntimeFixture(persona,{hold:true});
  const release=()=>{for(const dispatch of held.dispatches)void held.complete(dispatch.turnId);};
  return {held,chat:held.runtime.chat,release};
}
test('SSE: a turn streams its state changes and the final public turn, then the server closes the stream',async()=>{
  const {held,release}=heldSplit();Object.assign(runtime,held.runtime);
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
test('SSE final re-read hides research fields for a live web stream',async()=>{
  const {held}=heldSplit();Object.assign(runtime,held.runtime);
  const session=(await call('sessions',{method:'POST',auth:`Bearer ${productionToken}`,owner:webOwner,body:{personId:persona.personId}})).body.session;
  const sent=await call(`sessions/${session.id}/turns`,{method:'POST',auth:`Bearer ${productionToken}`,owner:webOwner,body:{clientRequestId:'live_web_stream',text:'합성 질문'}});
  const reading=readSse(`${base}/api/turns/${sent.body.turn.id}/events`,webOwner,3000,`Bearer ${productionToken}`);
  await new Promise(resolve=>setTimeout(resolve,50));
  await held.complete(sent.body.turn.id,{responseKind:'timeline',grounding:'source_bound_quotes',claims:[{text:'합성 주장',evidenceRefs:[]}],evidence:[],limitations:['합성 한계'],promptEvidence:{sourceIds:['source'],annotationIds:[],omittedAnnotations:0,promptBytes:1}});
  const stream=await reading;
  expect(stream.status).toBe(200);expect(stream.closed).toBe(true);
  expect(stream.events[0]!.data.state).not.toBe('completed');
  const final=stream.events.at(-1)!;expect(final.event).toBe('turn');expect(final.data.state).toBe('completed');
  for(const field of ['evidence','limitations','grounding','claims','promptEvidence'])expect(final.data.reply).not.toHaveProperty(field);
});
test('SSE: an already ended turn yields one snapshot and closes; another owner gets a plain 404',async()=>{
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId}});const id=created.body.session.id;
  const sent=await call(`sessions/${id}/turns`,{method:'POST',body:{clientRequestId:'sse_2',text:'안녕'}});const final=await waitTurn(sent.body.turn.id);
  const done=await readSse(`${base}/api/turns/${final.id}/events`);
  expect(done.closed).toBe(true);expect(done.events).toHaveLength(1);expect(done.events[0]!.data.state).toBe('completed');
  const other=await readSse(`${base}/api/turns/${final.id}/events`,'owner_synthetic_b');
  expect(other.status).toBe(404);expect(other.type).toMatch(/^application\/json/);
});
test('SSE snapshots use the token space projection for both web and harness',async()=>{
  fixture.reply={responseKind:'timeline',grounding:'source_bound_quotes',claims:[{text:'합성 주장',evidenceRefs:[]}],
    evidence:[],limitations:['합성 한계'],promptEvidence:{sourceIds:['source'],annotationIds:[],omittedAnnotations:0,promptBytes:1}};
  for(const [auth,owner,hidden] of [[`Bearer ${productionToken}`,webOwner,true],[`Bearer ${token}`,'owner_synthetic_a',false]] as const) {
    const session=(await call('sessions',{method:'POST',auth,owner,body:{personId:persona.personId}})).body.session;
    const sent=await call(`sessions/${session.id}/turns`,{method:'POST',auth,owner,body:{clientRequestId:`sse_${owner}`,text:'합성 질문'}});
    const final=await (async()=>{for(let i=0;i<100;i++){const result=await call(`turns/${sent.body.turn.id}`,{auth,owner});if(result.body.turn.state==='completed')return result.body.turn;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('Synthetic turn did not settle');})();
    const stream=await readSse(`${base}/api/turns/${final.id}/events`,owner,3000,auth);
    expect(stream.status).toBe(200);expect(stream.closed).toBe(true);expect(stream.events).toHaveLength(1);
    const reply=stream.events[0]!.data.reply;
    for(const field of ['evidence','limitations','grounding','claims','promptEvidence'])expect(Object.hasOwn(reply??{},field)).toBe(!hidden);
  }
});
test('SSE: if pub/sub notices are lost, the periodic store re-check still delivers the end of the turn',async()=>{
  const {held,chat,release}=heldSplit();
  const silent={...held.runtime,eventSource:{subscribe:async()=>()=>undefined}} as unknown as SplitApiRuntime;
  const quiet=await createApiApplication(silent,productionToken,{syntheticToken:token,sse:{recheckMs:50}});await quiet.listen(0,'127.0.0.1');const quietBase=await quiet.getUrl();
  try {
    const session=await chat.createSession('owner_synthetic_a',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC',executionProfile:'legacy'});
    const {turn}=await chat.submitTurn('owner_synthetic_a',{sessionId:session.id,clientRequestId:'sse_3',text:'안녕'});
    const reading=readSse(`${quietBase}/api/turns/${turn.id}/events`);
    await new Promise(r=>setTimeout(r,30));release();
    const {events,closed}=await reading;
    expect(closed).toBe(true);expect(events.at(-1)!.data.state).toBe('completed');
  } finally {await quiet.close();}
});

test('SSE: a client gone during the ownership check leaves no subscription behind; a failing subscribe still streams via store re-checks',async()=>{
  const {held,chat,release}=heldSplit();
  let active=0,subscribes=0;let failSubscribe=false;
  const counting={subscribe:async(turnId:string,listener:(e:TurnEvent)=>void)=>{
    subscribes++;if(failSubscribe)throw new Error('redis down');active++;const off=await held.events.subscribe(turnId,listener);return ()=>{active--;off();};}};
  const app2=await createApiApplication({...held.runtime,eventSource:counting} as unknown as SplitApiRuntime,productionToken,{syntheticToken:token,sse:{recheckMs:40}});
  await app2.listen(0,'127.0.0.1');const base2=await app2.getUrl();
  try {
    const session=await chat.createSession('owner_synthetic_a',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC',executionProfile:'legacy'});
    const {turn}=await chat.submitTurn('owner_synthetic_a',{sessionId:session.id,clientRequestId:'sse_gone',text:'안녕'});
    const slow=jest.spyOn(chat,'getTurn');slow.mockImplementationOnce(async(owner:string,id:string)=>{await new Promise(r=>setTimeout(r,150));return ChatServiceGetTurn.call(chat,owner,id);});
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

test('SSE: native transport emits exact ping comments, no IDs, and releases subscriptions at maximum duration',async()=>{
  const {held,chat,release}=heldSplit();let active=0;
  const eventSource={subscribe:async()=>{active++;return ()=>{active--;};}};
  const app2=await createApiApplication({...held.runtime,eventSource} as unknown as SplitApiRuntime,productionToken,{syntheticToken:token,sse:{heartbeatMs:10,maxMs:65,recheckMs:20}});
  await app2.listen(0,'127.0.0.1');
  try {
    const session=await chat.createSession('owner_synthetic_a',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC',executionProfile:'legacy'});
    const {turn}=await chat.submitTurn('owner_synthetic_a',{sessionId:session.id,clientRequestId:'sse_ping',text:'안녕'});
    const result=await readSse(`${await app2.getUrl()}/api/turns/${turn.id}/events`);
    expect(result.closed).toBe(true);expect(result.wire).toContain(': ping\n\n');expect(result.wire).not.toMatch(/^id:/m);
    expect(active).toBe(0);
  } finally {release();await app2.close();}
});

test('SSE: post-header store errors close safely without the native default Error.message event',async()=>{
  const {held,chat,release}=heldSplit();let off=0;
  const app2=await createApiApplication({...held.runtime,eventSource:{subscribe:async()=>()=>{off++;}}} as unknown as SplitApiRuntime,productionToken,{syntheticToken:token,sse:{recheckMs:10}});
  await app2.listen(0,'127.0.0.1');
  try {
    const session=await chat.createSession('owner_synthetic_a',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC',executionProfile:'legacy'});
    const {turn}=await chat.submitTurn('owner_synthetic_a',{sessionId:session.id,clientRequestId:'sse_error',text:'안녕'});
    let calls=0;jest.spyOn(chat,'getTurn').mockImplementation((owner:string,id:string)=>++calls<=2?ChatServiceGetTurn.call(chat,owner,id):Promise.reject(new Error('SYNTHETIC_PRIVATE_ERROR')));
    const result=await readSse(`${await app2.getUrl()}/api/turns/${turn.id}/events`);
    expect(result.closed).toBe(true);expect(result.events).toHaveLength(1);expect(result.wire).not.toContain('SYNTHETIC_PRIVATE_ERROR');expect(result.wire).not.toContain('event: error');expect(off).toBe(1);
  } finally {release();await app2.close();}
});

test('SSE: a late subscription after its RxJS timeout is disposed once, not leaked',async()=>{
  const {held,chat,release}=heldSplit();let off=0;
  let resolveSubscription!:(off:()=>void)=>void;
  const subscription=new Promise<()=>void>(resolve=>{resolveSubscription=resolve;});
  const app2=await createApiApplication({...held.runtime,eventSource:{subscribe:async()=>subscription}} as unknown as SplitApiRuntime,productionToken,{syntheticToken:token,sse:{subscribeTimeoutMs:10,maxMs:30,recheckMs:10}});
  await app2.listen(0,'127.0.0.1');
  try {
    const session=await chat.createSession('owner_synthetic_a',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC',executionProfile:'legacy'});
    const {turn}=await chat.submitTurn('owner_synthetic_a',{sessionId:session.id,clientRequestId:'sse_late',text:'안녕'});
    const result=await readSse(`${await app2.getUrl()}/api/turns/${turn.id}/events`);
    expect(result.closed).toBe(true);expect(off).toBe(0);
    resolveSubscription(()=>{off++;});await new Promise<void>(resolve=>setImmediate(resolve));expect(off).toBe(1);
  } finally {release();await app2.close();}
});

test('remote safety notices pass through without artifact writes; successful remote drafts remain fictional',async()=>{
  const remote=jest.fn(async(_session:ChatSession,brief:string)=>brief.startsWith('REFUSE')?{notice:{status:'out_of_scope' as const,content:'안전한 안내',limitations:[]}}:brief.startsWith('SUPPORT')?{notice:{status:'out_of_scope' as const,content:'도움을 요청해 주세요.',limitations:['SAFETY_SUPPORT']}}:{content:'합성 초안',provider:'fake',model:'synthetic'});
  runtime.draftRemote=remote;
  const id=(await call('sessions',{method:'POST',body:{personId:persona.personId}})).body.session.id;
  for(const brief of ['REFUSE_ME 초안','SUPPORT_ME']){
    const result=await call(`sessions/${id}/drafts`,{method:'POST',body:{brief}});expect(result.status).toBe(201);expect(Object.keys(result.body).sort()).toEqual(['image','notice']);expect(artifacts).toHaveLength(0);
  }
  const drafted=await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'INJECT_ME 초안'}});expect(drafted.status).toBe(201);expect(artifacts).toHaveLength(1);
  expect(remote.mock.calls.map(call=>call[1])).toEqual(['REFUSE_ME 초안','SUPPORT_ME','INJECT_ME 초안']);
});

test('draft cap applies with the Jev classifier off as well',async()=>{
  await app.close();
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token,draftsPerOwnerPerMinute:1});await app.listen(0,'127.0.0.1');base=await app.getUrl();
  const off=(await call('sessions',{method:'POST',body:{personId:persona.personId}})).body.session.id;
  expect((await call(`sessions/${off}/drafts`,{method:'POST',body:{brief:'합성 초안'}})).status).toBe(201);
  expect((await call(`sessions/${off}/drafts`,{method:'POST',body:{brief:'합성 초안'}})).status).toBe(503);
  expect(runtime.draftRemote).toHaveBeenCalledTimes(1);
});
test('foreign session draft attempts do not consume the authorized owner quota',async()=>{
  await app.close();fixture=splitRuntimeFixture(persona);runtime=fixture.runtime;
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token,draftsPerOwnerPerMinute:1});await app.listen(0,'127.0.0.1');base=await app.getUrl();
  const foreign=(await call('sessions',{method:'POST',owner:'owner_synthetic_b',body:{personId:persona.personId}})).body.session.id;
  expect((await call(`sessions/${foreign}/drafts`,{method:'POST',body:{brief:'합성 초안'}})).status).toBe(404);
  expect(runtime.draftRemote).not.toHaveBeenCalled();
  const own=(await call('sessions',{method:'POST',body:{personId:persona.personId}})).body.session.id;
  expect((await call(`sessions/${own}/drafts`,{method:'POST',body:{brief:'합성 초안'}})).status).toBe(201);
  expect(runtime.draftRemote).toHaveBeenCalledTimes(1);
});
test('remote draft requests are capped independently per owner before the service call',async()=>{
  await app.close();
  fixture=splitRuntimeFixture(persona);runtime=fixture.runtime;
  app=await createApiApplication(runtime,productionToken,{syntheticToken:token,draftsPerOwnerPerMinute:2});await app.listen(0,'127.0.0.1');base=await app.getUrl();
  const id=(await call('sessions',{method:'POST',body:{personId:persona.personId}})).body.session.id;
  for(let i=0;i<2;i++)expect((await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'合成 초안'}})).status).toBe(201);
  const limited=await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'합성 초안'}});expect(limited.status).toBe(503);expect(limited.body).toEqual({error:{code:'QUEUE_FULL'}});expect(runtime.draftRemote).toHaveBeenCalledTimes(2);
  const other=(await call('sessions',{method:'POST',owner:'owner_synthetic_b',body:{personId:persona.personId}})).body.session.id;
  expect((await call(`sessions/${other}/drafts`,{method:'POST',owner:'owner_synthetic_b',body:{brief:'합성 초안'}})).status).toBe(201);
  await expect(createApiApplication(runtime,productionToken,{syntheticToken:token,draftsPerOwnerPerMinute:0})).rejects.toThrow();
});

test('draft RPC sends pinned session projection and brief, not backend-rendered persona prompts',async()=>{
  const remote=jest.spyOn(runtime,'draftRemote');
  const created=await call('sessions',{method:'POST',body:{personId:persona.personId}});const id=created.body.session.id;
  expect((await call(`sessions/${id}/drafts`,{method:'POST',body:{brief:'합성 그림 전시 소개'}})).status).toBe(201);
  expect(remote).toHaveBeenCalledTimes(1);expect(remote.mock.calls[0]![0]).toMatchObject({personaId:persona.id,personaRevision:persona.revision,personId:persona.personId});
  expect(remote.mock.calls[0]![0]).not.toHaveProperty('identity');expect(remote.mock.calls[0]![0]).not.toHaveProperty('style');
  expect(remote.mock.calls[0]![1]).toBe('합성 그림 전시 소개');
});
