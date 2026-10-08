import type { IntentRouting, RagCondition } from '@ptr/contracts';
import { isPostMemoryRequest, type retrievalContext } from './conversation-context';
import { isBiographicalRequest } from './safety';

export type TurnIntent=IntentRouting['ruleIntent'];
export type ClassifiedIntent='timeline'|'small_talk';
export interface IntentClassification { label:ClassifiedIntent; confidence:number; probabilities:Record<ClassifiedIntent,number> }
/**
 * Optional second opinion on the timeline/small_talk split. `seed` is the turn id: it makes adapter-side choices
 * (label order) reproducible and scopes billing idempotency to the turn; implementations must not send it upstream.
 * Undefined means "no answer".
 */
export interface IntentClassifier {
  readonly name:string;
  classify(input:{text:string;recentUserTurns:string[];seed:string},options:{signal:AbortSignal}):Promise<IntentClassification|undefined>;
}
export interface IntentClassifierOptions { classifier:IntentClassifier; minConfidence:number; timeoutMs:number }

const SENSITIVE=/phone number|home address|private address|real.time location|rumou?r|secret relationship|연락처|전화번호|집 주소|주거지|실시간 위치|사생활|루머|미성년/i;
/**
 * Current whereabouts and in-person visit requests, in present or request form only. Not matched: past places and
 * stays ("어디 갔어?", "숙소 어디였어?", "제주 여행 때 숙소 어디 잡았어?", "where did you live?", "where are you staying in that
 * photo?"), meeting someone else ("친구 만나러 갈래?"), hometown ("where are you from?"), wishes ("어디 살고
 * 싶어?"), a photo's location ("이 사진 지금 어디야?"), past meetings ("직접 만나봤어?"), seeing a performance
 * ("go see you perform"), and a bare "stop by" without a visit to the persona.
 */
const WHEREABOUTS=new RegExp([
  String.raw`(?<!(?:사진|그림|이거|그거|저거|이곳|그곳|거기|여기|장소|가게|카페)[은는이가]?\s*)지금\s?어디\s?(?:야|있|에\s?있|예요|에요|세요|인지|쯤)`,
  String.raw`(?:지금|현재)\s?위치`,String.raw`지금\s?있는\s?(?:곳|데|카페|장소|가게|식당|호텔|숙소)`,
  String.raw`어디\s?(?:살아|사세요|사니|사는지|사냐)`,String.raw`(?:네가|너가|니가|너|당신)\S{0,2}\s?사는\s?곳|사는\s?곳(?:이|은)?\s?어디`,
  // 집/숙소 … 어디: refused when anchored to the present, or when the message has no past-trip/photo marker.
  String.raw`(?:지금|요즘|이번|오늘|현재)[^.?!\n]{0,15}(?:집|숙소)\s?(?:이|은|는)?\s?어디`,
  String.raw`^(?![\s\S]*(?:때|작년|지난|여행|사진|었|였))[\s\S]*(?:집|숙소)\s?(?:이|은|는)?\s?어디`,
  String.raw`찾아\s?갈게|(?:만나러|찾아)\s?(?:갈게|갈께|가도\s?(?:돼|될까))|(?:나|저|너|당신|널|날)\S{0,2}\s?(?:만나러|찾아)\s?갈래|(?:직접|실제로)\s?(?:만나자|만나러|만나고\s?싶|만나도\s?돼|만날래|만나볼래)`,
  String.raw`\bwhere\s+(?:are|r)\s+(?:you|u)\s+(?:right\s+)?now\b|\bwhere\s+you\s+are\s+(?:right\s+)?now\b`,
  String.raw`\bwhere\s+do\s+you\s+live\b|\bwhere\s+are\s+you\s+(?:staying|living|based)\b(?!\s+in\s+(?:that|this|the)\s+(?:photo|picture|pic|post|video))|\byour\s+(?:home\s+|current\s+)?address\b`,
  String.raw`\b(?:are\s+you|you're|you\s+are)\s+(?:nearby|near\s+me|around\s+here)\b`,
  String.raw`\b(?:come|go)\s+(?:see|meet|visit)\s+you\b(?!\s+(?:perform|play|sing|dance|speak|present|compete|race)\w*)|\bmeet\s+(?:you\s+)?in\s+person\b|\bmeet\s+up\s+with\s+you\b|\bvisit\s+you\b`,
  String.raw`\b(?:stop|drop|come)\s+by\s+(?:your\s+(?:place|home|house|hotel|cafe|room)\b|(?:to|and)\s+see\s+you\b)`,
].join('|'),'i');
/** Narrow sensitive-topic pattern: such requests route to unsupported, and earlier ones are never sent to a classifier. */
export function isSensitive(text:string):boolean { return SENSITIVE.test(text)||WHEREABOUTS.test(text); }
/** Generic past-tense/time/place words: a weak cue that also matches ordinary small talk ("have you tried…?", "어디 가고 싶어?"). */
const TIMELINE_CUE=/\b(when|where|visited|trip|travel|activity|posted|yesterday|last year|in 20\d\d|did you|were you|have you|your past|your family)\b|\d{4}[-년]|언제|어디|활동|여행|방문|그날|게시|지난|어제|그 여행|무슨 일|뭐 했|뭘 했|갔어|했어|가족/i;
const IMAGE_CUE=/image|photo|picture|visual|이미지|사진|그림|작품|의도|분위기/i;

export interface IntentSignals {
  sensitive:boolean; explicitIntent?:TurnIntent; creative:boolean;
  /** Authoritative timeline routes: explicit timeline query, biography, post-memory request, follow-up of a timeline reply. */
  strongTimeline:boolean;
  /** Lexical-only timeline routes: the generic timeline cue, or image words in a RAG session. */
  weakTimeline:boolean;
}
export function intentSignals(input:{text:string;context:ReturnType<typeof retrievalContext>;explicitIntent?:TurnIntent;explicitTimeline:boolean;ragCondition?:RagCondition;previousTimeline:boolean}):IntentSignals {
  const {text,context}=input;const creative=context.creative;
  return {sensitive:isSensitive(text),...(input.explicitIntent?{explicitIntent:input.explicitIntent}:{}),creative,
    strongTimeline:input.explicitTimeline||!creative&&(isBiographicalRequest(text)||isPostMemoryRequest(text)||context.followUp&&input.previousTimeline),
    weakTimeline:!creative&&(TIMELINE_CUE.test(context.followUp?context.query:text)||!!input.ragCondition&&IMAGE_CUE.test(text))};
}
/** The deterministic routing. Conservative clarification/unsupported routes never answer or retrieve; explicit small_talk cannot downgrade a timeline cue. */
export function ruleIntent(signals:IntentSignals):TurnIntent {
  if(signals.sensitive||signals.explicitIntent==='unsupported') return 'unsupported';
  if(signals.explicitIntent==='clarification') return 'clarification';
  if(signals.strongTimeline||signals.weakTimeline) return 'timeline';
  return signals.explicitIntent??'small_talk';
}
/**
 * Ambiguity gate: the classifier is asked only when the rules decided timeline vs small_talk from lexical cues alone
 * (or no cue). Sensitive, explicit, creative and strong-timeline requests stay rule-decided.
 */
export function needsIntentClassifier(signals:IntentSignals):boolean {
  return !signals.sensitive&&!signals.explicitIntent&&!signals.creative&&!signals.strongTimeline;
}
/** Failure class of a classifier call (shared with the input safety filter). */
export function classifierFallbackReason(error:unknown,turn:AbortSignal):'aborted'|'timeout'|'budget'|'subcap'|'unresolved'|'error' {
  if(turn.aborted) return 'aborted';
  if(error==='timeout') return 'timeout';
  const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
  return code==='BUDGET_EXCEEDED'?'budget':code==='DECISION_SUBCAP'?'subcap':code==='REQUEST_UNRESOLVED_NO_RESUBMIT'?'unresolved':'error';
}
/** Combines the rules with an optional classifier. Any failure, timeout, abort or low confidence keeps the rule result. */
export async function routeIntent(signals:IntentSignals,input:{text:string;recentUserTurns:string[];seed:string},options:IntentClassifierOptions|undefined,turn:AbortSignal):Promise<{intent:TurnIntent;routing?:IntentRouting}> {
  const rule=ruleIntent(signals);
  if(!options) return {intent:rule};
  if(!needsIntentClassifier(signals)) return {intent:rule,routing:{decidedBy:'rule',ruleIntent:rule}};
  const base={classifier:options.classifier.name,ruleIntent:rule};
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  const stop=()=>controller.abort();turn.addEventListener('abort',stop,{once:true});
  try {
    if(turn.aborted) throw new Error('aborted');
    // Race as well as abort, so a classifier that ignores its signal still cannot hold the turn.
    const result=await Promise.race([options.classifier.classify(input,{signal:controller.signal}),
      new Promise<never>((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject('timeout');},options.timeoutMs);
        controller.signal.addEventListener('abort',()=>reject(turn.aborted?'aborted':'timeout'),{once:true});
      })]);
    if(!result) return {intent:rule,routing:{decidedBy:'classifier_fallback',...base,fallbackReason:'no_answer'}};
    const answer={label:result.label,confidence:result.confidence};
    if(!(result.confidence>=options.minConfidence)) return {intent:rule,routing:{decidedBy:'classifier_fallback',...base,...answer,fallbackReason:'below_threshold'}};
    return {intent:result.label,routing:{decidedBy:'classifier',...base,...answer}};
  } catch(error) {
    return {intent:rule,routing:{decidedBy:'classifier_fallback',...base,fallbackReason:classifierFallbackReason(error,turn)}};
  } finally {
    if(timer) clearTimeout(timer);
    turn.removeEventListener('abort',stop);controller.abort();
  }
}
