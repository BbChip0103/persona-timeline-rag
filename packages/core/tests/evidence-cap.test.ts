import type { ChatMessage, Persona, ProviderMessage, SourcePost } from '@ptr/contracts';
import { InMemoryConversationStore, InMemoryPersonaRepository, buildExperimentContext, createLocalChat, runCharacterAgent, EVIDENCE_POST_LIMIT, EXPERIMENT_PROMPT_BYTE_LIMIT } from '../src';

//  (user decision, scope and fitting decided later): at most three posts in the character prompts (experiment and
// agent); whole posts in relevance order, a post that does not fit the byte budget is skipped (captions are never
// sliced); CONTEXT_LIMIT only when the prompt does not fit even with no evidence. Retrieval and the goal1 legacy path keep
// their limit. Synthetic fixtures only.
const persona:Persona={id:'cap-persona',personId:'cap-person',label:'Synthetic',language:'ko',revision:'v1',reviewStatus:'synthetic',identity:'Fictional painter',concept:'Research',style:['brief'],boundaries:['AI simulation'],sourceRefs:[],greeting:'안녕'};
const post=(id:string,caption=`합성 게시물 ${id}입니다.`,patch:Partial<SourcePost>={}):SourcePost=>({id,personId:persona.personId,caption,postedAt:'2024-01-01T00:00:00Z',eventDate:null,
  sourceUrl:`https://example.invalid/${id}`,hash:`hash-${id}`,snapshot:'v1',unsafe:false,...patch});
const posts=(...ids:string[])=>ids.map(id=>post(id));
const bytes=(messages:ProviderMessage[])=>Buffer.byteLength(JSON.stringify(messages),'utf8');
const evidence=(messages:ProviderMessage[])=>JSON.parse(messages.find(m=>m.content.startsWith('UNTRUSTED_EVIDENCE_JSON_DATA '))!.content.slice('UNTRUSTED_EVIDENCE_JSON_DATA '.length)) as {sourceId:string;caption:string}[];
const agentFinal=(patch:object={})=>JSON.stringify({status:'answered',message:'편하게 이야기해요.',evidenceRefs:[],variableUpdates:{},...patch});
const agentTool=(query:string)=>JSON.stringify({status:'answered',message:'',evidenceRefs:[],variableUpdates:{},function:{name:'timeline_search',arguments:{query}}});
/** A caption (3-byte Hangul) whose post takes about `share` of the room left by the prompt without evidence. */
function sized(id:string,share:number):SourcePost {
  const room=EXPERIMENT_PROMPT_BYTE_LIMIT-bytes(buildExperimentContext(persona,[],'질문',[]).messages);
  return post(id,'가'.repeat(Math.floor(room*share/3)));
}

describe('evidence cap (3 posts)',()=>{
  test('the prompt carries at most three posts, in the given order, and reports the rest as omitted',()=>{
    expect(EVIDENCE_POST_LIMIT).toBe(3);
    const five=posts('p1','p2','p3','p4','p5');
    const context=buildExperimentContext(persona,[],'질문',five);
    expect(context.sources.map(s=>s.id)).toEqual(['p1','p2','p3']);
    expect(evidence(context.messages).map(s=>s.sourceId)).toEqual(['p1','p2','p3']);
    expect(context.omittedSourceIds).toEqual(['p4','p5']);
    // Byte-stable: the capped prompt equals the prompt built from the first three posts alone.
    const three=buildExperimentContext(persona,[],'질문',five.slice(0,3));
    expect(context.messages).toEqual(three.messages);expect(three.omittedSourceIds).toEqual([]);
  });

  test('a repeated source ID takes one slot (first occurrence) and is never reported as omitted',()=>{
    const context=buildExperimentContext(persona,[],'질문',[post('a'),post('a','다른 합성 캡션'),post('b'),post('c'),post('d')]);
    expect(context.sources.map(s=>[s.id,s.caption])).toEqual([['a','합성 게시물 a입니다.'],['b','합성 게시물 b입니다.'],['c','합성 게시물 c입니다.']]);
    expect(context.omittedSourceIds).toEqual(['d']);
  });

  test('character experiment path: retrieval keeps the API limit (recall@5 comparable), the prompt carries the first three',async()=>{
    const provider={generate:jest.fn(async()=>JSON.stringify({status:'answered',answer:'합성 답변',evidenceRefs:[]}))};
    const retrieval={search:jest.fn(async()=>posts('p1','p2','p3','p4','p5'))};
    const chat=createLocalChat({store:new InMemoryConversationStore(),personas:new InMemoryPersonaRepository([persona]),provider,retrieval});
    const session=await chat.createSession('owner',{personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,ragCondition:'caption'});
    const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'r1',text:'그 그림 설명해 줘'});
    expect((retrieval.search.mock.calls[0] as unknown as [{limit:number}])[0].limit).toBe(5);
    expect(turn.reply?.promptEvidence).toMatchObject({sourceIds:['p1','p2','p3'],omittedSourceIds:['p4','p5']});
    expect(evidence((provider.generate.mock.calls[0] as unknown as [ProviderMessage[]])[0]).map(s=>s.sourceId)).toEqual(['p1','p2','p3']);
  });

  test('goal1 legacy timeline path (buildPrompt) keeps its previous five-post evidence',async()=>{
    const provider={generate:jest.fn(async()=>JSON.stringify({status:'insufficient_evidence',answer:'',evidenceRefs:[]}))};
    const retrieval={search:jest.fn(async()=>posts('p1','p2','p3','p4','p5','p6'))};
    const chat=createLocalChat({store:new InMemoryConversationStore(),personas:new InMemoryPersonaRepository([persona]),provider,retrieval});
    const session=await chat.createSession('owner',{personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,retrievalMode:'lexical'});
    await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'r1',text:'그 그림 설명해 줘',intent:'timeline',timeline:{dateBasis:'posted',query:'합성'}});
    expect((retrieval.search.mock.calls[0] as unknown as [{limit:number}])[0].limit).toBe(5);
    expect(evidence((provider.generate.mock.calls[0] as unknown as [ProviderMessage[]])[0]).map(s=>s.sourceId)).toEqual(['p1','p2','p3','p4','p5']);
  });

  test('agent: initial sources are capped at three',async()=>{
    const provider={generate:jest.fn(async(_messages:ProviderMessage[])=>agentFinal())};
    const run=await runCharacterAgent({provider,persona,history:[],text:'안녕',sources:posts('p1','p2','p3','p4','p5'),signal:new AbortController().signal});
    expect(run.context.sources.map(s=>s.id)).toEqual(['p1','p2','p3']);
    expect(evidence(provider.generate.mock.calls[0]![0]).map(s=>s.sourceId)).toEqual(['p1','p2','p3']);
  });

  test('agent: tool results come first, then the previous sources, at most three, deterministic',async()=>{
    const cases:[SourcePost[],string[]][]=[
      [posts('t1','t2','t3','t4'),['t1','t2','t3']],
      [posts('t1'),['t1','p1','p2']],
      [[post('p3'),post('t1')],['p3','t1','p1']],
      [[],['p1','p2','p3']],
    ];
    for(const [result,expected] of cases) {
      let call=0;const provider={generate:jest.fn(async(_messages:ProviderMessage[])=>++call===1?agentTool('합성'):agentFinal())};
      const run=await runCharacterAgent({provider,persona,history:[],text:'안녕',sources:posts('p1','p2','p3'),signal:new AbortController().signal,search:async()=>result});
      expect(run.context.sources.map(s=>s.id)).toEqual(expected);
      expect(evidence(provider.generate.mock.calls[1]![0]).map(s=>s.sourceId)).toEqual(expected);
    }
  });

  test('agent: a source seen earlier in the turn keeps its first snapshot when a tool returns it again',async()=>{
    let call=0;const provider={generate:jest.fn(async(_messages:ProviderMessage[])=>++call===1?agentTool('합성'):agentFinal())};
    const run=await runCharacterAgent({provider,persona,history:[],text:'안녕',sources:posts('p1'),signal:new AbortController().signal,
      search:async()=>[post('t1'),post('p1','바뀐 합성 캡션',{hash:'other-hash'})]});
    expect(run.context.sources.map(s=>[s.id,s.hash])).toEqual([['t1','hash-t1'],['p1','hash-p1']]);
  });
});

describe('budget fitting (whole posts in relevance order, skip what does not fit)',()=>{
  test('over the byte budget the post that no longer fits is left out whole and every caption stays intact',()=>{
    const three=[sized('b1',0.4),sized('b2',0.4),sized('b3',0.4)];
    const context=buildExperimentContext(persona,[],'질문',three);
    expect(bytes(context.messages)).toBeLessThanOrEqual(EXPERIMENT_PROMPT_BYTE_LIMIT);
    expect(context.sources.map(s=>s.id)).toEqual(['b1','b2']);expect(context.omittedSourceIds).toEqual(['b3']);
    for(const [index,item] of evidence(context.messages).entries())expect(item.caption).toBe(three[index]!.caption);
  });

  test('a top-ranked post that does not fit alone is skipped and the next ones fill in relevance order',()=>{
    const huge=sized('huge',1.2);
    const context=buildExperimentContext(persona,[],'질문',[huge,post('s1'),sized('mid',0.7),sized('mid2',0.7),post('s2'),post('s3')]);
    expect(context.sources.map(s=>s.id)).toEqual(['s1','mid','s2']);expect(context.omittedSourceIds).toEqual(['huge','mid2','s3']);
    expect(bytes(context.messages)).toBeLessThanOrEqual(EXPERIMENT_PROMPT_BYTE_LIMIT);
    const data=evidence(context.messages);
    expect(data.map(item=>item.sourceId)).toEqual(['s1','mid','s2']);
    for(const item of data)expect(item.caption).toBe(context.sources.find(source=>source.id===item.sourceId)!.caption);
    expect(data.find(item=>item.sourceId==='mid')!.caption).toHaveLength(Math.floor((EXPERIMENT_PROMPT_BYTE_LIMIT-bytes(buildExperimentContext(persona,[],'질문',[]).messages))*0.7/3));
    // Only oversized posts: the turn still runs, with no evidence.
    const none=buildExperimentContext(persona,[],'질문',[huge,sized('huge2',1.1)]);
    expect(none.sources).toEqual([]);expect(none.omittedSourceIds).toEqual(['huge','huge2']);expect(evidence(none.messages)).toEqual([]);
  });

  test('CONTEXT_LIMIT only when the prompt does not fit with no evidence',async()=>{
    const history:ChatMessage[]=[{id:'h',sessionId:'s',turnId:null,role:'user',content:'😀'.repeat(8000),createdAt:'2024-01-01T00:00:00Z'}];
    expect(()=>buildExperimentContext(persona,history,'질문',posts('p1'))).toThrow(expect.objectContaining({code:'CONTEXT_LIMIT'}));
    const provider={generate:jest.fn(async(_messages:ProviderMessage[])=>agentFinal())};
    await expect(runCharacterAgent({provider,persona,history,text:'질문',sources:posts('p1'),signal:new AbortController().signal})).rejects.toMatchObject({code:'CONTEXT_LIMIT'});
    expect(provider.generate).not.toHaveBeenCalled();
  });

  test('agent: a tool round over budget skips the post that does not fit and records it in the context step',async()=>{
    let call=0;const provider={generate:jest.fn(async(_messages:ProviderMessage[])=>++call===1?agentTool('합성'):agentFinal())};
    const run=await runCharacterAgent({provider,persona,history:[],text:'질문',sources:posts('p1'),signal:new AbortController().signal,
      search:async()=>[sized('t1',0.6),sized('t2',0.6)]});
    expect(run.context.sources.map(s=>s.id)).toEqual(['t1','p1']);
    expect(bytes(provider.generate.mock.calls[1]![0])).toBeLessThanOrEqual(EXPERIMENT_PROMPT_BYTE_LIMIT);
    expect(run.agent.steps.filter(step=>step.phase==='context')).toEqual([
      {phase:'context',iteration:0,sourceIds:['p1']},
      {phase:'context',iteration:1,sourceIds:['t1','p1'],omittedSourceIds:['t2']},
    ]);
  });

  test.each(['experiment','agent'] as const)('%s service: an oversize post is omitted (not a failed turn) and cannot be cited',async mode=>{
    const big=sized('big',1.2),small=post('small');
    const refs=[{sourceId:'big',quote:big.caption.slice(0,20)}];
    const raw=mode==='agent'?agentFinal({evidenceRefs:refs}):JSON.stringify({status:'answered',answer:'합성 답변',evidenceRefs:refs});
    const outputs=mode==='agent'?[agentTool('합성'),raw]:[raw];
    const provider={generate:jest.fn(async(_messages:ProviderMessage[])=>outputs.shift()!)};
    const retrieval={search:jest.fn(async()=>[small,big])};
    const chat=createLocalChat({store:new InMemoryConversationStore(),personas:new InMemoryPersonaRepository([persona]),provider,retrieval});
    const session=await chat.createSession('owner',{personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,ragCondition:'caption',
      ...(mode==='agent'?{executionProfile:'agent_loop' as const}:{})});
    const turn=await chat.sendTurn('owner',{sessionId:session.id,clientRequestId:'r',text:'그 그림 설명해 줘'});
    expect(turn.state).toBe('completed');
    expect(turn.reply?.promptEvidence).toMatchObject({sourceIds:['small'],omittedSourceIds:['big']});
    expect(turn.reply?.evidence).toEqual([]);expect(turn.reply?.limitations).toContain('INVALID_MODEL_EVIDENCE');
    for(const call of provider.generate.mock.calls)expect(JSON.stringify(call[0])).not.toContain(big.caption);
  });
});
