import { FakeTextProvider, FakeEmbeddingProvider, OpenRouterEmbeddingProvider, normalizeEmbeddingModel, OpenRouterClient, ProviderError, type BudgetLedger, type BudgetRequest } from '../src';

const signal=()=>new AbortController().signal;
const databaseUrl='postgresql://ptr_researcher:synthetic@127.0.0.1:56432/ptr_research';
class MemoryLedger implements BudgetLedger {
  readonly requests=new Map<string,BudgetRequest>();
  constructor(private readonly cap=1_000_000) {}
  async reserve(key:string,amount:number):Promise<{created:boolean;request:BudgetRequest}> {
    const previous=this.requests.get(key); if(previous) return {created:false,request:previous};
    const total=[...this.requests.values()].reduce((sum,row)=>sum+(row.state==='settled'?row.actualMicrousd??0:Math.max(row.reservedMicrousd,row.actualMicrousd??0)),0);
    if(total+amount>this.cap) throw new ProviderError('BUDGET_EXCEEDED');
    const request:BudgetRequest={key,state:'reserved',reservedMicrousd:amount,actualMicrousd:null,response:null,generationId:null};
    this.requests.set(key,request); return {created:true,request};
  }
  async submitted(key:string):Promise<void> { this.requests.get(key)!.state='submitted'; }
  async finish(key:string,actual:number|null,response:unknown|null,generationId:string|null):Promise<void> {
    const row=this.requests.get(key)!; if(row.state==='settled') return;
    Object.assign(row,{state:actual===null?'unknown':'settled',actualMicrousd:actual,response:response??row.response,generationId:generationId??row.generationId});
  }
  async get(key:string):Promise<BudgetRequest|undefined> { return this.requests.get(key); }
}
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const textCatalog=[{id:'google/gemini-3-flash-preview',pricing:{prompt:'0.0000005',completion:'0.000003',request:'0'}},
  {id:'google/gemini-2.5-flash-lite',pricing:{prompt:'0.0000001',completion:'0.0000004',request:'0'}}];
function fakeFetch(post:(body:Record<string,unknown>)=>Response|Promise<Response>=body=>reply({id:'gen-synthetic',model:body.model,choices:[{message:{content:'synthetic answer'}}],usage:{cost:0.000001}})) {
  return jest.fn(async (url: string|URL|Request,init?:RequestInit)=>{
    if(String(url).endsWith('/embeddings/models')) return reply({data:[{id:'openai/text-embedding-3-small',pricing:{prompt:'0.00000002',completion:'0',request:'0'}}]});
    if(String(url).endsWith('/models')) return reply({data:textCatalog});
    return post(JSON.parse(String(init?.body??'{}')));
  });
}
function client(fetcher:ReturnType<typeof fakeFetch>,ledger=new MemoryLedger(),extra:Partial<ConstructorParameters<typeof OpenRouterClient>[0]>={}) {
  return new OpenRouterClient({apiKey:'synthetic-private-key',liveEnabled:true,allowExternalData:true,databaseUrl,ledger,fetch:fetcher as typeof fetch,...extra});
}
const messages=[{role:'user' as const,content:'Synthetic hello'}];
const posts=(fetcher:ReturnType<typeof fakeFetch>)=>fetcher.mock.calls.filter(([,init])=>init?.method==='POST');

describe('disabled and deterministic adapters',()=>{
  test('no explicit live flags or key means disabled before any fetch',()=>{
    const fetcher=fakeFetch();
    expect(()=>client(fetcher,new MemoryLedger(),{liveEnabled:false})).toThrow('LIVE_DISABLED');
    expect(()=>client(fetcher,new MemoryLedger(),{allowExternalData:false})).toThrow('LIVE_DISABLED');
    expect(()=>client(fetcher,new MemoryLedger(),{apiKey:''})).toThrow('LIVE_DISABLED');
    expect(()=>client(fetcher,new MemoryLedger(),{databaseUrl:'postgresql://x:y@remote:5432/x'})).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  test('fake text is deterministic and structured quotes are offsetless',async()=>{
    const fake=new FakeTextProvider();
    expect(await fake.generate(messages,{signal:signal()})).toBe(await fake.generate(messages,{signal:signal()}));
    const result=JSON.parse(await fake.generate([{role:'system',content:'TIMELINE_JSON_REPLY'},{role:'user',content:'UNTRUSTED_EVIDENCE_JSON_DATA '+JSON.stringify([{sourceId:'synthetic',caption:'🌱 합성 원문'}])}],{signal:signal()}));
    expect(result.evidenceRefs).toEqual([{sourceId:'synthetic',quote:'🌱 합성 원문'}]);
    const embedding=new FakeEmbeddingProvider();
    const vectors=await embedding.embed(['synthetic'],{signal:signal()});
    expect(vectors[0]).toHaveLength(1536);
    expect(vectors).toEqual(await embedding.embed(['synthetic'],{signal:signal()}));
  });
});
describe('live adapter with fake network only',()=>{
  test('catalog verifies unauthenticated; POST enforces policies and cache avoids duplicate billing',async()=>{
    const ledger=new MemoryLedger(); const fetcher=fakeFetch(); const provider=client(fetcher,ledger);
    expect(await provider.generate(messages,{signal:signal()})).toBe('synthetic answer');
    expect(await provider.generate(messages,{signal:signal()})).toBe('synthetic answer');
    expect(posts(fetcher)).toHaveLength(1);
    expect(fetcher.mock.calls.slice(0,2).every(([,init])=>!init?.headers)).toBe(true);
    const body=JSON.parse(String(posts(fetcher)[0]![1]!.body));
    expect(body.model).toBe('google/gemini-3-flash-preview');
    expect(body.reasoning).toEqual({effort:'minimal'});
    expect(body.provider).toEqual({require_parameters:true,data_collection:'deny',zdr:true,allow_fallbacks:false,max_price:{prompt:0.5,completion:3,request:0}});
    expect(body.max_tokens).toBe(512);
    expect([...ledger.requests.values()][0]).toMatchObject({state:'settled',actualMicrousd:1});
    expect(JSON.stringify([...ledger.requests.values()])).not.toContain('synthetic-private-key');
  });
  test('aggregate cap rejects text and embedding before POST',async()=>{
    const ledger=new MemoryLedger(1); const fetcher=fakeFetch(); const provider=client(fetcher,ledger);
    await expect(provider.generate(messages,{signal:signal()})).rejects.toThrow('BUDGET_EXCEEDED');
    await expect(provider.embed(['synthetic'],{signal:signal()})).rejects.toThrow('BUDGET_EXCEEDED');
    expect(posts(fetcher)).toHaveLength(0);
  });
  test('ambiguous transport reserves cost and same request cannot resubmit after restart',async()=>{
    const ledger=new MemoryLedger();const fetcher=fakeFetch(()=>{throw new Error('synthetic-private-key must not leak');});
    await expect(client(fetcher,ledger).generate(messages,{signal:signal()})).rejects.toThrow('PROVIDER_TRANSPORT');
    const row=[...ledger.requests.values()][0]!; expect(row.state).toBe('unknown');expect(row.reservedMicrousd).toBeGreaterThan(0);
    await expect(client(fetcher,ledger).generate(messages,{signal:signal()})).rejects.toThrow('REQUEST_UNRESOLVED_NO_RESUBMIT');
    expect(posts(fetcher)).toHaveLength(1);
  });
  test('missing chat cost retains reservation yet cached response is usable',async()=>{
    const ledger=new MemoryLedger();const fetcher=fakeFetch(()=>reply({choices:[{message:{content:'synthetic'}}]}));const provider=client(fetcher,ledger);
    await provider.generate(messages,{signal:signal()}); await provider.generate(messages,{signal:signal()});
    expect([...ledger.requests.values()][0]!.state).toBe('unknown');expect(posts(fetcher)).toHaveLength(1);
  });
  test('API errors are sanitized and are not automatically retried',async()=>{
    const fetcher=fakeFetch(()=>reply({error:{message:'synthetic-private-key input secrets'}},429));
    await expect(client(fetcher).generate(messages,{signal:signal()})).rejects.toThrow('PROVIDER_HTTP_429');
    expect(posts(fetcher)).toHaveLength(1);
  });
  test('abort before call makes zero network requests; abort during request retains reservation',async()=>{
    const controller=new AbortController();controller.abort();const fetcher=fakeFetch();
    await expect(client(fetcher).generate(messages,{signal:controller.signal})).rejects.toThrow('CANCELLED');expect(fetcher).not.toHaveBeenCalled();
    const ledger=new MemoryLedger();const during=new AbortController();const interrupted=fakeFetch(()=>{during.abort();throw new Error('aborted');});
    await expect(client(interrupted,ledger).generate(messages,{signal:during.signal})).rejects.toThrow('CANCELLED');
    expect([...ledger.requests.values()][0]!.state).toBe('unknown');
  });
  test('concurrent duplicate has exactly one POST',async()=>{
    const ledger=new MemoryLedger();const fetcher=fakeFetch();const provider=client(fetcher,ledger);
    const results=await Promise.allSettled([provider.generate(messages,{signal:signal()}),provider.generate(messages,{signal:signal()})]);
    expect(results.filter(value=>value.status==='fulfilled')).toHaveLength(1);expect(posts(fetcher)).toHaveLength(1);
  });
  test('changed catalog price or new fee refuses POST',async()=>{
    for(const pricing of [{prompt:'0.000001',completion:'0.000003'},{prompt:'0.0000005',completion:'0.000003',unknown_fee:'0.1'}]) {
      const fetcher=fakeFetch();fetcher.mockImplementationOnce(async()=>reply({data:[{id:'google/gemini-3-flash-preview',pricing}]}));
      await expect(client(fetcher).generate(messages,{signal:signal()})).rejects.toThrow('PRICING_CHANGED_OR_UNKNOWN_FEE');expect(posts(fetcher)).toHaveLength(0);
    }
  });
  test('a failed catalog check is not cached forever',async()=>{
    const fetcher=fakeFetch();fetcher.mockImplementationOnce(async()=>reply({error:'synthetic outage'},503));const provider=client(fetcher);
    await expect(provider.generate(messages,{signal:signal()})).rejects.toThrow('PROVIDER_HTTP_503');expect(posts(fetcher)).toHaveLength(0);
    expect(await provider.generate(messages,{signal:signal()})).toBe('synthetic answer');
  });
  test('catalog optional events are disabled and unknown message features rejected',async()=>{
    const fetcher=fakeFetch();
    fetcher.mockImplementationOnce(async()=>reply({data:[{id:'google/gemini-3-flash-preview',pricing:{prompt:'0.0000005',completion:'0.000003',image:'0.0000005',audio:'0.000001',input_audio_cache:'0.0000001',web_search:'0.014',internal_reasoning:'0.000003',input_cache_read:'0.00000005',input_cache_write:'0.0000000833333333333333'}}]}));
    await client(fetcher).generate(messages,{signal:signal()});
    expect(JSON.parse(String(posts(fetcher)[0]![1]!.body)).reasoning).toEqual({effort:'minimal'});
    const invalid=fakeFetch();
    await expect(client(invalid).generate([{role:'user',content:'Synthetic',tools:[]} as never],{signal:signal()})).rejects.toThrow('INVALID_INPUT');
    expect(invalid).not.toHaveBeenCalled();
  });
  test('timeout and oversized responses stay unresolved without leaking bodies',async()=>{
    const ledger=new MemoryLedger();
    const fetcher=fakeFetch();
    const original=fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url,init)=>String(url).endsWith('/chat/completions')?new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('synthetic-private-key')),{once:true})):original(url,init));
    await expect(client(fetcher,ledger,{timeoutMs:5}).generate(messages,{signal:signal()})).rejects.toThrow('PROVIDER_TIMEOUT');
    expect([...ledger.requests.values()][0]!.state).toBe('unknown');
    const oversized=fakeFetch(()=>new Response('synthetic-private-key',{headers:{'content-length':String(3*1024*1024)}}));
    await expect(client(oversized).generate(messages,{signal:signal()})).rejects.toThrow('PROVIDER_RESPONSE_LIMIT');
  });
  test('explicit gemini-2.5-flash-lite keeps the previous baseline request policy',async()=>{
    const ledger=new MemoryLedger();const fetcher=fakeFetch();
    await client(fetcher,ledger,{textModel:'google/gemini-2.5-flash-lite'}).generate(messages,{signal:signal()});
    const body=JSON.parse(String(posts(fetcher)[0]![1]!.body));
    expect(body.model).toBe('google/gemini-2.5-flash-lite');expect(body.reasoning).toEqual({enabled:false});
    expect(body.provider.max_price).toEqual({prompt:0.1,completion:0.4,request:0});
    // Same input reserves ~5x more under the default model's higher prices.
    const defaultLedger=new MemoryLedger();await client(fakeFetch(),defaultLedger).generate(messages,{signal:signal()});
    expect([...defaultLedger.requests.values()][0]!.reservedMicrousd).toBeGreaterThan(4*[...ledger.requests.values()][0]!.reservedMicrousd);
  });
  test('explicit gemma-4-26b-a4b-it uses its catalog price ceiling, structured replies and disabled reasoning',async()=>{
    const fetcher=fakeFetch();
    fetcher.mockImplementationOnce(async()=>reply({data:[{id:'google/gemma-4-26b-a4b-it',pricing:{prompt:'0.00000009',completion:'0.0000003',input_cache_read:'0.00000005'}}]}));
    await client(fetcher,new MemoryLedger(),{textModel:'google/gemma-4-26b-a4b-it'}).generate([{role:'system',content:'TIMELINE_JSON_REPLY'},...messages],{signal:signal()});
    const body=JSON.parse(String(posts(fetcher)[0]![1]!.body));
    expect(body.model).toBe('google/gemma-4-26b-a4b-it');expect(body.reasoning).toEqual({enabled:false});expect(body.response_format).toEqual({type:'json_object'});
    expect(body.provider).toEqual({require_parameters:true,data_collection:'deny',zdr:true,allow_fallbacks:false,max_price:{prompt:0.09,completion:0.3,request:0}});
    // The free variant is never allowlisted.
    expect(()=>client(fakeFetch(),new MemoryLedger(),{textModel:'google/gemma-4-26b-a4b-it:free'})).toThrow('MODEL_NOT_ALLOWED');
    const raised=fakeFetch();raised.mockImplementationOnce(async()=>reply({data:[{id:'google/gemma-4-26b-a4b-it',pricing:{prompt:'0.00000015',completion:'0.0000006'}}]}));
    await expect(client(raised,new MemoryLedger(),{textModel:'google/gemma-4-26b-a4b-it'}).generate(messages,{signal:signal()})).rejects.toThrow('PRICING_CHANGED_OR_UNKNOWN_FEE');
  });
  test('gemma agent replies are schema-constrained when the catalog advertises structured outputs; others keep json_object',async()=>{
    const {AGENT_RESPONSE_JSON_SCHEMA}=await import('@ptr/core');
    const gemma=(supported?:string[])=>{const fetcher=fakeFetch();
      fetcher.mockImplementationOnce(async()=>reply({data:[{id:'google/gemma-4-26b-a4b-it',pricing:{prompt:'0.00000009',completion:'0.0000003'},...(supported?{supported_parameters:supported}:{})}]}));return fetcher;};
    const agent=[{role:'system' as const,content:'AGENT_JSON_REPLY (TIMELINE_JSON_REPLY transport)'},...messages];
    const sent=async(fetcher:ReturnType<typeof fakeFetch>,input=agent,textModel='google/gemma-4-26b-a4b-it')=>{
      await client(fetcher,new MemoryLedger(),{textModel}).generate(input,{signal:signal()});return JSON.parse(String(posts(fetcher)[0]![1]!.body));};
    const structured=await sent(gemma(['response_format','structured_outputs']));
    expect(structured.response_format).toEqual({type:'json_schema',json_schema:{name:'agent_reply',strict:true,schema:AGENT_RESPONSE_JSON_SCHEMA}});
    // Routes that cannot honour the schema are excluded rather than silently used.
    expect(structured.provider.require_parameters).toBe(true);
    expect((await sent(gemma(['response_format']))).response_format).toEqual({type:'json_object'});
    // The legacy timeline reply has no JSON schema: json_object stays.
    expect((await sent(gemma(['response_format','structured_outputs']),[{role:'system',content:'TIMELINE_JSON_REPLY'},...messages])).response_format).toEqual({type:'json_object'});
    // Models not opted in keep json_object even when the catalog advertises structured outputs.
    const flash=fakeFetch();flash.mockImplementationOnce(async()=>reply({data:[{...textCatalog[0],supported_parameters:['response_format','structured_outputs']}]}));
    expect((await sent(flash,agent,'google/gemini-3-flash-preview')).response_format).toEqual({type:'json_object'});
  });
  test('an idempotency key scopes the chat ledger entry; a smaller max output is honoured and capped; usage is reported',async()=>{
    const ledger=new MemoryLedger();const fetcher=fakeFetch(body=>reply({id:'gen-synthetic',model:body.model,choices:[{message:{content:'synthetic answer'}}],usage:{cost:0.000001,prompt_tokens:21,completion_tokens:4}}));
    const provider=client(fetcher,ledger);const usage:unknown[]=[];
    await provider.generate(messages,{signal:signal(),idempotencyKey:'turn-a',onUsage:value=>usage.push(value)});
    await provider.generate(messages,{signal:signal(),idempotencyKey:'turn-b'});
    await provider.generate(messages,{signal:signal(),idempotencyKey:'turn-a'}); // replay
    expect(posts(fetcher)).toHaveLength(2);expect(ledger.requests.size).toBe(2);
    expect(usage).toEqual([{promptTokens:21,completionTokens:4}]);
    await provider.generate([{role:'user',content:'Synthetic short'}],{signal:signal(),maxOutputTokens:100});
    await provider.generate([{role:'user',content:'Synthetic long'}],{signal:signal(),maxOutputTokens:4096});
    expect(posts(fetcher).slice(2).map(([,init])=>JSON.parse(String(init?.body)).max_tokens)).toEqual([100,512]);
  });
  test('input/output caps and unapproved models reject locally',async()=>{
    const fetcher=fakeFetch();expect(()=>client(fetcher,new MemoryLedger(),{maxOutputTokens:2048})).toThrow('INVALID_LIMIT');
    expect(()=>client(fetcher,new MemoryLedger(),{textModel:'unknown/model'})).toThrow('MODEL_NOT_ALLOWED');
    await expect(client(fetcher,new MemoryLedger(),{maxInputBytes:8}).generate(messages,{signal:signal()})).rejects.toThrow('INPUT_LIMIT');expect(fetcher).not.toHaveBeenCalled();
  });
  test('embedding indices are restored, complete vectors cache, no promised cost means reservation retained',async()=>{
    const ledger=new MemoryLedger();const fetcher=fakeFetch(()=>reply({id:'synthetic-embedding',model:'openai/text-embedding-3-small',data:[{index:1,embedding:Array(1536).fill(2)},{index:0,embedding:Array(1536).fill(1)}],usage:{prompt_tokens:2}}));
    const provider=client(fetcher,ledger);const vectors=await provider.embed(['synthetic-a','synthetic-b'],{signal:signal()});
    expect(vectors[0]![0]).toBe(1);expect(vectors[1]![0]).toBe(2);
    await provider.embed(['synthetic-a','synthetic-b'],{signal:signal()});expect(posts(fetcher)).toHaveLength(1);expect([...ledger.requests.values()][0]!.state).toBe('unknown');
  });
  test('exact vendorless embedding alias normalizes metadata and settles reported fractional cost',async()=>{
    const ledger=new MemoryLedger();const fetcher=fakeFetch(()=>reply({id:'synthetic-observed-alias',model:'text-embedding-3-small',data:[{index:0,embedding:Array(1536).fill(0.25)}],usage:{prompt_tokens:6,cost:1.2e-7}}));
    const provider=new OpenRouterEmbeddingProvider(client(fetcher,ledger));
    expect(provider.model).toBe('openai/text-embedding-3-small');
    expect(normalizeEmbeddingModel('text-embedding-3-small')).toBe(provider.model);
    expect((await provider.embed(['synthetic-alias-case'],{signal:signal()}))[0]![0]).toBe(0.25);
    const row=[...ledger.requests.values()][0]!;
    expect(row).toMatchObject({state:'settled',actualMicrousd:1});
    expect((row.response as {model:string}).model).toBe('text-embedding-3-small');
    await provider.embed(['synthetic-alias-case'],{signal:signal()});expect(posts(fetcher)).toHaveLength(1);
  });
  test('previously cached alias response reconciles valid cost without a second POST',async()=>{
    const ledger=new MemoryLedger();const fetcher=fakeFetch(()=>reply({id:'synthetic-cached-alias',model:'text-embedding-3-small',data:[{index:0,embedding:Array(1536).fill(1)}],usage:{cost:1.2e-7}}));
    await client(fetcher,ledger).embed(['synthetic-cached-case'],{signal:signal()});
    const row=[...ledger.requests.values()][0]!;
    row.state='unknown';row.actualMicrousd=null; // Simulate the old accounting behavior with its durable raw response.
    await client(fetcher,ledger).embed(['synthetic-cached-case'],{signal:signal()});
    expect(row).toMatchObject({state:'settled',actualMicrousd:1});expect(posts(fetcher)).toHaveLength(1);
  });
  test('embedding cost accepts explicit zero and retains reservation for missing or invalid values',async()=>{
    for(const cost of [undefined,null,'0',-1]) {
      const ledger=new MemoryLedger();const fetcher=fakeFetch(()=>reply({model:'text-embedding-3-small',data:[{index:0,embedding:Array(1536).fill(1)}],usage:{cost}}));
      await client(fetcher,ledger).embed(['synthetic-cost-case'],{signal:signal()});
      expect([...ledger.requests.values()][0]!).toMatchObject({state:'unknown',actualMicrousd:null});
    }
    const ledger=new MemoryLedger();const fetcher=fakeFetch(()=>reply({model:'openai/text-embedding-3-small',data:[{index:0,embedding:Array(1536).fill(1)}],usage:{cost:0}}));
    await client(fetcher,ledger).embed(['synthetic-zero-cost-case'],{signal:signal()});
    expect([...ledger.requests.values()][0]!).toMatchObject({state:'settled',actualMicrousd:0});
  });
  test('embedding aliases reject arbitrary vendors and suffixes',async()=>{
    for(const model of ['other/text-embedding-3-small','text-embedding-3-small:free','openai/text-embedding-3-small-v2','TEXT-EMBEDDING-3-SMALL']) {
      expect(normalizeEmbeddingModel(model)).toBeUndefined();
      const fetcher=fakeFetch(()=>reply({model,data:[{index:0,embedding:Array(1536).fill(1)}],usage:{cost:0}}));
      await expect(client(fetcher).embed(['synthetic-rejected-alias'],{signal:signal()})).rejects.toThrow('INVALID_EMBEDDINGS');
    }
  });
  test('malformed embeddings reject duplicate indices/dimensions/nonfinite/count',async()=>{
    for(const data of [[{index:0,embedding:[1]}],[],[{index:0,embedding:Array(1536).fill(null)}],[{index:2,embedding:Array(1536).fill(1)}]]) {
      const fetcher=fakeFetch(()=>reply({model:'openai/text-embedding-3-small',data}));
      await expect(client(fetcher).embed(['synthetic'],{signal:signal()})).rejects.toThrow('INVALID_EMBEDDINGS');
    }
  });
});

test('offsetless fake reply produces canonical UTF16 refs through the same core validator',async()=>{
  const {validateSourceBoundReply}=await import('@ptr/core');
  const source={id:'synthetic-offsetless-source',personId:'synthetic-person',caption:'🌱 합성 원문',postedAt:'2026-01-01T00:00:00Z',eventDate:null,sourceUrl:'https://example.com/synthetic',hash:'synthetic-hash',snapshot:'synthetic-v1',unsafe:false};
  const fake=new FakeTextProvider();
  const raw=await fake.generate([{role:'system',content:'TIMELINE_JSON_REPLY'},{role:'user',content:'UNTRUSTED_EVIDENCE_JSON_DATA '+JSON.stringify([{sourceId:source.id,caption:source.caption}])}],{signal:signal()});
  expect(JSON.parse(raw).evidenceRefs[0]).not.toHaveProperty('start');expect(JSON.parse(raw).evidenceRefs[0]).not.toHaveProperty('end');
  const result=validateSourceBoundReply(raw,[source],source.personId);
  expect(result.status).toBe('answered');expect(result.claims[0].evidenceRefs).toEqual([{sourceId:source.id,quote:source.caption,start:0,end:source.caption.length}]);
});
