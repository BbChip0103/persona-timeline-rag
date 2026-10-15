import {validateWire} from '../../../contracts/llm/v2/validate';
import {validateWire as validateV1} from '../../../contracts/llm/v1/validate';
const start={contractVersion:2,turnId:'00000000-0000-4000-8000-000000000001',dispatchSeq:0,jobId:'t-00000000-0000-4000-8000-000000000001-0',lockToken:'synthetic-token',executionId:'00000000-0000-4000-8000-000000000002'};
it('strictly accepts the shared synthetic Start contract',()=>expect(validateWire('StartRequest',start)).toEqual(start));
it.each([{...start,contractVersion:1},{...start,dispatchSeq:'0'},{...start,extra:true},{...start,dispatchSeq:Infinity},{...start,lockToken:''},{...start,turnId:'not-uuid'},{...start,dispatchSeq:9007199254740992}])('rejects incompatible or coerced wire payload',value=>expect(()=>validateWire('StartRequest',value)).toThrow());
it('rejects UTF8 overflow, not just codepoint overflow',()=>expect(()=>validateWire('StartRequest',{...start,lockToken:'한'.repeat(400)})).toThrow());
it('accepts a runtime-owned speech level in persisted agent variables',()=>{
  const agent={revision:'synthetic',promptRevision:'synthetic',modelCalls:1,toolCalls:0,
    variables:{conversationTopic:'',tone:'neutral',speechLevel:'casual'},steps:[],validator:'disabled'};
  expect(validateWire('Agent',agent)).toEqual(agent);
  expect(()=>validateWire('Agent',{...agent,variables:{...agent.variables,speechLevel:'invented'}})).toThrow();
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
