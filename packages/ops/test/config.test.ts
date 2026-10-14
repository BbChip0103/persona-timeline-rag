import { ConfigError, ROLES, checkRole, loadConfig, type EnvRole } from '../src';

const TOKEN='synthetic-token-only-0123456789';
const runtime=()=>({DATABASE_URL:'postgresql://ptr_framework_tester:synthetic-password@127.0.0.1:57432/ptr_framework_test',
  PTR_REDIS_URL:'redis://:synthetic-password@127.0.0.1:57479/0',PTR_CHAT_PROVIDER:'fake',
  PTR_PERSONAS_FILE:'synthetic-personas.json',PTR_API_TOKEN:TOKEN,
  PTR_GUARDRAILS_URL:'http://127.0.0.1:58000',PTR_GUARDRAILS_TOKEN:'synthetic-guardrails-token-only'});
const web=()=>({PTR_API_TOKEN:TOKEN,PTR_SESSION_SECRET:'synthetic-session-secret-at-least-32',PTR_UI_PASSWORD:'synthetic-ui-password'});
const valid=(role:EnvRole)=>role==='web'?web():runtime();

test('only API, worker and dependency-free web are roles',()=>expect(ROLES).toEqual(['api','worker','web']));
test.each(['api','worker','web'] as EnvRole[])('%s valid framework configuration has no errors',role=>{
  expect(checkRole(role,valid(role))).toEqual({role,errors:[],warnings:[]});
});
test.each(['api','worker'] as const)('%s operator uses framework fake/local contract, not old gateway/model allowlists',role=>{
  expect(checkRole(role,{...runtime(),PTR_CHAT_PROVIDER:'gateway'}).errors).toContainEqual({key:'PTR_CHAT_PROVIDER',rule:'invalid_enum_value'});
  expect(checkRole(role,{...runtime(),PTR_CHAT_PROVIDER:undefined}).errors.some(problem=>problem.key==='PTR_CHAT_PROVIDER')).toBe(true);
  expect(checkRole(role,{...runtime(),PTR_MODEL:'local-model-alias'}).errors).toEqual([]);
});
test('framework validation preserves isolated DB/Redis and concurrency guards',()=>{
  for(const override of [{DATABASE_URL:'postgresql://u:PRIVATE_SENTINEL@remote.invalid/production'},
    {PTR_REDIS_URL:'redis://PRIVATE_SENTINEL@remote.invalid/0'},{PTR_WORKER_CONCURRENCY:'0'},{PTR_API_TOKEN:'short'}]) {
    const report=checkRole('worker',{...runtime(),...override});expect(report.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_SENTINEL');
  }
});
test('Jev and paid spillover gates are the same as framework startup, no demo bypass',()=>{
  expect(checkRole('worker',{...runtime(),PTR_SAFETY_FILTER:'jev'}).errors).toContainEqual({key:'PTR_SAFETY_FILTER',rule:'paid_jev_not_enabled'});
  expect(checkRole('worker',{...runtime(),PTR_PAID_SPILLOVER:'1'}).errors).toContainEqual({key:'GOAL1_LIVE_ENABLED',rule:'paid_transfer_not_enabled'});
  expect(checkRole('worker',{PTR_DEMO_SCALING:'1',PTR_CHAT_PROVIDER:'fake'}).errors).toContainEqual({key:'PTR_DEMO_SCALING',rule:'retired_setting'});
});
test.each(['PTR_GATEWAY_TOKEN','PTR_CAPACITY_CONTROLLER','PTR_UPSTREAM_HEARTBEAT_MS','PTR_REGISTRY_PREFIX','PTR_EXECUTION'])(
  'retired controls fail instead of restoring parallel paths: %s',key=>{
    const errors=checkRole('api',{...runtime(),[key]:'synthetic-unused'}).errors;
    expect(errors.filter(problem=>problem.key===key)).toEqual([{key,rule:'retired_setting'}]);
  });
test('unknown knobs fail; infrastructure/system keys do not require obsolete registries',()=>{
  const name=['PTR','UNKNOWN','SETTING'].join('_');
  expect(checkRole('api',{...runtime(),[name]:'PRIVATE_SENTINEL'}).errors).toEqual([{key:name,rule:'unknown_key'}]);
  expect(checkRole('api',{...runtime(),PTR_DB_PASSWORD:'synthetic',HOME:'/synthetic',SOME_TOOL_SETTING:'x'}).errors).toEqual([]);
});
test('DB alias is explicit, does not override canonical DB, and conflict is framework-detected',()=>{
  const env=runtime();
  expect(checkRole('api',{...env,DATABASE_URL:undefined,GOAL1_DATABASE_URL:env.DATABASE_URL}).warnings).toEqual([{key:'GOAL1_DATABASE_URL',rule:'renamed_key'}]);
  expect(checkRole('api',{...env,GOAL1_DATABASE_URL:env.DATABASE_URL.replace('synthetic-password','different')}).errors)
    .toContainEqual({key:'DATABASE_URL',rule:'conflicting_alias'});
});
test('web authentication remains validated and API target remains constant',()=>{
  expect(checkRole('web',{...web(),PTR_UI_PASSWORD:'short'}).errors).toEqual([{key:'PTR_UI_PASSWORD',rule:'password_length'}]);
  expect(checkRole('web',{...web(),PTR_API_URL:'http://127.0.0.1:56441'}).warnings).toEqual([{key:'PTR_API_URL',rule:'constant_ignored'}]);
  expect(checkRole('web',{...web(),PTR_API_URL:'http://remote.invalid'}).errors).toEqual([{key:'PTR_API_URL',rule:'api_url_constant'}]);
});
test('loadConfig outputs only keys/rule codes, no values or rejected URLs',()=>{
  const lines:string[]=[];const sentinel='PRIVATE_SECRET_SENTINEL';
  expect(()=>loadConfig('api',{...runtime(),DATABASE_URL:`postgresql://u:${sentinel}@remote.invalid/production`},line=>lines.push(line))).toThrow(ConfigError);
  expect(lines.join('\n')).not.toContain(sentinel);expect(lines.join('\n')).not.toContain('remote.invalid');
  expect(JSON.parse(lines[0]!)).toMatchObject({event:'config_invalid',role:'api'});
  expect(loadConfig('api',runtime(),()=>undefined).errors).toEqual([]);
});
