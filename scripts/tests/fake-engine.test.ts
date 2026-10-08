import { FakeEngine } from '../fake-engine';

const engines:FakeEngine[]=[];
afterEach(async()=>{await Promise.all(engines.splice(0).map(engine=>engine.stop()));});
async function engine(config:Partial<ConstructorParameters<typeof FakeEngine>[0]>={}) {
  const e=new FakeEngine({name:'e',slots:2,prefillTokensPerSec:10000,tpotMs:1,kvCapacityTokens:100000,...config});await e.start();engines.push(e);return e;
}
async function call(e:FakeEngine,messages:{role:string;content:string}[],output=20) {
  const started=Date.now();let ttft=0;
  const response=await fetch(`${e.baseUrl}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages,ptr_fake_output_tokens:output})});
  const reader=response.body!.getReader();let text='';
  for(;;) {const {done,value}=await reader.read();if(done) break;if(!ttft) ttft=Date.now()-started;text+=new TextDecoder().decode(value);}
  return {ttft,total:Date.now()-started,text};
}
const msgs=(user:string,policyBytes=44500)=>[{role:'system',content:'P'.repeat(policyBytes)},{role:'user',content:user}];

describe('FakeEngineUpstream (§9.1)',()=>{
  test('streams SSE ending in [DONE]; prefill time follows uncached tokens; a cached prefix skips it',async()=>{
    const e=await engine({prefillTokensPerSec:20000}); // 44500 B / 4.45 = 10000 tokens → 500 ms cold
    const cold=await call(e,msgs('a'));
    expect(cold.text).toContain('data: [DONE]');expect(cold.ttft).toBeGreaterThanOrEqual(450);
    const warm=await call(e,msgs('b')); // same system message: prefix hit
    expect(warm.ttft).toBeLessThan(150);
    expect(e.stats).toMatchObject({prefixHits:1,completed:2});
  });
  test('more requests than slots wait inside the engine; /metrics and /health use vLLM names',async()=>{
    const e=await engine({slots:1,tpotMs:20});
    const calls=[call(e,msgs('a',100),20),call(e,msgs('b',100),20)];
    await new Promise(r=>setTimeout(r,100));
    const metrics=await (await fetch(`http://127.0.0.1:${e.port}/metrics`)).text();
    expect(metrics).toMatch(/vllm:num_requests_running\{[^}]*\} 1/);expect(metrics).toMatch(/vllm:num_requests_waiting\{[^}]*\} 1/);
    expect(metrics).toMatch(/vllm:kv_cache_usage_perc/);expect(metrics).toMatch(/process_start_time_seconds/);
    expect((await fetch(`http://127.0.0.1:${e.port}/health`)).status).toBe(200);
    await Promise.all(calls);
  });
  test('KV capacity: a request that does not fit beside the running one waits for it',async()=>{
    const e=await engine({slots:4,tpotMs:10,kvCapacityTokens:300}); // each ~22 + 200 output tokens
    const a=call(e,msgs('a',100),200),b=call(e,msgs('b',100),200);
    await new Promise(r=>setTimeout(r,100));
    expect(e.metricsText()).toMatch(/num_requests_waiting\{[^}]*\} 1/);
    const [first,second]=await Promise.all([a,b]);
    expect(second.total).toBeGreaterThan(first.total);
  });
  test('telemetry controls for acceptance runs: forced KV/waiting reports, an unanswered /metrics, a restart with a new start time',async()=>{
    const e=await engine({kvCapacityTokens:1000});
    const read=async()=>(await fetch(`http://127.0.0.1:${e.port}/metrics`,{signal:AbortSignal.timeout(300)})).text();
    const info=/vllm:cache_config_info\{([^}]*)\}/.exec(await read())![1]!; // 1000 tokens / 16 = 62 blocks
    expect(info).toContain('num_gpu_blocks="62"');expect(info).toContain('block_size="16"');
    e.report({kvUsage:0.97,waiting:5});
    expect(await read()).toMatch(/vllm:kv_cache_usage_perc\{[^}]*\} 0\.97/);expect(await read()).toMatch(/vllm:num_requests_waiting\{[^}]*\} 5/);
    e.report({});expect(await read()).toMatch(/vllm:kv_cache_usage_perc\{[^}]*\} 0\n/);
    const before=/process_start_time_seconds (\S+)/.exec(await read())![1];
    e.hangMetrics(true);await expect(read()).rejects.toThrow();e.hangMetrics(false);
    await new Promise(r=>setTimeout(r,20));
    await e.restart();
    // A pooled keep-alive connection may still point at the old process: one failed read is what a poller sees too.
    const after=await read().catch(()=>read());
    expect(/process_start_time_seconds (\S+)/.exec(after)![1]).not.toBe(before);
    expect((await call(e,msgs('after restart',100),5)).text).toContain('[DONE]');
  });
});
