import { BullMqTurnDelivery, RedisTurnEvents } from '@ptr/messaging';
import { loadFrameworkConfig } from '@ptr/ops';
import { createRuntime } from '../src/runtime';
const env={DATABASE_URL:'postgresql://ptr_framework_tester:synthetic-password@127.0.0.1:57432/ptr_framework_test',
 PTR_REDIS_URL:'redis://:synthetic-password@127.0.0.1:57479/0',PTR_CHAT_PROVIDER:'fake',PTR_GUARDRAILS_URL:'http://127.0.0.1:57464',PTR_GUARDRAILS_TOKEN:'synthetic_guard_token_abcdefghij',
 PTR_PERSONAS_FILE:'data/synthetic/personas.json',PTR_API_TOKEN:'synthetic_private_token_abcdefghij'};
test('api and worker compose same durable execution path; no dispatcher runtime or provider keys for fake',async()=>{
 expect(loadFrameworkConfig('api',env).PTR_CHAT_PROVIDER).toBe('fake');
 expect(loadFrameworkConfig('worker',env).PTR_WORKER_CONCURRENCY).toBe(32);
 const runtime=createRuntime(env);
 expect(runtime.delivery).toBeInstanceOf(BullMqTurnDelivery);expect(runtime.events).toBeInstanceOf(RedisTurnEvents);
 expect(runtime.executionStore).toBe(runtime.leases);expect('gateways' in runtime).toBe(false);
 await runtime.close?.();
});
