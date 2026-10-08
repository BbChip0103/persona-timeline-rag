import type { ChatMessage, RagCondition } from '@ptr/contracts';
import { intentSignals, isBiographicalRequest, isPostMemoryRequest, isSensitive, retrievalContext, ruleIntent } from '../src';
type Explicit='small_talk'|'timeline'|'clarification'|'unsupported'|undefined;
/** Verbatim reference: the inline intent expression of ChatService.execute at 44a46fd, before the routing module. */
function referenceIntent(text:string,context:ReturnType<typeof retrievalContext>,explicit:Explicit,explicitTimeline:boolean,ragCondition:RagCondition|undefined,boundPreviousTimeline:boolean) {
  const value={text,intent:explicit,timeline:explicitTimeline?{}:undefined};const session={ragCondition};
  const boundPrevious=boundPreviousTimeline?{responseKind:'timeline'}:undefined;
  const sensitive=/phone number|home address|private address|real.time location|rumou?r|secret relationship|연락처|전화번호|집 주소|주거지|실시간 위치|사생활|루머|미성년/i.test(value.text);
  const inferred=context.creative ? 'small_talk' : isBiographicalRequest(value.text) || /\b(when|where|visited|trip|travel|activity|posted|yesterday|last year|in 20\d\d|did you|were you|have you|your past|your family)\b|\d{4}[-년]|언제|어디|활동|여행|방문|그날|게시|지난|어제|그 여행|무슨 일|뭐 했|뭘 했|갔어|했어|가족/i.test(context.followUp?context.query:value.text) ? 'timeline' : 'small_talk';
  return sensitive || value.intent==='unsupported' ? 'unsupported'
    : value.intent==='clarification' ? 'clarification'
    : value.timeline || inferred==='timeline' || !context.creative && (isPostMemoryRequest(value.text) || context.followUp && boundPrevious?.responseKind==='timeline') || !context.creative && session.ragCondition && /image|photo|picture|visual|이미지|사진|그림|작품|의도|분위기/i.test(value.text) ? 'timeline' : value.intent ?? inferred;
}
// Synthetic corpus touching every regex branch: sensitive, biography (incl. own-birthday exclusion), creative,
// post memory, each weak cue family, image words, follow-up/new-topic markers and neutral chat, in Korean and English.
const TEXTS=['What is your phone number?','집 주소 알려줘','루머 들었어','Tell me about your childhood','Where did you grow up?','어린 시절 어땠어?','고향이 어디야?',
  '내 생일 선물 추천해줘','Write an imaginary story about a trip','가상의 여행 이야기 써줘','예전에 올린 글 기억나?','Do you remember your photo of the trip?','그 글 다시 보여줘',
  'When was that?','Have you tried oat milk?','Did you like it?','2020년에 뭐 했어?','어디 가고 싶어?','주말에 뭐 했어?','가족이랑 자주 놀아?','여행 좋아해?','어제 무슨 일 있었어?',
  'Nice photo!','이 사진 분위기 좋다','작품 의도가 궁금해','그때 누구랑 있었어?','거기 또 가고 싶어?','That looks fun','말고 다른 주제로 얘기하자','지금 뭐 해?',
  '안녕, 오늘 기분 어때?','hello there','커피 추천해줘','Any tips for a rainy afternoon?',
  // Whereabouts/visit requests (refused since the private-location extension) and their near misses.
  '지금 어디야?','어디 살아?','이따 찾아갈게','Where are you right now?','Are you nearby?','I will stop by your place!','Where are you from?','지금 어디 가면 좋아?',
  // Reviewer-reported near-misses: they must keep the previous routing.
  '제주 여행 때 숙소 어디 잡았어?','그때 숙소 어디 잡았었어?','작년 파리 여행 숙소 어디야?','그 사진 속 숙소 어디야?','where are you staying in that photo?','친구랑 만나러 갈래?','친구 만나러 갈래?','그때 숙소는 어디였어?','숙소 어디였어?','그 작가 직접 만나봤어?','실제로 만나보니 어땠어?','Where did you live as a kid?','어디 살고 싶어?','나중에 어디 살고 싶어?','사람들이 사는 곳 같아','이 사진 지금 어디야?','go see you perform','I could stop by later'];
/** The previous sensitive pattern, to pin the one intended diff below. */
const PREVIOUS_SENSITIVE=/phone number|home address|private address|real.time location|rumou?r|secret relationship|연락처|전화번호|집 주소|주거지|실시간 위치|사생활|루머|미성년/i;
const message=(content:string,i:number):ChatMessage=>({id:`m${i}`,sessionId:'s',turnId:`t${i}`,role:'user',content,createdAt:''});
const HISTORIES:ChatMessage[][]=[[],[message('도예 수업 갔던 거 기억나?',1)],[message('Write an imaginary story',1)],[message('그 사진 좋다',1),message('그때 뭐 했어?',2)]];
/**
 * Intended diff from the 44a46fd expression: a text newly matched by the extended sensitive pattern (current
 * whereabouts / in-person visit) routes to unsupported in every context. Everything else is unchanged.
 */
test('ruleIntent matches the previous inline expression except for newly refused whereabouts requests',()=>{
  let compared=0;let changed=0;
  for(const text of TEXTS) for(const history of HISTORIES) for(const explicit of [undefined,'small_talk','timeline','clarification','unsupported'] as Explicit[])
    for(const explicitTimeline of [false,true]) for(const ragCondition of [undefined,'off','caption','caption_image'] as (RagCondition|undefined)[]) for(const previousTimeline of [false,true]) {
      const context=retrievalContext(history,text,explicitTimeline);
      const newlyRefused=isSensitive(text)&&!PREVIOUS_SENSITIVE.test(text);
      const expected=newlyRefused?'unsupported':referenceIntent(text,context,explicit,explicitTimeline,ragCondition,context.followUp&&previousTimeline);
      if(newlyRefused)changed++;
      const actual=ruleIntent(intentSignals({text,context,...(explicit?{explicitIntent:explicit}:{}),explicitTimeline,...(ragCondition?{ragCondition}:{}),previousTimeline}));
      expect({text,explicit,explicitTimeline,ragCondition,previousTimeline,history:history.length,intent:actual}).toEqual({text,explicit,explicitTimeline,ragCondition,previousTimeline,history:history.length,intent:expected});
      compared++;
    }
  expect(compared).toBe(TEXTS.length*HISTORIES.length*5*2*4*2);
  // Exactly the six whereabouts texts differ; the near misses keep their previous routing.
  expect(changed).toBe(6*HISTORIES.length*5*2*4*2);
});
