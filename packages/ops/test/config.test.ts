import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, checkRole, loadConfig, type EnvRole } from '../src';

// Synthetic values only. Loopback targets pass the storage/Redis guards; nothing connects.
const DB='postgresql://ptr_researcher:synthetic-password@127.0.0.1:56432/ptr_research';
const REDIS='redis://:synthetic-password@127.0.0.1:56479/0';
const TOKEN='synthetic-token-abcdefghijklmnop', GATEWAY_TOKEN='synthetic-gateway-token-abcdefghij';
let dir:string, upstreams:string, twoPools:string, personas:string;
beforeAll(()=>{
  dir=mkdtempSync(join(tmpdir(),'ptr-ops-'));
  upstreams=join(dir,'upstreams.json');twoPools=join(dir,'two.json');personas=join(dir,'personas.json');
  writeFileSync(upstreams,JSON.stringify({pools:{'synthetic-model':{upstreams:[{id:'a',baseUrl:'http://127.0.0.1:18000/v1'}]}}}));
  writeFileSync(twoPools,JSON.stringify({pools:{a:{upstreams:[]},b:{upstreams:[]}}}));
  writeFileSync(personas,'[]');
});
afterAll(()=>rmSync(dir,{recursive:true,force:true}));

const base=():Record<EnvRole,NodeJS.ProcessEnv>=>({
  api:{DATABASE_URL:DB,PTR_REDIS_URL:REDIS,PTR_CHAT_PROVIDER:'gateway',PTR_GATEWAY_TOKEN:GATEWAY_TOKEN,PTR_API_TOKEN:TOKEN},
  worker:{DATABASE_URL:DB,PTR_REDIS_URL:REDIS,PTR_CHAT_PROVIDER:'gateway',PTR_GATEWAY_TOKEN:GATEWAY_TOKEN},
  dispatcher:{DATABASE_URL:DB,PTR_REDIS_URL:REDIS},
  gateway:{PTR_GATEWAY_TOKEN:GATEWAY_TOKEN,PTR_GATEWAY_UPSTREAMS_FILE:upstreams},
  web:{PTR_API_TOKEN:TOKEN,PTR_SESSION_SECRET:'synthetic-session-secret-at-least-32-chars',PTR_UI_PASSWORD:'synthetic'},
});
const live={GOAL1_LIVE_ENABLED:'true',GOAL1_ALLOW_EXTERNAL_DATA:'true',OPENROUTER_API_KEY:'synthetic-key'};
const check=(role:EnvRole,env:NodeJS.ProcessEnv)=>{const report=checkRole(role,env);return {errors:report.errors,warnings:report.warnings};};
// Built at run time so the env-name scan does not see a fake registered name.
const unknownKey=['PTR','NOT','A','KNOB'].join('_'), unknownGoal1Key=['GOAL1','UNKNOWN'].join('_');

describe('role schemas ()',()=>{
  test.each(['api','worker','dispatcher','gateway','web'] as EnvRole[])('a complete %s production profile passes',role=>{
    expect(check(role,base()[role])).toEqual({errors:[],warnings:[]});
  });
  test.each([
    ['api','PTR_REDIS_URL'],['api','DATABASE_URL'],['api','PTR_CHAT_PROVIDER'],['api','PTR_API_TOKEN'],['worker','PTR_REDIS_URL'],
    ['dispatcher','DATABASE_URL'],['gateway','PTR_GATEWAY_TOKEN'],['gateway','PTR_GATEWAY_UPSTREAMS_FILE'],['web','PTR_SESSION_SECRET'],['web','PTR_UI_PASSWORD'],
  ] as [EnvRole,string][])('%s: missing %s',(role,key)=>{
    const env={...base()[role]};delete env[key];
    expect(check(role,env).errors).toEqual([{key,rule:'missing'}]);
  });
  test('the dispatcher needs no provider keys, and other roles\' keys are ignored',()=>{
    expect(check('dispatcher',{...base().dispatcher,...base().web,PTR_GATEWAY_UPSTREAMS_FILE:'/missing'})).toEqual({errors:[],warnings:[]});
    expect(check('web',{...base().web,...base().api})).toEqual({errors:[],warnings:[]});
  });
  test('H, I and S names and unprefixed unknown names are ignored',()=>{
    expect(check('api',{...base().api,PTR_LOADTEST_DATABASE_URL:'x',PTR_DB_PASSWORD:'x',PTR_REDIS_PASSWORD:'x',HOME:'/x',SOME_TOOL_SETTING:'x'})).toEqual({errors:[],warnings:[]});
  });
  test('value rules',()=>{
    const {api,worker,gateway,web}=base();
    const cases:[EnvRole,NodeJS.ProcessEnv,{key:string;rule:string}[]][]=[
      ['api',{...api,PTR_CHAT_PROVIDER:'fake'},[{key:'PTR_CHAT_PROVIDER',rule:'production_provider'}]],
      ['api',{...api,PTR_CHAT_PROVIDER:'selfhosted'},[{key:'PTR_CHAT_PROVIDER',rule:'production_provider'}]],
      ['api',{...api,PTR_API_TOKEN:'short'},[{key:'PTR_API_TOKEN',rule:'token_length'}]],
      ['api',{...api,PTR_API_TOKEN:'x'.repeat(513)},[{key:'PTR_API_TOKEN',rule:'token_length'}]],
      ['api',{...api,PTR_GATEWAY_TOKEN:'short'},[{key:'PTR_GATEWAY_TOKEN',rule:'token_length'}]],
      ['api',{...api,DATABASE_URL:'postgresql://u:p@10.0.0.1:5432/ptr_research'},[{key:'DATABASE_URL',rule:'database_url_guard'}]],
      ['api',{...api,PTR_REDIS_URL:'redis://127.0.0.1:6379/0'},[{key:'PTR_REDIS_URL',rule:'redis_url_guard'}]],
      ['api',{...api,PTR_PERSONAS_FILE:join(dir,'missing.json')},[{key:'PTR_PERSONAS_FILE',rule:'file_missing'}]],
      ['api',{...api,PTR_AUTHORED_PERSONAS_FILE:join(dir,'missing.json')},[{key:'PTR_AUTHORED_PERSONAS_FILE',rule:'file_missing'}]],
      ['api',{...api,PTR_PERSONAS_FILE:''},[{key:'PTR_PERSONAS_FILE',rule:'file_missing'}]],
      ['api',{...api,PTR_PERSONAS_FILE:dir},[{key:'PTR_PERSONAS_FILE',rule:'file_missing'}]],
      ['api',{...api,PTR_INTENT_CLASSIFIER:'llm'},[{key:'PTR_INTENT_CLASSIFIER',rule:'invalid_value'}]],
      ['api',{...api,PTR_SAFETY_FILTER:'on'},[{key:'PTR_SAFETY_FILTER',rule:'invalid_value'}]],
      ['api',{...api,PTR_MODEL:'vendor/not-allowlisted'},[{key:'PTR_MODEL',rule:'model_allowlist'}]],
      ['worker',{...worker,PTR_WORKER_CONCURRENCY:'0'},[{key:'PTR_WORKER_CONCURRENCY',rule:'invalid_value'}]],
      ['worker',{...worker,PTR_WORKER_CONCURRENCY:'1025'},[{key:'PTR_WORKER_CONCURRENCY',rule:'invalid_value'}]],
      ['gateway',{...gateway,PTR_GATEWAY_FAILOVER:'fake'},[{key:'PTR_GATEWAY_FAILOVER',rule:'invalid_value'}]],
      ['gateway',{...gateway,PTR_GATEWAY_UPSTREAMS_FILE:join(dir,'missing.json')},[{key:'PTR_GATEWAY_UPSTREAMS_FILE',rule:'file_missing'}]],
      ['gateway',{...gateway,PTR_GATEWAY_UPSTREAMS_FILE:twoPools},[{key:'PTR_GATEWAY_UPSTREAMS_FILE',rule:'upstreams_pool_count'}]],
      ['gateway',{...gateway,PTR_GATEWAY_UPSTREAMS_FILE:personas},[{key:'PTR_GATEWAY_UPSTREAMS_FILE',rule:'upstreams_file_invalid'}]],
      ['web',{...web,PTR_SESSION_SECRET:'x'.repeat(31)},[{key:'PTR_SESSION_SECRET',rule:'secret_length'}]],
      ['web',{...web,PTR_UI_PASSWORD:''},[{key:'PTR_UI_PASSWORD',rule:'missing'}]],
    ];
    for(const [role,env,errors] of cases) expect([role,check(role,env).errors]).toEqual([role,errors]);
  });
  test('cross rules: openrouter needs PTR_MODEL and the live trio; Jev and OpenRouter failover need the trio',()=>{
    const {api,gateway}=base();
    const openrouter={...api,PTR_CHAT_PROVIDER:'openrouter'};
    expect(check('api',openrouter).errors).toEqual([{key:'PTR_MODEL',rule:'missing'},
      {key:'GOAL1_LIVE_ENABLED',rule:'live_trio'},{key:'GOAL1_ALLOW_EXTERNAL_DATA',rule:'live_trio'},{key:'OPENROUTER_API_KEY',rule:'live_trio'}]);
    expect(check('api',{...openrouter,...live,PTR_MODEL:'google/gemma-4-26b-a4b-it'}).errors).toEqual([]);
    expect(check('api',{...openrouter,...live,GOAL1_LIVE_ENABLED:'false',PTR_MODEL:'google/gemma-4-26b-a4b-it'}).errors).toEqual([{key:'GOAL1_LIVE_ENABLED',rule:'live_trio'}]);
    expect(check('api',{...api,PTR_INTENT_CLASSIFIER:'jev',...live,OPENROUTER_API_KEY:' '}).errors).toEqual([{key:'OPENROUTER_API_KEY',rule:'live_trio'}]);
    expect(check('api',{...api,PTR_SAFETY_FILTER:'jev',...live}).errors).toEqual([]);
    // The gateway provider needs the gateway token; OpenRouter does not.
    const noToken={...api};delete noToken.PTR_GATEWAY_TOKEN;
    expect(check('api',noToken).errors).toEqual([{key:'PTR_GATEWAY_TOKEN',rule:'missing'}]);
    expect(check('api',{...noToken,PTR_CHAT_PROVIDER:'openrouter',PTR_MODEL:'google/gemma-4-26b-a4b-it',...live}).errors).toEqual([]);
    expect(check('gateway',{...gateway,PTR_GATEWAY_FAILOVER:'openrouter'}).errors).toEqual([{key:'DATABASE_URL',rule:'missing'},
      {key:'GOAL1_LIVE_ENABLED',rule:'live_trio'},{key:'GOAL1_ALLOW_EXTERNAL_DATA',rule:'live_trio'},{key:'OPENROUTER_API_KEY',rule:'live_trio'}]);
    expect(check('gateway',{...gateway,PTR_GATEWAY_FAILOVER:'openrouter',DATABASE_URL:DB,...live}).errors).toEqual([]);
  });
});

describe('environment-wide rules ( steps 1, 3–5)',()=>{
  test('unknown PTR_/GOAL1_ names fail in every role',()=>{
    for(const role of ['api','dispatcher','web'] as EnvRole[])
      expect(check(role,{...base()[role],[unknownKey]:'1',[unknownGoal1Key]:'1'}).errors).toEqual([{key:unknownKey,rule:'unknown_key'},{key:unknownGoal1Key,rule:'unknown_key'}]);
  });
  test('demo keys fail unless PTR_DEMO_SCALING=1, which also lifts the production value rules',()=>{
    expect(check('gateway',{...base().gateway,PTR_GATEWAY_ROUTING:'scored'}).errors).toEqual([{key:'PTR_GATEWAY_ROUTING',rule:'demo_key'}]);
    expect(check('dispatcher',{...base().dispatcher,PTR_LEASE_MS:'5000'}).errors).toEqual([{key:'PTR_LEASE_MS',rule:'demo_key'}]);
    expect(check('gateway',{PTR_DEMO_SCALING:'1',PTR_GATEWAY_ROUTING:'scored',PTR_GATEWAY_UPSTREAM:'fake'})).toEqual({errors:[],warnings:[]});
    expect(check('api',{PTR_DEMO_SCALING:'1',PTR_CHAT_PROVIDER:'fake',PTR_FAKE_LATENCY:'{}'})).toEqual({errors:[],warnings:[]});
    // Even in demo mode, api and worker name their provider: no silent fallback to the fake model.
    for(const role of ['api','worker'] as EnvRole[]) expect(check(role,{PTR_DEMO_SCALING:'1'}).errors).toEqual([{key:'PTR_CHAT_PROVIDER',rule:'missing'}]);
    expect(check('dispatcher',{PTR_DEMO_SCALING:'1'}).errors).toEqual([]);
    expect(checkRole('api',{PTR_DEMO_SCALING:'1',PTR_CHAT_PROVIDER:'fake'}).demo).toBe(true);
    expect(check('api',{...base().api,PTR_DEMO_SCALING:'0'})).toEqual({errors:[],warnings:[]});
    expect(check('api',{...base().api,PTR_DEMO_SCALING:'yes'}).errors).toEqual([{key:'PTR_DEMO_SCALING',rule:'invalid_value'}]);
  });
  test('R rules: removed fails, PTR_API_URL warns when it is the constant, example-file keys warn',()=>{
    const {api}=base();
    expect(check('api',{...api,PTR_EXECUTION:'queue'}).errors).toEqual([{key:'PTR_EXECUTION',rule:'removed_key'}]);
    expect(check('api',{...api,PTR_API_URL:'http://127.0.0.1:56441'})).toEqual({errors:[],warnings:[{key:'PTR_API_URL',rule:'constant_ignored'}]});
    expect(check('api',{...api,PTR_API_URL:'http://127.0.0.1:56449'}).errors).toEqual([{key:'PTR_API_URL',rule:'api_url_constant'}]);
    expect(check('api',{...api,GOAL1_BUDGET_USD:'1',PTR_EMBEDDING_MODEL:'m',REPLICATE_API_TOKEN:'t',INSTAGRAM_DATASET_FOLDER_URL:'u'}))
      .toEqual({errors:[],warnings:['GOAL1_BUDGET_USD','PTR_EMBEDDING_MODEL','REPLICATE_API_TOKEN','INSTAGRAM_DATASET_FOLDER_URL'].map(key=>({key,rule:'unused_key'}))});
    // Same rules under the demo switch: removed keys never come back.
    expect(check('api',{PTR_DEMO_SCALING:'1',PTR_CHAT_PROVIDER:'fake',PTR_EXECUTION:'inline'}).errors).toEqual([{key:'PTR_EXECUTION',rule:'removed_key'}]);
  });
  test('aliases warn and satisfy the new name; a different value under both names fails',()=>{
    const api={...base().api};delete api.DATABASE_URL;
    expect(check('api',{...api,GOAL1_DATABASE_URL:DB})).toEqual({errors:[],warnings:[{key:'GOAL1_DATABASE_URL',rule:'renamed_key'}]});
    expect(check('api',{...api,GOAL1_DATABASE_URL:DB,DATABASE_URL:DB}).warnings).toEqual([{key:'GOAL1_DATABASE_URL',rule:'renamed_key'}]);
    expect(check('api',{...api,GOAL1_DATABASE_URL:DB,DATABASE_URL:DB.replace('synthetic-password','other-password')}).errors).toEqual([{key:'GOAL1_DATABASE_URL',rule:'alias_conflict'}]);
    const openrouter={...base().api,PTR_CHAT_PROVIDER:'openrouter',...live};
    expect(check('api',{...openrouter,TEXT_MODEL:'google/gemma-4-26b-a4b-it'})).toEqual({errors:[],warnings:[{key:'TEXT_MODEL',rule:'renamed_key'}]});
    expect(check('api',{...openrouter,GOAL1_TEXT_MODEL:'vendor/not-allowlisted'}).errors).toEqual([{key:'PTR_MODEL',rule:'model_allowlist'}]);
    expect(check('api',{...openrouter,PTR_MODEL:'google/gemma-4-26b-a4b-it',TEXT_MODEL:'openai/gpt-4.1-nano'}).errors).toEqual([{key:'TEXT_MODEL',rule:'alias_conflict'}]);
  });
});

describe('loadConfig output',()=>{
  test('lists every problem in one JSON line without values, then throws',()=>{
    const sentinel='SENTINEL-secret-value-0123456789';
    const lines:string[]=[];
    const env={...base().api,DATABASE_URL:`postgresql://u:${sentinel}@10.0.0.1:5432/x`,PTR_API_TOKEN:sentinel.slice(0,10),PTR_API_URL:`http://${sentinel}`,
      [unknownKey]:sentinel,GOAL1_BUDGET_USD:sentinel};
    expect(()=>loadConfig('api',env,line=>lines.push(line))).toThrow(ConfigError);
    expect(lines.join('')).not.toContain(sentinel);expect(lines.join('')).not.toContain('10.0.0.1');
    const invalid=JSON.parse(lines.find(line=>line.includes('config_invalid'))!);
    expect(invalid).toEqual({event:'config_invalid',role:'api',problems:[{key:unknownKey,rule:'unknown_key'},{key:'PTR_API_URL',rule:'api_url_constant'},
      {key:'DATABASE_URL',rule:'database_url_guard'},{key:'PTR_API_TOKEN',rule:'token_length'}]});
    expect(JSON.parse(lines.find(line=>line.includes('config_warning'))!)).toEqual({event:'config_warning',role:'api',problems:[{key:'GOAL1_BUDGET_USD',rule:'unused_key'}]});
  });
  test('the model allowlist is the client\'s: allowlisted ids pass, others fail',()=>{
    for(const model of ['google/gemma-4-26b-a4b-it','google/gemini-3-flash-preview']) expect(check('api',{...base().api,PTR_MODEL:model}).errors).toEqual([]);
    expect(check('api',{...base().api,PTR_MODEL:'google/gemma-4-26b-a4b-it:free'}).errors).toEqual([{key:'PTR_MODEL',rule:'model_allowlist'}]);
  });
  test('a valid profile returns the report; the gateway gets its single pool name',()=>{
    const lines:string[]=[];
    expect(loadConfig('api',base().api,line=>lines.push(line))).toMatchObject({role:'api',demo:false,errors:[],warnings:[]});
    expect(loadConfig('gateway',base().gateway,line=>lines.push(line)).pool).toBe('synthetic-model');
    expect(loadConfig('gateway',{PTR_DEMO_SCALING:'1'},line=>lines.push(line)).pool).toBeUndefined();
    expect(lines).toEqual([]);
  });
});
