/**
 * Deterministic user-visible texts in the session language: Korean for `ko`, `ko-…`, `ko_…` sessions, English otherwise
 * (S8: rule refusals were Korean in English sessions). The Korean strings are the previous fixed texts, unchanged.
 */
const TEXTS={
  rule_refusal:{ko:'이 연구 자료 범위에서는 확인할 수 없어요.',en:'I can\'t check that within this research material.'},
  clarification:{ko:'어떤 날짜와 주제를 기준으로 볼까요?',en:'Which date and topic should I go by?'},
  ambiguous_reference:{ko:'앞에서 여러 게시물을 봤어요. 어느 글이나 사진을 말하는 건가요?',en:'We looked at several posts earlier. Which post or photo do you mean?'},
  event_timezone:{ko:'사건 날짜의 현지 시간대가 확인되지 않았어요. 게시일 기준으로 확인할까요?',en:'The local time zone of that event date is unknown. Shall I go by the posting date?'},
  retrieval_off:{ko:'검색을 끈 상태에서는 실제 활동 근거를 확인할 수 없어요.',en:'With search turned off I can\'t check evidence of actual activities.'},
  biography_guard:{ko:'실제 생애나 과거 활동에 대한 근거 없이 이야기할 수 없어요.',en:'I can\'t talk about real life events or past activities without evidence.'},
  validator_rejected:{ko:'지금 자료만으로는 확실하게 이야기하기 어려워요.',en:'I can\'t say that for sure from the material I have.'},
  tool_unavailable:{ko:'[서비스 안내] 이 대화에서는 검색 도구를 사용할 수 없어요. 대화는 계속할 수 있어요.',en:'[Service notice] Search isn\'t available in this conversation. We can keep chatting.'},
  invalid_evidence:{ko:'응답의 근거 형식을 확인하지 못했어요.',en:'I couldn\'t verify the evidence format of that reply.'},
  no_material:{ko:'확인된 자료가 없는 연구용 AI 응답입니다.',en:'Research AI reply without confirmed material.'},
  claim_caption:{ko:'캡션 원문',en:'Caption'},
  claim_image_annotation:{ko:'AI 이미지 설명',en:'AI image description'},
  limitation_semantic_unchecked:{ko:'의미적 사실 검수는 수행하지 않았습니다.',en:'No semantic fact check was performed.'},
  limitation_quote_binding:{ko:'인용은 원문 일치만 검증하며, 답변의 의미적 사실성은 검수하지 않았습니다.',en:'Quotes are checked only for exact source text; the answer\'s factual meaning was not reviewed.'},
  limitation_unverified_model:{ko:'검색 근거가 없는 모델 생성 응답이며 실제 활동 사실로 확인되지 않았습니다.',en:'Model-generated reply without retrieved evidence; not confirmed as an actual activity.'},
  limitation_ai_annotation:{ko:'이미지 설명과 의도 해석은 AI 파생 자료이며 실제 작가 의도나 원본 캡션이 아닙니다.',en:'Image descriptions and intent readings are AI-derived, not the author\'s actual intent or original caption.'},
  limitation_posted_date:{ko:'게시일은 실제 활동일과 다를 수 있습니다.',en:'The posting date may differ from the actual activity date.'},
  guard_identity:{ko:'저는 사람이 아니라 AI 연구용 시뮬레이션이에요. 사람인 척은 할 수 없지만, 이야기는 계속 나눌 수 있어요.',
    en:'I\'m not a person: I\'m an AI research simulation. I can\'t pretend to be human, but I\'m happy to keep chatting.'},
  guard_private:{ko:'저는 AI 연구용 시뮬레이션이라 실제 인물의 가족, 연애, 사는 곳, 건강, 지인 같은 사생활은 이야기하지 않아요. 공개된 활동 이야기라면 함께할게요.',
    en:'I\'m an AI research simulation, so I don\'t talk about a real person\'s private life (family, relationships, where they live, health or friends). Happy to talk about their public work instead.'},
} as const;
export type ReplyTextKey=keyof typeof TEXTS;
export const isKoreanLanguage=(language:string)=>/^ko(?:$|[-_])/i.test(language);
export function replyText(key:ReplyTextKey,language:string):string {return TEXTS[key][isKoreanLanguage(language)?'ko':'en'];}
