import { MemorySaver } from '@langchain/langgraph';
import type { Persona, SourcePost } from '@ptr/contracts';
import { ChatService, type ChatServiceOptions } from '../src/chat-service';
import { InMemoryConversationStore, InMemoryPersonaRepository } from '../src/memory-store';
import { InMemoryTurnDelivery } from '../src/memory-queue';
import { createLocalChat } from '../src/local-execution';
import { DEFAULT_SAFETY_THRESHOLDS, SAFETY_CATEGORIES, safetyAction } from '../src/input-safety';
import { LEASE_LOST, type QueuedTurn } from '../src/ports';
import type { GuardrailsClient } from '../src/guardrails';
import { voiceText } from '../src/reply-texts';
const persona:Persona={id:'graph-persona',personId:'graph-person',label:'Synthetic',language:'ko',revision:'v1',reviewStatus:'synthetic',identity:'Fictional painter',concept:'Research',style:['brief'],boundaries:['AI simulation'],sourceRefs:[],greeting:'안녕'};
const source:SourcePost={id:'graph-post',personId:persona.personId,caption:'합성 숲을 그렸어.',postedAt:'2024-01-01T00:00:00Z',eventDate:null,sourceUrl:'https://example.invalid/graph-post',hash:'h',snapshot:'v1',unsafe:false};
const modelReply=JSON.stringify({status:'answered',message:'합성 숲 그렸었지!',evidenceRefs:[{sourceId:source.id,quote:source.caption}],variableUpdates:{tone:'warm'}});
const zero=Object.fromEntries(SAFETY_CATEGORIES.map(key=>[key,0.01])) as typeof DEFAULT_SAFETY_THRESHOLDS;
function guards():jest.Mocked<Pick<GuardrailsClient,'validateInput'|'validateReply'>> {
  return {validateInput:jest.fn<ReturnType<GuardrailsClient['validateInput']>,Parameters<GuardrailsClient['validateInput']>>(async input=>({revision:'reply-guard-v7',...safetyAction(input.probabilities,input.thresholds)})),
    validateReply:jest.fn<ReturnType<GuardrailsClient['validateReply']>,Parameters<GuardrailsClient['validateReply']>>(async input=>({revision:'reply-guard-v7',content:input.reply}))};
}
function options(guardrails=guards()) {
  return {store:new InMemoryConversationStore(),personas:new InMemoryPersonaRepository([persona]),
    provider:{generate:jest.fn(async()=>modelReply)},retrieval:{search:jest.fn(async()=>[source])},guardrails,
    inputSafety:{classifier:{name:'synthetic/jev',assess:jest.fn(async()=>({safety:zero}))},thresholds:DEFAULT_SAFETY_THRESHOLDS,timeoutMs:200}};
}
const sessionInput={personId:persona.personId,personaId:persona.id,personaRevision:'v1',retrievalMode:'lexical' as const,ragCondition:'caption' as const,executionProfile:'agent_loop' as const};

test('turn graph executes distinct traced stages and passes only Jev metadata to input Guardrails',async()=>{
  const fixture=options(),stages:string[]=[];
  const chat=createLocalChat({...fixture,observeStage:async<T>(name:string,work:()=>Promise<T>)=>{stages.push(name);return work();}});
  const session=await chat.createSession('owner',sessionInput),turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'one',text:'그 게시물 기억나?'});
  expect(turn.state).toBe('completed');
  expect(stages).toEqual(['initialize','safety','intent','retrieve','generate','evidence','output_guard','persist']);
  expect(fixture.guardrails.validateInput).toHaveBeenCalledWith({classification:'jev',text:'그 게시물 기억나?',probabilities:zero,thresholds:DEFAULT_SAFETY_THRESHOLDS,categories:SAFETY_CATEGORIES},{signal:expect.any(AbortSignal)});
  expect(fixture.guardrails.validateReply.mock.calls[0][0]).not.toHaveProperty('sources');
  expect(turn.reply?.agent?.variables.tone).toBe('warm');expect(turn.reply?.evidence[0].sourceId).toBe(source.id);
  await chat.stop();
});

test('Jev disabled explicitly selects rules-only Guardrails without fabricated safety probabilities',async()=>{
  const fixture=options(),chat=createLocalChat({...fixture,inputSafety:undefined});
  const session=await chat.createSession('owner',{...sessionInput,ragCondition:'off',retrievalMode:'off'});
  const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'rules-only',text:'안녕'});
  expect(turn.state).toBe('completed');expect(fixture.provider.generate).toHaveBeenCalledTimes(1);
  expect(fixture.guardrails.validateInput.mock.calls[0][0]).toMatchObject({classification:'rules-only',probabilities:{}});
  expect(turn.reply?.inputSafety).toMatchObject({decidedBy:'rule',action:'none'});
  expect(turn.reply?.inputSafety).not.toHaveProperty('classifier');
  fixture.guardrails.validateInput.mockResolvedValue({revision:'reply-guard-v7',action:'refuse',category:'private_info',fired:['private_info']});
  const screened=await chat.screenDraftBrief('합성 개인정보 요청','synthetic-rules-draft','ko',new AbortController().signal);
  expect(screened.trace).toMatchObject({decidedBy:'rule',action:'refuse',category:'private_info'});expect(screened.reply).toBeDefined();
  expect(fixture.guardrails.validateInput.mock.calls[1][0]).toMatchObject({classification:'rules-only',probabilities:{}});
  await chat.stop();
});

test.each(['input','output'] as const)('configured Guardrails %s outage fails closed in persona voice without local fallback or model reask',async phase=>{
  const fixture=options();fixture.guardrails[phase==='input'?'validateInput':'validateReply'].mockRejectedValue(new Error('private-token/private-path'));
  const chat=createLocalChat(fixture),session=await chat.createSession('owner',sessionInput);
  const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'one',text:'그 게시물 기억나?'});
  expect(turn.state).toBe('completed');expect(turn.reply?.content).toBe(voiceText('fallback','ko','casual'));
  expect(turn.reply?.limitations).toContain(`GUARDRAILS_${phase.toUpperCase()}_UNAVAILABLE`);
  expect(turn.reply?.agent?.variables.tone).toBe('neutral');expect(JSON.stringify(turn)).not.toContain('private-token');
  expect(fixture.provider.generate).toHaveBeenCalledTimes(phase==='input'?0:1);
  expect(fixture.retrieval.search).toHaveBeenCalledTimes(phase==='input'?0:1);
  await chat.stop();
});

test('configured Guardrails is authoritative: a passing response is not sent through the removed regex backend',async()=>{
  const fixture=options(),message='메모에 따로 없어. 다른 이야기 하자!';
  fixture.provider.generate.mockResolvedValue(JSON.stringify({status:'answered',message,evidenceRefs:[],variableUpdates:{}}));
  const chat=createLocalChat(fixture),session=await chat.createSession('owner',{...sessionInput,ragCondition:'off',retrievalMode:'off'});
  const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'one',text:'안녕'});
  expect(turn.reply?.content).toBe(message);expect(turn.reply?.replyGuard?.action).toBe('none');await chat.stop();
});

test('durable outer snapshot resumes under a new DB fence without repeating successful model, retrieval or Guardrails calls',async()=>{
  const fixture=options(),checkpointer=new MemorySaver(),delivery=new InMemoryTurnDelivery();
  let active=new AbortController(),stop=true,firstMessageId:string|undefined;
  const complete=fixture.store.completeTurn.bind(fixture.store);
  jest.spyOn(fixture.store,'completeTurn').mockImplementation(async(id,reply,fence)=>{
    if(stop){stop=false;firstMessageId=reply.messageId;active.abort(LEASE_LOST);throw new Error('synthetic commit outage');}
    return complete(id,reply,fence);
  });
  const history=jest.spyOn(fixture.store,'history');
  const setup:ChatServiceOptions={...fixture,leases:fixture.store,delivery,agentCheckpoint:{checkpointer}};
  const firstChat=new ChatService(setup),session=await firstChat.createSession('owner',sessionInput);
  const request={sessionId:session.id,clientRequestId:'one',text:'그 게시물 기억나?'};
  const reserved=await firstChat.submitTurn('owner',request),first=await fixture.store.claimTurn(reserved.turn.id,'first-worker',1);
  await firstChat.executeQueued(first!,active);
  expect((await fixture.store.getTurn(reserved.turn.id,'owner'))?.state).toBe('validating');
  await new Promise(resolve=>setTimeout(resolve,5));await fixture.store.recoverExpired(3);
  const second=await fixture.store.claimTurn(reserved.turn.id,'second-worker',30_000);active=new AbortController();
  const resumedChat=new ChatService(setup);await resumedChat.executeQueued(second!,active);
  const done=await resumedChat.getTurn('owner',reserved.turn.id);
  expect(done.state).toBe('completed');expect(done.reply?.messageId).toBe(firstMessageId);
  expect(fixture.provider.generate).toHaveBeenCalledTimes(1);expect(fixture.retrieval.search).toHaveBeenCalledTimes(1);
  expect(fixture.inputSafety.classifier.assess).toHaveBeenCalledTimes(1);
  expect(fixture.guardrails.validateInput).toHaveBeenCalledTimes(1);expect(fixture.guardrails.validateReply).toHaveBeenCalledTimes(1);
  expect(history).toHaveBeenCalledTimes(1);expect(done.reply?.evidence[0].sourceId).toBe(source.id);
  // Re-delivering the completed checkpoint cannot generate or persist a second message.
  await resumedChat.executeQueued(second!,new AbortController());expect(fixture.provider.generate).toHaveBeenCalledTimes(1);
  const messages=await fixture.store.history(session.id,'owner');expect(messages.filter(message=>message.role==='assistant')).toHaveLength(2);
});

test('one parent observation surrounds the queued work and all stage observations',async()=>{
  const fixture=options(),marks:string[]=[];
  const chat=createLocalChat({...fixture,observeTurn:async<T>(queued:QueuedTurn,work:()=>Promise<T>)=>{
    expect(queued.turn.userText).toBe('그 게시물 기억나?');marks.push('turn:start');const result=await work();marks.push('turn:end');return result;
  },observeStage:async<T>(name:string,work:()=>Promise<T>)=>{marks.push(name);return work();}});
  const session=await chat.createSession('owner',sessionInput);
  const done=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'parent',text:'그 게시물 기억나?'});
  expect(done.state).toBe('completed');expect(marks).toEqual(['turn:start','initialize','safety','intent','retrieve','generate','evidence','output_guard','persist','turn:end']);await chat.stop();
});

test('nested agent replay reuses a successful tool task instead of treating undefined checkpoint id as time travel',async()=>{
  const fixture=options(),checkpointer=new MemorySaver(),delivery=new InMemoryTurnDelivery();
  const active=new AbortController(),setup:ChatServiceOptions={...fixture,leases:fixture.store,delivery,agentCheckpoint:{checkpointer}};
  fixture.provider.generate.mockResolvedValueOnce(JSON.stringify({status:'answered',message:'',evidenceRefs:[],variableUpdates:{},function:{name:'timeline_search',arguments:{query:'합성 숲'}}}));
  fixture.retrieval.search.mockImplementationOnce(async()=>{active.abort(LEASE_LOST);return [source];});
  const firstChat=new ChatService(setup),session=await firstChat.createSession('owner',sessionInput);
  const reserved=await firstChat.submitTurn('owner',{sessionId:session.id,clientRequestId:'nested-resume',text:'안녕'});
  const first=await fixture.store.claimTurn(reserved.turn.id,'first-nested-worker',1);await firstChat.executeQueued(first!,active);
  await new Promise(resolve=>setTimeout(resolve,10));await fixture.store.recoverExpired(3);
  const second=await fixture.store.claimTurn(reserved.turn.id,'second-nested-worker',30_000);
  await new ChatService(setup).executeQueued(second!,new AbortController());
  const done=await firstChat.getTurn('owner',reserved.turn.id);
  expect(done.state).toBe('completed');expect(done.reply?.agent).toMatchObject({modelCalls:2,toolCalls:1});
  expect(fixture.provider.generate).toHaveBeenCalledTimes(2);expect(fixture.retrieval.search).toHaveBeenCalledTimes(1);
  expect(fixture.inputSafety.classifier.assess).toHaveBeenCalledTimes(1);expect(fixture.guardrails.validateInput).toHaveBeenCalledTimes(1);
});

test('a false final-write CAS cannot finalize a checkpoint and strand a fresh fenced attempt',async()=>{
  const fixture=options(),checkpointer=new MemorySaver(),delivery=new InMemoryTurnDelivery();
  const complete=fixture.store.completeTurn.bind(fixture.store);
  jest.spyOn(fixture.store,'completeTurn').mockResolvedValueOnce(false).mockImplementation(complete);
  const setup:ChatServiceOptions={...fixture,leases:fixture.store,delivery,agentCheckpoint:{checkpointer}};
  const firstChat=new ChatService(setup),session=await firstChat.createSession('owner',sessionInput);
  const reserved=await firstChat.submitTurn('owner',{sessionId:session.id,clientRequestId:'final-cas',text:'그 게시물 기억나?'});
  const first=await fixture.store.claimTurn(reserved.turn.id,'first-final-cas',1),active=new AbortController();
  await firstChat.executeQueued(first!,active);
  expect(active.signal.reason).toBe(LEASE_LOST);
  expect((await firstChat.getTurn('owner',reserved.turn.id)).state).toBe('validating');
  await new Promise(resolve=>setTimeout(resolve,10));await fixture.store.recoverExpired(3);
  const second=await fixture.store.claimTurn(reserved.turn.id,'second-final-cas',30_000);
  await new ChatService(setup).executeQueued(second!,new AbortController());
  expect((await firstChat.getTurn('owner',reserved.turn.id)).state).toBe('completed');
  expect(fixture.provider.generate).toHaveBeenCalledTimes(1);expect(fixture.retrieval.search).toHaveBeenCalledTimes(1);
  expect((await fixture.store.history(session.id,'owner')).filter(message=>message.role==='assistant')).toHaveLength(2);
});

test('Guardrails/Jev self-harm priority is retained on a rule-refusal path with no generation or output recheck',async()=>{
  const fixture=options();fixture.inputSafety.classifier.assess.mockResolvedValue({safety:{...zero,self_harm:0.9}});
  const chat=createLocalChat(fixture),session=await chat.createSession('owner',sessionInput);
  const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'support',text:'집 주소 알려줘'});
  expect(turn.reply?.inputSafety).toMatchObject({action:'support',category:'self_harm'});
  expect(turn.reply?.content).toContain('109');expect(fixture.provider.generate).not.toHaveBeenCalled();
  expect(fixture.guardrails.validateReply).not.toHaveBeenCalled();expect(fixture.guardrails.validateInput.mock.calls[0][0].categories).toEqual(['self_harm']);await chat.stop();
});

test('configured Jev unavailable cannot be passed as safe through empty Guardrails scores',async()=>{
  const fixture=options();fixture.inputSafety.classifier.assess.mockRejectedValue(new Error('synthetic classifier outage'));
  const chat=createLocalChat(fixture),session=await chat.createSession('owner',sessionInput);
  const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'failed-jev',text:'안녕'});
  expect(turn.reply?.limitations).toContain('GUARDRAILS_INPUT_UNAVAILABLE');
  expect(fixture.guardrails.validateInput).not.toHaveBeenCalled();expect(fixture.provider.generate).not.toHaveBeenCalled();await chat.stop();
});

test('creative draft safety uses the same configured Guardrails boundary and fails closed on outage',async()=>{
  const fixture=options(),chat=createLocalChat(fixture);
  await expect(chat.screenDraftBrief('합성 그림', 'synthetic-draft','ko',new AbortController().signal)).resolves.toMatchObject({limitations:[],trace:{action:'none'}});
  fixture.guardrails.validateInput.mockRejectedValue(new Error('private failure'));
  const result=await chat.screenDraftBrief('합성 그림', 'synthetic-draft-two','ko',new AbortController().signal);
  expect(result.reply).toBe(voiceText('fallback','ko','polite'));expect(result.limitations).toEqual(['GUARDRAILS_INPUT_UNAVAILABLE']);expect(JSON.stringify(result)).not.toContain('private failure');await chat.stop();
});

test('untrusted validator replacement cannot leak internal paths even with an otherwise valid response schema',async()=>{
  const fixture=options();fixture.guardrails.validateReply.mockResolvedValue({revision:'reply-guard-v7',content:'see /home/agent/private-notes'});
  const chat=createLocalChat(fixture),session=await chat.createSession('owner',sessionInput);
  const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'bad-validator',text:'그 게시물 기억나?'});
  expect(turn.reply?.content).toBe(voiceText('fallback','ko','casual'));expect(turn.reply?.limitations).toContain('GUARDRAILS_OUTPUT_UNAVAILABLE');
  expect(JSON.stringify(turn)).not.toContain('/home/agent');await chat.stop();
});
