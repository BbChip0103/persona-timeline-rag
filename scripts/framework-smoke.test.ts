import { randomBytes } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { assertSyntheticTargets, fixtures, frameworkEnvironment, readGeneratedEnv, traceEvidence } from './framework-smoke';
const source={PTR_FRAMEWORK_TEST_DB_PASSWORD:'synthetic-db',PTR_FRAMEWORK_QUEUE_PASSWORD:'synthetic-redis',PTR_LITELLM_PORT:'58001',
  PTR_GUARDRAILS_PORT:'58002',PTR_GUARDRAILS_TOKEN:'synthetic-guardrails-token',LANGFUSE_BASE_URL:'http://127.0.0.1:58003',
  LANGFUSE_PUBLIC_KEY:'synthetic-public',LANGFUSE_SECRET_KEY:'synthetic-secret',OPENROUTER_API_KEY:'DO_NOT_INHERIT',PTR_LITELLM_MASTER_KEY:'DO_NOT_INHERIT',
  GOAL1_LIVE_ENABLED:'true',LANGSMITH_TRACING:'true'};
const key={PTR_LITELLM_API_KEY:'synthetic-constrained-virtual-key'};
test('explicit child environment excludes live/provider/master credentials and forces synthetic modes',()=>{
  const env=frameworkEnvironment(source,key,'/tmp/synthetic-personas.json','fw-smoke-test');
  expect(env.OPENROUTER_API_KEY).toBeUndefined();expect(env.PTR_LITELLM_MASTER_KEY).toBeUndefined();expect(env.GOAL1_LIVE_ENABLED).toBeUndefined();
  expect(env.PTR_CHAT_PROVIDER).toBe('litellm');expect(env.PTR_LITELLM_BILLABLE).toBe('0');expect(env.PTR_SAFETY_FILTER).toBe('off');
  expect(env.LANGSMITH_TRACING).toBe('false');expect(env.PTR_LANGFUSE_CAPTURE_CONTENT).toBe('0');
  expect(env.PTR_API_TOKEN).not.toBe(env.PTR_API_SYNTHETIC_TOKEN);
});
test('strict target guard forbids research/main/shared or unexpected identities before connections',()=>{
  const db='postgresql://ptr_framework_tester:synthetic@127.0.0.1:57432/ptr_framework_test';
  const redis='redis://:synthetic@127.0.0.1:57479/0';
  expect(()=>assertSyntheticTargets(db,redis)).not.toThrow();
  expect(()=>assertSyntheticTargets(db.replace('57432','56432'),redis)).toThrow();
  expect(()=>assertSyntheticTargets(db.replace('ptr_framework_test','ptr_research'),redis)).toThrow();
  expect(()=>assertSyntheticTargets(db,redis.replace('57479','56479'))).toThrow();
  expect(()=>assertSyntheticTargets(db,redis.replace('/0','/1'))).toThrow();
  expect(()=>assertSyntheticTargets('postgresql://ptr_loadtester:synthetic@127.0.0.1:57433/ptr_loadtest','redis://:synthetic@127.0.0.1:57480/0',true)).not.toThrow();
});
test('generated fixture uses only fictional scoped identities and exact quoteable captions',()=>{
  const result=fixtures('abc12345');expect(result.personas).toHaveLength(2);expect(result.posts).toHaveLength(2);
  expect(result.personas.every(p=>p.reviewStatus==='synthetic'&&p.id.startsWith('synthetic-'))).toBe(true);
  expect(result.posts.every(p=>result.personas.some(persona=>persona.personId===p.personId)&&p.sourceUrl.startsWith('https://example.com/')&&p.id.startsWith('synthetic-'))).toBe(true);
  expect(()=>fixtures('../unsafe')).toThrow('INVALID_FIXTURE_RUN');
});
test('reads only mode0600 generated flat env files without evaluating shell syntax',async()=>{
  const path=`/tmp/ptr-fw-unit-${randomBytes(4).toString('hex')}.env`;
  try {await writeFile(path,'# generated synthetic\nPTR_TEST_KEY=synthetic\n',{mode:0o600});
    expect(await readGeneratedEnv(path)).toEqual({PTR_TEST_KEY:'synthetic'});
    await writeFile(path,'export PTR_TEST_KEY=synthetic\n');await expect(readGeneratedEnv(path)).rejects.toThrow('INVALID_GENERATED_ENV');
    await expect(readGeneratedEnv('/tmp/research.env')).rejects.toThrow('GENERATED_ENV_PATH_REQUIRED');
  }finally{await unlink(path);}
});

test('v4 observations reader uses bounded cursor pages, scope guard and no IO fields',async()=>{
  const {pseudonymousId}=await import('@ptr/ops');const session='synthetic-session',hash=pseudonymousId(session);
  const original=global.fetch;const calls:URL[]=[];let page=0;
  global.fetch=jest.fn(async(raw)=>{calls.push(new URL(String(raw)));page++;return new Response(JSON.stringify({data:[{id:`obs-${page}`,traceId:'synthetic-trace',sessionId:hash,name:page===1?'model':'persist'}],meta:page===1?{cursor:'next'}:{}}),{status:200});}) as typeof fetch;
  try {expect(await traceEvidence({LANGFUSE_BASE_URL:'http://127.0.0.1:58003',LANGFUSE_PUBLIC_KEY:'synthetic',LANGFUSE_SECRET_KEY:'synthetic'},[session],'2026-10-10T00:00:00Z')).toEqual({count:1,observations:2,stageNames:['model','persist'],stageLatencyMs:{}});
    expect(calls.every(url=>url.pathname==='/api/public/v2/observations'&&url.searchParams.get('fields')==='core,basic,metrics'&&url.searchParams.has('fromStartTime')&&url.searchParams.has('toStartTime'))).toBe(true);
    expect(JSON.parse(calls[0]!.searchParams.get('filter')!)).toEqual([{type:'string',column:'sessionId',operator:'=',value:hash}]);
    expect(calls[1]!.searchParams.get('cursor')).toBe('next');
  }finally{global.fetch=original;}
});
