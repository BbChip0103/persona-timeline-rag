import type { ChatTurn } from '@ptr/contracts';
import { publicTurn } from '../src/public-turn';
test('public turn explicit allowlist excludes unknown runtime fields, state, sourceContext and raw tool query',()=>{
  const turn:ChatTurn={id:'turn',sessionId:'session',ownerId:'private-owner',clientRequestId:'req',userText:'안녕',sequence:1,state:'completed',createdAt:'2024-01-01T00:00:00Z',reply:{sessionId:'session',turnId:'turn',messageId:'message',personId:'person',personaRevision:'v1',responseKind:'small_talk',status:'answered',content:'안녕!',claims:[],evidence:[],limitations:[],agent:{revision:'v1',promptRevision:'v1',modelCalls:2,toolCalls:1,variables:{conversationTopic:'private-topic',tone:'warm'},decisionSummary:'private-summary',steps:[{phase:'tool',iteration:0,query:'private-tool-query'}],validator:'disabled'},sourceContext:{revision:'v1',references:[]},retrievalContext:{revision:'v1',action:'search',query:'private-tool-query',contextTurnIds:[],reusedSourceIds:[]}}};
  const raw=JSON.stringify(publicTurn({...turn,rawProvider:'private-raw'} as ChatTurn,'harness'));
  expect(raw).toContain('안녕!');for(const value of ['private-owner','private-topic','private-summary','private-tool-query','private-raw','sourceContext','retrievalContext'])expect(raw).not.toContain(value);
});
test('intent routing trace stays internal',()=>{
  const turn:ChatTurn={id:'turn',sessionId:'session',ownerId:'owner',clientRequestId:'req',userText:'안녕',sequence:1,state:'completed',createdAt:'2024-01-01T00:00:00Z',reply:{sessionId:'session',turnId:'turn',messageId:'message',personId:'person',personaRevision:'v1',responseKind:'timeline',status:'answered',content:'안녕!',claims:[],evidence:[],limitations:[],
    intentRouting:{decidedBy:'classifier',classifier:'typesafe/jev-1.13',ruleIntent:'small_talk',label:'timeline',confidence:0.9}}};
  const raw=JSON.stringify(publicTurn(turn,'harness'));
  for(const value of ['intentRouting','typesafe','classifier'])expect(raw).not.toContain(value);
});
test('input safety trace stays internal',()=>{
  const turn:ChatTurn={id:'turn',sessionId:'session',ownerId:'owner',clientRequestId:'req',userText:'안녕',sequence:1,state:'completed',createdAt:'2024-01-01T00:00:00Z',reply:{sessionId:'session',turnId:'turn',messageId:'message',personId:'person',personaRevision:'v1',responseKind:'unsupported',status:'out_of_scope',content:'그런 이야기는 어려워요.',claims:[],evidence:[],limitations:[],
    inputSafety:{decidedBy:'classifier',classifier:'typesafe/jev-1.13',action:'refuse',category:'sexual',fired:['sexual'],probabilities:{prompt_injection:0.01,sexual:0.97,violence_gore:0.01,self_harm:0.01,hate_harassment:0.01,illegal_dangerous:0.01,private_info:0.01}}}};
  const raw=JSON.stringify(publicTurn(turn,'harness'));
  expect(Object.keys(JSON.parse(raw).reply).sort()).toEqual(['claims','content','evidence','limitations','messageId','personId','personaRevision','responseKind','sessionId','status','turnId']);
  for(const value of ['inputSafety','typesafe','sexual','probabilities','refuse'])expect(raw).not.toContain(value);
});

test('web projection omits research fields while harness projection keeps them',()=>{
  const turn:ChatTurn={id:'turn',sessionId:'session',ownerId:'owner',clientRequestId:'req',userText:'합성 질문',sequence:1,state:'completed',createdAt:'2024-01-01T00:00:00Z',reply:{
    sessionId:'session',turnId:'turn',messageId:'message',personId:'person',personaRevision:'v1',responseKind:'timeline',status:'answered',content:'합성 답변',
    claims:[{text:'합성 주장',evidenceRefs:[{sourceId:'source',quote:'합성 인용',start:0,end:5}]}],
    evidence:[{sourceId:'source',personId:'person',sourceUrl:'https://example.invalid/source',postedAt:'2024-01-01T00:00:00Z',eventDate:null,snapshot:'합성',hash:'hash',quote:'합성 인용'}],
    limitations:['합성 한계'],grounding:'source_bound_quotes',promptEvidence:{sourceIds:['source'],annotationIds:[],omittedAnnotations:0,promptBytes:1},
  }};
  const web=publicTurn(turn,'web');const harness=publicTurn(turn,'harness');
  for(const field of ['evidence','limitations','grounding','claims','promptEvidence']) {
    expect(web.reply).not.toHaveProperty(field);
    expect(harness.reply).toHaveProperty(field);
  }
  expect(web.reply?.content).toBe('합성 답변');expect(harness.reply?.content).toBe('합성 답변');
  expect(JSON.stringify(web)).not.toContain('합성 인용');
  expect(JSON.stringify(harness)).toContain('합성 인용');
});

test('operator guard diagnostics expose only fixed class, stage and code to harness',()=>{
  const turn:ChatTurn={id:'turn',sessionId:'session',ownerId:'owner',clientRequestId:'req',userText:'합성 질문',sequence:1,state:'completed',createdAt:'2024-01-01T00:00:00Z',reply:{
    sessionId:'session',turnId:'turn',messageId:'message',personId:'person',personaRevision:'v1',responseKind:'small_talk',status:'insufficient_evidence',content:'다시 말해 줘.',claims:[],evidence:[],limitations:['GUARDRAILS_OUTPUT_UNAVAILABLE'],
    operatorMetadata:{guardStage:'output_guard',exceptionClass:'ValueError',code:'GUARDRAILS_OUTPUT_UNAVAILABLE'},
  }};
  expect(publicTurn(turn,'web').reply).not.toHaveProperty('operatorMetadata');
  expect(publicTurn(turn,'harness').reply).toHaveProperty('operatorMetadata',{
    guardStage:'output_guard',exceptionClass:'ValueError',code:'GUARDRAILS_OUTPUT_UNAVAILABLE',
  });
});

test('reply origin and repeat check stay in the operator harness',()=>{
  const turn:ChatTurn={id:'turn',sessionId:'session',ownerId:'owner',clientRequestId:'req',userText:'합성 질문',sequence:2,state:'completed',createdAt:'2024-01-01T00:00:00Z',reply:{
    sessionId:'session',turnId:'turn',messageId:'message',personId:'person',personaRevision:'v1',responseKind:'small_talk',status:'answered',content:'합성 답변',claims:[],evidence:[],limitations:[],
    operatorTrace:{path:'identity_variant',code:'REPEATED_IDENTITY_REPLY',repeatChecked:true,previousAvailable:true},
  }};
  expect(publicTurn(turn,'web').reply).not.toHaveProperty('operatorTrace');
  expect(publicTurn(turn,'harness').reply).toHaveProperty('operatorTrace',{
    path:'identity_variant',code:'REPEATED_IDENTITY_REPLY',repeatChecked:true,previousAvailable:true,
  });
});
