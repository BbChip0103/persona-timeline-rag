import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const root=join(__dirname,'../../..');
test.each(['main.ts','packaged-main.ts'])('%s refuses legacy before constructing connections',entry=>{
  const result=spawnSync(process.execPath,['--import','tsx',`apps/api/src/${entry}`],{
    cwd:root,encoding:'utf8',timeout:10000,
    env:{PATH:process.env.PATH,HOME:process.env.HOME,PTR_LLM_SERVICE_MODE:'legacy'},
  });
  expect(result.status).toBe(1);expect(result.stdout).toBe('');
  expect(result.stderr.trim()).toBe('API_STARTUP_FAILED LEGACY_RUNTIME_NOT_PACKAGED');
});
test.each(['main.ts','packaged-main.ts'])('%s rejects invalid mode and port before missing resources',entry=>{
  for(const [settings,code] of [[{PTR_LLM_SERVICE_MODE:'unexpected'},'INVALID_SERVICE_MODE'],[{PTR_API_PORT:'0'},'INVALID_PORT']] as const){
    const result=spawnSync(process.execPath,['--import','tsx',`apps/api/src/${entry}`],{cwd:root,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:process.env.HOME,...settings}});
    expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(result.stderr.trim()).toBe(`API_STARTUP_FAILED ${code}`);
  }
});
test('active API sources have no historical runtime type or draft execution dependency',()=>{
  for(const file of ['app.ts','main.ts','split-runtime.ts','turn-sse.ts']){
    const source=readFileSync(join(root,'apps/api/src',file),'utf8');
    expect(source).not.toMatch(/from\s+['"]\.\/runtime['"]|import\(['"]\.\/runtime['"]\)|\bApiRuntime\b|\bChatService\b|screenDraftBrief|\.provider\.generate|\.guardrails|\.telemetry/);
  }
});
test('actual backend module imports do not load Node LLM SDKs or the historical composition',()=>{
  const result=spawnSync(process.execPath,['--import','tsx','-e',String.raw`
    require('./apps/api/src/app.ts');require('./apps/api/src/split-runtime.ts');
    const loaded=Object.keys(require.cache);
    const forbidden=loaded.filter(path=>/node_modules\/.*(?:@langchain|@langfuse|langgraph|openai)/.test(path)||/apps\/api\/src\/(?:runtime|worker|queue-worker)\.ts$/.test(path));
    process.stdout.write(JSON.stringify(forbidden));
  `],{cwd:root,encoding:'utf8',timeout:10000,env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  expect(result.status).toBe(0);expect(result.stderr).toBe('');expect(JSON.parse(result.stdout)).toEqual([]);
});
