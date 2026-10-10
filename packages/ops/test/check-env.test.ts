import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCheckEnv } from '../scripts/check-env';

const SENTINEL='SENTINEL-value-must-not-print-0123456789';
const valid=()=>({DATABASE_URL:`postgresql://ptr_framework_tester:${SENTINEL}@127.0.0.1:57432/ptr_framework_test`,
  PTR_REDIS_URL:`redis://:${SENTINEL}@127.0.0.1:57479/0`,PTR_CHAT_PROVIDER:'fake',PTR_API_TOKEN:SENTINEL,
  PTR_PERSONAS_FILE:'synthetic-personas.json',PTR_GUARDRAILS_URL:'http://127.0.0.1:58000',PTR_GUARDRAILS_TOKEN:SENTINEL,
  PTR_SESSION_SECRET:SENTINEL,PTR_UI_PASSWORD:SENTINEL});
let dir:string;
beforeAll(()=>{dir=mkdtempSync(join(tmpdir(),'ptr-check-framework-env-'));});
afterAll(()=>rmSync(dir,{recursive:true,force:true}));
function run(env:NodeJS.ProcessEnv=valid(),args:string[]=['--file','synthetic.env']) {
  writeFileSync(join(dir,'synthetic.env'),Object.entries(env).filter(([,value])=>value!==undefined).map(([key,value])=>`${key}=${value}`).join('\n')+'\n');
  const lines:string[]=[];const code=runCheckEnv(args,{cwd:dir,write:line=>lines.push(line)});
  expect(lines.join('\n')).not.toContain(SENTINEL);return {code,lines};
}
test('defaults validate only API, worker and web with the new framework contract',()=>{
  expect(run()).toEqual({code:0,lines:['roles api,worker,web','errors 0 warnings 0']});
});
test('never auto-reads .env.local, even when a valid file exists',()=>{
  writeFileSync(join(dir,'.env.local'),'PTR_API_TOKEN=PRIVATE_SENTINEL\n');
  expect(run(valid(),[])).toEqual({code:2,lines:['usage explicit_file_required']});
});
test('--roles/--role replace defaults; removed roles and missing arguments are usage errors',()=>{
  expect(run(valid(),['--file','synthetic.env','--role','web']).lines[0]).toBe('roles web');
  expect(run(valid(),['--file','synthetic.env','--roles','worker,api,worker']).lines[0]).toBe('roles worker,api');
  for(const args of [['--file','synthetic.env','--roles','gateway'],['--file','synthetic.env','--roles','dispatcher'],
    ['--file','synthetic.env','--roles',' , '],['--file','--roles','api'],['--file','synthetic.env','--unknown']])expect(run(valid(),args).code).toBe(2);
});
test('validation errors are framework codes, never values, and do not open connections',()=>{
  const {code,lines}=run({...valid(),PTR_CHAT_PROVIDER:'gateway'});
  expect(code).toBe(1);expect(lines).toContain('error api invalid_enum_value PTR_CHAT_PROVIDER');
  expect(lines).toContain('error worker invalid_enum_value PTR_CHAT_PROVIDER');
});
test('absolute persona paths are warnings without opening persona data or printing paths',()=>{
  const {code,lines}=run({...valid(),PTR_PERSONAS_FILE:join(dir,'private-sentinel.json')});
  expect(code).toBe(0);expect(lines).toContain('warning all path_not_repo_relative PTR_PERSONAS_FILE');
  expect(lines.join('\n')).not.toContain('private-sentinel.json');
});
test('missing and malformed explicit files produce only sanitized usage codes',()=>{
  const lines:string[]=[];
  expect(runCheckEnv(['--file',`missing-${SENTINEL}.env`],{cwd:dir,write:line=>lines.push(line)})).toBe(2);
  expect(lines).toEqual(['usage env_file_unreadable']);
});
test('file environment is isolated from process.env and cannot silently inherit credentials',()=>{
  const saved=process.env.PTR_API_TOKEN;process.env.PTR_API_TOKEN=SENTINEL;
  try {const {code,lines}=run({...valid(),PTR_API_TOKEN:undefined});expect(code).toBe(1);expect(lines.some(line=>line.endsWith(' PTR_API_TOKEN'))).toBe(true);}
  finally {if(saved===undefined)delete process.env.PTR_API_TOKEN;else process.env.PTR_API_TOKEN=saved;}
});
