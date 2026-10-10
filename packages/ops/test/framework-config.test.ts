import { FrameworkConfigError, loadFrameworkConfig } from '../src/framework-config';
const env=()=>({DATABASE_URL:'postgresql://ptr_framework_tester:synthetic-password@127.0.0.1:57432/ptr_framework_test',
  PTR_REDIS_URL:'redis://:synthetic-password@127.0.0.1:57479/0',PTR_CHAT_PROVIDER:'fake',PTR_GUARDRAILS_URL:'http://127.0.0.1:57464',PTR_GUARDRAILS_TOKEN:'synthetic_guard_token_abcdefghij',
  PTR_PERSONAS_FILE:'synthetic-personas.json',PTR_API_TOKEN:'synthetic-api-token-24-characters'});
test('requires explicit fake or LiteLLM, isolated targets and positive concurrency',()=>{
  expect(loadFrameworkConfig('worker',env()).PTR_WORKER_CONCURRENCY).toBe(32);
  expect(()=>loadFrameworkConfig('api',{...env(),PTR_CHAT_PROVIDER:undefined})).toThrow(FrameworkConfigError);
  expect(()=>loadFrameworkConfig('worker',{...env(),PTR_WORKER_CONCURRENCY:'0'})).toThrow(FrameworkConfigError);
  expect(()=>loadFrameworkConfig('api',{...env(),DATABASE_URL:'postgresql://not-allowed:never-output@remote.invalid/production'})).toThrow(FrameworkConfigError);
});
test('live gateway requires Guardrails and rejects unapproved tracing or paid calls',()=>{
  expect(()=>loadFrameworkConfig('worker',{...env(),PTR_CHAT_PROVIDER:'litellm'})).toThrow(FrameworkConfigError);
  expect(()=>loadFrameworkConfig('worker',{...env(),PTR_LITELLM_BILLABLE:'1'})).toThrow(FrameworkConfigError);
  expect(()=>loadFrameworkConfig('worker',{...env(),LANGSMITH_TRACING:'true'})).toThrow(FrameworkConfigError);
});
test('errors contain only key/rule, not secrets or connection strings',()=>{
  try{loadFrameworkConfig('worker',{...env(),DATABASE_URL:'secret-sentinel'});}catch(error){
    expect(JSON.stringify(error)).not.toContain('secret-sentinel');
  }
});
test('unused optional placeholders may be empty, without weakening required values or numeric controls',()=>{
  expect(loadFrameworkConfig('api',{...env(),PTR_API_SYNTHETIC_TOKEN:'',PTR_LITELLM_BASE_URL:'',PTR_LITELLM_API_KEY:''}).PTR_LITELLM_API_KEY).toBeUndefined();
  for(const extra of [{PTR_API_TOKEN:''},{PTR_GUARDRAILS_TOKEN:''},{PTR_GUARDRAILS_URL:''},{PTR_WORKER_CONCURRENCY:''},
    {PTR_CHAT_PROVIDER:'litellm',PTR_LITELLM_BASE_URL:'',PTR_LITELLM_API_KEY:''}])
    expect(()=>loadFrameworkConfig('api',{...env(),...extra})).toThrow(FrameworkConfigError);
});

test('unknown or paid aliases cannot bypass the durable ledger and paid-data gates',()=>{
  const live={...env(),PTR_CHAT_PROVIDER:'litellm',PTR_LITELLM_BASE_URL:'http://127.0.0.1:57460/v1',PTR_LITELLM_API_KEY:'synthetic_proxy_token_abcdefghij'};
  expect(()=>loadFrameworkConfig('worker',{...live,PTR_MODEL:'openrouter-primary'})).toThrow(FrameworkConfigError);
  expect(()=>loadFrameworkConfig('worker',{...live,PTR_MODEL:'unclassified'})).toThrow(FrameworkConfigError);
  expect(()=>loadFrameworkConfig('worker',{...live,PTR_MODEL:'openrouter-primary',PTR_LITELLM_BILLABLE:'1',GOAL1_LIVE_ENABLED:'true'})).toThrow(FrameworkConfigError);
  expect(loadFrameworkConfig('worker',{...live,PTR_MODEL:'openrouter-primary',PTR_LITELLM_BILLABLE:'1',GOAL1_LIVE_ENABLED:'true',GOAL1_ALLOW_EXTERNAL_DATA:'true'}).PTR_LITELLM_BILLABLE).toBe('1');
});
test('serving requires the same genuine validator even with fake model, and rejects retired knobs/alias conflicts',()=>{
  for(const extra of [{PTR_GUARDRAILS_TOKEN:undefined},{PTR_GATEWAY_URL:'unused'},{GOAL1_DATABASE_URL:'different'},{PTR_QUEUE_LOCK_MS:'0'},{PTR_ENVIRONMENT:'production'}])
    expect(()=>loadFrameworkConfig('api',{...env(),...extra})).toThrow(FrameworkConfigError);
});
