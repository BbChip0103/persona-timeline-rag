import { FakeTextProvider, LatencyInjectedTextProvider } from '@ptr/providers';
import { createRuntime } from '../src/runtime';

// Pools are lazy: no connection is opened by composition alone.
const databaseUrl='postgresql://ptr_loadtester:synthetic-password@127.0.0.1:56432/ptr_loadtest';

test('fake provider stays instant unless a load-test latency profile is set',async()=>{
  const runtime=createRuntime({DATABASE_URL:databaseUrl});
  expect(runtime.provider).toBeInstanceOf(FakeTextProvider);
  await runtime.close?.();
});
test('PTR_FAKE_LATENCY wraps only the fake provider with the seeded delay profile',async()=>{
  const runtime=createRuntime({DATABASE_URL:databaseUrl,PTR_FAKE_LATENCY:'{"medianMs":1900,"p95Ms":3600,"seed":7}'});
  expect(runtime.provider).toBeInstanceOf(LatencyInjectedTextProvider);
  expect(runtime.model).toBe('synthetic/fake-text-v1+latency');
  await runtime.close?.();
});
test('invalid latency profiles fail at startup, and are rejected for live providers',()=>{
  expect(()=>createRuntime({DATABASE_URL:databaseUrl,PTR_FAKE_LATENCY:'{"medianMs":0}'})).toThrow();
  expect(()=>createRuntime({DATABASE_URL:databaseUrl,PTR_CHAT_PROVIDER:'openrouter',PTR_FAKE_LATENCY:'{"medianMs":10,"p95Ms":20}'})).toThrow();
});
test('PTR_EXECUTION=queue exposes the durable queue and validates its knobs',async()=>{
  const runtime=createRuntime({DATABASE_URL:databaseUrl,PTR_EXECUTION:'queue',PTR_QUEUE_MAX_DEPTH:'64',PTR_DB_POOL_MAX:'32'});
  expect(runtime.queue).toBeDefined();
  await runtime.close?.();
  const inline=createRuntime({DATABASE_URL:databaseUrl});expect(inline.queue).toBeUndefined();await inline.close?.();
  for(const env of [{PTR_EXECUTION:'threads'},{PTR_EXECUTION:'queue',PTR_QUEUE_MAX_DEPTH:'0'},{PTR_DB_POOL_MAX:'0'}])
    expect(()=>createRuntime({DATABASE_URL:databaseUrl,...env})).toThrow();
});
