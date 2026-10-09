import { z } from 'zod';
import { EvidenceRefSchema, SourcePostSchema, TimelineQuerySchema, type ChatReply, type EvidenceRef, type SourcePost, type TimelineQuery } from '@ptr/contracts';
import { CoreError } from './ports';
import { containsCredentialPattern, containsInternalPathPattern } from './safety';
import { replyText, voiceText, type SpeechLevel } from './reply-texts';
// Legacy offsetless quotes are exact-only; experimental formatting recovery never repairs supplied selectors.
const LegacyEvidenceRefSchema=EvidenceRefSchema.omit({annotationId:true});
const ModelSelectionSchema=z.union([LegacyEvidenceRefSchema,LegacyEvidenceRefSchema.omit({start:true,end:true})]);
const ExperimentSelectionSchema=z.union([EvidenceRefSchema,EvidenceRefSchema.omit({start:true,end:true})]);
export const ModelReplySchema=z.object({
  status:z.enum(['answered','insufficient_evidence','needs_clarification','out_of_scope']),
  answer:z.string().max(8000),
  evidenceRefs:z.array(ModelSelectionSchema).max(100),
}).strict();
export const ExperimentModelReplySchema=ModelReplySchema.extend({evidenceRefs:z.array(ExperimentSelectionSchema).max(100)});
/** Calendar-day filtering handles DST via Intl, without assuming a 24-hour local day. */
function postedDay(postedAt:string,timezone:string):string {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(postedAt));
  const get=(type:string)=>parts.find(p=>p.type===type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export function filterEvidence(raw:SourcePost[],request:TimelineQuery,trustedPersonId:string):SourcePost[] {
  const query=TimelineQuerySchema.parse(request);
  if(query.personId !== trustedPersonId) throw new CoreError('FORBIDDEN');
  // Reject invalid/cross-person/unsafe results rather than trusting the adapter.
  return raw.filter(item=>{
    const parsed=SourcePostSchema.safeParse(item);
    if(!parsed.success || item.personId !== trustedPersonId || item.unsafe) return false;
    if(!query.start || !query.end) return true;
    // Minimal SourcePost carries no event timezone: do not silently convert event calendar dates.
    if(query.dateBasis === 'event' && query.timezone !== 'UTC') return false;
    const day=query.dateBasis==='posted' ? postedDay(item.postedAt,query.timezone) : item.eventDate;
    return day !== null && day >= query.start && day < query.end;
  }).slice(0,query.limit);
}
export function validateSourceBoundReply(raw:string,sources:SourcePost[],personId:string):Pick<ChatReply,'status'|'content'|'claims'|'evidence'|'limitations'> {
  const fallback={status:'insufficient_evidence' as const,content:'자료에서 확인할 수 있는 근거가 부족해요.',claims:[],evidence:[],limitations:['생성된 인용을 검증하지 못했습니다.']};
  let result:z.infer<typeof ModelReplySchema>;
  try { result=ModelReplySchema.parse(JSON.parse(raw)); } catch { return fallback; }
  if(result.status !== 'answered') {
    // Model prose in nonanswered factual replies is never surfaced: it may smuggle a new claim.
    const text={insufficient_evidence:'자료에서 확인할 수 있는 근거가 부족해요.',needs_clarification:'게시일과 활동일 중 어떤 날짜를 기준으로 볼까요?',out_of_scope:'이 자료 범위에서는 확인할 수 없어요.'};
    return {status:result.status,content:text[result.status],claims:[],evidence:[],limitations:[]};
  }
  if(!result.evidenceRefs.length) return fallback;
  const evidence:ChatReply['evidence']=[];
  const canonicalRefs:EvidenceRef[]=[];
  for(const selection of result.evidenceRefs) {
    const source=sources.find(s=>s.id===selection.sourceId && s.personId===personId && !s.unsafe);
    if(!source || containsCredentialPattern(selection.quote)) return fallback;
    let ref:EvidenceRef;
    if('start' in selection) {
      // Strict legacy mode: the schema requires both integer selectors; do not repair either.
      if(selection.start>=selection.end || selection.end>source.caption.length || source.caption.slice(selection.start,selection.end)!==selection.quote) return fallback;
      ref=selection;
    } else {
      // indexOf/slice offsets are UTF16 code units. Require one exact occurrence, including overlaps.
      const start=source.caption.indexOf(selection.quote);
      if(start<0 || source.caption.indexOf(selection.quote,start+1)!==-1) return fallback;
      ref={...selection,start,end:start+selection.quote.length};
    }
    canonicalRefs.push(ref);
    evidence.push({sourceId:source.id,personId,sourceUrl:source.sourceUrl,postedAt:source.postedAt,eventDate:source.eventDate,snapshot:source.snapshot,hash:source.hash,quote:ref.quote});
  }
  // This proves source/selector binding, NOT semantic entailment or actual real-world activity.
  const claims=canonicalRefs.map(ref=>({text:`캡션 원문: ${ref.quote}`,evidenceRefs:[ref]}));
  return {status:'answered',content:claims.map(c=>c.text).join('\n'),claims,evidence,limitations:['캡션의 진술이며 실제 활동일은 게시일과 다를 수 있습니다.','원문 인용 일치 검사는 의미적 사실 검수와 다릅니다.']};
}

/** Collapse only ASCII formatting whitespace, retaining original UTF-16 range boundaries.
 * No word, punctuation, Unicode normalization, fuzzy match or selector repair is allowed. */
function formattedQuote(text:string,quote:string):{start:number;end:number;quote:string;canonicalized:boolean}|undefined {
  if(!quote.trim())return;
  const exact=text.indexOf(quote);
  if(exact>=0)return text.indexOf(quote,exact+1)===-1?{start:exact,end:exact+quote.length,quote,canonicalized:false}:undefined;
  const normalize=(value:string)=>value.replace(/[ \t\r\n]+/g,' ');
  const needle=normalize(quote);
  const units:string[]=[];const starts:number[]=[];const ends:number[]=[];
  for(let index=0;index<text.length;) {
    const start=index;
    if(/[ \t\r\n]/.test(text[index]!)) {
      while(index<text.length&&/[ \t\r\n]/.test(text[index]!))index++;
      units.push(' ');
    }else {units.push(text[index]!);index++;}
    starts.push(start);ends.push(index);
  }
  const normalized=units.join('');const match=normalized.indexOf(needle);
  if(match<0||normalized.indexOf(needle,match+1)!==-1)return;
  const start=starts[match]!;const end=ends[match+needle.length-1]!;
  const original=text.slice(start,end);
  if(normalize(original)!==needle)return;
  return {start,end,quote:original,canonicalized:true};
}

/**
 * Experimental natural prose is explicitly unverified; quotes are validated independently. `language` is the reply
 * language and `level` the persona's speech level for the persona-voice fallback.
 * : a validation failure never shows a system text. Invalid evidence keeps the model's own answer, unverified
 * and without citations (the reply guard still runs on it in the chat service); an unparseable reply or an empty answer
 * gets the persona-voice fallback, also when its citations are valid (they stay in `evidence`/`claims`). INVALID_MODEL_EVIDENCE
 * stays in the limitations (metadata).
 */
export function validateExperimentReply(raw:string,sources:SourcePost[],personId:string,condition:'off'|'caption'|'caption_image',language='ko',level:SpeechLevel='polite'):Pick<ChatReply,'status'|'content'|'claims'|'evidence'|'limitations'|'grounding'> {
  const fallbackText=voiceText('fallback',language,level);
  const fallback={status:'insufficient_evidence' as const,content:fallbackText,claims:[],evidence:[],grounding:'unverified_model' as const,limitations:['INVALID_MODEL_EVIDENCE',replyText('limitation_semantic_unchecked',language)]};
  let result:z.infer<typeof ExperimentModelReplySchema>;
  try { result=ExperimentModelReplySchema.parse(JSON.parse(raw)); } catch { return fallback; }
  if(containsCredentialPattern(result.answer) || containsInternalPathPattern(result.answer) || result.answer.length>8000) throw new CoreError('TURN_FAILED','REPLY_REJECTED');
  const answer=result.answer.trim();
  const unverified={...fallback,content:answer||fallbackText,limitations:[...(condition==='off'?['RETRIEVAL_OFF']:[]),'INVALID_MODEL_EVIDENCE','UNVERIFIED_MODEL_RESPONSE',replyText('limitation_unverified_model',language),replyText('limitation_semantic_unchecked',language)]};
  if(condition==='off' && result.evidenceRefs.length) return unverified;
  const evidence:ChatReply['evidence']=[];
  const refs:EvidenceRef[]=[];
  let canonicalized=false;
  for(const selection of result.evidenceRefs) {
    const source=sources.find(item=>item.id===selection.sourceId && item.personId===personId && !item.unsafe);
    if(!source || containsCredentialPattern(selection.quote) || containsInternalPathPattern(selection.quote)) return unverified;
    const annotation=selection.annotationId ? source.imageAnnotations?.find(item=>item.id===selection.annotationId) : undefined;
    if(selection.annotationId && (condition!=='caption_image' || !annotation || annotation.humanReviewed!==false)) return unverified;
    const text=annotation?.text ?? source.caption;
    let ref:EvidenceRef;
    if('start' in selection) {
      if(selection.start>=selection.end || selection.end>text.length || text.slice(selection.start,selection.end)!==selection.quote) return unverified;
      ref=selection;
    } else {
      const match=formattedQuote(text,selection.quote);
      if(!match)return unverified;
      ref={...selection,quote:match.quote,start:match.start,end:match.end};
      canonicalized ||= match.canonicalized;
    }
    refs.push(ref);
    evidence.push({sourceId:source.id,personId,sourceUrl:source.sourceUrl,postedAt:source.postedAt,eventDate:source.eventDate,snapshot:source.snapshot,hash:source.hash,quote:ref.quote,
      ...(annotation ? {origin:'ai_image_annotation' as const,annotationId:annotation.id,imageHash:annotation.imageHash,annotationHash:annotation.annotationHash,annotationRevision:annotation.revision} : {origin:'source_caption' as const})});
  }
  // Verified claims refer only to exact source text, never to the generated answer's entailment.
  const claims=refs.map(ref=>({text:`${replyText(ref.annotationId?'claim_image_annotation':'claim_caption',language)}: ${ref.quote}`,evidenceRefs:[ref]}));
  // An empty answer never shows the claim lines ("캡션 원문: …"): they stay metadata (review M2).
  const content=answer || fallbackText;
  return {status:answer?result.status:'insufficient_evidence',content,claims,evidence,grounding:evidence.length?'source_bound_quotes':'unverified_model',limitations:[
    ...(condition==='off'?['RETRIEVAL_OFF']:[]),
    ...(canonicalized?['QUOTE_WHITESPACE_CANONICALIZED']:[]),
    ...(evidence.length?[replyText('limitation_quote_binding',language)]:['UNVERIFIED_MODEL_RESPONSE',replyText('limitation_unverified_model',language)]),
    ...(evidence.some(card=>card.origin==='ai_image_annotation')?[replyText('limitation_ai_annotation',language)]:[]),
    replyText('limitation_posted_date',language),
  ]};
}
