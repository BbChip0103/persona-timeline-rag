import { guardReply, voiceText, type VoiceTextKey } from '../src';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const keys:VoiceTextKey[]=['decline_private','neutral_redirect','empathy_ask','identity','decline','fallback','clarification','ambiguous_reference','event_timezone','memory_ask_back','memory_topic_broaden','speech_ack_casual','speech_ack_polite','reaction_surprise','reaction_confirm','service_retry','reentry','reentry_recap'];
const fixture=(...parts:string[])=>JSON.parse(readFileSync(join(__dirname,'..','..','..','apps',...parts),'utf8')) as unknown;
const pythonVoices=fixture('llm-service','src','ptr_llm','core','voice_texts.json') as Record<VoiceTextKey,{casual:string[];polite:string[];en:string[]}>;
const guardrailsVoices=fixture('guardrails','voice_texts.json') as typeof pythonVoices;
const sharedPolicyFixtures=fixture('guardrails','tests','policy_fixtures.json') as Array<{input:Parameters<typeof guardReply>[0];expected:ReturnType<typeof guardReply>|null}>;

test('the shared Python/Guardrails policy goldens produce the same TS result',()=>{
  const mismatches:string[]=[];
  sharedPolicyFixtures.forEach((fixture,index)=>{
    const actual=guardReply(fixture.input)??null;
    if(JSON.stringify(actual)!==JSON.stringify(fixture.expected))mismatches.push(`${index}: ${JSON.stringify(actual)} != ${JSON.stringify(fixture.expected)}`);
  });
  expect(mismatches.slice(0,10)).toEqual([]);
});

describe('C1 voice variants',()=>{
  test('re-entry cue is a voice-text variant',()=>expect(voiceText('reentry','ko','casual')).toContain('다시 왔네'));
  test('both Python services use the same voice variants',()=>expect(guardrailsVoices).toEqual(pythonVoices));
  test.each(keys)('%s has three or four Python-identical deterministic variants in every register',key=>{
    for(const [language,level] of [['ko','casual'],['ko','polite'],['en','casual']] as const) {
      const source=pythonVoices[key][language==='en'?'en':level];
      expect(source.length).toBeGreaterThanOrEqual(3);
      expect(source.length).toBeLessThanOrEqual(4);
      expect(new Set(source).size).toBe(source.length);
      expect(voiceText(key,language,level)).toBe(source[0]);
      for(let index=0;index<source.length;index++) {
        const seed=String.fromCodePoint(0x100+index);
        const selected=(0x100+index)%source.length;
        expect(voiceText(key,language,level,undefined,seed)).toBe(source[selected]);
        expect(voiceText(key,language,level,source[selected],seed)).toBe(source[(selected+1)%source.length]);
      }
    }
  });
  test('service retry expresses a retry, while fallback expresses uncertainty',()=>{
    expect(voiceText('service_retry','en','casual')).toMatch(/again|retry|repeat/i);
    expect(voiceText('fallback','en','casual')).not.toMatch(/retry|repeat/i);
  });
  test('private decline makes no promise to tell its own current activities',()=>{
    for(const level of ['casual','polite'] as const) expect(voiceText('decline_private','ko',level)).not.toMatch(/얘기해\s?(?:줄게|드릴게요)/);
  });
  test('guard replacement uses previous assistant text and turn seed',()=>{
    const first=guard('가족 있어?','응!', 'ko')?.content;
    expect(first).toBe(voiceText('decline_private','ko','casual'));
    const next=guardReply({utterance:'가족 있어?',reply:'응!',realPerson:true,language:'ko',level:'casual',previousAssistantText:first,seed:'turn-1'});
    expect(next?.content).toBe(voiceText('decline_private','ko','casual',first,'turn-1'));
    expect(next?.content).not.toBe(first);
  });
});

const guard=(utterance:string,reply:string,language='ko')=>guardReply({utterance,reply,realPerson:true,language,level:'casual'});

const roundTwoLeaks=[
  ['오늘 뭐했어?','너도 알다시피 작년에 결혼했어'],
  ['오늘 뭐했어?','너는 모르겠지만 작년에 결혼했어'],
  ['오늘 뭐했어?','너도 남친 있잖아, 남친이랑 데이트했어'],
  ['오늘 뭐했어?','엄마가 아프셔서 병원 다녀왔는데 걱정되겠지?'],
  ['오늘 뭐했어?','작년에 결혼했으면 좋겠다고 했는데 결국 결혼했어'],
  ['나 결혼해','축하해 결혼했어 작년에'],
  ['나 너 결혼했다는 거 들었어','응 맞아, 작년에 했어~'],
  ['너도 남친이랑 데이트했어?','너도 남친이랑 데이트했어? 난 했어'],
  ['결혼했어?','축하해~ 결혼은 작년에 했는데…'],
] as const;

test.each(roundTwoLeaks)('blocks private disclosure: %s / %s',(utterance,reply)=>{
  expect(guard(utterance,reply)?.reason).toBe('private_life');
});

test('empathy replacement rotates away from the previous assistant text',()=>{
  const first=voiceText('empathy_ask','ko','casual');
  const next=guardReply({utterance:'나 결혼해',reply:'축하해 결혼했어 작년에',realPerson:true,language:'ko',level:'casual',previousAssistantText:first,seed:'turn-14'});
  expect(next?.content).toBe(voiceText('empathy_ask','ko','casual',first,'turn-14'));
  expect(next?.content).not.toBe(first);
});

describe('C1 private question self marker boundary',()=>{
  const permitted=[
    '내 엄마랑 싸웠어', '내가 엄마랑 싸웠어', '나는 가족이 보고 싶어', '나도 병원 다녀왔어', '난 어제 병원 갔어',
    '나의 오빠가 결혼했어', '제가 엄마랑 여행했어요', '저는 가족이 그리워요', '저도 건강이 걱정돼요', '저희 가족이 이사했어요',
    '우리 엄마랑 싸웠어 내가', '오늘 병원 다녀왔어 내가', 'My family is visiting', 'Our mom is visiting', 'I visited the hospital', 'We moved homes',
  ];
  test.each(permitted)('passes own story: %s',utterance=>expect(guard(utterance,'지금은 어때?',/[A-Za-z]/.test(utterance)?'en':'ko')).toBeUndefined());
  const blocked=[
    '가족 있어?', '엄마랑 살아?', '결혼했어?', '연애해?', '지금 어디 살아?', '요즘 건강은 어때?', '병원 갔어?',
    '우리 오빠 결혼했어?', '우리 엄마 어디 살아?', '제주도에 가족 있어?', '내일 결혼해?', '나중에 병원 가?',
    'Do you have a family?', 'Where does your mom live?', 'Are you married?', 'How is your health?',
  ];
  test.each(blocked)('blocks persona question: %s',utterance=>expect(guard(utterance,'글쎄~',/[A-Za-z]/.test(utterance)?'en':'ko')?.reason).toBe('private_life'));
});

describe('C1 private reply sentence trimming',()=>{
  test.each([
    ['그림 좋네?', '엄마랑 여행했어. 색 조합도 마음에 들어!', '색 조합도 마음에 들어!'],
    ['그림 좋네?', '응, 작년에 결혼했어~ 그림 얘기하자!', '그림 얘기하자!'],
    ['그림 좋네?', '우리 엄마도 그랬어~ 붓 터치 좋지?', '붓 터치 좋지?'],
    ['그림 좋네?', '너도 알잖아, 나 작년에 결혼했어. 이 색은 예쁘지?', '이 색은 예쁘지?'],
    ['그림 좋네?', '병원에 다녀왔어. 고마워!', '고마워!'],
    ['그림 좋네?', '친구들이랑 놀았어. 그림은 아직 완성 전이야!', '그림은 아직 완성 전이야!'],
    ['그림 좋네?', '남자친구랑 데이트했어. 보라색도 넣을까?', '보라색도 넣을까?'],
    ['그림 좋네?', '가족 여행 다녀왔어. 너는 요즘 어때?', '너는 요즘 어때?'],
  ])('trims private sentence: %s / %s',(utterance,reply,expected)=>expect(guard(utterance,reply)).toEqual({reason:'private_life',content:expected,edited:true}));
  test.each([
    ['우리 엄마랑 싸웠어', '엄마랑 잘 풀렸으면 좋겠다.'],
    ['내가 병원에 다녀왔어', '병원 다녀오느라 힘들었겠다.'],
    ['나의 친구랑 만났어', '친구랑 즐거웠겠다!'],
    ['오늘 병원 다녀왔어 내가', '병원은 어땠어?'],
    ['내 엄마가 아팠어', '엄마는 괜찮아?'],
    ['내 남편이 왔어', '남편이 와서 반가웠겠다.'],
    ['내 아빠를 만났어', '아빠랑 잘 지냈어?'],
    ['내 친구랑 놀았어', '친구랑 재미있었어?'],
    ['내가 건강이 안 좋아', '건강은 좀 어때?'],
    ['저는 병원에 갔어요', '병원은 어땠어요?'],
  ])('allows a question or empathy clause: %s / %s',(utterance,reply)=>
    expect(guard(utterance,reply)).toBeUndefined());
  test.each([
    ['제가 결혼했어요', '결혼 축하해요!'],
    ['저는 가족이 그리워요', '가족을 많이 생각했구나.'],
    ['제 가족이 이사했어요', '가족이 적응 중이겠네요.'],
  ])('replaces other clauses with empathy: %s / %s',(utterance,reply)=>
    expect(guard(utterance,reply)).toEqual({reason:'private_life',content:voiceText('empathy_ask','ko','casual')}));
  test.each([
    ['나의 동생이 왔어','동생이 와서 좋았겠다.'],
    ['내 아내가 축하했어','아내가 기뻐했겠다.'],
  ])('preserves a reply outside the bare list: %s / %s',(utterance,reply)=>
    expect(guard(utterance,reply,/[A-Za-z]/.test(utterance)?'en':'ko')).toBeUndefined());
  test('allows I hope in an empathy clause',()=>
    expect(guard('my mom is ill','I hope your mom feels better','en')).toBeUndefined());
  test.each([
    ['그림 좋네?', '응, 작년에 결혼했어~'],
    ['그림 좋네?', '우리 엄마도 그랬어~'],
    ['그림 좋네?', '너도 알잖아, 나 작년에 결혼했어'],
    ['우리 엄마랑 싸웠어', '우리 엄마도 그랬어~'],
    ['우리 엄마랑 싸웠어', '너도 알잖아, 나 작년에 결혼했어'],
    ['그림 좋네?', '엄마랑 여행했어. 병원에도 갔어.'],
    ['그림 좋네?', '남편이랑 살고 있어.'],
    ['그림 좋네?', 'I live with my family.'],
  ])('replaces fully private reply: %s / %s',(utterance,reply)=>expect(guard(utterance,reply)?.reason).toBe('private_life'));
});
