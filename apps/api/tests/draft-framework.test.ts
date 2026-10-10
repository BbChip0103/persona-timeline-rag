/** HTTP draft boundary; Python core_policy_test/native validation tests own classifier/Guard policy. */
import type {INestApplication} from '@nestjs/common';
import {DraftRequestSchema,type Persona} from '@ptr/contracts';
import {createApiApplication} from '../src/app';
import type {CreativeArtifact} from '../src/creative-artifact';
import {splitRuntimeFixture} from './split-runtime-fixture';
const token='synthetic_framework_draft_token_abcdefghijklmnop';
const production='synthetic_production_draft_token_abcdefghijklmnop';
const caller='owner_synthetic_draft';
const persona:Persona={id:'persona_synthetic_draft',personId:'person_synthetic_draft',label:'Synthetic',language:'ko',revision:'synthetic-v1',reviewStatus:'synthetic',identity:'Fictional',concept:'Synthetic',style:['brief'],boundaries:['AI disclosure'],sourceRefs:[],greeting:'안녕하세요.'};
let app:INestApplication,base:string,sessionId:string,fixture:ReturnType<typeof splitRuntimeFixture>;
async function request(body:unknown,owner=caller) {
  const response=await fetch(`${base}/api/sessions/${sessionId}/drafts`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'X-PTR-Owner':owner,'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as {artifact?:CreativeArtifact;notice?:{content:string;limitations:string[]};error?:{code:string}}};
}
beforeEach(async()=>{
  fixture=splitRuntimeFixture(persona);
  const session=await fixture.runtime.chat.createSession(caller,{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC',executionProfile:'agent_loop'});sessionId=session.id;
  app=await createApiApplication(fixture.runtime,production,{syntheticToken:token});await app.listen(0,'127.0.0.1');base=await app.getUrl();
});
afterEach(async()=>{jest.restoreAllMocks();await app.close();});
test('HTTP adapter delegates pinned fictional draft, paid retry key remains stable and owner scoped',async()=>{
  fixture.runtime.billable=true;const remote=jest.spyOn(fixture.runtime,'draftRemote');const before=Date.now();
  for(let i=0;i<2;i++)expect((await request({brief:'합성 창작',clientRequestId:'synthetic_draft_1'})).status).toBe(201);
  expect(remote).toHaveBeenCalledTimes(2);
  for(const [session,brief,key,deadline,signal] of remote.mock.calls){expect(session).toMatchObject({personId:persona.personId,personaRevision:persona.revision});expect(brief).toBe('합성 창작');expect(key).toBe(`draft:${caller}:synthetic_draft_1`);expect(deadline).toBeGreaterThanOrEqual(before+30000);expect(signal).toBeInstanceOf(AbortSignal);}
  expect(fixture.artifacts[0]).toMatchObject({fictional:true,kind:'post_draft',origin:'generated'});
  expect((await fixture.runtime.chat.history(caller,sessionId))).toHaveLength(1);
  sessionId=(await fixture.runtime.chat.createSession('owner_synthetic_other',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'})).id;
  await request({brief:'합성 창작',clientRequestId:'synthetic_draft_1'},'owner_synthetic_other');expect(remote.mock.calls.at(-1)![2]).toBe('draft:owner_synthetic_other:synthetic_draft_1');
});
test('billable drafts reject missing or forged request IDs before the service call',async()=>{
  fixture.runtime.billable=true;
  for(const body of [{brief:'합성 창작'},{brief:'합성 창작',clientRequestId:'draft:foreign-turn'},{brief:'합성 창작',clientRequestId:'x',ownerId:'foreign'}])expect((await request(body)).body).toEqual({error:{code:'INVALID_INPUT'}});
  expect(fixture.runtime.draftRemote).not.toHaveBeenCalled();expect(fixture.artifacts).toHaveLength(0);
  expect(DraftRequestSchema.parse({brief:' 합성 창작 '})).toEqual({brief:'합성 창작'});
});
test.each(['GUARDRAILS_OUTPUT_UNAVAILABLE','REPLY_GUARD_HUMAN_IMPERSONATION'])('remote output notice %s is sanitized and writes no artifact',async limitation=>{
  fixture.runtime.draftRemote=jest.fn(async()=>({notice:{status:'out_of_scope' as const,content:'안전한 안내입니다.',limitations:[limitation]}}));
  const result=await request({brief:'합성 창작'});expect(result.status).toBe(201);expect(result.body.notice?.limitations).toEqual([limitation]);expect(result.body.artifact).toBeUndefined();expect(JSON.stringify(result.body)).not.toMatch(/postgres|secret|sk-/);expect(fixture.runtime.draftRemote).toHaveBeenCalledTimes(1);expect(fixture.artifacts).toHaveLength(0);
});
test('remote input outage remains a notice with no artifact',async()=>{
  fixture.runtime.draftRemote=jest.fn(async()=>({notice:{status:'out_of_scope' as const,content:'안전한 안내입니다.',limitations:['GUARDRAILS_INPUT_UNAVAILABLE']}}));
  expect((await request({brief:'합성 창작'})).body.notice?.limitations).toEqual(['GUARDRAILS_INPUT_UNAVAILABLE']);expect(fixture.runtime.draftRemote).toHaveBeenCalledTimes(1);expect(fixture.artifacts).toHaveLength(0);
});
test('remote policy replacement is a notice; an edited remote result can be saved',async()=>{
  fixture.runtime.draftRemote=jest.fn(async()=>({notice:{status:'out_of_scope' as const,content:'안전한 안내입니다.',limitations:['REPLY_GUARD_HUMAN_IMPERSONATION']}}));
  expect((await request({brief:'합성 창작'})).body.notice?.limitations).toEqual(['REPLY_GUARD_HUMAN_IMPERSONATION']);expect(fixture.artifacts).toHaveLength(0);
  fixture.runtime.draftRemote=jest.fn(async()=>({content:'정리된 합성 창작 초안입니다.',provider:'fake',model:'synthetic'}));
  expect((await request({brief:'합성 창작'})).body.artifact?.content).toContain('정리된 합성');expect(fixture.artifacts).toHaveLength(1);
});
test('secrets cannot be saved or exposed even when returned by the remote service',async()=>{
  for(const remote of [async()=>({content:'Bearer synthetic-secret',provider:'fake',model:'synthetic'}),async()=>({notice:{status:'out_of_scope' as const,content:'Bearer synthetic-secret',limitations:[]}}),async()=>{throw new Error('private postgres://secret');}]){
    fixture.runtime.draftRemote=async()=>remote();expect((await request({brief:'합성 창작'})).body).toEqual({error:{code:'TURN_FAILED'}});expect(fixture.artifacts).toHaveLength(0);
  }
});
test('draft RPC receives a session projection, not persona-rendered prompts or fabricated turn metadata',async()=>{
  const remote=jest.spyOn(fixture.runtime,'draftRemote');await request({brief:'합성 창작'});
  const [session,brief,key]=remote.mock.calls[0]!;expect(session).toMatchObject({personaId:persona.id,personaRevision:persona.revision});expect(session).not.toHaveProperty('identity');expect(session).not.toHaveProperty('concept');expect(session).not.toHaveProperty('style');expect(session).not.toHaveProperty('turnId');expect(brief).toBe('합성 창작');expect(key).toMatch(/^draft:owner_synthetic_draft:/);
});
test('the 30-second deadline rejects an ignoring service and late output cannot write an artifact',async()=>{
  const timer=setTimeout;let release!:(value:{content:string;provider:string;model:string})=>void;let signal!:AbortSignal;
  fixture.runtime.draftRemote=jest.fn(async(_session,_brief,_key,_deadline,abort)=>{signal=abort;return new Promise(resolve=>{release=resolve;});});
  jest.spyOn(global,'setTimeout').mockImplementation(((fn:()=>void,ms:number,...args:unknown[])=>timer(fn,ms===30000?40:ms,...args)) as typeof setTimeout);
  expect((await request({brief:'합성 창작'})).body).toEqual({error:{code:'TURN_FAILED'}});expect(signal.aborted).toBe(true);
  release({content:'늦게 도착한 합성 초안',provider:'fake',model:'synthetic'});await new Promise(resolve=>timer(resolve,10));expect(fixture.artifacts).toHaveLength(0);
});
