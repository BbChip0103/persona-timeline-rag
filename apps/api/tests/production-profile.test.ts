import { BullMqTurnDelivery, RedisTurnEvents } from '@ptr/messaging';
import { loadConfig } from '@ptr/ops';
import { createRecoveryRuntime, createRuntime } from '../src/runtime';

// : the production profile's code changes. Synthetic loopback targets; nothing connects.
const databaseUrl='postgresql://ptr_loadtester:synthetic-password@127.0.0.1:56432/ptr_loadtest';
const redisUrl='redis://ptr:synthetic-password@127.0.0.1:56479/0';
const gateway={DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:'gateway',PTR_GATEWAY_TOKEN:'synthetic_gateway_token_abcdefghij'};
const structuredOf=(runtime:ReturnType<typeof createRuntime>)=>(runtime.provider as unknown as {options:{structuredAgentReplies?:boolean}}).options.structuredAgentReplies;

test('the gateway provider asks for structured agent replies by default; PTR_GATEWAY_STRUCTURED=0 (demo layer) turns it off',async()=>{
  const byDefault=createRuntime(gateway);expect(structuredOf(byDefault)).toBe(true);await byDefault.close?.();
  const off=createRuntime({...gateway,PTR_GATEWAY_STRUCTURED:'0'});expect(structuredOf(off)).toBe(false);await off.close?.();
  const on=createRuntime({...gateway,PTR_GATEWAY_STRUCTURED:'1'});expect(structuredOf(on)).toBe(true);await on.close?.();
});
test('the dispatcher starts without any provider key: its runtime has leases, delivery and events only',async()=>{
  const env={DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl};
  expect(loadConfig('dispatcher',env,()=>undefined).errors).toEqual([]);
  // Provider settings that createRuntime would refuse are never read.
  const runtime=createRecoveryRuntime({...env,PTR_CHAT_PROVIDER:'gateway',PTR_INTENT_CLASSIFIER:'jev'});
  expect(runtime.delivery).toBeInstanceOf(BullMqTurnDelivery);expect(runtime.events).toBeInstanceOf(RedisTurnEvents);expect(runtime.leases).toBeDefined();
  expect(Object.keys(runtime).sort()).toEqual(['close','delivery','events','leases']);
  await runtime.close();
  // Same validation as createRuntime for what it does read.
  for(const extra of [{PTR_TURN_QUEUE:'Bad:Name'},{PTR_DB_POOL_MAX:'0'},{PTR_REDIS_URL:'redis://127.0.0.1:56479/0'}])
    expect(()=>createRecoveryRuntime({...env,...extra})).toThrow();
});
