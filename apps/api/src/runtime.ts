import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { ChatService, CoreError, DEFAULT_SAFETY_THRESHOLDS, parsePersonaList, SAFETY_CATEGORIES, type InputSafetyOptions, type IntentClassifierOptions, type PersonaRepository, type TextProvider, type TurnDelivery, type TurnEventSource, type TurnEvents, type TurnLeaseStore } from '@ptr/core';
import { BullMqTurnDelivery, GatewayDirectory, RedisGatewayRegistry, RedisTurnEventSource, RedisTurnEvents, createRedisConnection, parseGatewayAllow,
  registryPrefixFromEnv, type GatewayRegistryReader } from '@ptr/messaging';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository, PostgresRetrieval, PostgresSourceRepository } from '@ptr/storage';
import { DECISION_MODEL_IDS, DEFAULT_JEV_MODEL, DEFAULT_TEXT_MODEL, FakeEmbeddingProvider, JevInputSafetyClassifier, JevIntentClassifier, FakeTextProvider, LatencyInjectedTextProvider, OpenAICompatibleTextProvider, OpenRouterClient, OpenRouterEmbeddingProvider, PostgresBudgetLedger, liveOptionsFromEnvironment, parseLatencyProfile } from '@ptr/providers';
export interface CreativeArtifact {
  id:string;ownerId:string;personId:string;personaRevision:string;sessionId:string;
  kind:'post_draft';origin:'generated';fictional:true;status:'draft';content:string;
  promptRevision:string;provider:string;model:string;createdAt:string;
}
export interface ApiRuntime {
  chat:ChatService;personas:PersonaRepository;provider:TextProvider;
  /** Queued execution: the API reserves and publishes; worker processes execute; the dispatcher recovers. */
  leases:TurnLeaseStore;delivery:TurnDelivery;events:TurnEvents;eventSource:TurnEventSource;
  listPersonas():Promise<Persona[]>;
  saveArtifact(artifact:CreativeArtifact):Promise<void>;
  providerName:string;model:string;close?():Promise<void>;
  /** PTR_CHAT_PROVIDER=gateway with PTR_GATEWAY_DISCOVERY=redis: the gateway list read from the gateway registry (S6). */
  gateways?:GatewayDirectory;
}
/** Fail-open stays visible: one sanitized stderr line per safety fallback (scope, reason class, running count), never text. */
function logSafetyFallback():(event:{scope:'turn'|'draft';reason:string})=>void {
  const counts=new Map<string,number>();
  return ({scope,reason})=>{
    const key=`${scope}:${reason}`;const count=(counts.get(key)??0)+1;counts.set(key,count);
    process.stderr.write(`input_safety_fallback scope=${scope} reason=${reason} count=${count}\n`);
  };
}
/** Gateway base URLs in priority order: `PTR_GATEWAY_URLS` (comma list), else `PTR_GATEWAY_URL` as a list of one. */
export function gatewayBaseUrls(env:NodeJS.ProcessEnv):string[] {
  const urls=(env.PTR_GATEWAY_URLS??env.PTR_GATEWAY_URL??'http://127.0.0.1:56460/v1').split(',').map(url=>url.trim()).filter(Boolean);
  if(!urls.length||urls.length>8) throw new CoreError('INVALID_INPUT');
  return urls;
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
/** Composition only. It never seeds, migrates, imports posts, or calls a live provider at startup. */
export function createRuntime(env:NodeJS.ProcessEnv=process.env,hooks:{onTurnFailure?:(failure:{turnId:string;code:string})=>void;onSafetyFallback?:(event:{scope:'turn'|'draft';reason:string})=>void;
  /** Tests: read the gateway registry from this store instead of Redis. */
  gatewayRegistry?:GatewayRegistryReader}={}):ApiRuntime {
  const databaseUrl=env.GOAL1_DATABASE_URL??env.DATABASE_URL??'';
  const poolMax=env.PTR_DB_POOL_MAX===undefined?undefined:Number(env.PTR_DB_POOL_MAX);
  const pool=createLocalPool(databaseUrl,poolMax===undefined?{}:{max:poolMax});
  // Inline and Postgres-polling execution were removed; fail loudly instead of silently ignoring an old setting.
  if(env.PTR_EXECUTION!==undefined) throw new CoreError('INVALID_INPUT','PTR_EXECUTION was removed: turns always run through Redis workers');
  const redisUrl=env.PTR_REDIS_URL??'';
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
  const fakeText=new FakeTextProvider();const fakeEmbedding=new FakeEmbeddingProvider();
  let provider:TextProvider=fakeText;
  let embed=(text:string,options:{signal:AbortSignal})=>fakeEmbedding.embed([text],options).then(vectors=>vectors[0]!);
  let model='synthetic/fake-text-v1';let embeddingModel=fakeEmbedding.model;
  let gateways:GatewayDirectory|undefined;let stopGateways:(()=>Promise<void>)|undefined;
  const providerName=env.PTR_CHAT_PROVIDER??'fake';
  // One billable client per runtime: chat, embeddings and decisions share its budget ledger and live gates.
  let liveClient:OpenRouterClient|undefined;
  const openRouter=()=>liveClient??=new OpenRouterClient(liveOptionsFromEnvironment({...env,GOAL1_DATABASE_URL:databaseUrl,GOAL1_TEXT_MODEL:env.GOAL1_TEXT_MODEL??env.PTR_MODEL??env.TEXT_MODEL},new PostgresBudgetLedger(pool,databaseUrl)));
  // Load tests only: delay/failure injection is never allowed to wrap a billable provider.
  if(env.PTR_FAKE_LATENCY!==undefined) {
    if(providerName!=='fake') throw new CoreError('INVALID_INPUT');
    provider=new LatencyInjectedTextProvider(fakeText,parseLatencyProfile(env.PTR_FAKE_LATENCY));model=`${model}+latency`;
  }
  if(providerName==='openrouter') {
    const client=openRouter();
    const embedding=new OpenRouterEmbeddingProvider(client);
    provider=client;model=env.GOAL1_TEXT_MODEL??env.PTR_MODEL??env.TEXT_MODEL??DEFAULT_TEXT_MODEL;embeddingModel=embedding.model;
    embed=(text,options)=>embedding.embed([text],options).then(vectors=>vectors[0]!);
  } else if(providerName==='selfhosted') {
    // Goal2: self-hosted vLLM/SGLang through an SSH tunnel. Chat only: there is no real query embedder (see semanticSearch).
    const baseUrl=env.PTR_SELFHOSTED_BASE_URL, selfModel=env.PTR_SELFHOSTED_MODEL;
    if(!baseUrl||!selfModel) throw new CoreError('INVALID_INPUT');
    provider=new OpenAICompatibleTextProvider({baseUrl,model:selfModel,maxOutputTokens:512,timeoutMs:60000,structuredAgentReplies:env.PTR_SELFHOSTED_STRUCTURED==='1'});model=`selfhosted/${selfModel}`;
  } else if(providerName==='gateway') {
    // Scale rework: workers reach every model through the LLM gateway (admission, metrics); the gateway owns the upstream.
    // Several URLs = active–standby gateways: calls use the first and move on when it refuses, resets or drains.
    const seed=gatewayBaseUrls(env), token=env.PTR_GATEWAY_TOKEN??'';
    if(token.length<24) throw new CoreError('INVALID_INPUT');
    let baseUrl:string[]|(()=>string[])=seed;
    const discovery=env.PTR_GATEWAY_DISCOVERY??'static';
    if(discovery!=='static'&&discovery!=='redis') throw new CoreError('INVALID_INPUT');
    if(discovery==='redis') {
      // Gateway registry : every call walks the registry's list (leader → oldest start), the static
      // URLs come last and are the whole list until the first read and during a Redis outage before it (seed/fallback).
      let allow;try {allow=parseGatewayAllow(env.PTR_GATEWAY_ALLOW);} catch {throw new CoreError('INVALID_INPUT','INVALID_PTR_GATEWAY_ALLOW');}
      let reader=hooks.gatewayRegistry;
      if(!reader) {
        const redis=createRedisConnection(redisUrl);redis.on('error',()=>undefined); // reconnects on its own; the list stays as it was
        reader=new RedisGatewayRegistry(redis,registryPrefixFromEnv(env));
        stopGateways=async()=>{redis.disconnect();};
      }
      const directory=new GatewayDirectory(reader,{seed,allow});
      void directory.start();
      const stopRedis=stopGateways;
      stopGateways=async()=>{await directory.close();await stopRedis?.();};
      gateways=directory;baseUrl=()=>directory.urls();
    }
    // Connection resets are retried for keyed turn calls (the turn id makes the resend idempotent at the gateway).
    // Number('') is 0: an empty or blank value is a configuration error, not "off".
    if([env.PTR_GATEWAY_RESET_RETRIES,env.PTR_GATEWAY_RETRY_MIN_REMAINING_MS].some(value=>value!==undefined&&!value.trim())) throw new CoreError('INVALID_INPUT');
    const resetRetries=Number(env.PTR_GATEWAY_RESET_RETRIES??2), retryMinRemainingMs=Number(env.PTR_GATEWAY_RETRY_MIN_REMAINING_MS??5000);
    if(!Number.isInteger(resetRetries)||resetRetries<0||resetRetries>10||!Number.isInteger(retryMinRemainingMs)||retryMinRemainingMs<0||retryMinRemainingMs>60000) throw new CoreError('INVALID_INPUT');
    provider=new OpenAICompatibleTextProvider({baseUrl,model:'gateway',apiKey:token,maxOutputTokens:512,timeoutMs:60000,structuredAgentReplies:env.PTR_GATEWAY_STRUCTURED==='1',
      resetRetries,retryMinRemainingMs});model='gateway';
  } else if(providerName!=='fake') throw new CoreError('INVALID_INPUT');
  // Optional Jev helpers, both default off; any failure falls back to the deterministic rules. With both on, one
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
  // Separate names let a load test run beside other users of the same Redis (and be wiped safely afterwards).
  const queueName=env.PTR_TURN_QUEUE??'turns', namespace=env.PTR_EVENTS_NAMESPACE??'events';
  if(!/^[a-z0-9-]{1,40}$/.test(queueName)||!/^[a-z0-9-]{1,40}$/.test(namespace)) throw new CoreError('INVALID_INPUT');
  const delivery=new BullMqTurnDelivery(redisUrl,{queueName});
  const events=new RedisTurnEvents(redisUrl,{namespace});const eventSource=new RedisTurnEventSource(redisUrl,{namespace});
  // R10: self-hosted and gateway chat embed queries with the fake hash model, whose space holds no licensed source
  // vectors (those are openai/text-embedding-3-small), so semantic search would quietly find nothing. Semantic sessions
  // are refused there instead; real query embeddings would be a new external, paid transfer (docs/data-policy.md).
  const semanticSearch=providerName==='fake'||providerName==='openrouter';
  const chat=new ChatService({store,personas,provider,leases:store,delivery,events,maxQueueDepth:queueMaxDepth,semanticSearch,
    retrieval:new PostgresRetrieval(sources,semanticSearch?{embed,modelRevision:embeddingModel}:undefined),
    ...(intentClassifier?{intentClassifier}:{}),...(inputSafety?{inputSafety,onSafetyFallback:hooks.onSafetyFallback??logSafetyFallback()}:{}),...(hooks.onTurnFailure?{onTurnFailure:hooks.onTurnFailure}:{})});
  return {chat,personas,provider,providerName,model,leases:store,delivery,events,eventSource,...(gateways?{gateways}:{}),
    async listPersonas() {
      const result=await pool.query('SELECT v.document FROM personas p JOIN persona_versions v ON v.persona_id=p.id AND v.revision=p.current_revision ORDER BY p.id');
      const registry=await approvedPersonas();
      return registry.map(selected=>result.rows.map(row=>PersonaSchema.parse(row.document)).find(p=>p.id===selected.id&&p.personId===selected.personId&&p.revision===selected.revision)).filter((p):p is Persona=>Boolean(p));
    },
    async saveArtifact(artifact) {
      const directory=join(process.cwd(),'data','generated');await mkdir(directory,{recursive:true,mode:0o700});
      await writeFile(join(directory,`${artifact.id}.json`),JSON.stringify(artifact,null,2),{flag:'wx',mode:0o600});
    },
    async close() {await Promise.allSettled([delivery.close(),events.close(),eventSource.close(),stopGateways?.()]);await pool.end();},
  };
}
