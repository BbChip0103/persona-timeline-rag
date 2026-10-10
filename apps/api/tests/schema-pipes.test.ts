import { z } from 'zod';
import { ZodSchemaPipe, WireSchemaPipe } from '../src/schema-pipes';

test('schema pipes use existing Zod transforms/strictness and the shared wire schema',()=>{
  const schema=z.object({label:z.string().trim().min(1),limit:z.number().int().default(5)}).strict();
  expect(new ZodSchemaPipe(schema).transform({label:' synthetic '})).toEqual({label:'synthetic',limit:5});
  expect(()=>new ZodSchemaPipe(schema).transform({label:'synthetic',extra:true})).toThrow();
  const value={contractVersion:1,turnId:'12345678-1234-4234-9234-123456789abc',dispatchSeq:0};
  expect(new WireSchemaPipe('Dispatch').transform(value)).toBe(value);
  for(const invalid of [{...value,dispatchSeq:'0'},{...value,extra:true},{...value,dispatchSeq:Infinity}])
    expect(()=>new WireSchemaPipe('Dispatch').transform(invalid)).toThrow();
});
