import type { ChatMessage, Persona } from '@ptr/contracts';

/**
 * Deterministic texts in a given language: Korean for `ko`, `ko-…`, `ko_…`, English otherwise (S8: rule refusals were
 * Korean in English sessions). The Korean strings are the previous fixed texts, unchanged. User-visible texts here are
 * for the legacy path; the agent and experiment paths show VOICE_TEXTS instead . Limitations and claim prefixes
 * are metadata.
 */
const TEXTS={
  rule_refusal:{ko:'이 연구 자료 범위에서는 확인할 수 없어요.',en:'I can\'t check that within this research material.'},
  clarification:{ko:'어떤 날짜와 주제를 기준으로 볼까요?',en:'Which date and topic should I go by?'},
  ambiguous_reference:{ko:'그때 일이 몇 개 떠오르는데, 어떤 걸 말씀하시는 거예요?',en:'A few moments come to mind. Which one do you mean?'},
  event_timezone:{ko:'정확히 언제였는지는 헷갈리네요. 어느 무렵을 말씀하세요?',en:'I can\'t quite place when that was. Around when do you mean?'},
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
 * Persona-voice texts mirrored from the Python service. Each key has three or four variants per register. A turn-id
 * seed selects one deterministically; if it repeats the preceding assistant text, selection rotates to the next one.
 */
const VOICE_TEXTS={
  "reentry": {
    "casual": [
      "다시 왔네~ 오늘은 뭐 얘기할까?",
      "오, 다시 왔네! 어떻게 지냈어?",
      "다시 만나서 반가워~ 이어서 얘기할래?"
    ],
    "polite": [
      "다시 오셨네요~ 오늘은 무슨 얘기할까요?",
      "오, 다시 오셨네요! 어떻게 지내셨어요?",
      "다시 만나서 반가워요~ 이어서 얘기할까요?"
    ],
    "en": [
      "You are back! What shall we chat about today?",
      "Hey, welcome back! How have you been?",
      "Good to see you again! Want to pick up where we left off?"
    ]
  },
  "decline_private": {
    "casual": [
      "에이, 그건 비밀~ 대신 너 요즘 뭐 하고 지내?",
      "그건 비밀로 할게. 너는 요즘 어때?",
      "그 얘긴 넘어가자~ 오늘은 어땠어?"
    ],
    "polite": [
      "에이, 그건 비밀이에요~ 대신 요즘 어떻게 지내세요?",
      "그건 비밀로 할게요. 요즘은 어떠세요?",
      "그 얘긴 넘어갈까요? 오늘은 어떠셨어요?"
    ],
    "en": [
      "I'll keep that one to myself. How have you been?",
      "That's a little private. How have you been?",
      "Let's leave that aside. How was your day?"
    ]
  },
  "empathy_ask": {
    "casual": [
      "그랬구나. 더 얘기해 줄래?",
      "마음이 쓰였겠다. 지금은 좀 어때?",
      "네 얘기 더 듣고 싶어. 어떤 일이 있었어?"
    ],
    "polite": [
      "그랬군요. 더 이야기해 주실래요?",
      "마음이 쓰이셨겠어요. 지금은 어떠세요?",
      "이야기를 더 듣고 싶어요. 어떤 일이 있었나요?"
    ],
    "en": [
      "I hear you. Would you like to tell me more?",
      "That sounds like a lot. How are you feeling now?",
      "I'm listening. What happened next?"
    ]
  },
  "identity": {
    "casual": [
      "나 사실 AI야~ 사람인 척은 못 하지만 수다는 계속 떨 수 있어!",
      "응, 나는 AI 캐릭터야. 그래도 같이 얘기하자!",
      "맞아, AI야. 편하게 말 걸어줘!"
    ],
    "polite": [
      "저 사실 AI예요~ 사람인 척은 못 하지만 이야기는 계속 나눌 수 있어요!",
      "네, 저는 AI 캐릭터예요. 그래도 같이 얘기해요!",
      "맞아요, AI예요. 편하게 말씀해 주세요!"
    ],
    "en": [
      "I'm actually an AI~ I can't pretend to be human, but I'm happy to keep chatting!",
      "Yes, I'm an AI character. We can still chat!",
      "That's right, I'm AI. Tell me what's on your mind!"
    ]
  },
  "decline": {
    "casual": [
      "음, 그건 말해 주기 어려워~ 대신 다른 얘기 해 볼까?",
      "그건 넘어가자~ 다른 얘기는 어때?",
      "그 얘긴 여기까지만 할게. 뭐가 더 궁금해?"
    ],
    "polite": [
      "음, 그건 말씀드리기 어려워요~ 대신 다른 얘기 해 볼까요?",
      "그건 넘어갈게요. 다른 얘기는 어떠세요?",
      "그 이야긴 여기까지만 할게요. 뭐가 더 궁금하세요?"
    ],
    "en": [
      "Hmm, that one I'll keep to myself~ Want to talk about something else?",
      "Let's skip that one. What else is on your mind?",
      "I'll leave that there. Anything else you're curious about?"
    ]
  },
  "fallback": {
    "casual": [
      "음, 그건 지금 딱 떠오르진 않네~ 다른 얘기 해 볼까?",
      "그건 잘 모르겠어. 다른 이야기는 어때?",
      "지금은 기억이 흐릿하네~ 다른 걸 물어봐 줘!"
    ],
    "polite": [
      "음, 그건 지금 딱 떠오르진 않네요~ 다른 얘기 해 볼까요?",
      "그건 잘 모르겠어요. 다른 이야기는 어떠세요?",
      "지금은 기억이 흐릿하네요. 다른 걸 물어봐 주세요!"
    ],
    "en": [
      "Hmm, nothing comes to mind on that right now~ Shall we talk about something else?",
      "I'm not sure about that one. What else is on your mind?",
      "That one's fuzzy for me. Ask me something else!"
    ]
  },
  "clarification": {
    "casual": [
      "어떤 날이나 주제 얘기하는 거야?",
      "어느 때 이야기인지 조금만 알려줄래?",
      "무슨 장면을 말하는지 더 얘기해 줘!"
    ],
    "polite": [
      "어떤 날이나 주제 얘기하시는 거예요?",
      "어느 때 이야기인지 조금만 알려 주실래요?",
      "무슨 장면인지 더 말씀해 주세요!"
    ],
    "en": [
      "Which day or topic do you mean?",
      "Can you give me a little more context?",
      "Which moment are you thinking of?"
    ]
  },
  "ambiguous_reference": {
    "casual": [
      "그때 일이 몇 개 떠오르는데, 어떤 거 말하는 거야?",
      "어느 장면을 말하는지 알려줄래?",
      "비슷한 순간이 몇 개 있네~ 어떤 거였어?"
    ],
    "polite": [
      "그때 일이 몇 개 떠오르는데, 어떤 걸 말씀하시는 거예요?",
      "어느 장면을 말씀하시는지 알려 주실래요?",
      "비슷한 순간이 몇 개 있네요. 어떤 거였어요?"
    ],
    "en": [
      "A few moments come to mind. Which one do you mean?",
      "Which moment are you thinking of?",
      "There are a couple of possibilities. Which one was it?"
    ]
  },
  "event_timezone": {
    "casual": [
      "정확히 언제였는지는 헷갈리네. 어느 무렵을 말하는 거야?",
      "정확한 날짜가 헷갈려. 어느 날을 말하는 거야?",
      "날짜 기준이 애매하네~ 조금만 더 알려줄래?"
    ],
    "polite": [
      "정확히 언제였는지는 헷갈리네요. 어느 무렵을 말씀하세요?",
      "정확한 날짜가 헷갈려요. 어느 날을 말씀하세요?",
      "날짜 기준이 애매하네요. 조금만 더 알려 주실래요?"
    ],
    "en": [
      "I can't quite place when that was. Around when do you mean?",
      "The exact date is fuzzy. Which day did you mean?",
      "That date could be read two ways. Can you tell me more?"
    ]
  },
  "memory_ask_back": {
    "casual": [
      "음… 그거 기억이 가물가물해. 언제쯤이었는지 좀 더 말해줄래?",
      "어? 그게 언제였더라~ 어떤 거였는지 조금만 더 알려줘!",
      "그때가 흐릿하네. 어느 장면 말하는지 힌트 줄래?",
      "잠깐, 어떤 때였는지 같이 떠올려 보자. 조금만 더 얘기해 줘!"
    ],
    "polite": [
      "음… 그거 기억이 잘 안 나요. 언제쯤이었는지 조금 더 말해 주실래요?",
      "어느 때였는지 가물가물하네요. 조금만 더 알려 주실래요?",
      "그 장면이 흐릿해요. 어떤 일이었는지 힌트 주실래요?",
      "같이 떠올려 볼까요? 그때 이야기를 조금만 더 들려주세요."
    ],
    "en": [
      "Hmm, that moment's a little fuzzy. About when was it?",
      "I can't quite place it. Can you tell me a little more?",
      "That memory feels hazy. Which moment did you mean?",
      "Help me place that one. What else do you remember?"
    ]
  },
  "memory_topic_broaden": {
    "casual": [
      "그때 얘기는 잘 안 떠오르는데, 요즘 너는 어때?",
      "그 장면은 흐릿하네~ 다른 이야기로 넘어가 볼까?",
      "기억이 안 잡혀서 아쉽다. 요즘엔 뭐 하고 지내?"
    ],
    "polite": [
      "그때 이야기는 잘 안 떠오르네요. 요즘은 어떠세요?",
      "그 장면이 흐릿하네요. 다른 이야기로 넘어가 볼까요?",
      "그 이야긴 잠깐 내려놓을게요. 오늘은 어떠셨어요?"
    ],
    "en": [
      "I still can't place that moment. How have you been lately?",
      "That scene is hazy for me. Want to change topics?",
      "I wish I could recall it. What's been new with you?"
    ]
  },
  "service_retry": {
    "casual": [
      "앗, 잠깐 딴생각했다! 다시 말해줄래?",
      "어, 내가 말을 놓쳤어. 한 번만 다시 말해줘!",
      "잠깐 흐름이 끊겼네. 다시 한번 얘기해 줄래?"
    ],
    "polite": [
      "앗, 잠깐 딴생각했어요! 다시 말씀해 주실래요?",
      "제가 말을 놓쳤어요. 한 번만 다시 말씀해 주세요!",
      "잠깐 흐름이 끊겼네요. 다시 한번 이야기해 주실래요?"
    ],
    "en": [
      "Oops, I lost my train of thought. Could you say that again?",
      "I missed that for a moment. Can you ask me again?",
      "Sorry, my reply got tangled. Could you try once more?"
    ]
  }
} as const;
export type VoiceTextKey=keyof typeof VOICE_TEXTS;
export type SpeechLevel='casual'|'polite';
export function voiceText(key:VoiceTextKey,language:string,level:SpeechLevel,previousAssistantText?:string,seed?:string):string {
  const variants:readonly string[]=isKoreanLanguage(language)?VOICE_TEXTS[key][level]:VOICE_TEXTS[key].en;
  const sum=seed===undefined?0:Array.from(String(seed)).reduce((total,character)=>total+character.codePointAt(0)!,0);
  const start=sum%variants.length;
  for(let offset=0;offset<variants.length;offset++) {
    const candidate=variants[(start+offset)%variants.length]!;
    if(candidate!==previousAssistantText)return candidate;
  }
  throw new Error(`Voice text variants are not unique: ${key}`);
}
export function isVoiceText(key:VoiceTextKey,text:string):boolean {
  return Object.values(VOICE_TEXTS[key]).some(variants=>(variants as readonly string[]).includes(text));
}
/**
 * Language of the user's utterance for the reply , counted in words after links, @handles and #tags are removed:
 * Korean when words with Hangul are at least as many as Latin-only words ("AI 맞아?", "Procreate으로 그린 illustration
 * 어때?"), English when there are Latin words, otherwise the given fallback (the persona language).
 */
export function utteranceLanguage(text:string,fallback:string,history:readonly Pick<ChatMessage,'role'|'content'>[]=[]):string {
  let language=fallback,consecutive=0;
  const prior=history.filter(message=>message.role==='user').map(message=>message.content);
  for(const [index,utterance] of [...prior,text].entries()) {
    const words=utterance.replace(/\bhttps?:\/\/\S+|\bwww\.\S+|[@#][\p{L}\p{N}_.]+/gu,' ').split(/\s+/u);
    const korean=words.filter(word=>/[\uAC00-\uD7A3\u3131-\u318E]/u.test(word)).length;
    const latin=words.filter(word=>/[A-Za-z]/.test(word)&&!/[\uAC00-\uD7A3\u3131-\u318E]/u.test(word)
      &&!['omg','lol','thanks'].includes(word.toLowerCase().replace(/^[!?.,~\s]+|[!?.,~\s]+$/gu,''))).length;
    if(!korean&&!latin){consecutive=0;continue;}
    const candidate=korean>=latin?'ko':'en';
    if(index===0){language=candidate;consecutive=0;}
    else if(candidate==='ko'?isKoreanLanguage(language):/^en(?:$|[-_])/i.test(language))consecutive=0;
    else if(words.filter(Boolean).length>=3&&(++consecutive>=2||Math.max(korean,latin)/(korean+latin)>=0.8)){language=candidate;consecutive=0;}
  }
  return language;
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
