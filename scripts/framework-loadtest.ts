import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Pool } from 'pg';
import { parseExposition } from '@ptr/ops';
import { percentile } from './loadtest-lib';
import { replyText } from '../packages/core/src/reply-texts';
import { FrameworkFleet, assertSyntheticTargets, checkpointStorage, type CheckpointStorage, createSession, demand, engineCounts, fixtures,
  frameworkEnvironment, freePort, migrateAndSeed, readGeneratedEnv, sendTurn, waitFor, waitForTurn, traceEvidence } from './framework-smoke';

/** Locked before any comparative run; not a production capacity promise. */
export const LOAD_GATE=Object.freeze({warmupTurns:4,measuredTurns:32,clientConcurrency:8,workerConcurrency:4,
  expectedDelayMs:100,expectedPromptTokens:16,expectedCompletionTokens:12,p95RatioMax:1.75,p95SlackMs:250,
  throughputRatioMin:0.60,maxErrors:0});
export interface LoadSummary {
  turns:number;completed:number;errors:number;elapsedMs:number;completedPerSecond:number;
  latencyMs:{p50:number|null;p95:number|null;p99:number|null};clientPeakConcurrency:number;workerPeakConcurrency:number|null;
  workerPeakConcurrencyLowerBound?:true;checkpointStorage?:CheckpointStorage;
  modelSuccesses?:number;modelFailures?:number;modelTimeouts?:number;nonFallbackOutputs?:number;modelOutputHashes?:string[];
  modelSubmissions:number;providerTTFT:null;queueWaitUpperBoundSeconds:{p50:number|null;p95:number|null};
  checkpointRows:number;checkpointBytes:number;traceCount:number|null;observations:number|null;stageNames:string[];stageLatencyMs:Record<string,{p50:number|null;p95:number|null}>;
}
export function comparison(baseline:LoadSummary,migration:LoadSummary):{passed:boolean;gates:Record<string,boolean>} {
  const gates={zeroErrors:baseline.errors===0&&migration.errors===0,
    complete:baseline.completed===LOAD_GATE.measuredTurns&&migration.completed===LOAD_GATE.measuredTurns,
    oneSyntheticSubmission:baseline.modelSubmissions===LOAD_GATE.measuredTurns&&migration.modelSubmissions===LOAD_GATE.measuredTurns,
    exactModelSuccess:baseline.modelSuccesses===LOAD_GATE.measuredTurns&&migration.modelSuccesses===LOAD_GATE.measuredTurns,
    noModelFailure:baseline.modelFailures===0&&migration.modelFailures===0&&baseline.modelTimeouts===0&&migration.modelTimeouts===0,
    nonFallbackOutputs:baseline.nonFallbackOutputs===LOAD_GATE.measuredTurns&&migration.nonFallbackOutputs===LOAD_GATE.measuredTurns,
    outputShapesMatch:Array.isArray(baseline.modelOutputHashes)&&baseline.modelOutputHashes.length>0&&Array.isArray(migration.modelOutputHashes)
      &&JSON.stringify([...baseline.modelOutputHashes].sort())===JSON.stringify([...migration.modelOutputHashes].sort()),
    p95:baseline.latencyMs.p95!==null&&migration.latencyMs.p95!==null&&migration.latencyMs.p95<=baseline.latencyMs.p95*LOAD_GATE.p95RatioMax+LOAD_GATE.p95SlackMs,
    throughput:migration.completedPerSecond>=baseline.completedPerSecond*LOAD_GATE.throughputRatioMin};
  return {passed:Object.values(gates).every(Boolean),gates};
}
const syntheticPolicyAnnotations=new Set(['RETRIEVAL_OFF','UNVERIFIED_MODEL_RESPONSE',...['ko','en'].flatMap(language=>[
  replyText('limitation_unverified_model',language),replyText('limitation_posted_date',language)])]);
/** Exact fixture response shape/content excludes successful-looking policy or transport fallback replies. */
export function isSyntheticModelReply(value:unknown):boolean {
  if(!value||typeof value!=='object')return false;
  const reply=value as {status?:unknown;content?:unknown;limitations?:unknown};
  // The normal current and historical off-RAG APIs annotate valid generated replies. These are
  // informational policy metadata, not fallback failures; all unrecognized limitations still fail.
  return reply.status==='answered'&&['Synthetic reply from the isolated local engine.','합성 엔진에서 보내는 짧은 답변이에요.'].includes(String(reply.content))
    &&Array.isArray(reply.limitations)&&reply.limitations.every(value=>typeof value==='string'&&syntheticPolicyAnnotations.has(value));
}
export function workerEndpointPeak(before:string,after:string):number|null {
  const peak=Math.max(...[before,after].map(text=>parseExposition(text).samples.find(s=>s.name==='ptr_turns_inflight')?.value??0));
  return peak>0?peak:null;
}
export function histogramQuantile(before:string,after:string,name:string,percent:number):number|null {
  const old=parseExposition(before).samples,next=parseExposition(after).samples;
  const count=next.find(s=>s.name===`${name}_count`)?.value??0,oldCount=old.find(s=>s.name===`${name}_count`)?.value??0;
  const needed=Math.ceil((count-oldCount)*percent/100);if(needed<=0)return null;
  for(const bucket of next.filter(s=>s.name===`${name}_bucket`).sort((a,b)=>Number(a.labels.le)-Number(b.labels.le))) {
    const previous=old.find(s=>s.name===bucket.name&&s.labels.le===bucket.labels.le)?.value??0;
    if(bucket.value-previous>=needed){const bound=bucket.labels.le==='+Inf'?Infinity:Number(bucket.labels.le);return Number.isFinite(bound)?bound:null;}
  }
  return null;
}
/** Only the baseline COPY is adapted, only two exact loopback port literals. No old main or research store touched. */
export async function adaptBaselinePorts(root:string):Promise<void> {
  demand(resolve(root)==='/tmp/ptr-framework-baseline-src','BASELINE_COPY_REQUIRED');
  for(const [relative,oldPort,newPort] of [['packages/storage/src/local-guard.ts','56432','57433'],['packages/messaging/src/local-guard.ts','56479','57480']]) {
    const path=join(root,relative!),original=await readFile(path,'utf8');
    demand(original.includes(`'${oldPort}'`)||original.includes(`'${newPort}'`),'BASELINE_GUARD_MISMATCH');
    if(original.includes(`'${oldPort}'`))await writeFile(path,original.replace(`'${oldPort}'`,`'${newPort}'`));
  }
}
async function scrape(fleet:FrameworkFleet):Promise<string> {return (await fetch(`${fleet.workerMetricsBase}/metrics/prom`,{signal:AbortSignal.timeout(3000)})).text();}
export async function measuredStage(fleet:FrameworkFleet,source:NodeJS.ProcessEnv,personId:string,turns:number=LOAD_GATE.measuredTurns,concurrency:number=LOAD_GATE.clientConcurrency,traceSessions:string[]=[]):Promise<LoadSummary> {
  demand(Number.isInteger(turns)&&turns>0&&turns<=64&&Number.isInteger(concurrency)&&concurrency>0&&concurrency<=8,'BOUNDED_LOAD_REQUIRED');
  const sessions:string[]=[];for(let n=0;n<turns;n++)sessions.push(await createSession(fleet,personId));
  traceSessions.push(...sessions);
  const beforeCounts=await engineCounts(source),beforeMetrics=await scrape(fleet),started=performance.now();
  const latencies:number[]=[],ids:string[]=[],outputHashes=new Set<string>();let cursor=0,active=0,peak=0,errors=0,nonFallbackOutputs=0;
  await Promise.all(Array.from({length:concurrency},async()=>{
    for(;;){const n=cursor++;if(n>=turns)break;active++;peak=Math.max(peak,active);const began=performance.now();
      try {const turn=await sendTurn(fleet,sessions[n]!,`load-${n}`);ids.push(turn.id);const final=await waitForTurn(fleet,turn.id);
        if(final.state==='completed') {
          latencies.push(performance.now()-began);
          if(isSyntheticModelReply(final.reply)) {
            nonFallbackOutputs++;outputHashes.add(createHash('sha256').update(JSON.stringify({status:final.reply!.status,content:final.reply!.content,limitations:final.reply!.limitations})).digest('hex'));
          }
        }else errors++;
      } catch {errors++;}finally{active--;}
    }
  }));
  const elapsedMs=performance.now()-started;
  const afterCounts=await engineCounts(source),afterMetrics=await scrape(fleet);
  // Before/after scrapes do not sample the timed stage. A nonzero endpoint value is only a lower bound;
  // zero endpoints cannot reveal peak concurrency, so report unavailable rather than configured concurrency.
  const workerPeak=workerEndpointPeak(beforeMetrics,afterMetrics);
  const pool=new Pool({connectionString:fleet.env.DATABASE_URL,max:2});let checkpointRows=0,checkpointBytes=0;
  let storage:CheckpointStorage|undefined;
  try {if(!fleet.baseline&&ids.length){storage=await checkpointStorage(pool,ids);checkpointRows=storage.rows;checkpointBytes=storage.bytes;}}finally{await pool.end();}
  return {turns,completed:latencies.length,errors,elapsedMs:Math.round(elapsedMs),completedPerSecond:latencies.length/(elapsedMs/1000),
    latencyMs:{p50:percentile(latencies,50),p95:percentile(latencies,95),p99:percentile(latencies,99)},
    clientPeakConcurrency:peak,workerPeakConcurrency:workerPeak,workerPeakConcurrencyLowerBound:true,
    modelSubmissions:afterCounts.submitted!-beforeCounts.submitted!,modelSuccesses:afterCounts.success!-beforeCounts.success!,
    modelFailures:afterCounts.failed!-beforeCounts.failed!,modelTimeouts:afterCounts.timeout!-beforeCounts.timeout!,nonFallbackOutputs,
    modelOutputHashes:[...outputHashes].sort(),...(storage?{checkpointStorage:storage}:{}),providerTTFT:null,
    queueWaitUpperBoundSeconds:{p50:histogramQuantile(beforeMetrics,afterMetrics,'ptr_turn_queue_wait_seconds',50),p95:histogramQuantile(beforeMetrics,afterMetrics,'ptr_turn_queue_wait_seconds',95)},
    checkpointRows,checkpointBytes,traceCount:null,observations:null,stageNames:[],stageLatencyMs:{}};
}
async function runTopology(source:NodeJS.ProcessEnv,key:NodeJS.ProcessEnv,baselineEnv:NodeJS.ProcessEnv|undefined,baseline:boolean):Promise<LoadSummary> {
  const root=baseline?'/tmp/ptr-framework-baseline-src':resolve('.'),directory=await mkdtemp(join(tmpdir(),'ptr-fw-load-')),run=randomBytes(4).toString('hex');
  const data=fixtures(run);let env=frameworkEnvironment(source,key,join(directory,'personas.json'),`fw-load-${run}`);
  if(baseline) {
    demand(baselineEnv?.BASELINE_DATABASE_URL&&baselineEnv.BASELINE_REDIS_URL,'BASELINE_ENV_REQUIRED');
    const redis=new URL(baselineEnv.BASELINE_REDIS_URL);if(redis.pathname===''||redis.pathname==='/')redis.pathname='/0';
    assertSyntheticTargets(baselineEnv.BASELINE_DATABASE_URL,redis.href,true);await adaptBaselinePorts(root);
    env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',PTR_DEMO_SCALING:'1',
      DATABASE_URL:baselineEnv.BASELINE_DATABASE_URL,PTR_REDIS_URL:redis.href,PTR_PERSONAS_FILE:env.PTR_PERSONAS_FILE,
      PTR_API_TOKEN:env.PTR_API_TOKEN,PTR_API_SYNTHETIC_TOKEN:env.PTR_API_SYNTHETIC_TOKEN,PTR_TURN_QUEUE:env.PTR_TURN_QUEUE,
      PTR_EVENTS_NAMESPACE:env.PTR_EVENTS_NAMESPACE,PTR_DB_POOL_MAX:'8',PTR_QUEUE_MAX_DEPTH:'64',PTR_WORKER_CONCURRENCY:'4',
      PTR_WORKER_REPLICAS_HINT:'1',PTR_LEASE_MS:'15000',PTR_DISPATCH_GRACE_MS:'200',PTR_DISPATCH_INTERVAL_MS:'100',
      PTR_CHAT_PROVIDER:'gateway',PTR_GATEWAY_STRUCTURED:'1',PTR_GATEWAY_TOKEN:randomBytes(24).toString('hex'),PTR_METRICS_PORT:'0',
      PTR_SELFHOSTED_BASE_URL:`http://127.0.0.1:${source.PTR_FAKE_ENGINE_PORT}/v1`,PTR_SELFHOSTED_MODEL:'ptr-synthetic'};
  }
  await migrateAndSeed(root,env,data,baseline);const fleet=new FrameworkFleet(root,env,directory,baseline);
  try {
    if(baseline) {
      const gatewayPort=await freePort();env.PTR_GATEWAY_URL=`http://127.0.0.1:${gatewayPort}/v1`;
      fleet.launch('apps/gateway/src/main.ts',{PTR_GATEWAY_PORT:String(gatewayPort),PTR_GATEWAY_UPSTREAM:'selfhosted',PTR_GATEWAY_MAX_CONCURRENCY:'4',PTR_GATEWAY_MAX_QUEUE:'64',PTR_GATEWAY_PRIMARY_HEADERS_TIMEOUT_MS:'0'});
      await waitFor(async()=>(await fetch(`http://127.0.0.1:${gatewayPort}/healthz`,{signal:AbortSignal.timeout(3000)})).status===200);
      fleet.launch('apps/api/src/dispatcher.ts');
    }
    await fleet.startApi();await fleet.startWorker();
    await measuredStage(fleet,source,data.personas[0]!.personId,LOAD_GATE.warmupTurns,4);
    const traceSessions:string[]=[],traceStart=new Date().toISOString();
    const result=await measuredStage(fleet,source,data.personas[0]!.personId,LOAD_GATE.measuredTurns,LOAD_GATE.clientConcurrency,traceSessions);
    // Trace cardinality/stage checks belong to functional smoke; no API read traffic contaminates the timed stage.
    await fleet.close();
    if(!baseline){let traces:Awaited<ReturnType<typeof traceEvidence>>|undefined;await waitFor(async()=>{traces=await traceEvidence(env,traceSessions,traceStart);return traces.count===LOAD_GATE.measuredTurns;},60000,'LOAD_TRACE_INGESTION_TIMEOUT');result.traceCount=traces!.count;result.observations=traces!.observations;result.stageNames=traces!.stageNames;result.stageLatencyMs=traces!.stageLatencyMs;}
    return result;
  }finally{await fleet.close();}
}
export async function loadComparison(source:NodeJS.ProcessEnv,key:NodeJS.ProcessEnv,baselineEnv:NodeJS.ProcessEnv):Promise<Record<string,unknown>> {
  const config=await engineCounts(source);demand(config.effective_delay_ms===LOAD_GATE.expectedDelayMs&&config.prompt_tokens===LOAD_GATE.expectedPromptTokens&&config.completion_tokens===LOAD_GATE.expectedCompletionTokens,'FIXED_ENGINE_DELAY_REQUIRED');
  const baseline=await runTopology(source,key,baselineEnv,true),migration=await runTopology(source,key,undefined,false);
  return {syntheticOnly:true,paidCalls:0,thresholds:LOAD_GATE,baseline,migration,...comparison(baseline,migration),
    unavailable:['providerTTFT: non-streaming migration transport','actual disk/WAL I/O: checkpointBytes measures complete stored row bytes only',
      'worker peak concurrency: before/after endpoints are a lower bound only; null means unavailable, no timed sampling',
      'baseline trace/stage latency: old runtime has no equivalent instrumentation']};
}
if(process.argv[1]?.endsWith('framework-loadtest.ts')) {
  const args=Object.fromEntries(process.argv.slice(2).map(arg=>arg.replace(/^--/,'').split('=')));
  void Promise.all([readGeneratedEnv(args['env-file']??''),readGeneratedEnv(args['app-key-file']??''),readGeneratedEnv(args['baseline-env-file']??'')])
    .then(([source,key,baseline])=>loadComparison(source,key,baseline)).then(result=>{process.stdout.write(`${JSON.stringify(result)}\n`);if(!result.passed)process.exitCode=1;},error=>{
      const code=(error as Error).message;process.stderr.write(`${JSON.stringify({ok:false,code:/^[A-Z_]+$/.test(code)?code:'FRAMEWORK_LOAD_FAILED'})}\n`);process.exitCode=1;
    });
}
