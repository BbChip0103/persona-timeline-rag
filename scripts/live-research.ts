import { readFile } from 'node:fs/promises';
import { type Persona, type SourcePost } from '@ptr/contracts';
import { buildPrompt, PROMPT_REVISION } from '../packages/core/src/prompts';
import { OpenRouterClient, PostgresBudgetLedger, ProviderError, EMBEDDING_MODEL } from '@ptr/providers';
import { createLocalPool, PostgresSourceRepository } from '@ptr/storage';
import { privateJson } from './prepare-research';
const signal=()=>AbortSignal.timeout(60000);
export async function runLive(stage:string):Promise<void>{
  if(stage!=='budget'&&process.env.GOAL1_LIVE_ENABLED!=='true')throw new ProviderError('LIVE_DISABLED');
  const url=process.env.DATABASE_URL??'';const pool=createLocalPool(url);const ledger=new PostgresBudgetLedger(pool,url);
  try{
    await ledger.initialize();
    if(stage==='budget'){
      const stats=await pool.query("SELECT state,count(*)::int AS calls,COALESCE(sum(actual_microusd),0)::bigint AS actual,COALESCE(sum(reserved_microusd) FILTER(WHERE state<>'settled'),0)::bigint AS unresolved FROM ptr_provider_requests GROUP BY state");
      await privateJson('reports/provider-budget.json',{at:new Date().toISOString(),capUsd:1,rows:stats.rows});console.log(JSON.stringify({capUsd:1,rows:stats.rows}));return;
    }
    const client=new OpenRouterClient({apiKey:process.env.OPENROUTER_API_KEY??'',liveEnabled:true,allowExternalData:process.env.GOAL1_ALLOW_EXTERNAL_DATA==='true',databaseUrl:url,ledger});
    await client.verifyPricing(signal());
    if(stage==='preflight'){
      const began=Date.now();const text=await client.generate([{role:'system',content:'You are a synthetic connectivity test. Reply exactly READY.'},{role:'user',content:'Please return READY.'}],{signal:signal()});
      const vectors=await client.embed(['Synthetic corpus connectivity test.'],{signal:signal()});
      await privateJson('reports/live-preflight.json',{at:new Date().toISOString(),provider:'openrouter',textModel:process.env.PTR_MODEL,embeddingModel:EMBEDDING_MODEL,textNonempty:Boolean(text.trim()),vectors:vectors.length,dimensions:vectors[0]?.length,latencyMs:Date.now()-began,externalData:true});
      console.log('Live text and embedding preflight passed.');
    }else if(stage==='index'){
      const sources=JSON.parse(await readFile('data/research/sources.json','utf8')) as SourcePost[];
      const repository=new PostgresSourceRepository(pool);const existing=await pool.query('SELECT source_id FROM source_vectors WHERE model_revision=$1',[EMBEDDING_MODEL]);
      const done=new Set(existing.rows.map(row=>row.source_id as string));const eligible=sources.filter(s=>!s.unsafe&&s.caption.trim()&&!done.has(s.id));
      let indexed=0;let skipped=0;const start=Date.now();
      // Byte budget and 8 inputs keep vector JSON below the provider response allocation cap.
      for(let offset=0;offset<eligible.length;){
        const batch:SourcePost[]=[];let bytes=0;
        while(offset<eligible.length&&batch.length<8){const row=eligible[offset]!;const size=Buffer.byteLength(JSON.stringify(row.caption),'utf8');
          if(size>30000){skipped++;offset++;continue;}if(bytes+size>30000&&batch.length)break;batch.push(row);bytes+=size;offset++;}
        if(!batch.length)continue;
        const vectors=await client.embed(batch.map(s=>s.caption),{signal:signal()});
        for(let i=0;i<batch.length;i++){await repository.importVector(batch[i]!.id,EMBEDDING_MODEL,vectors[i]!);indexed++;}
        await privateJson('reports/index-progress.json',{model:EMBEDDING_MODEL,indexedThisRun:indexed,existing:done.size,skippedOversize:skipped,eligible:eligible.length,latencyMs:Date.now()-start});
      }
      console.log(JSON.stringify({stage:'index',model:EMBEDDING_MODEL,indexedThisRun:indexed,existing:done.size,skippedOversize:skipped}));
    }else if(stage==='baseline'){
      const personas=JSON.parse(await readFile('data/research/personas.json','utf8')) as Persona[];const outputs:unknown[]=[];
      for(const p of personas){
        const text=p.language==='ko'?'오늘 기분이 좀 별로야. 네 스타일로 가볍게 이야기해줘. 실제 생활 얘기는 말고.':'I feel a bit flat today. Chat with me in your style, without claiming real experiences.';
        const began=Date.now();const content=await client.generate(buildPrompt(p,[],text,[],false),{signal:signal()});
        outputs.push({personId:p.personId,personaRevision:p.revision,kind:'chat',retrievalMode:'off',content,latencyMs:Date.now()-began,reviewStatus:'silver',promptRevision:PROMPT_REVISION});
        for(let i=0;i<3;i++){
          const brief=["a relaxing creative morning","a vibrant creative discovery","an imaginary new project"][i]!;
          const instruction=`Write an explicitly fictional Instagram caption idea about ${brief}, in the persona's language/style. Label it AI-generated fiction. No real dates, locations, sponsors or personal events. This must never become factual source evidence.`;
          const content=await client.generate(buildPrompt(p,[],instruction,[],false),{signal:signal()});
          outputs.push({personId:p.personId,personaRevision:p.revision,kind:'post_draft',origin:'generated',fictional:true,retrievalMode:'off',content,reviewStatus:'silver',promptRevision:PROMPT_REVISION});
        }
        await privateJson('reports/baseline-rag-off.json',{frozenAt:new Date().toISOString(),textModel:process.env.PTR_MODEL,promptRevision:PROMPT_REVISION,outputs,humanReview:'pending',notes:['Style is silver, not validated impersonation fidelity.','Images are a separate run; do not label fake output as actual images.']});
      }
      console.log(JSON.stringify({stage:'baseline',chats:4,fictionalDrafts:12,review:'pending'}));
    }else throw new Error('Unsupported live stage');
  }finally{await pool.end();}
}
if(require.main===module)void runLive(process.argv[2]??'preflight').catch(error=>{console.error(error instanceof ProviderError?error.code:'Private live research failed.');process.exitCode=1;});
