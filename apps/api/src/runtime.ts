import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { ChatService, CoreError, type PersonaRepository, type TextProvider, type TurnQueue } from '@ptr/core';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository, PostgresRetrieval, PostgresSourceRepository } from '@ptr/storage';
import { DEFAULT_TEXT_MODEL, FakeEmbeddingProvider, FakeTextProvider, LatencyInjectedTextProvider, OpenRouterClient, OpenRouterEmbeddingProvider, PostgresBudgetLedger, liveOptionsFromEnvironment, parseLatencyProfile } from '@ptr/providers';
export interface CreativeArtifact {
  id:string;ownerId:string;personId:string;personaRevision:string;sessionId:string;
  kind:'post_draft';origin:'generated';fictional:true;status:'draft';content:string;
  promptRevision:string;provider:string;model:string;createdAt:string;
}
export interface ApiRuntime {
  chat:ChatService;personas:PersonaRepository;provider:TextProvider;
  /** Present when PTR_EXECUTION=queue: the API only enqueues and worker processes execute. */
  queue?:TurnQueue;
  listPersonas():Promise<Persona[]>;
  saveArtifact(artifact:CreativeArtifact):Promise<void>;
  providerName:string;model:string;close?():Promise<void>;
}
/** Composition only. It never seeds, migrates, imports posts, or calls a live provider at startup. */
export function createRuntime(env:NodeJS.ProcessEnv=process.env):ApiRuntime {
  const databaseUrl=env.GOAL1_DATABASE_URL??env.DATABASE_URL??'';
  const poolMax=env.PTR_DB_POOL_MAX===undefined?undefined:Number(env.PTR_DB_POOL_MAX);
  const pool=createLocalPool(databaseUrl,poolMax===undefined?{}:{max:poolMax});
  const execution=env.PTR_EXECUTION??'inline';
  if(execution!=='inline'&&execution!=='queue') throw new CoreError('INVALID_INPUT');
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
  } else if(providerName!=='fake') throw new CoreError('INVALID_INPUT');
  const store=new PostgresConversationStore(pool);
  const queue=execution==='queue'?store:undefined;
  const chat=new ChatService({store,personas,provider,
    retrieval:new PostgresRetrieval(sources,{embed,modelRevision:embeddingModel}),
    ...(queue?{queue:{store:queue,maxDepth:queueMaxDepth}}:{})});
  return {chat,personas,provider,providerName,model,...(queue?{queue}:{}),
    async listPersonas() {
      const result=await pool.query('SELECT v.document FROM personas p JOIN persona_versions v ON v.persona_id=p.id AND v.revision=p.current_revision ORDER BY p.id');
      const registry=await approvedPersonas();
      return registry.map(selected=>result.rows.map(row=>PersonaSchema.parse(row.document)).find(p=>p.id===selected.id&&p.personId===selected.personId&&p.revision===selected.revision)).filter((p):p is Persona=>Boolean(p));
    },
    async saveArtifact(artifact) {
      const directory=join(process.cwd(),'data','generated');await mkdir(directory,{recursive:true,mode:0o700});
      await writeFile(join(directory,`${artifact.id}.json`),JSON.stringify(artifact,null,2),{flag:'wx',mode:0o600});
    },
    close:()=>pool.end(),
  };
}
