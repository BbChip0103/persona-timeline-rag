import type { ChatMessage, EvidenceCard, SourcePost } from '@ptr/contracts';
import { containsCredentialPattern, isExplicitlyCreativeRequest } from './safety';
export const RETRIEVAL_CONTEXT_REVISION='user-context-v2-pinned-source-context';
// A bounded deterministic baseline, NOT semantic coreference or an LLM query rewrite.
export function isContextFollowUp(text:string):boolean {
  if(/\b(?:instead|different|new topic|this week|right now)\b|말고|다른\s?(?:글|사진|주제|여행)|새로운|이번\s?주|지금/i.test(text))return false;
  return /그때|그\s?(?:글|사진|그림|장면|여행|곳|수업)|거기|옆에|그럼|그거|그것|\b(?:that|those|then|there|it|its)\b/i.test(text);
}
export function isPostMemoryRequest(text:string):boolean {
  return /(?:올린|갔던|했던|봤던|예전)[^.!?\n]{0,60}(?:글|거|사진)|(?:그|이)\s?글|(?:그|예전|너의|당신의)[^.!?\n]{0,30}기억나|\b(?:post|posted)\b|\bremember\b[^.!?\n]{0,40}\b(?:your|that|the)\b[^.!?\n]{0,30}\b(?:photo|trip|visit)\b/i.test(text);
}
export function retrievalContext(history:ChatMessage[],text:string,explicitTimeline=false):{query:string;contextTurnIds:string[];followUp:boolean;creative:boolean} {
  const recent=history.filter(message=>message.role==='user'&&message.turnId!==null).slice(-5);
  const followUp=!explicitTimeline&&isContextFollowUp(text)&&recent.length>0;
  const chain:ChatMessage[]=[];
  // Walk only the contiguous referential chain, stopping at its first topic anchor.
  if(followUp || !explicitTimeline&&/\b(?:photo|picture|caption)\b|사진|이미지|캡션/i.test(text)) {
    for(const message of [...recent].reverse()) {
      chain.unshift(message);
      if(!isContextFollowUp(message.content))break;
    }
  }
  const creative=!explicitTimeline&&(isExplicitlyCreativeRequest(text)||chain.some(message=>isExplicitlyCreativeRequest(message.content))&&!isPostMemoryRequest(text));
  const current=[...text].slice(0,500).join('');
  if(!followUp || creative)return {query:current,contextTurnIds:[],followUp,creative};
  let remaining=500-[...current].length;const selected:ChatMessage[]=[];const segments:string[]=[];
  for(const message of [...chain].reverse()) {
    if(remaining<=1)break;
    if(containsCredentialPattern(message.content))continue;
    const segment=[...message.content].slice(0,remaining-1).join('');
    segments.unshift(segment);selected.unshift(message);remaining-=[...segment].length+1;
  }
  return {query:[...segments,current].join('\n'),contextTurnIds:selected.map(message=>message.turnId!),followUp,creative};
}

/** Original context references, not additional model claims or assistant-generated facts. */
export function rememberSourceContext(sources:SourcePost[],cited:EvidenceCard[]):EvidenceCard[] {
  const references=[...cited];
  const parents=new Set(cited.map(ref=>ref.sourceId));
  for(const source of sources.filter(source=>parents.has(source.id))) {
    const base={sourceId:source.id,personId:source.personId,sourceUrl:source.sourceUrl,postedAt:source.postedAt,eventDate:source.eventDate,snapshot:source.snapshot,hash:source.hash};
    if(source.caption&&!references.some(ref=>ref.sourceId===source.id&&!ref.annotationId))references.push({...base,quote:[...source.caption].slice(0,96).join(''),origin:'source_caption'});
    for(const annotation of source.imageAnnotations??[]) {
      if(references.length>=20)break;
      if(references.some(ref=>ref.sourceId===source.id&&ref.annotationId===annotation.id))continue;
      references.push({...base,quote:[...annotation.text].slice(0,96).join(''),origin:'ai_image_annotation',annotationId:annotation.id,imageHash:annotation.imageHash,annotationHash:annotation.annotationHash,annotationRevision:annotation.revision});
    }
  }
  return references.slice(0,20);
}
