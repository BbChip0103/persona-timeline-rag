import { FakeTextProvider, LatencyInjectedTextProvider, OpenAICompatibleTextProvider } from '@ptr/providers';
import { BullMqTurnDelivery } from '@ptr/messaging';
import { createRuntime } from '../src/runtime';

// Pools are lazy: no connection is opened by composition alone.
const databaseUrl='postgresql://ptr_loadtester:synthetic-password@127.0.0.1:56432/ptr_loadtest';
// Redis clients are lazy too: composition validates the target but connects on first use.
const redisUrl='redis://:synthetic-password@127.0.0.1:56479/0';

test('fake provider stays instant unless a load-test latency profile is set',async()=>{
  const runtime=createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl});
  expect(runtime.provider).toBeInstanceOf(FakeTextProvider);
  await runtime.close?.();
});
test('PTR_FAKE_LATENCY wraps only the fake provider with the seeded delay profile',async()=>{
  const runtime=createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_FAKE_LATENCY:'{"medianMs":1900,"p95Ms":3600,"seed":7}'});
  expect(runtime.provider).toBeInstanceOf(LatencyInjectedTextProvider);
  expect(runtime.model).toBe('synthetic/fake-text-v1+latency');
  await runtime.close?.();
});
test('invalid latency profiles fail at startup, and are rejected for live providers',()=>{
  expect(()=>createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_FAKE_LATENCY:'{"medianMs":0}'})).toThrow();
  expect(()=>createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:'openrouter',PTR_FAKE_LATENCY:'{"medianMs":10,"p95Ms":20}'})).toThrow();
});
test('turns always run through Redis workers: queue knobs are validated and the removed PTR_EXECUTION is rejected',async()=>{
  const runtime=createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_QUEUE_MAX_DEPTH:'64',PTR_DB_POOL_MAX:'32'});
  expect(runtime.delivery).toBeInstanceOf(BullMqTurnDelivery);expect(runtime.leases).toBeDefined();
  await runtime.close?.();
  for(const env of [{PTR_EXECUTION:'inline'},{PTR_EXECUTION:'queue'},{PTR_QUEUE_MAX_DEPTH:'0'},{PTR_DB_POOL_MAX:'0'},{PTR_TURN_QUEUE:'Bad:Name'},{PTR_EVENTS_NAMESPACE:'x'.repeat(41)}])
    expect(()=>createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,...env})).toThrow();
  for(const url of ['','redis://:x@10.0.0.5:56479/0','redis://127.0.0.1:56479/0'])
    expect(()=>createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:url})).toThrow();
});
test('PTR_CHAT_PROVIDER=selfhosted uses the loopback OpenAI-compatible engine and never the billable client',async()=>{
  const runtime=createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:'selfhosted',PTR_SELFHOSTED_BASE_URL:'http://127.0.0.1:18000/v1',PTR_SELFHOSTED_MODEL:'gemma-4-e4b'});
  expect(runtime.provider).toBeInstanceOf(OpenAICompatibleTextProvider);
  expect(runtime.providerName).toBe('selfhosted');expect(runtime.model).toBe('selfhosted/gemma-4-e4b');
  await runtime.close?.();
  expect(()=>createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:'selfhosted',PTR_SELFHOSTED_BASE_URL:'https://api.example.com/v1',PTR_SELFHOSTED_MODEL:'m'})).toThrow();
  expect(()=>createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:'selfhosted'})).toThrow();
});
test('PTR_CHAT_PROVIDER=gateway sends every model call to the loopback LLM gateway with its token',async()=>{
  const runtime=createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:'gateway',PTR_GATEWAY_TOKEN:'synthetic_gateway_token_abcdefghij'});
  expect(runtime.provider).toBeInstanceOf(OpenAICompatibleTextProvider);expect(runtime.model).toBe('gateway');
  await runtime.close?.();
  expect(()=>createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:'gateway'})).toThrow();
  expect(()=>createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:'gateway',PTR_GATEWAY_TOKEN:'synthetic_gateway_token_abcdefghij',PTR_GATEWAY_URL:'https://example.com/v1'})).toThrow();
});
test('gateway URLs: PTR_GATEWAY_URLS is a priority list (PTR_GATEWAY_URL a list of one); reset retries are configurable',async()=>{
  const base={DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:'gateway',PTR_GATEWAY_TOKEN:'synthetic_gateway_token_abcdefghij'};
  const optionsOf=(runtime:ReturnType<typeof createRuntime>)=>(runtime.provider as unknown as {options:{baseUrl:string[];resetRetries:number;retryMinRemainingMs:number}}).options;
  const defaults=createRuntime(base);
  expect(optionsOf(defaults)).toMatchObject({baseUrl:['http://127.0.0.1:56460/v1'],resetRetries:2,retryMinRemainingMs:5000});
  await defaults.close?.();
  const single=createRuntime({...base,PTR_GATEWAY_URL:'http://127.0.0.1:56461/v1'});
  expect(optionsOf(single).baseUrl).toEqual(['http://127.0.0.1:56461/v1']);await single.close?.();
  const pair=createRuntime({...base,PTR_GATEWAY_URLS:' http://127.0.0.1:56460/v1 , http://127.0.0.1:56461/v1',PTR_GATEWAY_RESET_RETRIES:'0',PTR_GATEWAY_RETRY_MIN_REMAINING_MS:'8000'});
  expect(optionsOf(pair)).toMatchObject({baseUrl:['http://127.0.0.1:56460/v1','http://127.0.0.1:56461/v1'],resetRetries:0,retryMinRemainingMs:8000});
  await pair.close?.();
  for(const extra of [{PTR_GATEWAY_URLS:'http://127.0.0.1:56460/v1,https://example.com/v1'},{PTR_GATEWAY_URLS:' , '},{PTR_GATEWAY_RESET_RETRIES:'-1'},{PTR_GATEWAY_RESET_RETRIES:''},{PTR_GATEWAY_RETRY_MIN_REMAINING_MS:' '},{PTR_GATEWAY_URLS:'http://127.0.0.1:56460/v1,http://127.0.0.1:56460/v1'},{PTR_GATEWAY_RESET_RETRIES:'11'},{PTR_GATEWAY_RETRY_MIN_REMAINING_MS:'x'}])
    expect(()=>createRuntime({...base,...extra})).toThrow();
});
test('PTR_INTENT_CLASSIFIER=jev is off by default, needs the live gates, and validates its knobs',async()=>{
  const classifierOf=(runtime:ReturnType<typeof createRuntime>)=>(runtime.chat as unknown as {options:{intentClassifier?:{classifier:{name:string};minConfidence:number;timeoutMs:number}}}).options.intentClassifier;
  const off=createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl});
  expect(classifierOf(off)).toBeUndefined();await off.close?.();
  const live={DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_INTENT_CLASSIFIER:'jev',GOAL1_LIVE_ENABLED:'true',GOAL1_ALLOW_EXTERNAL_DATA:'true',OPENROUTER_API_KEY:'synthetic-private-key'};
  const jev=createRuntime(live);
  expect(classifierOf(jev)).toMatchObject({classifier:{name:'typesafe/jev-1.13'},minConfidence:0.6,timeoutMs:1500});
  // The chat provider stays fake: only the classifier uses the billable client.
  expect(jev.provider).toBeInstanceOf(FakeTextProvider);await jev.close?.();
  expect(()=>createRuntime({...live,GOAL1_LIVE_ENABLED:'false'})).toThrow('LIVE_DISABLED');
  for(const env of [{PTR_INTENT_CLASSIFIER:'llm'},{PTR_JEV_MIN_CONFIDENCE:'0'},{PTR_JEV_MIN_CONFIDENCE:'1.2'},{PTR_JEV_MIN_CONFIDENCE:'x'},{PTR_JEV_TIMEOUT_MS:'10'},{PTR_JEV_TIMEOUT_MS:'1500.5'},{PTR_JEV_MODEL:'~typesafe/jev-latest'},{PTR_FAKE_LATENCY:'{"medianMs":10,"p95Ms":20}'}])
    expect(()=>createRuntime({...live,...env})).toThrow();
});
test('PTR_SAFETY_FILTER=jev is off by default, separate from the intent classifier, and validates its thresholds',async()=>{
  type Options={inputSafety?:{classifier:{name:string};thresholds:Record<string,number>;timeoutMs:number};intentClassifier?:unknown};
  const optionsOf=(runtime:ReturnType<typeof createRuntime>)=>(runtime.chat as unknown as {options:Options}).options;
  const off=createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl});
  expect(optionsOf(off).inputSafety).toBeUndefined();await off.close?.();
  const live={DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_SAFETY_FILTER:'jev',GOAL1_LIVE_ENABLED:'true',GOAL1_ALLOW_EXTERNAL_DATA:'true',OPENROUTER_API_KEY:'synthetic-private-key'};
  const safety=createRuntime({...live,PTR_SAFETY_THRESHOLD_SELF_HARM:'0.2'});
  // Own deadline (default 2500 ms): full 4100-code-point windows measured p50 625 / max 1244 ms on 2026-10-08.
  expect(optionsOf(safety).inputSafety).toMatchObject({classifier:{name:'typesafe/jev-1.13'},timeoutMs:2500,thresholds:{self_harm:0.2,sexual:expect.any(Number)}});
  const tuned=createRuntime({...live,PTR_SAFETY_TIMEOUT_MS:'3000'});expect(optionsOf(tuned).inputSafety?.timeoutMs).toBe(3000);await tuned.close?.();
  expect(optionsOf(safety).intentClassifier).toBeUndefined();expect(safety.provider).toBeInstanceOf(FakeTextProvider);
  // Fallbacks are logged by default as a sanitized counter line.
  const write=jest.spyOn(process.stderr,'write').mockImplementation(()=>true);
  const log=(safety.chat as unknown as {options:{onSafetyFallback:(event:{scope:string;reason:string})=>void}}).options.onSafetyFallback;
  log({scope:'turn',reason:'budget'});log({scope:'turn',reason:'budget'});
  expect(write.mock.calls.map(([line])=>String(line))).toEqual(['input_safety_fallback scope=turn reason=budget count=1\n','input_safety_fallback scope=turn reason=budget count=2\n']);
  write.mockRestore();await safety.close?.();
  const both=createRuntime({...live,PTR_INTENT_CLASSIFIER:'jev'});
  expect(optionsOf(both).intentClassifier).toBeDefined();expect(optionsOf(both).inputSafety).toBeDefined();await both.close?.();
  expect(()=>createRuntime({...live,GOAL1_LIVE_ENABLED:'false'})).toThrow('LIVE_DISABLED');
  for(const env of [{PTR_SAFETY_FILTER:'regex'},{PTR_SAFETY_THRESHOLD_SEXUAL:'0'},{PTR_SAFETY_THRESHOLD_SEXUAL:'1.1'},{PTR_SAFETY_THRESHOLD_PRIVATE_INFO:'x'},{PTR_JEV_TIMEOUT_MS:'10'},{PTR_JEV_RESERVED_CALL_FRACTION:'1'},{PTR_JEV_RESERVED_CALL_FRACTION:''},{PTR_SAFETY_TIMEOUT_MS:'10'},{PTR_SAFETY_TIMEOUT_MS:'2500.5'},{PTR_SAFETY_TIMEOUT_MS:'20000'},{PTR_JEV_RESERVED_CALL_FRACTION:' '},{PTR_FAKE_LATENCY:'{"medianMs":10,"p95Ms":20}'}])
    expect(()=>createRuntime({...live,...env})).toThrow();
});
