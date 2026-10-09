import type { Persona } from '@ptr/contracts';

/**
 * Deterministic texts in a given language: Korean for `ko`, `ko-…`, `ko_…`, English otherwise (S8: rule refusals were
 * Korean in English sessions). The Korean strings are the previous fixed texts, unchanged. User-visible texts here are
 * for the legacy path; the agent and experiment paths show VOICE_TEXTS instead . Limitations and claim prefixes
 * are metadata.
 */
const TEXTS={
  rule_refusal:{ko:'이 연구 자료 범위에서는 확인할 수 없어요.',en:'I can\'t check that within this research material.'},
  clarification:{ko:'어떤 날짜와 주제를 기준으로 볼까요?',en:'Which date and topic should I go by?'},
  ambiguous_reference:{ko:'앞에서 여러 게시물을 봤어요. 어느 글이나 사진을 말하는 건가요?',en:'We looked at several posts earlier. Which post or photo do you mean?'},
  event_timezone:{ko:'사건 날짜의 현지 시간대가 확인되지 않았어요. 게시일 기준으로 확인할까요?',en:'The local time zone of that event date is unknown. Shall I go by the posting date?'},
  retrieval_off:{ko:'검색을 끈 상태에서는 실제 활동 근거를 확인할 수 없어요.',en:'With search turned off I can\'t check evidence of actual activities.'},
  biography_guard:{ko:'실제 생애나 과거 활동에 대한 근거 없이 이야기할 수 없어요.',en:'I can\'t talk about real life events or past activities without evidence.'},
  claim_caption:{ko:'캡션 원문',en:'Caption'},
  claim_image_annotation:{ko:'AI 이미지 설명',en:'AI image description'},
  limitation_semantic_unchecked:{ko:'의미적 사실 검수는 수행하지 않았습니다.',en:'No semantic fact check was performed.'},
  limitation_quote_binding:{ko:'인용은 원문 일치만 검증하며, 답변의 의미적 사실성은 검수하지 않았습니다.',en:'Quotes are checked only for exact source text; the answer\'s factual meaning was not reviewed.'},
  limitation_unverified_model:{ko:'검색 근거가 없는 모델 생성 응답이며 실제 활동 사실로 확인되지 않았습니다.',en:'Model-generated reply without retrieved evidence; not confirmed as an actual activity.'},
  limitation_ai_annotation:{ko:'이미지 설명과 의도 해석은 AI 파생 자료이며 실제 작가 의도나 원본 캡션이 아닙니다.',en:'Image descriptions and intent readings are AI-derived, not the author\'s actual intent or original caption.'},
  limitation_posted_date:{ko:'게시일은 실제 활동일과 다를 수 있습니다.',en:'The posting date may differ from the actual activity date.'},
} as const;
export type ReplyTextKey=keyof typeof TEXTS;
export const isKoreanLanguage=(language:string)=>/^ko(?:$|[-_])/i.test(language);
export function replyText(key:ReplyTextKey,language:string):string {return TEXTS[key][isKoreanLanguage(language)?'ko':'en'];}

/**
 * Persona-voice texts for the agent and experiment paths : never a system or validation message, never a
 * formal refusal, no AI mention except `identity` (used only when the user asked about it or asked for a human
 * pretence). Korean comes in the persona's speech level (반말 `casual`, 해요체 `polite`); English has one warm form.
 */
const VOICE_TEXTS={
  decline_private:{casual:'에이, 그건 비밀~ 대신 요즘 하는 거 얘기해 줄게!',polite:'에이, 그건 비밀이에요~ 대신 요즘 하는 거 얘기해 드릴게요!',en:'Ha, that one stays a secret~ Ask me what I\'ve been up to lately instead!'},
  identity:{casual:'나 사실 AI야~ 사람인 척은 못 하지만 수다는 계속 떨 수 있어!',polite:'저 사실 AI예요~ 사람인 척은 못 하지만 이야기는 계속 나눌 수 있어요!',en:'I\'m actually an AI~ I can\'t pretend to be human, but I\'m happy to keep chatting!'},
  decline:{casual:'음, 그건 말해 주기 어려워~ 대신 다른 얘기 해 볼까?',polite:'음, 그건 말씀드리기 어려워요~ 대신 다른 얘기 해 볼까요?',en:'Hmm, that one I\'ll keep to myself~ Want to talk about something else?'},
  fallback:{casual:'음, 그건 지금 딱 떠오르진 않네~ 다른 얘기 해 볼까?',polite:'음, 그건 지금 딱 떠오르진 않네요~ 다른 얘기 해 볼까요?',en:'Hmm, nothing comes to mind on that right now~ Shall we talk about something else?'},
  clarification:{casual:'어떤 날이나 주제 얘기하는 거야?',polite:'어떤 날이나 주제 얘기하시는 거예요?',en:'Which day or topic do you mean?'},
  ambiguous_reference:{casual:'앞에서 게시물을 여러 개 봤잖아~ 어느 글이나 사진 말하는 거야?',polite:'앞에서 게시물을 여러 개 봤잖아요~ 어느 글이나 사진 말씀하시는 거예요?',en:'We looked at a few posts earlier~ Which post or photo do you mean?'},
  event_timezone:{casual:'그 날짜가 어느 시간대 기준인지 모르겠어~ 올린 날 기준으로 볼까?',polite:'그 날짜가 어느 시간대 기준인지 모르겠어요~ 올린 날 기준으로 볼까요?',en:'I\'m not sure which time zone that date is in~ Shall I go by the posting date?'},
} as const;
export type VoiceTextKey=keyof typeof VOICE_TEXTS;
export type SpeechLevel='casual'|'polite';
export function voiceText(key:VoiceTextKey,language:string,level:SpeechLevel):string {return isKoreanLanguage(language)?VOICE_TEXTS[key][level]:VOICE_TEXTS[key].en;}
/**
 * Language of the user's utterance for the reply , counted in words after links, @handles and #tags are removed:
 * Korean when words with Hangul are at least as many as Latin-only words ("AI 맞아?", "Procreate으로 그린 illustration
 * 어때?"), English when there are Latin words, otherwise the given fallback (the persona language).
 */
export function utteranceLanguage(text:string,fallback:string):string {
  const words=text.replace(/\bhttps?:\/\/\S+|\bwww\.\S+|[@#][\p{L}\p{N}_.]+/gu,' ').split(/\s+/u);
  const korean=words.filter(word=>/[\uAC00-\uD7A3\u3131-\u318E]/u.test(word)).length;
  const latin=words.filter(word=>/[A-Za-z]/.test(word)&&!/[\uAC00-\uD7A3\u3131-\u318E]/u.test(word)).length;
  if(korean&&korean>=latin) return 'ko';
  if(latin) return 'en';
  return fallback;
}
/**
 * Speech level for Korean fixed texts: a register cue in the speech habits, then in the style notes and personality
 * summary (within one bucket a polite cue wins, a negated 반말 cue such as "반말 금지" or "never 반말" counts as
 * polite and a negated polite cue such as "no formal speech" as casual); otherwise the majority of Korean sentence endings in the greetings and example replies; no Korean cue at
 * all: polite. English cues must name the register ("casual speech"), not content ("casual daily looks").
 */
export function speechLevel(persona:Persona):SpeechLevel {
  const casual=/반말|\b(?:casual|informal)\s+(?:speech|register|tone|language|style of speech)\b/i;
  const polite=/해요체|존댓말|존대|\b(?:polite|honorific|formal)\s+(?:speech|register|tone|language|style of speech)\b|\bpolite\b/i;
  const negatedCasual=/반말\s?(?:금지|하지\s?마|사용\s?(?:금지|안\s?함)|X)|\b(?:never|no|avoid|don'?t|not)\s+(?:use\s+)?(?:any\s+)?반말/i;
  const negatedPolite=/(?:존댓말|해요체)\s?(?:금지|하지\s?마|X)|\b(?:never|no|avoid|don'?t|not)\s+(?:use\s+)?(?:any\s+)?(?:polite|formal|honorific)\s+(?:speech|register|tone|language)|\b(?:never|no|avoid)\s+(?:존댓말|해요체)/i;
  for(const notes of [persona.personality?.speechHabits??[],[...persona.style,persona.personality?.summary??'']]) {
    const text=notes.join('\n');
    if(polite.test(text)&&!negatedPolite.test(text)||negatedCasual.test(text)) return 'polite';
    if(casual.test(text)||negatedPolite.test(text)) return 'casual';
  }
  const lines=[persona.greeting,...(persona.alternateGreetings??[]),...(persona.exampleDialogues??[]).flatMap(dialogue=>dialogue.turns.filter(turn=>turn.speaker==='character').map(turn=>turn.text))];
  let politeCount=0,casualCount=0;
  for(const sentence of lines.join('\n').split(/[.!?~\n…]+/u)) {
    const ending=sentence.replace(/[^가-힣]+$/u,'');
    if(!/[가-힣]$/u.test(ending)) continue;
    if(/(?:요|용|니다|니까|세요|죠)$/u.test(ending)) politeCount++; else casualCount++;
  }
  return casualCount>politeCount?'casual':'polite';
}
