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

describe('FakeEngineUpstream',()=>{
  test('streams SSE ending in [DONE]; prefill time follows uncached tokens; a cached prefix skips it',async()=>{
    const e=await engine({prefillTokensPerSec:20000}); // 44500 B / 4.45 = 10000 tokens → 500 ms cold
    const cold=await call(e,msgs('a'));
    expect(cold.text).toContain('data: [DONE]');expect(cold.ttft).toBeGreaterThanOrEqual(450);
    const warm=await call(e,msgs('b')); // same system message: prefix hit
    expect(warm.ttft).toBeLessThan(150);
    expect(e.stats).toMatchObject({prefixHits:1,completed:2});
  });
  test('the prefix cache lives in the KV pool: resident prefixes beyond kvCapacityTokens evict the least recently used; token-level hit stats',async()=>{
    const e=await engine({kvCapacityTokens:3000}); // 8900 B = 2000 tokens per system block
    await call(e,msgs('a',8900));await call(e,msgs('b',8900)); // same block: hit
    expect(e.stats).toMatchObject({prefixHits:1,cachedTokens:2000});
    expect(e.stats.promptTokens).toBeCloseTo(2*(2000+1/4.45),3);
    await call(e,[{role:'system',content:'B'.repeat(8900)},{role:'user',content:'c'}]); // 2000 + 2000 > 3000: the P block goes
    await call(e,msgs('d',8900));
    expect(e.stats.prefixHits).toBe(1);
    const big=await engine({kvCapacityTokens:100000});
    await call(big,[{role:'system',content:'B'.repeat(8900)},{role:'user',content:'c'}]);await call(big,msgs('a',8900));await call(big,msgs('d',8900));
    expect(big.stats.prefixHits).toBe(1);
  });
  test('KV like vLLM: a cached prefix saves KV only while a running request holds it; a finished session\'s history is allocated again',async()=>{
    const e=await engine({slots:4,tpotMs:10,kvCapacityTokens:100000,prefillTokensPerSec:100000});
    const usage=()=>Number(/vllm:kv_cache_usage_perc\{[^}]*\} (\S+)/.exec(e.metricsText())![1]);
    const history=[{role:'system',content:'P'.repeat(8900)},{role:'user',content:'u1'},{role:'assistant',content:'a1'}];
    await call(e,[...history,{role:'user',content:'u2'}],5); // the history is now cached, nothing runs
    const alone=call(e,[...history,{role:'user',content:'u3'}],200);
    await new Promise(r=>setTimeout(r,100));
    expect(e.stats.cachedTokens).toBeGreaterThan(2000); // prefill skipped the cached history…
    expect(usage()*100000).toBeGreaterThan(2000+200); // …but its KV is allocated again (prompt + output)
    const shared=call(e,[...history,{role:'user',content:'u4'}],200); // same prefix as the running request: shared blocks
    await new Promise(r=>setTimeout(r,100));
    expect(usage()*100000).toBeLessThan(2*(2000+200)-1500);
    await Promise.all([alone,shared]);
  });
  test('shared blocks stay counted while any running request holds them, also when the request that first held them finishes first',async()=>{
    const e=await engine({slots:4,tpotMs:10,kvCapacityTokens:100000,prefillTokensPerSec:100000});
    const usage=()=>Number(/vllm:kv_cache_usage_perc\{[^}]*\} (\S+)/.exec(e.metricsText())![1])*100000;
    const history=[{role:'system',content:'P'.repeat(8900)},{role:'user',content:'u1'},{role:'assistant',content:'a1'}];
    const first=call(e,[...history,{role:'user',content:'u3'}],30); // ~300 ms of decode
    await new Promise(r=>setTimeout(r,50));
    const second=call(e,[...history,{role:'user',content:'u4'}],300); // shares the 2000-token history with the first
    await first;await new Promise(r=>setTimeout(r,50));
    expect(usage()).toBeGreaterThan(2000+300-1); // the second still holds the whole history + its output
    await second;
    expect(usage()).toBe(0);
  });
  test('the cache holds at most K − KV in use: a long running request evicts idle cached prefixes',async()=>{
    const e=await engine({slots:4,tpotMs:1,kvCapacityTokens:4000,prefillTokensPerSec:100000});
    await call(e,msgs('a',8900)); // P (2000 tokens) cached; P + Q = 4000 would fit an idle cache
    await call(e,[{role:'system',content:'Q'.repeat(8900)},{role:'user',content:'b'}],512); // 2000 + 512 in use → room for ~1488: P goes
    await call(e,msgs('c',8900));
    expect(e.stats.prefixHits).toBe(0);
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
