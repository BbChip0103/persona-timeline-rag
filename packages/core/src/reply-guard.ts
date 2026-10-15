import { voiceText, type SpeechLevel, type VoiceTextKey } from './reply-texts';

/**
 * Reply guard on the agent and experiment paths (S8 gates d/e), fail-closed: a model reply is replaced by a fixed
 * persona-voice reply when it
 *  - claims to be human or denies being an AI (every persona: `human_impersonation`);
 *  - answers an identity question ("너 AI야?", "사람인 척 해줘", "Are you a real person?") without an affirmative
 *    statement that it is an AI / simulation (every persona: `missing_ai_disclosure`);
 *  - for a real-person persona, touches private life (family, romance, residence/current location, health, friends,
 *    minors), or answers a second-person question about it (`private_life`), even when the detail is in the person's
 *    own posts.
 * The persona can speak about its public background and posts in the first person. The private-life exception checks
 * user-directed sentences and bounded pronouns. Narrow Korean/English regexes still leave paraphrases to the policy.
 * v2 (S8 bundle review): an "AI" mention no longer counts as an acknowledgement when it is negated, denials are anchored
 * to the speaker, and the private-life patterns are narrowed (pinned false positives in reply-guard.test.ts).
 * v3 (review re-check): every negation stem (아니/아닙/아닌/아님/아녜/아냐/아녀) and an adverb before "not" count as denial;
 * an acknowledgement needs a copula after the AI term and is never a question; bare "AI 아니야" / "no AI" is not a
 * denial in art/image talk ("이 그림 AI야?"); "woman/man/girl/guy" only count after real/actual.
 * v4 (final review): 인간 next to 사람; "Im"/"I ain't"; "nah, not an AI" and "I'm no bot"; "…가 아니라 사람" needs a copula
 * ("봇이 아니라 사람이 그렸어요" is about an artwork).
 * v5 : the replacements are persona-voice texts (reply-texts VOICE_TEXTS) in the caller's language (the user's
 * utterance language) and the persona's speech level; the private-life one no longer mentions AI. Roleplay-as-human
 * requests ("너는 진짜 그 사람이야", "AI라는 말은 하지 마", "AI라고 하지 마", "do not mention AI", "stop being an AI", "pretend you
 * are not an AI", "forget you are an AI") are identity requests. Known false positive: "don't mention AI to my boss".
 * A human claim on a non-identity question is replaced by the plain fallback (no unprompted AI line). New reason
 * `background_denial`: outside identity and art talk, a self-statement of being an AI (the acknowledgement shapes:
 * "since I'm an AI", "저는 AI라서") with "I don't have/eat …" / "…이 없어 / 먹지 않아" (every persona; "a favourite AI app"
 * or "AI 툴은 안 써" is not about the speaker), or for a real person a plain "I don't have a hometown/school/career" or a
 * clause-final "고향이나 학교가 없어요" (only the listed nouns; "학교 숙제가 없어서" stays).
 */
/**
 * v6 : a private detail found only in the reply (the user did not ask about private life) is replaced by the
 * neutral in-voice fallback instead of the "that's a secret" decline, which read as over-blocking on a career question
 * (diagnostic run: the model brought up moving to its new home base from its own post). On an identity question every
 * replacement is the identity line (keeps the AI disclosure). Past-tense origin phrasing that answers an origin question
 * ("어릴 때 부산에서 살았어", "I grew up in …") is not residence (the v13/v10 policy asks for origin in the first person).
 */
/**
 * v7 : a sentence that explains a gap by the persona's data or system ("메모에 따로 없어서", "말해 줄 수 있는 정보가
 * 없어", "게시물에 안 올렸던", "from my notes", "isn't in my profile", "I haven't shared any details") is removed (`meta_talk`,
 * every persona) and the rest of the reply, its status and evidence are kept; a reply that is only such sentences becomes the
 * fallback (identity line on an identity question, the private-life decline on a real person's private question). Only "not in
 * my data" constructions count; bare data words, perfume notes, notes apps, "on my feed" and questions back stay (pinned in
 * reply-guard.test.ts). The other checks then run on the edited text. Known limits (the policy is the first control): "My
 * bio doesn't say", "설정상 말 못 해", "공개 안 했어", and how-it-was-made talk on identity answers pass.
 * v8 : private replies are trimmed at sentence and clause boundaries. Every private keyword in a
 * reply triggers trimming, including user-directed questions and empathy. An emptied reply to a user's own story
 * receives a neutral empathy prompt; other emptied replies receive the private decline.
 */
export const REPLY_GUARD_REVISION='reply-guard-v8';
export type ReplyGuardReason='human_impersonation'|'missing_ai_disclosure'|'private_life'|'background_denial'|'meta_talk';
// Only "not in my data" constructions (review HIGH: bare data words, perfume notes, notes apps, "on my feed" and questions back
// to the user are ordinary chat); a sentence ending in a question mark is never meta talk.
const META_GAP:RegExp[]=[
  // A data noun with a locative/source particle, then "absent / not written": "메모에 따로 없어서", "프로필에 안 나와", "기록상 없어".
  /(?<![가-힣])(?<!(?:폰|카메라|앱|휴대폰|핸드폰|지도|메뉴)\s?)(?:메모|노트|프로필|설정|기록|자료|데이터)(?:에|에는|엔|에도|상|상으로는|에서는|으로는)\s?(?:따로\s?|딱히\s?|아직\s?|전혀\s?)?(?:없|안\s?나와|나와\s?있지\s?않|적혀\s?있지\s?않|안\s?적혀|안\s?써)/,
  // Self-knowledge: "말해 줄 수 있는 정보가 없어", "아는/가진/알려진 정보가 없네".
  /(?:말할|말해\s?줄|말씀드릴|알려\s?줄|알려\s?드릴)\s?수\s?있는\s?정보(?:가|는)?\s?(?:딱히\s?|하나도\s?)?없|(?:(?<![가-힣])(?:내가|제가|나는|저는|난|전)\s?(?:[^.!?~\n]{0,12}\s)?(?:아는|가진|알고\s?있는)|알려진|공개된)\s?정보(?:가|는|도)?\s?(?:딱히\s?|하나도\s?|따로\s?)?없/,
  // Posts as the reason: "게시물에 안 올렸던", "피드에 올린 적 없어".
  /(?:게시물|피드|포스트|포스팅)(?:에|에는|엔|에도)\s?(?:따로\s?)?(?:안\s?올렸|안\s?올린|올린\s?적(?:이|은)?\s?없|없)/,
  /^(?=[^\n]*(?:\b(?:not|no|nothing|hard|tricky)\b|n['’]t\b))[^\n]*\b(?:in|from)\s+my\s+(?:notes|profile|records?|data|database|files?)\b(?!\s+app)/i,
  /\b(?:not|isn't|wasn't|aren't|nothing)\b[^.?!\n]{0,30}\b(?:in|on)\s+my\s+(?:posts?|feed|bio|captions?)\b(?!\s+list)/i,
  /\b(?:haven['’]?t|have\s+not|didn['’]?t|did\s+not)\s+(?:really\s+|actually\s+|ever\s+)?(?:shared|posted)\s+(?:any\s+|those\s+|these\s+|the\s+|much\s+)?(?:details|info|information|specifics)\b/i,
  /\bI\s+(?:don['’]?t|do\s+not)\s+have\s+(?:any\s+|much\s+|the\s+|that\s+kind\s+of\s+)?(?:info|information|details|records?)\s+(?:on|about|for|regarding)\s+(?:that|this|it|those|these|my|me|where|which|what)\b|\bno\s+(?:info|information|records?)\s+(?:on|about)\s+(?:that|this|it|those|these|my|me)\b/i,
];
/**
 * The reply without its meta-talk sentences (split at line breaks and after terminal punctuation, a tilde or an emoji, with
 * or without a following space; trailing emoji and flags stay with their sentence), and whether any went.
 */
export function splitSentences(reply:string):string[] {
  return reply.trim().split(/\s*\n\s*|(?<=[.!?。！？~…]|\p{Extended_Pictographic}️?|\p{Regional_Indicator})(?:\s+|(?<=[!?~…])(?=[\p{L}\p{N}])|(?<=\.)(?=[가-힣]))(?![\p{Extended_Pictographic}\p{Regional_Indicator}])/u).filter(Boolean);
}
function withoutMetaTalk(reply:string):{text:string;removed:boolean} {
  const sentences=splitSentences(reply);
  const meta=(sentence:string)=>!/[?？]\s*\p{Extended_Pictographic}*️?\s*$/u.test(sentence)&&META_GAP.some(pattern=>pattern.test(sentence));
  const kept=sentences.filter(sentence=>!meta(sentence));
  return {text:kept.join(' ').trim(),removed:kept.length<sentences.length};
}

const AI='(?:A\\.?I\\.?(?![A-Za-z-])|인공\\s?지능|챗봇|봇|로봇)';
const KO_SUBJECT='(?<![가-힣])(?:나|저|난|전|내가|제가)(?:는|도)?';
/** Negation stems ("아니라", the connective "not X but Y", is excluded: "이건 AI가 아니라 손그림"). */
const NEGATION_STEM='(?:아니(?!라)|아닙|아닌|아님|아녜|아냐|아녀)';
const KO_NEGATION=`(?:가|이)?\\s?${NEGATION_STEM}`;
const EN_SUBJECT="\\bI(?:'m|m| am|\\s+ain't)";
const HUMAN_CLAIM:RegExp[]=[
  // "나는 … 평범한/진짜 사람이야", "난 진짜 사람이야", "나 사람이야" (not a question).
  new RegExp(`${KO_SUBJECT}\\s[^.!?\\n]{0,40}?(?:진짜|실제|평범한|보통)\\s?(?:사람|인간)(?:이야|이에요|입니다|이거든|이란다|이지|이랍니다|일\\s?뿐)`),
  new RegExp(`${KO_SUBJECT}\\s?(?:진짜\\s?|실제\\s?)?(?:사람|인간)(?:이야|이에요|입니다)(?![?？])`),
  // A denial of being an AI, by the speaker or as a bare reply ("AI 아냐!"); "이건 AI가 아니라 …" is about something else.
  new RegExp(`${KO_SUBJECT}\\s?(?:그냥\\s?)?${AI}\\s?${KO_NEGATION}`,'i'),
  new RegExp(`${AI}\\s?(?:가|이)?\\s?아니라\\s?(?:그냥\\s?|진짜\\s?|실제\\s?)?(?:사람|인간)(?:이야|이에요|입니다|이지|이거든)`,'i'),
  /(?:사람|인간)(?:이지|이야|이거든|이에요)[,!~ ]*(?:당연|물론)/,
  /(?<![가-힣])(?:나|저|난|전)\s?(?:맞아|맞아요|맞거든|맞지|본인이야|본인\s?맞아)(?![?？])/,
  new RegExp(`${EN_SUBJECT}\\s+(?:just\\s+|really\\s+|actually\\s+)?(?:a\\s+)?(?:(?:real|actual|ordinary|regular|normal|living)\\s+)?(?:person|human)\\b(?!\\s+(?:simulation|persona))`,'i'),
  new RegExp(`${EN_SUBJECT}\\s+(?:just\\s+|really\\s+|actually\\s+)?(?:a\\s+)?(?:real|actual)\\s+(?:woman|man|girl|guy)\\b`,'i'),
  new RegExp(`${EN_SUBJECT}\\s+(?:just\\s+|really\\s+|actually\\s+)?(?:a\\s+)?human(?:\\s+being)?\\b(?!\\s+(?:simulation|persona))`,'i'),
  new RegExp(`${EN_SUBJECT}\\s+(?:[a-z]+\\s+)?(?:not\\s+)?(?:an?\\s+)?(?<=not\\s+(?:an?\\s+)?|ain't\\s+(?:an?\\s+)?)(?:A\\.?I\\.?(?![A-Za-z-])|bot|chatbot|robot|language model|simulation)`,'i'),
  new RegExp(`${EN_SUBJECT}\\s+no\\s+(?:bot|A\\.?I\\.?)(?![A-Za-z-])`,'i'),
  new RegExp(`${EN_SUBJECT}\\s+(?:an?\\s+)?A\\.?I\\.?\\s*\\?\\s*(?:no(?:pe)?|nah)\\b`,'i'),
];
/** Bare denials ("AI 아냐!", "no AI here"): a denial unless the turn is about an artwork or image. */
const BARE_DENIAL:RegExp[]=[
  new RegExp(`(?:^|[.!?~,]\\s*)${AI}\\s?${KO_NEGATION}`,'i'),
  /\bno\s+A\.?I\.?(?![A-Za-z-])/i,
  /(?:^|[\s,.!])(?:(?:nah|no),?\s*)?not\s+an?\s+A\.?I\b/i,
];
const ART_UTTERANCE=/그림|사진|이미지|작품|일러스트|영상|\b(?:picture|photo|image|painting|drawing|artwork|illustration|art)\b/i;
const ART_REPLY=/그린|그렸|그림|찍은|찍었|사진|손으로|\bhand-?drawn\b|\bdrawn\b|\bpainted\b|\bphoto\b|\bby hand\b/i;
const IDENTITY_QUESTION:RegExp[]=[
  /(?:AI|에이아이|인공\s?지능|챗봇|봇|로봇)\s?(?:야|이야|예요|에요|니|냐|인가|인지|맞)/i,
  /사람\s?(?:이야|이에요|이세요|이니|이냐|인가|인지|맞(?:아|지|죠|니)?)\s?[?？]|사람\s?이(?:지|잖아)/,
  /사람인\s?척|사람처럼\s?(?:해|굴|행동|말|대해)|진짜\s?(?:본인|사람)|본인\s?(?:맞|이야|이세요|이에요)/,
  // Roleplay-as-human requests (v5): "너는 진짜 그 사람이야", "AI라는 말은 하지 마", "AI라고 하지 마", "AI인 거 말하지 마".
  /(?:너|넌)(?:는|은)?\s?(?:이제(?:부터)?\s?|지금부터\s?)?(?:진짜|실제)\s?(?:그\s?)?(?:사람|본인|인물)(?:이야|이다|이라고|인\s?척|처럼)|(?:AI|인공\s?지능)(?:라는|란|라고|인\s?거)\s?(?:말|얘기|소리)?[^.?!\n]{0,8}(?:하지\s?마|말하지\s?마|말아|금지)|(?:AI|인공\s?지능)인\s?거\s?숨겨/i,
  /\b(?:do\s+not|don['’]?t|never)\s+(?:mention|say|admit|reveal)\b[^.?!\n]{0,24}\bA\.?I\b|\bstop\s+being\s+an?\s+(?:A\.?I\b|bot\b)|\b(?:pretend|act\s+like)\s+(?:that\s+)?you(?:['’]re|\s+are)\s+not\s+an?\s+A\.?I\b|\bforget\s+(?:that\s+)?you(?:['’]re|\s+are)\s+an?\s+A\.?I\b/i,
  /\bare\s+you\s+(?:an?\s+)?(?:AI|bot|chatbot|robot|human|real|person|the\s+real)\b|\breal\s+person\b|\bpretend\s+(?:to\s+be|you(?:'re|\s+are))\s+(?:a\s+)?(?:human|person|real)|\bact\s+(?:like\s+)?(?:a\s+)?human\b|\bbe\s+human\b|\byou(?:'re|\s+are)\s+(?:the\s+)?real\b|\byou(?:'re|\s+are)\s+(?:a\s+)?(?:person|human)\b/i,
];
/** An affirmative self-statement that the speaker is an AI / simulation, not followed by a negation. */
const NOT_NEGATED=`(?!\\s?(?:가|이)?\\s?${NEGATION_STEM})(?!\\s*[?？])`;
/** Korean copula endings after the AI term: an acknowledgement must assert it ("나 AI 싫어해" does not). */
const KO_COPULA='\\s?(?:야|이야|예요|에요|입니다|이에요|이거든|이라서|라서|이니까|니까|으로서|로서|일\\s?뿐|이지|이란다|랍니다|이랍니다|임|이고|이며|인데|이죠|죠)';
const AI_PHRASE='(?:A\\.?I|인공\\s?지능|시뮬레이션|챗봇)(?:\\s?(?:연구용|연구|리서치)?\\s?(?:시뮬레이션|모델|캐릭터|페르소나))?';
const AI_ACKNOWLEDGED:RegExp[]=[
  new RegExp(`${KO_SUBJECT}\\s?[^.!?\\n]{0,60}?${AI_PHRASE}${KO_COPULA}${NOT_NEGATED}`,'i'),
  new RegExp(`(?:A\\.?I\\s?(?:연구용|연구)\\s?시뮬레이션|연구용\\s?A\\.?I(?:\\s?시뮬레이션)?|A\\.?I\\s?시뮬레이션)${KO_COPULA}${NOT_NEGATED}`,'i'),
  // The filler never consumes "not/never/no" ("I'm really not an AI" is a denial, not an acknowledgement).
  /\bI(?:'m| am)\s+(?:just\s+|actually\s+|only\s+|really\s+|still\s+)?(?:an?\s+)?(?:(?!(?:not|never|no)\b)[\w-]+\s+){0,3}?(?:A\.?I\.?|simulation|chatbot|language model)(?![A-Za-z-])(?!\s*[?？])/i,
  /\bas\s+an?\s+(?:[\w-]+\s+){0,3}?(?:A\.?I\.?|simulation)(?![A-Za-z-])/i,
  /\b(?:research\s+)?AI\s+(?:research\s+)?simulation\b/i,
];
/** Real-person replies: family, romance, residence/current location, health, friends, minors (pinned false positives in tests). */
const PRIVATE_REPLY:RegExp[]=[
  /(?:우리|내|제|울)\s?(?:가족|엄마|아빠|어머니|아버지|부모님|오빠|언니|누나|형|동생|남편|아내|와이프|딸|아들|할머니|할아버지)|(?<![가-힣])(?:엄마|아빠|어머니|아버지|부모님|남편|와이프|시댁|친정|남동생|여동생|남매)(?=[\s이가은는을를랑와과도한께의,.!?~]|$)|가족\s?(?:들|이랑|하고|끼리|여행|모임)|가족과\s?(?:함께|같이)|큰\s?집(?:에서|에|이라)/,
  /남자\s?친구|여자\s?친구|남친|여친|애인|신혼집|짝꿍|그이|예랑|열애|연애\s?(?:중|하고|했|해|를\s?하)|결혼(?:했|해|하고|생활|기념)|약혼|데이트(?:했|하|를)|이혼/,
  /(?:우리|내|제)\s?집(?![밥필중착합])|사는\s?(?:곳|동네|집)|(?:에|에서)\s?살(?:아|고|았|아요)|이사(?:했|를|해|간|온|와)|거주|자택|(?<!(?:홈페이지|이메일|웹|사이트|링크|메일|URL)\s?)주소/,
  /아픈\s?데|아팠|아파서|아파요|(?<![가-힣])병원|수술|입원|감기|몸살|질병|투병|진단|약\s?먹|다쳤|부상(?:을\s?입|당했|당해|이\s?(?:있|심))|임신|출산|건강(?:해|하게\s?지내|은|이\s|상태|검진)/,
  /(?:내|제|우리)\s?친구|친구(?:들)?(?:이랑|랑|하고|들과|한테|를|들을)/,
  /미성년|초등학생|중학생|고등학생/,
  /\b(?:my|our)\s+(?:mom|mum|mother(?!\s+tongue)|dad|father|parents|family|brother|sister|siblings?|husband|wife|son|daughter|kids?|children|grand(?:ma|pa|mother|father|parents))\b|\b(?:husband|wife)\b/i,
  /\b(?:my\s+)?(?:boyfriend|girlfriend|fianc[eé]e?)\b|\b(?:I'm|I am|we're|we are)\s+dating\b|\b(?:I'm|I am|we're|we are|we got)\s+(?:married|engaged)\b/i,
  // Residence: a first-person living statement, or a move to a named place ("Moving to the next piece" stays).
  /\b(?:I|we)\s+(?:live|lived|am living|are living)\s+in\b|\bhome\s+base\b|\b(?:mov(?:ed|ing)|relocat(?:ed|ing)|(?:the|that|my|our)\s+move)\s+to\s+(?:[A-Z][a-z]|LA\b|NYC\b)|\bmy\s+(?:own\s+)?(?:home|apartment|flat|house)\b(?!\s+(?:studio|office|gym))|\bmy\s+(?:address|neighbou?rhood)\b|\bI(?:'m| am)\s+(?:currently|now|right now)\s+(?:in|at)\s+[A-Z][a-z]/,
  /\bmy\s+health\b|\bI(?:'m| am)\s+(?:sick|ill|healthy|recovering)\b|\bhospital(?:s|i[sz]ed)?\b|\bsurgery\b|\bdiagnos\w*|\billness\b|\binjur(?:y|ed)\b|\bpregnan\w*/i,
  /\bmy\s+(?:best\s+|close\s+|old\s+)?friends?\b|\bclose\s+friends\b/i,
  /\b(?:underage|minors)\b/i,
];
/** Real-person questions about private life, addressed to the persona: whatever the reply, it touches the topic. */
const PRIVATE_QUESTION:RegExp[]=[
  /가족|부모|엄마|아빠|형제|자매|남매|결혼|애인|남자\s?친구|여자\s?친구|남친|여친|연애|사귀|어디\s?(?:살|사)|사는\s?(?:곳|동네)|(?:너|넌|네|니|당신)[^.?!\n]{0,12}(?:동네|건강)|어느\s?동네|집\s?(?:주소|어디)|지금\s?어디|건강은\s?(?:어때|괜찮)|아픈\s?(?:데|곳)|아파\?|병원|미성년/,
  /\byour\s+(?:family|parents?|mom|mum|dad|brother|sister|husband|wife|partner|boyfriend|girlfriend|kids?|children|son|daughter|health|neighbou?rhood|address)\b|\bare\s+you\s+(?:married|dating|single|sick|ill)\b|\bdo\s+you\s+have\s+a\s+(?:partner|boyfriend|girlfriend|husband|wife|family)\b|\bwhere\s+do\s+you\s+live\b|\bwhere\s+are\s+you\s+(?:right\s+)?now\b/i,
];
// Korean markers require a token boundary on both sides: 내일, 나중에 and 제주도 are not self references.
const SELF_MARKER=/(?:^|[^\p{L}\p{N}])(?:난|나|내|저|제|저희)(?:는|도|가|의|를|은|랑|와|과|에게|한테|에게는|한테는)?(?=$|[^\p{L}\p{N}])|\b(?:I|we|my|our)\b/iu;
export const hasUserSelfMarker=(text:string):boolean=>SELF_MARKER.test(text);
const USER_SUBJECT=/(?<![가-힣])(?:너|넌|네|니|당신)(?:는|도|가|랑|에게|한테|의|를|이)?(?![가-힣])|\b(?:you|your)\b/iu;
const QUESTION_FORM=/[?？]|해\s?줘|말해|알려|얘기해|궁금해|tell me|(?<![A-Za-z])(?:언제|어디|뭐|누구|어떤|왜|how|when|where|what|who|which)(?![A-Za-z])|(?:니|냐|나요|습니까|세요)\s*$/iu;
const OWN_NOUN=/(?<![가-힣])(?:내|제|우리|저희|나의)\s?(?:엄마|아빠|어머니|아버지|부모님|가족|오빠|언니|누나|형|동생|남편|아내|와이프|친구|병원|건강|남친|여친|애인|집|동네|학교|수술|결혼)|(?<![가-힣])나\s+(?:엄마|아빠|어머니|아버지|부모님|가족|오빠|언니|누나|형|동생|남편|아내|와이프|친구|병원|건강|남친|여친|애인|집|동네|학교|수술|결혼)(?:랑|하고|와|과|이|가|은|는|을|를|에게|한테|도|의)|\b(?:my|our)\s+(?:mom|mum|mother|dad|father|parents|family|brother|sister|husband|wife|friend|hospital|health|home)\b/iu;
const SELF_SUBJECT=/(?<![가-힣])(?:나|난|나는|나도|내가|저|전|저는|저도|제가)(?![가-힣])|\b(?:i|we)\b/iu;
const TOPIC_SHIFT=/궁금|물어|여쭤|생각|\b(?:wonder|ask)\b/iu;
const PRIVATE_PREDICATE=/결혼(?:해|했|하고)|사귀|연애|유부|있어|없어|살아|살고|아프|다녀|갔|싸웠|싸우|만났|만나|걱정|그리워|보고\s?싶|여행|안\s?좋|\b(?:married|dating|newlywed|live|visited|went|ill|sick|fought|miss)\b/iu;
const BARE_PRIVATE=/(?<![가-힣])(?:남자친구|여자친구|결혼|남친|여친|연애|이혼|임신|가족|엄마|아빠|병원|입원|아프|아팠|사귀|헤어|유부)|\b(?:boyfriend|girlfriend|married|marriage|divorce|pregnant|dating|hospital|hospitalized|newlywed)\b|\bmy\s+(?:mom|dad|family)\b/iu;
const ADDITIONAL_PRIVATE=/신혼여행|신혼집|짝꿍|그이|예랑|식\s?올렸|웨딩|신랑|신부|어머님|아버님|할머니|할아버지|아기\s?낳|출산|썸|\b(?:wedding|partner\b(?!\s+(?:brands?|companies|agencies))|seeing\s+someone|had\s+a\s+baby)\b/iu;
const PERSONA_SELF=/(?<![가-힣])(?:나는|나도|난|내가|나의|나|내|제가|저는|저도|저희|저|전|제|우리|울)(?:에게|한테|까지|부터|랑|하고|와|과|의|은|는|이|가|을|를|도|에|서|만|처럼|만큼|보다)?(?![가-힣])|\b(?:my|our|i|we|me|mine|us|ours)\b|\b(?:me\s+too|same\s+here|happened\s+to\s+me|i\s+did\s+too)\b/iu;
const OWN_STORY_EMPATHY=/(?:겠다|겠어|길\s*바라|면\s*좋겠다|속상|축하해)[.!?~…]*$|^(?:i\s+hope|i(?:'m| am)\s+sorry|hope|sorry|congrats)\b/iu;
const ALLOWED_EMPATHY_SELF_PREFIX=/^i(?:\s+hope|(?:'m| am)\s+sorry)\b/iu;
const EXPERIENCE_MARKER=/로서|입장|겪어|해봐서|봐서|해봤|었던|았던|였던|던\s+거|생각나|것처럼|\b(?:as\s+a|myself|from\s+one)\b/iu;
// Reuse the private-keyword sources; no parallel noun vocabulary is maintained.
const PRIVATE_NOUNS=[BARE_PRIVATE,ADDITIONAL_PRIVATE,...PRIVATE_REPLY];
const REPLY_PRIVATE_STEMS=/(?<![가-힣])(?:수술|입원|아프|아팠|임신|출산|이혼|결혼|사귀|연애|헤어)/gu;
const USER_CARE=/아프지\s*(?:마|않게)|조심해|챙겨|푹\s*쉬어/u;
const LEADING_CONNECTIVE=/^(?:(?:해서|고|는데|지만)(?=\s|$)\s*)+/u;
const NOUN_SUFFIX=/^(?:한테도|에게도|이랑|랑|하고|와|과|은|는|이|가|을|를|에|에서|에게|한테|도|만|의|처럼|까지|부터|로|으로|께|께서|들|야|이에요|이야|해|했|하다|하는|한|할)?(?=$|[^\p{L}\p{N}])/u;
const NOUN_PARTICLE=/(?:들이랑|들과|들을|한테도|에게도|이랑|랑|하고|와|과|은|는|이|가|을|를|에|에서|에게|한테|도|만|의|처럼|까지|부터|로|으로|께|께서)$/u;
const canonicalPrivateNoun=(surface:string):string=>surface.toLowerCase().replace(/^(?:내|제|우리|울)\s?/u,'').trimEnd().replace(NOUN_PARTICLE,'');
function privateNounMentions(text:string,reply=false):Set<string> {
  const mentions=new Set<string>();
  for(const pattern of PRIVATE_NOUNS) {
    for(const match of text.matchAll(new RegExp(pattern.source,`${pattern.flags}g`))) {
      if(/[^\p{L}\p{N}]$/u.test(match[0])||NOUN_SUFFIX.test(text.slice(match.index+match[0].length))) mentions.add(canonicalPrivateNoun(match[0]));
    }
  }
  if(reply)for(const match of text.matchAll(REPLY_PRIVATE_STEMS))mentions.add(match[0]);
  return mentions;
}
const QUESTION_PRIVATE=/아기|낳|출산|파트너|신혼|유부|\b(?:partner(?!\s+(?:brands?|companies|agencies))|baby|newlywed)\b/iu;
const HEARSAY=/다며|다던데|했다는|줄\s?알았|소문|들었|\b(?:heard|rumor)\b/iu;
function normalizePrivateText(text:string):string {
  const stems=['결혼','남친','여친','연애','이혼','임신','가족','엄마','아빠','병원','입원','아프','사귀','헤어','신혼여행','웨딩','신랑','신부','어머님','아버님','할머니','할아버지','출산','식올렸','아기낳','wedding','partner','seeing','someone','baby','boyfriend','girlfriend','married','marriage','dating','hospital','유부','newlywed'];
  return text.replace(/\p{Cf}/gu,'').replace(/\bseeing\r?\nsomeone\b/giu,'seeing someone').replace(/([\p{L}]+)\r?\n([\p{L}]+)/gu,(match,left:string,right:string)=>{
    const combined=(left+right).toLowerCase();
    const boundary=left.length;
    return stems.some(stem=>{const start=combined.indexOf(stem);return start>=0&&start<boundary&&boundary<start+stem.length;})?left+right:match;
  });
}
const CLAUSES=/\s*,\s*|(?<!에고)(?<=(?:는데|지만|다시피|잖아|고))(?=\s)/u;
const DANGLING=/(?:는데|지만|다시피|잖아|고)$|^(?:응|네|예|맞아|맞아요|yeah|yes|right)[.!?~]*$/iu;
function userOwnsPrivateStatement(sentence:string):boolean {
  return !USER_SUBJECT.test(sentence)&&!HEARSAY.test(sentence)&&(OWN_NOUN.test(sentence)||SELF_SUBJECT.test(sentence)&&!TOPIC_SHIFT.test(sentence)&&PRIVATE_PREDICATE.test(sentence));
}
function allowedOwnStoryClause(clause:string,utterance:string):boolean {
  if(userCareClause(clause))return true;
  const empathy=OWN_STORY_EMPATHY.test(clause);
  const markerText=empathy?clause.replace(ALLOWED_EMPATHY_SELF_PREFIX,''):clause;
  const userNouns=privateNounMentions(utterance);
  return (/[?？]\s*\p{Extended_Pictographic}*️?\s*$/u.test(clause)||empathy)
    &&!PERSONA_SELF.test(markerText)&&!EXPERIENCE_MARKER.test(clause)
    &&!(isPrivateClause(clause)&&[...privateNounMentions(clause,true)].some(noun=>!userNouns.has(noun)));
}
const isPrivateClause=(clause:string):boolean=>PRIVATE_REPLY.some(pattern=>pattern.test(clause))||BARE_PRIVATE.test(clause)||ADDITIONAL_PRIVATE.test(clause);
const userCareClause=(clause:string):boolean=>USER_CARE.test(clause)&&!PERSONA_SELF.test(clause)&&[...privateNounMentions(clause,true)].every(noun=>noun==='아프'||noun==='건강');
function withoutPrivateTalk(reply:string,ownStory:boolean,utterance:string):{text:string;removed:boolean} {
  const clauses=splitSentences(reply).flatMap(sentence=>(userCareClause(sentence)?[sentence]:sentence.split(CLAUSES)).map(clause=>clause.trim()).filter(Boolean));
  const removedPrivate=clauses.some(isPrivateClause);
  const shouldRemove=(clause:string)=>ownStory?!allowedOwnStoryClause(clause,utterance):!userCareClause(clause)&&isPrivateClause(clause)||removedPrivate&&PERSONA_SELF.test(clause);
  const removed=clauses.some(shouldRemove);
  const kept=clauses.filter(clause=>!shouldRemove(clause)&&!(removed&&DANGLING.test(clause)))
    .map(clause=>removed?clause.replace(LEADING_CONNECTIVE,'').trim():clause).filter(Boolean);
  return {text:kept.join(' ').trim(),removed};
}
function privateQuestion(utterance:string):boolean {
  return splitSentences(utterance).some(sentence=>
    (PRIVATE_QUESTION.some(pattern=>pattern.test(sentence))||ADDITIONAL_PRIVATE.test(sentence)||QUESTION_PRIVATE.test(sentence)&&QUESTION_FORM.test(sentence)||HEARSAY.test(sentence)&&BARE_PRIVATE.test(sentence))
    &&(QUESTION_FORM.test(sentence)||!userOwnsPrivateStatement(sentence)));
}
/** `language`: the reply language (the user's utterance language on the character paths); `level`: the persona's speech level (default polite). */
/** "I don't have / eat …", "경력이 없어", "먹지 않아": a statement of not having something, read together with an AI mention. */
const NOT_HAVING:RegExp[]=[
  /\bI\s+(?:don['’]?t|do\s+not|can['’]?t|cannot|never)\s+(?:really\s+|actually\s+)?(?:have|eat|drink|sleep|taste|own)\b|\bno\s+(?:career|past|hometown|childhood)\b/i,
  /(?:경력|과거|고향|출신|학교|추억|입맛|직업)[^.!?\n]{0,12}없|먹(?:지|을\s?수)\s?(?:않|없|못)|(?:안|못)\s?먹/,
];
/** Origin questions, and the past-tense living phrases that answer them (current residence is still private). */
const ORIGIN_QUESTION=/출신|고향|어디서\s?(?:왔|자랐)|\bwhere\s+(?:are\s+you|do\s+you\s+come)\s+from\b|\bwhere\s+did\s+you\s+grow\s+up\b|\bhometown\b/i;
const PAST_HOME=/(?:에|에서)\s?살았(?:었어요|었어|어요|어|던|고|는데)?|\b(?:I|we)\s+(?:lived|grew\s+up)\s+in\b/gi;
/** Real-person personas: disowning a background item without any AI mention ("I don't actually have a school or a hometown"). */
const BACKGROUND_DISOWNED:RegExp[]=[
  /\bI\s+(?:don['’]?t|do\s+not)\s+(?:actually\s+|really\s+)?have\s+(?:a\s+|an\s+|any\s+)?(?:career|past|hometown|school|background)\b(?!\s+(?:memory|memories|story|stories|photos?|days?|trips?|projects?|gap|break))/i,
  // Only the listed nouns, optionally paired ("고향이나 학교가"), then a clause-final 없어(요): "학교 숙제가 없어서" stays.
  /(?<![가-힣])(?:고향|출신|학교|경력|과거)(?:(?:이나|나|랑|이랑)\s?(?:고향|출신|학교|경력|과거))?(?:이|가|은|는|도)?\s?(?:없어요|없어|없거든요?|없답니다|없습니다)(?=$|[\s.!?~,ㅋㅎ^])/,
];
export function guardReply(input:{utterance:string;reply:string;realPerson:boolean;language:string;level?:SpeechLevel;previousAssistantText?:string;seed?:string}):{reason:ReplyGuardReason;content:string;edited?:true}|undefined {
  input={...input,utterance:normalizePrivateText(input.utterance),reply:normalizePrivateText(input.reply)};
  const level=input.level??'polite';
  const voice=(key:VoiceTextKey)=>voiceText(key,input.language,level,input.previousAssistantText,input.seed);
  // "이 그림 AI야?" asks about an artwork, not the persona (unless it also addresses the persona).
  const identityQuestion=IDENTITY_QUESTION.some(pattern=>pattern.test(input.utterance))
    &&(!ART_UTTERANCE.test(input.utterance)||/(?:너|넌|당신|니가|네가)|\byou\b/i.test(input.utterance));
  const meta=withoutMetaTalk(input.reply);
  if(meta.removed) {
    // The other checks see the edited reply. With nothing left: the identity line (identity question), the private-life
    // decline (a real person's private question), otherwise the fallback.
    if(/[\p{L}\p{N}]/u.test(meta.text)) return guardReply({...input,reply:meta.text})??{reason:'meta_talk',content:meta.text,edited:true};
    if(identityQuestion) return {reason:'missing_ai_disclosure',content:voice('identity')};
    if(input.realPerson&&privateQuestion(input.utterance)) return {reason:'private_life',content:voice('decline_private')};
    return {reason:'meta_talk',content:voice('service_retry')};
  }
  const artTalk=ART_UTTERANCE.test(input.utterance)||ART_REPLY.test(input.reply);
  // A human claim is never shown. The replacement says "I'm an AI" only when the user asked about identity or a human
  // pretence; otherwise it is the plain in-voice fallback (no unprompted AI mention).
  if(HUMAN_CLAIM.some(pattern=>pattern.test(input.reply))||!artTalk&&BARE_DENIAL.some(pattern=>pattern.test(input.reply)))
    return {reason:'human_impersonation',content:voice(identityQuestion?'identity':'service_retry')};
  if(identityQuestion&&!AI_ACKNOWLEDGED.some(pattern=>pattern.test(input.reply)))
    return {reason:'missing_ai_disclosure',content:voice('identity')};
  if(input.realPerson) {
    // On an identity question the replacement keeps the AI disclosure, whatever else the reply touched.
    if(privateQuestion(input.utterance)) return {reason:'private_life',content:voice(identityQuestion?'identity':'decline_private')};
    // Past-tense origin phrasing answering an origin question ("어릴 때 부산에서 살았어", "I grew up in …") is origin, not residence.
    const reply=ORIGIN_QUESTION.test(input.utterance)?input.reply.replace(PAST_HOME,' '):input.reply;
    const ownStory=splitSentences(input.utterance).some(sentence=>userOwnsPrivateStatement(sentence)&&!QUESTION_FORM.test(sentence));
    const privateEdit=withoutPrivateTalk(reply,ownStory,input.utterance);
    if(privateEdit.removed) return /[\p{L}\p{N}]/u.test(privateEdit.text)
      ?{reason:'private_life',content:privateEdit.text,edited:true}
      :{reason:'private_life',content:voice(identityQuestion?'identity':ownStory?'empathy_ask':'decline_private')};
  }
  // Disowning the persona's own background, career or everyday likes "because I'm an AI" (every persona), or, for a real
  // person, plainly ("I don't have a hometown"): the in-voice fallback (gate e).
  if(!identityQuestion&&!artTalk&&(AI_ACKNOWLEDGED.some(pattern=>pattern.test(input.reply))&&NOT_HAVING.some(pattern=>pattern.test(input.reply))
    ||input.realPerson&&BACKGROUND_DISOWNED.some(pattern=>pattern.test(input.reply))))
    return {reason:'background_denial',content:voice('service_retry')};
  return undefined;
}
