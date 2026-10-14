/** Historical research/test composition only. API serving is split-only; this module is not a startup option. */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { ChatService, CoreError, type ChatServiceOptions, DEFAULT_SAFETY_THRESHOLDS, parsePersonaList, SAFETY_CATEGORIES, type InputSafetyOptions, type IntentClassifierOptions, type PersonaRepository, type TextProvider, type TurnDelivery, type TurnEventSource, type TurnEvents, type TurnLeaseStore, type TurnExecutionStore } from '@ptr/core';
import { BullMqTurnDelivery, RedisTurnEventSource, RedisTurnEvents, createRedisConnection } from '@ptr/messaging';
import { createLog, FrameworkTelemetry, frameworkTelemetryConfig, type FrameworkObservation } from '@ptr/ops';
import { CheckpointedTextProvider, GuardrailsClient, AGENT_RUNTIME_REVISION, AGENT_PROMPT_REVISION, REPLY_GUARD_REVISION } from '@ptr/core';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository, PostgresRetrieval, PostgresSourceRepository } from '@ptr/storage';
import { DECISION_MODEL_IDS, DEFAULT_JEV_MODEL, FakeEmbeddingProvider, JevInputSafetyClassifier, JevIntentClassifier, FakeTextProvider, LatencyInjectedTextProvider, OpenAICompatibleTextProvider, OpenRouterClient, PostgresBudgetLedger, liveOptionsFromEnvironment, parseLatencyProfile } from '@ptr/providers';
import type {CreativeArtifact} from './creative-artifact';
export type {CreativeArtifact} from './creative-artifact';
export interface ApiRuntime {
  kind?:'legacy';
  chat:ChatService;personas:PersonaRepository;provider:TextProvider;
  /** Queued execution: the API reserves and publishes; worker processes execute; the worker maintains the durable outbox. */
  leases:TurnLeaseStore;delivery:TurnDelivery;events:TurnEvents;eventSource:TurnEventSource;
  listPersonas():Promise<Persona[]>;
  saveArtifact(artifact:CreativeArtifact):Promise<void>;
  guardrails?:GuardrailsClient;telemetry?:FrameworkTelemetry;billable?:boolean;
  providerName:string;model:string;close?():Promise<void>;
  /** Dependency checks for /api/health (D23): database `SELECT 1` and Redis `PING`, 1 s each. */
  health?():Promise<{database:boolean;redis:boolean}>;

}
export interface FrameworkApiRuntime extends ApiRuntime {executionStore:TurnExecutionStore;oldestPendingAgeSeconds():Promise<number>}

/** Observes the existing ledgered Jev boundary, without exporting decision state/answers or changing retries.
 * Cost/usage are reported receipt metrics, not proof of another transport submission (the ledger may replay).
 */
export function observeJevDecisions(client:Pick<OpenRouterClient,'decide'>,telemetry:Pick<FrameworkTelemetry,'generation'>):Pick<OpenRouterClient,'decide'> {
  return {decide:(request,options)=>telemetry.generation('jev',async span=>{
    const started=performance.now(),model=DECISION_MODEL_IDS.includes(request.model)?request.model:'unknown';
    const metadata={kind:'decision',accounting:'reported-receipt'};
    span.update({model,metadata});
    try {
      const result=await client.decide(request,options);
      const usage=result.usage&&typeof result.usage==='object'&&!Array.isArray(result.usage)?result.usage as Record<string,unknown>:{};
      const count=(value:unknown):number|undefined=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:undefined;
      const input=count(usage.input_tokens)??count(usage.prompt_tokens),output=count(usage.output_tokens)??count(usage.completion_tokens);
      const usageDetails={...(input===undefined?{}:{input}),...(output===undefined?{}:{output})};
      const cost=typeof usage.cost==='number'&&Number.isFinite(usage.cost)&&usage.cost>=0?usage.cost:undefined;
      span.update({...(Object.keys(usageDetails).length?{usageDetails}:{}),...(cost===undefined?{}:{costDetails:{total:cost}})});
      return result;
    } finally {span.update({metadata:{...metadata,totalMs:Math.round(performance.now()-started)}});}
  })};
}
/** Classifier failures stay visible; configured Guardrails serving fails closed rather than bypassing validation. */
function logSafetyFallback():(event:{scope:'turn'|'draft';reason:string})=>void {
  const counts=new Map<string,number>();const log=createLog('api');
  return ({scope,reason})=>{
    const key=`${scope}:${reason}`;const count=(counts.get(key)??0)+1;counts.set(key,count);
    log('input_safety_fallback',{scope,reason,count});
  };
}
/** Resolves false when `check` fails or takes longer than `ms`. */
async function within(check:()=>Promise<unknown>,ms:number):Promise<boolean> {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {return await Promise.race([check().then(()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),ms);})]);}
  catch {return false;}
  finally {clearTimeout(timer);}
}
/**
 * UI catalogue: the generated list (prepare-research) with each authored persona replacing the entry of its personId.
 * Session creation needs exactly one candidate per personId, so duplicates within either list fail.
 */
export function mergePersonaLists(generated:Persona[],authored:Persona[]):Persona[] {
  for(const list of [generated,authored]) if(new Set(list.map(persona=>persona.personId)).size!==list.length) throw new CoreError('PERSONA_UNAVAILABLE');
  const byPerson=new Map(authored.map(persona=>[persona.personId,persona]));
  const merged=generated.map(persona=>byPerson.get(persona.personId)??persona);
  return [...merged,...authored.filter(persona=>!generated.some(entry=>entry.personId===persona.personId))];
}
const readPersonaList=(path:string)=>readFile(path,'utf8').then(text=>{
  const raw:unknown=JSON.parse(text);if(!Array.isArray(raw))throw new CoreError('PERSONA_UNAVAILABLE');
  return raw.map(value=>PersonaSchema.parse(value));
});
/**
 * Generated list (`PTR_PERSONAS_FILE`) merged with the authored list (`PTR_AUTHORED_PERSONAS_FILE`, empty when unset).
 * An authored list bound to a database (`{database, personas}`) must name this runtime's database; plain arrays are
 * still read.
 */
export async function readPersonaCatalogue(env:NodeJS.ProcessEnv,databaseUrl:string):Promise<Persona[]> {
  const authoredFile=env.PTR_AUTHORED_PERSONAS_FILE;
  const [generated,authored]=await Promise.all([readPersonaList(env.PTR_PERSONAS_FILE??'data/research/personas.json'),
    authoredFile?readFile(authoredFile,'utf8').then(text=>parsePersonaList(JSON.parse(text))):{personas:[]}]);
  if('database' in authored&&authored.database!==undefined) {
    let database='';try {database=new URL(databaseUrl).pathname.slice(1);} catch {database='';}
    if(authored.database!==database) throw new CoreError('PERSONA_UNAVAILABLE','The authored persona list belongs to another database');
  }
  return mergePersonaLists(generated,authored.personas);
}
/** Database pool (aliases: GOAL1_DATABASE_URL) and the validated queue/event names shared by all roles. */
function messagingSettings(env:NodeJS.ProcessEnv) {
  const databaseUrl=env.DATABASE_URL??env.GOAL1_DATABASE_URL??'';
  const poolMax=env.PTR_DB_POOL_MAX===undefined?undefined:Number(env.PTR_DB_POOL_MAX);
  const pool=createLocalPool(databaseUrl,poolMax===undefined?{}:{max:poolMax});
  // Separate names let a load test run beside other users of the same Redis (and be wiped safely afterwards).
  const queueName=env.PTR_TURN_QUEUE??'turns', namespace=env.PTR_EVENTS_NAMESPACE??'events';
  if(!/^[a-z0-9-]{1,40}$/.test(queueName)||!/^[a-z0-9-]{1,40}$/.test(namespace)) throw new CoreError('INVALID_INPUT');
  return {databaseUrl,pool,redisUrl:env.PTR_REDIS_URL??'',queueName,namespace};
}
const paidSpilloverPossible=(env:NodeJS.ProcessEnv)=>env.PTR_PAID_SPILLOVER==='1';
/** Composition only. It never seeds, migrates, imports posts, or calls a live provider at startup. */
export function createRuntime(env:NodeJS.ProcessEnv=process.env,hooks:{onTurnFailure?:(failure:{turnId:string;code:string})=>void;onSafetyFallback?:(event:{scope:'turn'|'draft';reason:string})=>void;
  onTurnCompleted?:ChatServiceOptions['onTurnCompleted'];
  telemetry?:FrameworkTelemetry}={}):FrameworkApiRuntime {
  const {databaseUrl,pool,redisUrl,queueName,namespace}=messagingSettings(env);
  // Inline and Postgres-polling execution were removed; fail loudly instead of silently ignoring an old setting.
  if(env.PTR_EXECUTION!==undefined) throw new CoreError('INVALID_INPUT','PTR_EXECUTION was removed: turns always run through Redis workers');
  const queueMaxDepth=Number(env.PTR_QUEUE_MAX_DEPTH??256);
  if(!Number.isInteger(queueMaxDepth)||queueMaxDepth<1) throw new CoreError('INVALID_INPUT');
  const personas=new PostgresPersonaRepository(pool);
  const sources=new PostgresSourceRepository(pool);
  // SQL tests may retain immutable synthetic rows: only the private approved registry is a UI catalogue.
  // Authored personas (scripts/persona.ts publish) live in their own list so prepare-research cannot overwrite them;
  // read once per process, so a publish needs an API restart .
  const authoredFile=env.PTR_AUTHORED_PERSONAS_FILE;
  if(authoredFile&&!existsSync(authoredFile)) throw new CoreError('INVALID_INPUT','PTR_AUTHORED_PERSONAS_FILE is set but the file does not exist');
  let approved:Promise<Persona[]>|undefined;
  const approvedPersonas=()=>approved??=readPersonaCatalogue(env,databaseUrl);
  const telemetry=hooks.telemetry??new FrameworkTelemetry(frameworkTelemetryConfig(env));
  const generation=new AsyncLocalStorage<FrameworkObservation>();
  const fakeText=new FakeTextProvider(),fakeEmbedding=new FakeEmbeddingProvider();
  const embed=(text:string,options:{signal:AbortSignal})=>fakeEmbedding.embed([text],options).then(vectors=>vectors[0]!);
  const providerName=env.PTR_CHAT_PROVIDER??'fake';
  const billable=paidSpilloverPossible(env);
  if(!['fake','local'].includes(providerName))throw new CoreError('INVALID_INPUT','Legacy provider routes were removed');
  if(billable&&(env.GOAL1_LIVE_ENABLED!=='true'||env.GOAL1_ALLOW_EXTERNAL_DATA!=='true'))throw new CoreError('INVALID_INPUT');
  if(providerName==='local'&&billable)throw new CoreError('INVALID_INPUT','Local provider has no TS spillover ledger');
  let model=providerName==='fake'?'synthetic/fake-text-v1':env.PTR_LLM_LOCAL_MODEL??'';
  let provider:TextProvider=fakeText;
  if(env.PTR_FAKE_LATENCY!==undefined) {
    if(providerName!=='fake')throw new CoreError('INVALID_INPUT');
    provider=new LatencyInjectedTextProvider(fakeText,parseLatencyProfile(env.PTR_FAKE_LATENCY));model+='+'+'latency';
  }
  if(providerName==='local') {
    if(!env.PTR_LLM_LOCAL_BASE_URL||!model)throw new CoreError('INVALID_INPUT');
    provider=new OpenAICompatibleTextProvider({baseUrl:env.PTR_LLM_LOCAL_BASE_URL,apiKey:env.PTR_LLM_LOCAL_API_KEY,model,
      structuredAgentReplies:true,onMetrics:metrics=>generation.getStore()?.update({model,metadata:{attempts:metrics.attempts,totalMs:metrics.totalMs}})});
  }
  let guardrails:GuardrailsClient|undefined;
  if(env.PTR_GUARDRAILS_URL||env.PTR_GUARDRAILS_TOKEN) {
    if(!env.PTR_GUARDRAILS_URL||!env.PTR_GUARDRAILS_TOKEN)throw new CoreError('INVALID_INPUT');
    guardrails=new GuardrailsClient({baseUrl:env.PTR_GUARDRAILS_URL,apiKey:env.PTR_GUARDRAILS_TOKEN,timeoutMs:Number(env.PTR_GUARDRAILS_TIMEOUT_MS??2500)});
  }
  if(providerName==='local'&&!guardrails)throw new CoreError('INVALID_INPUT');
  // Domain composition preserves provider identity in offline tests; production calls carry real generation spans.
  if(frameworkTelemetryConfig(env).enabled) {
    const transport=provider;
    provider={generate:(messages,options)=>telemetry.generation('model',span=>generation.run(span,async()=>{
      span.update({model,input:messages});
      const result=await transport.generate(messages,{...options,onUsage:usage=>{
        options.onUsage?.(usage);span.update({usageDetails:{...(usage.promptTokens===null?{}:{input:usage.promptTokens}),
          ...(usage.completionTokens===null?{}:{output:usage.completionTokens})}});
      }});
      span.update({output:result});return result;
    }))};
  }
  // Jev retains its decision-question protocol and explicit paid-data gates, not a duplicate chat gateway.
  let liveClient:Pick<OpenRouterClient,'decide'>|undefined;
  const openRouter=()=>liveClient??=observeJevDecisions(new OpenRouterClient(liveOptionsFromEnvironment({...env,GOAL1_DATABASE_URL:databaseUrl},new PostgresBudgetLedger(pool,databaseUrl))),telemetry);
  // Optional Jev helpers, both default off; configured safety failure fails closed with Guardrails. With both on, one
  // Jev request per turn answers the safety questions and (when the intent gate is open) the intent question.
  let intentClassifier:IntentClassifierOptions|undefined;let inputSafety:InputSafetyOptions|undefined;
  const classifierName=env.PTR_INTENT_CLASSIFIER??'off', safetyName=env.PTR_SAFETY_FILTER??'off';
  if(!['jev','off'].includes(classifierName)||!['jev','off'].includes(safetyName)) throw new CoreError('INVALID_INPUT');
  if(classifierName==='jev'||safetyName==='jev') {
    // Load-test latency injection never runs beside a billable classifier.
    if(env.PTR_FAKE_LATENCY!==undefined) throw new CoreError('INVALID_INPUT');
    const timeoutMs=Number(env.PTR_JEV_TIMEOUT_MS??1500), jevModel=env.PTR_JEV_MODEL??DEFAULT_JEV_MODEL;
    if(!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>10000||!DECISION_MODEL_IDS.includes(jevModel)) throw new CoreError('INVALID_INPUT');
    if(classifierName==='jev') {
      const minConfidence=Number(env.PTR_JEV_MIN_CONFIDENCE??0.6);
      if(!(minConfidence>0&&minConfidence<=1)) throw new CoreError('INVALID_INPUT');
      intentClassifier={classifier:new JevIntentClassifier(openRouter(),jevModel),minConfidence,timeoutMs};
    }
    if(safetyName==='jev') {
      // Per-category thresholds: PTR_SAFETY_THRESHOLD_<CATEGORY> (e.g. PTR_SAFETY_THRESHOLD_SELF_HARM), in (0,1].
      const thresholds={...DEFAULT_SAFETY_THRESHOLDS};
      for(const category of SAFETY_CATEGORIES) {
        const raw=env[`PTR_SAFETY_THRESHOLD_${category.toUpperCase()}`];if(raw===undefined)continue;
        const value=Number(raw);if(!(value>0&&value<=1)) throw new CoreError('INVALID_INPUT');
        thresholds[category]=value;
      }
      // Own deadline: full 4100-code-point windows took p50 625 / max 1244 ms live (2026-10-08), above the intent
      // classifier's 1500 ms comfort margin; short messages still answer in about 400 ms.
      const safetyTimeoutMs=Number(env.PTR_SAFETY_TIMEOUT_MS??2500);
      if(!Number.isInteger(safetyTimeoutMs)||safetyTimeoutMs<50||safetyTimeoutMs>10000) throw new CoreError('INVALID_INPUT');
      inputSafety={classifier:new JevInputSafetyClassifier(openRouter(),jevModel),thresholds,timeoutMs:safetyTimeoutMs};
    }
  }
  const store=new PostgresConversationStore(pool);
  // Health (D23): its own Redis connection, opened on the first check (composing a runtime opens none).
  let pingConnection:ReturnType<typeof createRedisConnection>|undefined;
  const ping=()=>{if(!pingConnection) {pingConnection=createRedisConnection(redisUrl);pingConnection.on('error',()=>undefined);}return pingConnection.ping();};
  const delivery=new BullMqTurnDelivery(redisUrl,{queueName});
  const events=new RedisTurnEvents(redisUrl,{namespace});const eventSource=new RedisTurnEventSource(redisUrl,{namespace});
  // Only synthetic vectors have the matching fake query embedder; no hashes against real source embeddings.
  const semanticSearch=providerName==='fake';
  // Only costly self-hosted turn calls get a minimal durable response checkpoint. Paid chat/Jev already
  // have independent request ledgers; drafts keep the unwrapped provider. Cheap graph stages restart.
  const turnProvider=providerName==='local'&&!billable
    ?new CheckpointedTextProvider(provider,{checkpointer:new PostgresSaver(pool),
      identity:JSON.stringify({revision:'local-turn-receipt-v1',baseUrl:env.PTR_LLM_LOCAL_BASE_URL,
        model,maxOutputTokens:512,temperature:0,structuredOutput:'agent-json-schema-v1'})})
    :provider;
  const chat=new ChatService({store,personas,provider:turnProvider,leases:store,delivery,events,maxQueueDepth:queueMaxDepth,semanticSearch,
    ...(guardrails?{guardrails}:{}),
    observeStage:(name,work)=>telemetry.stage(name,()=>work()),
    observeTurn:async(queued,work)=>{
      const session=await store.getOwnedSession(queued.turn.sessionId,queued.turn.ownerId);
      return telemetry.turn({turnId:queued.turn.id,sessionId:queued.turn.sessionId,personId:session?.personId??'unknown',
        userId:queued.turn.ownerId,input:queued.input.text,versions:{prompt:AGENT_PROMPT_REVISION,runtime:AGENT_RUNTIME_REVISION,
          guard:REPLY_GUARD_REVISION,persona:session?.personaRevision??'unknown'}},async span=>{
          const value=await work();
          const result=await store.getTurn(queued.turn.id,queued.turn.ownerId).catch(()=>undefined);
          const summary={state:result?.state??'unknown',outcome:result&&['completed','failed','cancelled'].includes(result.state)?result.state:'interrupted',
            errorCode:result?.errorCode??null,status:result?.reply?.status??null,limitations:result?.reply?.limitations??[],
            guard:result?.reply?.replyGuard?.action??null,safety:result?.reply?.inputSafety?.action??null,
            agentSteps:result?.reply?.agent?.steps.length??null,model};
          span.update({metadata:summary});return value;
        });
    },
    retrieval:new PostgresRetrieval(sources,semanticSearch?{embed,modelRevision:fakeEmbedding.model}:undefined),
    ...(intentClassifier?{intentClassifier}:{}),...(inputSafety?{inputSafety,onSafetyFallback:hooks.onSafetyFallback??logSafetyFallback()}:{}),...(hooks.onTurnFailure?{onTurnFailure:hooks.onTurnFailure}:{}),
    ...(hooks.onTurnCompleted?{onTurnCompleted:hooks.onTurnCompleted}:{})});
  return {chat,personas,provider,providerName,model,telemetry,...(guardrails?{guardrails}:{}),billable,leases:store,executionStore:store,delivery,events,eventSource,
    async oldestPendingAgeSeconds() {
      const result=await pool.query('SELECT COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::float8 AS age FROM turn_outbox');
      return Math.max(0,Number(result.rows[0]?.age??0));
    },
    async health() {
      const [database,redis]=await Promise.all([within(()=>pool.query('SELECT 1'),1000),within(ping,1000)]);
      return {database,redis};
    },
    async listPersonas() {
      const result=await pool.query('SELECT v.document FROM personas p JOIN persona_versions v ON v.persona_id=p.id AND v.revision=p.current_revision ORDER BY p.id');
      const registry=await approvedPersonas();
      return registry.map(selected=>result.rows.map(row=>PersonaSchema.parse(row.document)).find(p=>p.id===selected.id&&p.personId===selected.personId&&p.revision===selected.revision)).filter((p):p is Persona=>Boolean(p));
    },
    async saveArtifact(artifact) {
      const directory=join(process.cwd(),'data','generated');await mkdir(directory,{recursive:true,mode:0o700});
      await writeFile(join(directory,`${artifact.id}.json`),JSON.stringify(artifact,null,2),{flag:'wx',mode:0o600});
    },
    async close() {pingConnection?.disconnect();await Promise.allSettled([delivery.close(),events.close(),eventSource.close(),telemetry.shutdown()]);await pool.end();},
  };
}
