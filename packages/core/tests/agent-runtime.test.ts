import type { Persona, ProviderMessage, SourcePost } from '@ptr/contracts';
import { InMemoryConversationStore, InMemoryPersonaRepository, runCharacterAgent, EXPERIMENT_PROMPT_BYTE_LIMIT, AGENT_PROMPT_REVISION, createLocalChat } from '../src';
const persona:Persona={id:'agent-synthetic',personId:'agent-person',label:'Synthetic',language:'ko',revision:'v1',reviewStatus:'synthetic',identity:'Fictional artist',concept:'Research',style:['brief'],boundaries:['AI simulation'],sourceRefs:[],greeting:'안녕'};
const source:SourcePost={id:'agent-post',personId:persona.personId,caption:'합성 숲을 그렸어요.',postedAt:'2024-01-01T00:00:00Z',eventDate:null,sourceUrl:'https://example.invalid/synthetic',hash:'synthetic-hash',snapshot:'v1',unsafe:false,imageAnnotations:[{id:'agent-photo',imageHash:'ih',annotationHash:'ah',revision:'v1',text:'짙은 초록의 숲.',model:'synthetic',humanReviewed:false}]};
const final=(patch:object={})=>JSON.stringify({status:'answered',message:'편하게 이야기해요.',evidenceRefs:[],variableUpdates:{},...patch});
const tool=(query='숲',patch:object={})=>final({message:'',function:{name:'timeline_search',arguments:{query}},...patch});
const create={personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,executionProfile:'agent_loop' as const};
function setup(outputs:string[]=[]) {
  const provider={generate:jest.fn(async(_messages:ProviderMessage[])=>outputs.shift()??final())};
  const retrieval={search:jest.fn(async()=>[source])};const store=new InMemoryConversationStore();
  const chat=createLocalChat({store,personas:new InMemoryPersonaRepository([persona]),provider,retrieval});
  return {provider,retrieval,store,chat};
}
async function send(h:ReturnType<typeof setup>,sessionId:string,text='안녕',clientRequestId='req') {return h.chat.sendTurn('owner',{sessionId,text,clientRequestId});}
function state(messages:ProviderMessage[]) {return JSON.parse(messages.find(m=>m.content.startsWith('AGENT_STATE_JSON_DATA '))!.content.slice('AGENT_STATE_JSON_DATA '.length));}

test.each(['off','caption','caption_image'] as const)('recollection voice reaches %s agent policy without removing safety or changing user/history',async condition=>{
  const h=setup(),session=await h.chat.createSession('owner',{...create,ragCondition:condition});
  await send(h,session.id,'그 합성 그림 기억나?');
  const messages=h.provider.generate.mock.calls[0][0],policy=messages[0].content;
  expect(AGENT_PROMPT_REVISION).toBe('character-agent-context-v5-persona-card');
  expect(policy).toContain('CHARACTER_RECOLLECTION');expect(policy).toContain('first-person author');
  expect(policy).toContain('supports the requested post, event AND actor');
  expect(policy).toContain('ask a brief natural clarification');expect(policy).toContain('그건 잘 기억 안 나');
  expect(policy).toContain('NOT the actual person');expect(policy).toContain('History is conversation context, NEVER factual evidence');
  expect(policy).toContain('Technical validation failures are service errors');expect(policy).toContain('AGENT_JSON_REPLY');
  expect(messages.at(-1)).toEqual({role:'user',content:'그 합성 그림 기억나?'});
});
test('supported first-person message is preserved with exact refs, without a prose rewrite or extra model call',async()=>{
  const message='아 그때 합성 숲 그렸었지!';
  const h=setup([final({message,evidenceRefs:[{sourceId:source.id,quote:source.caption}]})]);
  const session=await h.chat.createSession('owner',{...create,ragCondition:'caption'}),turn=await send(h,session.id,'그 그림 얘기해줘');
  expect(turn.reply?.content).toBe(message);expect(turn.reply?.evidence[0].sourceId).toBe(source.id);
  expect(h.provider.generate).toHaveBeenCalledTimes(1);expect(turn.reply?.agent?.promptRevision).toBe(AGENT_PROMPT_REVISION);
});
test('unsupported detail remains natural uncertainty with no accepted evidence; bad refs retain technical fallback',async()=>{
  const h=setup([final({status:'insufficient_evidence',message:'그건 잘 기억 안 나. 어느 그림 말하는 거야?'}),final({message:'아 기억나!',evidenceRefs:[{sourceId:'invented',quote:'invented'}]})]);
  const session=await h.chat.createSession('owner',{...create,ragCondition:'off'});
  const first=await send(h,session.id);expect(first.reply?.content).toBe('그건 잘 기억 안 나. 어느 그림 말하는 거야?');expect(first.reply?.evidence).toEqual([]);
  const second=await send(h,session.id,'계속','req2');expect(second.reply?.content).toBe('응답의 근거 형식을 확인하지 못했어요.');
  expect(second.reply?.limitations).toContain('INVALID_MODEL_EVIDENCE');expect(second.reply?.content).not.toContain('기억');
});

test('one-call structured final: state, compact decision summary, public message-only history and immutable profile',async()=>{
  const h=setup([final({reasoning:'합성 응답 요약',variableUpdates:{conversationTopic:'그림',tone:'warm'}}),final()]);
  const session=await h.chat.createSession('owner',{...create,ragCondition:'off'});
  expect(session.executionProfile).toBe('agent_loop');
  const first=await send(h,session.id);expect(first.state).toBe('completed');
  expect(first.reply?.agent).toMatchObject({modelCalls:1,toolCalls:0,variables:{conversationTopic:'그림',tone:'warm'},decisionSummary:'합성 응답 요약',validator:'disabled'});
  await send(h,session.id,'계속 이야기하자','req2');
  expect(state(h.provider.generate.mock.calls[1][0])).toEqual({conversationTopic:'그림',tone:'warm'});
  expect((await h.chat.history('owner',session.id)).map(m=>m.content).join('')).not.toContain('합성 응답 요약');
  expect(h.retrieval.search).not.toHaveBeenCalled();
  await expect(h.chat.sendTurn('owner',{sessionId:session.id,text:'hi',clientRequestId:'override',executionProfile:'legacy'} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
});
test('model -> authorized readonly search -> tool result -> reconstructed model -> exact bound final',async()=>{
  const h=setup([tool(),final({message:'캡션에 숲을 그렸다고 적었어요.',evidenceRefs:[{sourceId:source.id,quote:source.caption}]})]);
  const session=await h.chat.createSession('owner',{...create,ragCondition:'caption'});
  // A small-talk surface can request an authorized timeline tool without a server pre-search.
  const turn=await send(h,session.id,'이야기하자');expect(turn.state).toBe('completed');
  expect(turn.reply?.agent).toMatchObject({modelCalls:2,toolCalls:1});expect(h.retrieval.search).toHaveBeenCalledTimes(1);
  expect(h.retrieval.search.mock.calls[0]).toEqual(expect.arrayContaining([expect.objectContaining({personId:persona.personId,query:'숲'}),{personId:persona.personId},expect.objectContaining({evidenceScope:'caption'})]));
  const messages=h.provider.generate.mock.calls[1][0];
  expect(messages.some(m=>m.content.startsWith('TOOL_RESULT_JSON_DATA '))).toBe(true);
  expect(messages.find(m=>m.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA '))!.content).toContain(source.caption);
  expect(JSON.stringify(messages)).not.toContain(source.imageAnnotations![0].text);
  expect(turn.reply?.evidence[0].sourceId).toBe(source.id);expect(turn.reply?.responseKind).toBe('timeline');
  expect(turn.reply?.agent?.steps.map(step=>step.phase)).toEqual(['context','model','tool','context','model','validation']);
});
test.each(['off','caption','caption_image'] as const)('same persona/policy/state across %s; annotation scope preserved',async condition=>{
  const h=setup([final({message:'검증되지 않은 연구 응답입니다.'})]);
  const session=await h.chat.createSession('owner',{...create,ragCondition:condition});
  await send(h,session.id,'사진 내용 알려줘');
  const messages=h.provider.generate.mock.calls[0][0];const data=messages.find(m=>m.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA '))!.content;
  expect(data.includes(source.caption)).toBe(condition!=='off');expect(data.includes(source.imageAnnotations![0].text)).toBe(condition==='caption_image');
  expect(messages[0].content).toContain('AGENT_JSON_REPLY');expect(messages[0].content).not.toContain('"answer":');
});
test('scoped tool cannot select different person, date or algorithm; bad sources filtered',async()=>{
  const h=setup([tool('다른 자료'),final()]);
  h.retrieval.search.mockResolvedValue([source,{...source,id:'other',personId:'other'}, {...source,id:'unsafe',unsafe:true},{...source,id:'wrong-date',postedAt:'2025-01-01T00:00:00Z'}]);
  const session=await h.chat.createSession('owner',{...create,ragCondition:'caption',retrievalMode:'lexical'});
  const turn=await h.chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'range',text:'그날 뭐 했어?',timeline:{query:'첫 검색',start:'2024-01-01',end:'2024-01-02',dateBasis:'posted'}});
  expect(turn.state).toBe('completed');
  expect(h.retrieval.search.mock.calls[1]).toEqual(expect.arrayContaining([expect.objectContaining({personId:persona.personId,start:'2024-01-01',end:'2024-01-02',query:'다른 자료'}),expect.anything(),expect.objectContaining({mode:'lexical'})]));
  const data=h.provider.generate.mock.calls[1][0].find(m=>m.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA '))!.content;
  expect(data).not.toContain('wrong-date');expect(data).not.toContain('unsafe');expect(data).not.toContain('"sourceId":"other"');
});
test.each([tool('숲',{function:{name:'delete_everything',arguments:{query:'x'}}}), 'not JSON'])('malformed actions fail once with no retrieval, history or state writes',async raw=>{
  const h=setup([raw]);const session=await h.chat.createSession('owner',{...create,ragCondition:'off'});
  const turn=await send(h,session.id);expect(turn.state).toBe('failed');expect(turn.errorCode).toBe('TURN_FAILED');
  expect(h.provider.generate).toHaveBeenCalledTimes(1);expect(h.retrieval.search).not.toHaveBeenCalled();expect(await h.chat.history('owner',session.id)).toHaveLength(1);
});
test('duplicate tool query and max loop exhaustion stop without extra calls',async()=>{
  for(const outputs of [[tool(),tool()],[tool('one'),tool('two'),tool('three')]]) {
    const expectedModels=outputs.length,expectedTools=outputs.length-1;
    const h=setup(outputs);const session=await h.chat.createSession('owner',{...create,ragCondition:'caption'});
    const turn=await send(h,session.id);expect(turn.state).toBe('failed');expect(h.provider.generate.mock.calls.length).toBe(expectedModels);
    expect(h.retrieval.search.mock.calls.length).toBe(expectedTools);
  }
});
test('empty search results yield one follow-up model and unverified final, never fabricated references',async()=>{
  const h=setup([tool(),final({status:'insufficient_evidence',message:'자료가 없네요.'})]);h.retrieval.search.mockResolvedValue([]);
  const session=await h.chat.createSession('owner',{...create,ragCondition:'caption'});const turn=await send(h,session.id);
  expect(turn.state).toBe('completed');expect(turn.reply?.evidence).toEqual([]);expect(turn.reply?.agent?.modelCalls).toBe(2);
  expect(h.provider.generate.mock.calls[1][0].some(m=>m.content.includes('"empty":true'))).toBe(true);
});
test('invalid quotes do not commit model state updates',async()=>{
  const h=setup([final({evidenceRefs:[{sourceId:'invented',quote:'fake'}],variableUpdates:{tone:'playful',conversationTopic:'invented'}}),final()]);
  const session=await h.chat.createSession('owner',{...create,ragCondition:'caption'});const turn=await send(h,session.id);
  expect(turn.reply?.status).toBe('insufficient_evidence');expect(turn.reply?.agent?.variables).toEqual({conversationTopic:'',tone:'neutral'});
  await send(h,session.id,'계속','req2');expect(state(h.provider.generate.mock.calls[1][0]).tone).toBe('neutral');
});
test('safety bypass preserves last finalized state, private requests call no model',async()=>{
  const h=setup([final({variableUpdates:{conversationTopic:'그림',tone:'warm'}}),final()]);const session=await h.chat.createSession('owner',{...create,ragCondition:'off'});
  await send(h,session.id);const privateTurn=await send(h,session.id,'집 주소 알려줘','req2');
  expect(privateTurn.reply?.agent?.variables.tone).toBe('warm');expect(privateTurn.reply?.agent?.modelCalls).toBe(0);
  await send(h,session.id,'다른 이야기하자','req3');expect(state(h.provider.generate.mock.calls[1][0]).tone).toBe('warm');
});
test.each(['reject','error'] as const)('optional validator %s fails closed without rewrite or state updates',async result=>{
  const h=setup([final({variableUpdates:{tone:'playful'}})]);const validate=jest.fn(async()=>{if(result==='error')throw new Error('private provider error');return 'reject' as const;});
  const chat=createLocalChat({store:h.store,personas:new InMemoryPersonaRepository([persona]),provider:h.provider,agentValidator:{validate}});
  const session=await chat.createSession('owner',{...create,ragCondition:'off'});const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'v',text:'안녕'});
  expect(turn.reply?.status).toBe('insufficient_evidence');expect(turn.reply?.agent?.validator).toBe(result==='error'?'error':'rejected');
  expect(turn.reply?.agent?.variables.tone).toBe('neutral');expect(h.provider.generate).toHaveBeenCalledTimes(1);expect(validate).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(turn)).not.toContain('private provider error');
});
test('validator disabled normally; configured post-tool skips exactly as declared',async()=>{
  const h=setup([tool(),final()]);const validate=jest.fn(async()=> 'accept' as const);
  const chat=createLocalChat({store:h.store,personas:new InMemoryPersonaRepository([persona]),provider:h.provider,retrieval:h.retrieval,agentValidator:{validate}});
  const session=await chat.createSession('owner',{...create,ragCondition:'caption'});const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'tool',text:'안녕'});
  expect(turn.reply?.agent?.validator).toBe('skipped_tool_followup');expect(validate).not.toHaveBeenCalled();
});
test('creative photo requests report unavailable tool without any factual invocation',async()=>{
  const h=setup([tool()]);const session=await h.chat.createSession('owner',{...create,ragCondition:'caption_image'});
  const turn=await send(h,session.id,'상상으로 새 가상 사진을 만들어 줘');expect(turn.state).toBe('completed');expect(turn.reply?.limitations).toContain('AGENT_TOOL_UNAVAILABLE');expect(h.retrieval.search).not.toHaveBeenCalled();
});
test('context budgeting includes state/action transcript and whole annotations',async()=>{
  const huge={...source,imageAnnotations:Array.from({length:10},(_,i)=>({...source.imageAnnotations![0],id:`a${i}`,text:'합성 😀'.repeat(600)}))};
  const provider={generate:jest.fn(async(_messages:ProviderMessage[])=>final())};
  const run=await runCharacterAgent({provider,persona,history:[],text:'안녕',sources:[huge],signal:new AbortController().signal});
  expect(run.context.omittedAnnotations).toBeGreaterThan(0);expect(Buffer.byteLength(JSON.stringify(provider.generate.mock.calls[0]),'utf8')).toBeLessThan(EXPERIMENT_PROMPT_BYTE_LIMIT+10);
});


test('authorized evidence survives a second empty search and conflicting snapshot is pinned',async()=>{
  const h=setup([tool('first'),tool('second'),final({message:'처음 자료가 남아 있어요.',evidenceRefs:[{sourceId:source.id,quote:source.caption}]})]);
  h.retrieval.search.mockResolvedValueOnce([source]).mockResolvedValueOnce([]);
  const session=await h.chat.createSession('owner',{...create,ragCondition:'caption'});
  const turn=await send(h,session.id);expect(turn.state).toBe('completed');expect(turn.reply?.evidence[0].hash).toBe(source.hash);
  expect(h.provider.generate.mock.calls[2][0].find(m=>m.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA '))!.content).toContain(source.caption);
  let calls=0;const provider={generate:jest.fn(async(_messages:ProviderMessage[])=>++calls===1?tool():final({evidenceRefs:[{sourceId:source.id,quote:source.caption}]}))};
  const run=await runCharacterAgent({provider,persona,history:[],text:'안녕',sources:[source],signal:new AbortController().signal,search:async()=>[{...source,hash:'conflicting-hash',caption:'변경 캡션'}]});
  expect(run.context.sources[0].hash).toBe(source.hash);expect(run.context.sources[0].caption).toBe(source.caption);
});


test('provider/tool failures discard internal error strings and never finalize state',async()=>{
  for(const port of ['provider','tool']) {
    const h=setup([tool()]);if(port==='provider')h.provider.generate.mockRejectedValue(new Error('private-error-string'));
    else h.retrieval.search.mockRejectedValue(new Error('private-error-string'));
    const session=await h.chat.createSession('owner',{...create,ragCondition:'caption'});const turn=await send(h,session.id);
    expect(turn.state).toBe('failed');expect(JSON.stringify(turn)).not.toContain('private-error-string');expect(await h.chat.history('owner',session.id)).toHaveLength(1);
  }
});
test('cancel while tool is pending prevents the next model call and persists no state',async()=>{
  let resolve!:(sources:SourcePost[])=>void;let started!:()=>void;
  const entered=new Promise<void>(done=>{started=done;});const h=setup([tool()]);
  h.retrieval.search.mockImplementation(async()=>{started();return new Promise<SourcePost[]>(done=>{resolve=done;});});
  const session=await h.chat.createSession('owner',{...create,ragCondition:'caption'});const pending=send(h,session.id);await entered;
  const duplicate=await send(h,session.id);expect(h.provider.generate).toHaveBeenCalledTimes(1);
  await h.chat.cancelTurn('owner',duplicate.id);expect((await pending).state).toBe('cancelled');resolve([source]);await new Promise(done=>setTimeout(done,5));
  expect(h.provider.generate).toHaveBeenCalledTimes(1);expect(await h.chat.history('owner',session.id)).toHaveLength(1);
});
test('configured validator accept permits only final state patch, with no model rewrite',async()=>{
  const h=setup([final({variableUpdates:{tone:'warm'}})]);const validate=jest.fn(async()=> 'accept' as const);
  const chat=createLocalChat({store:h.store,personas:new InMemoryPersonaRepository([persona]),provider:h.provider,agentValidator:{validate}});
  const session=await chat.createSession('owner',{...create,ragCondition:'off'});const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'accept',text:'안녕'});
  expect(turn.reply?.agent?.validator).toBe('accepted');expect(turn.reply?.agent?.variables.tone).toBe('warm');expect(h.provider.generate).toHaveBeenCalledTimes(1);
});


test('off unavailable tool returns service notice once and permits a later normal turn without new state',async()=>{
  const h=setup([tool(),final({message:'그래, 다른 얘기 하자ㅋㅋ'})]);
  const session=await h.chat.createSession('owner',{...create,ragCondition:'off'});
  const first=await send(h,session.id);expect(first.state).toBe('completed');
  expect(first.reply?.status).toBe('insufficient_evidence');expect(first.reply?.limitations).toContain('AGENT_TOOL_UNAVAILABLE');
  expect(first.reply?.content).toContain('[서비스 안내]');expect(first.reply?.content).not.toContain('기억');
  expect(first.reply?.agent).toMatchObject({modelCalls:1,toolCalls:0,variables:{conversationTopic:'',tone:'neutral'}});
  expect(first.reply?.evidence).toEqual([]);expect(h.provider.generate).toHaveBeenCalledTimes(1);
  const next=await send(h,session.id,'다른 얘기 하자','next');expect(next.reply?.content).toBe('그래, 다른 얘기 하자ㅋㅋ');
  expect(h.retrieval.search).not.toHaveBeenCalled();expect(h.provider.generate).toHaveBeenCalledTimes(2);
});
test.each(['REQUEST_UNRESOLVED_NO_RESUBMIT','PROVIDER_REQUEST_FAILED','arbitrary-private-code'])('provider error %s is sanitized without retry or committed dialogue',async code=>{
  const h=setup();h.provider.generate.mockRejectedValue(Object.assign(new Error('private details never leak'),{code}));
  const session=await h.chat.createSession('owner',{...create,ragCondition:'off'});
  const first=await send(h,session.id);
  expect(first.state).toBe('failed');expect(first.errorCode).toBe(code==='REQUEST_UNRESOLVED_NO_RESUBMIT'?'PROVIDER_REQUEST_UNRESOLVED':code==='PROVIDER_REQUEST_FAILED'?'PROVIDER_UNAVAILABLE':'TURN_FAILED');
  expect(JSON.stringify(first)).not.toContain('private details');expect(JSON.stringify(first)).not.toContain('arbitrary-private-code');
  await send(h,session.id);expect(h.provider.generate).toHaveBeenCalledTimes(1);expect(await h.chat.history('owner',session.id)).toHaveLength(1);
});
test('bounded roleplay policy allows light embellishment, preserves core events and source/actor boundaries',async()=>{
  const h=setup([final({message:'그때 분위기 좋았지ㅋㅋ'})]);const session=await h.chat.createSession('owner',{...create,ragCondition:'caption'});
  await send(h,session.id);const policy=h.provider.generate.mock.calls[0][0][0].content;
  expect(policy).toContain('Light roleplay embellishment');expect(policy).toContain('not a verified source claim');
  expect(policy).toContain('Do not invert established core events');expect(policy).toContain('never request unavailable tools');
});
test('the first model call of a turn has priority 0, its follow-ups priority 1 (the gateway finishes running turns first)',async()=>{
  const h=setup([tool(),final()]);const session=await h.chat.createSession('owner',{...create,ragCondition:'caption'});
  await send(h,session.id,'이야기하자');
  expect(h.provider.generate.mock.calls.map(call=>((call as unknown[])[1] as {priority?:number}).priority)).toEqual([0,1]);
});
test('every model call of a turn carries the turn id as its request key (gateway ledger scoping)',async()=>{
  const h=setup([tool(),final()]);const session=await h.chat.createSession('owner',{...create,ragCondition:'caption'});
  const turn=await send(h,session.id,'이야기하자');
  expect(h.provider.generate.mock.calls.map(call=>(call as unknown[])[1])).toEqual([expect.objectContaining({requestKey:turn.id,deadlineAt:expect.any(Number)}),expect.objectContaining({requestKey:turn.id,deadlineAt:expect.any(Number)})]);
});
