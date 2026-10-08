import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { ChatService, CoreError, DEFAULT_SAFETY_THRESHOLDS, SAFETY_CATEGORIES, type InputSafetyOptions, type IntentClassifierOptions, type PersonaRepository, type TextProvider, type TurnDelivery, type TurnEventSource, type TurnEvents, type TurnLeaseStore } from '@ptr/core';
import { BullMqTurnDelivery, RedisTurnEventSource, RedisTurnEvents } from '@ptr/messaging';
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
}
/** Fail-open stays visible: one sanitized stderr line per safety fallback (scope, reason class, running count), never text. */
function logSafetyFallback():(event:{scope:'turn'|'draft';reason:string})=>void {
  const counts=new Map<string,number>();
  return ({scope,reason})=>{
    const key=`${scope}:${reason}`;const count=(counts.get(key)??0)+1;counts.set(key,count);
    process.stderr.write(`input_safety_fallback scope=${scope} reason=${reason} count=${count}\n`);
  };
}
/** Composition only. It never seeds, migrates, imports posts, or calls a live provider at startup. */
export function createRuntime(env:NodeJS.ProcessEnv=process.env,hooks:{onTurnFailure?:(failure:{turnId:string;code:string})=>void;onSafetyFallback?:(event:{scope:'turn'|'draft';reason:string})=>void}={}):ApiRuntime {
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
  let approved:Promise<Persona[]>|undefined;
  const approvedPersonas=()=>approved??=readFile(env.PTR_PERSONAS_FILE??'data/research/personas.json','utf8').then(text=>{
    const raw:unknown=JSON.parse(text);if(!Array.isArray(raw))throw new CoreError('PERSONA_UNAVAILABLE');
    return raw.map(value=>PersonaSchema.parse(value));
  });
  const fakeText=new FakeTextProvider();const fakeEmbedding=new FakeEmbeddingProvider();
  let provider:TextProvider=fakeText;
  let embed=(text:string,options:{signal:AbortSignal})=>fakeEmbedding.embed([text],options).then(vectors=>vectors[0]!);
  let model='synthetic/fake-text-v1';let embeddingModel=fakeEmbedding.model;
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
    // Goal2: self-hosted vLLM/SGLang through an SSH tunnel. Chat only; embeddings stay on the fake space.
    const baseUrl=env.PTR_SELFHOSTED_BASE_URL, selfModel=env.PTR_SELFHOSTED_MODEL;
    if(!baseUrl||!selfModel) throw new CoreError('INVALID_INPUT');
    provider=new OpenAICompatibleTextProvider({baseUrl,model:selfModel,maxOutputTokens:512,timeoutMs:60000,structuredAgentReplies:env.PTR_SELFHOSTED_STRUCTURED==='1'});model=`selfhosted/${selfModel}`;
  } else if(providerName==='gateway') {
    // Scale rework: workers reach every model through the LLM gateway (admission, metrics); the gateway owns the upstream.
    const baseUrl=env.PTR_GATEWAY_URL??'http://127.0.0.1:56460/v1', token=env.PTR_GATEWAY_TOKEN??'';
    if(token.length<24) throw new CoreError('INVALID_INPUT');
    provider=new OpenAICompatibleTextProvider({baseUrl,model:'gateway',apiKey:token,maxOutputTokens:512,timeoutMs:60000,structuredAgentReplies:env.PTR_GATEWAY_STRUCTURED==='1'});model='gateway';
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
  const chat=new ChatService({store,personas,provider,leases:store,delivery,events,maxQueueDepth:queueMaxDepth,
    retrieval:new PostgresRetrieval(sources,{embed,modelRevision:embeddingModel}),
    ...(intentClassifier?{intentClassifier}:{}),...(inputSafety?{inputSafety,onSafetyFallback:hooks.onSafetyFallback??logSafetyFallback()}:{}),...(hooks.onTurnFailure?{onTurnFailure:hooks.onTurnFailure}:{})});
  return {chat,personas,provider,providerName,model,leases:store,delivery,events,eventSource,
    async listPersonas() {
      const result=await pool.query('SELECT v.document FROM personas p JOIN persona_versions v ON v.persona_id=p.id AND v.revision=p.current_revision ORDER BY p.id');
      const registry=await approvedPersonas();
      return registry.map(selected=>result.rows.map(row=>PersonaSchema.parse(row.document)).find(p=>p.id===selected.id&&p.personId===selected.personId&&p.revision===selected.revision)).filter((p):p is Persona=>Boolean(p));
    },
    async saveArtifact(artifact) {
      const directory=join(process.cwd(),'data','generated');await mkdir(directory,{recursive:true,mode:0o700});
      await writeFile(join(directory,`${artifact.id}.json`),JSON.stringify(artifact,null,2),{flag:'wx',mode:0o600});
    },
    async close() {await Promise.allSettled([delivery.close(),events.close(),eventSource.close()]);await pool.end();},
  };
}
