import { parseEngineMetrics } from '../src/engine-metrics';

const text=(values:{running?:number;waiting?:number;kv?:number;start?:number;queries?:number;hits?:number})=>[
  '# HELP vllm:num_requests_running Number of requests in model execution batches.','# TYPE vllm:num_requests_running gauge',
  ...(values.running!==undefined?[`vllm:num_requests_running{engine="0",model_name="m"} ${values.running}`]:[]),
  ...(values.waiting!==undefined?[`vllm:num_requests_waiting{engine="0",model_name="m"} ${values.waiting}`]:[]),
  ...(values.kv!==undefined?[`vllm:kv_cache_usage_perc{engine="0",model_name="m"} ${values.kv}`]:[]),
  ...(values.queries!==undefined?[`vllm:prefix_cache_queries_total{engine="0",model_name="m"} ${values.queries}`]:[]),
  ...(values.hits!==undefined?[`vllm:prefix_cache_hits_total{engine="0",model_name="m"} ${values.hits}`]:[]),
  ...(values.start!==undefined?[`process_start_time_seconds ${values.start}`]:[]),
].join('\n')+'\n';

describe('vLLM /metrics parsing',()=>{
  test('vLLM v1 names: running/waiting summed over label sets (engine cores), KV usage = the highest, prefix counters, process start',()=>{
    const parsed=parseEngineMetrics(text({running:3,waiting:1,kv:0.42,queries:1000,hits:600,start:1759990000.5})
      +'vllm:num_requests_waiting{engine="1",model_name="m"} 2\nvllm:kv_cache_usage_perc{engine="1",model_name="m"} 0.9\n');
    expect(parsed).toEqual({running:3,waiting:3,kvUsage:0.9,prefixQueries:1000,prefixHits:600,startTimeSeconds:1759990000.5});
  });
  test('older names are accepted (gpu_cache_usage_perc, counters without _total, gpu_prefix_cache_*); missing ones are null',()=>{
    expect(parseEngineMetrics('vllm:gpu_cache_usage_perc{model_name="m"} 0.5\nvllm:prefix_cache_queries{model_name="m"} 10\nvllm:gpu_prefix_cache_hits_total{model_name="m"} 4\n'))
      .toEqual({running:null,waiting:null,kvUsage:0.5,prefixQueries:10,prefixHits:4,startTimeSeconds:null});
    expect(parseEngineMetrics('garbage\nvllm:num_requests_waiting NaN\n')).toEqual({running:null,waiting:null,kvUsage:null,prefixQueries:null,prefixHits:null,startTimeSeconds:null});
  });
  test('Prometheus/OpenMetrics edge cases: comments, NaN and ±Inf ignored, exemplars and timestamps, "}" and escaped quotes in label values',()=>{
    const parsed=parseEngineMetrics([
      '# HELP vllm:num_requests_waiting Number of requests waiting {to be} processed.','# TYPE vllm:num_requests_waiting gauge',
      'vllm:num_requests_waiting{model_name="a}b",path="x\\"y}"} 3 1700000000000',
      'vllm:num_requests_running{model_name="m"} 2 # {trace_id="abc"} 1.0',
      'vllm:kv_cache_usage_perc{model_name="m"} +Inf','vllm:kv_cache_usage_perc{model_name="n"} NaN','vllm:kv_cache_usage_perc{model_name="o"} 0.4',
      'process_start_time_seconds -Inf','  ','vllm:prefix_cache_hits_total{a="}"}',
    ].join('\n'));
    expect(parsed).toEqual({running:2,waiting:3,kvUsage:0.4,prefixQueries:null,prefixHits:null,startTimeSeconds:null});
  });
});
