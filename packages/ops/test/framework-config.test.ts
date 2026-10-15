import { FrameworkConfigError, loadFrameworkConfig } from '../src/framework-config';
const env=()=>({DATABASE_URL:'postgresql://ptr_framework_tester:synthetic-password@127.0.0.1:57432/ptr_framework_test',
  PTR_REDIS_URL:'redis://:synthetic-password@127.0.0.1:57479/0',PTR_CHAT_PROVIDER:'fake',PTR_GUARDRAILS_URL:'http://127.0.0.1:57464',PTR_GUARDRAILS_TOKEN:'synthetic_guard_token_abcdefghij',
  PTR_PERSONAS_FILE:'synthetic-personas.json',PTR_API_TOKEN:'synthetic-api-token-24-characters'});
test('requires explicit fake or local, isolated targets and positive concurrency',()=>{
  expect(loadFrameworkConfig('worker',env()).PTR_WORKER_CONCURRENCY).toBe(32);
  expect(loadFrameworkConfig('worker',{...env(),PTR_CHAT_PROVIDER:'local',PTR_LLM_LOCAL_BASE_URL:'http://127.0.0.1:57460/v1',PTR_LLM_LOCAL_MODEL:'synthetic-local'}).PTR_CHAT_PROVIDER).toBe('local');
  expect(()=>loadFrameworkConfig('api',{...env(),PTR_CHAT_PROVIDER:undefined})).toThrow(FrameworkConfigError);
  expect(()=>loadFrameworkConfig('worker',{...env(),PTR_WORKER_CONCURRENCY:'0'})).toThrow(FrameworkConfigError);
  expect(()=>loadFrameworkConfig('api',{...env(),DATABASE_URL:'postgresql://not-allowed:never-output@remote.invalid/production'})).toThrow(FrameworkConfigError);
});
test('removed gateway settings and paid spillover require explicit live/data gates',()=>{
  expect(()=>loadFrameworkConfig('worker',{...env(),PTR_CHAT_PROVIDER:'litellm'})).toThrow(FrameworkConfigError);
  expect(()=>loadFrameworkConfig('worker',{...env(),PTR_PAID_SPILLOVER:'1'})).toThrow(FrameworkConfigError);
  expect(()=>loadFrameworkConfig('worker',{...env(),LANGSMITH_TRACING:'true'})).toThrow(FrameworkConfigError);
});
test('errors contain only key/rule, not secrets or connection strings',()=>{
  try{loadFrameworkConfig('worker',{...env(),DATABASE_URL:'secret-sentinel'});}catch(error){
    expect(JSON.stringify(error)).not.toContain('secret-sentinel');
  }
});
test('unused optional placeholders may be empty, without weakening required values or numeric controls',()=>{
  expect(loadFrameworkConfig('api',{...env(),PTR_API_SYNTHETIC_TOKEN:'',PTR_LLM_LOCAL_BASE_URL:'',PTR_LLM_LOCAL_API_KEY:''}).PTR_LLM_LOCAL_API_KEY).toBeUndefined();
  for(const extra of [{PTR_API_TOKEN:''},{PTR_GUARDRAILS_TOKEN:''},{PTR_GUARDRAILS_URL:''},{PTR_WORKER_CONCURRENCY:''},
    {PTR_CHAT_PROVIDER:'local',PTR_LLM_LOCAL_BASE_URL:'',PTR_LLM_LOCAL_MODEL:''}])
    expect(()=>loadFrameworkConfig('api',{...env(),...extra})).toThrow(FrameworkConfigError);
});

test('paid spillover cannot bypass paid-data gates',()=>{
  const live={...env(),PTR_CHAT_PROVIDER:'local',PTR_LLM_LOCAL_BASE_URL:'http://127.0.0.1:57460/v1',PTR_LLM_LOCAL_MODEL:'synthetic-local'};
  expect(()=>loadFrameworkConfig('worker',{...live,PTR_PAID_SPILLOVER:'1',GOAL1_LIVE_ENABLED:'true'})).toThrow(FrameworkConfigError);
  expect(()=>loadFrameworkConfig('worker',{...live,PTR_PAID_SPILLOVER:'1',GOAL1_LIVE_ENABLED:'true',GOAL1_ALLOW_EXTERNAL_DATA:'true'})).toThrow(FrameworkConfigError);
});
test('split API permits local billable drafts while framework API and worker retain ledger and paid gates',()=>{
  const paid={...env(),PTR_CHAT_PROVIDER:'local',PTR_LLM_LOCAL_BASE_URL:'http://127.0.0.1:57460/v1',PTR_LLM_LOCAL_MODEL:'synthetic-local',PTR_PAID_SPILLOVER:'1',PTR_LLM_SERVICE_MODE:'split'};
  expect(loadFrameworkConfig('api',paid).PTR_PAID_SPILLOVER).toBe('1');
  for(const [role,settings] of [['api',{...paid,PTR_LLM_SERVICE_MODE:'legacy'}],['worker',paid]] as const){
    try{loadFrameworkConfig(role,settings);throw new Error('expected config rejection');}
    catch(error){expect(error).toBeInstanceOf(FrameworkConfigError);
      expect((error as FrameworkConfigError).problems).toEqual(expect.arrayContaining([
        {key:'GOAL1_LIVE_ENABLED',rule:'paid_transfer_not_enabled'},
        {key:'PTR_PAID_SPILLOVER',rule:'local_has_no_spillover_ledger'},
      ]));}
  }
});
test('serving requires the same genuine validator even with fake model, and rejects retired knobs/alias conflicts',()=>{
  for(const extra of [{PTR_GUARDRAILS_TOKEN:undefined},{PTR_GATEWAY_URL:'unused'},{GOAL1_DATABASE_URL:'different'},{PTR_QUEUE_LOCK_MS:'0'},{PTR_ENVIRONMENT:'production'}])
    expect(()=>loadFrameworkConfig('api',{...env(),...extra})).toThrow(FrameworkConfigError);
});
