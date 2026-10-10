import type {INestApplication} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {InMemoryConversationStore} from '@ptr/core';
import {createApiApplication} from '../src/app';
import {SplitChatService} from '../src/split-chat';
import type {SplitApiRuntime} from '../src/split-runtime';
import type {PostgresLlmControl} from '@ptr/storage';
import type {CreativeArtifact} from '../src/runtime';
const production='synthetic-production-token-1234567890',synthetic='synthetic-owner-token-1234567890123',controlToken='synthetic-control-token-12345678901';
const persona={id:'synthetic-persona',personId:'synthetic-person',revision:'synthetic-v1',label:'Synthetic',language:'ko',reviewStatus:'synthetic' as const,greeting:'synthetic greeting'};
let app:INestApplication,base:string,runtime:SplitApiRuntime;let artifacts:CreativeArtifact[],control:{start:jest.Mock;status:jest.Mock;progress:jest.Mock;complete:jest.Mock};
const request={contractVersion:1,turnId:'00000000-0000-4000-8000-000000000001',dispatchSeq:0,jobId:'t-00000000-0000-4000-8000-000000000001-0',lockToken:'synthetic-lock',executionId:'00000000-0000-4000-8000-000000000002'};
async function call(path:string,body?:unknown,token=synthetic){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-PTR-Owner':'owner_synthetic_split'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};}
beforeEach(async()=>{
 const store=new InMemoryConversationStore(),events={publish:jest.fn(async()=>undefined)},delivery={backlog:async()=>0,publish:jest.fn(async()=>undefined)};
 control={start:jest.fn(async()=>({contractVersion:1,status:'lost'})),status:jest.fn(async()=>({contractVersion:1,status:'lost'})),progress:jest.fn(async()=>({contractVersion:1,status:'applied'})),complete:jest.fn(async()=>({contractVersion:1,status:'applied'}))};artifacts=[];
 runtime={kind:'split',chat:new SplitChatService(store,async()=>[persona],delivery,events),control:control as unknown as PostgresLlmControl,controlToken,executionStore:store,delivery,events,eventSource:{subscribe:async()=>()=>undefined},providerName:'fake',model:'synthetic/fake',billable:false,listPersonas:async()=>[persona],draftRemote:jest.fn(async()=>({content:'synthetic draft',provider:'fake',model:'synthetic/fake'})),saveArtifact:async (a:CreativeArtifact)=>{artifacts.push(a);},health:async()=>({database:true,redis:true}),close:async()=>undefined} as unknown as SplitApiRuntime;
 app=await createApiApplication(runtime,production,{syntheticToken:synthetic});await app.listen(0,'127.0.0.1');base=await app.getUrl();
});
afterEach(async()=>{await app.close();});
test('internal control auth never accepts public web/harness tokens or owner spoofing',async()=>{
 expect((await call('/internal/llm/start',request,synthetic)).status).toBe(403);expect((await call('/internal/llm/start',request,production)).status).toBe(403);
 expect(control.start).not.toHaveBeenCalled();expect((await call('/internal/llm/start',request,controlToken)).status).toBe(200);expect((await call('/internal/llm/start',request,controlToken)).body).toEqual({contractVersion:1,status:'lost'});expect(control.start).toHaveBeenCalledWith(request);
 expect((await call('/api/personas',undefined,controlToken)).status).toBe(403);
});
test('unknown fields, versions, and raw provider strings reject with sanitized 400 and no store call',async()=>{
 for(const body of [{...request,contractVersion:2},{...request,unknown:'private upstream body'},{...request,dispatchSeq:'0'}])expect(await call('/internal/llm/start',body,controlToken)).toEqual({status:400,body:{error:{code:'INVALID_INPUT'}}});expect(control.start).not.toHaveBeenCalled();
});
test('split public catalogue/session/reservation remain owner safe without LLM database/provider assembly',async()=>{
 const listed=await call('/api/personas');expect(listed.status).toBe(200);expect(listed.body.personas[0].greeting).toBeUndefined();
 const session=await call('/api/sessions',{personId:persona.personId,executionProfile:'agent_loop'});expect(session.status).toBe(201);expect(session.body.session.ownerId).toBeUndefined();expect(session.body.session.personaRevision).toBe('synthetic-v1');
 const sent=await call(`/api/sessions/${session.body.session.id}/turns`,{clientRequestId:randomUUID(),text:'synthetic hello'});expect(sent.status).toBe(201);expect(sent.body.turn.state).toBe('pending');expect(sent.body.turn.ownerId).toBeUndefined();
});
test('draft RPC keeps backend quota/artifact ownership and fictional marker',async()=>{
 const session=await call('/api/sessions',{personId:persona.personId});const draft=await call(`/api/sessions/${session.body.session.id}/drafts`,{brief:'synthetic brief',clientRequestId:'synthetic-request'});
 expect(draft.status).toBe(201);expect(draft.body.artifact.content).toContain('[가상 포스트 초안 · AI 생성]');expect(draft.body.artifact.ownerId).toBeUndefined();expect(artifacts[0].ownerId).toBe('owner_synthetic_split');expect(runtime.draftRemote).toHaveBeenCalledWith(expect.objectContaining({id:session.body.session.id}),'synthetic brief','draft:owner_synthetic_split:synthetic-request',expect.any(Number),expect.any(AbortSignal));
});
test('split larger internal admission does not widen public16KiB bodies',async()=>{expect((await call('/api/sessions',{personId:persona.personId,junk:'x'.repeat(20000)})).status).toBe(413);});
test('public raw16KiB counts whitespace, while authenticated internal reply may exceed16KiB',async()=>{
 const catalogue=jest.spyOn(runtime,'listPersonas');
 const padded=await fetch(`${base}/api/sessions`,{method:'POST',headers:{Authorization:`Bearer ${synthetic}`,'Content-Type':'application/json','X-PTR-Owner':'owner_synthetic_split'},body:' '.repeat(20000)+JSON.stringify({personId:persona.personId})});
 expect(padded.status).toBe(413);expect(catalogue).not.toHaveBeenCalled();
 const reply={sessionId:request.turnId,turnId:request.turnId,messageId:request.executionId,personId:persona.personId,personaRevision:persona.revision,responseKind:'small_talk',status:'answered',content:'한'.repeat(6000),claims:[],evidence:[],limitations:[]};
 expect((await call('/internal/llm/complete',{...request,generation:1,result:{kind:'completed',reply}},controlToken)).status).toBe(200);expect(control.complete).toHaveBeenCalledTimes(1);
});
test('live split catalogue session policy preserves lexical default and rejects unavailable semantic capability',async()=>{
 const store=new InMemoryConversationStore();const chat=new SplitChatService(store,async()=>[persona],{backlog:async()=>0,publish:async()=>undefined},{publish:async()=>undefined},256,false);
 const session=await chat.createSession('owner_synthetic_split',{personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,ragCondition:'caption'});expect(session.retrievalMode).toBe('lexical');
 await expect(chat.createSession('owner_synthetic_split',{personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,retrievalMode:'semantic'})).rejects.toMatchObject({code:'SEMANTIC_UNAVAILABLE'});
});
