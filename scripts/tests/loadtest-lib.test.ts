import { PersonaSchema, SourcePostSchema } from '@ptr/contracts';
import { percentile, summarizeStage, syntheticCorpus, LOADTEST_QUESTIONS, type TurnSample } from '../loadtest-lib';

test('percentile uses nearest-rank and handles empty input',()=>{
  expect(percentile([],50)).toBeNull();
  expect(percentile([5],95)).toBe(5);
  const values=Array.from({length:100},(_,i)=>i+1);
  expect(percentile(values,50)).toBe(50);expect(percentile(values,95)).toBe(95);expect(percentile(values,99)).toBe(99);
  expect(percentile([3,1,2],100)).toBe(3);
});
test('stage summary separates completed, failed and stuck turns and reports throughput over the window',()=>{
  const ok=(e2e:number):TurnSample=>({outcome:'completed',acceptMs:10,e2eMs:e2e,errorCode:null});
  const samples:TurnSample[]=[ok(100),ok(200),ok(300),{outcome:'failed',acceptMs:12,e2eMs:900,errorCode:'TURN_FAILED'},
    {outcome:'rejected',acceptMs:5,e2eMs:null,errorCode:'HTTP_409'},{outcome:'stuck',acceptMs:11,e2eMs:null,errorCode:null}];
  const summary=summarizeStage(samples,10_000);
  expect(summary.turns).toEqual({attempted:6,completed:3,failed:1,rejected:1,stuck:1});
  expect(summary.completedPerSecond).toBeCloseTo(0.3);
  expect(summary.e2eMs).toEqual({p50:200,p95:300,p99:300,max:300});
  expect(summary.errors).toEqual({TURN_FAILED:1,HTTP_409:1});
});
test('synthetic corpus is deterministic, schema-valid and never claims real people',()=>{
  const a=syntheticCorpus(3,5), b=syntheticCorpus(3,5);
  expect(a).toEqual(b);
  expect(a.personas).toHaveLength(3);expect(a.posts).toHaveLength(15);
  for(const persona of a.personas){PersonaSchema.parse(persona);expect(persona.reviewStatus).toBe('synthetic');expect(persona.id).toMatch(/^loadtest-/);}
  for(const post of a.posts){SourcePostSchema.parse(post);expect(post.sourceUrl).toMatch(/^https:\/\/example\.com\//);}
  expect(new Set(a.posts.map(post=>post.id)).size).toBe(15);
  expect(LOADTEST_QUESTIONS.length).toBeGreaterThanOrEqual(6);
});
