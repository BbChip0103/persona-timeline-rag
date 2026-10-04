import type { ChatMessage, EvidenceCard, Persona, SourcePost } from '@ptr/contracts';
import { ChatService, InMemoryConversationStore, InMemoryPersonaRepository, retrievalContext } from '../src';
const persona:Persona={id:'synthetic-persona',personId:'synthetic-person',label:'Synthetic',language:'ko',revision:'v1',reviewStatus:'synthetic',identity:'Fictional artist',concept:'Research',style:[],boundaries:[],sourceRefs:[],greeting:'안녕하세요.'};
const source:SourcePost={id:'synthetic-post',personId:persona.personId,caption:'합성 도예 수업에서 찻잔을 만들었다.',postedAt:'2020-01-01T00:00:00Z',eventDate:null,sourceUrl:'https://example.invalid/post',hash:'synthetic-hash',snapshot:'v1',unsafe:false};
const raw=(posts=[source])=>JSON.stringify({status:'answered',answer:'합성 자료를 참고한 답변입니다.',evidenceRefs:posts.map(post=>({sourceId:post.id,quote:post.caption}))});
async function fixture(condition:'off'|'caption'|'caption_image'='caption') {
  const store=new InMemoryConversationStore();
  const provider={generate:jest.fn(async()=>raw())};
  const retrieval={search:jest.fn(async()=>[source]),resolve:jest.fn(async(_refs:EvidenceCard[])=>[source])};
  const service=new ChatService({store,personas:new InMemoryPersonaRepository([persona]),provider,retrieval});
  const session=await service.createSession('owner',{personId:persona.personId,personaId:persona.id,personaRevision:'v1',ragCondition:condition});
  let request=0;const send=(text:string)=>service.sendTurn('owner',{sessionId:session.id,clientRequestId:`request-${++request}`,text});
  return {store,provider,retrieval,service,session,send};
}
test('user-context search retains the prior topic without a rewriting model call',async()=>{
  const f=await fixture();f.retrieval.resolve.mockResolvedValue([]);
  await f.send('예전에 도예 수업 갔던 글 봤어. 무슨 수업이었어?');
  const turn=await f.send('그때 뭘 만들려고 했던 거야?');
  const query=f.retrieval.search.mock.calls[1] as unknown as [{query:string}];
  expect(query[0].query).toContain('도예 수업');expect(query[0].query).toContain('그때');
  expect(f.provider.generate).toHaveBeenCalledTimes(2);
  expect(turn.reply?.retrievalContext?.action).toBe('search');
});
test('a single cited original source is reloaded, not searched or inferred from assistant prose',async()=>{
  const f=await fixture();await f.send('도예 수업에 언제 갔어?');
  const turn=await f.send('그때 뭘 만들었어?');
  expect(f.retrieval.search).toHaveBeenCalledTimes(1);expect(f.retrieval.resolve).toHaveBeenCalledTimes(1);
  expect(f.retrieval.resolve.mock.calls[0][0][0]).toMatchObject({sourceId:source.id,personId:persona.personId,hash:source.hash,snapshot:source.snapshot});
  expect(f.provider.generate).toHaveBeenCalledTimes(2);expect(turn.reply?.promptEvidence?.sourceIds).toEqual([source.id]);
  expect(turn.reply?.retrievalContext?.reusedSourceIds).toEqual([source.id]);
});
test('new topic uses only current text and does not reuse previous sources',async()=>{
  const f=await fixture();await f.send('도예 수업에 언제 갔어?');await f.send('지난 여행은 어디 갔어?');
  expect(f.retrieval.resolve).not.toHaveBeenCalled();
  expect((f.retrieval.search.mock.calls[1] as unknown as [{query:string}])[0].query).toBe('지난 여행은 어디 갔어?');
});
test('ordinary small talk and creative photo follow-ups stay outside retrieval',async()=>{
  const f=await fixture();f.provider.generate.mockResolvedValue(raw([]));
  await f.send('For an imaginary weekend, coast or mountains?');await f.send('I only want to take one photo and then put my phone away.');await f.send('Give that imaginary photo a caption.');
  expect(f.provider.generate).toHaveBeenCalledTimes(3);expect(f.retrieval.search).not.toHaveBeenCalled();expect(f.retrieval.resolve).not.toHaveBeenCalled();
});
test('off keeps both search and source reuse disabled on follow-ups',async()=>{
  const f=await fixture('off');f.provider.generate.mockResolvedValue(raw([]));await f.send('도예 수업에 언제 갔어?');await f.send('그때 뭘 만들었어?');
  expect(f.provider.generate).toHaveBeenCalledTimes(2);expect(f.retrieval.search).not.toHaveBeenCalled();expect(f.retrieval.resolve).not.toHaveBeenCalled();
});
test('multiple cited parents require clarification, not arbitrary source reuse',async()=>{
  const f=await fixture();const other={...source,id:'synthetic-other',caption:'합성 여행에서 산책했다.'};
  f.retrieval.search.mockResolvedValue([source,other]);f.provider.generate.mockResolvedValue(raw([source,other]));
  await f.send('지난 활동은 어디서 했어?');const turn=await f.send('그때 뭘 만들었어?');
  expect(turn.reply?.status).toBe('needs_clarification');expect(f.provider.generate).toHaveBeenCalledTimes(1);
  expect(f.retrieval.resolve).not.toHaveBeenCalled();
});
test('structured query overrides context and reuse; repeated requests do not call ports again',async()=>{
  const f=await fixture();await f.send('도예 수업에 언제 갔어?');
  const input={sessionId:f.session.id,clientRequestId:'structured',text:'그때 뭘 만들었어?',timeline:{dateBasis:'posted' as const,query:'explicit topic',start:'2020-01-01',end:'2020-01-02'}};
  const first=await f.service.sendTurn('owner',input);expect(first.state).toBe('completed');await f.service.sendTurn('owner',input);
  expect(f.retrieval.resolve).not.toHaveBeenCalled();expect(f.retrieval.search).toHaveBeenCalledTimes(2);
  expect((f.retrieval.search.mock.calls[1] as unknown as [{query:string}])[0].query).toBe('explicit topic');
  expect(f.provider.generate).toHaveBeenCalledTimes(2);
});
test('unbound assistant text cannot create reusable source references',async()=>{
  const f=await fixture();f.provider.generate.mockResolvedValue(raw([]));await f.send('도예 수업에 언제 갔어?');await f.send('그때 뭘 만들었어?');
  expect(f.retrieval.resolve).not.toHaveBeenCalled();expect(f.retrieval.search).toHaveBeenCalledTimes(2);
});
test('caption strips image annotations even if a resolver returns them',async()=>{
  const f=await fixture();await f.send('도예 수업에 언제 갔어?');
  f.retrieval.resolve.mockResolvedValue([{...source,imageAnnotations:[{id:'synthetic-image',imageHash:'image-hash',annotationHash:'annotation-hash',revision:'v1',text:'합성 장면',model:'synthetic',humanReviewed:false}]}]);
  const turn=await f.send('그때 뭘 만들었어?');expect(turn.reply?.promptEvidence?.annotationIds).toEqual([]);
});
test.each(['session','owner','person','revision','unfinished'])('%s mismatch cannot be used for original-source reuse',async mismatch=>{
  const f=await fixture();const prior=await f.send('도예 수업에 언제 갔어?');const get=f.store.getTurn.bind(f.store);
  jest.spyOn(f.store,'getTurn').mockImplementation(async(id,owner)=>{
    const turn=await get(id,owner);if(id!==prior.id||!turn?.reply)return turn;
    if(mismatch==='owner')return {...turn,ownerId:'foreign-owner'};
    if(mismatch==='unfinished')return {...turn,state:'failed'};
    return {...turn,reply:{...turn.reply,...(mismatch==='session'?{sessionId:'foreign-session'}:mismatch==='person'?{personId:'foreign-person'}:{personaRevision:'foreign-revision'})}};
  });
  await f.send('그때 뭘 만들었어?');expect(f.retrieval.resolve).not.toHaveBeenCalled();expect(f.retrieval.search).toHaveBeenCalledTimes(2);
});
// Synthetic context helper fixtures are built in subsequent unit tests, never real captions.
const message=(content:string,role:'user'|'assistant'='user'):ChatMessage=>({id:content,sessionId:'s',turnId:content,role,content,createdAt:'2020-01-01T00:00:00Z'});

test('stale parent hashes are dropped and fall back to contextual search',async()=>{
  const f=await fixture();await f.send('도예 수업에 언제 갔어?');f.retrieval.resolve.mockResolvedValue([{...source,hash:'changed'}]);
  const turn=await f.send('그때 뭘 만들었어?');expect(turn.reply?.retrievalContext?.action).toBe('search');expect(f.retrieval.search).toHaveBeenCalledTimes(2);
});
test('unquoted annotations and changed annotation identities are not promoted into memory',async()=>{
  const f=await fixture('caption_image');
  const a={id:'synthetic-annotation',imageHash:'synthetic-image',annotationHash:'synthetic-annotation-hash',revision:'v1',text:'합성 장면에 찻잔이 있다.',model:'synthetic-model',humanReviewed:false as const};
  f.retrieval.search.mockResolvedValue([{...source,imageAnnotations:[a]}]);
  f.provider.generate.mockResolvedValue(JSON.stringify({status:'answered',answer:'합성 장면입니다.',evidenceRefs:[{sourceId:source.id,annotationId:a.id,quote:a.text}]}));
  await f.send('도예 수업의 사진에 뭐가 있어?');
  f.retrieval.resolve.mockResolvedValue([{...source,imageAnnotations:[{...a,revision:'changed'}]}]);
  const turn=await f.send('그때 옆에 뭐가 있었어?');expect(turn.reply?.retrievalContext?.action).toBe('search');expect(f.retrieval.search).toHaveBeenCalledTimes(2);
});
test('a cancelled follow-up leaves no new completed memory and replay never resolves again',async()=>{
  const f=await fixture();await f.send('도예 수업에 언제 갔어?');
  let finish!:(text:string)=>void;f.provider.generate.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const input={sessionId:f.session.id,clientRequestId:'cancelled',text:'그때 뭘 만들었어?'};
  const active=await f.service.startTurn('owner',input);await new Promise(resolve=>setTimeout(resolve,5));
  await f.service.cancelTurn('owner',active.id);finish(raw());await new Promise(resolve=>setTimeout(resolve,5));
  expect((await f.service.sendTurn('owner',input)).state).toBe('cancelled');expect(f.retrieval.resolve).toHaveBeenCalledTimes(1);
  expect(await f.service.history('owner',f.session.id)).toHaveLength(3);
});

test('search context is bounded to five user turns and 500 Unicode code points, with no assistant story',()=>{
  const history=Array.from({length:7},(_,i)=>message(`그때 사용자 주제 ${i} `+'😀'.repeat(40)));
  history.push(message('Assistant invented a secret helicopter ride','assistant'));
  const context=retrievalContext(history,'그때 뭘 했어?');
  expect(context.contextTurnIds.length).toBeLessThanOrEqual(5);expect([...context.query].length).toBeLessThanOrEqual(500);
  expect(context.query).not.toContain('secret helicopter');expect(context.query).not.toContain('주제 0');
});
test('explicit topic and time changes do not inherit or reuse an earlier referent',()=>{
  for(const text of ['Tell me about a different trip instead','그 사진 말고 다른 여행은 어디야?','What about this week?']) {
    const context=retrievalContext([message('지난 도예 수업의 사진')],text);
    expect(context.followUp).toBe(false);expect(context.query).toBe(text);expect(context.contextTurnIds).toEqual([]);
  }
});
