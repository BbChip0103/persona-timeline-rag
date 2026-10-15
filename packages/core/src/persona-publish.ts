import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { LORE_BYTE_LIMIT, PERSONA_BLOCK_BYTE_LIMIT, loreBytes, personaBlockBytes } from './persona-card';
import { containsCredentialPattern, containsInternalPathPattern, containsUngroundedBiography } from './safety';

/**
 * Publish-time persona checks , fail-closed. Run only when a revision is published, so the rules may
 * narrow without breaking stored revisions. These are narrow regex gates, not a semantic review: for real-person
 * personas the user's confirmation of the publish summary  stays the main control. The private-life
 * patterns are broad on purpose (N5): a harmless phrase that matches must be reworded, there is no exception list.
 * Bump the revision whenever a pattern or limit changes.
 */
export const PERSONA_LINT_REVISION='persona-lint-v6';
export interface PersonaPublishIssue { path:string; rule:string; severity:'error'|'warn' }
export interface PersonaPublishReport { ok:boolean; issues:PersonaPublishIssue[]; lintRevision:string }
export interface PersonaPublishContext {
  /** Test-split captions of the same person (12-code-point leak check). */
  testCaptions:readonly string[];
  /** Whether a source reference exists for this person: a licensed post ID, or `web:<n>` in the private sources document. */
  sourceRefExists(ref:string,personId:string):boolean|Promise<boolean>;
  /**
   * The persona prepare-research generated for the same person, when there is one. Author texts left exactly as
   * generated (the existing style/boundaries sentences, built from development captions only) skip the leak check:
   * common phrases such as "conversational responses" otherwise collide with captions .
   */
  generated?:Persona;
  /**
   * The same persona's revision that was current before this publish (pre-existing approved text, e.g. goal1's refined
   * `dialogue-*` revisions). Style and boundaries lines identical to it skip the leak check and the per-line length
   * limit, and the style count limit while every style line comes from it (style only, intended: the refined
   * revisions have more and longer style lines than the publish limits; boundaries keep their 1–10 count limit). Style
   * lines are compared with the baseline style, boundaries with the baseline boundaries. It must be the same persona id
   * and person (else `baseline_mismatch`, no exemption). Every other rule still applies.
   */
  baseline?:Persona;
  /** The baseline was verified against the target database (a confirmed publish); otherwise a `baseline_unverified` warning. */
  baselineVerified?:boolean;
}
export const EXAMPLE_DIALOGUE_CODE_POINT_LIMIT=800;
export const TEST_CAPTION_OVERLAP_CODE_POINTS=12;

const codePoints=(text:string)=>[...text].length;
/** Our prompt block markers ; an author field must never forge one. */
const BLOCK_MARKERS=['UNTRUSTED_EVIDENCE_JSON_DATA','AGENT_STATE_JSON_DATA','AGENT_TOOLS_JSON_DATA','TOOL_RESULT_JSON_DATA','SAFETY_NOTE_FOR_THIS_TURN',
  'TIMELINE_JSON_REPLY','AGENT_JSON_REPLY','SMALL_TALK_REPLY','CHARACTER_RECOLLECTION','PERSONA_STYLE_EXAMPLES_JSON_DATA','UNTRUSTED_PERSONA_LORE_JSON_DATA','Persona definition'];
const AI_WORDS='AI|A\\.I\\.|에이아이|인공지능|챗봇|봇|로봇|시뮬레이션';
const FORBIDDEN:[string,RegExp[]][]=[
  ['ai_denial',[
    /\b(?:I\s*(?:am|['’]m)|you\s*(?:are|['’]re))\s+(?:(?:definitely|certainly|really|absolutely|totally|honestly|truly|actually)\s+)?not\s+(?:an?\s+)?(?:AI|A\.I\.|bot|chatbot|robot|language model|machine|program|simulation)\b/i,
    /\b(?:definitely|certainly|absolutely|totally|truly)\s+not\s+(?:an?\s+)?(?:AI|A\.I\.|bot|chatbot|robot|language model|machine|program)\b/i,
    /\b(?:I\s*(?:am|['’]m)|you\s*(?:are|['’]re))\s+(?:a\s+)?(?:(?:real|actual|genuine|living)\s+)?(?:person|human)\b/i,
    new RegExp(`(?:${AI_WORDS}|프로그램)\\s*(?:가|이)?\\s*아니`,'i'),
    /(?:나는|난|저는|전|내가|제가)?\s*(?:진짜|실제|진짜로|살아\s*있는)\s*(?:사람|인간)(?:이야|이에요|예요|입니다|이다|이라고|임)/,
    /(?:나는|난|저는|전|내가|제가)\s*(?:사람|인간)(?:이야|이에요|예요|입니다|이다|이라고|임)/,
    /(?:^|\s)(?:나|저)\s+(?:진짜\s*|실제\s*)?(?:사람|인간)(?:이야|이에요|예요|입니다|이다|이라고|임)/,
  ]],
  ['keep_character',[
    /\b(?:never|don['’]?t|do not|must not|mustn['’]t)\s+(?:ever\s+)?(?:break|leave|drop|exit)\s+(?:the\s+|your\s+)?(?:character|role|persona)\b/i,
    /\b(?:stay|remain|keep)\s+in\s+(?:character|role)\b/i,
    /\bin[- ]character at all times\b/i,
    /\b(?:never|don['’]?t|do not|must not|mustn['’]t)\s+(?:ever\s+)?(?:reveal|admit|say|tell|disclose|mention|acknowledge|confirm)\b[^.!?\n]{0,40}?\b(?:AI|A\.I\.|bot|language model|artificial|simulation|machine)\b/i,
    /(?:캐릭터|역할|배역|롤플레이|역할극)(?:을|를|에서)?\s*(?:절대\s*|절대로\s*)?(?:깨지|벗어나지|그만두지|멈추지)\s*(?:마|않|말)/,
    /(?:캐릭터|역할)(?:을|를)?\s*(?:항상|끝까지|계속)\s*유지/,
    new RegExp(`(?:${AI_WORDS})\\s*(?:라고|이라고|임을|인\\s*것을|인\\s*걸|라는\\s*(?:것|사실|걸)을?|인지)?\\s*(?:절대\\s*|절대로\\s*)?(?:밝히|말하|드러내|인정하|들키|알리|고백하)지\\s*(?:마|않|말)`,'i'),
    new RegExp(`(?:${AI_WORDS})(?:임|인\\s*것|라는\\s*것)?(?:을|를)?\\s*숨기`,'i'),
  ]],
  ['instruction',[
    /\bignore\s+(?:all\s+|any\s+|the\s+|your\s+)?(?:previous|prior|above|earlier|system|policy|safety)\b/i,
    /\bsystem\s*prompt\b/i,
    /\b(?:disregard|override|bypass)\s+(?:the\s+|all\s+|any\s+|your\s+)?(?:policy|policies|rules|instructions|guidelines|safety)\b/i,
    /\bdeveloper\s+(?:mode|message)\b|\bjailbreak/i,
    /(?:이전|위|앞|기존|시스템|모든)\s*(?:의\s*)?(?:지시|명령|규칙|지침|정책|프롬프트)(?:을|를|은|는|들)?\s*(?:모두\s*|전부\s*|다\s*)?(?:무시|따르지\s*마)/,
    /시스템\s*프롬프트|프롬프트(?:를|을)?\s*(?:공개|보여|출력)|탈옥/,
  ]],
  ['block_marker',[new RegExp(BLOCK_MARKERS.join('|'),'i')]],
  ['reply_json',[/"(?:evidenceRefs|variableUpdates)"|"(?:status|function)"\s*:/i]],
  // `<|x>` / `<x|>`: Gemma 4's asymmetric control tokens (<|turn>, <turn|>, <|channel>, <tool_call|>, …), parsed as real
  // control tokens when they appear in message content (S8 gate a, vLLM /tokenize).
  ['special_token',[/<\/?(?:start_of_turn|end_of_turn|bos|eos|pad|start_of_image|end_of_image)>|<\|[^|<>\s]{1,40}\|>|<\|[^|<>\s]{1,40}>|<[^|<>\s]{1,40}\|>|\[\/?INST\]|<<\/?SYS>>|<\/?s>/i]],
  // CBS / V1 macros are nondeterministic or substituted ; any double brace is refused.
  ['macro',[/\{\{|\}\}|<\s*\/?\s*(?:BOT|USER|CHAR)\s*>/i]],
];
/** Real-person personas only : family, romance, address, health, real-time location, minors. */
const PRIVATE_LIFE:RegExp[]=[
  /가족|부모|엄마|아빠|어머니|아버지|어머님|아버님|형제|자매|남매|오빠|언니|누나|남편|아내|와이프|배우자|자녀|아들|딸(?!기)|손자|손녀|결혼|이혼|임신|출산|시댁|처가|친정/,
  /연애|남자\s*친구|여자\s*친구|남친|여친|애인|열애|연인|썸(?:남|녀|타)|데이트|헤어졌|이별/,
  /주소|자택|거주지|사는\s*(?:곳|동네|집)|살고\s*있는\s*(?:곳|동네|집)|이사/,
  /건강\s*(?:문제|상태|이상|악화|검진)|질병|질환|투병|병원|병력|지병|진단|수술|입원|치료|우울|공황|정신\s*(?:건강|질환|과)|장애|복용/,
  /현재\s*위치|실시간\s*위치|지금\s*(?:있는|머무는)\s*곳|지금\s*어디/,
  /미성년|어린이|초등학생|중학생|고등학생|청소년|아동/,
  /\b(?:family|families|parents?|mom|mum|mother|dad|father|siblings?|brothers?|sisters?|husband|wife|spouse|kids?|child|children|sons?|daughters?|grand(?:son|daughter|parents?|ma|pa)|married|marriage|divorced?|pregnan\w*|wedding)\b/i,
  /\b(?:boyfriend|girlfriend|dating|romance|romantic|lover|fianc[eé]e?|crush|breakup|broke up)\b/i,
  /\b(?:home address|address|lives? in|living in|resides?|residence|moved to)\b/i,
  /\b(?:health (?:issues?|problems?|conditions?|scare)|illness|disease|diagnos\w*|surgery|hospital\w*|therapy|depression|disorder|disabilit\w*|medication|cancer)\b/i,
  /\b(?:current(?:ly)?\s+(?:location|located|in|at|based)|real[- ]time location|right now (?:in|at))\b/i,
  /\b(?:minors?|underage|teen(?:ager)?s?|juvenile)\b/i,
];
const DATE_PLACE:RegExp[]=[
  /\b(?:19|20)\d{2}\b|\d{4}\s*년|\d{1,2}\s*월\s*\d{1,2}\s*일|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}\b/,
  /[가-힣]{1,10}(?:시|구|동|역|공항)에서|\b(?:in|at)\s+(?:[A-Z][a-z]+\s){1,3}(?:City|Station|Airport|Street|St\.|Avenue)\b/,
];
type Group='label'|'card'|'core'|'greeting'|'personality'|'background'|'example'|'lore'|'meta';
/** Card copy is public character-facing text, not an operator or research surface. */
const CARD_COPY_FORBIDDEN=/(?:게시물|캡션|자료|연구|근거|출처|검수|리비전|검색|실험|평가|디버그|시스템|프롬프트|모델|운영자|데이터베이스|시뮬레이션|(?<![\p{L}\p{N}_])model(?=[가-힣])|(?<![\p{L}\p{N}_])(?:research|evidence|sources?|retrieval|revision|experiment|evaluation|debug|system|prompt|model|operator|database|simulation|rag|api)(?![\p{L}\p{N}_]))/iu;
/** Every author-written string that is rendered (plus label and meta, shown in the UI), with its report path. */
function authorFields(p:Persona):{path:string;text:string;group:Group}[] {
  const out:{path:string;text:string;group:Group}[]=[];
  const add=(group:Group,path:string,text:string)=>{out.push({path,text,group});};
  add('label','label',p.label);add('core','id',p.id);add('core','language',p.language);add('core','identity',p.identity);add('core','concept',p.concept);
  if(p.tagline!==undefined) add('card','tagline',p.tagline);
  p.starters?.forEach((text,i)=>add('card',`starters[${i}]`,text));
  p.style.forEach((text,i)=>add('core',`style[${i}]`,text));p.boundaries.forEach((text,i)=>add('core',`boundaries[${i}]`,text));
  add('greeting','greeting',p.greeting);p.alternateGreetings?.forEach((text,i)=>add('greeting',`alternateGreetings[${i}]`,text));
  if(p.personality) {
    if(p.personality.summary!==undefined) add('personality','personality.summary',p.personality.summary);
    for(const key of ['traits','values','speechHabits'] as const) p.personality[key].forEach((text,i)=>add('personality',`personality.${key}[${i}]`,text));
  }
  if(p.background) add('background','background.text',p.background.text);
  p.exampleDialogues?.forEach((dialogue,d)=>dialogue.turns.forEach((turn,t)=>add('example',`exampleDialogues[${d}].turns[${t}].text`,turn.text)));
  p.lore?.forEach((entry,i)=>{add('lore',`lore[${i}].id`,entry.id);add('lore',`lore[${i}].content`,entry.content);entry.keys.forEach((key,k)=>add('lore',`lore[${i}].keys[${k}]`,key));});
  p.meta?.tags?.forEach((text,i)=>add('meta',`meta.tags[${i}]`,text));
  if(p.meta?.creatorNotes!==undefined) add('meta','meta.creatorNotes',p.meta.creatorNotes);
  return out;
}
/** NFKC, lower case and collapsed whitespace, so case, width and spacing do not hide a copied caption. */
/** NFKD, combining marks (accents, strokes, variation selectors, CGJ) removed, then NFKC; Hangul jamo recompose. */
const withoutMarks=(text:string)=>text.normalize('NFKD').replace(/\p{M}/gu,'').normalize('NFKC');
/** Characters that render as nothing (or as blank) without being whitespace: Hangul fillers, braille blank. */
const FILLERS=/[\u115F\u1160\u3164\uFFA0\u2800]/gu;
const leakForm=(text:string)=>withoutMarks(text).replace(/\p{Cf}/gu,'').replace(FILLERS,'').toLowerCase().replace(/\s+/g,' ');
/**
 * Invisible in review and able to split a pattern: format, control, private-use and unassigned characters, U+2028/U+2029, the
 * combining grapheme joiner, Hangul fillers, the braille blank, Mongolian and Unicode variation selectors, and any
 * combining mark written after an ASCII letter. Emoji sequences are allowed: keycaps ([0-9#*] VS16 U+20E3), VS16 after a pictograph and ZWJ between
 * pictographs (with an optional VS16 and skin tone) are removed before this test. Precomposed letters (café) pass.
 */
const INVISIBLE=/[\p{Cf}\p{Cc}\p{Co}\p{Cn}\u2028\u2029\u034F\u115F\u1160\u3164\uFFA0\u2800\u180B-\u180F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]|[A-Za-z]\p{M}/u;
const withoutEmojiJoiners=(text:string)=>text
  .replace(/([0-9#*])\uFE0F\u20E3/gu,'$1')
  .replace(/(?<=\p{Extended_Pictographic}\uFE0F?[\u{1F3FB}-\u{1F3FF}]?)\u200D(?=\p{Extended_Pictographic})/gu,'')
  .replace(/(?<=\p{Extended_Pictographic})\uFE0F/gu,'');
/**
 * Letters that render like Latin ones, folded before the forbidden-pattern checks: a fixed subset (Cyrillic, Greek,
 * Latin small capitals, dotless i/j), not the full Unicode confusables table.
 */
const CONFUSABLES:Record<string,string>={'А':'A','В':'B','Е':'E','К':'K','М':'M','Н':'H','О':'O','Р':'P','С':'C','Т':'T','Х':'X','У':'Y','І':'I','Ј':'J','Ѕ':'S',
  'а':'a','в':'b','е':'e','к':'k','м':'m','н':'h','о':'o','р':'p','с':'c','т':'t','у':'y','х':'x','і':'i','ј':'j','ѕ':'s','ԁ':'d','һ':'h','ӏ':'l',
  'Α':'A','Β':'B','Ε':'E','Ζ':'Z','Η':'H','Ι':'I','Κ':'K','Μ':'M','Ν':'N','Ο':'O','Ρ':'P','Τ':'T','Υ':'Y','Χ':'X','α':'a','ο':'o','ι':'i','ν':'v','κ':'k','ρ':'p','τ':'t','υ':'u','χ':'x',
  'ᴀ':'a','ʙ':'b','ᴄ':'c','ᴅ':'d','ᴇ':'e','ꜰ':'f','ɢ':'g','ʜ':'h','ɪ':'i','ᴊ':'j','ᴋ':'k','ʟ':'l','ᴍ':'m','ɴ':'n','ᴏ':'o','ᴘ':'p','ʀ':'r','ꜱ':'s','ᴛ':'t','ᴜ':'u',
  'ᴠ':'v','ᴡ':'w','ʏ':'y','ᴢ':'z','ı':'i','ȷ':'j'};
/**
 * The form the forbidden-pattern checks see: NFKD → marks removed → NFKC (full-width → ASCII, accents and selectors
 * gone), format/private-use characters and fillers removed, control characters and separators as spaces, look-alike
 * letters folded to Latin.
 */
const checkForm=(text:string)=>withoutMarks(text).replace(/[\p{Cf}\p{Co}]/gu,'').replace(FILLERS,'').replace(/[\p{Cc}\u2028\u2029]/gu,' ')
  .replace(/[^\x00-\x7F]/gu,char=>CONFUSABLES[char]??char);
/**
 * A word with Latin letters and a letter of any script other than Latin, Common, Inherited, Hangul, Han, Hiragana or
 * Katakana (Cyrillic, Greek, Armenian, Cherokee, Tifinagh, ...). Runs on the raw text: NFKC would turn the micro sign
 * into Greek mu.
 */
const FOREIGN_LETTER=/[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const mixedScriptWord=(text:string)=>(text.match(/\p{L}+/gu)??[]).some(word=>/\p{Script=Latin}/u.test(word)&&FOREIGN_LETTER.test(word));
function windows(text:string,size:number):string[] {
  const points=[...leakForm(text)];const out:string[]=[];
  for(let i=0;i+size<=points.length;i++) out.push(points.slice(i,i+size).join(''));
  return out;
}
const formatPath=(path:readonly (string|number)[])=>path.reduce<string>((out,part)=>typeof part==='number'?`${out}[${part}]`:out?`${out}.${part}`:part,'');

/** `${reviewStatus}-` + 16 hex of sha256 over the parsed document without `revision` (prepare-research rule, generalized). */
export function personaRevision(input:unknown):string {
  const {revision:_,...rest}=PersonaSchema.parse({...(input as object),revision:'pending'});
  return `${rest.reviewStatus}-${createHash('sha256').update(JSON.stringify(rest)).digest('hex').slice(0,16)}`;
}

/** Reports `{path, rule, severity}` only, never field text. `ok` is false when any error exists. */
export async function validatePersonaForPublish(input:unknown,context:PersonaPublishContext):Promise<PersonaPublishReport> {
  const parsed=PersonaSchema.safeParse(input);
  if(!parsed.success) {
    const seen=new Set<string>();
    const issues=parsed.error.issues.map(issue=>formatPath(issue.path)).filter(path=>!seen.has(path)&&!!seen.add(path)).map(path=>({path,rule:'schema',severity:'error' as const}));
    return {ok:false,issues,lintRevision:PERSONA_LINT_REVISION};
  }
  const p=parsed.data,issues:PersonaPublishIssue[]=[],keys=new Set<string>();
  const report=(path:string,rule:string,severity:'error'|'warn'='error')=>{const key=`${path}\u0000${rule}`;if(!keys.has(key)){keys.add(key);issues.push({path,rule,severity});}};
  const realPerson=p.reviewStatus!=='synthetic';
  // Publish limits of the v1 fields (the read schema stays wide for stored revisions).
  const limit=(path:string,count:number,max:number,min=0)=>{if(count>max||count<min)report(path,'limit');};
  limit('label',codePoints(p.label),60);limit('identity',codePoints(p.identity),300);limit('concept',codePoints(p.concept),300);
  const baseline=context.baseline&&context.baseline.id===p.id&&context.baseline.personId===p.personId?context.baseline:undefined;
  if(context.baseline&&!baseline) report('','baseline_mismatch');
  if(baseline&&!context.baselineVerified) report('','baseline_unverified','warn');
  const baselineStyle=new Set(baseline?.style??[]),baselineBoundaries=new Set(baseline?.boundaries??[]);
  const styleFromBaseline=p.style.length>0&&p.style.length<=(baseline?.style.length??0)&&p.style.every(text=>baselineStyle.has(text));
  if(!styleFromBaseline) limit('style',p.style.length,8);
  p.style.forEach((text,i)=>{if(!baselineStyle.has(text)) limit(`style[${i}]`,codePoints(text),120);});
  limit('boundaries',p.boundaries.length,10,1);p.boundaries.forEach((text,i)=>{if(!baselineBoundaries.has(text)) limit(`boundaries[${i}]`,codePoints(text),160);});
  limit('sourceRefs',p.sourceRefs.length,50);limit('greeting',codePoints(p.greeting),300);
  const exampleTotal=(p.exampleDialogues??[]).reduce((sum,dialogue)=>sum+dialogue.turns.reduce((inner,turn)=>inner+codePoints(turn.text),0),0);
  if(exampleTotal>EXAMPLE_DIALOGUE_CODE_POINT_LIMIT) report('exampleDialogues','example_total');
  const loreIds=new Set<string>();
  p.lore?.forEach((entry,i)=>{
    if(loreIds.has(entry.id)) report(`lore[${i}].id`,'lore_duplicate_id');
    if(!entry.id.startsWith('lore-')) report(`lore[${i}].id`,'lore_id_prefix');
    loreIds.add(entry.id);
    if(loreBytes([entry])>LORE_BYTE_LIMIT) report(`lore[${i}]`,'budget_lore_entry');
  });
  if(personaBlockBytes(p)>PERSONA_BLOCK_BYTE_LIMIT) report('','budget_persona_block');
  // Only the generated (or baseline) style and boundaries sentences are exempt from the leak check (review fix), each
  // against the same field: a style sentence never exempts the same text in boundaries, nor the other way round.
  const exemptStyle=new Set([...(context.generated?.style??[]),...baselineStyle]);
  const exemptBoundaries=new Set([...(context.generated?.boundaries??[]),...baselineBoundaries]);
  if(realPerson&&!context.testCaptions.length) report('','leak_check_unavailable');
  const leaks=new Set(context.testCaptions.flatMap(caption=>windows(caption,TEST_CAPTION_OVERLAP_CODE_POINTS)));
  for(const {path,text,group} of authorFields(p)) {
    const folded=checkForm(text),matches=(pattern:RegExp)=>pattern.test(text)||pattern.test(folded);
    if(group==='card'&&matches(CARD_COPY_FORBIDDEN)) report(path,'card_copy');
    if(INVISIBLE.test(withoutEmojiJoiners(path==='meta.creatorNotes'?text.replace(/\n/g,''):text))) report(path,'invisible_char');
    if(mixedScriptWord(text)) report(path,'homoglyph');
    for(const [rule,patterns] of FORBIDDEN) if(patterns.some(matches)) report(path,rule);
    if(containsCredentialPattern(text)||containsCredentialPattern(folded)) report(path,'credential');
    if(containsInternalPathPattern(text)||containsInternalPathPattern(folded)) report(path,'internal_path');
    const exempt=/^style\[/.test(path)&&exemptStyle.has(text)||/^boundaries\[/.test(path)&&exemptBoundaries.has(text);
    if(group!=='label'&&group!=='meta'&&leaks.size&&!exempt&&windows(text,TEST_CAPTION_OVERLAP_CODE_POINTS).some(window=>leaks.has(window))) report(path,'test_caption_overlap');
    if(realPerson&&['card','greeting','personality','background','example','lore'].includes(group)&&PRIVATE_LIFE.some(matches)) report(path,'private_life');
    // Background text is stored as a third-person character sheet (a storage format; the model speaks about it in the
    // first person): it gets the private-life check instead of the biography check .
    if(['card','greeting','personality','example'].includes(group)&&(containsUngroundedBiography(text)||containsUngroundedBiography(folded))) report(path,'biography',realPerson?'error':'warn');
    if(group!=='label'&&group!=='meta'&&DATE_PLACE.some(pattern=>pattern.test(text))) report(path,'date_place','warn');
  }
  const refs:[string,string][]=[...p.sourceRefs.map((ref,i)=>[`sourceRefs[${i}]`,ref] as [string,string]),
    ...(p.background?.sourceRefs??[]).map((ref,i)=>[`background.sourceRefs[${i}]`,ref] as [string,string]),
    ...(p.lore??[]).flatMap((entry,l)=>entry.sourceRefs.map((ref,i)=>[`lore[${l}].sourceRefs[${i}]`,ref] as [string,string]))];
  for(const [path,ref] of refs) {
    try {if(!await context.sourceRefExists(ref,p.personId)) report(path,'source_missing');}
    catch {report(path,'source_lookup_failed');}
  }
  return {ok:!issues.some(issue=>issue.severity==='error'),issues,lintRevision:PERSONA_LINT_REVISION};
}

/**
 * Persona list files. The publish CLI writes the authored list as `{database, personas}` so a list is bound to the
 * database it was published to; the generated list (prepare-research) and older lists are plain arrays.
 */
export const AuthoredPersonaListSchema=z.object({database:z.string().min(1),personas:z.array(PersonaSchema)}).strict();
export function parsePersonaList(raw:unknown):{database?:string;personas:Persona[]} {
  if(Array.isArray(raw)) return {personas:z.array(PersonaSchema).parse(raw)};
  return AuthoredPersonaListSchema.parse(raw);
}
