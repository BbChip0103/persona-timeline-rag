import { randomUUID } from 'node:crypto';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Annotation, END, START, StateGraph, MemorySaver, getConfig } from '@langchain/langgraph';
import { CheckpointedTextProvider } from '../src/checkpointed-provider';
import { PROVIDER_DEADLINE, type TextProvider } from '../src/ports';
const messages=[{role:'user' as const,content:'synthetic private prompt marker'}];
const identity='synthetic:model-v1:output-v1';
const requestKey=randomUUID();
const signal=()=>new AbortController().signal;
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));

test('completed costly responses replay callbacks once per invocation, without persisting prompts',async()=>{
  const saver=new MemorySaver();
  const provider:TextProvider={generate:jest.fn(async(_messages,options)=>{options.onServed?.('primary');options.onUsage?.({promptTokens:12,completionTokens:7});return 'synthetic response';})};
  const wrapped=new CheckpointedTextProvider(provider,{checkpointer:saver,identity});
  const onServed=jest.fn(),onUsage=jest.fn();
  for(let attempt=0;attempt<2;attempt++)expect(await wrapped.generate(messages,{signal:signal(),requestKey,onServed,onUsage})).toBe('synthetic response');
  expect(provider.generate).toHaveBeenCalledTimes(1);expect(onServed.mock.calls).toEqual([['primary'],['primary']]);
  expect(onUsage.mock.calls).toEqual([[{promptTokens:12,completionTokens:7}],[{promptTokens:12,completionTokens:7}]]);
  const rows=[];for await(const row of saver.list({}))rows.push(row);
  expect(rows.length).toBeGreaterThan(0);
  expect(rows.every(row=>new RegExp(`^model:${requestKey}:[0-9a-f]{64}$`).test(row.config.configurable!.thread_id))).toBe(true);
  expect(rows.every(row=>row.config.configurable!.checkpoint_ns==='')).toBe(true);
  expect(JSON.stringify(rows)).not.toContain(messages[0].content);
  expect(JSON.stringify(rows)).not.toContain(identity);
});

test('distinct contents and trusted model identity never reuse the wrong costly response',async()=>{
  const saver=new MemorySaver(),provider={generate:jest.fn(async()=> 'response')};
  const wrapped=new CheckpointedTextProvider(provider,{checkpointer:saver,identity});
  await wrapped.generate(messages,{signal:signal(),requestKey});
  await wrapped.generate([{role:'user',content:'different'}],{signal:signal(),requestKey});
  await new CheckpointedTextProvider(provider,{checkpointer:saver,identity:'another-model'}).generate(messages,{signal:signal(),requestKey});
  expect(provider.generate).toHaveBeenCalledTimes(3);
});

test('successful task receipt survives interruption of its enclosing model node',async()=>{
  const saver=new MemorySaver(),active=new AbortController();
  const provider={generate:jest.fn(async()=>{active.abort();return 'durable response';})};
  const wrapped=new CheckpointedTextProvider(provider,{checkpointer:saver,identity});
  await expect(wrapped.generate(messages,{signal:active.signal,requestKey})).rejects.toThrow('TURN_ABORTED');
  await settle();
  expect(await new CheckpointedTextProvider(provider,{checkpointer:saver,identity}).generate(messages,{signal:signal(),requestKey})).toBe('durable response');
  expect(provider.generate).toHaveBeenCalledTimes(1);
});

test('root model receipt is detached from real enclosing graph namespaces and ambient runnable context',async()=>{
  const saver=new MemorySaver(),seen:unknown[]=[];
  const provider={generate:jest.fn(async()=>{seen.push(getConfig()?.configurable);return 'response';})};
  const wrapped=new CheckpointedTextProvider(provider,{checkpointer:saver,identity});
  const State=Annotation.Root({value:Annotation<string>()});
  const outer=new StateGraph(State).addNode('outer',async()=>({value:await wrapped.generate(messages,{signal:signal(),requestKey})})).addEdge(START,'outer').addEdge('outer',END).compile();
  await outer.invoke({value:''},{configurable:{thread_id:'synthetic-parent',checkpoint_ns:'arbitrary-parent',checkpoint_map:{'arbitrary-parent':'synthetic-id'}}});
  await AsyncLocalStorageProviderSingleton.runWithConfig({configurable:{thread_id:'different-parent',checkpoint_ns:'different-parent'}},()=>wrapped.generate(messages,{signal:signal(),requestKey}));
  expect(provider.generate).toHaveBeenCalledTimes(1);
  // The provider sees no graph internals, while independent OTel context remains untouched.
  expect(seen).toEqual([undefined]);
  expect(JSON.stringify(seen)).not.toContain('synthetic-parent');expect(JSON.stringify(seen)).not.toContain('arbitrary-parent');
  const rows=[];for await(const row of saver.list({}))rows.push(row);
  expect(rows.every(row=>row.config.configurable!.checkpoint_ns==='')).toBe(true);
});

test('cache hits obey cancellation and elapsed deadlines before callbacks',async()=>{
  const provider={generate:jest.fn(async()=> 'response')},wrapped=new CheckpointedTextProvider(provider,{checkpointer:new MemorySaver(),identity});
  await wrapped.generate(messages,{signal:signal(),requestKey});
  const active=new AbortController();active.abort();const onServed=jest.fn();
  await expect(wrapped.generate(messages,{signal:active.signal,requestKey,onServed})).rejects.toThrow('TURN_ABORTED');
  await expect(wrapped.generate(messages,{signal:signal(),requestKey,deadlineAt:Date.now()-1,onServed})).rejects.toThrow(PROVIDER_DEADLINE);
  expect(onServed).not.toHaveBeenCalled();expect(provider.generate).toHaveBeenCalledTimes(1);
});

test('invalid turn bindings and corrupt completed receipts fail without another upstream request',async()=>{
  const saver=new MemorySaver(),provider={generate:jest.fn(async()=> 'response')},wrapped=new CheckpointedTextProvider(provider,{checkpointer:saver,identity});
  await expect(wrapped.generate(messages,{signal:signal(),requestKey:'not-a-turn'})).rejects.toThrow();
  await wrapped.generate(messages,{signal:signal(),requestKey});
  const actual=saver.getTuple.bind(saver);
  jest.spyOn(saver,'getTuple').mockImplementation(async config=>{
    const tuple=await actual(config);if(!tuple)return tuple;
    return {...tuple,checkpoint:{...tuple.checkpoint,channel_values:{...tuple.checkpoint.channel_values,call:{fingerprint:'wrong',receipt:{rawResponse:42}}}}};
  });
  await expect(wrapped.generate(messages,{signal:signal(),requestKey})).rejects.toThrow();
  expect(provider.generate).toHaveBeenCalledTimes(1);
});

test.each(['missing','bad-response','bad-usage'] as const)('saved %s completed receipt fails closed without a model reask',async corruption=>{
  const saver=new MemorySaver(),provider={generate:jest.fn(async()=> 'response')},wrapped=new CheckpointedTextProvider(provider,{checkpointer:saver,identity});
  await wrapped.generate(messages,{signal:signal(),requestKey});
  const actual=saver.getTuple.bind(saver);
  jest.spyOn(saver,'getTuple').mockImplementation(async config=>{
    const tuple=await actual(config);if(!tuple)return tuple;
    const call=tuple.checkpoint.channel_values.call as {fingerprint:string;receipt?:unknown};
    const receipt=corruption==='missing'?undefined:corruption==='bad-response'?{rawResponse:42}:{rawResponse:'response',usage:{promptTokens:-1,completionTokens:null}};
    return {...tuple,checkpoint:{...tuple.checkpoint,channel_values:{...tuple.checkpoint.channel_values,call:{fingerprint:call.fingerprint,...(receipt!==undefined?{receipt}:{})}}}};
  });
  await expect(wrapped.generate(messages,{signal:signal(),requestKey})).rejects.toThrow('TURN_FAILED');
  expect(provider.generate).toHaveBeenCalledTimes(1);
});

test('a cache hit cancelled during its durable read cannot deliver callbacks or response',async()=>{
  const saver=new MemorySaver(),provider={generate:jest.fn(async()=> 'response')},wrapped=new CheckpointedTextProvider(provider,{checkpointer:saver,identity});
  await wrapped.generate(messages,{signal:signal(),requestKey});
  const active=new AbortController(),actual=saver.getTuple.bind(saver),onUsage=jest.fn();
  jest.spyOn(saver,'getTuple').mockImplementation(async config=>{const result=await actual(config);active.abort();return result;});
  await expect(wrapped.generate(messages,{signal:active.signal,requestKey,onUsage})).rejects.toThrow('TURN_ABORTED');
  expect(onUsage).not.toHaveBeenCalled();expect(provider.generate).toHaveBeenCalledTimes(1);
});

test('unknown usage stays unknown and untrusted upstream labels cannot leak through callback replay',async()=>{
  const provider:TextProvider={generate:jest.fn(async(_messages,options)=>{options.onServed?.('https://private-provider/token');options.onUsage?.({promptTokens:null,completionTokens:null});return 'response';})};
  const wrapped=new CheckpointedTextProvider(provider,{checkpointer:new MemorySaver(),identity}),onServed=jest.fn(),onUsage=jest.fn();
  for(let attempt=0;attempt<2;attempt++)await wrapped.generate(messages,{signal:signal(),requestKey,onServed,onUsage});
  expect(onServed.mock.calls).toEqual([['unknown'],['unknown']]);expect(onUsage.mock.calls).toEqual([[{promptTokens:null,completionTokens:null}],[{promptTokens:null,completionTokens:null}]]);
});


test('message object property order is not a different request, while caller mutations cannot alter a queued call',async()=>{
  const saver=new MemorySaver(),actual=saver.getTuple.bind(saver),caller=[{role:'user' as const,content:'original'}];
  const provider={generate:jest.fn(async(input:typeof messages)=>input[0].content)};
  const wrapped=new CheckpointedTextProvider(provider,{checkpointer:saver,identity});
  jest.spyOn(saver,'getTuple').mockImplementation(async config=>{caller[0].content='mutated';return actual(config);});
  expect(await wrapped.generate(caller,{signal:signal(),requestKey})).toBe('original');
  expect(await wrapped.generate([{content:'original',role:'user'}],{signal:signal(),requestKey})).toBe('original');
  expect(provider.generate).toHaveBeenCalledTimes(1);
});

test('provider failures persist only a sanitized transport code, never an untrusted error body',async()=>{
  const saver=new MemorySaver(),provider={generate:jest.fn(async()=>{throw Object.assign(new Error('synthetic secret error body'),{code:'PROVIDER_TRANSPORT'});})};
  const wrapped=new CheckpointedTextProvider(provider,{checkpointer:saver,identity});
  await expect(wrapped.generate(messages,{signal:signal(),requestKey})).rejects.toMatchObject({message:'PROVIDER_TRANSPORT',code:'PROVIDER_TRANSPORT'});
  const rows=[];for await(const row of saver.list({}))rows.push(row);
  expect(JSON.stringify(rows)).not.toContain('synthetic secret error body');expect(provider.generate).toHaveBeenCalledTimes(1);
});

test.each([{label:'empty',rawResponse:''},{label:'whitespace',rawResponse:' \n\t '},{label:'UTF8 over limit',rawResponse:'한'.repeat(21846)}])('invalid $label raw response cannot be served live or replayed',async({rawResponse})=>{
  const saver=new MemorySaver(),provider={generate:jest.fn(async()=>rawResponse)},wrapped=new CheckpointedTextProvider(provider,{checkpointer:saver,identity});
  await expect(wrapped.generate(messages,{signal:signal(),requestKey})).rejects.toThrow('TURN_FAILED');
  expect(provider.generate).toHaveBeenCalledTimes(1);
  const seeded=new MemorySaver(),validProvider={generate:jest.fn(async()=> 'valid')},seededWrapper=new CheckpointedTextProvider(validProvider,{checkpointer:seeded,identity});
  await seededWrapper.generate(messages,{signal:signal(),requestKey});
  const actual=seeded.getTuple.bind(seeded);
  jest.spyOn(seeded,'getTuple').mockImplementation(async config=>{
    const tuple=await actual(config);if(!tuple)return tuple;
    const call=tuple.checkpoint.channel_values.call as {fingerprint:string};
    return {...tuple,checkpoint:{...tuple.checkpoint,channel_values:{...tuple.checkpoint.channel_values,call:{fingerprint:call.fingerprint,receipt:{rawResponse}}}}};
  });
  await expect(seededWrapper.generate(messages,{signal:signal(),requestKey})).rejects.toThrow('TURN_FAILED');
  expect(validProvider.generate).toHaveBeenCalledTimes(1);
});

test.each([NaN,Infinity,-Infinity])('nonfinite deadline %s is rejected before cold calls and cached callbacks',async deadlineAt=>{
  const provider={generate:jest.fn(async()=> 'response')},wrapped=new CheckpointedTextProvider(provider,{checkpointer:new MemorySaver(),identity});
  const onServed=jest.fn(),onUsage=jest.fn();
  await expect(wrapped.generate(messages,{signal:signal(),requestKey,deadlineAt,onServed,onUsage})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(provider.generate).not.toHaveBeenCalled();
  await wrapped.generate(messages,{signal:signal(),requestKey});
  await expect(wrapped.generate(messages,{signal:signal(),requestKey,deadlineAt,onServed,onUsage})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(provider.generate).toHaveBeenCalledTimes(1);expect(onServed).not.toHaveBeenCalled();expect(onUsage).not.toHaveBeenCalled();
});

test.each(['PRIVATE_SECRET_TOKEN_ABC','PROVIDER_HTTP_999','PROVIDER_HTTP_200_PRIVATE','PROVIDER_TRANSPORT_SECRET'])('unknown or secret-looking uppercase code %s is not persisted or surfaced',async code=>{
  const saver=new MemorySaver(),provider={generate:jest.fn(async()=>{throw Object.assign(new Error('untrusted body'),{code});})};
  const wrapped=new CheckpointedTextProvider(provider,{checkpointer:saver,identity});
  await expect(wrapped.generate(messages,{signal:signal(),requestKey})).rejects.toMatchObject({code:'PROVIDER_TRANSPORT',message:'PROVIDER_TRANSPORT'});
  const rows=[];for await(const row of saver.list({}))rows.push(row);
  expect(JSON.stringify(rows)).not.toContain(code);expect(provider.generate).toHaveBeenCalledTimes(1);
});

test.each([PROVIDER_DEADLINE,'CANCELLED','PROVIDER_TIMEOUT','INVALID_INPUT','INPUT_LIMIT','INVALID_PROVIDER_RESPONSE','PROVIDER_TRANSPORT','PROVIDER_HTTP_100','PROVIDER_HTTP_429','PROVIDER_HTTP_599'])('known adapter failure code %s retains its classification',async code=>{
  const provider={generate:jest.fn(async()=>{throw Object.assign(new Error('untrusted body'),{code});})};
  const wrapped=new CheckpointedTextProvider(provider,{checkpointer:new MemorySaver(),identity});
  await expect(wrapped.generate(messages,{signal:signal(),requestKey})).rejects.toMatchObject({code,message:code});
  expect(provider.generate).toHaveBeenCalledTimes(1);
});

test('65536 UTF8 byte response remains replayable without trimming transport contents',async()=>{
  const response=' 한'.padEnd(65536-2,'a');expect(Buffer.byteLength(response,'utf8')).toBe(65536);
  const provider={generate:jest.fn(async()=>response)},wrapped=new CheckpointedTextProvider(provider,{checkpointer:new MemorySaver(),identity});
  for(let attempt=0;attempt<2;attempt++)expect(await wrapped.generate(messages,{signal:signal(),requestKey})).toBe(response);
  expect(provider.generate).toHaveBeenCalledTimes(1);
});
