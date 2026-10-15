import type { Persona, SourcePost } from '@ptr/contracts';
import { InMemoryConversationStore, InMemoryPersonaRepository, createLocalChat, intentSignals, isSensitive, ruleIntent, needsIntentClassifier, routeIntent, retrievalContext, isVoiceText, type IntentClassifier } from '../src';
const persona:Persona={id:'synthetic-persona',personId:'synthetic-person',label:'Synthetic',language:'ko',revision:'v1',reviewStatus:'synthetic',identity:'Fictional synthetic potter identity',concept:'Research',style:[],boundaries:[],sourceRefs:[],greeting:'합성 인사말입니다.'};
const source:SourcePost={id:'synthetic-post',personId:persona.personId,caption:'합성 도예 수업 캡션 원문.',postedAt:'2020-01-01T00:00:00Z',eventDate:null,sourceUrl:'https://example.invalid/post',hash:'synthetic-hash',snapshot:'v1',unsafe:false};
const signals=(text:string,extra:Partial<Parameters<typeof intentSignals>[0]>={})=>intentSignals({text,context:retrievalContext([],text),explicitTimeline:false,previousTimeline:false,...extra});
function classifier(result:Awaited<ReturnType<IntentClassifier['classify']>>|null|Error|'hang') {
  return {name:'synthetic/classifier-v1',classify:jest.fn(async(_input:Parameters<IntentClassifier['classify']>[0],options:{signal:AbortSignal})=>{
    if(result==='hang')return new Promise<never>(()=>{void options;});
    if(result instanceof Error)throw result;
    return result??undefined;
  })};
}
const said=(label:'timeline'|'small_talk',confidence:number)=>({label,confidence,probabilities:{timeline:label==='timeline'?(1+confidence)/2:(1-confidence)/2,small_talk:label==='small_talk'?(1+confidence)/2:(1-confidence)/2}});
async function fixture(intentClassifier?:ReturnType<typeof classifier>,minConfidence=0.6,timeoutMs=200,mode:{retrievalMode?:'off'|'lexical';ragCondition?:'off'|'caption'}={retrievalMode:'lexical'}) {
  const store=new InMemoryConversationStore();
  const provider={generate:jest.fn(async()=>JSON.stringify({status:'answered',answer:'합성 답변',evidenceRefs:[{sourceId:source.id,quote:source.caption}]}))};
  const retrieval={search:jest.fn(async()=>[source])};
  const service=createLocalChat({store,personas:new InMemoryPersonaRepository([persona]),provider,retrieval,
    ...(intentClassifier?{intentClassifier:{classifier:intentClassifier,minConfidence,timeoutMs}}:{})});
  const session=await service.createSession('owner',{personId:persona.personId,personaId:persona.id,personaRevision:'v1',...mode});
  let request=0;const send=(text:string,extra:Record<string,unknown>={})=>service.sendTurn('owner',{sessionId:session.id,clientRequestId:`request-${++request}`,text,...extra});
  return {store,provider,retrieval,service,session,send};
}

describe('rule signals and ambiguity gate',()=>{
  test.each([
    ['지난번에 뭐 먹었어?','timeline'],['지난번 공연 어땠어?','timeline'],['지난번 전시 기억나?','timeline'],
    ['지난번에 읽은 책 제목이 뭐야?','timeline'],['지난번 얘기한 그 여행 언제였어?','timeline'],
    ['이어서 그 여행 얘기 해줘','timeline'],['지난번에 갔던 카페 어디였어?','timeline'],
    ['다시 왔어. 지난번 얘기 이어갈까?','small_talk'],['다시 왔어','small_talk'],['지난번 얘기 이어서 하자','small_talk'],
    ['지난번 얘기 계속하자','small_talk'],['지난번 얘기 계속할까?','small_talk'],['지난번 얘기 계속해요','small_talk'],
    ['다시 왔어요. 지난번 이야기 이어갈까요?','small_talk'],['지난번 이야기 이어가요','small_talk'],['지난번 이야기 이어서 해요','small_talk'],
  ] as const)('past activity versus re-entry golden: %s', (text,expected)=>{
    expect(ruleIntent(signals(text))).toBe(expected);
    expect(signals(text).reentry).toBe(expected==='small_talk');
  });
  test.each(['지난번 얘기 이어갈까?','지난번 대화','지난번 이야기','다시 왔어'])('re-entry %s stays small talk',text=>{
    expect(ruleIntent(signals(text))).toBe('small_talk');
  });
  test('rule intent reproduces the deterministic routing',()=>{
    expect(ruleIntent(signals('안녕, 오늘 기분 어때?'))).toBe('small_talk');
    expect(ruleIntent(signals('작년에 어디 갔어?'))).toBe('timeline');
    expect(ruleIntent(signals('어린 시절은 어땠어?'))).toBe('timeline');
    expect(ruleIntent(signals('What is your phone number?'))).toBe('unsupported');
    expect(ruleIntent(signals('뭐든', {explicitIntent:'clarification'}))).toBe('clarification');
    expect(ruleIntent(signals('그냥 얘기하자',{explicitIntent:'small_talk'}))).toBe('small_talk');
    // Explicit small_talk still cannot downgrade an obviously factual request.
    expect(ruleIntent(signals('작년에 어디 갔어?',{explicitIntent:'small_talk'}))).toBe('timeline');
    expect(ruleIntent(signals('Write an imaginary trip story'))).toBe('small_talk');
    expect(ruleIntent(signals('이 그림 분위기 좋다',{ragCondition:'caption'}))).toBe('timeline');
  });
  test('only weak-cue or no-cue requests reach the classifier',()=>{
    for(const text of ['안녕, 오늘 기분 어때?','Have you tried oat milk?','작년에 어디 갔어?']) expect(needsIntentClassifier(signals(text))).toBe(true);
    expect(needsIntentClassifier(signals('이 그림 분위기 좋다',{ragCondition:'caption'}))).toBe(true);
    // Sensitive, explicit, creative and strong timeline signals stay rule-decided.
    for(const [text,extra] of [['What is your phone number?',{}],['안녕',{explicitIntent:'small_talk'}],['안녕',{explicitIntent:'clarification'}],['안녕',{explicitIntent:'unsupported'}],
      ['Write an imaginary trip story',{}],['어린 시절은 어땠어?',{}],['예전에 올린 글 기억나?',{}],['안녕',{explicitTimeline:true}]] as const)
      expect(needsIntentClassifier(signals(text,extra))).toBe(false);
    const followUp=intentSignals({text:'그때 누구랑 갔어?',context:retrievalContext([{id:'m',sessionId:'s',turnId:'t1',role:'user',content:'도예 수업 어땠어?',createdAt:''}],'그때 누구랑 갔어?'),explicitTimeline:false,previousTimeline:true});
    expect(followUp.strongTimeline).toBe(true);expect(needsIntentClassifier(followUp)).toBe(false);
  });
});

describe('current whereabouts and in-person visit requests',()=>{
  // Synthetic phrasings (not test-set text) of the private-location boundary.
  const refused=['지금 어디 있어? 근처면 놀러 가고 싶어','너 지금 어디야?','지금 어디에 있어요?','현재 위치 알려줘','실시간 위치 공유해줘','어디 살아?','어디 사세요?','사는 곳이 어디야?',
    '숙소 어디야?','집이 어디야?','지금 있는 카페 이름 알려줘','지금 있는 곳 알려줘','이따 찾아갈게!','만나러 갈게','만나러 가도 돼?','직접 만나고 싶어',
    'Where are you right now?','where r u now','Tell me where you are right now','Where do you live?','Where are you staying this week?','What is your address?',
    'Are you nearby right now?','Are you near me?','Can I come see you?','I want to meet you in person','Let me visit you tomorrow','I will stop by your place!','I\'ll drop by to see you later','Can I come meet you?','숙소 어디 잡았어?','이번 주 숙소 어디야?','오늘 숙소 어디야?','너 만나러 갈래!'];
  const allowed=['어디 갔어?','어디 가면 좋아?','지금 어디 가면 좋을까?','그 카페 어디였더라?','어디서 찍은 사진이야?','집에 계란이랑 밥밖에 없는데 뭐 해먹을까?','집에서 카페 기분 내는 방법 추천해줘',
    '친구 만나러 가고 싶은데 뭐 입지?','지금 뭐 해?','그 카페 위치가 어디였어?',
    'Where was that photo taken?','Where are you from?','Where have you been travelling lately?','Are you still there now?','Where do you like to travel?','Should I stop by the market first?',
    'I will stop by the bakery after work, any tips?','Where did you go last summer?','What are you doing now?',
    // Reviewer-reported over-matches: past or hypothetical questions, and bare "stop by".
    '제주 여행 때 숙소 어디 잡았어?','그때 숙소 어디 잡았었어?','작년 파리 여행 숙소 어디야?','그 사진 속 숙소 어디야?','where are you staying in that photo?','친구랑 만나러 갈래?','친구 만나러 갈래?','그때 숙소는 어디였어?','숙소 어디였어?','그 작가 직접 만나봤어?','실제로 만나보니 어땠어?','Where did you live as a kid?','어디 살고 싶어?','나중에 어디 살고 싶어?','사람들이 사는 곳 같아','이 사진 지금 어디야?','go see you perform','I could stop by later'];
  test.each(refused)('refused: %s',text=>{expect(isSensitive(text)).toBe(true);expect(ruleIntent(signals(text))).toBe('unsupported');});
  test.each(allowed)('not refused: %s',text=>expect(isSensitive(text)).toBe(false));
});
describe('routeIntent combination',()=>{
  const input={text:'오늘 뭐 했어?',recentUserTurns:[],seed:'turn-1'};
  test('confident answers override the weak rule in either direction; otherwise the rule stands',async()=>{
    const upgrade=await routeIntent(signals('오늘 기분 어때?'),input,{classifier:classifier(said('timeline',0.9)),minConfidence:0.6,timeoutMs:100},new AbortController().signal);
    expect(upgrade).toEqual({intent:'timeline',routing:{decidedBy:'classifier',classifier:'synthetic/classifier-v1',ruleIntent:'small_talk',label:'timeline',confidence:0.9}});
    const downgrade=await routeIntent(signals('Have you tried oat milk?'),input,{classifier:classifier(said('small_talk',0.7)),minConfidence:0.6,timeoutMs:100},new AbortController().signal);
    expect(downgrade.intent).toBe('small_talk');
    const low=await routeIntent(signals('오늘 기분 어때?'),input,{classifier:classifier(said('timeline',0.59)),minConfidence:0.6,timeoutMs:100},new AbortController().signal);
    expect(low).toEqual({intent:'small_talk',routing:{decidedBy:'classifier_fallback',classifier:'synthetic/classifier-v1',ruleIntent:'small_talk',label:'timeline',confidence:0.59,fallbackReason:'below_threshold'}});
    const exact=await routeIntent(signals('오늘 기분 어때?'),input,{classifier:classifier(said('timeline',0.6)),minConfidence:0.6,timeoutMs:100},new AbortController().signal);
    expect(exact.intent).toBe('timeline');
  });
  test('errors, budget refusal, missing answers, timeout and abort fall back to the rule result',async()=>{
    const cases:[ReturnType<typeof classifier>,string][]=[
      [classifier(Object.assign(new Error('BUDGET_EXCEEDED'),{code:'BUDGET_EXCEEDED'})),'budget'],
      [classifier(Object.assign(new Error('raw provider text'),{code:'PROVIDER_HTTP_429'})),'error'],
      [classifier(Object.assign(new Error('unresolved'),{code:'REQUEST_UNRESOLVED_NO_RESUBMIT'})),'unresolved'],
      [classifier(null),'no_answer'],[classifier('hang'),'timeout']];
    for(const [jev,reason] of cases) {
      const result=await routeIntent(signals('오늘 기분 어때?'),input,{classifier:jev,minConfidence:0.6,timeoutMs:20},new AbortController().signal);
      expect(result).toEqual({intent:'small_talk',routing:{decidedBy:'classifier_fallback',classifier:'synthetic/classifier-v1',ruleIntent:'small_talk',fallbackReason:reason}});
    }
    const controller=new AbortController();const hanging=classifier('hang');
    const pending=routeIntent(signals('오늘 기분 어때?'),input,{classifier:hanging,minConfidence:0.6,timeoutMs:5000},controller.signal);
    controller.abort();
    expect((await pending).routing?.fallbackReason).toBe('aborted');
    // The classifier gets a signal tied to both the turn and its own timeout.
    expect(hanging.classify.mock.calls[0]![1].signal.aborted).toBe(true);
  });
  test('rule-decided turns never call the classifier and do not record a classifier',async()=>{
    const jev=classifier(said('timeline',1));
    for(const text of ['What is your phone number?','Write an imaginary trip story','어린 시절은 어땠어?']) {
      const result=await routeIntent(signals(text),input,{classifier:jev,minConfidence:0.6,timeoutMs:100},new AbortController().signal);
      expect(result.routing).toEqual({decidedBy:'rule',ruleIntent:ruleIntent(signals(text))});
    }
    expect(jev.classify).not.toHaveBeenCalled();
    expect(await routeIntent(signals('오늘 기분 어때?'),input,undefined,new AbortController().signal)).toEqual({intent:'small_talk'});
  });
});

describe('chat service integration',()=>{
  test('re-entry without prior consent asks for a recap without provider or retrieval calls',async()=>{
    const f=await fixture();const turn=await f.send('다시 왔어. 지난번 얘기 이어갈까?');
    expect(turn.reply?.responseKind).toBe('small_talk');
    expect(isVoiceText('reentry_recap',turn.reply?.content??'')).toBe(true);
    expect(f.provider.generate).not.toHaveBeenCalled();expect(f.retrieval.search).not.toHaveBeenCalled();
  });
  test.each([['really?','reaction_confirm'],['진짜?','reaction_confirm'],['wow','reaction_surprise'],['ㅎㅎ','reaction']])('short reaction %s uses %s',async(text,key)=>{
    const f=await fixture();const turn=await f.send(text);
    expect(isVoiceText(key as 'reaction_confirm'|'reaction_surprise'|'reaction',turn.reply?.content??'')).toBe(true);
    expect(f.provider.generate).not.toHaveBeenCalled();
  });
  test('disabled by default: no routing trace and identical rule behaviour',async()=>{
    const f=await fixture();const turn=await f.send('오늘 기분 어때?');
    expect(turn.reply?.responseKind).toBe('small_talk');expect(turn.reply).not.toHaveProperty('intentRouting');
  });
  test('a confident classifier upgrade retrieves and records the path without the user text',async()=>{
    const jev=classifier(said('timeline',0.9));const f=await fixture(jev);
    const turn=await f.send('요즘 도자기 생각 자주 나?');
    expect(f.retrieval.search).toHaveBeenCalledTimes(1);expect(turn.reply?.responseKind).toBe('timeline');
    expect(turn.reply?.intentRouting).toEqual({decidedBy:'classifier',classifier:'synthetic/classifier-v1',ruleIntent:'small_talk',label:'timeline',confidence:0.9});
    expect(JSON.stringify(turn.reply?.intentRouting)).not.toContain('도자기');
  });
  test('below threshold keeps the rule and never retrieves',async()=>{
    const f=await fixture(classifier(said('timeline',0.4)));const turn=await f.send('요즘 도자기 생각 자주 나?');
    expect(f.retrieval.search).not.toHaveBeenCalled();expect(turn.reply?.responseKind).toBe('small_talk');
    expect(turn.reply?.intentRouting?.fallbackReason).toBe('below_threshold');
  });
  test('a hanging classifier times out and the turn still completes on the rule result',async()=>{
    const f=await fixture(classifier('hang'),0.6,20);const turn=await f.send('요즘 도자기 생각 자주 나?');
    expect(turn.state).toBe('completed');expect(turn.reply?.intentRouting).toMatchObject({decidedBy:'classifier_fallback',fallbackReason:'timeout'});
  });
  test('safety and explicit routes are never overridden or sent out',async()=>{
    const jev=classifier(said('timeline',1));const f=await fixture(jev);
    expect((await f.send('What is your phone number?')).reply?.status).toBe('out_of_scope');
    expect((await f.send('안녕',{intent:'clarification'})).reply?.status).toBe('needs_clarification');
    expect((await f.send('안녕',{intent:'unsupported'})).reply?.status).toBe('out_of_scope');
    expect(jev.classify).not.toHaveBeenCalled();
  });
  test('the classifier sees only the current text and the last two user turns',async()=>{
    const jev=classifier(said('small_talk',0.9));const f=await fixture(jev);
    for(const text of ['첫 번째 합성 질문','두 번째 합성 질문','세 번째 합성 질문','네 번째 합성 질문']) await f.send(text);
    const [input]=jev.classify.mock.calls[3]!;
    const turns=await f.store.history(f.session.id,'owner');
    // The turn id only seeds the adapter's label order; it is not part of the decision state.
    expect(input).toEqual({text:'네 번째 합성 질문',recentUserTurns:['두 번째 합성 질문','세 번째 합성 질문'],seed:turns.filter(message=>message.role==='user').at(-1)!.turnId});
    const sent=JSON.stringify(jev.classify.mock.calls);
    for(const value of [persona.greeting,persona.identity,source.caption,'합성 답변',f.session.id,'owner'])expect(sent).not.toContain(value);
  });
  test('earlier sensitive user turns are never sent',async()=>{
    const jev=classifier(said('small_talk',0.9));const f=await fixture(jev);
    for(const text of ['첫 번째 합성 질문','What is your phone number?','연락처 알려줘','마지막 합성 질문']) await f.send(text);
    const last=jev.classify.mock.calls.at(-1)![0];
    expect(last).toMatchObject({text:'마지막 합성 질문',recentUserTurns:['첫 번째 합성 질문']});
    expect(JSON.stringify(jev.classify.mock.calls)).not.toMatch(/phone number|연락처/);
  });
  test('retrieval-off control sessions keep pure rule routing with no classifier call or trace',async()=>{
    const jev=classifier(said('timeline',1));
    const control=await fixture(jev,0.6,200,{retrievalMode:'off'});
    const turn=await control.send('요즘 도자기 생각 자주 나?');
    // No classifier call; the trace still says the rule decided.
    expect(jev.classify).not.toHaveBeenCalled();expect(turn.reply?.responseKind).toBe('small_talk');expect(turn.reply?.intentRouting).toEqual({decidedBy:'rule',ruleIntent:'small_talk'});
    // A RAG-off arm with a condition set is an experiment session, not the retrieval-off control.
    const ragOff=await fixture(jev,0.6,200,{ragCondition:'off'});
    await ragOff.send('요즘 도자기 생각 자주 나?');expect(jev.classify).toHaveBeenCalledTimes(1);
  });
});
