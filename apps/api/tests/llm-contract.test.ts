import {validateWire} from '../../../contracts/llm/v2/validate';
import {validateWire as validateV1} from '../../../contracts/llm/v1/validate';
const start={contractVersion:2,turnId:'00000000-0000-4000-8000-000000000001',dispatchSeq:0,jobId:'t-00000000-0000-4000-8000-000000000001-0',lockToken:'synthetic-token',executionId:'00000000-0000-4000-8000-000000000002'};
it('strictly accepts the shared synthetic Start contract',()=>expect(validateWire('StartRequest',start)).toEqual(start));
it.each([{...start,contractVersion:1},{...start,dispatchSeq:'0'},{...start,extra:true},{...start,dispatchSeq:Infinity},{...start,lockToken:''},{...start,turnId:'not-uuid'},{...start,dispatchSeq:9007199254740992}])('rejects incompatible or coerced wire payload',value=>expect(()=>validateWire('StartRequest',value)).toThrow());
it('rejects UTF8 overflow, not just codepoint overflow',()=>expect(()=>validateWire('StartRequest',{...start,lockToken:'한'.repeat(400)})).toThrow());
it('accepts a runtime-owned speech level in persisted agent variables',()=>{
  const agent={revision:'synthetic',promptRevision:'synthetic',modelCalls:1,toolCalls:0,
    variables:{conversationTopic:'',tone:'neutral',speechLevel:'casual',lastYearRecallUsed:true},steps:[],validator:'disabled'};
  expect(validateWire('Agent',agent)).toEqual(agent);
  expect(()=>validateWire('Agent',{...agent,variables:{...agent.variables,speechLevel:'invented'}})).toThrow();
  expect(()=>validateWire('Agent',{...agent,variables:{...agent.variables,lastYearRecallUsed:'yes'}})).toThrow();
});
import corpus from '../../../contracts/llm/v2/corpus.json';
it.each(corpus)('shared crosslanguage corpus: $name',entry=>{if(entry.valid)expect(()=>validateWire(entry.schema,entry.value)).not.toThrow();else expect(()=>validateWire(entry.schema,entry.value)).toThrow();});
import oldCorpus from '../../../contracts/llm/v1/corpus.json';
it.each(oldCorpus)('frozen v1 corpus: $name',entry=>{if(entry.valid)expect(()=>validateV1(entry.schema,entry.value)).not.toThrow();else expect(()=>validateV1(entry.schema,entry.value)).toThrow();});

it('v2 accepts speech level and rejects a v1 peer with a version-specific error',()=>{
  expect(validateWire('StartRequest',start)).toMatchObject({contractVersion:2});
  expect(()=>validateWire('StartRequest',{...start,contractVersion:1})).toThrow('WIRE_VERSION_MISMATCH');
  expect(validateWire('Agent',{revision:'synthetic',promptRevision:'synthetic',modelCalls:0,toolCalls:0,variables:{conversationTopic:'',tone:'neutral',speechLevel:'casual'},steps:[],validator:'disabled'})).toHaveProperty('variables.speechLevel','casual');
});

it('accepts C4 summary, consent, memories and post-reply updates on wire v2',()=>{
  const session={id:'00000000-0000-4000-8000-000000000001',ownerId:'synthetic-owner',personId:'synthetic-person',personaId:'synthetic-persona',personaRevision:'synthetic-v1',language:'ko',timezone:'UTC',retrievalMode:'off',createdAt:'2026-10-10T00:00:00Z',userMemoryConsent:true};
  const turn={id:'00000000-0000-4000-8000-000000000003',sessionId:session.id,ownerId:session.ownerId,clientRequestId:'synthetic-request',userText:'나는 민트차를 좋아해',sequence:1,state:'generating',createdAt:session.createdAt};
  const context={turn,session,input:{sessionId:session.id,clientRequestId:turn.clientRequestId,text:turn.userText},history:[],refusedTurnIds:[],summary:{text:'사용자는 차 이야기를 했다.',lastMessageId:'00000000-0000-4000-8000-000000000004'},userMemories:[{id:'00000000-0000-4000-8000-000000000005',kind:'like',text:'민트차를 좋아해',forgotten:false}],userMemoryConsent:true};
  expect(validateWire('Context',context)).toEqual(context);
  expect(validateWire('Context',{...context,previousSessionUserSaid:'지난번에 파란 하늘을 좋아한다고 말했어'})).toBeDefined();
  expect(()=>validateWire('Context',{...context,previousSessionUserSaid:'abc'})).toThrow();
  const {summary: _summary,...withoutSummary}=context;
  expect(validateWire('Context',{...withoutSummary,userMemoryConsent:false})).toBeDefined();
  expect(()=>validateWire('Context',{...context,userMemories:[{...context.userMemories[0],text:'x'.repeat(121)}]})).toThrow();
  const reply={sessionId:session.id,turnId:turn.id,messageId:'00000000-0000-4000-8000-000000000006',personId:session.personId,personaRevision:session.personaRevision,responseKind:'small_talk',status:'answered',content:'그렇구나!',claims:[],evidence:[],limitations:[]};
  const result={kind:'completed',reply,summaryUpdate:{text:'사용자는 차를 좋아한다.',lastMessageId:reply.messageId},userMemoryOps:[{op:'add',kind:'like',text:'민트차를 좋아해'}]};
  expect(validateWire('Result',result)).toEqual(result);
  expect(validateWire('Result',{kind:'completed',reply})).toBeDefined();
});
