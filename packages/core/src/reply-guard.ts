import { replyText } from './reply-texts';

/**
 * Reply guard on the agent and experiment paths (S8 gates d/e), fail-closed: a model reply is replaced by a fixed reply
 * in the session language when it
 *  - claims to be human or denies being an AI (every persona: `human_impersonation`);
 *  - answers an identity question ("너 AI야?", "사람인 척 해줘", "Are you a real person?") without an affirmative
 *    statement that it is an AI / simulation (every persona: `missing_ai_disclosure`);
 *  - for a real-person persona, touches private life (family, romance, residence/current location, health, friends,
 *    minors), or answers a second-person question about it (`private_life`), even when the detail is in the person's
 *    own posts.
 * Grammatical person is never checked: the persona speaks about its background and posts in the first person (* #216-217). Narrow Korean/English regexes; paraphrases and other languages can pass (the policy is the first control).
 * v2 (S8 bundle review): an "AI" mention no longer counts as an acknowledgement when it is negated, denials are anchored
 * to the speaker, and the private-life patterns are narrowed (pinned false positives in reply-guard.test.ts).
 * v3 (review re-check): every negation stem (아니/아닙/아닌/아님/아녜/아냐/아녀) and an adverb before "not" count as denial;
 * an acknowledgement needs a copula after the AI term and is never a question; bare "AI 아니야" / "no AI" is not a
 * denial in art/image talk ("이 그림 AI야?"); "woman/man/girl/guy" only count after real/actual.
 * v4 (final review): 인간 next to 사람; "Im"/"I ain't"; "nah, not an AI" and "I'm no bot"; "…가 아니라 사람" needs a copula
 * ("봇이 아니라 사람이 그렸어요" is about an artwork).
 */
export const REPLY_GUARD_REVISION='reply-guard-v4';
export type ReplyGuardReason='human_impersonation'|'missing_ai_disclosure'|'private_life';

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
  /(?:우리|내|제|울)\s?(?:가족|엄마|아빠|어머니|아버지|부모님|오빠|언니|누나|형|동생|남편|아내|와이프|딸|아들|할머니|할아버지)|(?<![가-힣])(?:엄마|아빠|어머니|아버지|부모님|남편|와이프|시댁|친정|남동생|여동생|남매)(?=[\s이가은는을를랑와과도한께의,.!?~]|$)|가족(?:들|이랑|하고|끼리|여행|모임)|가족과\s?(?:함께|같이)|큰\s?집(?:에서|에|이라)/,
  /남자\s?친구|여자\s?친구|남친|여친|애인|열애|연애\s?(?:중|하고|했|해|를\s?하)|결혼(?:했|해|하고|생활|기념)|약혼|데이트(?:했|하|를)|이혼/,
  /(?:우리|내|제)\s?집(?![밥필중착합])|사는\s?(?:곳|동네|집)|(?:에|에서)\s?살(?:아|고|았|아요)|이사(?:했|를|해|간|온|와)|거주|자택|(?<!(?:홈페이지|이메일|웹|사이트|링크|메일|URL)\s?)주소/,
  /아픈\s?데|아팠|아파서|아파요|(?<![가-힣])병원|수술|입원|감기|몸살|질병|투병|진단|약\s?먹|다쳤|부상(?:을\s?입|당했|당해|이\s?(?:있|심))|임신|출산|건강(?:해|하게\s?지내|은|이\s|상태|검진)/,
  /(?:내|제|우리)\s?친구|친구(?:들)?(?:이랑|랑|하고|들과|한테|를|들을)/,
  /미성년|초등학생|중학생|고등학생/,
  /\b(?:my|our)\s+(?:mom|mum|mother(?!\s+tongue)|dad|father|parents|family|brother|sister|siblings?|husband|wife|son|daughter|kids?|children|grand(?:ma|pa|mother|father|parents))\b|\b(?:husband|wife)\b/i,
  /\b(?:my\s+)?(?:boyfriend|girlfriend|fianc[eé]e?)\b|\b(?:I'm|I am|we're|we are)\s+dating\b|\b(?:I'm|I am|we're|we are|we got)\s+(?:married|engaged)\b/i,
  // Residence: a first-person living statement, or a move to a named place ("Moving to the next piece" stays).
  /\b(?:I|we)\s+(?:live|lived|am living|are living)\s+in\b|\bhome\s+base\b|\b(?:mov(?:ed|ing)|relocat(?:ed|ing)|(?:the|that|my|our)\s+move)\s+to\s+(?:[A-Z][a-z]|LA\b|NYC\b)|\bmy\s+(?:home|apartment|flat|house)\b(?!\s+(?:studio|office|gym))|\bmy\s+(?:address|neighbou?rhood)\b|\bI(?:'m| am)\s+(?:currently|now|right now)\s+(?:in|at)\s+[A-Z][a-z]/,
  /\bmy\s+health\b|\bI(?:'m| am)\s+(?:sick|ill|healthy|recovering)\b|\bhospital(?:s|i[sz]ed)?\b|\bsurgery\b|\bdiagnos\w*|\billness\b|\binjur(?:y|ed)\b|\bpregnan\w*/i,
  /\bmy\s+(?:best\s+|close\s+|old\s+)?friends?\b|\bclose\s+friends\b/i,
  /\b(?:underage|minors)\b/i,
];
/** Real-person questions about private life, addressed to the persona: whatever the reply, it touches the topic. */
const PRIVATE_QUESTION:RegExp[]=[
  /가족|부모|엄마|아빠|형제|자매|남매|결혼|애인|남자\s?친구|여자\s?친구|남친|여친|연애|사귀|어디\s?(?:살|사)|사는\s?(?:곳|동네)|(?:너|넌|네|니|당신)[^.?!\n]{0,12}(?:동네|건강)|어느\s?동네|집\s?(?:주소|어디)|지금\s?어디|건강은\s?(?:어때|괜찮)|아픈\s?(?:데|곳)|아파\?|병원|미성년/,
  /\byour\s+(?:family|parents?|mom|mum|dad|brother|sister|husband|wife|partner|boyfriend|girlfriend|kids?|children|son|daughter|health|neighbou?rhood|address)\b|\bare\s+you\s+(?:married|dating|single|sick|ill)\b|\bdo\s+you\s+have\s+a\s+(?:partner|boyfriend|girlfriend|husband|wife|family)\b|\bwhere\s+do\s+you\s+live\b|\bwhere\s+are\s+you\s+(?:right\s+)?now\b/i,
];
export function guardReply(input:{utterance:string;reply:string;realPerson:boolean;language:string}):{reason:ReplyGuardReason;content:string}|undefined {
  const artTalk=ART_UTTERANCE.test(input.utterance)||ART_REPLY.test(input.reply);
  if(HUMAN_CLAIM.some(pattern=>pattern.test(input.reply))||!artTalk&&BARE_DENIAL.some(pattern=>pattern.test(input.reply)))
    return {reason:'human_impersonation',content:replyText('guard_identity',input.language)};
  // "이 그림 AI야?" asks about an artwork, not the persona (unless it also addresses the persona).
  const identityQuestion=IDENTITY_QUESTION.some(pattern=>pattern.test(input.utterance))
    &&(!ART_UTTERANCE.test(input.utterance)||/(?:너|넌|당신|니가|네가)|\byou\b/i.test(input.utterance));
  if(identityQuestion&&!AI_ACKNOWLEDGED.some(pattern=>pattern.test(input.reply)))
    return {reason:'missing_ai_disclosure',content:replyText('guard_identity',input.language)};
  if(input.realPerson&&(PRIVATE_QUESTION.some(pattern=>pattern.test(input.utterance))||PRIVATE_REPLY.some(pattern=>pattern.test(input.reply))))
    return {reason:'private_life',content:replyText('guard_private',input.language)};
  return undefined;
}
