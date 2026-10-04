import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { ExecutionProfile, Persona, SourcePost } from '@ptr/contracts';
import { AGENT_PROMPT_REVISION, AGENT_RUNTIME_REVISION, EXPERIMENT_PROMPT_REVISION, RETRIEVAL_CONTEXT_REVISION } from '@ptr/core';
import { EMBEDDING_MODEL, MAX_PROVIDER_CALLS, MAX_TOTAL_MICROUSD } from '@ptr/providers';
import { privateJson } from './prepare-research';
import { prepareChatTestset, testsetHash, type ChatTestset } from './prepare-character-chat-testset';
import { prepareImageAnnotations } from './import-image-annotations';
import { CONDITIONS } from './evaluate-image-rag';
import { executeNaturalConversation, summarizeNaturalRows, validateUserExport, type NaturalChatRow } from './evaluate-character-chat';
import { budgetSnapshot, codeFingerprint, corpusSnapshot, createMemoryPilotRuntime, selectMemoryPilot, validatePilotArguments, type MemoryTrace } from './evaluate-memory-context';

export const PROFILE_LIMITS={turns:72,textCalls:144,embeddingCalls:96,freshRequests:120} as const;
export interface ProfileRow extends NaturalChatRow {executionProfile:ExecutionProfile}
export function validateProfileBudget(budget:Record<string,number|string>):void {
  const cap=Number(budget.cap_microusd),calls=Number(budget.calls),callCap=Number(budget.call_cap),actual=Number(budget.actual_microusd),unresolved=Number(budget.unresolved_microusd);
  if(![cap,calls,callCap,actual,unresolved].every(Number.isSafeInteger)||cap<1||cap>MAX_TOTAL_MICROUSD||callCap>MAX_PROVIDER_CALLS||calls<0||callCap-calls<PROFILE_LIMITS.freshRequests||actual<0||unresolved<0||actual+unresolved>=cap)
    throw new Error('Existing global budget must retain 120 request slots; no reset allowed');
}
export function matchedProfileRows(rows:ProfileRow[]):ProfileRow[] {
  const key=(row:ProfileRow)=>`${row.conversationId}:${row.userTurnId}:${row.condition}`;
  const completed=new Map<string,Set<ExecutionProfile>>();
  for(const row of rows)if(row.trace.state==='completed'){const profiles=completed.get(key(row))??new Set<ExecutionProfile>();profiles.add(row.executionProfile);completed.set(key(row),profiles);}
  return rows.filter(row=>row.trace.state==='completed'&&completed.get(key(row))?.size===2);
}
export function summarizeProfiles(rows:ProfileRow[]) {
  return Object.fromEntries((['legacy','agent_loop'] as const).map(profile=>{
    const group=rows.filter(row=>row.executionProfile===profile);
    return [profile,{...summarizeNaturalRows(group),controlFlow:{
      totalTurns:group.length,completed:group.filter(row=>row.trace.state==='completed').length,failed:group.filter(row=>row.trace.state!=='completed').length,
      agentToolCalls:group.reduce((n,row)=>n+(row.reply?.agent?.toolCalls??0),0),
      stateUpdatedTurns:group.filter(row=>row.reply?.agent&&(row.reply.agent.variables.conversationTopic!==''||row.reply.agent.variables.tone!=='neutral')).length,
      lookupCalls:group.reduce((n,row)=>n+((row.trace as MemoryTrace).sourceLookupCalls??0),0),
    }}];
  }));
}
export async function runProfileEvaluation(args:string[]):Promise<void> {
  validatePilotArguments(args,process.env);
  const pointer=JSON.parse(await readFile('data/research/character-chat-testset.latest.json','utf8')) as {directory:string;revision:string};
  if(!/^[a-f0-9]{64}$/.test(pointer.revision)||pointer.directory!==`data/research/character-chat-testsets/${pointer.revision}`)throw new Error('Unsafe frozen pointer');
  const evaluator=JSON.parse(await readFile(`${pointer.directory}/evaluator.json`,'utf8')) as ChatTestset;
  const paths={seed:'data/research/character-chat-curation.private.json',personas:'data/research/personas.json',sources:'data/research/sources.json',split:'data/research/split.json',images:'data/research/image_descriptions_v5_declarative/images.jsonl'};
  const texts:Record<string,string>=Object.fromEntries(await Promise.all(Object.entries(paths).map(async([key,path])=>[key,await readFile(path,'utf8')])));
  const sources=JSON.parse(texts.sources!) as SourcePost[],personas=JSON.parse(texts.personas!) as Persona[];
  const plan=prepareImageAnnotations(texts.images!.split('\n').filter(line=>line.trim()).map(line=>JSON.parse(line) as unknown),sources);
  const rebuilt=prepareChatTestset(JSON.parse(texts.seed!),personas,sources,plan,JSON.parse(texts.split!) as Record<string,string>,Object.fromEntries(Object.entries(texts).map(([key,text])=>[key,testsetHash(text)])));
  const {frozenAt:_a,...frozen}=evaluator,{frozenAt:_b,...current}=rebuilt;
  if(evaluator.revision!==pointer.revision||testsetHash(frozen)!==testsetHash(current))throw new Error('Frozen evaluator/assets changed');
  const conversations=selectMemoryPilot(evaluator,validateUserExport(evaluator,JSON.parse(await readFile(`${pointer.directory}/user.json`,'utf8'))));
  const runtime=createMemoryPilotRuntime(process.env,PROFILE_LIMITS),rows:ProfileRow[]=[],failures:unknown[]=[];
  const startedAt=new Date().toISOString(),directory=`reports/agent-reevaluation/paired-${startedAt.replace(/[:.]/g,'-')}`,owner=`profile-pilot-${randomUUID()}`;
  try {
    const before=await codeFingerprint(),codeCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),budgetBefore=await budgetSnapshot(runtime.pool);validateProfileBudget(budgetBefore);
    const corpusBefore=await corpusSnapshot(runtime.pool,sources,plan);
    for(const persona of personas)if(testsetHash(await runtime.personas.get(persona.id,persona.revision))!==testsetHash(persona))throw new Error('Frozen persona mismatch');
    await privateJson(`${directory}/preflight.json`,{startedAt,codeCommit,codeFingerprint:before,corpusFingerprint:testsetHash(corpusBefore),budgetBefore,limits:PROFILE_LIMITS,
      profileOrder:'rotating',selectedConversationIds:conversations.map(item=>item.id),maxToolRounds:2,validator:'disabled',noHiddenInputHints:true,
      note:'Planned72 turns; worst-case provider port calls exceed120 fresh-request cap. Hard limits may stop the trial; completion is not guaranteed.'});
    for(const [index,conversation]of conversations.entries())for(const condition of CONDITIONS.map((_,offset)=>CONDITIONS[(index+offset)%3]!)) {
      const profiles:ExecutionProfile[]=index%2?['agent_loop','legacy']:['legacy','agent_loop'];
      for(const profile of profiles) {
        try {
          await executeNaturalConversation(runtime,owner,conversation,condition,async row=>{
            rows.push({...row,executionProfile:profile});
            await privateJson(`${directory}/progress.json`,{startedAt,observedAt:new Date().toISOString(),planned:PROFILE_LIMITS.turns,observed:rows.length,rows,failures,summary:summarizeProfiles(rows)});
            console.log(JSON.stringify({observed:rows.length,planned:PROFILE_LIMITS.turns,profile,condition,state:row.trace.state,status:row.reply?.status,textCalls:row.trace.textCalls,embeddingCalls:row.trace.embeddingCalls,toolCalls:row.reply?.agent?.toolCalls??null,errors:row.trace.errors}));
          },750,profile);
        } catch {
          failures.push({conversationId:conversation.id,condition,profile,observedAt:new Date().toISOString(),skippedFollowups:conversation.turns.length-rows.filter(row=>row.conversationId===conversation.id&&row.condition===condition&&row.executionProfile===profile).length});
          // Never retry a failed turn or fabricate its history. Other independent profile/condition sessions may proceed.
          const budget=await budgetSnapshot(runtime.pool);
          const submitted=rows.flatMap(row=>row.trace.requests).filter(request=>request.created).length;
          if(runtime.haltedReason()||submitted>=PROFILE_LIMITS.freshRequests||Number(budget.calls)>=Number(budget.call_cap)||Number(budget.actual_microusd)+Number(budget.unresolved_microusd)>=Number(budget.cap_microusd))throw new Error('Trial stopped at existing budget bound');
        }
      }
    }
    const after=await codeFingerprint(),corpusAfter=await corpusSnapshot(runtime.pool,sources,plan);
    if(before!==after||testsetHash(corpusBefore)!==testsetHash(corpusAfter))throw new Error('Code/corpus changed during evaluation');
    const unique=[...new Set(rows.flatMap(row=>row.trace.requests.map(request=>request.key)))];
    const accounting=await runtime.pool.query('SELECT key,state,reserved_microusd,actual_microusd,generation_id,response_json FROM ptr_provider_requests WHERE key=ANY($1::text[])',[unique]);
    await privateJson(`${directory}/provider-responses.private.json`,accounting.rows);
    const report={label:'paired-character-agent-profile-regression',execution:'live',startedAt,finishedAt:new Date().toISOString(),planned:PROFILE_LIMITS.turns,observed:rows.length,
      completed:rows.filter(row=>row.trace.state==='completed').length,failed:rows.filter(row=>row.trace.state!=='completed').length,failures,rows,
      revision:evaluator.revision,model:runtime.model,embeddingModel:EMBEDDING_MODEL,codeCommit,codeFingerprint:before,codeUnchanged:true,corpusFingerprint:testsetHash(corpusBefore),corpusUnchanged:true,
      promptRevisions:{legacy:EXPERIMENT_PROMPT_REVISION,agent_loop:AGENT_PROMPT_REVISION},agentRevision:AGENT_RUNTIME_REVISION,contextRevision:RETRIEVAL_CONTEXT_REVISION,
      maxToolRounds:2,validator:'disabled',limits:PROFILE_LIMITS,budgetBefore,budgetAfter:await budgetSnapshot(runtime.pool),summary:summarizeProfiles(rows),matchedPairCount:matchedProfileRows(rows).length/2,matchedSummary:summarizeProfiles(matchedProfileRows(rows)),humanReview:'pending',limitations:[
        'Four previously observed three-turn conversations, not unseen human-gold accuracy or full32-conversation validation.',
        'Same frozen user inputs/model/personas/corpus; each profile/condition has its own evolving assistant history. Profiles change prompt/protocol/state/tool behavior together: not an isolated component effect.',
        'Failure skips dependent followups without retry; other independent sessions continue. Planned, observed, completed and skipped counts remain separate.',
        'Persistent response cache may replay legacy calls; billed cost/latency cannot be naively compared to uncached new-profile calls.',
        'Exact quotes, source exposure and status answered do not prove semantic support or answer correctness.',
        'agent-loop is independent bounded interaction reproduction, not equivalence with any production engine.']};
    await privateJson(`${directory}/report.json`,report);await privateJson('reports/agent-reevaluation/latest.json',{directory,finishedAt:report.finishedAt,planned:report.planned,completed:report.completed});
    console.log(JSON.stringify({directory,planned:report.planned,observed:rows.length,completed:report.completed,failed:report.failed,summary:report.summary}));
  } catch {
    await privateJson(`${directory}/failure.json`,{startedAt,observedAt:new Date().toISOString(),planned:PROFILE_LIMITS.turns,observed:rows.length,rows,failures,budgetAfter:await budgetSnapshot(runtime.pool).catch(()=>null),noRetry:true});
    throw new Error('Profile evaluation stopped; private results preserved');
  } finally {await runtime.close();}
}
if(require.main===module)void runProfileEvaluation(process.argv.slice(2)).catch(()=>{console.error('Agent profile trial stopped; private progress/failure preserved, no automatic resubmission.');process.exitCode=1;});
