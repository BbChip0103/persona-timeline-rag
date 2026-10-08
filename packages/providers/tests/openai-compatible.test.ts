import { OpenAICompatibleTextProvider, ProviderError, type CallMetrics } from '../src';

const signal=()=>new AbortController().signal;
const messages=[{role:'system' as const,content:'Synthetic system'},{role:'user' as const,content:'Synthetic hello'}];
function sse(chunks:unknown[],status=200):Response {
  const body=chunks.map(chunk=>`data: ${typeof chunk==='string'?chunk:JSON.stringify(chunk)}\n\n`).join('');
  return new Response(body,{status,headers:{'Content-Type':'text/event-stream'}});
}
const delta=(content:string)=>({choices:[{delta:{content}}]});
function provider(fetcher:jest.Mock,extra:Record<string,unknown>={}) {
  return new OpenAICompatibleTextProvider({baseUrl:'http://127.0.0.1:18000/v1',model:'gemma-4-e4b',fetch:fetcher as typeof fetch,...extra});
}

test('streams, concatenates deltas and reports TTFT/total/usage metrics',async()=>{
  const metrics:CallMetrics[]=[];
  const fetcher=jest.fn(async()=>sse([delta('반'),delta('가워요.'),{choices:[],usage:{prompt_tokens:12,completion_tokens:3}},'[DONE]']));
  const result=await provider(fetcher,{onMetrics:(m:CallMetrics)=>metrics.push(m)}).generate(messages,{signal:signal()});
  expect(result).toBe('반가워요.');
  expect(metrics).toHaveLength(1);
  expect(metrics[0]).toMatchObject({model:'gemma-4-e4b',promptTokens:12,completionTokens:3,ok:true});
  expect(metrics[0]!.ttftMs).toBeGreaterThanOrEqual(0);expect(metrics[0]!.totalMs).toBeGreaterThanOrEqual(metrics[0]!.ttftMs!);
  const body=JSON.parse(String((fetcher.mock.calls[0] as unknown[])[1] && ((fetcher.mock.calls[0] as unknown[])[1] as RequestInit).body));
  expect(body).toMatchObject({model:'gemma-4-e4b',stream:true,temperature:0,stream_options:{include_usage:true},chat_template_kwargs:{enable_thinking:false}});
  expect(body.messages).toEqual(messages);
});
test('JSON reply contracts request json_object like the live adapter',async()=>{
  const fetcher=jest.fn(async()=>sse([delta('{"status":"answered"}'),'[DONE]']));
  await provider(fetcher).generate([{role:'system',content:'AGENT_JSON_REPLY'},{role:'user',content:'x'}],{signal:signal()});
  const body=JSON.parse(((fetcher.mock.calls[0] as unknown[])[1] as RequestInit).body as string);
  expect(body.response_format).toEqual({type:'json_object'});
});
test('only loopback endpoints are accepted (self-hosted engines are reached through an SSH tunnel)',()=>{
  for(const baseUrl of ['https://api.example.com/v1','http://10.0.0.5:8000/v1','http://localhost:8000/v1','ftp://127.0.0.1/v1'])
    expect(()=>new OpenAICompatibleTextProvider({baseUrl,model:'m'})).toThrow();
});
test('HTTP errors, empty output and aborts are typed and sanitized; metrics record the failure',async()=>{
  const metrics:CallMetrics[]=[];
  const busy=jest.fn(async()=>new Response('{"error":"secret detail"}',{status:503}));
  await expect(provider(busy,{onMetrics:(m:CallMetrics)=>metrics.push(m)}).generate(messages,{signal:signal()})).rejects.toEqual(new ProviderError('PROVIDER_HTTP_503'));
  expect(metrics[0]).toMatchObject({ok:false,error:'PROVIDER_HTTP_503'});
  const empty=jest.fn(async()=>sse(['[DONE]']));
  await expect(provider(empty).generate(messages,{signal:signal()})).rejects.toEqual(new ProviderError('INVALID_PROVIDER_RESPONSE'));
  const controller=new AbortController();controller.abort();
  const never=jest.fn();
  await expect(provider(never).generate(messages,{signal:controller.signal})).rejects.toEqual(new ProviderError('CANCELLED'));
  expect(never).not.toHaveBeenCalled();
});
test('structured agent replies send the agent JSON Schema for guided decoding (agent prompts only)',async()=>{
  const fetcher=jest.fn(async()=>sse([delta('{"message":"x","status":"answered","evidenceRefs":[],"variableUpdates":{}}'),'[DONE]']));
  const structured=provider(fetcher,{structuredAgentReplies:true});
  await structured.generate([{role:'system',content:'AGENT_JSON_REPLY'},{role:'user',content:'x'}],{signal:signal()});
  const body=JSON.parse(((fetcher.mock.calls[0] as unknown[])[1] as RequestInit).body as string);
  expect(body.response_format.type).toBe('json_schema');
  expect(body.response_format.json_schema.name).toBe('agent_reply');
  expect(body.response_format.json_schema.schema.required).toContain('evidenceRefs');
  await structured.generate(messages,{signal:signal()});
  const plain=JSON.parse(((fetcher.mock.calls[1] as unknown[])[1] as RequestInit).body as string);
  expect(plain.response_format).toBeUndefined();
});
test('a per-turn request key travels as X-PTR-Request-Key (gateway ledger scoping); malformed keys are not sent',async()=>{
  const fetcher=jest.fn(async()=>sse([delta('ok'),'[DONE]']));
  const headers=(index:number)=>((fetcher.mock.calls[index] as unknown[])[1] as RequestInit).headers as Record<string,string>;
  await provider(fetcher).generate(messages,{signal:signal(),requestKey:'turn_0b7c-1'});
  await provider(fetcher).generate(messages,{signal:signal()});
  await provider(fetcher).generate(messages,{signal:signal(),requestKey:'bad key\nx'});
  expect(headers(0)['X-PTR-Request-Key']).toBe('turn_0b7c-1');
  expect(headers(1)['X-PTR-Request-Key']).toBeUndefined();expect(headers(2)['X-PTR-Request-Key']).toBeUndefined();
});
