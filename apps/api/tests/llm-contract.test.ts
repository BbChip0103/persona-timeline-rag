import {validateWire} from '../../../contracts/llm/v1/validate';
const start={contractVersion:1,turnId:'00000000-0000-4000-8000-000000000001',dispatchSeq:0,jobId:'t-00000000-0000-4000-8000-000000000001-0',lockToken:'synthetic-token',executionId:'00000000-0000-4000-8000-000000000002'};
it('strictly accepts the shared synthetic Start contract',()=>expect(validateWire('StartRequest',start)).toEqual(start));
it.each([{...start,contractVersion:2},{...start,dispatchSeq:'0'},{...start,extra:true},{...start,dispatchSeq:Infinity},{...start,lockToken:''},{...start,turnId:'not-uuid'},{...start,dispatchSeq:9007199254740992}])('rejects incompatible or coerced wire payload',value=>expect(()=>validateWire('StartRequest',value)).toThrow());
it('rejects UTF8 overflow, not just codepoint overflow',()=>expect(()=>validateWire('StartRequest',{...start,lockToken:'한'.repeat(400)})).toThrow());
import corpus from '../../../contracts/llm/v1/corpus.json';
it.each(corpus)('shared crosslanguage corpus: $name',entry=>{if(entry.valid)expect(()=>validateWire(entry.schema,entry.value)).not.toThrow();else expect(()=>validateWire(entry.schema,entry.value)).toThrow();});
