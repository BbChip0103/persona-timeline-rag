import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { ChatService, CoreError, type IntentClassifierOptions, type PersonaRepository, type TextProvider, type TurnDelivery, type TurnEventSource, type TurnEvents, type TurnLeaseStore } from '@ptr/core';
import { BullMqTurnDelivery, RedisTurnEventSource, RedisTurnEvents } from '@ptr/messaging';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository, PostgresRetrieval, PostgresSourceRepository } from '@ptr/storage';
import { DECISION_MODEL_IDS, DEFAULT_JEV_MODEL, DEFAULT_TEXT_MODEL, FakeEmbeddingProvider, JevIntentClassifier, FakeTextProvider, LatencyInjectedTextProvider, OpenAICompatibleTextProvider, OpenRouterClient, OpenRouterEmbeddingProvider, PostgresBudgetLedger, liveOptionsFromEnvironment, parseLatencyProfile } from '@ptr/providers';
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
/** Composition only. It never seeds, migrates, imports posts, or calls a live provider at startup. */
export function createRuntime(env:NodeJS.ProcessEnv=process.env,hooks:{onTurnFailure?:(failure:{turnId:string;code:string})=>void}={}):ApiRuntime {
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
  // Optional ambiguity-only intent classifier (default off). Any failure falls back to the deterministic rules.
  let intentClassifier:IntentClassifierOptions|undefined;
  const classifierName=env.PTR_INTENT_CLASSIFIER??'off';
  if(classifierName==='jev') {
    // Load-test latency injection never runs beside a billable classifier.
    if(env.PTR_FAKE_LATENCY!==undefined) throw new CoreError('INVALID_INPUT');
    const minConfidence=Number(env.PTR_JEV_MIN_CONFIDENCE??0.6), timeoutMs=Number(env.PTR_JEV_TIMEOUT_MS??1500), jevModel=env.PTR_JEV_MODEL??DEFAULT_JEV_MODEL;
    if(!(minConfidence>0&&minConfidence<=1)||!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>10000||!DECISION_MODEL_IDS.includes(jevModel)) throw new CoreError('INVALID_INPUT');
    intentClassifier={classifier:new JevIntentClassifier(openRouter(),jevModel),minConfidence,timeoutMs};
  } else if(classifierName!=='off') throw new CoreError('INVALID_INPUT');
  const store=new PostgresConversationStore(pool);
  // Separate names let a load test run beside other users of the same Redis (and be wiped safely afterwards).
  const queueName=env.PTR_TURN_QUEUE??'turns', namespace=env.PTR_EVENTS_NAMESPACE??'events';
  if(!/^[a-z0-9-]{1,40}$/.test(queueName)||!/^[a-z0-9-]{1,40}$/.test(namespace)) throw new CoreError('INVALID_INPUT');
  const delivery=new BullMqTurnDelivery(redisUrl,{queueName});
  const events=new RedisTurnEvents(redisUrl,{namespace});const eventSource=new RedisTurnEventSource(redisUrl,{namespace});
  const chat=new ChatService({store,personas,provider,leases:store,delivery,events,maxQueueDepth:queueMaxDepth,
    retrieval:new PostgresRetrieval(sources,{embed,modelRevision:embeddingModel}),
    ...(intentClassifier?{intentClassifier}:{}),...(hooks.onTurnFailure?{onTurnFailure:hooks.onTurnFailure}:{})});
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
