import { gpuUsdPerRequest, openRouterBody, scrapeVllm, selectStratified } from './bench-jev-gemma';

describe('jev/gemma bench helpers',()=>{
  const items=Array.from({length:60},(_,i)=>({id:`c${i}`,language:i%2?'en':'ko',bytes:1000+i*100}));
  it('selects a fixed-size sample balanced over language and size tertiles',()=>{
    const picked=selectStratified(items,48);
    expect(picked).toHaveLength(48);
    expect(new Set(picked.map(item=>item.id)).size).toBe(48);
    expect(picked.filter(item=>item.language==='ko')).toHaveLength(24);
    const sorted=[...items].sort((a,b)=>a.bytes-b.bytes);const tier=(id:string)=>Math.min(2,Math.floor(3*sorted.findIndex(item=>item.id===id)/sorted.length));
    expect([0,1,2].map(t=>picked.filter(item=>tier(item.id)===t).length)).toEqual([16,16,16]);
  });
  it('tops up from the remaining items when a cell is short and never exceeds the pool',()=>{
    const skewed=[...items.slice(0,40).map(item=>({...item,language:'ko'})),...items.slice(40)];
    expect(selectStratified(skewed,48)).toHaveLength(48);
    expect(selectStratified(items.slice(0,10),48)).toHaveLength(10);
  });
  it('prices an always-on GPU by measured throughput and utilisation',()=>{
    expect(gpuUsdPerRequest(0.78,1)).toBeCloseTo(0.78/3600);
    expect(gpuUsdPerRequest(0.78,2,0.5)).toBeCloseTo(0.78/3600);
    expect(gpuUsdPerRequest(0.78,0)).toBeNaN();
  });
  it('streams only in the bench variant of the app body',()=>{
    const messages=[{role:'system' as const,content:'AGENT_JSON_REPLY'},{role:'user' as const,content:'hi'}];
    expect(openRouterBody(messages,false)).not.toHaveProperty('stream_options');
    expect(openRouterBody(messages,true)).toMatchObject({stream:true,stream_options:{include_usage:true},response_format:{type:'json_schema'}});
  });
});

describe('vLLM metrics scrape',()=>{
  it('sums tracked series across label sets and ignores others',()=>{
    const text=['# HELP x','vllm:kv_cache_usage_perc{engine="0",model_name="m"} 0.25','vllm:num_requests_running{engine="0"} 3',
      'vllm:num_requests_waiting{engine="0"} 0','vllm:num_preemptions_total{engine="0"} 4.0','vllm:generation_tokens_total{engine="0"} 9'].join('\n');
    expect(scrapeVllm(text)).toEqual({kv_cache_usage_perc:0.25,num_requests_running:3,num_requests_waiting:0,num_preemptions_total:4});
  });
});
