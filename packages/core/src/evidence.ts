import { z } from 'zod';
import { EvidenceRefSchema, SourcePostSchema, TimelineQuerySchema, type ChatReply, type SourcePost, type TimelineQuery } from '@ptr/contracts';
import { CoreError } from './ports';
import { containsCredentialPattern } from './safety';
export const ModelReplySchema=z.object({
  status:z.enum(['answered','insufficient_evidence','needs_clarification','out_of_scope']),
  answer:z.string().max(8000),
  evidenceRefs:z.array(EvidenceRefSchema).max(100),
}).strict();
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
  for(const ref of result.evidenceRefs) {
    const source=sources.find(s=>s.id===ref.sourceId && s.personId===personId && !s.unsafe);
    if(!source || ref.start >= ref.end || ref.end>source.caption.length || containsCredentialPattern(ref.quote) || source.caption.slice(ref.start,ref.end)!==ref.quote) return fallback;
    evidence.push({sourceId:source.id,personId,sourceUrl:source.sourceUrl,postedAt:source.postedAt,eventDate:source.eventDate,snapshot:source.snapshot,hash:source.hash,quote:ref.quote});
  }
  // This proves source/selector binding, NOT semantic entailment or actual real-world activity.
  const claims=result.evidenceRefs.map(ref=>({text:`캡션 원문: ${ref.quote}`,evidenceRefs:[ref]}));
  return {status:'answered',content:claims.map(c=>c.text).join('\n'),claims,evidence,limitations:['캡션의 진술이며 실제 활동일은 게시일과 다를 수 있습니다.','원문 인용 일치 검사는 의미적 사실 검수와 다릅니다.']};
}
