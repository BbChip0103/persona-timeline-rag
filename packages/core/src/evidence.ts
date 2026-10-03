import { z } from 'zod';
import { EvidenceRefSchema, SourcePostSchema, TimelineQuerySchema, type ChatReply, type EvidenceRef, type SourcePost, type TimelineQuery } from '@ptr/contracts';
import { CoreError } from './ports';
import { containsCredentialPattern, containsInternalPathPattern } from './safety';
// Offsetless selections are exact quotes, not instructions to repair supplied selectors.
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

/** Experimental natural prose is explicitly unverified; quotes are validated independently. */
export function validateExperimentReply(raw:string,sources:SourcePost[],personId:string,condition:'off'|'caption'|'caption_image'):Pick<ChatReply,'status'|'content'|'claims'|'evidence'|'limitations'|'grounding'> {
  const fallback={status:'insufficient_evidence' as const,content:'응답의 근거 형식을 확인하지 못했어요.',claims:[],evidence:[],grounding:'unverified_model' as const,limitations:['INVALID_MODEL_EVIDENCE','의미적 사실 검수는 수행하지 않았습니다.']};
  let result:z.infer<typeof ExperimentModelReplySchema>;
  try { result=ExperimentModelReplySchema.parse(JSON.parse(raw)); } catch { return fallback; }
  if(containsCredentialPattern(result.answer) || containsInternalPathPattern(result.answer) || result.answer.length>8000) throw new CoreError('TURN_FAILED');
  if(condition==='off' && result.evidenceRefs.length) return fallback;
  const evidence:ChatReply['evidence']=[];
  const refs:EvidenceRef[]=[];
  for(const selection of result.evidenceRefs) {
    const source=sources.find(item=>item.id===selection.sourceId && item.personId===personId && !item.unsafe);
    if(!source || containsCredentialPattern(selection.quote) || containsInternalPathPattern(selection.quote)) return fallback;
    const annotation=selection.annotationId ? source.imageAnnotations?.find(item=>item.id===selection.annotationId) : undefined;
    if(selection.annotationId && (condition!=='caption_image' || !annotation || annotation.humanReviewed!==false)) return fallback;
    const text=annotation?.text ?? source.caption;
    let ref:EvidenceRef;
    if('start' in selection) {
      if(selection.start>=selection.end || selection.end>text.length || text.slice(selection.start,selection.end)!==selection.quote) return fallback;
      ref=selection;
    } else {
      const start=text.indexOf(selection.quote);
      if(start<0 || text.indexOf(selection.quote,start+1)!==-1) return fallback;
      ref={...selection,start,end:start+selection.quote.length};
    }
    refs.push(ref);
    evidence.push({sourceId:source.id,personId,sourceUrl:source.sourceUrl,postedAt:source.postedAt,eventDate:source.eventDate,snapshot:source.snapshot,hash:source.hash,quote:ref.quote,
      ...(annotation ? {origin:'ai_image_annotation' as const,annotationId:annotation.id,imageHash:annotation.imageHash,annotationHash:annotation.annotationHash,annotationRevision:annotation.revision} : {origin:'source_caption' as const})});
  }
  // Verified claims refer only to exact source text, never to the generated answer's entailment.
  const claims=refs.map(ref=>({text:`${ref.annotationId?'AI 이미지 설명':'캡션 원문'}: ${ref.quote}`,evidenceRefs:[ref]}));
  const content=result.answer.trim() || (claims.length ? claims.map(claim=>claim.text).join('\n') : '확인된 자료가 없는 연구용 AI 응답입니다.');
  return {status:result.status,content,claims,evidence,grounding:evidence.length?'source_bound_quotes':'unverified_model',limitations:[
    ...(condition==='off'?['RETRIEVAL_OFF']:[]),
    ...(evidence.length?['인용은 원문 일치만 검증하며, 답변의 의미적 사실성은 검수하지 않았습니다.']:['UNVERIFIED_MODEL_RESPONSE','검색 근거가 없는 모델 생성 응답이며 실제 활동 사실로 확인되지 않았습니다.']),
    ...(evidence.some(card=>card.origin==='ai_image_annotation')?['이미지 설명과 의도 해석은 AI 파생 자료이며 실제 작가 의도나 원본 캡션이 아닙니다.']:[]),
    '게시일은 실제 활동일과 다를 수 있습니다.',
  ]};
}
