import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { ChatService, CoreError, type PersonaRepository, type TextProvider } from '@ptr/core';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository, PostgresRetrieval, PostgresSourceRepository } from '@ptr/storage';
import { DEFAULT_TEXT_MODEL, FakeEmbeddingProvider, FakeTextProvider, OpenRouterClient, OpenRouterEmbeddingProvider, PostgresBudgetLedger, liveOptionsFromEnvironment } from '@ptr/providers';
export interface CreativeArtifact {
  id:string;ownerId:string;personId:string;personaRevision:string;sessionId:string;
  kind:'post_draft';origin:'generated';fictional:true;status:'draft';content:string;
  promptRevision:string;provider:string;model:string;createdAt:string;
}
export interface ApiRuntime {
  chat:ChatService;personas:PersonaRepository;provider:TextProvider;
  listPersonas():Promise<Persona[]>;
  saveArtifact(artifact:CreativeArtifact):Promise<void>;
  providerName:string;model:string;close?():Promise<void>;
}
/** Composition only. It never seeds, migrates, imports posts, or calls a live provider at startup. */
export function createRuntime(env:NodeJS.ProcessEnv=process.env):ApiRuntime {
  const databaseUrl=env.GOAL1_DATABASE_URL??env.DATABASE_URL??'';
  const pool=createLocalPool(databaseUrl);
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
  if(providerName==='openrouter') {
    const ledger=new PostgresBudgetLedger(pool,databaseUrl);
    const liveEnv={...env,GOAL1_DATABASE_URL:databaseUrl,GOAL1_TEXT_MODEL:env.GOAL1_TEXT_MODEL??env.PTR_MODEL??env.TEXT_MODEL};
    const client=new OpenRouterClient(liveOptionsFromEnvironment(liveEnv,ledger));
    const embedding=new OpenRouterEmbeddingProvider(client);
    provider=client;model=liveEnv.GOAL1_TEXT_MODEL??DEFAULT_TEXT_MODEL;embeddingModel=embedding.model;
    embed=(text,options)=>embedding.embed([text],options).then(vectors=>vectors[0]!);
  } else if(providerName!=='fake') throw new CoreError('INVALID_INPUT');
  const chat=new ChatService({store:new PostgresConversationStore(pool),personas,provider,
    retrieval:new PostgresRetrieval(sources,{embed,modelRevision:embeddingModel})});
  return {chat,personas,provider,providerName,model,
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
