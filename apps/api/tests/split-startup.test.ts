import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createSplitRuntime} from '../src/split-runtime';
import {PostgresCreativeArtifactStore} from '../../../packages/storage/src/creative-artifacts';
import type {CreativeArtifact} from '../src/creative-artifact';

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
describe('split runtime cluster guard',()=>{
  const base={PTR_NETWORK_MODE:'cluster',KUBERNETES_SERVICE_HOST:'10.0.0.1',PTR_BACKEND_MAINTENANCE:'0',
    PTR_APP_DATABASE_URL:'postgresql://ptr_cluster_app:synthetic-password@postgres.example.internal:5432/ptr_cluster_research?sslmode=require',
    PTR_REDIS_URL:'rediss://:synthetic-password@redis.example.internal:6380/0',
    PTR_LLM_SERVICE_URL:'http://ptr-llm.default.svc.cluster.local:58442',
    PTR_LLM_CONTROL_TOKEN:'synthetic-control-token-1234567890',
    PTR_CLUSTER_DATABASE_URL_ALLOWLIST:'postgresql://postgres.example.internal:5432',
    PTR_CLUSTER_DATABASE_IDENTITIES:'ptr_cluster_research:ptr_cluster_app',
    PTR_CLUSTER_REDIS_URL_ALLOWLIST:'rediss://redis.example.internal:6380',
    PTR_CLUSTER_HTTP_URL_ALLOWLIST:'http://ptr-llm.default.svc.cluster.local:58442'};
  const withClusterEnv=async(override:Record<string,string|undefined>,work:()=>Promise<void>|void)=>{
    const keys=Object.keys({...base,...override}),previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
    try {
      for(const [key,value] of Object.entries({...base,...override})) {
        if(value===undefined) delete process.env[key]; else process.env[key]=value;
      }
      await work();
    } finally {
      for(const key of keys) {
        const value=previous[key]; if(value===undefined) delete process.env[key]; else process.env[key]=value;
      }
    }
  };
  test('accepts configured cluster database, Redis, and internal HTTP service targets',async()=>{
    await withClusterEnv({},async()=>{
      const runtime=createSplitRuntime();
      expect(runtime.providerName).toBe('fake');
      await runtime.close();
    });
  });
  test.each([
    ['HTTP','http://ptr-llm.default.svc.cluster.local','http://ptr-llm.default.svc.cluster.local:80'],
    ['HTTPS','https://ptr-llm.default.svc.cluster.local','https://ptr-llm.default.svc.cluster.local:443'],
  ])('matches default %s ports after URL normalization',async(_label,serviceUrl,allowlist)=>{
    await withClusterEnv({PTR_LLM_SERVICE_URL:serviceUrl,PTR_CLUSTER_HTTP_URL_ALLOWLIST:allowlist},async()=>{
      const runtime=createSplitRuntime();
      await runtime.close();
    });
  });
  test.each([
    ['outside Kubernetes',{KUBERNETES_SERVICE_HOST:''}],
    ['unlisted service host',{PTR_LLM_SERVICE_URL:'http://ptr-llm.other.svc.cluster.local:58442'}],
    ['service credentials',{PTR_LLM_SERVICE_URL:'http://user@ptr-llm.default.svc.cluster.local:58442'}],
    ['plain HTTP outside service DNS',{PTR_LLM_SERVICE_URL:'http://worker.example.com:58442',PTR_CLUSTER_HTTP_URL_ALLOWLIST:'http://worker.example.com:58442'}],
    ['database identity not configured',{PTR_CLUSTER_DATABASE_IDENTITIES:'ptr_split_test:ptr_split_app'}],
  ])('rejects %s before connecting',async(_label,override)=>withClusterEnv(override,()=>expect(()=>createSplitRuntime()).toThrow()));
});

test('split runtime routes generated artifacts to the Postgres store',async()=>{
  const artifact={id:'synthetic-artifact',ownerId:'owner_synthetic_a',sessionId:'synthetic-session'} as CreativeArtifact;
  const save=jest.spyOn(PostgresCreativeArtifactStore.prototype,'save').mockResolvedValue();
  const get=jest.spyOn(PostgresCreativeArtifactStore.prototype,'get').mockResolvedValue(artifact);
  const runtime=createSplitRuntime({PTR_APP_DATABASE_URL:'postgresql://ptr_split_app:synthetic@127.0.0.1:58432/ptr_split_test',
    PTR_REDIS_URL:'redis://:synthetic@127.0.0.1:58479/0',PTR_LLM_CONTROL_TOKEN:'synthetic-control-token-1234567890',
    PTR_BACKEND_MAINTENANCE:'0'});
  try {
    await runtime.saveArtifact(artifact);
    expect(save).toHaveBeenCalledWith(artifact);
    await expect(runtime.loadArtifact(artifact.ownerId,artifact.id)).resolves.toBe(artifact);
    expect(get).toHaveBeenCalledWith(artifact.ownerId,artifact.id);
  } finally {await runtime.close();save.mockRestore();get.mockRestore();}
});

test('generated artifact migration stays in app schema with private grants and no source table',()=>{
  const migration=readFileSync(join(root,'supabase/split/0005_generated_artifacts.sql'),'utf8');
  expect(migration).toContain('CREATE TABLE IF NOT EXISTS app.generated_artifacts');
  expect(migration).toContain('CREATE INDEX IF NOT EXISTS generated_artifacts_owner_created');
  expect(migration).toContain('REFERENCES app.sessions(id) ON DELETE CASCADE');
  expect(migration).toContain('GRANT SELECT,INSERT ON app.generated_artifacts TO ptr_split_app');
  expect(migration).toContain('REVOKE UPDATE,DELETE ON app.generated_artifacts FROM ptr_split_app');
  expect(migration).not.toContain('llm.source_posts');
});
