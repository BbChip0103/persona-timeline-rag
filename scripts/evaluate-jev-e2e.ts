/**
 * End-to-end comparison of final answers with the intent classifier off vs Jev on, on the frozen 96-utterance natural
 * character-chat set (user texts only, conversation order, agent_loop + caption_image). Conversation state stays in the
 * in-memory store; personas, sources and vectors are read from the research DB (SELECT only, no migration). Every
 * provider call goes through the shared budget ledger with run caps.
 *
 *   GOAL1_LIVE_ENABLED=true node --env-file=.env.local --import tsx scripts/evaluate-jev-e2e.ts --live \
 *     --data-root=<checkout with data/research> --max-usd=1.00 --max-calls=1300
 *
 * Both arms are identical except the classifier. The off arm uses a classifier stub that always fails, which keeps
 * the rule decision (exactly what PTR_INTENT_CLASSIFIER=off routes) while recording the routing trace. Identical
 * provider requests replay the ledger's stored response (the existing no-resubmission policy), so turns that route the
 * same with the same history get the same answer at no extra cost.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatReply, ProviderMessage } from '@ptr/contracts';
import { createLocalChat, InMemoryConversationStore, type IntentClassifier, type Retrieval, type TextProvider } from '@ptr/core';
import { EMBEDDING_MODEL, JevIntentClassifier, OpenRouterClient, PostgresBudgetLedger, ProviderError, liveOptionsFromEnvironment, type BudgetLedger } from '@ptr/providers';
import { createLocalPool, PostgresPersonaRepository, PostgresRetrieval, PostgresSourceRepository } from '@ptr/storage';
import { validateUserExport } from './evaluate-character-chat';
import { EXPECTED } from './evaluate-jev-intent';
import { percentile } from './loadtest-lib';
import type { ChatTestset } from './prepare-character-chat-testset';

const CHAT_MODEL='google/gemma-4-26b-a4b-it';
const ESTIMATE={turnsPerArm:96,arms:2,modelCallsPerTurn:1.5,inputTokensPerCall:5000,outputTokensPerCall:300,promptUsdPerM:0.09,completionUsdPerM:0.3,jevCalls:60,jevUsd:0.00002};
type Kind='chat'|'embedding'|'jev';
interface Bucket { created:number; replayed:number; settledMicrousd:number; unknownMicrousd:number; byKind:Record<Kind,{created:number;replayed:number;microusd:number}> }
const bucket=():Bucket=>({created:0,replayed:0,settledMicrousd:0,unknownMicrousd:0,byKind:{chat:{created:0,replayed:0,microusd:0},embedding:{created:0,replayed:0,microusd:0},jev:{created:0,replayed:0,microusd:0}}});
interface Row {
  arm:'off'|'on'; conversationId:string; turnIndex:number; category:string; language:string; behavior:string; expected:string; text:string;
  state:string; errorCode?:string; route?:string; routing?:ChatReply['intentRouting']; status?:string; responseKind?:string;
  retrievalRan:boolean; retrievalAction?:string; searchCalls:number; toolCalls:number; sources:number; evidence:number; grounding?:string; limitations:string[];
  answer?:string; latencyMs:number; cost:Bucket;
}
function args():Record<string,string> {
  return Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...rest]=arg.replace(/^--/,'').split('=');return [key!,rest.join('=')||'true'];}));
}
export function estimateUsd(e=ESTIMATE):number {
  const calls=e.turnsPerArm*e.arms*e.modelCallsPerTurn;
  return calls*(e.inputTokensPerCall*e.promptUsdPerM+e.outputTokensPerCall*e.completionUsdPerM)/1e6+e.jevCalls*e.jevUsd;
}
async function budgetSnapshot(pool:ReturnType<typeof createLocalPool>) {
  const row=(await pool.query(`SELECT count(*)::int calls,COALESCE(sum(actual_microusd) FILTER(WHERE state='settled'),0)::bigint settled,
    COALESCE(sum(GREATEST(reserved_microusd,COALESCE(actual_microusd,0))) FILTER(WHERE state<>'settled'),0)::bigint unresolved FROM ptr_provider_requests`)).rows[0] as Record<string,string|number>;
  return {calls:Number(row.calls),settledMicrousd:Number(row.settled),unresolvedMicrousd:Number(row.unresolved)};
}
async function main():Promise<void> {
  const options=args();
  const maxUsd=Number(options['max-usd']??1),maxCalls=Number(options['max-calls']??1300);
  const estimate=estimateUsd();
  console.log(JSON.stringify({preflight:{estimateUsd:+estimate.toFixed(4),assumptions:ESTIMATE,maxUsd,maxCalls}}));
  if(estimate>0.5) throw new Error('Estimate above US$0.50; not running');
  if(options.live!=='true'||process.env.GOAL1_LIVE_ENABLED!=='true') throw new Error('Explicit --live and GOAL1_LIVE_ENABLED=true required');
  const root=options['data-root']??'.';
  const pointer=JSON.parse(await readFile(join(root,'data/research/character-chat-testset.latest.json'),'utf8')) as {directory:string;revision:string};
  if(pointer.directory!==`data/research/character-chat-testsets/${pointer.revision}`||!/^[a-f0-9]{64}$/.test(pointer.revision)) throw new Error('Unsafe testset pointer');
  const evaluator=JSON.parse(await readFile(join(root,pointer.directory,'evaluator.json'),'utf8')) as ChatTestset;
  validateUserExport(evaluator,JSON.parse(await readFile(join(root,pointer.directory,'user.json'),'utf8')));
  if(evaluator.revision!==pointer.revision||evaluator.conversations.length!==32) throw new Error('Unexpected test set');

  const databaseUrl=process.env.DATABASE_URL??'';
  if(new URL(databaseUrl).pathname!=='/ptr_research') throw new Error('Live calls must use the shared research ledger');
  const pool=createLocalPool(databaseUrl);
  try {
    const before=await budgetSnapshot(pool);
    // Run caps and per-turn attribution. Calls run one at a time, so the active kind/turn bucket is unambiguous.
    const base=new PostgresBudgetLedger(pool,databaseUrl);let kind:Kind='chat';let turn=bucket();const keyKind=new Map<string,Kind>();const open=new Set<string>();
    const run={created:0,settledMicrousd:0,unknownMicrousd:0,capReached:false};
    const ledger:BudgetLedger={
      async reserve(key,amount) {
        if(run.created>=maxCalls||run.settledMicrousd+run.unknownMicrousd+amount>maxUsd*1e6) {run.capReached=true;throw new ProviderError('BUDGET_EXCEEDED');}
        const saved=await base.reserve(key,amount);keyKind.set(key,kind);
        if(saved.created){run.created++;turn.created++;turn.byKind[kind].created++;run.unknownMicrousd+=amount;open.add(key);}
        else {turn.replayed++;turn.byKind[kind].replayed++;}
        return saved;
      },
      submitted:key=>base.submitted(key),get:key=>base.get(key),
      async finish(key,cost,response,generationId) {
        await base.finish(key,cost,response,generationId);
        // Only this run's new requests count, once: a replay or a second finish of the same request is not a new charge.
        if(!open.delete(key)) return;
        const reserved=(await base.get(key))?.reservedMicrousd??0;const k=keyKind.get(key)??kind;
        if(cost!==null){run.unknownMicrousd-=reserved;run.settledMicrousd+=cost;turn.settledMicrousd+=cost;turn.byKind[k].microusd+=cost;}
        else {turn.unknownMicrousd+=reserved;turn.byKind[k].microusd+=reserved;}
      },
    };
    const client=new OpenRouterClient(liveOptionsFromEnvironment({...process.env,GOAL1_DATABASE_URL:databaseUrl,GOAL1_TEXT_MODEL:CHAT_MODEL},ledger));
    const provider:TextProvider={generate:(messages:ProviderMessage[],o)=>{kind='chat';return client.generate(messages,o);}};
    const personas=new PostgresPersonaRepository(pool);const sources=new PostgresSourceRepository(pool);
    const retrieval=new PostgresRetrieval(sources,{modelRevision:EMBEDDING_MODEL,embed:(text,o)=>{kind='embedding';return client.embed([text],o).then(vectors=>vectors[0]!);}});
    let searchCalls=0;
    const tracked:Retrieval={search:(...a)=>{searchCalls++;return retrieval.search(...a);},resolve:(...a)=>retrieval.resolve(...a)};
    const jev=new JevIntentClassifier({decide:(request,o)=>{kind='jev';return client.decide(request,o);}});
    // Off arm: always fails, so routing is exactly the rule decision; it never reaches the network.
    const off:IntentClassifier={name:'off',classify:async()=>{throw Object.assign(new Error('classifier off'),{code:'CLASSIFIER_OFF'});}};
    const rows:Row[]=[];const started=new Date().toISOString();
    for(const arm of (options.arm==='off'||options.arm==='on'?[options.arm]:['off','on']) as ('off'|'on')[]) {
      const chat=createLocalChat({store:new InMemoryConversationStore(),personas,provider,retrieval:tracked,
        intentClassifier:{classifier:arm==='on'?jev:off,minConfidence:Number(process.env.PTR_JEV_MIN_CONFIDENCE??0.6),timeoutMs:Number(process.env.PTR_JEV_TIMEOUT_MS??1500)}});
      try {
        for(const conversation of evaluator.conversations) {
          if(run.capReached) break;
          const owner=`jev-e2e-${randomUUID()}`;
          const session=await chat.createSession(owner,{personId:conversation.personId,personaId:conversation.personaId,personaRevision:conversation.personaRevision,
            timezone:'Asia/Seoul',ragCondition:'caption_image',retrievalMode:'semantic',executionProfile:'agent_loop'});
          for(const [turnIndex,item] of conversation.turns.entries()) {
            turn=bucket();searchCalls=0;const began=performance.now();
            const result=await chat.sendTurn(owner,{sessionId:session.id,clientRequestId:randomUUID(),text:item.text});
            const reply=result.reply;const routing=reply?.intentRouting;
            const retrievalAction=reply?.retrievalContext?.action;const toolCalls=reply?.agent?.toolCalls??0;
            rows.push({arm,conversationId:conversation.id,turnIndex,category:conversation.category,language:conversation.language,behavior:item.evaluator.behavior,
              expected:EXPECTED[item.evaluator.behavior],text:item.text,state:result.state,...(result.errorCode?{errorCode:result.errorCode}:{}),
              ...(routing?{routing,route:routing.decidedBy==='classifier'?routing.label!:routing.ruleIntent}:{}),
              ...(reply?{status:reply.status,responseKind:reply.responseKind,grounding:reply.grounding,answer:reply.content}:{}),
              retrievalRan:retrievalAction==='search'||retrievalAction==='reuse'||toolCalls>0||searchCalls>0,...(retrievalAction?{retrievalAction}:{}),
              searchCalls,toolCalls,sources:reply?.promptEvidence?.sourceIds.length??0,evidence:reply?.evidence.length??0,limitations:reply?.limitations??[],
              latencyMs:Math.round(performance.now()-began),cost:turn});
            if(run.capReached) break;
          }
        }
      } finally {chat.stop();}
    }
    const after=await budgetSnapshot(pool);
    const memory=(row:Row)=>row.expected==='timeline';
    const totals=(arm:'off'|'on')=>{const part=rows.filter(row=>row.arm===arm);const lat=part.map(row=>row.latencyMs);
      return {turns:part.length,failures:part.filter(row=>row.state!=='completed').length,
        statuses:Object.fromEntries(['answered','insufficient_evidence','needs_clarification','out_of_scope'].map(status=>[status,part.filter(row=>row.status===status).length])),
        answeredGrounded:part.filter(row=>row.status==='answered'&&row.evidence>0).length,
        answeredWithoutRetrieval:part.filter(row=>row.status==='answered'&&!row.retrievalRan).length,
        memoryAnsweredWithoutRetrieval:part.filter(row=>memory(row)&&row.status==='answered'&&!row.retrievalRan).length,
        routes:Object.fromEntries(['timeline','small_talk','clarification','unsupported'].map(route=>[route,part.filter(row=>row.route===route).length])),
        latencyMs:{p50:percentile(lat,50),p95:percentile(lat,95)},
        createdCalls:part.reduce((n,row)=>n+row.cost.created,0),replayedCalls:part.reduce((n,row)=>n+row.cost.replayed,0),
        costUsd:+(part.reduce((n,row)=>n+row.cost.settledMicrousd+row.cost.unknownMicrousd,0)/1e6).toFixed(6),
        costByKindUsd:Object.fromEntries((['chat','embedding','jev'] as Kind[]).map(k=>[k,+(part.reduce((n,row)=>n+row.cost.byKind[k].microusd,0)/1e6).toFixed(6)])),
        errors:Object.fromEntries([...new Set(part.flatMap(row=>row.errorCode?[row.errorCode]:[]))].map(code=>[code,part.filter(row=>row.errorCode===code).length]))};};
    const key=(row:Row)=>`${row.conversationId}#${row.turnIndex}`;
    const onByKey=new Map(rows.filter(row=>row.arm==='on').map(row=>[key(row),row]));
    const differing=rows.filter(row=>row.arm==='off'&&onByKey.has(key(row))&&onByKey.get(key(row))!.route!==row.route).map(row=>({key:key(row),off:row,on:onByKey.get(key(row))!}));
    const summary={execution:'live',label:'jev-e2e',chatModel:CHAT_MODEL,startedAt:started,finishedAt:new Date().toISOString(),testsetRevision:evaluator.revision,
      capReached:run.capReached,preflightEstimateUsd:+estimate.toFixed(4),runCreatedCalls:run.created,runCostUsd:+((run.settledMicrousd+run.unknownMicrousd)/1e6).toFixed(6),
      ledger:{before,after},arms:{off:totals('off'),on:totals('on')},
      routedDifferently:differing.length,
      sameRouteDifferentAnswer:rows.filter(row=>row.arm==='off'&&onByKey.get(key(row))?.route===row.route&&onByKey.get(key(row))?.answer!==row.answer).length,
      differing:differing.map(({key:k,off:a,on:b})=>({key:k,behavior:a.behavior,expected:a.expected,language:a.language,text:[...a.text].slice(0,80).join(''),
        off:{route:a.route,status:a.status,sources:a.sources,retrievalRan:a.retrievalRan,evidence:a.evidence,answer:[...(a.answer??'')].slice(0,200).join('')},
        on:{route:b.route,confidence:b.routing?.confidence,status:b.status,sources:b.sources,retrievalRan:b.retrievalRan,evidence:b.evidence,answer:[...(b.answer??'')].slice(0,200).join('')}})),
      possibleFabrication:Object.fromEntries((['off','on'] as const).map(arm=>[arm,rows.filter(row=>row.arm===arm&&memory(row)&&row.status==='answered'&&!row.retrievalRan)
        .map(row=>({key:key(row),behavior:row.behavior,text:[...row.text].slice(0,80).join(''),answer:[...(row.answer??'')].slice(0,200).join('')}))])),
      limitations:['Expected behaviours are an agent mapping of draft-silver evaluator labels.','One run per arm; identical requests replay stored responses.',
        'Fabrication flags are a heuristic (memory question answered with no retrieval); the answer text needs human judgement.']};
    const directory=join(__dirname,'..','reports','jev-e2e',started.replace(/[:.]/g,'-'));await mkdir(directory,{recursive:true,mode:0o700});
    await writeFile(join(directory,'rows.private.json'),JSON.stringify(rows,null,1),{mode:0o600});
    await writeFile(join(directory,'summary.private.json'),JSON.stringify(summary,null,1),{mode:0o600});
    console.log(JSON.stringify({arms:summary.arms,routedDifferently:summary.routedDifferently,sameRouteDifferentAnswer:summary.sameRouteDifferentAnswer,capReached:run.capReached,runCostUsd:summary.runCostUsd,ledger:summary.ledger}));
    console.log(`report: ${directory}`);
  } finally {await pool.end();}
}
if(require.main===module) void main().catch(error=>{console.error(error instanceof Error?error.message.slice(0,200):'Jev E2E evaluation failed');process.exitCode=1;});
