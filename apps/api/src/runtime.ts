import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { ChatService, CoreError, type PersonaRepository, type TextProvider, type TurnDelivery, type TurnEventSource, type TurnEvents, type TurnLeaseStore } from '@ptr/core';
import { BullMqTurnDelivery, RedisTurnEventSource, RedisTurnEvents } from '@ptr/messaging';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository, PostgresRetrieval, PostgresSourceRepository } from '@ptr/storage';
import { DEFAULT_TEXT_MODEL, FakeEmbeddingProvider, FakeTextProvider, LatencyInjectedTextProvider, OpenAICompatibleTextProvider, OpenRouterClient, OpenRouterEmbeddingProvider, PostgresBudgetLedger, liveOptionsFromEnvironment, parseLatencyProfile } from '@ptr/providers';
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
  // Load tests only: delay/failure injection is never allowed to wrap a billable provider.
  if(env.PTR_FAKE_LATENCY!==undefined) {
    if(providerName!=='fake') throw new CoreError('INVALID_INPUT');
    provider=new LatencyInjectedTextProvider(fakeText,parseLatencyProfile(env.PTR_FAKE_LATENCY));model=`${model}+latency`;
  }
  if(providerName==='openrouter') {
    const ledger=new PostgresBudgetLedger(pool,databaseUrl);
    const liveEnv={...env,GOAL1_DATABASE_URL:databaseUrl,GOAL1_TEXT_MODEL:env.GOAL1_TEXT_MODEL??env.PTR_MODEL??env.TEXT_MODEL};
    const client=new OpenRouterClient(liveOptionsFromEnvironment(liveEnv,ledger));
    const embedding=new OpenRouterEmbeddingProvider(client);
    provider=client;model=liveEnv.GOAL1_TEXT_MODEL??DEFAULT_TEXT_MODEL;embeddingModel=embedding.model;
    embed=(text,options)=>embedding.embed([text],options).then(vectors=>vectors[0]!);
  } else if(providerName==='selfhosted') {
    // Goal2: self-hosted vLLM/SGLang through an SSH tunnel. Chat only; embeddings stay on the fake space.
    const baseUrl=env.PTR_SELFHOSTED_BASE_URL, selfModel=env.PTR_SELFHOSTED_MODEL;
    if(!baseUrl||!selfModel) throw new CoreError('INVALID_INPUT');
    provider=new OpenAICompatibleTextProvider({baseUrl,model:selfModel,maxOutputTokens:512,timeoutMs:60000,structuredAgentReplies:env.PTR_SELFHOSTED_STRUCTURED==='1'});model=`selfhosted/${selfModel}`;
  } else if(providerName!=='fake') throw new CoreError('INVALID_INPUT');
  const store=new PostgresConversationStore(pool);
  const delivery=new BullMqTurnDelivery(redisUrl);
  const events=new RedisTurnEvents(redisUrl);const eventSource=new RedisTurnEventSource(redisUrl);
  const chat=new ChatService({store,personas,provider,leases:store,delivery,events,maxQueueDepth:queueMaxDepth,
    retrieval:new PostgresRetrieval(sources,{embed,modelRevision:embeddingModel}),
    ...(hooks.onTurnFailure?{onTurnFailure:hooks.onTurnFailure}:{})});
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
