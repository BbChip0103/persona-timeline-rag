/** Metadata-only acceptance of the explicitly owned research deployment. Never starts/stops services. */
import { createHmac, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname, join } from 'node:path';
import { Pool } from 'pg';
import { assertLocalDatabaseUrl } from '../packages/storage/src/local-guard';
const runFile=promisify(execFile);
const OUTPUT='/tmp/ptr-operational-cutover-20261011/e2e';
function check(value:unknown,code:string):asserts value {if(!value)throw new Error(code);}
function record(value:unknown):Record<string,unknown>{check(value!==null&&typeof value==='object'&&!Array.isArray(value),'INVALID_OBJECT');return value as Record<string,unknown>;}
function string(value:unknown):string {check(typeof value==='string'&&value.length>0,'INVALID_STRING');return value;}
function localUrl(raw:string):string {const url=new URL(raw);check(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port&&!url.username&&!url.password&&!url.search&&!url.hash,'NONLOCAL_SERVICE');return url.toString().replace(/\/$/,'');}
export function operationalConfig(env:NodeJS.ProcessEnv,execute=false,nonce?:string){
  const get=(key:string)=>string(env[`PTR_OPERATIONAL_${key}`]);
  const ownerNonce=get('OWNER_NONCE');check(/^[a-zA-Z0-9_-]{16,80}$/.test(ownerNonce),'INVALID_OWNER_NONCE');
  check(!execute||nonce===ownerNonce,'OWNER_NONCE_MISMATCH');
  const callCap=Number(get('MODEL_CALL_CAP')),maxOutputTokens=Number(get('MAX_OUTPUT_TOKENS'));
  check(Number.isInteger(callCap)&&callCap>=9&&callCap<=12,'MODEL_CALL_CAP');
  check(Number.isInteger(maxOutputTokens)&&maxOutputTokens>=64&&maxOutputTokens<=512,'OUTPUT_TOKEN_CAP');
  const db=(key:string,role:string)=>{const raw=assertLocalDatabaseUrl(get(key)),url=new URL(raw);check(url.pathname==='/ptr_split_research'&&decodeURIComponent(url.username)===role,'EXACT_RESEARCH_ROLE_REQUIRED');return raw;};
  const apiToken=get('API_TOKEN');check(apiToken.length>=24&&apiToken.length<=512,'SYNTHETIC_TOKEN_REQUIRED');
  check(new URL(get('MODEL_METRICS_URL')).pathname==='/metrics','EXACT_NATIVE_METRICS_PATH');
  const manifest=resolve(get('DEPLOYMENT_MANIFEST'));check(manifest.startsWith('/tmp/ptr-operational-cutover-20261011/'),'PRIVATE_MANIFEST_PATH');
  return {execute,ownerNonce,callCap,maxOutputTokens,apiToken,manifest,output:OUTPUT,
    backend:localUrl(get('BACKEND_URL')),worker:localUrl(get('WORKER_URL')),gateway:localUrl(get('GATEWAY_URL')),
    modelMetrics:localUrl(get('MODEL_METRICS_URL')),metricsToken:get('MODEL_METRICS_TOKEN'),
    appDatabase:db('APP_DATABASE_URL','ptr_split_app'),llmDatabase:db('LLM_DATABASE_URL','ptr_split_llm')};
}
type Config=ReturnType<typeof operationalConfig>;
export function privateMetadata(id:string,content:string,nonce:string){const digest=(v:string)=>createHmac('sha256',nonce).update(v).digest('hex');return {reference:digest(id),contentDigest:digest(content),bytes:Buffer.byteLength(content)};}
export function parseNativeMetrics(text:string){
  const values=new Map<string,number>();
  const used=new Set(['request_success_total','request_failure_total','num_requests_running','num_requests_waiting','prompt_tokens_total','generation_tokens_total'].map(name=>`vllm:${name}`));
  const labels=/^\{(?:[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\["\\n])*"(?:,\s*[a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\\n]|\\["\\n])*")*,?)?\}$/;
  for(const raw of text.split('\n')){
    const line=raw.trim(),family=/^(vllm:[a-zA-Z0-9_]+)/.exec(line)?.[1];if(!family||!used.has(family))continue;
    const match=/^(vllm:[a-zA-Z0-9_]+)(\{.*\})?\s+([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:\s+([+-]?\d+))?$/.exec(line);
    check(match&&(!match[2]||labels.test(match[2])),'INVALID_NATIVE_METRIC');
    const value=Number(match[3]),sum=(values.get(family)??0)+value;
    check(Number.isFinite(value)&&value>=0&&Number.isFinite(sum)&&(!match[4]||Number.isSafeInteger(Number(match[4]))),'INVALID_NATIVE_METRIC');values.set(family,sum);
  }
  check(values.has('vllm:request_success_total'),'NATIVE_SUCCESS_METRIC_MISSING');
  const optional=(key:string)=>values.get(`vllm:${key}`)??null;
  return {successes:values.get('vllm:request_success_total')!,errors:optional('request_failure_total'),running:optional('num_requests_running'),waiting:optional('num_requests_waiting'),promptTokens:optional('prompt_tokens_total'),generationTokens:optional('generation_tokens_total')};
}
type Metrics=ReturnType<typeof parseNativeMetrics>;
export class AdmissionBudget {submissions=0;constructor(readonly cap:number){check(Number.isInteger(cap)&&cap>=1&&cap<=3,'DISTINCT_TURN_CAP');}reserve(){check(this.submissions<this.cap,'LOCAL_SUBMISSION_CAP');this.submissions++;}}
interface Service {name:string;id:string;image:string;ownerLabel:string}
export function validateManifest(value:unknown,nonce:string){const body=record(value);check(body.ownerNonce===nonce,'DEPLOYMENT_OWNER_MISMATCH');const project=string(body.project);check(Array.isArray(body.services),'DEPLOYMENT_SERVICES_REQUIRED');const services:Service[]=body.services.map(value=>{const row=record(value);check(row.ownerLabel===nonce,'DEPLOYMENT_SERVICE_OWNER');return {name:string(row.name),id:string(row.id),image:string(row.image),ownerLabel:nonce};});check(['api','worker','model-gateway'].every(name=>services.filter(s=>s.name===name).length===1),'DEPLOYMENT_THREE_TIERS_REQUIRED');return {project,services};}
export function validateSignal(value:unknown,nonce:string,phase:string,requestNonce?:string){const body=record(value);check(body.ownerNonce===nonce&&body.phase===phase&&(!requestNonce||body.requestNonce===requestNonce),'PARENT_SIGNAL_MISMATCH');return true;}
interface Proof {state:string;assistants:number;outbox:number;grants:number;acknowledged:number}
export function completedProof(value:Proof){return value.state==='completed'&&value.assistants===1&&value.outbox===0&&value.grants===1&&value.acknowledged===1;}
async function privateJson(path:string){const stat=await fs.lstat(path);check(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'PRIVATE_FILE_PERMISSIONS');return JSON.parse(await fs.readFile(path,'utf8')) as unknown;}
async function writePrivate(path:string,body:unknown){await fs.mkdir(dirname(path),{recursive:true,mode:0o700});const dir=await fs.lstat(dirname(path));check(dir.isDirectory()&&!dir.isSymbolicLink()&&(dir.mode&0o077)===0,'PRIVATE_DIRECTORY_PERMISSIONS');const temp=`${path}.tmp-${process.pid}`;await fs.writeFile(temp,JSON.stringify(body,null,2)+'\n',{mode:0o600,flag:'wx'});await fs.rename(temp,path);}
export function validateModelPolicy(value:unknown,callCap:number,maxOutputTokens:number){const raw=record(value);check(raw.qualificationCallCap===callCap&&raw.providerAdmissionHardCap===null&&raw.maxOutputTokens===maxOutputTokens&&raw.primaryOnly===true&&raw.automaticRetries===0&&raw.gatewayRetries===0&&raw.maxModelAttemptsPerTurn===3,'DEPLOYMENT_MODEL_POLICY_PROOF_REQUIRED');return true;}
async function ownership(config:Config){const raw=record(await privateJson(config.manifest));const manifest=validateManifest(raw,config.ownerNonce);if(config.execute){validateModelPolicy(raw,config.callCap,config.maxOutputTokens);}for(const service of manifest.services){const {stdout}=await runFile('docker',['inspect',service.id],{timeout:10000,maxBuffer:1024*1024});const inspected=record((JSON.parse(stdout) as unknown[])[0]),settings=record(inspected.Config),labels=record(settings.Labels);check(labels['ptr.operational.owner']===config.ownerNonce&&labels['com.docker.compose.project']===manifest.project&&labels['com.docker.compose.service']===service.name,'ACTUAL_DEPLOYMENT_OWNER_MISMATCH');check(settings.Image===service.image||inspected.Image===service.image,'ACTUAL_DEPLOYMENT_IMAGE_MISMATCH');}return {servicesVerified:manifest.services.length};}
const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));
export interface SmokeDependencies {fetch?:typeof fetch;app?:Pool;llm?:Pool;verifyOwnership?:(config:Config)=>Promise<unknown>;persist?:(path:string,body:unknown)=>Promise<void>;delay?:(ms:number)=>Promise<void>;parentSignal?:(phase:string,requestNonce:string)=>Promise<unknown>;}
export async function operationalSmoke(config:Config,dependencies:SmokeDependencies={}){
  const fetch=dependencies.fetch??globalThis.fetch,persist=dependencies.persist??writePrivate,sleep=dependencies.delay??delay;
  const app=dependencies.app??new Pool({connectionString:config.appDatabase,connectionTimeoutMillis:3000,statement_timeout:3000}),llm=dependencies.llm??new Pool({connectionString:config.llmDatabase,connectionTimeoutMillis:3000,statement_timeout:3000});
  const owner=`lt-ops-${createHmac('sha256',config.ownerNonce).update('actor').digest('hex').slice(0,20)}`,alien=`lt-ops-${createHmac('sha256',config.ownerNonce).update('alien').digest('hex').slice(0,20)}`;
  const report:Record<string,unknown>={schema:1,mode:config.execute?'actual-operational':'preflight-no-generation',passed:false,rag:'off',executionProfile:'agent_loop',callCap:config.callCap,distinctTurnCap:3,maxModelAttemptsPerTurn:3,gatewayRetries:0,sdkAutomaticRetries:0,maxOutputTokens:config.maxOutputTokens,admissionCounts:null,errorCounterSupported:false,semantic:'not-run',stages:[]};
  const stages=report.stages as unknown[];const statuses:Record<string,number>={};let finalMetrics:Metrics|undefined;let initialMetrics:Metrics|undefined;
  const budget=new AdmissionBudget(Math.min(3,Math.floor(config.callCap/3)));
  const request=async(url:string,method='GET',body?:unknown,actor=owner,auth=true)=>{const response=await fetch(url,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{...(auth?{Authorization:`Bearer ${config.apiToken}`,'X-PTR-Owner':actor}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});statuses[String(response.status)]=(statuses[String(response.status)]??0)+1;return response;};
  const api=async(path:string,method='GET',body?:unknown,actor=owner)=>{const response=await request(`${config.backend}/api/${path}`,method,body,actor);check(response.ok,'API_REQUEST_FAILED');return record(await response.json());};
  const native=async()=>{const response=await fetch(config.modelMetrics,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${config.metricsToken}`}});check(response.ok,'NATIVE_METRICS_UNAVAILABLE');return parseNativeMetrics(await response.text());};
  const paid=async()=>{const result=await llm.query<{total:string;embeddings:string;committed:string}>(`SELECT COUNT(*)::text AS total,COUNT(*) FILTER(WHERE request_kind LIKE '%embedding%')::text AS embeddings,COALESCE(SUM(CASE WHEN state='settled' THEN COALESCE(actual_microusd,reserved_microusd) ELSE GREATEST(reserved_microusd,COALESCE(actual_microusd,0)) END),0)::text AS committed FROM llm.ptr_provider_requests`);return result.rows[0]!;};
  const proof=async(id:string):Promise<Proof>=>{const result=await app.query<{state:string;assistants:number;outbox:number}>(`SELECT t.state,(SELECT count(*)::int FROM app.messages m WHERE m.turn_id=t.id AND m.role='assistant') AS assistants,(SELECT count(*)::int FROM app.turn_outbox o WHERE o.turn_id=t.id) AS outbox FROM app.turns t WHERE t.id=$1 AND t.owner_id=$2`,[id,owner]);check(result.rows.length===1,'OWN_TURN_MISSING');const grants=await app.query<{execution_id:string}>(`SELECT execution_id FROM app.turn_execution_grants WHERE turn_id=$1 AND result_hash IS NOT NULL`,[id]);const receipts=await llm.query<{count:number}>(`SELECT count(*)::int AS count FROM llm.result_receipts WHERE execution_id=ANY($1::text[]) AND acknowledged_at IS NOT NULL`,[grants.rows.map(row=>row.execution_id)]);return {...result.rows[0]!,grants:grants.rowCount??0,acknowledged:receipts.rows[0]!.count};};
  const phase=async(name:string,requestNonce:string)=>persist(join(config.output,'phase.json'),{ownerNonce:config.ownerNonce,phase:name,requestNonce});
  const signal=async(name:string)=>{const requestNonce=randomUUID();await phase(`await-${name}`,requestNonce);if(dependencies.parentSignal){validateSignal(await dependencies.parentSignal(name,requestNonce),config.ownerNonce,name,requestNonce);return;}const deadline=Date.now()+180000;while(Date.now()<deadline){try{validateSignal(await privateJson(join(config.output,`${name}.json`)),config.ownerNonce,name,requestNonce);return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await sleep(300);}throw new Error('PARENT_SIGNAL_TIMEOUT');};
  try {
    await (dependencies.verifyOwnership??ownership)(config);
    for(const [pool,role] of [[app,'ptr_split_app'],[llm,'ptr_split_llm']] as const){const result=await pool.query<{db:string;role:string}>('SELECT current_database() AS db,current_user AS role');check(result.rows[0]?.db==='ptr_split_research'&&result.rows[0]?.role===role,'ACTUAL_DATABASE_IDENTITY');}
    for(const [url,path] of [[config.backend,'/api/health'],[config.worker,'/health/ready'],[config.gateway,'/health/readiness']]){const response=await request(`${url}${path}`,'GET',undefined,owner,false);check(response.ok,'SERVICE_NOT_READY');await response.body?.cancel();}
    const unauth=await request(`${config.backend}/api/personas`,'GET',undefined,owner,false);check(unauth.status===403,'UNAUTHENTICATED_CATALOGUE_NOT_DENIED');await unauth.body?.cancel();
    initialMetrics=await native();check(initialMetrics.running===0&&initialMetrics.waiting===0,'NATIVE_ENGINE_NOT_IDLE');
    report.preflight={ownedThreeTiers:true,exactResearchRoles:true,readiness:true,unauthenticatedDenied:true};
    if(!config.execute){report.passed=true;return report;}
    // Catalogue is read once into memory; neither IDs nor labels/revisions are saved or logged.
    const catalogue=await api('personas');check(Array.isArray(catalogue.personas),'CATALOGUE_INVALID');const candidate=catalogue.personas.map(record).find(row=>['synthetic','silver','human_reviewed'].includes(String(row.reviewStatus)));check(candidate,'PUBLISHED_PERSONA_REQUIRED');const personId=string(candidate.personId);
    const paidBefore=await paid();
    const session=async()=>string(record((await api('sessions','POST',{personId,retrievalMode:'off',executionProfile:'agent_loop'})).session).id);
    const submit=async(sessionId:string,clientRequestId:string,reserve=true)=>{if(reserve)budget.reserve();const turn=record((await api(`sessions/${encodeURIComponent(sessionId)}/turns`,'POST',{clientRequestId,text:'짧게 인사만 해 주세요.',intent:'small_talk'})).turn);return string(turn.id);};
    const finish=async(id:string)=>{const deadline=Date.now()+180000;let metadata:unknown;while(Date.now()<deadline){const turn=record((await api(`turns/${encodeURIComponent(id)}`)).turn);check(!['failed','cancelled'].includes(string(turn.state)),'TURN_DID_NOT_COMPLETE');if(turn.state==='completed'){const reply=record(turn.reply);check(reply.status==='answered'&&typeof reply.content==='string'&&reply.content.trim().length>0,'INVALID_PUBLIC_REPLY');check(Array.isArray(reply.evidence)&&reply.evidence.length===0&&!('agent'in reply)&&!('sourceContext'in reply),'PUBLIC_REPLY_PRIVATE_OR_RAG_FIELDS');check(Array.isArray(reply.limitations)&&reply.limitations.length===0,'PUBLIC_REPLY_POLICY_FALLBACK');metadata=privateMetadata(id,reply.content,config.ownerNonce);const receipt=await proof(id);if(completedProof(receipt))return {metadata,proof:receipt};}await sleep(300);}throw new Error('TURN_ACK_DEADLINE');};
    const sid=await session(),id=await submit(sid,'ops_complete');
    const denied=await request(`${config.backend}/api/turns/${encodeURIComponent(id)}`,'GET',undefined,alien);check(denied.status===404,'OWNER_ISOLATION_FAILED');await denied.body?.cancel();
    const deniedCancel=await request(`${config.backend}/api/turns/${encodeURIComponent(id)}/cancel`,'POST',{},alien);check(deniedCancel.status===404,'OWNER_CANCEL_ISOLATION_FAILED');await deniedCancel.body?.cancel();
    stages.push({stage:'completed',...await finish(id),ownerIsolation:true});
    const beforeIdempotent=await native();check(await submit(sid,'ops_complete',false)===id,'IDEMPOTENCE_TURN_CHANGED');await sleep(1500);const afterIdempotent=await native();check(afterIdempotent.successes===beforeIdempotent.successes,'IDEMPOTENCE_EXTRA_GENERATION');check(completedProof(await proof(id)),'IDEMPOTENCE_EXACTLY_ONCE_FAILED');stages.push({stage:'idempotent',extraSuccessfulGenerations:0});
    await signal('worker-paused');
    const cancellationMetrics=await native();const cancelled=await submit(await session(),'ops_cancel');check(record((await api(`turns/${encodeURIComponent(cancelled)}`)).turn).state==='pending','WORKER_NOT_PAUSED');check((await api(`turns/${encodeURIComponent(cancelled)}/cancel`,'POST',{})).cancelled===true,'CANCEL_REJECTED');
    const cancelProof=await proof(cancelled);check(cancelProof.state==='cancelled'&&cancelProof.assistants===0&&cancelProof.outbox===0,'CANCELLATION_NOT_DURABLE');check((await native()).successes===cancellationMetrics.successes,'CANCELLATION_GENERATED');stages.push({stage:'cancelled',proof:cancelProof,extraSuccessfulGenerations:0});
    const recovery=await submit(await session(),'ops_recovery');const pending=await proof(recovery);check(pending.state==='pending'&&pending.outbox===1&&pending.assistants===0,'RECOVERY_NOT_STAGED');await signal('backend-restarted');check(record((await api(`turns/${encodeURIComponent(recovery)}`)).turn).state==='pending','BACKEND_RESTART_NOT_READY');const afterRestart=await proof(recovery);check(afterRestart.state==='pending'&&afterRestart.outbox===1,'BACKEND_RESTART_LOST_PENDING');await signal('worker-resumed');stages.push({stage:'recovery',...await finish(recovery),backendRestartPersisted:true});
    finalMetrics=await native();const successDelta=finalMetrics.successes-initialMetrics.successes;check(successDelta>=2&&successDelta<=config.callCap,'NATIVE_SUCCESS_CAP_OR_COUNT');check(finalMetrics.running===0&&finalMetrics.waiting===0,'NATIVE_ENGINE_NOT_DRAINED');const paidAfter=await paid();report.providerRequestRows={before:paidBefore.total,after:paidAfter.total};check(/^\d+$/.test(paidBefore.total)&&paidAfter.total===paidBefore.total,'RAG_OFF_AUXILIARY_SUBMISSION');check(paidAfter.embeddings===paidBefore.embeddings&&paidAfter.committed===paidBefore.committed,'RAG_OFF_PAID_OR_EMBEDDING_CALL');
    report.paid={providerRequestRowsDelta:0,embeddingRowsDelta:0,committedMicrousdDelta:0};report.passed=true;
    return report;
  } catch(error) {const message=error instanceof Error?error.message:'';report.errorCode=/^[A-Z][A-Z0-9_]{1,80}$/.test(message)?message:'OPERATIONAL_SMOKE_FAILED';throw error;
  } finally {
    if(config.execute&&initialMetrics&&!finalMetrics){try{finalMetrics=await native();}catch{report.finalMetricsUnavailable=true;}}
    report.localDistinctTurnSubmissions=budget.submissions;report.modelCallCreditsReserved=budget.submissions*3;report.nativeCounters={before:initialMetrics??null,after:finalMetrics??null,successDelta:initialMetrics&&finalMetrics?finalMetrics.successes-initialMetrics.successes:null,admissions:null,errorDelta:initialMetrics?.errors!==null&&finalMetrics?.errors!==null&&initialMetrics&&finalMetrics?finalMetrics.errors!-initialMetrics.errors!:null};report.httpStatusCounts=statuses;
    try{await persist(join(config.output,'summary.json'),report);}finally{await Promise.all([app.end(),llm.end()]);}
  }
}
async function main(){const args=process.argv.slice(2);for(let i=0;i<args.length;i++){check(['--env-file','--execute','--owner-nonce'].includes(args[i]!),'UNKNOWN_ARGUMENT');if(args[i]!=='--execute'){check(Boolean(args[i+1])&&!args[i+1]!.startsWith('--'),'ARGUMENT_VALUE_REQUIRED');i++;}}const envFile=args[args.indexOf('--env-file')+1];check(args.includes('--env-file')&&envFile,'EXPLICIT_PRIVATE_ENV_REQUIRED');const stat=await fs.lstat(envFile);check(stat.isFile()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'PRIVATE_ENV_PERMISSIONS');const env:NodeJS.ProcessEnv={};for(const line of (await fs.readFile(envFile,'utf8')).split('\n')){const match=/^(PTR_OPERATIONAL_[A-Z_]+)=(.*)$/.exec(line);if(match){let value=match[2]!;if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1);env[match[1]!]=value;}}
  const config=operationalConfig(env,args.includes('--execute'),args.includes('--owner-nonce')?args[args.indexOf('--owner-nonce')+1]:undefined);
  const report=await operationalSmoke(config);process.stdout.write(JSON.stringify({passed:report.passed,mode:report.mode,artifact:join(OUTPUT,'summary.json')})+'\n');}
if(require.main===module)void main().catch(async error=>{const message=error instanceof Error?error.message:'';const code=/^[A-Z][A-Z0-9_]{1,80}$/.test(message)?message:'OPERATIONAL_SMOKE_FAILED';process.stderr.write(code+'\n');process.exitCode=1;});
