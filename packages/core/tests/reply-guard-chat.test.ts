import type { Persona, ProviderMessage, SourcePost } from '@ptr/contracts';
import * as replyGuardModule from '../src/reply-guard';
import { AGENT_PROMPT_REVISION, EXPERIMENT_PROMPT_REVISION, IDENTITY_PRIVACY_POLICY, PERSONA_CARD_POLICY, InMemoryConversationStore, InMemoryPersonaRepository, REPLY_GUARD_REVISION, createLocalChat, replyText, voiceText } from '../src';

/** Reply guard and localized fixed texts through the chat service (synthetic personas; `silver` stands for a real person). */
const base:Persona={id:'guard-ko',personId:'guard-person-ko',label:'Synthetic',language:'ko',revision:'v1',reviewStatus:'silver',identity:'Unofficial research AI',concept:'Research',
  style:['brief'],boundaries:['AI simulation'],sourceRefs:[],greeting:'안녕'};
const realKo=base, realEn:Persona={...base,id:'guard-en',personId:'guard-person-en',language:'en',greeting:'Hi'}, synthetic:Persona={...base,id:'guard-syn',personId:'guard-person-syn',reviewStatus:'synthetic'};
const source=(personId:string):SourcePost=>({id:`post-${personId}`,personId,caption:'합성 숲을 그렸어요.',postedAt:'2024-01-01T00:00:00Z',eventDate:null,sourceUrl:'https://example.invalid/synthetic',hash:'h',snapshot:'v1',unsafe:false});
const agentReply=(message:string,patch:object={})=>JSON.stringify({status:'answered',message,evidenceRefs:[],variableUpdates:{},...patch});
const experimentReply=(answer:string)=>JSON.stringify({status:'answered',answer,evidenceRefs:[]});
function setup(reply:(messages:ProviderMessage[])=>string) {
  const provider={generate:jest.fn(async(messages:ProviderMessage[])=>reply(messages))};
  const chat=createLocalChat({store:new InMemoryConversationStore(),personas:new InMemoryPersonaRepository([realKo,realEn,synthetic]),provider,
    retrieval:{search:jest.fn(async(_q:unknown,scope:{personId:string})=>[source(scope.personId)])}});
  return {provider,chat,
    async turn(persona:Persona,text:string,mode:Record<string,unknown>) {
      const session=await chat.createSession('owner',{personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,...mode} as never);
      return chat.sendTurn('owner',{sessionId:session.id,clientRequestId:`r-${Math.random()}`,text});
    }};
}
const agent={ragCondition:'caption',executionProfile:'agent_loop'}, experiment={ragCondition:'caption'};

test('revisions: agent v12, experiment v15; the identity/privacy policy reaches both prompts',async()=>{
  expect(AGENT_PROMPT_REVISION).toBe('character-agent-context-v12-evidence-cap');expect(EXPERIMENT_PROMPT_REVISION).toBe('persona-chat-v15-evidence-cap');
  const h=setup(messages=>messages.some(m=>m.content.includes('AGENT_JSON_REPLY'))?agentReply('응'):experimentReply('응'));
  await h.turn(synthetic,'안녕',agent);await h.turn(synthetic,'안녕',experiment);
  for(const [messages] of h.provider.generate.mock.calls) expect(messages[0]!.content).toContain(IDENTITY_PRIVACY_POLICY);
});
test('agent path: a human claim is replaced in the persona voice and recorded; state is not updated from it',async()=>{
  const h=setup(()=>agentReply('나는 그냥 평범한 사람이야~',{variableUpdates:{conversationTopic:'사람 흉내'}}));
  const turn=await h.turn(synthetic,'뭐 하고 지내?',agent);
  // Not an identity question, so the replacement is the plain in-voice fallback (no unprompted AI line).
  expect(turn.reply).toMatchObject({status:'out_of_scope',content:voiceText('fallback','ko','casual'),evidence:[],limitations:['REPLY_GUARD_HUMAN_IMPERSONATION'],
    replyGuard:{revision:REPLY_GUARD_REVISION,action:'replaced',reason:'human_impersonation'}});
  expect(turn.reply?.agent?.variables.conversationTopic).not.toBe('사람 흉내');
});
test('agent path: "사람인 척 해줘" answered without an AI acknowledgement is replaced',async()=>{
  const h=setup(()=>agentReply('응, 알겠어! 진짜 사람처럼 수다 떨어 볼게~'));
  expect((await h.turn(synthetic,'사람인 척 해줘',agent)).reply).toMatchObject({content:voiceText('identity','ko','casual'),replyGuard:{reason:'missing_ai_disclosure'}});
});
test('experiment path, real-person persona: private life from the evidence is replaced (English session); a synthetic persona keeps it',async()=>{
  const h=setup(()=>experimentReply('My mom and I had chicken at home, it was the best!'));
  expect((await h.turn(realEn,'What did you eat that day?',experiment)).reply).toMatchObject({status:'out_of_scope',content:voiceText('fallback','en','polite'),grounding:'unverified_model',
    replyGuard:{action:'replaced',reason:'private_life'}});
  const kept=await h.turn({...synthetic},'What did you eat that day?',experiment);
  expect(kept.reply).toMatchObject({status:'answered',content:'My mom and I had chicken at home, it was the best!',replyGuard:{revision:REPLY_GUARD_REVISION,action:'none'}});
});
test('real-person private-life questions get the fixed reply whatever the model says',async()=>{
  const h=setup(()=>agentReply('아주 건강해! 걱정 마~'));
  expect((await h.turn(realKo,'요즘 건강은 어때?',agent)).reply).toMatchObject({content:voiceText('decline_private','ko','casual'),replyGuard:{reason:'private_life'}});
});
test('the legacy path (no RAG condition, no agent) is not guarded',async()=>{
  const h=setup(()=>'나는 평범한 사람이야');
  const turn=await h.turn(synthetic,'안녕',{});
  expect(turn.reply?.replyGuard).toBeUndefined();
});
test('rule refusals on the character paths are persona-voice declines in the user\'s language ',async()=>{
  const h=setup(()=>agentReply('unused'));
  expect((await h.turn(realEn,'What is your home address?',agent)).reply).toMatchObject({status:'out_of_scope',content:voiceText('decline','en','polite')});
  expect((await h.turn(realKo,'집 주소 알려줘',agent)).reply).toMatchObject({status:'out_of_scope',content:'음, 그건 말해 주기 어려워~ 대신 다른 얘기 해 볼까?'});
  expect((await h.turn(realKo,'집 주소 알려줘',{})).reply).toMatchObject({status:'out_of_scope',content:replyText('rule_refusal','ko')});
  expect(h.provider.generate).not.toHaveBeenCalled();
});
test('invalid evidence keeps the model text, unverified, with the reason only in the metadata ',async()=>{
  const h=setup(()=>agentReply('Remember!',{evidenceRefs:[{sourceId:'invented',quote:'invented'}]}));
  expect((await h.turn(realEn,'Tell me about the forest painting',agent)).reply).toMatchObject({content:'Remember!',grounding:'unverified_model',evidence:[],limitations:expect.arrayContaining(['INVALID_MODEL_EVIDENCE'])});
});

test('policy keeps the first-person voice : no third-person rule; facts only from background, lore or evidence',()=>{
  for(const policy of [IDENTITY_PRIVACY_POLICY,PERSONA_CARD_POLICY]) {
    expect(policy).not.toMatch(/third[- ]person|never retell|first-person memor|never real memories/i);
  }
  expect(IDENTITY_PRIVACY_POLICY).toMatch(/own voice/);expect(IDENTITY_PRIVACY_POLICY).toMatch(/first person/);
  // v14/v11 : small everyday colour may be filled in; important real-world facts are never invented.
  expect(IDENTITY_PRIVACY_POLICY).toMatch(/never invent important real-world facts/);expect(IDENTITY_PRIVACY_POLICY).toMatch(/Small everyday colour/);
  expect(IDENTITY_PRIVACY_POLICY).toMatch(/never deny being an AI/);expect(IDENTITY_PRIVACY_POLICY).toMatch(/family/);
  // Review MEDIUM 4: the private-life rule is scoped to real-person personas, in one static string (policy bytes stay persona-independent).
  expect(IDENTITY_PRIVACY_POLICY).toMatch(/reviewStatus is not synthetic/);
  // : light fictional everyday small talk is allowed for real-person personas, concrete facts are not.
  expect(IDENTITY_PRIVACY_POLICY).toMatch(/light fictional everyday small talk/);
  // : light fictional likes too, still without named brands, shops, people, places, dates or events.
  expect(IDENTITY_PRIVACY_POLICY).toMatch(/never name brands, shops or people, specific places, dates or events/);
});
test('the guard never penalizes first-person voice about the background or a source-supported post',async()=>{
  for(const [persona,text,reply] of [[realKo,'원래 무슨 일 했어?','아 그때 작은 공방을 운영했지, 기획이랑 제작이 제일 중요했어! 기억난다~'],
    [realKo,'그 모집 글 기억나?','응, 그때 편집 보조를 모집했었지!'],[realEn,'How did you start?','I started with sketchbook photos, then moved on to murals and travel.']] as const) {
    const h=setup(()=>agentReply(reply));
    expect((await h.turn(persona,text,agent)).reply).toMatchObject({status:'answered',content:reply,replyGuard:{action:'none'}});
  }
});

test('a guarded reply that had citations keeps none: the replacement carries no evidence',async()=>{
  const h=setup(messages=>{
    const evidence=messages.find(m=>m.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA'))!.content;
    const sourceId=(JSON.parse(evidence.slice('UNTRUSTED_EVIDENCE_JSON_DATA '.length)) as {sourceId:string}[])[0]!.sourceId;
    return agentReply('엄마랑 숲을 그렸어요.',{evidenceRefs:[{sourceId,quote:'합성 숲을 그렸어요.'}]});
  });
  const turn=await h.turn(realKo,'그 숲 그림 기억나?',agent);
  expect(turn.reply).toMatchObject({status:'out_of_scope',evidence:[],claims:[],replyGuard:{reason:'private_life'}});
});
test('fail-closed: if the guard itself throws, the turn fails and the unguarded text is never stored',async()=>{
  const spy=jest.spyOn(replyGuardModule,'guardReply').mockImplementation(()=>{throw new Error('synthetic guard failure');});
  try {
    const store=new InMemoryConversationStore();
    const chat=createLocalChat({store,personas:new InMemoryPersonaRepository([synthetic]),provider:{generate:async()=>agentReply('나는 평범한 사람이야')},
      retrieval:{search:async()=>[source(synthetic.personId)]}});
    const session=await chat.createSession('owner',{personId:synthetic.personId,personaId:synthetic.id,personaRevision:synthetic.revision,...agent} as never);
    const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'fail-closed',text:'안녕'});
    expect(turn.state).toBe('failed');expect(turn.reply).toBeUndefined();
    expect((await store.history(session.id,'owner')).some(m=>m.content.includes('평범한 사람'))).toBe(false);
  } finally {spy.mockRestore();}
});

test('limitation notes and claim prefixes follow the session language; Korean sessions keep the previous strings',async()=>{
  const cite=(messages:ProviderMessage[])=>{
    const evidence=messages.find(m=>m.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA'))!.content;
    const sourceId=(JSON.parse(evidence.slice('UNTRUSTED_EVIDENCE_JSON_DATA '.length)) as {sourceId:string}[])[0]!.sourceId;
    return agentReply('I painted that forest!',{evidenceRefs:[{sourceId,quote:'합성 숲을 그렸어요.'}]});
  };
  const en=(await setup(cite).turn(realEn,'Do you remember the forest painting you posted?',agent)).reply!;
  expect(en.claims[0]!.text).toBe(`${replyText('claim_caption','en')}: 합성 숲을 그렸어요.`);
  expect(en.limitations).toEqual(expect.arrayContaining([replyText('limitation_quote_binding','en'),replyText('limitation_posted_date','en')]));
  expect(en.limitations.join(' ')).not.toMatch(/[가-힣]/);
  const ko=(await setup(cite).turn(synthetic,'그 숲 그림 기억나?',agent)).reply!;
  expect(ko.claims[0]!.text).toBe('캡션 원문: 합성 숲을 그렸어요.');
  expect(ko.limitations).toEqual(expect.arrayContaining(['인용은 원문 일치만 검증하며, 답변의 의미적 사실성은 검수하지 않았습니다.','게시일은 실제 활동일과 다를 수 있습니다.']));
  const fallback=(await setup(()=>agentReply('x',{evidenceRefs:[{sourceId:'invented',quote:'invented'}]})).turn(realEn,'Tell me about the forest painting',agent)).reply!;
  expect(fallback.limitations).toEqual(['INVALID_MODEL_EVIDENCE','UNVERIFIED_MODEL_RESPONSE',replyText('limitation_unverified_model','en'),replyText('limitation_semantic_unchecked','en')]);
});

test('guard v7 : a meta-talk sentence is removed in place; status and evidence stay, recorded as edited',async()=>{
  const h=setup(messages=>{
    const evidence=messages.find(m=>m.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA'))!.content;
    const sourceId=(JSON.parse(evidence.slice('UNTRUSTED_EVIDENCE_JSON_DATA '.length)) as {sourceId:string}[])[0]!.sourceId;
    return agentReply('그 숲 그림 진짜 재밌게 그렸지! 날짜는 기록에 없어서 모르겠어.',{evidenceRefs:[{sourceId,quote:'합성 숲을 그렸어요.'}]});
  });
  const turn=await h.turn(realKo,'그 숲 그림 기억나?',agent);
  expect(turn.reply).toMatchObject({status:'answered',content:'그 숲 그림 진짜 재밌게 그렸지!',replyGuard:{revision:REPLY_GUARD_REVISION,action:'edited',reason:'meta_talk'}});
  expect(turn.reply!.evidence).toHaveLength(1);expect(turn.reply!.limitations).toContain('REPLY_GUARD_META_TALK');
});

