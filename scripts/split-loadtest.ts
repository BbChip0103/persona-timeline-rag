/** Matched, zero-dollar synthetic load comparison. Never runs against a research database. */
import {createHash,randomBytes} from 'node:crypto';
import {spawn,execFile} from 'node:child_process';
import {closeSync,openSync} from 'node:fs';
import {cp,mkdir,readFile,readdir,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {Pool} from 'pg';
import {createRequire} from 'node:module';
// Reuse the messaging workspace's already pinned BullMQ; this harness adds no dependency.
const {Queue}=createRequire(resolve('packages/messaging/package.json'))('bullmq') as typeof import('../packages/messaging/node_modules/bullmq');
import {PostgresPersonaRepository} from '../packages/storage/src/personas';
import {REDIS_PREFIX} from '../packages/messaging/src/redis';
import {percentile} from './loadtest-lib';
import {hostSnapshot,type HostSnapshot} from './split-loadtest-host';
import {isSyntheticModelReply} from './framework-loadtest';
import {FrameworkFleet,assertSyntheticTargets,createSession,demand,engineCounts,fixtures,frameworkEnvironment,freePort,migrateAndSeed,readGeneratedEnv,sendTurn,waitFor,waitForTurn} from './framework-smoke';

export const SPLIT_LOAD_GATE=Object.freeze({delayMs:100,promptTokens:16,completionTokens:12,warmup:4,measured:32,clients:8,workers:1,concurrency:4,
  original:Object.freeze({throughputMin:.60,p95RatioMax:1.75,p95SlackMs:250}),current:Object.freeze({throughputMin:.85,p95RatioMax:1.25,p95SlackMs:100})});
export type Kind='O'|'C'|'P';
export const TRIPLET_ORDERS:readonly (readonly Kind[])[]=Object.freeze([['O','C','P'],['P','C','O'],['O','P','C'],['C','P','O']] as const);
const REFS={O:'ee9f55c091697c7794b8cf8fad998c66ca1464b7',C:'3dc6ff8e90575c3e575368c0261277c053d23097'};
export interface Summary {turns:number;completed:number;errors:number;elapsedMs:number;completedPerSecond:number;latencyMs:{p50:number|null;p95:number|null;p99:number|null};clientPeakConcurrency:number;modelSubmissions:number;modelSuccesses:number;modelFailures:number;modelTimeouts:number;nonFallbackOutputs:number;modelOutputHashes:string[];assistantUnique:boolean;outboxEmpty:boolean;durableAck?:boolean}
export interface SplitLoadLeg {kind:Kind;round:number;code:string;outcome:'measured'|'invalid';summary?:Summary;raw:{latenciesMs:number[];turnIds:string[];modelCountsBefore:Record<string,number>;modelCountsAfter:Record<string,number>;samples?:Array<{turnId?:string;latencyMs:number;state:string;errorCode?:string}>;timing?:{startedAt:string;completedAt:string;hostBefore:HostSnapshot;hostAfter:HostSnapshot}};artifact:string;errorCode?:string;warmup?:Summary;warmupRaw?:SplitLoadLeg['raw'];runtimeSourceHash?:string;ports?:{api:number;worker:number};phases?:{runtimeStartedAt:string;runtimeReadyAt?:string;cleanupStartedAt?:string;cleanupCompletedAt?:string}}
export interface Triplet {round:number;order:readonly Kind[];legs:SplitLoadLeg[];passed:boolean;gates:Record<string,boolean>;ratios?:Record<string,number>}
const valid=(leg:SplitLoadLeg|undefined)=>!!leg&&leg.outcome==='measured'&&!!leg.summary&&leg.summary.turns===32&&leg.summary.completed===32&&leg.summary.errors===0&&leg.summary.modelSubmissions===32&&leg.summary.modelSuccesses===32&&leg.summary.modelFailures===0&&leg.summary.modelTimeouts===0&&leg.summary.nonFallbackOutputs===32&&leg.summary.assistantUnique&&leg.summary.outboxEmpty&&(leg.kind!=='P'||leg.summary.durableAck===true)&&Number.isFinite(leg.summary.completedPerSecond)&&leg.summary.completedPerSecond>0&&Number.isFinite(leg.summary.latencyMs.p95);
export function compareMatchedTriplet(legs:SplitLoadLeg[]):Pick<Triplet,'passed'|'gates'|'ratios'> {
  const o=legs.find(l=>l.kind==='O'),c=legs.find(l=>l.kind==='C'),p=legs.find(l=>l.kind==='P'),shape=(l:SplitLoadLeg|undefined)=>JSON.stringify(l?.summary?.modelOutputHashes.slice().sort());
  const gates:Record<string,boolean>={allThreePresent:legs.length===3&&new Set(legs.map(l=>l.kind)).size===3,originalCorrect:valid(o),currentCorrect:valid(c),pythonCorrect:valid(p),exactOutputShapeMatch:!!o?.summary?.modelOutputHashes.length&&shape(o)===shape(c)&&shape(c)===shape(p)};
  const ratios:Record<string,number>={};
  for(const [name,baseline,gate] of [['original',o,SPLIT_LOAD_GATE.original],['current',c,SPLIT_LOAD_GATE.current]] as const) {
    const b=baseline?.summary,next=p?.summary;
    gates[`${name}Throughput`]=!!b&&!!next&&next.completedPerSecond>=b.completedPerSecond*gate.throughputMin;
    gates[`${name}P95`]=!!b&&!!next&&b.latencyMs.p95!==null&&next.latencyMs.p95!==null&&next.latencyMs.p95<=b.latencyMs.p95*gate.p95RatioMax+gate.p95SlackMs;
    if(b&&next){ratios[`${name}Throughput`]=next.completedPerSecond/b.completedPerSecond;ratios[`${name}P95`]=next.latencyMs.p95! / b.latencyMs.p95!;}
  }
  return {passed:Object.values(gates).every(Boolean),gates,ratios};
}
export function finalizeReport(triplets:Triplet[]) {
  const ordersMatch=triplets.length===4&&triplets.every((t,i)=>JSON.stringify(t.order)===JSON.stringify(TRIPLET_ORDERS[i])&&t.round===i);
  const middle=(values:number[])=>{const sorted=values.slice().sort((a,b)=>a-b),n=sorted.length;return n===0?null:n%2?sorted[Math.floor(n/2)]!:(sorted[n/2-1]!+sorted[n/2]!)/2;};
  const median:Record<string,{throughput:number|null;p95:number|null}>={};
  for(const kind of ['O','C','P'] as const){const summaries=triplets.flatMap(t=>t.legs.filter(l=>l.kind===kind&&l.outcome==='measured'&&l.summary).map(l=>l.summary!));median[kind]={throughput:middle(summaries.map(s=>s.completedPerSecond)),p95:middle(summaries.flatMap(s=>s.latencyMs.p95===null?[]:[s.latencyMs.p95]))};}
  return {syntheticOnly:true,paidCalls:0,thresholds:SPLIT_LOAD_GATE,orders:TRIPLET_ORDERS,triplets,passed:ordersMatch&&triplets.every(t=>t.passed),ordersMatch,explanatoryMedianOnly:median,
    unavailable:['provider TTFT: nonstreaming fixture','worker peak: no sampler in timed window','disk/WAL I/O: not measured'],failedAndInvalidRunsRetained:true};
}
const runFile=promisify(execFile);
const code=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]{1,100}$/.test(error.message)?error.message:'SPLIT_LOAD_LEG_FAILED';
const writeJson=(path:string,value:unknown)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
/** The harness retains both roles for scoped proof queries; runtime children do not. */
export function splitChildEnvironment(env:NodeJS.ProcessEnv,kind:'node'|'python'):NodeJS.ProcessEnv {
  const common=new Set(['PATH','HOME','NODE_ENV','LANGSMITH_TRACING','LANGCHAIN_TRACING_V2','PTR_REDIS_URL','PTR_TURN_QUEUE','PTR_EVENTS_NAMESPACE']);
  const backend=new Set(['DATABASE_URL','PTR_APP_DATABASE_URL','PTR_API_TOKEN','PTR_API_SYNTHETIC_TOKEN','PTR_API_PORT','PTR_LLM_CONTROL_TOKEN','PTR_LLM_SERVICE_URL','PTR_LLM_SERVICE_MODE','PTR_CHAT_PROVIDER','PTR_LITELLM_BILLABLE','PTR_DB_POOL_MAX','PTR_QUEUE_MAX_DEPTH','PTR_DISPATCH_INTERVAL_MS','PTR_DISPATCH_GRACE_MS']);
  return Object.fromEntries(Object.entries(env).filter(([key])=>common.has(key)||(kind==='node'?backend.has(key):
    !key.includes('OWNER')&&(!key.includes('DATABASE_URL')||key==='PTR_LLM_DATABASE_URL')&&(key.startsWith('PTR_LLM_')||key.startsWith('LANGFUSE_')||key.startsWith('OPENROUTER_')||key==='FRAMEWORK_RELEASE'))));
}
export async function rolesEnvironment(path:string):Promise<NodeJS.ProcessEnv> {
  demand(resolve(path)==='/tmp/ptr-python-split-1791653132/roles.env','ISOLATED_ROLES_ENV_REQUIRED');const info=await stat(path);demand((info.mode&0o777)===0o600,'PRIVATE_ROLES_ENV_REQUIRED');const env:NodeJS.ProcessEnv={};
  for(const line of (await readFile(path,'utf8')).split('\n')){if(!line||line.startsWith('#'))continue;const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);demand(match,'INVALID_ROLES_ENV');env[match[1]!]=match[2]!;}
  for(const [key,user] of [['PTR_SPLIT_TEST_APP_DATABASE_URL','ptr_split_app'],['PTR_SPLIT_TEST_LLM_DATABASE_URL','ptr_split_llm']] as const){const url=new URL(env[key]??'');demand(url.hostname==='127.0.0.1'&&url.port==='58432'&&url.pathname==='/ptr_split_test'&&url.username===user&&url.password&&!url.search&&!url.hash,'SYNTHETIC_SPLIT_TARGET_REQUIRED');}
  const r=new URL(env.PTR_REDIS_URL??'');demand(r.hostname==='127.0.0.1'&&r.port==='58479'&&r.pathname==='/0'&&r.password&&!r.search&&!r.hash,'SYNTHETIC_SPLIT_REDIS_REQUIRED');return env;
}
async function linkDependencies(target:string,from:string):Promise<void> {
  for(const relative of ['node_modules',...(await readdir(join(target,'packages'))).map(n=>`packages/${n}/node_modules`),...(await readdir(join(target,'apps'))).map(n=>`apps/${n}/node_modules`)]) {
    const path=join(from,relative);if((await stat(path).catch(()=>undefined))?.isDirectory()){await symlink(path,join(target,relative),'dir');}
  }
}
export async function sourceHash(root:string,includePythonDependencies=false):Promise<string> {
  const hash=createHash('sha256');async function walk(path:string){for(const item of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(['node_modules','.venv','__pycache__'].includes(item.name)||item.name.endsWith('.pyc'))continue;const full=join(path,item.name);if(item.isDirectory())await walk(full);else if(item.isFile()){hash.update(full.slice(root.length));hash.update(await readFile(full));}}}
  for(const name of ['apps/api','packages','apps/llm-service/src','contracts',...(includePythonDependencies?['src']:[])])if((await stat(join(root,name)).catch(()=>undefined))?.isDirectory())await walk(join(root,name));return hash.digest('hex');
}
export async function prepareSources(directory:string):Promise<Record<Kind,{root:string;code:string;runtimeSourceHash:string;preparationStartedAt:string;preparationCompletedAt:string}>> {
  const source=resolve('.'),roots={} as Record<Kind,{root:string;code:string;runtimeSourceHash:string;preparationStartedAt:string;preparationCompletedAt:string}>;
  for(const kind of ['O','C'] as const){const preparationStartedAt=new Date().toISOString(),root=join(directory,kind);await mkdir(root,{mode:0o700});const tar=join(directory,`${kind}.tar`);const archive=await runFile('git',['archive','--format=tar',REFS[kind]],{cwd:source,encoding:'buffer',maxBuffer:64*1024*1024});await writeFile(tar,archive.stdout,{mode:0o600});await runFile('tar',['-xf',tar,'-C',root]);
    if(kind==='O'){for(const [file,oldPort,newPort] of [['packages/storage/src/local-guard.ts','56432','57433'],['packages/messaging/src/local-guard.ts','56479','57480']]){const path=join(root,file!),text=await readFile(path,'utf8');demand(text.includes(`'${oldPort}'`),'BASELINE_GUARD_MISMATCH');await writeFile(path,text.replace(`'${oldPort}'`,`'${newPort}'`));}}
    await linkDependencies(root,kind==='O'?'/tmp/ptr-framework-baseline-src':source);roots[kind]={root,code:REFS[kind],runtimeSourceHash:await sourceHash(root),preparationStartedAt,preparationCompletedAt:new Date().toISOString()};
  }
  const preparationStartedAt=new Date().toISOString(),root=join(directory,'P');await mkdir(root,{mode:0o700});
  for(const name of ['apps/api','apps/llm-service/src','packages','contracts','src','supabase','tsconfig.json','tsconfig.base.json','package.json','pnpm-lock.yaml','pnpm-workspace.yaml'])await cp(join(source,name),join(root,name),{recursive:true,filter:path=>!path.split('/').some(n=>['node_modules','.venv','__pycache__','.omx','data','reports'].includes(n)||n.endsWith('.private.md')||n==='.env'||n.endsWith('.pyc'))});
  await linkDependencies(root,source);roots.P={root,code:`3dc6ff8+working:${await sourceHash(root)}`,runtimeSourceHash:await sourceHash(root),preparationStartedAt,preparationCompletedAt:new Date().toISOString()};
  return roots;
}
export class PythonFleet extends FrameworkFleet {
  constructor(root:string,env:NodeJS.ProcessEnv,directory:string,private readonly pythonEnvironment:NodeJS.ProcessEnv){super(root,env,directory);}
  async startPython(sourceRoot:string):Promise<void>{const log=openSync(join(this.directory,'python-worker.private.log'),'a',0o600),port=Number(this.pythonEnvironment.PTR_LLM_PORT);
    const child=spawn(join(sourceRoot,'apps/llm-service/.venv/bin/python'),['-m','ptr_llm','worker'],{cwd:this.root,env:{...this.pythonEnvironment,PYTHONPATH:`${join(this.root,'apps/llm-service/src')}:${join(this.root,'src')}`},stdio:['ignore',log,log]});closeSync(log);this.children.push(child);this.worker=child;this.workerMetricsBase=`http://127.0.0.1:${port}`;
    await waitFor(async()=>{demand(child.exitCode===null,'PYTHON_PROCESS_EXITED');return (await fetch(`${this.workerMetricsBase}/health/ready`,{signal:AbortSignal.timeout(2000)})).status===200;},60000,'PYTHON_READINESS_TIMEOUT');
  }
}
interface RuntimeContext {source:NodeJS.ProcessEnv;key:NodeJS.ProcessEnv;baseline:NodeJS.ProcessEnv;roles:NodeJS.ProcessEnv;roots:Awaited<ReturnType<typeof prepareSources>>;directory:string}
async function startFleet(kind:Kind,round:number,ctx:RuntimeContext):Promise<{fleet:FrameworkFleet;personId:string;pool:Pool;ports:{api:number;worker:number}}> {
  const run=randomBytes(4).toString('hex'),directory=join(ctx.directory,`round-${round}-${kind}`);await mkdir(directory,{mode:0o700});const data=fixtures(run),queue=`split-load-${run}`,catalogue=join(directory,'personas.json'),root=ctx.roots[kind].root;
  let env=frameworkEnvironment(ctx.source,ctx.key,catalogue,queue),fleet:FrameworkFleet|undefined,pool:Pool|undefined;
  try {
    if(kind==='O'){
      const redis=new URL(ctx.baseline.BASELINE_REDIS_URL??'');if(redis.pathname==='/'||redis.pathname==='')redis.pathname='/0';assertSyntheticTargets(ctx.baseline.BASELINE_DATABASE_URL??'',redis.href,true);
      env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',PTR_DEMO_SCALING:'1',DATABASE_URL:ctx.baseline.BASELINE_DATABASE_URL,PTR_REDIS_URL:redis.href,PTR_PERSONAS_FILE:catalogue,PTR_API_TOKEN:randomBytes(24).toString('hex'),PTR_API_SYNTHETIC_TOKEN:randomBytes(24).toString('hex'),PTR_TURN_QUEUE:queue,PTR_EVENTS_NAMESPACE:queue,PTR_DB_POOL_MAX:'8',PTR_QUEUE_MAX_DEPTH:'64',PTR_WORKER_CONCURRENCY:'4',PTR_WORKER_REPLICAS_HINT:'1',PTR_LEASE_MS:'15000',PTR_DISPATCH_GRACE_MS:'200',PTR_DISPATCH_INTERVAL_MS:'100',PTR_CHAT_PROVIDER:'gateway',PTR_GATEWAY_STRUCTURED:'1',PTR_GATEWAY_TOKEN:randomBytes(24).toString('hex'),PTR_METRICS_PORT:'0',PTR_SELFHOSTED_BASE_URL:`http://127.0.0.1:${ctx.source.PTR_FAKE_ENGINE_PORT}/v1`,PTR_SELFHOSTED_MODEL:'ptr-synthetic',PTR_INTENT_CLASSIFIER:'off',PTR_SAFETY_FILTER:'off'};
    }
    if(kind!=='P'){
      // Exact archived reference runtimes, no modifications to shared source or existing baseline copy.
      if(kind==='C')delete env.PTR_LLM_SERVICE_MODE;
      await migrateAndSeed(root,env,data,kind==='O');fleet=new FrameworkFleet(root,env,directory,kind==='O');
      if(kind==='O'){const gateway=await freePort();env.PTR_GATEWAY_URL=`http://127.0.0.1:${gateway}/v1`;fleet.launch('apps/gateway/src/main.ts',{PTR_GATEWAY_PORT:String(gateway),PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_GATEWAY_MAX_CONCURRENCY:'4',PTR_GATEWAY_MAX_QUEUE:'64',PTR_GATEWAY_PRIMARY_HEADERS_TIMEOUT_MS:'0'});await waitFor(async()=>(await fetch(`http://127.0.0.1:${gateway}/healthz`,{signal:AbortSignal.timeout(3000)})).status===200);fleet.launch('apps/api/src/dispatcher.ts');}
      await fleet.startApi();await fleet.startWorker();pool=new Pool({connectionString:env.DATABASE_URL,max:2});
    }else{
      const apiPort=await freePort(),workerPort=await freePort();
      env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',LANGSMITH_TRACING:'false',LANGCHAIN_TRACING_V2:'false',PTR_APP_DATABASE_URL:ctx.roles.PTR_SPLIT_TEST_APP_DATABASE_URL,DATABASE_URL:ctx.roles.PTR_SPLIT_TEST_APP_DATABASE_URL,PTR_LLM_DATABASE_URL:ctx.roles.PTR_SPLIT_TEST_LLM_DATABASE_URL,PTR_REDIS_URL:ctx.roles.PTR_REDIS_URL,PTR_LLM_REDIS_URL:ctx.roles.PTR_REDIS_URL,PTR_LLM_CONTROL_TOKEN:ctx.roles.PTR_LLM_CONTROL_TOKEN,PTR_API_TOKEN:randomBytes(24).toString('hex'),PTR_API_SYNTHETIC_TOKEN:randomBytes(24).toString('hex'),PTR_LLM_SERVICE_MODE:'split',PTR_CHAT_PROVIDER:'litellm',PTR_LITELLM_BILLABLE:'0',PTR_API_PORT:String(apiPort),PTR_LLM_BACKEND_URL:`http://127.0.0.1:${apiPort}`,PTR_LLM_SERVICE_URL:`http://127.0.0.1:${workerPort}`,PTR_LLM_PORT:String(workerPort),PTR_TURN_QUEUE:queue,PTR_LLM_QUEUE_NAME:queue,PTR_EVENTS_NAMESPACE:queue,PTR_LLM_PROVIDER:'litellm',PTR_LLM_MODEL:'primary',PTR_LLM_LITELLM_BASE_URL:`http://127.0.0.1:${ctx.source.PTR_LITELLM_PORT}/v1`,PTR_LLM_LITELLM_API_KEY:ctx.key.PTR_LITELLM_API_KEY,PTR_LLM_LITELLM_BILLABLE:'0',PTR_LLM_CONCURRENCY:'4',PTR_LLM_DB_POOL_MAX:'8',PTR_DB_POOL_MAX:'8',PTR_QUEUE_MAX_DEPTH:'64',PTR_LLM_LOCK_DURATION_MS:'1000',PTR_LLM_STALLED_INTERVAL_MS:'500',PTR_DISPATCH_INTERVAL_MS:'100',PTR_DISPATCH_GRACE_MS:'200',PTR_LLM_INTENT_CLASSIFIER:'off',PTR_LLM_SAFETY_FILTER:'off',LANGFUSE_ENABLED:'true',LANGFUSE_ALLOW_LOCAL_HTTP:'true',LANGFUSE_CAPTURE_CONTENT:'false',LANGFUSE_BASE_URL:ctx.source.LANGFUSE_BASE_URL,LANGFUSE_PUBLIC_KEY:ctx.source.LANGFUSE_PUBLIC_KEY,LANGFUSE_SECRET_KEY:ctx.source.LANGFUSE_SECRET_KEY,LANGFUSE_TRACING_ENVIRONMENT:'synthetic',FRAMEWORK_RELEASE:'python-split-load'};
      const personas=new Pool({connectionString:env.PTR_LLM_DATABASE_URL,options:'-c search_path=llm,public',max:2});try{await new PostgresPersonaRepository(personas).importPersonas(data.personas);}finally{await personas.end();}
      fleet=new PythonFleet(root,splitChildEnvironment(env,'node'),directory,splitChildEnvironment(env,'python'));
      // FrameworkFleet normally allocates its API port; Python control needs the same preselected port.
      fleet.apiBase=`http://127.0.0.1:${apiPort}`;const api=fleet.launch('apps/api/src/main.ts');await waitFor(async()=>{demand(api.exitCode===null,'API_PROCESS_EXITED');return (await fetch(`${fleet!.apiBase}/api/health`,{signal:AbortSignal.timeout(2000)})).status===200;});await (fleet as PythonFleet).startPython(resolve('.'));
      pool=new Pool({connectionString:env.PTR_APP_DATABASE_URL,options:'-c search_path=app,public',max:2});
    }
    const resolved=await runFile(process.execPath,['--import','tsx','-e',"process.stdout.write(require.resolve('@ptr/core'))"],{cwd:root,env:fleet.env,maxBuffer:4096});demand(resolved.stdout.startsWith(root+'/packages/core/'),'REFERENCE_SOURCE_ALIAS_MISMATCH');
    return {fleet,personId:data.personas[0]!.personId,pool,ports:{api:Number(new URL(fleet.apiBase).port),worker:Number(new URL(fleet.workerMetricsBase).port)}};
  }catch(error){await fleet?.close();await pool?.end();throw error;}
}
export async function queueIdle(fleet:FrameworkFleet):Promise<void>{const target=new URL(fleet.env.PTR_REDIS_URL!),queue=new Queue(fleet.env.PTR_TURN_QUEUE!,{connection:{host:'127.0.0.1',port:Number(target.port),username:decodeURIComponent(target.username)||undefined,password:decodeURIComponent(target.password),db:0,maxRetriesPerRequest:1,commandTimeout:3000},prefix:REDIS_PREFIX});try{await waitFor(async()=>{const counts=await queue.getJobCounts('active','wait','delayed');return Object.values(counts).every(n=>n===0);},10000,'OWN_QUEUE_DRAIN_TIMEOUT');}finally{await queue.close();}}
async function measure(fleet:FrameworkFleet,source:NodeJS.ProcessEnv,personId:string,pool:Pool,kind:Kind,turns:number,concurrency:number):Promise<{summary:Summary;raw:SplitLoadLeg['raw']}> {
  const sessions:string[]=[];for(let i=0;i<turns;i++)sessions.push(await createSession(fleet,personId));
  const before=await engineCounts(source);demand(before.effective_delay_ms===100&&before.prompt_tokens===16&&before.completion_tokens===12,'FIXED_SYNTHETIC_ENGINE_CHANGED');
  const latencies:number[]=[],turnIds:string[]=[],samples:NonNullable<SplitLoadLeg['raw']['samples']>=[],hashes=new Set<string>();let index=0,active=0,peak=0,errors=0,nonFallback=0;
  // Both probes are outside the unchanged timed interval; never pause/subtract probe time.
  const hostBefore=await hostSnapshot(fleet.children.flatMap(child=>child.pid===undefined?[]:[child.pid])),startedAt=new Date().toISOString();const started=performance.now();
  await Promise.all(Array.from({length:concurrency},async()=>{for(;;){const i=index++;if(i>=turns)break;const began=performance.now();active++;peak=Math.max(peak,active);try{const pending=await sendTurn(fleet,sessions[i]!,`matched-${i}`);turnIds.push(pending.id);const final=await waitForTurn(fleet,pending.id);const latency=performance.now()-began;samples.push({turnId:pending.id,latencyMs:latency,state:final.state,...(final.errorCode?{errorCode:final.errorCode}:{})});if(final.state==='completed'){latencies.push(latency);if(isSyntheticModelReply(final.reply)){nonFallback++;hashes.add(createHash('sha256').update(JSON.stringify({status:final.reply!.status,content:final.reply!.content,limitations:final.reply!.limitations})).digest('hex'));}}else errors++;}catch(error){errors++;samples.push({latencyMs:performance.now()-began,state:'error',errorCode:code(error)});}finally{active--;}}}));
  const elapsed=performance.now()-started,completedAt=new Date().toISOString();
  const hostAfter=await hostSnapshot(fleet.children.flatMap(child=>child.pid===undefined?[]:[child.pid]));const after=await engineCounts(source);await queueIdle(fleet);
  const counts=(await pool.query(`SELECT t.id,t.state,count(m.id) FILTER(WHERE m.role='assistant')::int AS assistants,(SELECT count(*) FROM turn_outbox o WHERE o.turn_id=t.id)::int AS outbox FROM turns t LEFT JOIN messages m ON m.turn_id=t.id WHERE t.id=ANY($1::text[]) GROUP BY t.id`,[turnIds])).rows;
  const unique=counts.length===turns&&counts.every(r=>r.state==='completed'&&r.assistants===1),empty=counts.length===turns&&counts.every(r=>r.outbox===0);let ack:boolean|undefined;
  if(kind==='P')ack=(await pool.query('SELECT count(*)::int AS n FROM turn_execution_grants WHERE turn_id=ANY($1::text[]) AND result_hash IS NOT NULL',[turnIds])).rows[0].n===turns;
  const summary:Summary={turns,completed:latencies.length,errors,elapsedMs:elapsed,completedPerSecond:latencies.length/(elapsed/1000),latencyMs:{p50:percentile(latencies,50),p95:percentile(latencies,95),p99:percentile(latencies,99)},clientPeakConcurrency:peak,modelSubmissions:after.submitted!-before.submitted!,modelSuccesses:after.success!-before.success!,modelFailures:after.failed!-before.failed!,modelTimeouts:after.timeout!-before.timeout!,nonFallbackOutputs:nonFallback,modelOutputHashes:[...hashes].sort(),assistantUnique:unique,outboxEmpty:empty,...(ack===undefined?{}:{durableAck:ack})};
  return {summary,raw:{latenciesMs:latencies,turnIds,modelCountsBefore:before,modelCountsAfter:after,samples,timing:{startedAt,completedAt,hostBefore,hostAfter}}};
}
async function runLeg(kind:Kind,round:number,ctx:RuntimeContext):Promise<SplitLoadLeg>{const artifact=join(ctx.directory,`round-${round}-${kind}.json`),leg:SplitLoadLeg={kind,round,code:ctx.roots[kind].code,runtimeSourceHash:ctx.roots[kind].runtimeSourceHash,outcome:'invalid',raw:{latenciesMs:[],turnIds:[],modelCountsBefore:{},modelCountsAfter:{}},artifact,phases:{runtimeStartedAt:new Date().toISOString()}};let runtime:Awaited<ReturnType<typeof startFleet>>|undefined;
  try{runtime=await startFleet(kind,round,ctx);leg.phases!.runtimeReadyAt=new Date().toISOString();leg.ports=runtime.ports;const warm=await measure(runtime.fleet,ctx.source,runtime.personId,runtime.pool,kind,4,4);leg.warmup=warm.summary;leg.warmupRaw=warm.raw;demand(warm.summary.completed===4&&warm.summary.errors===0&&warm.summary.modelSubmissions===4&&warm.summary.modelSuccesses===4&&warm.summary.nonFallbackOutputs===4&&warm.summary.assistantUnique,'WARMUP_CORRECTNESS_FAILED');const measured=await measure(runtime.fleet,ctx.source,runtime.personId,runtime.pool,kind,32,8);leg.summary=measured.summary;leg.raw=measured.raw;leg.outcome='measured';}
  catch(error){leg.errorCode=code(error);}finally{leg.phases!.cleanupStartedAt=new Date().toISOString();await runtime?.fleet.close();await runtime?.pool.end();leg.phases!.cleanupCompletedAt=new Date().toISOString();await writeJson(artifact,leg);}return leg;
}
export async function runMatched(options:{sourceEnv:string;appKeyEnv:string;baselineEnv:string;rolesEnv:string;output:string}) {
  demand(resolve(options.output).startsWith('/tmp/ptr-split-load-'),'PRIVATE_DISPOSABLE_OUTPUT_REQUIRED');await mkdir(options.output,{recursive:true,mode:0o700});
  const [source,key,baseline,roles]=await Promise.all([readGeneratedEnv(options.sourceEnv),readGeneratedEnv(options.appKeyEnv),readGeneratedEnv(options.baselineEnv),rolesEnvironment(options.rolesEnv)]),configuration=await engineCounts(source);demand(configuration.effective_delay_ms===100&&configuration.prompt_tokens===16&&configuration.completion_tokens===12,'FIXED_SYNTHETIC_ENGINE_REQUIRED');
  const harnessSourceHashes=Object.fromEntries(await Promise.all(['split-loadtest.ts','split-loadtest-host.ts'].map(async name=>[name,createHash('sha256').update(await readFile(join(resolve('scripts'),name))).digest('hex')])));
  const roots=await prepareSources(options.output),ctx={source,key,baseline,roles,roots,directory:options.output},triplets:Triplet[]=[];await writeJson(join(options.output,'provenance.json'),{references:REFS,roots,harnessSourceHashes,configuration,thresholds:SPLIT_LOAD_GATE,orders:TRIPLET_ORDERS,clock:'performance.now',timedClientPolicy:'common HTTP POST + 100ms terminal polling',node:process.version,hostProvenancePolicy:'numeric bounded pre/post probes outside each warm/measure timed interval; missing metadata explicit; no causal inference from snapshots alone'});
  for(let round=0;round<TRIPLET_ORDERS.length;round++){const order=TRIPLET_ORDERS[round]!,legs:SplitLoadLeg[]=[];for(const kind of order){process.stdout.write(`MEASURING round=${round} kind=${kind}\n`);const leg=await runLeg(kind,round,ctx);legs.push(leg);await writeJson(join(options.output,'progress.json'),{triplets,round,order,legs});process.stdout.write(`MEASURED round=${round} kind=${kind} outcome=${leg.outcome}${leg.errorCode?` code=${leg.errorCode}`:''}\n`);}const triplet={round,order,legs,...compareMatchedTriplet(legs)};triplets.push(triplet);await writeJson(join(options.output,'summary.json'),finalizeReport(triplets));}
  const result=finalizeReport(triplets);await writeJson(join(options.output,'summary.json'),result);return result;
}
if(process.argv[1]?.endsWith('split-loadtest.ts')){const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));void runMatched({sourceEnv:args['env-file']??'/tmp/ptr-fw-infra-smoke.env',appKeyEnv:args['app-key-file']??'/tmp/ptr-fw-causal-app-key2.env',baselineEnv:args['baseline-env-file']??'/tmp/ptr-fw-baseline.env',rolesEnv:args['roles-env']??'/tmp/ptr-python-split-1791653132/roles.env',output:args.output??join(tmpdir(),`ptr-split-load-${Date.now()}`)}).then(result=>{process.stdout.write(JSON.stringify({passed:result.passed,triplets:result.triplets.map(t=>({round:t.round,passed:t.passed,gates:t.gates,ratios:t.ratios}))})+'\n');if(!result.passed)process.exitCode=1;},error=>{process.stderr.write(JSON.stringify({ok:false,code:code(error)})+'\n');process.exitCode=1;});}
