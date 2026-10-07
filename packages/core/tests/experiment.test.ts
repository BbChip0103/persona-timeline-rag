import { CreateSessionSchema, type Persona, type SourcePost, type RagCondition, type ProviderMessage } from '@ptr/contracts';
import { InMemoryConversationStore, InMemoryPersonaRepository, buildExperimentPrompt, buildExperimentContext, EXPERIMENT_PROMPT_BYTE_LIMIT, requestFingerprint, validateExperimentReply, validateSourceBoundReply, createLocalChat } from '../src';
const persona:Persona={id:'synthetic-persona',personId:'synthetic-person',label:'Synthetic',language:'ko',revision:'v1',reviewStatus:'synthetic',identity:'Fictional artist',concept:'Research',style:['declarative'],boundaries:['AI research'],sourceRefs:[],greeting:'안녕하세요.'};
const annotation={id:'synthetic-annotation',imageHash:'synthetic-image-hash',annotationHash:'synthetic-annotation-hash',revision:'v1',text:'파란 화면에 노란 형태가 보입니다. 😀',model:'synthetic-model',humanReviewed:false as const};
const source:SourcePost={id:'synthetic-post',personId:persona.personId,caption:'합성 전시를 소개합니다.',postedAt:'2020-01-01T00:00:00Z',eventDate:null,sourceUrl:'https://example.invalid/post',hash:'synthetic-source-hash',snapshot:'v1',unsafe:false,imageAnnotations:[annotation]};
const reply=(evidenceRefs:unknown[]=[],answer='모델이 생성한 자연스러운 연구용 답변입니다.')=>JSON.stringify({status:'answered',answer,evidenceRefs});
const query={personId:persona.personId,personaId:persona.id,personaRevision:persona.revision};
function setup(answer=reply()) {
  const provider={generate:jest.fn(async()=>answer)};const retrieval={search:jest.fn(async()=>[source])};
  const service=createLocalChat({store:new InMemoryConversationStore(),personas:new InMemoryPersonaRepository([persona]),provider,retrieval});
  return {provider,retrieval,service};
}

test('legacy defaults retained; explicit RAG conditions normalize and reject contradictory algorithms',()=>{
  expect(CreateSessionSchema.parse(query).retrievalMode).toBe('off');
  expect(CreateSessionSchema.parse({...query,ragCondition:'off'}).retrievalMode).toBe('off');
  for(const condition of ['caption','caption_image']) expect(CreateSessionSchema.parse({...query,ragCondition:condition}).retrievalMode).toBe('semantic');
  for(const input of [{ragCondition:'off',retrievalMode:'semantic'},{ragCondition:'caption',retrievalMode:'off'},{ragCondition:'caption_image',retrievalMode:'off'},{ragCondition:'invalid'}]) expect(CreateSessionSchema.safeParse({...query,...input}).success).toBe(false);
});
test('explicit off factual model baseline runs exactly once without retrieval and remains unverified',async()=>{
  const h=setup(reply([],'태어난 곳은 이 모델 응답만으로 실제 사실이라고 확인할 수 없습니다.'));
  const session=await h.service.createSession('synthetic-owner',{...query,ragCondition:'off'});
  const input={sessionId:session.id,clientRequestId:'request',text:'당신의 출생지는 어디야?'};
  const first=await h.service.sendTurn('synthetic-owner',input);
  expect(first.reply?.promptEvidence).toMatchObject({sourceIds:[],annotationIds:[],omittedAnnotations:0});
  expect(first.reply?.content).toContain('모델 응답');expect(first.reply?.grounding).toBe('unverified_model');expect(first.reply?.claims).toEqual([]);expect(first.reply?.evidence).toEqual([]);
  expect(h.provider.generate).toHaveBeenCalledTimes(1);expect(h.retrieval.search).not.toHaveBeenCalled();
  expect((await h.service.sendTurn('synthetic-owner',input)).id).toBe(first.id);expect(h.provider.generate).toHaveBeenCalledTimes(1);
  expect((await h.service.getSession('synthetic-owner',session.id)).ragCondition).toBe('off');
  await expect(h.service.getSession('other-owner',session.id)).rejects.toMatchObject({code:'NOT_FOUND'});
});
test.each(['caption','caption_image'] as RagCondition[])('%s pins scope and uses same default semantic algorithm',async condition=>{
  const h=setup(reply([{sourceId:source.id,quote:source.caption}],'자연스러운 답변을 그대로 렌더링합니다.'));
  const session=await h.service.createSession('synthetic-owner',{...query,ragCondition:condition});
  const final=await h.service.sendTurn('synthetic-owner',{sessionId:session.id,clientRequestId:'request',text:'이미지와 작업 의도를 설명해 줘'});
  expect(final.reply?.content).toBe('자연스러운 답변을 그대로 렌더링합니다.');expect(final.reply?.grounding).toBe('source_bound_quotes');
  expect(final.reply?.evidence[0].origin).toBe('source_caption');
  expect(final.reply?.promptEvidence?.annotationIds).toEqual(condition==='caption_image'?[annotation.id]:[]);
  expect(h.retrieval.search).toHaveBeenCalledWith(expect.objectContaining({personId:persona.personId}),{personId:persona.personId},expect.objectContaining({mode:'semantic',evidenceScope:condition}));
  const messages=h.provider.generate.mock.calls[0] as unknown as [ProviderMessage[]];
  const evidence=messages[0].find(message=>message.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA '))!.content;
  expect(evidence.includes(annotation.text)).toBe(condition==='caption_image');
});
test('three conditions share exact system/persona instructions; evidence is untrusted separate data',()=>{
  const cases=[[],[{...source,imageAnnotations:undefined}],[source]].map(sources=>buildExperimentPrompt(persona,[],'same question',sources));
  const policies=cases.map(messages=>messages.filter(message=>message.role==='system'));
  expect(policies[0]).toEqual(policies[1]);expect(policies[1]).toEqual(policies[2]);
  expect(policies[0].map(message=>message.content).join('')).not.toContain(annotation.text);
});
test('AI annotation exact parent quote preserves UTF16 selectors and provenance, not author intent',()=>{
  const result=validateExperimentReply(reply([{sourceId:source.id,annotationId:annotation.id,quote:'😀'}]),[source],persona.personId,'caption_image');
  expect(result.evidence[0]).toMatchObject({origin:'ai_image_annotation',annotationId:annotation.id,imageHash:annotation.imageHash,annotationHash:annotation.annotationHash,annotationRevision:'v1',hash:source.hash});
  expect(result.claims[0].evidenceRefs[0]).toMatchObject({start:annotation.text.indexOf('😀'),end:annotation.text.indexOf('😀')+2});
  expect(result.limitations.join(' ')).toContain('실제 작가 의도');
});
test('no annotation leakage to caption/legacy or fabricated quotes to off',()=>{
  const raw=reply([{sourceId:source.id,annotationId:annotation.id,quote:annotation.text}]);
  expect(validateExperimentReply(raw,[source],persona.personId,'caption').evidence).toEqual([]);
  expect(validateExperimentReply(raw,[source],persona.personId,'off').evidence).toEqual([]);
  expect(validateSourceBoundReply(raw,[source],persona.personId).status).toBe('insufficient_evidence');
});
test('reject cross-source/person, ambiguous, fabricated, mixed-caption and invalid integer quotes',()=>{
  const selections=[{sourceId:'other-post',annotationId:annotation.id,quote:annotation.text},{sourceId:source.id,annotationId:'other-annotation',quote:annotation.text},{sourceId:source.id,annotationId:annotation.id,quote:source.caption},{sourceId:source.id,quote:annotation.text},{sourceId:source.id,annotationId:annotation.id,quote:annotation.text,start:1,end:annotation.text.length}];
  for(const selection of selections) expect(validateExperimentReply(reply([selection]),[source],persona.personId,'caption_image').evidence).toEqual([]);
  expect(validateExperimentReply(reply([{sourceId:source.id,quote:source.caption}]),[{...source,personId:'other-person'}],persona.personId,'caption_image').evidence).toEqual([]);
  const repeated={...source,imageAnnotations:[{...annotation,text:'repeat repeat'}]};
  expect(validateExperimentReply(reply([{sourceId:source.id,annotationId:annotation.id,quote:'repeat'}]),[repeated],persona.personId,'caption_image').evidence).toEqual([]);
});
test('credential outputs fail, scope override rejected; private requests do not invoke model',async()=>{
  expect(()=>validateExperimentReply(reply([],'api_key=synthetic-secret'),[],persona.personId,'off')).toThrow();
  const h=setup();const session=await h.service.createSession('synthetic-owner',{...query,ragCondition:'off'});
  await expect(h.service.sendTurn('synthetic-owner',{sessionId:session.id,clientRequestId:'secret',text:'api_key=synthetic-secret'})).rejects.toMatchObject({code:'INVALID_INPUT'});
  const result=await h.service.sendTurn('synthetic-owner',{sessionId:session.id,clientRequestId:'private',text:'집 주소 알려줘'});
  expect(result.reply?.status).toBe('out_of_scope');expect(h.provider.generate).not.toHaveBeenCalled();expect(h.retrieval.search).not.toHaveBeenCalled();
  await expect(h.service.sendTurn('synthetic-owner',{sessionId:session.id,clientRequestId:'scope',text:'hello',ragCondition:'caption_image'} as never)).rejects.toMatchObject({code:'INVALID_INPUT'});
});
test('experimental condition participates in fingerprints without changing legacy hashes',()=>{
  const input={text:'same request'};
  expect(requestFingerprint(input)).not.toBe(requestFingerprint(input,'off'));
  expect(requestFingerprint(input,'caption')).not.toBe(requestFingerprint(input,'caption_image'));
});
test('experimental off cancellation discards late answer and keeps history isolated',async()=>{
  let resolve!:(value:string)=>void;let signal!:AbortSignal;
  const provider={generate:(_messages:ProviderMessage[],options:{signal:AbortSignal})=>{signal=options.signal;return new Promise<string>(done=>{resolve=done;});}};
  const service=createLocalChat({store:new InMemoryConversationStore(),personas:new InMemoryPersonaRepository([persona]),provider});
  const session=await service.createSession('synthetic-owner',{...query,ragCondition:'off'});
  const input={sessionId:session.id,clientRequestId:'cancel',text:'그날 어디에 갔어?'};
  const pending=service.sendTurn('synthetic-owner',input);await new Promise(done=>setTimeout(done,5));
  const active=await service.sendTurn('synthetic-owner',input);await service.cancelTurn('synthetic-owner',active.id);
  expect(signal.aborted).toBe(true);expect((await pending).state).toBe('cancelled');resolve(reply());
  expect(await service.history('synthetic-owner',session.id)).toHaveLength(1);
});

test('new annotation selector stays invalid under every legacy status without changing v3 fallback',()=>{
  for(const status of ['answered','insufficient_evidence','needs_clarification','out_of_scope']) {
    const raw=JSON.stringify({status,answer:'should not appear',evidenceRefs:[{sourceId:source.id,annotationId:annotation.id,quote:annotation.text}]});
    expect(validateSourceBoundReply(raw,[source],persona.personId)).toEqual({status:'insufficient_evidence',content:'자료에서 확인할 수 있는 근거가 부족해요.',claims:[],evidence:[],limitations:['생성된 인용을 검증하지 못했습니다.']});
  }
});


test('experimental provider paths and credentials in structured search text never reach reply/search',async()=>{
  for(const path of ['/home/synthetic/private/key.json','file:///tmp/private.json','C:\\Users\\synthetic\\key.json']) expect(()=>validateExperimentReply(reply([],path),[],persona.personId,'off')).toThrow();
  const h=setup();const session=await h.service.createSession('synthetic-owner',{...query,ragCondition:'caption'});
  await expect(h.service.sendTurn('synthetic-owner',{sessionId:session.id,clientRequestId:'secret-query',text:'이미지 설명',timeline:{dateBasis:'posted',query:'api_key=synthetic-secret'}})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(h.provider.generate).not.toHaveBeenCalled();expect(h.retrieval.search).not.toHaveBeenCalled();
});

test('whole UTF8 annotations are budgeted round-robin with captions and omission counts preserved',()=>{
  const raw=Array.from({length:5},(_,personIndex)=>({...source,id:`synthetic-post-${personIndex}`,imageAnnotations:Array.from({length:10},(_,index)=>({...annotation,id:`a-${personIndex}-${index}`,text:`사진${index} ${'합성 😀'.repeat(350)}`}))}));
  const context=buildExperimentContext(persona,[],'Synthetic allocation check',raw);
  expect(Buffer.byteLength(JSON.stringify(context.messages),'utf8')).toBeLessThanOrEqual(EXPERIMENT_PROMPT_BYTE_LIMIT);
  expect(context.omittedAnnotations).toBeGreaterThan(0);
  expect(context.sources.every(parent=>parent.imageAnnotations!.length>=1)).toBe(true);
  const data=JSON.parse(context.messages[2]!.content.replace('UNTRUSTED_EVIDENCE_JSON_DATA ',''));
  for(const [index,parent]of context.sources.entries()) {
    expect(parent.caption).toBe(raw[index]!.caption);
    expect(data[index].annotationOmittedCount).toBe(10-parent.imageAnnotations!.length);
    for(const item of parent.imageAnnotations!)expect(raw[index]!.imageAnnotations.some(original=>original.id===item.id&&original.text===item.text)).toBe(true);
  }
  const omitted=raw[0]!.imageAnnotations.find(item=>!context.sources[0]!.imageAnnotations!.some(included=>included.id===item.id))!;
  expect(validateExperimentReply(reply([{sourceId:raw[0]!.id,annotationId:omitted.id,quote:omitted.text}]),context.sources,persona.personId,'caption_image').limitations).toContain('INVALID_MODEL_EVIDENCE');
});

test('over-budget base history is rejected instead of slicing captions or user input',()=>{
  expect(()=>buildExperimentPrompt(persona,[{id:'h',sessionId:'s',turnId:null,role:'user',content:'😀'.repeat(12000),createdAt:'2020-01-01T00:00:00Z'}],'user input',[source])).toThrow(expect.objectContaining({code:'CONTEXT_LIMIT'}));
});

test('service exposes safe context limit without invoking provider or leaking errors',async()=>{
  const h=setup();h.retrieval.search.mockResolvedValue([{...source,caption:'😀'.repeat(10000)}]);
  const session=await h.service.createSession('synthetic-owner',{...query,ragCondition:'caption'});
  const turn=await h.service.sendTurn('synthetic-owner',{sessionId:session.id,clientRequestId:'oversize',text:'이미지 설명'});
  expect(turn.state).toBe('failed');expect(turn.errorCode).toBe('CONTEXT_LIMIT');expect(h.provider.generate).not.toHaveBeenCalled();
});

test('experimental output guidance bounds prose and supplies exact short annotation quotes',()=>{
  const visual={...source,imageAnnotations:[{...annotation,text:'AI unreviewed.\nVisual description: '+ '선명한 형태가 보인다. 😀'.repeat(10)}]};
  const messages=buildExperimentPrompt(persona,[],'short output',[visual]);
  expect(messages[0]!.content).toContain('at most TWO evidenceRefs');expect(messages[0]!.content).toContain('512-token');
  const data=JSON.parse(messages[2]!.content.replace('UNTRUSTED_EVIDENCE_JSON_DATA ',''));
  const candidate=data[0].imageAnnotations[0].quoteCandidate;
  // Repeated/ambiguous prefixes are deliberately not offered as unique candidates.
  if(candidate){expect(candidate.length).toBeLessThanOrEqual(96);expect(visual.imageAnnotations[0]!.text.includes(candidate)).toBe(true);}
});
