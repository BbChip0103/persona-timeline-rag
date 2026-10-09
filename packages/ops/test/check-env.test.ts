import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheckEnv } from '../scripts/check-env';

// Synthetic stand-ins for the 19 key names of the user's .env.local ; values are never read from it.
const SENTINEL='SENTINEL-value-must-not-print-0123456789';
const userKeys=(overrides:Record<string,string>={})=>({
  DATABASE_URL:`postgresql://ptr_researcher:${SENTINEL}@127.0.0.1:56432/ptr_research`,
  GOAL1_ALLOW_EXTERNAL_DATA:'true',GOAL1_BUDGET_USD:SENTINEL,GOAL1_LIVE_ENABLED:'true',OPENROUTER_API_KEY:SENTINEL,
  PTR_API_TOKEN:`${SENTINEL}-api-token`,PTR_API_URL:'http://127.0.0.1:56441',PTR_CHAT_PROVIDER:'openrouter',PTR_DB_PASSWORD:SENTINEL,
  PTR_EMBEDDING_MODEL:SENTINEL,PTR_LOADTEST_DATABASE_URL:SENTINEL,PTR_LOADTEST_DB_PASSWORD:SENTINEL,PTR_MODEL:'google/gemma-4-26b-a4b-it',
  PTR_PERSONAS_FILE:'personas.json',PTR_REDIS_PASSWORD:SENTINEL,PTR_REDIS_URL:`redis://:${SENTINEL}@127.0.0.1:56479/0`,
  PTR_SESSION_SECRET:`${SENTINEL}-session-secret`,PTR_UI_PASSWORD:SENTINEL,REPLICATE_API_TOKEN:SENTINEL,...overrides});
let dir:string;
beforeAll(()=>{dir=mkdtempSync(join(tmpdir(),'ptr-check-env-'));writeFileSync(join(dir,'personas.json'),'[]');});
afterAll(()=>rmSync(dir,{recursive:true,force:true}));
function run(env:Record<string,string>,args:string[]=[]):{code:number;lines:string[]} {
  writeFileSync(join(dir,'.env.local'),Object.entries(env).map(([key,value])=>`${key}=${value}`).join('\n')+'\n');
  const lines:string[]=[];
  const code=runCheckEnv(args,{cwd:dir,write:line=>lines.push(line)});
  expect(lines.join('\n')).not.toContain(SENTINEL);
  return {code,lines};
}
// File order (the synthetic file lists the names alphabetically).
const WARNINGS=['warning all unused_key GOAL1_BUDGET_USD','warning all constant_ignored PTR_API_URL','warning all unused_key PTR_EMBEDDING_MODEL',
  'warning all unused_key REPLICATE_API_TOKEN'];

test('the user\'s key set: no errors, the four documented warnings ',()=>{
  const {code,lines}=run(userKeys());
  expect(lines).toEqual(['roles api,worker,dispatcher,web (demo off)',...WARNINGS,'errors 0 warnings 4']);
  expect(code).toBe(0);
  expect(userKeys()).toHaveProperty('PTR_CHAT_PROVIDER');expect(Object.keys(userKeys())).toHaveLength(19);
});
test('PTR_CHAT_PROVIDER=gateway adds the gateway role and its missing keys, one line per role',()=>{
  const {code,lines}=run(userKeys({PTR_CHAT_PROVIDER:'gateway'}));
  expect(lines).toEqual(['roles api,worker,dispatcher,web,gateway (demo off)',...WARNINGS,'error api missing PTR_GATEWAY_TOKEN',
    'error worker missing PTR_GATEWAY_TOKEN','error gateway missing PTR_GATEWAY_TOKEN','error gateway missing PTR_GATEWAY_UPSTREAMS_FILE','errors 4 warnings 4']);
  expect(code).toBe(1);
});
test('--roles names the roles (gateway regardless of the provider); --role is accepted too',()=>{
  const gateway=run(userKeys(),['--roles','gateway']);
  expect(gateway.lines).toEqual(['roles gateway (demo off)',...WARNINGS,'error gateway missing PTR_GATEWAY_TOKEN','error gateway missing PTR_GATEWAY_UPSTREAMS_FILE','errors 2 warnings 4']);
  expect(run(userKeys(),['--role','web']).lines[0]).toBe('roles web (demo off)');
  expect(run(userKeys(),['--roles','api,nope']).code).toBe(2);
  expect(run(userKeys(),['--roles',' , ']).code).toBe(2);
});
test('value rules print rule ids only; absolute persona paths are flagged for Compose',()=>{
  const {code,lines}=run(userKeys({PTR_CHAT_PROVIDER:'fake',PTR_PERSONAS_FILE:join(dir,'personas.json'),PTR_API_URL:`http://${SENTINEL}`}));
  expect(lines).toEqual(['roles api,worker,dispatcher,web (demo off)','warning all unused_key GOAL1_BUDGET_USD','warning all unused_key PTR_EMBEDDING_MODEL',
    'warning all unused_key REPLICATE_API_TOKEN','warning all path_not_repo_relative PTR_PERSONAS_FILE','error all api_url_constant PTR_API_URL',
    'error api production_provider PTR_CHAT_PROVIDER','error worker production_provider PTR_CHAT_PROVIDER','errors 3 warnings 4']);
  expect(code).toBe(1);
});
test('a missing file is a usage error, named by its path only',()=>{
  const lines:string[]=[];
  expect(runCheckEnv(['--file','missing.env'],{cwd:dir,write:line=>lines.push(line)})).toBe(2);
  expect(lines).toEqual(['env file not found: missing.env']);
});
