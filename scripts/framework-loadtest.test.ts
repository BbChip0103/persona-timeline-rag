import { comparison, histogramQuantile, LOAD_GATE, type LoadSummary } from './framework-loadtest';
const sample=(extra:Partial<LoadSummary>={}):LoadSummary=>({turns:32,completed:32,errors:0,elapsedMs:1000,completedPerSecond:32,
  latencyMs:{p50:100,p95:200,p99:250},clientPeakConcurrency:8,workerPeakConcurrency:4,modelSubmissions:32,providerTTFT:null,
  queueWaitUpperBoundSeconds:{p50:0.1,p95:0.25},checkpointRows:0,checkpointBytes:0,traceCount:null,observations:null,stageNames:[],stageLatencyMs:{},...extra});
test('numerical gates are immutable and compare full count/latency/throughput, not just passing requests',()=>{
  expect(Object.isFrozen(LOAD_GATE)).toBe(true);expect(comparison(sample(),sample()).passed).toBe(true);
  expect(comparison(sample(),sample({completed:31})).passed).toBe(false);
  expect(comparison(sample(),sample({errors:1})).passed).toBe(false);
  expect(comparison(sample(),sample({modelSubmissions:33})).passed).toBe(false);
  expect(comparison(sample(),sample({latencyMs:{p50:100,p95:601,p99:700}})).gates.p95).toBe(false);
  expect(comparison(sample(),sample({completedPerSecond:19})).gates.throughput).toBe(false);
});
test('queue wait quantiles use DELTA cumulative buckets and report upper bounds',()=>{
  const text=(first:number,second:number,count:number)=>`# TYPE queue histogram\nqueue_bucket{le="0.1"} ${first}\nqueue_bucket{le="0.5"} ${second}\nqueue_bucket{le="+Inf"} ${count}\nqueue_count ${count}\nqueue_sum 1\n`;
  const before=text(10,12,12),after=text(11,14,15);
  expect(histogramQuantile(before,after,'queue',50)).toBe(0.5);
  expect(histogramQuantile(before,after,'queue',95)).toBeNull();
  expect(histogramQuantile(before,before,'queue',50)).toBeNull();
});
