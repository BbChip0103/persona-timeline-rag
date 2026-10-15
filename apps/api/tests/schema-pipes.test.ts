import { z } from 'zod';
import { ZodSchemaPipe, WireSchemaPipe } from '../src/schema-pipes';
import {validateWire} from '../../../contracts/llm/v2/validate';

test('schema pipes use existing Zod transforms/strictness and the shared wire schema',()=>{
  const schema=z.object({label:z.string().trim().min(1),limit:z.number().int().default(5)}).strict();
  expect(new ZodSchemaPipe(schema).transform({label:' synthetic '})).toEqual({label:'synthetic',limit:5});
  expect(()=>new ZodSchemaPipe(schema).transform({label:'synthetic',extra:true})).toThrow();
  const value={contractVersion:2,turnId:'12345678-1234-4234-9234-123456789abc',dispatchSeq:0};
  expect(new WireSchemaPipe('Dispatch').transform(value)).toBe(value);
  for(const invalid of [{...value,dispatchSeq:'0'},{...value,extra:true},{...value,dispatchSeq:Infinity}])
    expect(()=>new WireSchemaPipe('Dispatch').transform(invalid)).toThrow();
});
test('catalogue wire accepts bounded character card copy and rejects oversize copy',()=>{
  const persona={id:'synthetic-persona',personId:'synthetic-person',label:'Synthetic Character',language:'ko',revision:'synthetic-v1',reviewStatus:'synthetic',greeting:'안녕!',tagline:'오늘은 어떤 이야기를 해 볼까?',starters:['오늘 어땠어?','무슨 색 좋아해?']};
  const response={contractVersion:2,personas:[persona]};
  expect(validateWire('CatalogueResponse',response)).toBe(response);
  for(const changed of [{tagline:'가'.repeat(61)},{starters:Array(5).fill('안녕')},{starters:['가'.repeat(61)]}])
    expect(()=>validateWire('CatalogueResponse',{contractVersion:2,personas:[{...persona,...changed}]})).toThrow();
});
