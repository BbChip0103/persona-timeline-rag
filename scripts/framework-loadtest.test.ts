import { comparison, histogramQuantile, isSyntheticModelReply, LOAD_GATE, workerEndpointPeak, type LoadSummary } from './framework-loadtest';
import { checkpointStorage } from './framework-smoke';
import type { Pool } from 'pg';
const sample=(extra:Partial<LoadSummary>={}):LoadSummary=>({turns:32,completed:32,errors:0,elapsedMs:1000,completedPerSecond:32,
  latencyMs:{p50:100,p95:200,p99:250},clientPeakConcurrency:8,workerPeakConcurrency:4,modelSubmissions:32,modelSuccesses:32,modelFailures:0,modelTimeouts:0,nonFallbackOutputs:32,modelOutputHashes:['a'.repeat(64)],providerTTFT:null,
  queueWaitUpperBoundSeconds:{p50:0.1,p95:0.25},checkpointRows:0,checkpointBytes:0,traceCount:null,observations:null,stageNames:[],stageLatencyMs:{},...extra});
test('numerical gates are immutable and compare full count/latency/throughput, not just passing requests',()=>{
  expect(Object.isFrozen(LOAD_GATE)).toBe(true);expect(comparison(sample(),sample()).passed).toBe(true);
  expect(LOAD_GATE).toEqual({warmupTurns:4,measuredTurns:32,clientConcurrency:8,workerConcurrency:4,expectedDelayMs:100,
    expectedPromptTokens:16,expectedCompletionTokens:12,p95RatioMax:1.75,p95SlackMs:250,throughputRatioMin:0.60,maxErrors:0});
  expect(comparison(sample(),sample({completed:31})).passed).toBe(false);
  expect(comparison(sample(),sample({errors:1})).passed).toBe(false);
  expect(comparison(sample(),sample({modelSubmissions:33})).passed).toBe(false);
  expect(comparison(sample(),sample({latencyMs:{p50:100,p95:601,p99:700}})).gates.p95).toBe(false);
  expect(comparison(sample(),sample({completedPerSecond:19})).gates.throughput).toBe(false);
});
test('exact successful submissions and nonfallback outputs are required, even with32 completed turns',()=>{
  for(const value of [{modelSuccesses:31},{modelFailures:1},{modelTimeouts:1},{nonFallbackOutputs:31},{modelSuccesses:undefined},{modelOutputHashes:['b'.repeat(64)]}])
    expect(comparison(sample(),sample(value)).passed).toBe(false);
  expect(isSyntheticModelReply({status:'answered',content:'Synthetic reply from the isolated local engine.',limitations:[]})).toBe(true);
  expect(isSyntheticModelReply({status:'answered',content:'합성 엔진에서 보내는 짧은 답변이에요.',limitations:[]})).toBe(true);
  for(const value of [{status:'insufficient_evidence',content:'Synthetic reply from the isolated local engine.',limitations:[]},{status:'answered',content:'Fallback reply',limitations:[]},{status:'answered',content:'Synthetic reply from the isolated local engine.',limitations:['GUARDRAILS_OUTPUT_UNAVAILABLE']}])
    expect(isSyntheticModelReply(value)).toBe(false);
});
test('authored off-RAG policy annotations are not model failures; unknown or fallback limitations still fail',()=>{
  const reply={status:'answered',content:'Synthetic reply from the isolated local engine.'};
  const ko=['RETRIEVAL_OFF','UNVERIFIED_MODEL_RESPONSE','검색 근거가 없는 모델 생성 응답이며 실제 활동 사실로 확인되지 않았습니다.','게시일은 실제 활동일과 다를 수 있습니다.'];
  const en=['RETRIEVAL_OFF','UNVERIFIED_MODEL_RESPONSE','Model-generated reply without retrieved evidence; not confirmed as an actual activity.','The posting date may differ from the actual activity date.'];
  expect(isSyntheticModelReply({...reply,limitations:ko})).toBe(true);
  expect(isSyntheticModelReply({...reply,limitations:en})).toBe(true);
  for(const extra of ['GUARDRAILS_INPUT_UNAVAILABLE','GUARDRAILS_OUTPUT_UNAVAILABLE','INVALID_MODEL_EVIDENCE','UNKNOWN_POLICY_LIMITATION',7,null])
    expect(isSyntheticModelReply({...reply,limitations:[...ko,extra]})).toBe(false);
});
test('before/after worker metrics are only a lower bound; idle endpoints cannot reveal the peak',()=>{
  const text=(n:number)=>`# TYPE ptr_turns_inflight gauge\nptr_turns_inflight ${n}\n`;
  expect(workerEndpointPeak(text(0),text(0))).toBeNull();
  expect(workerEndpointPeak(text(1),text(2))).toBe(2);
  expect(workerEndpointPeak('','')).toBeNull();
});
test('checkpoint measurement covers row bytes in all three tables, valid model threads and legacy stages only',async()=>{
  const query=jest.fn(async(_sql:string,_values?:unknown[])=>({rows:[{table_name:'checkpoints',rows:2,bytes:'100',model_rows:1,legacy_rows:1},{table_name:'checkpoint_blobs',rows:3,bytes:'200',model_rows:2,legacy_rows:1},{table_name:'checkpoint_writes',rows:4,bytes:'300',model_rows:3,legacy_rows:1}]}));
  const id='abcdef01-2345-4567-89ab-cdef01234567';const result=await checkpointStorage({query} as unknown as Pool,[id]);
  expect(result).toMatchObject({rows:9,bytes:600,modelRows:6,legacyStageRows:3,rowBytesOnly:true});
  expect(result.tables.checkpoint_blobs).toEqual({rows:3,bytes:200});
  const sql=query.mock.calls[0]?.[0];expect(sql).toContain('pg_column_size(c)');expect(sql).toContain('checkpoint_writes');expect(sql).toContain('checkpoint_blobs');expect(sql).toContain('[0-9a-f]{64}');expect(sql).toContain('split_part');expect(sql).not.toMatch(/\bLIKE\b/);
});
test('queue wait quantiles use DELTA cumulative buckets and report upper bounds',()=>{
  const text=(first:number,second:number,count:number)=>`# TYPE queue histogram\nqueue_bucket{le="0.1"} ${first}\nqueue_bucket{le="0.5"} ${second}\nqueue_bucket{le="+Inf"} ${count}\nqueue_count ${count}\nqueue_sum 1\n`;
  const before=text(10,12,12),after=text(11,14,15);
  expect(histogramQuantile(before,after,'queue',50)).toBe(0.5);
  expect(histogramQuantile(before,after,'queue',95)).toBeNull();
  expect(histogramQuantile(before,before,'queue',50)).toBeNull();
});
