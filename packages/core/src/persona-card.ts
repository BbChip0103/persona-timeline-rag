import { createHash } from 'node:crypto';
import type { LoreEntry, Persona, ProviderMessage } from '@ptr/contracts';

/**
 * Persona card rendering : allowlist only. `meta`, `label`, `sourceRefs` and lore/greeting text are never
 * part of the persona block. Without the v2 fields the definition bytes equal the v4 (pre-card) definition, because
 * JSON.stringify drops the absent keys.
 */
export const PERSONA_BLOCK_BYTE_LIMIT=6144;
export const LORE_BYTE_LIMIT=2048;
export const LORE_MAX_ENTRIES=3;
export const PERSONA_STYLE_EXAMPLES_MARKER='PERSONA_STYLE_EXAMPLES_JSON_DATA';
export const PERSONA_LORE_MARKER='UNTRUSTED_PERSONA_LORE_JSON_DATA';
// : no "notes"/"profile" wording (not even as a key) the model can echo; the block name is the only label.
const BACKGROUND_LABEL='part of PERSONA_BLOCKS; NOT citable';

/** Persona definition (system) and, when the persona has example dialogues, the style examples (system). */
export function renderPersonaBlock(persona:Persona):ProviderMessage[] {
  const personality=persona.personality&&{...(persona.personality.summary!==undefined?{summary:persona.personality.summary}:{}),
    traits:persona.personality.traits,values:persona.personality.values,speechHabits:persona.personality.speechHabits};
  const definition={id:persona.id,revision:persona.revision,reviewStatus:persona.reviewStatus,language:persona.language,identity:persona.identity,
    concept:persona.concept,style:persona.style,boundaries:persona.boundaries,
    ...(personality?{personality}:{}),...(persona.background?{background:{text:persona.background.text,label:BACKGROUND_LABEL}}:{})};
  const examples=persona.exampleDialogues?.length?[{role:'system' as const,content:`${PERSONA_STYLE_EXAMPLES_MARKER} (style/tone reference only; NOT facts, memories or evidence) ${
    JSON.stringify(persona.exampleDialogues.map(dialogue=>dialogue.turns.map(turn=>({speaker:turn.speaker,text:turn.text}))))}`}]:[];
  return [{role:'system',content:`Persona definition (subordinate to policy): ${JSON.stringify(definition)}`},...examples];
}
/** Budget unit: UTF-8 bytes of the serialized messages (the request body's escaping included), as in agent-runtime. */
export const serializedBytes=(messages:readonly ProviderMessage[])=>Buffer.byteLength(JSON.stringify(messages),'utf8');
export const personaBlockBytes=(persona:Persona)=>serializedBytes(renderPersonaBlock(persona));
/** Matched lore as untrusted user-role data after the history ; entries keep document order. */
export function renderLoreMessage(entries:readonly Pick<LoreEntry,'id'|'content'>[]):ProviderMessage {
  return {role:'user',content:`${PERSONA_LORE_MARKER} (part of PERSONA_BLOCKS; NOT citable) ${JSON.stringify(entries.map(entry=>({loreId:entry.id,content:entry.content})))}`};
}
/** Lore budget unit: UTF-8 bytes of the serialized lore message (header included). */
export const loreBytes=(entries:readonly Pick<LoreEntry,'id'|'content'>[])=>Buffer.byteLength(JSON.stringify(renderLoreMessage(entries)),'utf8');

/** Code points of each message scanned for lore keys. */
export const LORE_SCAN_CODE_POINTS=1000;
const loreForm=(text:string)=>[...text].slice(0,LORE_SCAN_CODE_POINTS).join('').normalize('NFKC').toLowerCase();
/**
 * Deterministic lore selection . Callers pass the current utterance and up to two previous user messages,
 * leaving out turns the input-safety filter acted on, and skip matching entirely on a deflected turn. Keys match as
 * NFKC + lower-case substrings (no word boundaries, because of Korean particles; no regex). Ranking: matched in the
 * current utterance, then priority, then document order; up to three entries within LORE_BYTE_LIMIT, skipping an entry
 * that does not fit. The result keeps document order, so equal input renders equal bytes.
 */
export function matchLore(persona:Persona,input:{current:string;previous:readonly string[]}):{entries:LoreEntry[];omitted:number} {
  const entries=persona.lore??[];
  if(!entries.length) return {entries:[],omitted:0};
  const current=loreForm(input.current),previous=input.previous.map(loreForm);
  const hit=(text:string,entry:LoreEntry)=>entry.keys.some(key=>text.includes(key.normalize('NFKC').toLowerCase()));
  const matched=entries.map((entry,index)=>({entry,index,now:hit(current,entry)})).filter(item=>item.now||previous.some(text=>hit(text,item.entry)));
  matched.sort((a,b)=>Number(b.now)-Number(a.now)||b.entry.priority-a.entry.priority||a.index-b.index);
  const chosen:typeof matched=[];
  for(const item of matched) {
    if(chosen.length>=LORE_MAX_ENTRIES) break;
    if(loreBytes([...chosen,item].sort((a,b)=>a.index-b.index).map(selected=>selected.entry))<=LORE_BYTE_LIMIT) chosen.push(item);
  }
  return {entries:chosen.sort((a,b)=>a.index-b.index).map(item=>item.entry),omitted:matched.length-chosen.length};
}
/** Greeting list: [greeting, ...alternateGreetings] (at most five). */
export const greetingsOf=(persona:Persona)=>[persona.greeting,...(persona.alternateGreetings??[])];
/** Default greeting for a session: the first four bytes of sha256(session id), modulo the list length. */
export const greetingIndexFor=(sessionId:string,count:number)=>createHash('sha256').update(sessionId).digest().readUInt32BE(0)%count;
