import { randomBytes, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import { chromium } from '@playwright/test';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { AGENT_PROMPT_REVISION } from '../packages/core/src/agent-runtime';
import type { Persona, SourcePost } from '@ptr/contracts';
import { PostgresPersonaRepository, PostgresSourceRepository } from '@ptr/storage';
import { createLangfuseClient, FrameworkTelemetry, frameworkTelemetryConfig, parseExposition, pseudonymousId } from '@ptr/ops';
import { AppExperimentInputSchema, createHttpAppTask, evaluators, scorePolicy } from './framework-app-experiment';
import { migrateDataset, runFrameworkExperiment } from './framework-evaluate';
import { percentile, sseParser } from './loadtest-lib';

export const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export function demand(condition:unknown,code:string):asserts condition {if(!condition)throw new Error(code);}
export interface CheckpointStorage {
  rows:number;bytes:number;modelRows:number;legacyStageRows:number;rowBytesOnly:true;
  tables:Record<'checkpoints'|'checkpoint_blobs'|'checkpoint_writes',{rows:number;bytes:number}>;
}
/** All three saver tables, scoped by exact turn IDs. Bytes measure complete stored rows, not disk or WAL I/O. */
export async function checkpointStorage(pool:Pool,turnIds:string[]):Promise<CheckpointStorage> {
  const result:CheckpointStorage={rows:0,bytes:0,modelRows:0,legacyStageRows:0,rowBytesOnly:true,
    tables:{checkpoints:{rows:0,bytes:0},checkpoint_blobs:{rows:0,bytes:0},checkpoint_writes:{rows:0,bytes:0}}};
  if(!turnIds.length)return result;
  const pattern='^model:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{64}$';
  const rows=await pool.query(Object.keys(result.tables).map(table=>`SELECT '${table}' AS table_name,count(*)::int AS rows,
    COALESCE(sum(pg_column_size(c)),0)::bigint AS bytes,count(*) FILTER(WHERE c.thread_id ~ '${pattern}')::int AS model_rows,
    count(*) FILTER(WHERE c.thread_id=ANY($1::text[]))::int AS legacy_rows FROM public.${table} c
    WHERE c.thread_id=ANY($1::text[]) OR (c.thread_id ~ '${pattern}' AND split_part(c.thread_id,':',2)=ANY($2::text[]))`).join(' UNION ALL '),
  [turnIds.flatMap(id=>[`turn:${id}`,`character:${id}`]),turnIds]);
  for(const row of rows.rows) {
    const table=row.table_name as keyof CheckpointStorage['tables'];
    const entry={rows:Number(row.rows),bytes:Number(row.bytes)};result.tables[table]=entry;
    result.rows+=entry.rows;result.bytes+=entry.bytes;result.modelRows+=Number(row.model_rows);result.legacyStageRows+=Number(row.legacy_rows);
  }
  return result;
}
/** Only newly generated, private test env files. Never source a shell or read the research .env. */
export async function readGeneratedEnv(path:string):Promise<NodeJS.ProcessEnv> {
  demand(/^\/tmp\/ptr-fw-[A-Za-z0-9_.-]+\.env$/.test(path),'GENERATED_ENV_PATH_REQUIRED');
  const info=await stat(path);demand(info.isFile()&&(info.mode&0o777)===0o600,'PRIVATE_GENERATED_ENV_REQUIRED');
  const env:NodeJS.ProcessEnv={};
  for(const line of (await readFile(path,'utf8')).split('\n')) {
    if(!line.trim()||line.startsWith('#'))continue;
    const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);demand(match,'INVALID_GENERATED_ENV');env[match[1]!]=match[2]!;
  }
  return env;
}
/** Both allowed pairs are NEW synthetic stores; the old research ports are forbidden. */
export function assertSyntheticTargets(databaseUrl:string,redisUrl:string,baseline=false):void {
  const db=new URL(databaseUrl),redis=new URL(redisUrl);
  demand(['postgres:','postgresql:'].includes(db.protocol)&&db.hostname==='127.0.0.1'&&db.password&&!db.search&&!db.hash&&
    db.port===(baseline?'57433':'57432')&&db.pathname===(baseline?'/ptr_loadtest':'/ptr_framework_test')&&
    decodeURIComponent(db.username)===(baseline?'ptr_loadtester':'ptr_framework_tester'),'SYNTHETIC_DATABASE_REQUIRED');
  demand(redis.protocol==='redis:'&&redis.hostname==='127.0.0.1'&&redis.password&&!redis.search&&!redis.hash&&
    redis.port===(baseline?'57480':'57479')&&redis.pathname==='/0','SYNTHETIC_REDIS_REQUIRED');
}
function loopback(raw:string):string {
  const url=new URL(raw);demand(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&!url.search&&!url.hash,'LOCAL_SYNTHETIC_SERVICE_REQUIRED');return raw;
}
export function frameworkEnvironment(source:NodeJS.ProcessEnv,appKey:NodeJS.ProcessEnv,catalogue:string,queue:string):NodeJS.ProcessEnv {
  const password=source.PTR_FRAMEWORK_TEST_DB_PASSWORD,redisPassword=source.PTR_FRAMEWORK_QUEUE_PASSWORD;
  demand(password&&redisPassword&&appKey.PTR_LITELLM_API_KEY,'GENERATED_SERVICE_CREDENTIALS_REQUIRED');
  const databaseUrl=`postgresql://ptr_framework_tester:${encodeURIComponent(password)}@127.0.0.1:57432/ptr_framework_test`;
  const redisUrl=`redis://:${encodeURIComponent(redisPassword)}@127.0.0.1:57479/0`;
  assertSyntheticTargets(databaseUrl,redisUrl);
  demand(source.PTR_LITELLM_PORT&&source.PTR_GUARDRAILS_PORT,'GENERATED_SERVICE_PORTS_REQUIRED');
  demand(source.LANGFUSE_BASE_URL&&source.LANGFUSE_PUBLIC_KEY&&source.LANGFUSE_SECRET_KEY,'GENERATED_LANGFUSE_REQUIRED');
  return {PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',PTR_LLM_SERVICE_MODE:'legacy',LANGSMITH_TRACING:'false',LANGCHAIN_TRACING_V2:'false',
    DATABASE_URL:databaseUrl,PTR_REDIS_URL:redisUrl,PTR_CHAT_PROVIDER:'litellm',PTR_MODEL:'primary',PTR_LITELLM_BILLABLE:'0',
    PTR_LITELLM_BASE_URL:loopback(`http://127.0.0.1:${source.PTR_LITELLM_PORT}/v1`),PTR_LITELLM_API_KEY:appKey.PTR_LITELLM_API_KEY,
    PTR_GUARDRAILS_URL:loopback(`http://127.0.0.1:${source.PTR_GUARDRAILS_PORT}`),PTR_GUARDRAILS_TOKEN:source.PTR_GUARDRAILS_TOKEN,
    PTR_GUARDRAILS_TIMEOUT_MS:'1000',PTR_LANGFUSE_ENABLED:'1',PTR_LANGFUSE_LOCAL:'1',PTR_LANGFUSE_CAPTURE_CONTENT:'0',
    LANGFUSE_BASE_URL:loopback(source.LANGFUSE_BASE_URL),LANGFUSE_PUBLIC_KEY:source.LANGFUSE_PUBLIC_KEY,LANGFUSE_SECRET_KEY:source.LANGFUSE_SECRET_KEY,
    PTR_ENVIRONMENT:'test',PTR_API_TOKEN:randomBytes(24).toString('hex'),PTR_API_SYNTHETIC_TOKEN:randomBytes(24).toString('hex'),
    PTR_PERSONAS_FILE:catalogue,PTR_TURN_QUEUE:queue,PTR_EVENTS_NAMESPACE:queue,PTR_QUEUE_MAX_DEPTH:'64',PTR_DB_POOL_MAX:'8',
    PTR_WORKER_CONCURRENCY:'4',PTR_QUEUE_LOCK_MS:'1000',PTR_MAX_ATTEMPTS:'3',PTR_DISPATCH_GRACE_MS:'200',PTR_DISPATCH_INTERVAL_MS:'100',
    PTR_METRICS_PORT:'0',PTR_INTENT_CLASSIFIER:'off',PTR_SAFETY_FILTER:'off'};
}
export function fixtures(run:string):{personas:Persona[];posts:SourcePost[]} {
  demand(/^[a-f0-9]{8}$/.test(run),'INVALID_FIXTURE_RUN');
  const personas=[1,2].map(n=>({id:`synthetic-framework-persona-${run}-${n}`,personId:`synthetic-framework-person-${run}-${n}`,
    label:`Synthetic Framework ${n}`,language:'ko',revision:'synthetic-v1',reviewStatus:'synthetic' as const,
    identity:'A fictional synthetic test character, not a real person.',concept:'Synthetic framework regression',
    style:['brief polite Korean'],boundaries:['No private biography'],sourceRefs:[],greeting:'안녕하세요. 합성 캐릭터입니다.'}));
  const posts=personas.map((p,n)=>({id:`synthetic-framework-source-${run}-${n}`,personId:p.personId,
    caption:`합성 파란책 기록 ${n}: 가상의 파란 책을 읽었어요.`,postedAt:'2024-03-05T09:00:00Z',eventDate:null,
    sourceUrl:`https://example.com/synthetic/${run}/${n}`,hash:`synthetic-hash-${run}-${n}`,snapshot:'synthetic-v1',unsafe:false}));
  return {personas,posts};
}
export async function migrateAndSeed(root:string,env:NodeJS.ProcessEnv,data:ReturnType<typeof fixtures>,baseline=false):Promise<void> {
  assertSyntheticTargets(env.DATABASE_URL??'',env.PTR_REDIS_URL??'',baseline);
  const pool=new Pool({connectionString:env.DATABASE_URL,max:2,connectionTimeoutMillis:3000});
  try {
    const identity=(await pool.query('SELECT current_database() AS db,current_user AS usr')).rows[0];
    demand(identity.db===(baseline?'ptr_loadtest':'ptr_framework_test')&&identity.usr===(baseline?'ptr_loadtester':'ptr_framework_tester'),'SYNTHETIC_IDENTITY_MISMATCH');
    const migrations=join(root,'supabase/migrations');
    for(const name of (await readdir(migrations)).filter(n=>/^\d+.*\.sql$/.test(n)).sort()) {
      const exists=(await pool.query("SELECT to_regclass('public.ptr_schema_migrations') AS name")).rows[0].name;
      if(exists&&(await pool.query('SELECT 1 FROM ptr_schema_migrations WHERE name=$1',[name])).rowCount)continue;
      await pool.query(await readFile(join(migrations,name),'utf8'));
    }
    if(!baseline)await new PostgresSaver(pool).setup();
    await new PostgresPersonaRepository(pool).importPersonas(data.personas);
    await new PostgresSourceRepository(pool).importPosts(data.posts,'synthetic_fixture');
    await writeFile(env.PTR_PERSONAS_FILE!,JSON.stringify(data.personas),{mode:0o600});
  } finally {await pool.end();}
}
export async function freePort(preferred?:number):Promise<number> {
  const server=createServer();
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(preferred??0,'127.0.0.1',resolve);});
  const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;
}
export async function waitFor(check:()=>Promise<boolean>,ms=30000,code='READINESS_TIMEOUT'):Promise<void> {
  const until=Date.now()+ms;do {try {if(await check())return;}catch {/* bounded readiness retry, not a model retry */}await sleep(100);}while(Date.now()<until);throw new Error(code);
}
export class FrameworkFleet {
  readonly children:ChildProcess[]=[];apiBase='';worker?:ChildProcess;workerMetricsBase='';webBase='';
  constructor(readonly root:string,readonly env:NodeJS.ProcessEnv,readonly directory:string,readonly baseline=false) {}
  launch(script:string,extra:NodeJS.ProcessEnv={},cwd=this.root,args:string[]=[]):ChildProcess {
    const fd=openSync(join(this.directory,`process-${this.children.length}.log`),'a',0o600);
    const child=spawn(process.execPath,script.endsWith('.ts')?['--import','tsx',script,...args]:[script,...args],{cwd,env:{...this.env,...extra},stdio:['ignore',fd,fd]});
    closeSync(fd);this.children.push(child);return child;
  }
  async startApi(web=false):Promise<void> {
    const port=await freePort(web?56449:undefined);this.apiBase=`http://127.0.0.1:${port}`;
    const child=this.launch('apps/api/src/main.ts',{PTR_API_PORT:String(port)});
    await waitFor(async()=>{demand(child.exitCode===null,'API_PROCESS_EXITED');return (await fetch(`${this.apiBase}/api/health`,{signal:AbortSignal.timeout(2000)})).status===200;});
  }
  async startWorker(extra:NodeJS.ProcessEnv={}):Promise<ChildProcess> {
    const port=await freePort();this.workerMetricsBase=`http://127.0.0.1:${port}`;
    this.worker=this.launch('apps/api/src/worker.ts',{PTR_METRICS_PORT:String(port),PTR_WORKER_ID:`synthetic-${randomUUID().slice(0,8)}`,...extra});
    await waitFor(async()=>{demand(this.worker!.exitCode===null,'WORKER_PROCESS_EXITED');return (await fetch(`${this.workerMetricsBase}/healthz`,{signal:AbortSignal.timeout(2000)})).status===200;});
    return this.worker;
  }
  async startWeb():Promise<void> {
    await freePort(56448);this.webBase='http://127.0.0.1:56448';
    const child=this.launch(join(this.root,'apps/web/node_modules/next/dist/bin/next'),{NODE_ENV:'development',PTR_SYNTHETIC_UI:'1',
      PTR_SESSION_SECRET:randomBytes(32).toString('hex'),PTR_UI_PASSWORD:'synthetic-password-framework'},join(this.root,'apps/web'),['dev','--hostname','127.0.0.1','--port','56448']);
    await waitFor(async()=>{demand(child.exitCode===null,'WEB_PROCESS_EXITED');return (await fetch(this.webBase,{signal:AbortSignal.timeout(5000)})).status===200;},120000,'WEB_READINESS_TIMEOUT');
  }
  async stop(child:ChildProcess):Promise<void> {
    if(child.exitCode!==null||child.signalCode!==null)return;
    child.kill('SIGCONT');child.kill('SIGTERM');
    await Promise.race([new Promise<void>(resolve=>child.once('exit',()=>resolve())),sleep(5000)]);
    if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await new Promise<void>(resolve=>child.once('exit',()=>resolve()));}
  }
  async close():Promise<void> {for(const child of [...this.children].reverse())await this.stop(child);}
}
export interface PublicTurn {id:string;state:string;errorCode?:string;reply?:{status:string;content:string;evidence:Array<{sourceId:string;personId:string;quote:string}>;limitations:string[]}}
export async function apiRequest(fleet:FrameworkFleet,path:string,body?:unknown,owner='lt-framework',auth=fleet.env.PTR_API_SYNTHETIC_TOKEN):Promise<Response> {
  return fetch(`${fleet.apiBase}/api/${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bearer ${auth}`,'X-PTR-Owner':owner,'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
}
export async function createSession(fleet:FrameworkFleet,personId:string,caption=false):Promise<string> {
  const response=await apiRequest(fleet,'sessions',{personId,retrievalMode:caption?'lexical':'off',ragCondition:caption?'caption':'off',executionProfile:'agent_loop'});
  demand(response.ok,'SESSION_CREATE_FAILED');const result=await response.json() as {session:{id:string}};return result.session.id;
}
export async function sendTurn(fleet:FrameworkFleet,sessionId:string,requestId:string,text='안녕하세요. 가상의 이야기를 나눠요.',caption=false):Promise<PublicTurn> {
  const response=await apiRequest(fleet,`sessions/${sessionId}/turns`,{clientRequestId:requestId,text,...(caption?{intent:'timeline',timeline:{query:'파란책',dateBasis:'posted',limit:3}}:{})});
  demand(response.ok,'TURN_SUBMIT_FAILED');return ((await response.json()) as {turn:PublicTurn}).turn;
}
export async function waitForTurn(fleet:FrameworkFleet,id:string,timeout=30000):Promise<PublicTurn> {
  let result:PublicTurn|undefined;await waitFor(async()=>{
    const response=await apiRequest(fleet,`turns/${id}`);demand(response.ok,'TURN_READ_FAILED');result=((await response.json()) as {turn:PublicTurn}).turn;
    return ['completed','failed','cancelled'].includes(result.state);
  },timeout,'TURN_TERMINAL_TIMEOUT');return result!;
}
export async function engineCounts(source:NodeJS.ProcessEnv):Promise<Record<string,number>> {
  const response=await fetch(loopback(`http://127.0.0.1:${source.PTR_FAKE_ENGINE_PORT}/counts`),{signal:AbortSignal.timeout(3000)});
  demand(response.ok,'ENGINE_COUNTS_UNAVAILABLE');return response.json() as Promise<Record<string,number>>;
}
/** Langfuse v4 events-only has no trace read endpoint. Fetch only bounded safe field groups. */
export async function traceEvidence(env:NodeJS.ProcessEnv,sessionIds:string[],fromStartTime=new Date(Date.now()-300000).toISOString()):Promise<{count:number;observations:number;stageNames:string[];stageLatencyMs:Record<string,{p50:number|null;p95:number|null}>}> {
  const headers={Authorization:`Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString('base64')}`};
  const traces=new Set<string>(),observationIds=new Set<string>(),stageNames=new Set<string>(),latencies:Record<string,number[]>={};
  for(const id of sessionIds) {
    let cursor:string|undefined;
    do {
      const url=new URL('/api/public/v2/observations',env.LANGFUSE_BASE_URL);
      url.search=new URLSearchParams({fields:'core,basic,metrics',limit:'1000',fromStartTime,toStartTime:new Date().toISOString(),
        filter:JSON.stringify([{type:'string',column:'sessionId',operator:'=',value:pseudonymousId(id)}]),...(cursor?{cursor}:{})}).toString();
      const response=await fetch(url,{headers,signal:AbortSignal.timeout(10000)});
      demand(response.ok,'TRACE_READ_FAILED');
      const result=await response.json() as {data:Array<{id:string;traceId:string;sessionId:string;name:string;latency?:number}>;meta:{cursor?:string}};
      for(const item of result.data) {
        demand(item.sessionId===pseudonymousId(id),'TRACE_SCOPE_MISMATCH');
        traces.add(item.traceId);if(!observationIds.has(item.id)&&/^[a-z_-]{1,64}$/.test(item.name)){stageNames.add(item.name);if(Number.isFinite(item.latency))(latencies[item.name]??=[]).push(item.latency!*1000);}observationIds.add(item.id);
      }
      cursor=result.meta.cursor;
    }while(cursor);
  }
  return {count:traces.size,observations:observationIds.size,stageNames:[...stageNames].sort(),stageLatencyMs:Object.fromEntries(Object.entries(latencies).map(([name,values])=>[name,{p50:percentile(values,50),p95:percentile(values,95)}]))};
}
export async function smoke(source:NodeJS.ProcessEnv,appKey:NodeJS.ProcessEnv,web=true):Promise<Record<string,unknown>> {
  const root=resolve('.'),directory=await mkdtemp(join(tmpdir(),'ptr-fw-functional-')),run=randomBytes(4).toString('hex');
  const env=frameworkEnvironment(source,appKey,join(directory,'personas.json'),`fw-smoke-${run}`),data=fixtures(run);
  await migrateAndSeed(root,env,data);const fleet=new FrameworkFleet(root,env,directory),pool=new Pool({connectionString:env.DATABASE_URL,max:2});
  const gates:Record<string,boolean>={},traceStart=new Date().toISOString();
  let experiment:{cases:number;failedScores:number;missingScores:number;taskFailures:number;traceCount:number;modelSubmissions:number}|undefined;
  try {
    await fleet.startApi(web);await fleet.startWorker();
    gates.auth=(await fetch(`${fleet.apiBase}/api/personas`)).status===403;
    const session=await createSession(fleet,data.personas[0]!.personId);const before=await engineCounts(source);
    const turn=await sendTurn(fleet,session,'smoke-hello');
    const stream=await apiRequest(fleet,`turns/${turn.id}/events`);demand(stream.ok,'SSE_CONNECT_FAILED');
    const frames=sseParser()(await stream.text());gates.sse=frames.some(frame=>frame.event==='turn'&&(frame.data as {state?:string}).state==='completed');
    const complete=await waitForTurn(fleet,turn.id);gates.turn=complete.state==='completed'&&!!complete.reply;
    gates.modelResult=!!complete.reply&&complete.reply.content.length>0&&!complete.reply.limitations.some(value=>value.startsWith('GUARDRAILS_'));
    const served=(await pool.query("SELECT reply->'serving' AS serving FROM turns WHERE id=$1",[turn.id])).rows[0].serving;
    gates.actualTransport=served?.calls===1&&Array.isArray(served.upstreams)&&served.upstreams.some((value:string)=>['litellm','fake'].includes(value));
    gates.owner=(await apiRequest(fleet,`turns/${turn.id}`,undefined,'lt-other')).status===404;
    gates.dto=!JSON.stringify(complete).includes('"agent"')&&!JSON.stringify(complete).includes('"serving"');
    const again=await sendTurn(fleet,session,'smoke-hello');await sleep(250);const after=await engineCounts(source);
    gates.idempotency=again.id===turn.id&&after.submitted-before.submitted===1;
    let storage=await checkpointStorage(pool,[turn.id]);
    gates.checkpoints=storage.modelRows>0&&storage.tables.checkpoints.rows>0&&storage.legacyStageRows===0;
    const captionSession=await createSession(fleet,data.personas[0]!.personId,true);
    const factual=await waitForTurn(fleet,(await sendTurn(fleet,captionSession,'smoke-evidence','파란책 게시물 기록을 알려주세요.',true)).id);
    gates.evidence=factual.state==='completed'&&!!factual.reply?.evidence.length&&factual.reply.evidence.every(e=>e.personId===data.personas[0]!.personId&&data.posts.some(p=>p.id===e.sourceId&&p.caption.includes(e.quote)));
    const draft=await apiRequest(fleet,`sessions/${session}/drafts`,{brief:'가상의 파란 책 포스트를 작성해주세요.'});
    const artifact=await draft.json() as {artifact?:{fictional:boolean;origin:string};notice?:unknown};gates.draft=draft.ok&&artifact.artifact?.fictional===true&&artifact.artifact.origin==='generated';
    await fleet.stop(fleet.worker!);const unavailablePort=await freePort();await fleet.startWorker({PTR_GUARDRAILS_URL:`http://127.0.0.1:${unavailablePort}`});
    const outageBefore=await engineCounts(source);const closed=await waitForTurn(fleet,(await sendTurn(fleet,session,'smoke-closed')).id);
    gates.failClosed=closed.state==='completed'&&closed.reply?.limitations.includes('GUARDRAILS_INPUT_UNAVAILABLE')===true;
    gates.failClosedNoModel=(await engineCounts(source)).submitted===outageBefore.submitted;
    await fleet.stop(fleet.worker!);await fleet.startWorker();const restart=await waitForTurn(fleet,(await sendTurn(fleet,session,'smoke-restart')).id);
    gates.workerRestart=restart.state==='completed';
    // Only a runner-owned process is paused. The new worker must reclaim BullMQ's expired lock.
    const lockBefore=await engineCounts(source),stale=fleet.worker!;
    const lost=await sendTurn(fleet,session,'smoke-lock-loss','__LOCK_LOSS__ 합성 잠금 상실 복구 테스트입니다.');
    await waitFor(async()=>(await engineCounts(source)).submitted>lockBefore.submitted,5000,'MODEL_SUBMISSION_NOT_OBSERVED');
    stale.kill('SIGSTOP');
    try {
      await fleet.startWorker();
      await waitFor(async()=>(await pool.query('SELECT attempts FROM turns WHERE id=$1',[lost.id])).rows[0].attempts>=2,10000,'LOCK_LOSS_NOT_RECOVERED');
      stale.kill('SIGCONT');
      const recovered=await waitForTurn(fleet,lost.id,20000);
      gates.lockLoss=recovered.state==='completed';
      await fleet.stop(stale);
      gates.staleWriterRejected=(await pool.query("SELECT count(*)::int AS n FROM messages WHERE turn_id=$1 AND role='assistant'",[lost.id])).rows[0].n===1;
    }finally{stale.kill('SIGCONT');}
    const rows=(await pool.query("SELECT count(*)::int AS n FROM messages WHERE turn_id=$1 AND role='assistant'",[turn.id])).rows[0].n;gates.singlePersistence=rows===1;
    const metrics=await (await fetch(`${fleet.workerMetricsBase}/metrics/prom`)).text();gates.metrics=parseExposition(metrics).types.has('ptr_turn_duration_seconds')&&!metrics.includes(run);
    if(web) {
      await fleet.startWeb();
      const unauthenticated=await fetch(`${fleet.webBase}/api/proxy/personas`);gates.webAuth=unauthenticated.status===403;
      const login=await fetch(`${fleet.webBase}/api/auth`,{method:'POST',headers:{Origin:fleet.webBase,'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-password-framework'})});
      const cookie=login.headers.get('set-cookie')?.split(';')[0];demand(login.ok&&cookie,'WEB_LOGIN_FAILED');
      const catalogue=await fetch(`${fleet.webBase}/api/proxy/personas`,{headers:{Cookie:cookie}});gates.web= catalogue.ok;
      const browser=await chromium.launch({headless:true});
      try {
        const page=await browser.newPage();page.setDefaultTimeout(30000);await page.goto(`${fleet.webBase}/login`);
        await page.waitForFunction(()=>{const input=document.querySelector('input[type=password]');return !!input&&Object.keys(input).some(key=>key.startsWith('__reactProps$'));});
        await page.getByLabel('연구 공간 비밀번호').fill('synthetic-password-framework');
        await page.getByRole('button',{name:'로그인',exact:true}).click();
        await page.getByRole('heading',{name:'대화 공간'}).waitFor();
        await page.getByLabel('연구 페르소나').selectOption(data.personas[0]!.personId);
        await page.getByRole('button',{name:'새 대화 시작'}).click();
        await page.getByLabel('메시지',{exact:true}).fill('안녕하세요. 합성 UI 대화예요.');
        await page.getByRole('button',{name:'보내기',exact:true}).click();
        await page.locator('.message.assistant').filter({hasText:complete.reply!.content}).last().waitFor({state:'visible',timeout:30000});
        await page.reload();await page.locator('.message.assistant').filter({hasText:complete.reply!.content}).last().waitFor({state:'visible',timeout:30000});
        gates.browser=true;
      }finally{await browser.close();}
    }
    const telemetry=new FrameworkTelemetry(frameworkTelemetryConfig(env)),client=createLangfuseClient(frameworkTelemetryConfig(env));
    try {
      const versions={code:'framework-smoke-v1',prompt:AGENT_PROMPT_REVISION,model:'primary',cases:'synthetic-v1',rubric:'seven-binary-v1'};
      const input=AppExperimentInputSchema.parse({personId:data.personas[0]!.personId,personaId:data.personas[0]!.id,personaRevision:'synthetic-v1',
        retrievalMode:'off',ragCondition:'off',turns:[{id:'hello-ko',text:'안녕하세요. 합성 평가 대화를 나눠요.',goldSourceIds:[]}],versions});
      const datasetName=`ptr-framework-http-${run}`;
      await migrateDataset(client,datasetName,{source:'synthetic',revision:'synthetic-v1',cases:[{id:'hello-ko',input,rubric:{synthetic:true,language:'ko'}}]});
      const experimentBefore=await engineCounts(source);
      const result=await runFrameworkExperiment({client,datasetName,runName:`synthetic-http-${run}`,versions,
        task:createHttpAppTask({baseUrl:fleet.apiBase,token:env.PTR_API_SYNTHETIC_TOKEN!,modelRevision:'primary',synthetic:true}),
        evaluators,scorePolicy,queueName:`ptr-framework-review-${run}`,telemetry});
      experiment={cases:result.cases,failedScores:result.failedScores,missingScores:result.missingScores,taskFailures:result.taskFailures,traceCount:result.traceIds.length,modelSubmissions:(await engineCounts(source)).submitted!-experimentBefore.submitted!};
      gates.appExperiment=result.cases===1&&result.failedScores===0&&result.missingScores===0&&result.taskFailures===0&&result.traceIds.length===1&&experiment.modelSubmissions===1;
    }finally{await telemetry.shutdown();}
    await fleet.close();let traces:Awaited<ReturnType<typeof traceEvidence>>={count:0,observations:0,stageNames:[],stageLatencyMs:{}};
    await waitFor(async()=>{traces=await traceEvidence(env,[session,captionSession],traceStart);return traces.count>=5&&traces.observations>=5;},60000,'TRACE_INGESTION_TIMEOUT');
    gates.tracing=traces.stageNames.includes('model')&&traces.stageNames.includes('retrieve')&&traces.stageNames.includes('output_guard');
    // Exact run-unique fixture persons include sessions created by browser and HTTP experiments too.
    const scopedTurns=(await pool.query('SELECT t.id FROM turns t JOIN sessions s ON s.id=t.session_id WHERE s.person_id=ANY($1::text[])',
      [data.personas.map(persona=>persona.personId)])).rows.map(row=>String(row.id));
    storage=await checkpointStorage(pool,scopedTurns);
    gates.checkpoints=gates.checkpoints&&storage.modelRows>0&&storage.legacyStageRows===0;
    if(!Object.values(gates).every(Boolean))throw Object.assign(new Error(`FUNCTIONAL_${Object.keys(gates).find(name=>!gates[name])?.toUpperCase()}_FAILED`),{evidence:{gates,traces,experiment}});
    return {syntheticOnly:true,paidCalls:0,webIncluded:web,gates,checkpointRows:storage.rows,checkpointStorage:storage,traces,experiment};
  } finally {await fleet.close();await pool.end();}
}
if(process.argv[1]?.endsWith('framework-smoke.ts')) {
  const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
  void Promise.all([readGeneratedEnv(args['env-file']??''),readGeneratedEnv(args['app-key-file']??'')]).then(([source,key])=>smoke(source,key,args['skip-web']!=='1'))
    .then(result=>{process.stdout.write(`${JSON.stringify(result)}\n`);},error=>{const code=(error as Error).message;process.stderr.write(`${JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(code)?code:'FRAMEWORK_SMOKE_FAILED',...((error as {evidence?:unknown}).evidence?{evidence:(error as {evidence:unknown}).evidence}:{})})}\n`);process.exitCode=1;});
}
