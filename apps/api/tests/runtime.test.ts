import { FakeTextProvider, LatencyInjectedTextProvider, LiteLLMTextProvider } from '@ptr/providers';
import { BullMqTurnDelivery } from '@ptr/messaging';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Persona } from '@ptr/contracts';
import { createRuntime, mergePersonaLists, readPersonaCatalogue } from '../src/runtime';

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
test('the worker\'s observability hooks reach the chat service (completion, failure, safety fallback)',async()=>{
  const hooks={onTurnFailure:()=>undefined,onTurnCompleted:()=>undefined,onSafetyFallback:()=>undefined};
  const runtime=createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl},hooks);
  const options=(runtime.chat as unknown as {options:Record<string,unknown>}).options;
  expect(options.onTurnCompleted).toBe(hooks.onTurnCompleted);expect(options.onTurnFailure).toBe(hooks.onTurnFailure);
  expect(typeof runtime.health).toBe('function');
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
const framework={DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:'litellm',
  PTR_LITELLM_BASE_URL:'http://127.0.0.1:57460/v1',PTR_LITELLM_API_KEY:'synthetic_proxy_token_abcdefghij',
  PTR_GUARDRAILS_URL:'http://127.0.0.1:57464',PTR_GUARDRAILS_TOKEN:'synthetic_guard_token_abcdefghij'};
test('nonbillable turn route checkpoints costly model calls only; raw adapter stays available for drafts',async()=>{
  const runtime=createRuntime(framework);
  expect(runtime.provider).toBeInstanceOf(LiteLLMTextProvider);expect(runtime.executionStore).toBe(runtime.leases);
  const options=(runtime.chat as unknown as {options:Record<string,unknown>}).options;
  expect(options.guardrails).toBeDefined();expect(options.agentCheckpoint).toBeUndefined();expect(options.provider).not.toBe(runtime.provider);expect(options.observeStage).toBeDefined();
  expect(options.semanticSearch).toBe(false);await runtime.close?.();
});
test('legacy chat routes are rejected rather than retained as hidden parallel defaults',()=>{
  for(const PTR_CHAT_PROVIDER of ['gateway','selfhosted','openrouter','unknown'])
    expect(()=>createRuntime({...framework,PTR_CHAT_PROVIDER})).toThrow();
  expect(()=>createRuntime({...framework,PTR_GUARDRAILS_TOKEN:undefined})).toThrow();
  expect(()=>createRuntime({...framework,PTR_LITELLM_BILLABLE:'1'})).toThrow();
  expect(()=>createRuntime({...framework,PTR_MODEL:'openrouter-primary'})).toThrow();
});
test('real vectors cannot be queried using synthetic hashes',async()=>{
  const runtime=createRuntime(framework);
  await expect(runtime.chat.createSession('owner_synthetic',{personId:'person_synthetic',personaId:'persona_synthetic',personaRevision:'v1',timezone:'UTC',retrievalMode:'semantic'})).rejects.toMatchObject({code:'SEMANTIC_UNAVAILABLE'});
  await runtime.close?.();
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
  // One JSON event per fallback , with the running count.
  expect(write.mock.calls.map(([line])=>JSON.parse(String(line))).map(({role,event,scope,reason,count})=>({role,event,scope,reason,count}))).toEqual([
    {role:'api',event:'input_safety_fallback',scope:'turn',reason:'budget',count:1},{role:'api',event:'input_safety_fallback',scope:'turn',reason:'budget',count:2}]);
  write.mockRestore();await safety.close?.();
  const both=createRuntime({...live,PTR_INTENT_CLASSIFIER:'jev'});
  expect(optionsOf(both).intentClassifier).toBeDefined();expect(optionsOf(both).inputSafety).toBeDefined();await both.close?.();
  expect(()=>createRuntime({...live,GOAL1_LIVE_ENABLED:'false'})).toThrow('LIVE_DISABLED');
  for(const env of [{PTR_SAFETY_FILTER:'regex'},{PTR_SAFETY_THRESHOLD_SEXUAL:'0'},{PTR_SAFETY_THRESHOLD_SEXUAL:'1.1'},{PTR_SAFETY_THRESHOLD_PRIVATE_INFO:'x'},{PTR_JEV_TIMEOUT_MS:'10'},{PTR_JEV_RESERVED_CALL_FRACTION:'1'},{PTR_JEV_RESERVED_CALL_FRACTION:''},{PTR_SAFETY_TIMEOUT_MS:'10'},{PTR_SAFETY_TIMEOUT_MS:'2500.5'},{PTR_SAFETY_TIMEOUT_MS:'20000'},{PTR_JEV_RESERVED_CALL_FRACTION:' '},{PTR_FAKE_LATENCY:'{"medianMs":10,"p95Ms":20}'}])
    expect(()=>createRuntime({...live,...env})).toThrow();
});

describe('persona catalogue: generated list + authored list ',()=>{
  const p=(personId:string,revision:string):Persona=>({id:`persona:${personId}`,personId,label:'Synthetic',language:'ko',revision,reviewStatus:'synthetic',identity:'Fictional',concept:'test',style:[],boundaries:['AI'],sourceRefs:[],greeting:'안녕'});
  test('the authored entry wins for its personId; other generated entries stay; personIds are unique',()=>{
    const merged=mergePersonaLists([p('a','gen-1'),p('b','gen-1')],[p('b','auth-1'),p('c','auth-1')]);
    expect(merged.map(x=>[x.personId,x.revision])).toEqual([['a','gen-1'],['b','auth-1'],['c','auth-1']]);
    // A prepare-research rerun replaces only the generated list: the authored entry still wins.
    expect(mergePersonaLists([p('a','gen-2'),p('b','gen-2')],[p('b','auth-1')]).find(x=>x.personId==='b')!.revision).toBe('auth-1');
    expect(()=>mergePersonaLists([],[p('b','auth-1'),p('b','auth-2')])).toThrow();
    expect(()=>mergePersonaLists([p('a','gen-1'),p('a','gen-2')],[])).toThrow();
  });
  test('the API reads the authored list only from PTR_AUTHORED_PERSONAS_FILE: unset is empty, set but missing does not start',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'personas-'));
    try {
      const generated=join(dir,'generated.json'),authored=join(dir,'authored.json');
      await writeFile(generated,JSON.stringify([p('a','gen-1'),p('b','gen-1')]));await writeFile(authored,JSON.stringify([p('b','auth-1')]));
      const base={DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_PERSONAS_FILE:generated};
      // File reading only (listPersonas then keeps the entries whose revision is current in the database).
      expect((await readPersonaCatalogue(base,databaseUrl)).map(x=>x.revision)).toEqual(['gen-1','gen-1']);
      expect((await readPersonaCatalogue({...base,PTR_AUTHORED_PERSONAS_FILE:authored},databaseUrl)).map(x=>[x.personId,x.revision])).toEqual([['a','gen-1'],['b','auth-1']]);
      const started=createRuntime({...base,PTR_AUTHORED_PERSONAS_FILE:authored});await started.close?.();
      expect(()=>createRuntime({...base,PTR_AUTHORED_PERSONAS_FILE:join(dir,'missing.json')})).toThrow();
      // Published lists are bound to their database ({database, personas}); a list for another database is refused.
      await writeFile(authored,JSON.stringify({database:'ptr_loadtest',personas:[p('b','auth-2')]}));
      expect((await readPersonaCatalogue({...base,PTR_AUTHORED_PERSONAS_FILE:authored},databaseUrl)).map(x=>x.revision)).toEqual(['gen-1','auth-2']);
      await writeFile(authored,JSON.stringify({database:'ptr_research',personas:[p('b','auth-2')]}));
      await expect(readPersonaCatalogue({...base,PTR_AUTHORED_PERSONAS_FILE:authored},databaseUrl)).rejects.toThrow();
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});

test('paid model calls use their existing ledger instead of another checkpoint wrapper',async()=>{
  const runtime=createRuntime({...framework,PTR_LITELLM_BILLABLE:'1',GOAL1_LIVE_ENABLED:'true',GOAL1_ALLOW_EXTERNAL_DATA:'true'});
  const options=(runtime.chat as unknown as {options:Record<string,unknown>}).options;
  expect(options.agentCheckpoint).toBeUndefined();expect(options.provider).toBe(runtime.provider);
  expect(runtime.billable).toBe(true);await runtime.close?.();
});
test('fake domain generation has no stage or model checkpoint wrapper',async()=>{
  const runtime=createRuntime({DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl});
  const options=(runtime.chat as unknown as {options:Record<string,unknown>}).options;
  expect(options.agentCheckpoint).toBeUndefined();expect(options.provider).toBe(runtime.provider);
  await runtime.close?.();
});
