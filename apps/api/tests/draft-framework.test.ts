/** Synthetic HTTP boundary tests; the Python suite separately exercises genuine Guard validators. */
import { createServer, type Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { DraftRequestSchema, type Persona, type ProviderMessage } from '@ptr/contracts';
import { createLocalChat, GuardrailsClient, InMemoryConversationStore, InMemoryPersonaRepository } from '@ptr/core';
import { FrameworkTelemetry } from '@ptr/ops';
import { createApiApplication } from '../src/app';
import type { ApiRuntime, CreativeArtifact } from '../src/runtime';
const token='synthetic_framework_draft_token_abcdefghijklmnop';
const production='synthetic_production_draft_token_abcdefghijklmnop';
const caller='owner_synthetic_draft';
const persona:Persona={id:'persona_synthetic_draft',personId:'person_synthetic_draft',label:'Synthetic',language:'ko',revision:'synthetic-v1',reviewStatus:'synthetic',identity:'Fictional',concept:'Synthetic',style:['brief'],boundaries:['AI disclosure'],sourceRefs:[],greeting:'안녕하세요.'};
let app:INestApplication,server:Server,base:string,sessionId:string,runtime:ApiRuntime;
let artifacts:CreativeArtifact[],requests:{path:string;body:Record<string,unknown>}[],calls:{messages:ProviderMessage[];options:Parameters<ApiRuntime['provider']['generate']>[1]}[];
let output:Record<string,unknown>,responseStatus:number,inputStatus:number;
async function request(body:unknown,owner=caller) {
  const response=await fetch(`${base}/api/sessions/${sessionId}/drafts`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'X-PTR-Owner':owner,'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {status:response.status,body:await response.json() as {artifact?:CreativeArtifact;notice?:{content:string;limitations:string[]};error?:{code:string}}};
}
beforeEach(async()=>{
  artifacts=[];requests=[];calls=[];responseStatus=200;inputStatus=200;
  output={revision:'reply-guard-v7',content:'검증된 합성 창작 초안입니다.'};
  server=createServer((req,res)=>{
    let body='';req.on('data',part=>{body+=String(part);});req.on('end',()=>{
      requests.push({path:req.url!,body:JSON.parse(body) as Record<string,unknown>});
      const input=req.url==='/validate/input';res.writeHead(input?inputStatus:responseStatus,{'Content-Type':'application/json'});
      res.end(JSON.stringify(input?{revision:'reply-guard-v7',action:'none',fired:[]}:responseStatus===200?output:{raw:'private postgres://secret sk-synthetic_secret'}));
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw new Error('synthetic server');
  const guardrails=new GuardrailsClient({baseUrl:`http://127.0.0.1:${address.port}`,apiKey:'synthetic_guardrails_token',timeoutMs:500});
  const store=new InMemoryConversationStore(),personas=new InMemoryPersonaRepository([persona]);
  const provider={generate:async(messages:ProviderMessage[],options:Parameters<ApiRuntime['provider']['generate']>[1])=>{calls.push({messages,options});return '검증 전 합성 초안입니다.';}};
  const chat=createLocalChat({store,personas,provider,guardrails});
  runtime={chat,personas,provider,guardrails,leases:store,delivery:chat.delivery,events:chat.events,eventSource:chat.events,providerName:'fake',model:'synthetic/fake',listPersonas:async()=>[persona],saveArtifact:async artifact=>{artifacts.push(artifact);}};
  const session=await chat.createSession(caller,{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC',executionProfile:'legacy'});sessionId=session.id;
  app=await createApiApplication(runtime,production,{syntheticToken:token});await app.listen(0,'127.0.0.1');base=await app.getUrl();
});
afterEach(async()=>{jest.restoreAllMocks();await app.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));});
test('HTTP adapter validates rules-only input and fictional output before saving; paid retry key is stable and owner scoped',async()=>{
  runtime.billable=true;const screening=jest.spyOn(runtime.chat,'screenDraftBrief');
  const before=Date.now();
  for(let i=0;i<2;i++)expect((await request({brief:'합성 창작',clientRequestId:'synthetic_draft_1'})).status).toBe(201);
  expect(calls).toHaveLength(2);
  for(const call of calls){expect(call.options.requestKey).toBe(`draft:${caller}:synthetic_draft_1`);expect(call.options.deadlineAt).toBeGreaterThanOrEqual(before+30000);expect(call.options.signal).toBeInstanceOf(AbortSignal);}
  expect(screening.mock.calls[0]![1]).toBe(calls[0]!.options.requestKey);
  expect(requests.map(value=>value.path)).toEqual(['/validate/input','/validate/output','/validate/input','/validate/output']);
  expect(requests[0]!.body).toMatchObject({metadata:{classification:'rules-only',probabilities:{}}});
  expect(requests[1]!.body).toEqual({text:'검증 전 합성 초안입니다.',metadata:{utterance:'합성 창작',realPerson:false,language:'ko',level:'polite'}});
  expect(artifacts[0]).toMatchObject({fictional:true,kind:'post_draft',origin:'generated'});expect(artifacts[0]!.content).toContain('검증된 합성');
  expect((await runtime.chat.history(caller,sessionId))).toHaveLength(1);
  const other=await runtime.chat.createSession('owner_synthetic_other',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC',executionProfile:'legacy'});
  sessionId=other.id;await request({brief:'합성 창작',clientRequestId:'synthetic_draft_1'},'owner_synthetic_other');expect(calls.at(-1)!.options.requestKey).toBe('draft:owner_synthetic_other:synthetic_draft_1');
});
test('billable drafts reject missing or forged request IDs before validation or model generation',async()=>{
  runtime.billable=true;
  for(const body of [{brief:'합성 창작'},{brief:'합성 창작',clientRequestId:'draft:foreign-turn'},{brief:'합성 창작',clientRequestId:'x',ownerId:'foreign'}])expect((await request(body)).body).toEqual({error:{code:'INVALID_INPUT'}});
  expect(calls).toHaveLength(0);expect(requests).toHaveLength(0);expect(artifacts).toHaveLength(0);
  expect(DraftRequestSchema.parse({brief:' 합성 창작 '})).toEqual({brief:'합성 창작'});
});
test.each([503,200])('output outage or invalid payload (%s) yields sanitized notice with no artifact and no extra model call',async status=>{
  responseStatus=status;output={raw:'private postgres://secret sk-synthetic_secret'};
  const result=await request({brief:'합성 창작'});expect(result.status).toBe(201);expect(result.body.notice?.limitations).toEqual(['GUARDRAILS_OUTPUT_UNAVAILABLE']);
  expect(result.body.artifact).toBeUndefined();expect(JSON.stringify(result.body)).not.toMatch(/postgres|secret|sk-/);expect(calls).toHaveLength(1);expect(artifacts).toHaveLength(0);
});
test('input outage remains fail closed with Jev disabled; no model, output guard or artifact',async()=>{
  inputStatus=503;const result=await request({brief:'합성 창작'});expect(result.body.notice?.limitations).toEqual(['GUARDRAILS_INPUT_UNAVAILABLE']);expect(requests).toHaveLength(1);expect(calls).toHaveLength(0);expect(artifacts).toHaveLength(0);
});
test('policy replacement is a notice, policy edits alone can be saved',async()=>{
  output={revision:'reply-guard-v7',content:'안전한 안내입니다.',reason:'human_impersonation'};
  expect((await request({brief:'합성 창작'})).body.notice?.limitations).toEqual(['REPLY_GUARD_HUMAN_IMPERSONATION']);expect(artifacts).toHaveLength(0);
  output={revision:'reply-guard-v7',content:'정리된 합성 창작 초안입니다.',reason:'meta_talk',edited:true};
  expect((await request({brief:'합성 창작'})).body.artifact?.content).toContain('정리된 합성');expect(artifacts).toHaveLength(1);expect(calls).toHaveLength(2);
});
test('secrets cannot be saved even if returned by an output validator',async()=>{
  output={revision:'reply-guard-v7',content:'Bearer synthetic-secret'};
  const result=await request({brief:'합성 창작'});expect(result.body.notice?.limitations).toEqual(['GUARDRAILS_OUTPUT_UNAVAILABLE']);expect(artifacts).toHaveLength(0);
  runtime.provider.generate=async()=>{throw new Error('private postgres://secret');};
  expect((await request({brief:'합성 창작'})).body).toEqual({error:{code:'TURN_FAILED'}});
});
test('draft stages run under a fictional parent and do not fabricate turn trace metadata',async()=>{
  const telemetry=new FrameworkTelemetry({enabled:false,environment:'synthetic',release:'synthetic',captureContent:false});runtime.telemetry=telemetry;
  const observations:unknown[]=[],names:string[]=[];let parent=false;
  jest.spyOn(telemetry,'stage').mockImplementation(async(name,task)=>{names.push(name);if(name==='creative-draft')parent=true;else expect(parent).toBe(true);try{return await task({update:value=>{observations.push(value);}});}finally{if(name==='creative-draft')parent=false;}});
  await request({brief:'합성 창작'});expect(names).toEqual(['creative-draft','draft-input','draft-output']);expect(observations[0]).toMatchObject({metadata:{artifactKind:'post_draft',fictional:true,grounding:'fictional_artifact'}});
  expect(JSON.stringify(observations)).not.toMatch(/turnId|owner_synthetic|합성 창작/);
});
test('the 30-second deadline rejects an ignoring provider and its late output cannot write an artifact',async()=>{
  const timer=setTimeout;let release!:(value:string)=>void;let signal!:AbortSignal;
  runtime.provider.generate=async(_messages,options)=>{signal=options.signal;return new Promise<string>(resolve=>{release=resolve;});};
  jest.spyOn(global,'setTimeout').mockImplementation(((fn:()=>void,ms:number,...args:unknown[])=>timer(fn,ms===30000?40:ms,...args)) as typeof setTimeout);
  const result=await request({brief:'합성 창작'});expect(result.body).toEqual({error:{code:'TURN_FAILED'}});expect(signal.aborted).toBe(true);
  release('늦게 도착한 합성 초안');await new Promise(resolve=>timer(resolve,10));expect(artifacts).toHaveLength(0);expect(requests.filter(value=>value.path==='/validate/output')).toHaveLength(0);
});
