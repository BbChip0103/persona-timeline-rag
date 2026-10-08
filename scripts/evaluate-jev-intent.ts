/**
 * Offline intent-routing evaluation: deterministic rules vs rules + Jev (ambiguity-gated) on the frozen natural
 * character-chat test set. Only user text and prior user turns are used; no chat model, retrieval or DB conversation.
 *
 *   node --env-file=.env.local --import tsx scripts/evaluate-jev-intent.ts --live --data-root=<checkout with data/research>
 *   pnpm exec tsx scripts/evaluate-jev-intent.ts --rules-only --data-root=<…> [--replay=<earlier rows.private.json>]
 *
 * --rules-only makes no network or DB call: the Jev arm replays recorded answers (by utterance) or falls back to rules.
 *
 * Reruns: each utterance's seed is its frozen export turn id, so the Jev request body (and its ledger key) is the same
 * on every live rerun. A rerun therefore replays the ledger's stored answers (no new call, no cost, same answers)
 * instead of sampling Jev again; latency is then the replay time. A fresh sample needs a different seed/model.
 *
 * Jev is called once per utterance (same state the service would send) so the gated arm, threshold sweep and the
 * Jev-alone diagnostic all reuse one answer. Calls reserve/settle in the shared research-DB ledger; the run refuses
 * to start without enough ledger headroom and stops at --max-calls / --max-usd. Expected intents are this script's
 * mapping of evaluator behaviours, not human gold.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessage, RagCondition } from '@ptr/contracts';
import { intentSignals, isSensitive, needsIntentClassifier, retrievalContext, routeIntent, ruleIntent, containsCredentialPattern, type IntentClassification, type TurnIntent } from '@ptr/core';
import { createLocalPool } from '@ptr/storage';
import { DEFAULT_JEV_MODEL, JevIntentClassifier, OpenRouterClient, PostgresBudgetLedger, liveOptionsFromEnvironment } from '@ptr/providers';
import { validateUserExport } from './evaluate-character-chat';
import { percentile } from './loadtest-lib';
import { userConversation, type ChatTestset } from './prepare-character-chat-testset';

type Behavior=ChatTestset['conversations'][number]['turns'][number]['evaluator']['behavior'];
/** Agent's mapping (not ground truth): memory-dependent behaviours need the timeline route; clarify/private stay rule-decided. */
export const EXPECTED:Record<Behavior,'timeline'|'small_talk'|'clarification'|'unsupported'>={
  social:'small_talk',general_advice:'small_talk',creative:'small_talk',
  grounded_caption:'timeline',grounded_image:'timeline',grounded_both:'timeline',interpretation:'timeline',acknowledge_unknown:'timeline',
  clarify:'clarification',reject_private:'unsupported',
};
const THRESHOLDS=[0.5,0.6,0.7,0.8];
// Research sessions run agent_loop with a RAG condition set, which turns on the image-word cue.
const RAG_CONDITION:RagCondition='caption_image';
interface Call { classification?:IntentClassification; error?:string; latencyMs:number; costUsd:number|null; inputTokens:number|null; created:boolean }
interface Row {
  conversationId:string; turnIndex:number; category:string; language:string; behavior:Behavior; expected:string; text:string;
  signals:{strongTimeline:boolean;weakTimeline:boolean;creative:boolean;sensitive:boolean}; gated:boolean;
  /** rule: rules-only arm; armRule: the rule result inside the Jev arm (its follow-up chain can differ). */
  rule:TurnIntent; armRule:TurnIntent; jevArm:TurnIntent; routing?:unknown; call:Call;
  /** Jev arm per threshold, replayed through routeIntent with the same recorded answer. */
  sweep:Record<string,TurnIntent>;
}
function args():Record<string,string> {
  return Object.fromEntries(process.argv.slice(2).map(arg=>{const [key,...rest]=arg.replace(/^--/,'').split('=');return [key!,rest.join('=')||'true'];}));
}
const binary=(row:Row)=>row.expected==='timeline'||row.expected==='small_talk';
const accuracy=(rows:Row[],pick:(row:Row)=>string)=>{const scored=rows.filter(binary);return {n:scored.length,correct:scored.filter(row=>pick(row)===row.expected).length,
  accuracy:scored.length?+(scored.filter(row=>pick(row)===row.expected).length/scored.length).toFixed(3):null};};
const confusion=(rows:Row[],pick:(row:Row)=>string)=>{
  const table:Record<string,Record<string,number>>={};
  for(const row of rows){const actual=pick(row);(table[row.expected]??={})[actual]=(table[row.expected]![actual]??0)+1;}
  return table;
};
const TIMEOUT_MS=Number(process.env.PTR_JEV_TIMEOUT_MS??1500);
const THRESHOLD=Number(process.env.PTR_JEV_MIN_CONFIDENCE??0.6);
const jevLabel=(row:Row)=>row.call.classification!.label;
async function budgetSnapshot(pool:ReturnType<typeof createLocalPool>) {
  const result=await pool.query(`SELECT b.cap_microusd,b.call_cap,count(r.key)::int AS calls,
    COALESCE(sum(r.actual_microusd) FILTER(WHERE r.state='settled'),0)::bigint AS settled_microusd,
    COALESCE(sum(GREATEST(r.reserved_microusd,COALESCE(r.actual_microusd,0))) FILTER(WHERE r.state<>'settled'),0)::bigint AS unresolved_microusd
    FROM ptr_provider_budget b LEFT JOIN ptr_provider_requests r ON true WHERE b.id='global' GROUP BY b.cap_microusd,b.call_cap`);
  if(result.rows.length!==1) throw new Error('Existing global budget required; never reset it');
  const row=result.rows[0] as Record<string,string|number>;
  return {capMicrousd:Number(row.cap_microusd),callCap:Number(row.call_cap),calls:Number(row.calls),settledMicrousd:Number(row.settled_microusd),unresolvedMicrousd:Number(row.unresolved_microusd)};
}
async function main():Promise<void> {
  const options=args();
  const offline=options['rules-only']==='true';
  if(!offline&&(options.live!=='true'||process.env.GOAL1_LIVE_ENABLED!=='true')) throw new Error('Explicit --live and GOAL1_LIVE_ENABLED=true required (or --rules-only)');
  const root=options['data-root']??'.';const maxCalls=Number(options['max-calls']??110);const maxUsd=Number(options['max-usd']??0.05);
  const pointer=JSON.parse(await readFile(join(root,'data/research/character-chat-testset.latest.json'),'utf8')) as {directory:string;revision:string};
  if(pointer.directory!==`data/research/character-chat-testsets/${pointer.revision}`||!/^[a-f0-9]{64}$/.test(pointer.revision)) throw new Error('Unsafe testset pointer');
  const evaluator=JSON.parse(await readFile(join(root,pointer.directory,'evaluator.json'),'utf8')) as ChatTestset;
  // Integrity check of the frozen user export; turn texts and ids below come from that export's allowlist.
  validateUserExport(evaluator,JSON.parse(await readFile(join(root,pointer.directory,'user.json'),'utf8')));
  if(evaluator.revision!==pointer.revision||evaluator.conversations.length!==32) throw new Error('Unexpected test set');

  const recorded=new Map<string,Call>();
  if(offline&&options.replay) for(const row of JSON.parse(await readFile(options.replay,'utf8')) as Row[]) recorded.set(`${row.conversationId}#${row.turnIndex}`,row.call);
  const databaseUrl=offline?'':process.env.DATABASE_URL??'';
  if(!offline&&new URL(databaseUrl).pathname!=='/ptr_research') throw new Error('Live calls must use the shared research ledger');
  const pool=offline?undefined:createLocalPool(databaseUrl);
  try {
    const before=pool?await budgetSnapshot(pool):undefined;
    let obtain:(input:{text:string;recentUserTurns:string[];seed:string},key:string)=>Promise<Call>;let modelName=options.model??DEFAULT_JEV_MODEL;
    if(!pool||!before) obtain=async(_input,key)=>recorded.get(key)??{error:'OFFLINE_NO_RECORD',latencyMs:0,costUsd:null,inputTokens:null,created:false};
    else {
    const headroom=Math.min(before.capMicrousd,2_000_000)-before.settledMicrousd-before.unresolvedMicrousd;
    if(before.callCap-before.calls<maxCalls||headroom<maxUsd*1e6) throw new Error('Ledger headroom below this run cap; not starting');
    let spentUsd=0;let calls=0;
    const ledger=new PostgresBudgetLedger(pool,databaseUrl);let created=false;let reservedMicrousd=0;
    const traced={reserve:async(key:string,amount:number,reserveOptions?:{reservedCallFraction?:number})=>{const saved=await ledger.reserve(key,amount,reserveOptions);created=saved.created;reservedMicrousd=saved.request.reservedMicrousd;return saved;},
      submitted:(key:string)=>ledger.submitted(key),finish:(...a:Parameters<typeof ledger.finish>)=>ledger.finish(...a),get:(key:string)=>ledger.get(key)};
    // Generous transport timeout: the service's 1.5 s budget is applied when replaying, so no paid answer is abandoned.
    const client=new OpenRouterClient({...liveOptionsFromEnvironment({...process.env,GOAL1_DATABASE_URL:databaseUrl},traced),timeoutMs:15000});
    const last:{usage?:Record<string,unknown>}={};
    const jev=new JevIntentClassifier({decide:async(request,o)=>{const result=await client.decide(request,o);last.usage=result.usage as Record<string,unknown>;return result;}},modelName);
    modelName=jev.name;
    obtain=async input=>{
        if(calls>=maxCalls||spentUsd>=maxUsd) throw new Error('Run cap reached before finishing; partial results not written as a complete run');
        const call:Call={latencyMs:0,costUsd:null,inputTokens:null,created:false};delete last.usage;created=false;reservedMicrousd=0;
        const began=performance.now();
        try {call.classification=await jev.classify(input,{signal:new AbortController().signal});}
        catch(error) {call.error=error&&typeof error==='object'&&'code' in error?String(error.code):'ERROR';}
        call.latencyMs=Math.round(performance.now()-began);call.created=created;calls++;
        const usage=last.usage as Record<string,unknown>|undefined;
        if(usage){call.costUsd=typeof usage.cost==='number'?usage.cost:null;call.inputTokens=typeof usage.input_tokens==='number'?usage.input_tokens:null;}
        // A new request without a reported cost counts at its full reservation (it may still have been charged).
        spentUsd+=call.costUsd??(call.created?reservedMicrousd/1e6:0);
        return call;
    };
    }
    const rows:Row[]=[];
    for(const conversation of evaluator.conversations) {
      const exported=userConversation(conversation);const history:ChatMessage[]=[];let previousJevArm:TurnIntent|undefined;let previousRule:TurnIntent|undefined;
      for(const [turnIndex,turn] of conversation.turns.entries()) {
        const text=turn.text;const exportedTurn=exported.turns[turnIndex]!;
        const context=retrievalContext(history,text);
        // previousTimeline approximates "the previous reply was a timeline reply" with each arm's own previous routing.
        const signalsFor=(previous:TurnIntent|undefined)=>intentSignals({text,context,explicitTimeline:false,ragCondition:RAG_CONDITION,previousTimeline:previous==='timeline'});
        const ruleSignals=signalsFor(previousRule);const jevSignals=signalsFor(previousJevArm);
        const recentUserTurns=history.filter(message=>!containsCredentialPattern(message.content)&&!isSensitive(message.content)).slice(-2).map(message=>[...message.content].slice(0,300).join(''));
        const input={text:[...text].slice(0,500).join(''),recentUserTurns,seed:exportedTurn.id};
        const call=await obtain(input,`${conversation.id}#${turnIndex}`);
        // Replay the recorded answer through the service's own combination (timeout included).
        const replay={name:modelName,classify:async()=>{
          if(call.error) throw Object.assign(new Error(call.error),{code:call.error});
          if(call.latencyMs>TIMEOUT_MS) return new Promise<never>(()=>undefined);
          return call.classification;
        }};
        const route=(minConfidence:number)=>routeIntent(jevSignals,input,{classifier:replay,minConfidence,timeoutMs:TIMEOUT_MS},new AbortController().signal);
        const routed=await route(THRESHOLD);
        const sweep:Record<string,TurnIntent>={};
        for(const t of THRESHOLDS) sweep[t]=(await route(t)).intent;
        const rule=ruleIntent(ruleSignals);
        rows.push({conversationId:conversation.id,turnIndex,category:conversation.category,language:conversation.language,behavior:turn.evaluator.behavior,expected:EXPECTED[turn.evaluator.behavior],text,
          signals:{strongTimeline:jevSignals.strongTimeline,weakTimeline:jevSignals.weakTimeline,creative:jevSignals.creative,sensitive:jevSignals.sensitive},
          gated:needsIntentClassifier(jevSignals),rule,armRule:ruleIntent(jevSignals),jevArm:routed.intent,routing:routed.routing,call,sweep});
        previousRule=rule;previousJevArm=routed.intent;
        history.push({id:`m-${exportedTurn.id}`,sessionId:'offline',turnId:exportedTurn.id,role:'user',content:text,createdAt:new Date(0).toISOString()});
      }
    }
    const after=pool?await budgetSnapshot(pool):undefined;
    const gated=rows.filter(row=>row.gated);const answered=rows.filter(row=>row.call.classification);
    const latencies=rows.map(row=>row.call.latencyMs);
    const confidences=answered.map(row=>row.call.classification!.confidence);
    const bins=[0,0.2,0.4,0.6,0.8,1.0001];
    const histogram=(values:number[])=>Object.fromEntries(bins.slice(0,-1).map((low,i)=>[`${low.toFixed(1)}-${Math.min(1,bins[i+1]!).toFixed(1)}`,values.filter(v=>v>=low&&v<bins[i+1]!).length]));
    const group=(key:'category'|'language'|'behavior')=>Object.fromEntries([...new Set(rows.map(row=>row[key]))].sort().map(value=>{
      const part=rows.filter(row=>row[key]===value);
      return [value,{n:part.length,reachedJev:part.filter(row=>row.gated).length,rules:accuracy(part,row=>row.rule),rulesPlusJev:accuracy(part,row=>row.jevArm),
        jevAlone:accuracy(part.filter(row=>row.call.classification),jevLabel)}];
    }));
    const changed=rows.filter(row=>row.jevArm!==row.rule);
    const summary={execution:offline?(options.replay?'offline-replay':'rules-only'):'live',label:'jev-intent-routing',testsetRevision:evaluator.revision,model:modelName,ragCondition:RAG_CONDITION,
      threshold:Number(process.env.PTR_JEV_MIN_CONFIDENCE??0.6),timeoutMs:TIMEOUT_MS,utterances:rows.length,jevCalls:rows.filter(row=>row.call.created).length,
      mapping:EXPECTED,
      overall:{rules:accuracy(rows,row=>row.rule),rulesPlusJev:accuracy(rows,row=>row.jevArm),jevAloneOnAnswered:accuracy(answered,jevLabel)},
      confusion:{rules:confusion(rows,row=>row.rule),rulesPlusJev:confusion(rows,row=>row.jevArm)},
      gate:{reachedJev:gated.length,ruleWeakTimeline:gated.filter(row=>row.signals.weakTimeline).length,ruleNoCue:gated.filter(row=>!row.signals.weakTimeline).length,
        rulesOnGated:accuracy(gated,row=>row.rule),rulesPlusJevOnGated:accuracy(gated,row=>row.jevArm),
        changed:{total:changed.length,upgrades:changed.filter(row=>row.jevArm==='timeline').length,downgrades:changed.filter(row=>row.jevArm==='small_talk').length,
          fixed:changed.filter(row=>binary(row)&&row.jevArm===row.expected).length,broke:changed.filter(row=>binary(row)&&row.rule===row.expected).length},
        fallbacks:Object.fromEntries([...new Set(gated.map(row=>(row.routing as {fallbackReason?:string})?.fallbackReason??'none'))].map(reason=>[reason,gated.filter(row=>((row.routing as {fallbackReason?:string})?.fallbackReason??'none')===reason).length]))},
      thresholds:Object.fromEntries(THRESHOLDS.map(t=>[t,{rulesPlusJev:accuracy(rows,row=>row.sweep[t]!),onGated:accuracy(gated,row=>row.sweep[t]!),
        byLanguage:Object.fromEntries(['ko','en'].map(language=>[language,accuracy(rows.filter(row=>row.language===language),row=>row.sweep[t]!)])),
        jevAppliedOnGated:gated.filter(row=>row.call.classification&&row.call.latencyMs<=TIMEOUT_MS&&row.call.classification.confidence>=t).length}])),
      confidence:{all:histogram(confidences),gated:histogram(gated.flatMap(row=>row.call.classification?[row.call.classification.confidence]:[])),
        p50:percentile(confidences,50),meanCorrect:+(answered.filter(row=>binary(row)&&jevLabel(row)===row.expected).reduce((s,row,_,a)=>s+row.call.classification!.confidence/a.length,0)).toFixed(3),
        meanWrong:+(answered.filter(row=>binary(row)&&jevLabel(row)!==row.expected).reduce((s,row,_,a)=>s+row.call.classification!.confidence/a.length,0)).toFixed(3)},
      latencyMs:{p50:percentile(latencies,50),p95:percentile(latencies,95),max:Math.max(...latencies),overTimeout:latencies.filter(v=>v>TIMEOUT_MS).length},
      errors:Object.fromEntries([...new Set(rows.flatMap(row=>row.call.error?[row.call.error]:[]))].map(code=>[code,rows.filter(row=>row.call.error===code).length])),
      falsePositiveRefusals:rows.filter(row=>row.rule==='unsupported'&&row.expected!=='unsupported').map(row=>({conversationId:row.conversationId,turnIndex:row.turnIndex,behavior:row.behavior})),
      cost:{usageCostUsd:+rows.reduce((sum,row)=>sum+(offline?0:row.call.costUsd??0),0).toFixed(8),meanInputTokens:answered.length?Math.round(answered.reduce((s,row)=>s+(row.call.inputTokens??0),0)/answered.length):null,
        createdRequests:rows.filter(row=>row.call.created).length},
      ledger:{before,after},
      byCategory:group('category'),byBehavior:group('behavior'),byLanguage:group('language'),
      ruleDecided:{clarify:Object.fromEntries(['rule','jevArm'].map(arm=>[arm,confusion(rows.filter(row=>row.behavior==='clarify'),row=>row[arm as 'rule'|'jevArm'])])),
        rejectPrivate:confusion(rows.filter(row=>row.behavior==='reject_private'),row=>row.jevArm)},
      limitations:['Expected intents are an agent mapping of draft-silver evaluator behaviours, not human labels.','96 utterances (88 binary-scored); small sample, one run.',
        'previousTimeline is approximated from each arm\'s own previous routing, not a completed reply.','Thresholds other than the run threshold are replayed with the same gate decisions.']};
    const directory=join(__dirname,'..','reports','jev-intent',new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(directory,{recursive:true,mode:0o700});
    await writeFile(join(directory,'rows.private.json'),JSON.stringify(rows,null,1),{mode:0o600});
    await writeFile(join(directory,'summary.json'),JSON.stringify(summary,null,1),{mode:0o600});
    console.log(JSON.stringify({overall:summary.overall,gate:summary.gate,latencyMs:summary.latencyMs,cost:summary.cost,errors:summary.errors}));
    console.log(`report: ${directory}`);
  } finally {await pool?.end();}
}
if(require.main===module) void main().catch(error=>{console.error(error instanceof Error?error.message.slice(0,200):'Jev intent evaluation failed');process.exitCode=1;});
