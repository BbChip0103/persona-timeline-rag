/**
 * Offline prefix-gain estimate for the cache-friendly prompt layout (stable prefix first; zero cost, no model or tokenizer calls).
 *
 *   pnpm exec tsx scripts/prompt-prefix-gain.ts --workload=reports/jev-gemma-bench/<run>/workload.private.json [--bytes-per-token=4.45] [--block-tokens=16]
 *
 * Input: a captured chat workload (`chat[]` of {conversationId, turnIndex, iteration, messages}) in the previous layout
 * (policy[+note] · persona · state · tools · history · evidence · user · transcript). Each call is rebuilt in the cache-friendly
 * layout (stable prefix first) by moving its own messages (policy · persona · history · state · tools · evidence · [note] · user ·
 * transcript), which is byte-identical to what buildExperimentContext now renders for the same inputs.
 *
 * For each call in capture order, the cacheable prefix is the longest common byte prefix with any EARLIER call (an
 * unbounded prefix cache that never evicts: an upper bound), split into the part shared with other conversations
 * (global: policy, persona, greeting) and the extra part only the same conversation provides (session history, which
 * only hits when the call lands on the engine that served that conversation before). Bytes become tokens at
 * `bytesPerToken` (median UTF-8 bytes / vLLM prompt_tokens = 4.45 on these captures, Gemma tokenizer), floored to
 * whole KV blocks (`blockTokens`, vLLM's default 16) because only full blocks are reused. Messages are serialized with a
 * generic chat-template wrapper; the real template adds a few constant bytes per message. Output: aggregates only (no
 * prompt text).
 */
import { readFileSync } from 'node:fs';
import type { ProviderMessage } from '@ptr/contracts';
import { SAFETY_DEFLECTION_NOTE } from '@ptr/core';

export interface CapturedCall { conversationId:string; turnIndex:number; iteration:number; messages:ProviderMessage[] }
export type Layout='previous'|'s7';
const tagged=(message:ProviderMessage,tag:string)=>message.content.startsWith(tag);
const isAgentBlock=(message:ProviderMessage)=>message.role==='system'&&(tagged(message,'AGENT_STATE_JSON_DATA ')||tagged(message,'AGENT_TOOLS_JSON_DATA '));

/** Previous-layout call → the same messages in the cache-friendly order (stable prefix first; a note appended to the policy becomes its own message). */
export function toS7Layout(messages:readonly ProviderMessage[]):ProviderMessage[] {
  const [policy,persona,...rest]=messages;
  if(!policy||!persona) throw new Error('CALL_TOO_SHORT');
  const noteAt=policy.content.lastIndexOf(` ${SAFETY_DEFLECTION_NOTE}`);
  const note=noteAt>=0&&noteAt+1+SAFETY_DEFLECTION_NOTE.length===policy.content.length;
  const agent=rest.filter(isAgentBlock), others=rest.filter(message=>!isAgentBlock(message));
  const evidence=others.findIndex(message=>message.role==='user'&&tagged(message,'UNTRUSTED_EVIDENCE_JSON_DATA '));
  // Without evidence (legacy small talk) the user utterance is the last message; agent tool transcripts always follow evidence.
  const userAt=evidence>=0?evidence+1:others.length-1;
  const history=others.slice(0,evidence>=0?evidence:userAt);
  return [{role:'system',content:note?policy.content.slice(0,noteAt):policy.content},persona,...history,...agent,
    ...(evidence>=0?[others[evidence]!]:[]),...(note?[{role:'system' as const,content:SAFETY_DEFLECTION_NOTE}]:[]),others[userAt]!,...others.slice(userAt+1)];
}
/** The same call as a deflected turn in each layout (what a `prompt_injection` deflection would have sent). */
export function deflected(messages:readonly ProviderMessage[],layout:Layout):ProviderMessage[] {
  const previous=[{role:'system' as const,content:`${messages[0]!.content} ${SAFETY_DEFLECTION_NOTE}`},...messages.slice(1)];
  return layout==='previous'?previous:toS7Layout(previous);
}
export const serialize=(messages:readonly ProviderMessage[]):Buffer=>Buffer.from(messages.map(message=>`<|${message.role}|>\n${message.content}<|end|>\n`).join(''),'utf8');
export function commonPrefixBytes(a:Buffer,b:Buffer):number {
  const n=Math.min(a.length,b.length);let i=0;
  while(i<n&&a[i]===b[i])i++;
  return i;
}
export interface CallGain { conversationId:string; turnIndex:number; totalTokens:number; globalTokens:number; sessionTokens:number }
/** Per call: prompt tokens and the cacheable prefix (whole blocks) from other conversations (global) and from any earlier call. */
export function prefixGains(calls:readonly {conversationId:string;turnIndex:number;messages:ProviderMessage[]}[],options:{bytesPerToken:number;blockTokens:number}):CallGain[] {
  const blocks=(bytes:number)=>Math.floor(bytes/options.bytesPerToken/options.blockTokens)*options.blockTokens;
  const seen:{conversationId:string;bytes:Buffer}[]=[];
  return calls.map(call=>{
    const bytes=serialize(call.messages);let global=0,session=0;
    for(const earlier of seen) {
      const shared=commonPrefixBytes(bytes,earlier.bytes);
      session=Math.max(session,shared);if(earlier.conversationId!==call.conversationId)global=Math.max(global,shared);
    }
    seen.push({conversationId:call.conversationId,bytes});
    return {conversationId:call.conversationId,turnIndex:call.turnIndex,totalTokens:bytes.length/options.bytesPerToken,globalTokens:blocks(global),sessionTokens:blocks(session)};
  });
}
const share=(gains:readonly CallGain[],key:'globalTokens'|'sessionTokens')=>{
  const total=gains.reduce((sum,gain)=>sum+gain.totalTokens,0);
  return total?+(gains.reduce((sum,gain)=>sum+gain[key],0)/total).toFixed(3):null;
};
function quantile(values:number[],p:number):number|null {
  if(!values.length) return null;const sorted=[...values].sort((a,b)=>a-b);
  return +sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(p*sorted.length)-1))]!.toFixed(3);
}
/** Shares of prompt tokens that are cacheable: per turn index, per session (distribution) and overall. */
export function summarize(gains:readonly CallGain[]) {
  const turns=[...new Set(gains.map(gain=>gain.turnIndex))].sort((a,b)=>a-b);
  const sessions=[...new Set(gains.map(gain=>gain.conversationId))].map(id=>gains.filter(gain=>gain.conversationId===id));
  const sessionShares=(key:'globalTokens'|'sessionTokens')=>sessions.map(list=>share(list,key)!);
  return {
    calls:gains.length,sessions:sessions.length,meanPromptTokens:+(gains.reduce((sum,gain)=>sum+gain.totalTokens,0)/(gains.length||1)).toFixed(0),
    overall:{global:share(gains,'globalTokens'),session:share(gains,'sessionTokens')},
    byTurn:turns.map(turnIndex=>{const list=gains.filter(gain=>gain.turnIndex===turnIndex);
      return {turnIndex,calls:list.length,meanPromptTokens:+(list.reduce((sum,gain)=>sum+gain.totalTokens,0)/list.length).toFixed(0),global:share(list,'globalTokens'),session:share(list,'sessionTokens')};}),
    bySession:{global:{p10:quantile(sessionShares('globalTokens'),0.1),p50:quantile(sessionShares('globalTokens'),0.5),p90:quantile(sessionShares('globalTokens'),0.9)},
      session:{p10:quantile(sessionShares('sessionTokens'),0.1),p50:quantile(sessionShares('sessionTokens'),0.5),p90:quantile(sessionShares('sessionTokens'),0.9)}},
  };
}
function argument(name:string):string|undefined {return process.argv.slice(2).find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);}
function main():void {
  const path=argument('workload');if(!path) throw new Error('--workload=<workload.private.json> required');
  const options={bytesPerToken:Number(argument('bytes-per-token')??4.45),blockTokens:Number(argument('block-tokens')??16)};
  const workload=JSON.parse(readFileSync(path,'utf8')) as {chat:CapturedCall[]};
  const calls=workload.chat;
  // Consistency of the capture with the layout claim: turn N+1's history extends turn N's (same conversation).
  let extended=0,pairs=0;
  for(const [index,call] of calls.entries()) {
    const previous=calls.slice(0,index).reverse().find(other=>other.conversationId===call.conversationId&&other.turnIndex<call.turnIndex);
    if(!previous) continue;pairs++;
    const a=toS7Layout(previous.messages),b=toS7Layout(call.messages),end=a.findIndex(isAgentBlock);
    if(end>0&&JSON.stringify(b.slice(0,end))===JSON.stringify(a.slice(0,end)))extended++;
  }
  const run=(layout:Layout,deflect:boolean)=>summarize(prefixGains(calls.map(call=>({...call,
    messages:deflect?deflected(call.messages,layout):layout==='s7'?toS7Layout(call.messages):call.messages})),options));
  const deflectedOnly=(layout:Layout)=>{
    // Each call as a deflected turn against all the ordinary calls before it (deflection is rare: the others are normal).
    const normal=calls.map(call=>layout==='s7'?toS7Layout(call.messages):call.messages);
    const gains=calls.map((call,index)=>prefixGains([...calls.slice(0,index).map((other,j)=>({...other,messages:normal[j]!})),{...call,messages:deflected(call.messages,layout)}],options).at(-1)!);
    return {overall:{global:share(gains,'globalTokens'),session:share(gains,'sessionTokens')}};
  };
  process.stdout.write(`${JSON.stringify({method:{workloadCalls:calls.length,...options,cache:'unbounded, capture order, whole blocks',
    historyExtendsPreviousTurn:`${extended}/${pairs}`},
  previous:run('previous',false),s7:run('s7',false),deflectedTurn:{previous:deflectedOnly('previous'),s7:deflectedOnly('s7')}},null,1)}\n`);
}
if(require.main===module) {try {main();} catch(error) {process.stderr.write(`PREFIX_GAIN_FAILED ${(error as Error).message}\n`);process.exitCode=1;}}
