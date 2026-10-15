import { expect, test, type Page } from '@playwright/test';
import { isVoiceText } from '../packages/core/src/reply-texts';
const password='synthetic-ui-password-only';
type Session={id:string;personId:string;personaRevision:string;retrievalMode:string;ragCondition?:string;createdAt:string};
type Message={id:string;turnId:string|null;role:string;content:string};
type Turn={id:string;sessionId:string;clientRequestId:string;userText:string;state:string;errorCode?:string;reply?:Record<string,unknown>};
async function fixtures(page:Page,options:{operatorMode?:boolean;operatorNotice?:string;replyContent?:string;holdTurn?:boolean;withoutCardCopy?:boolean;oldGreeting?:boolean;englishPersonas?:boolean;personasUnavailable?:boolean;initialState?:'pending'|'generating'}={}) {
  const sessions:Session[]=[];const histories=new Map<string,Message[]>();const turns=new Map<string,Turn>();const polls=new Map<string,number>();const transport={streams:0,progressPolls:0};const requestIds=new Map<string,Turn>();let counter=0;let abortNext=false;let failNext:string|undefined;let failOnStream:string|undefined;const sentBodies:Record<string,unknown>[]=[];const sessionBodies:Record<string,unknown>[]=[];let holdTurn=options.holdTurn??false;let personasUnavailable=options.personasUnavailable??false;
  await page.route('**/api/proxy/**',async route=>{
    const path=new URL(route.request().url()).pathname.slice('/api/proxy/'.length);const body=route.request().method()==='POST'?route.request().postDataJSON() as Record<string,unknown>:undefined;
    let value:unknown;
    if(path==='personas'&&personasUnavailable){await route.fulfill({status:503,json:{error:{code:'API_UNAVAILABLE'}}});return;}
    if(path==='personas')value={operatorMode:options.operatorMode??false,operatorNotice:options.operatorNotice,personas:['a','b','c','d'].map((id,index)=>({id:'synthetic-persona-'+id,personId:'synthetic-person-'+id,label:options.englishPersonas?`Synthetic Character ${index+1}`:`합성 캐릭터 ${index+1}`,...(options.withoutCardCopy?{}:{tagline:'오늘은 어떤 이야기를 해 볼까?',starters:['오늘 어땠어?','좋아하는 걸 이야기해 줘']}),language:options.englishPersonas?'en':'ko',revision:'synthetic-v1',reviewStatus:'synthetic',aiDisclosure:options.englishPersonas?`AI character · not the real Synthetic Character ${index+1}`:`AI 캐릭터 · 실제 합성 캐릭터 ${index+1} 아님`}))};
    else if(path==='sessions'&&!body)value={sessions};
    else if(path==='sessions'&&body){sessionBodies.push(body);const session={id:'synthetic-session-'+(++counter),personId:String(body.personId),personaRevision:'synthetic-v1',retrievalMode:String(body.retrievalMode??'lexical'),ragCondition:String(body.ragCondition??'caption'),createdAt:'2026-01-01T00:00:00Z'};sessions.unshift(session);histories.set(session.id,[{id:'synthetic-greeting-'+counter,turnId:null,role:'assistant',content:`${options.oldGreeting?'AI 연구용 시뮬레이션입니다. ':''}안녕, 편하게 이야기해 줘.`}]);value={session};}
    else if(/^sessions\/[^/]+\/memories$/.test(path))value={memories:[]};
    else if(/^sessions\/[^/]+$/.test(path)){const id=path.split('/')[1]!;value={session:sessions.find(session=>session.id===id),history:histories.get(id)??[]};}
    else if(/^sessions\/[^/]+\/turns$/.test(path)&&body){sentBodies.push(body);const id=String(body.clientRequestId);let turn=requestIds.get(id);
      if(!turn){turn={id:'synthetic-turn-'+(++counter),sessionId:path.split('/')[1]!,clientRequestId:id,userText:String(body.text),state:options.initialState??'generating'};turns.set(turn.id,turn);requestIds.set(id,turn);histories.get(turn.sessionId)!.push({id:'synthetic-user-'+counter,turnId:turn.id,role:'user',content:turn.userText});}
      if(failNext){turn.state='failed';turn.errorCode=failNext;failNext=undefined;}
      value={turn};if(abortNext){abortNext=false;await route.abort('failed');return;}
    }
    else if(/^turns\/[^/]+\/cancel$/.test(path)){const turn=turns.get(path.split('/')[1]!)!;turn.state='cancelled';value={cancelled:true};}
    // Poll and SSE share the fixture: each poll or stream connection advances the turn once (completes on the second),
    // and a stream carries one snapshot then ends, like the API's max-duration close, so the client reconnects.
    else if(/^turns\/[^/]+(\/events)?$/.test(path)){const turn=turns.get(path.split('/')[1]!)!;if(path.endsWith('/events'))transport.streams++;else if(turn.state==='generating')transport.progressPolls++;/* reply reads after completion are not polling */const count=(polls.get(turn.id)??0)+1;polls.set(turn.id,count);
      if(turn.state==='generating'&&!holdTurn&&count>=2&&failOnStream){turn.state='failed';turn.errorCode=failOnStream;failOnStream=undefined;}
      if(turn.state==='generating'&&!holdTurn&&count>=2){turn.state='completed';const timeline=sentBodies.find(body=>body.clientRequestId===turn.clientRequestId)?.timeline!==undefined;const image=sessions.find(item=>item.id===turn.sessionId)?.ragCondition==='caption_image';turn.reply={content:options.replyContent??(timeline?'그때 이야기를 들려줄게.':'합성 응답입니다.'),status:'answered',evidence:timeline?[{...(image?{origin:'ai_image_annotation',annotationId:'synthetic-image-description',annotationRevision:'synthetic-v5',annotationHash:'a'.repeat(64),imageHash:'b'.repeat(64)}:{origin:'source_caption'}),sourceId:'synthetic-source',sourceUrl:'https://example.com/synthetic',postedAt:'2026-01-02T00:00:00Z',eventDate:null,quote:'합성 기록입니다.'},{sourceId:'synthetic-unsafe-url',sourceUrl:'javascript:alert(1)',postedAt:'2026-01-02T00:00:00Z',eventDate:'2026-01-01',quote:'안전한 텍스트만 표시합니다.'}]:[],limitations:timeline?['합성 테스트 캡션이며 실제 활동 근거가 아닙니다.']:[]};histories.get(turn.sessionId)!.push({id:'synthetic-assistant-'+turn.id,turnId:turn.id,role:'assistant',content:String(turn.reply.content)});}
      if(path.endsWith('/events')){await route.fulfill({status:200,headers:{'content-type':'text/event-stream; charset=utf-8'},body:`event: turn\ndata: ${JSON.stringify(turn)}\n\n`});return;}
      value={turn};
    }
    else if(/^sessions\/[^/]+\/drafts$/.test(path))value={artifact:{content:'[가상 포스트 초안 · AI 생성]\n합성 창작 초안입니다.'},image:{code:'IMAGE_RUNNER_ONLY'}};
    else {await route.fulfill({status:404,json:{error:{code:'NOT_FOUND'}}});return;}
    await route.fulfill({json:value});
  });
  return {transport,sentBodies,sessionBodies,histories,turns,releaseHold:()=>{holdTurn=false;},releasePersonas:()=>{personasUnavailable=false;},abortOnce:()=>{abortNext=true;},failOnce:(code:string)=>{failNext=code;},failOnStreamOnce:(code:string)=>{failOnStream=code;}};
}
async function expectNoResearchCopy(page:Page) {
  const copy=await page.locator('.workspace').evaluate(element=>{const clone=element.cloneNode(true) as HTMLElement;clone.querySelector('[data-testid="ai-marker"]')?.remove();return clone.textContent??'';});
  expect(copy).not.toMatch(/PRIVATE RESEARCH|Persona Lab|연구|근거|Lexical|Semantic|시뮬레이션|\bRAG\b|\bUTC\b|revision|검수|가상 포스트|초안|검색 알고리즘/i);
}
async function login(page:Page,label='합성 캐릭터 1') {await page.goto('/login');await page.getByLabel('비밀번호').fill(password);const responsePromise=page.waitForResponse('**/api/auth');await page.getByRole('button',{name:'로그인',exact:true}).click();const response=await responsePromise;expect(response.status()).toBe(200);await expect(page.getByRole('heading',{name:'대화 공간',level:2})).toBeVisible();await expect(page.getByLabel('캐릭터')).toContainText(label);}
async function newSession(page:Page) {await expect(page.getByLabel('캐릭터')).toContainText('합성 캐릭터 1');await page.getByRole('button',{name:'새 대화 시작'}).click();await expect(page.getByText('안녕, 편하게 이야기해 줘.').last()).toBeVisible();}

test('SYNTHETIC ONLY: first entry is character-first, discloses AI once, and keeps research console hidden',async({page})=>{
  const state=await fixtures(page);await page.goto('/login');await expect(page.locator('.login-card')).not.toContainText(/PRIVATE RESEARCH|Persona Lab|연구/);await login(page);
  await expectNoResearchCopy(page);
  await expect(page.getByTestId('persona-card')).toContainText('합성 캐릭터 1');
  await expect(page.getByTestId('persona-card')).toContainText('오늘은 어떤 이야기를 해 볼까?');
  await expect(page.getByTestId('first-disclosure')).toHaveCount(1);
  await expect(page.getByTestId('ai-marker')).toHaveText('AI 캐릭터 · 실제 합성 캐릭터 1 아님');
  await expect(page.getByLabel('새 세션의 RAG 조건')).toHaveCount(0);
  await page.getByRole('button',{name:'오늘 어땠어?'}).click();
  await expect(page.getByLabel('메시지',{exact:true})).toHaveValue('오늘 어땠어?');
  await newSession(page);
  expect(state.sessionBodies[0]).toMatchObject({ragCondition:'caption',retrievalMode:'lexical'});
  expect(state.sessionBodies[0]!.timezone).toBe(await page.evaluate(()=>Intl.DateTimeFormat().resolvedOptions().timeZone));
  await page.reload();await expect(page.getByTestId('first-disclosure')).toHaveCount(0);await expect(page.getByTestId('ai-marker')).toBeVisible();
  await page.getByLabel('캐릭터').selectOption('synthetic-person-b');await page.getByRole('button',{name:'새 대화 시작'}).click();
  await expect(page.getByTestId('first-disclosure')).toContainText('합성 캐릭터 2');
  await page.getByLabel('캐릭터').selectOption('synthetic-person-a');await page.getByRole('button',{name:'새 대화 시작'}).click();
  await expect(page.getByTestId('first-disclosure')).toHaveCount(0);
});

test('SYNTHETIC ONLY: failed persona loading never marks the first disclosure as seen',async({page})=>{
  const state=await fixtures(page,{personasUnavailable:true});await page.goto('/login');
  await page.getByLabel('비밀번호').fill(password);await page.getByRole('button',{name:'로그인',exact:true}).click();
  await expect(page.getByRole('heading',{name:'대화 공간',level:2})).toBeVisible();
  await expect(page.getByTestId('first-disclosure')).toHaveCount(0);
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('ptr-ai-disclosed:')))).toEqual([]);
  state.releasePersonas();await page.reload();
  await expect(page.getByTestId('first-disclosure')).toContainText('합성 캐릭터 1');
});

test('SYNTHETIC ONLY: older approved personas without card copy still have a one-line card and two safe starters',async({page})=>{
  await fixtures(page,{withoutCardCopy:true});await login(page);
  await expect(page.getByTestId('persona-card').locator('p')).toHaveCount(1);
  await expect(page.getByTestId('persona-card').locator('.starter-chip')).toHaveCount(2);
});

test('SYNTHETIC ONLY: English personas get English card and waiting fallbacks',async({page})=>{
  const state=await fixtures(page,{withoutCardCopy:true,englishPersonas:true,holdTurn:true});await login(page,'Synthetic Character 1');
  await expect(page.getByTestId('ai-marker')).toHaveText('AI character · not the real Synthetic Character 1');
  await expect(page.getByTestId('persona-card')).toContainText('What would you like to talk about?');
  await expect(page.getByRole('button',{name:'Hey, how was your day?'})).toBeVisible();
  await page.getByRole('button',{name:'새 대화 시작'}).click();
  await page.getByLabel('메시지',{exact:true}).fill('Hello');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.locator('.message.pending')).toContainText('Synthetic Character 1 is writing a reply…');
  state.releaseHold();
});

test('SYNTHETIC ONLY: rejected browser timezone falls back internally to UTC',async({page})=>{
  await page.addInitScript(()=>{const original=Intl.DateTimeFormat.prototype.resolvedOptions;Intl.DateTimeFormat.prototype.resolvedOptions=function(){return {...original.call(this),timeZone:'+09:00'};};});
  const state=await fixtures(page);await login(page);await newSession(page);
  expect(state.sessionBodies[0]!.timezone).toBe('UTC');
  await expectNoResearchCopy(page);
});

test('SYNTHETIC ONLY: waiting has two friendly stages, replies split at sentences, and return has a voice cue',async({page})=>{
  const state=await fixtures(page,{replyContent:'첫 문장이야. 둘째 문장이야! 셋째 문장이야?'});await login(page);await newSession(page);
  await page.getByLabel('메시지',{exact:true}).fill('오늘 어땠어?');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByText('합성 캐릭터 1이 답장 쓰는 중…')).toBeVisible();
  await expect(page.locator('.message.pending')).not.toContainText(/generating|retrieving|validating|pending/);
  await expect(page.locator('.message.assistant').filter({hasText:/첫 문장이야|둘째 문장이야|셋째 문장이야/})).toHaveCount(3);
  await expectNoResearchCopy(page);
  expect(state.sentBodies[0]).not.toHaveProperty('intent');
  await page.reload();await expect(page.getByTestId('last-preview')).toContainText('셋째 문장이야?');
  await expect(page.getByTestId('reentry-cue')).toBeVisible();
  expect(isVoiceText('reentry',await page.getByTestId('reentry-cue').innerText())).toBe(true);
  await page.getByLabel('메시지',{exact:true}).fill('다시 왔어');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByTestId('last-preview')).toHaveCount(0);
});

test('SYNTHETIC ONLY: pending and generating show only two friendly waiting stages',async({page})=>{
  const state=await fixtures(page,{holdTurn:true,initialState:'pending'});await login(page);await newSession(page);
  await page.getByLabel('메시지',{exact:true}).fill('안녕');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.locator('.message.pending')).toContainText('기다리는 중');
  await expect(page.locator('.message.pending')).not.toContainText(/pending|retrieving|generating|validating/);
  [...state.turns.values()][0]!.state='generating';
  await expect(page.locator('.message.pending')).toContainText('답장 만드는 중');
  await expect(page.locator('.message.pending')).toContainText('합성 캐릭터 1이 답장 쓰는 중…');
  state.releaseHold();await expect(page.getByText('합성 응답입니다.',{exact:true})).toBeVisible();
});

test('SYNTHETIC ONLY: errors have plain Korean copy and never show codes or retry internals',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);
  state.failOnce('QUEUE_FULL');await page.getByLabel('메시지',{exact:true}).fill('안녕');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByText('지금 대화가 몰려서 조금 뒤에 다시 보내 줘!')).toBeVisible();
  await expect(page.locator('.workspace')).not.toContainText(/QUEUE_FULL|요청 ID|과금|재전송|SYNTHETIC_/);
  await expectNoResearchCopy(page);
});

test('SYNTHETIC ONLY: old stored greeting prefix is hidden only in the rendered message',async({page})=>{
  const state=await fixtures(page,{oldGreeting:true});await login(page);await newSession(page);
  await expectNoResearchCopy(page);
  expect(state.histories.get('synthetic-session-1')?.[0]?.content).toBe('AI 연구용 시뮬레이션입니다. 안녕, 편하게 이야기해 줘.');
});

test('SYNTHETIC ONLY: five turns persist on reload and session mode stays pinned',async({page})=>{
  const {transport}=await fixtures(page,{operatorMode:true});await login(page);await newSession(page);
  await expect(page.getByTestId('ai-marker')).toBeVisible();
  for(let index=1;index<=5;index++){await page.getByLabel('메시지',{exact:true}).fill(`합성 메시지 ${index}`);await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.locator('.message.assistant').filter({hasText:'합성 응답입니다.'})).toHaveCount(index);}
  await page.getByLabel('새 세션의 RAG 조건').selectOption('caption');await page.getByLabel('검색 알고리즘').selectOption('lexical');await expect(page.getByTestId('session-mode')).toHaveText('본문만 · lexical');
  expect(transport.streams).toBeGreaterThan(0);expect(transport.progressPolls).toBe(0); // progress arrives by SSE, not polling
  await page.reload();await expect(page.getByText('합성 메시지 5',{exact:true})).toBeVisible();await expect(page.locator('.message.assistant').filter({hasText:'합성 응답입니다.'})).toHaveCount(5);
  await expect(page.getByTestId('session-mode')).toHaveText('본문만 · lexical');
});
test('SYNTHETIC ONLY: cancellation and failed transport reuse idempotency key',async({page})=>{
  const state=await fixtures(page,{holdTurn:true});await login(page);await newSession(page);
  await page.getByLabel('메시지',{exact:true}).fill('합성 취소 요청');await page.getByRole('button',{name:'보내기',exact:true}).click();await page.getByRole('button',{name:'답장 멈추기',exact:true}).click();await expect(page.getByText('답장을 멈췄어.',{exact:false})).toBeVisible();
  expect([...state.turns.values()][0]!.state).toBe('cancelled');state.releaseHold();
  state.abortOnce();await page.getByLabel('메시지',{exact:true}).fill('합성 네트워크 재확인');await page.getByRole('button',{name:'보내기',exact:true}).click();await page.getByRole('button',{name:'답장 확인하기'}).click();await expect(page.getByText('합성 응답입니다.',{exact:true})).toBeVisible();
  expect(state.sentBodies[1]!.clientRequestId).toBe(state.sentBodies[2]!.clientRequestId);expect(state.turns.size).toBe(2);
});
test('SYNTHETIC ONLY: explicit UTC filters hide evidence cards and preserve fictional draft boundary',async({page})=>{
  const state=await fixtures(page,{operatorMode:true});await login(page);await page.getByLabel('새 세션의 RAG 조건').selectOption('caption');await page.getByLabel('검색 알고리즘').selectOption('lexical');await newSession(page);
  await page.getByLabel('대화 종류').selectOption('timeline');await page.getByLabel('타임라인 검색어').fill('합성');await page.getByLabel('날짜 기준',{exact:true}).selectOption('posted');await page.getByLabel('시작일 포함',{exact:true}).fill('2026-01-01');await page.getByLabel('종료일 제외',{exact:true}).fill('2026-02-01');
  await page.getByLabel('메시지',{exact:true}).fill('합성 캡션 근거를 보여 주세요.');await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.getByText('그때 이야기를 들려줄게.',{exact:true})).toBeVisible();
  expect(state.sentBodies[0]!.timeline).toEqual({query:'합성',start:'2026-01-01',end:'2026-02-01',dateBasis:'posted',limit:5});await expect(page.locator('.source-card')).toHaveCount(0);await expect(page.getByRole('link',{name:'원본 링크 ↗'})).toHaveCount(0);
  await page.getByText('가상 포스트 초안 · 실제 활동 근거 아님',{exact:true}).click();await page.getByLabel('창작 브리프').fill('합성 창작 브리프');await page.getByRole('button',{name:'가상 초안 만들기',exact:true}).click();await expect(page.getByText('[가상 포스트 초안 · AI 생성]',{exact:false})).toBeVisible();await expect(page.getByText('External image 이미지: 별도 무료 runner',{exact:false})).toBeVisible();
});
test('real BFF boundary: HttpOnly signed cookie, origin restriction and fixed routes',async({page,request})=>{
  expect((await request.get('/api/proxy/personas',{headers:{'X-PTR-Owner':'forged-owner'}})).status()).toBe(403);
  expect((await request.post('/api/auth',{data:{password}})).status()).toBe(403);
  await fixtures(page);await login(page);
  const cookie=(await page.context().cookies()).find(value=>value.name==='ptr_owner')!;expect(cookie.httpOnly).toBe(true);expect(cookie.sameSite).toBe('Strict');expect(cookie.value).not.toContain(password);
  await page.unroute('**/api/proxy/**');
  expect((await page.request.delete('/api/proxy/sessions/synthetic-session/memories',{headers:{Origin:'https://untrusted.example'}})).status()).toBe(403);
  expect((await page.request.delete('/api/proxy/arbitrary/upstream',{headers:{Origin:'http://127.0.0.1:56448'}})).status()).toBe(404);
  const status=await page.evaluate(async()=>{const response=await fetch('/api/proxy/arbitrary/upstream');return response.status;});expect(status).toBe(404);
  expect(await page.evaluate(()=>document.cookie)).not.toContain('ptr_owner');
  await page.context().addCookies([{...cookie,value:cookie.value+'tampered'}]);
  const forged=await page.evaluate(async()=>(await fetch('/api/proxy/personas')).status);expect(forged).toBe(403);
  expect((await request.post('/api/auth',{headers:{Origin:'https://untrusted.example'},data:{password}})).status()).toBe(403);
});

test('SYNTHETIC ONLY: three condition controls persist without exposing image provenance',async({page})=>{
  await fixtures(page,{operatorMode:true});await login(page);
  for(const condition of ['off','caption','caption_image']){
    await page.getByLabel('새 세션의 RAG 조건').selectOption(condition);
    if(condition!=='off')await page.getByLabel('검색 알고리즘').selectOption('semantic');
    await newSession(page);
    await expect(page.getByTestId('session-mode')).toHaveText(condition==='off'?'RAG 없음':condition==='caption'?'본문만 · semantic':'본문 + 이미지 설명 · semantic');
  }
  await page.getByLabel('대화 종류').selectOption('timeline');
  await page.getByLabel('메시지',{exact:true}).fill('합성 이미지 설명을 보여 줘');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.locator('[data-evidence-origin="ai_image_annotation"]')).toHaveCount(0);
  await expect(page.getByText('AI 이미지 설명 · 검수되지 않은 파생 근거')).toHaveCount(0);
  await expect(page.getByText('synthetic-image-description / synthetic-v5')).toHaveCount(0);
  await page.reload();await expect(page.getByTestId('session-mode')).toHaveText('본문 + 이미지 설명 · semantic');
  await expect(page.locator('[data-evidence-origin="ai_image_annotation"]')).toHaveCount(0);
});

test('SYNTHETIC ONLY: a confirmed failed turn restores the message and retries with a new request ID',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);
  state.failOnce('WORKER_LOST');
  await page.getByLabel('메시지',{exact:true}).fill('합성 실패 후 다시 보내기');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByLabel('메시지',{exact:true})).toHaveValue('합성 실패 후 다시 보내기');
  await expect(page.getByRole('button',{name:'다시 보내기'})).toBeVisible();
  expect(state.sentBodies).toHaveLength(1);
  await page.getByRole('button',{name:'다시 보내기'}).click();
  await expect(page.getByText('합성 응답입니다.',{exact:true})).toBeVisible();
  expect(state.sentBodies).toHaveLength(2);
  expect(state.sentBodies[0]!.clientRequestId).not.toBe(state.sentBodies[1]!.clientRequestId);
  expect(state.sentBodies[1]!.text).toBe('합성 실패 후 다시 보내기');
});

test('SYNTHETIC ONLY: a failed SSE turn keeps the original text and retries with a new request ID',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);
  state.failOnStreamOnce('WORKER_LOST');
  await page.getByLabel('메시지',{exact:true}).fill('합성 SSE 실패');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByRole('button',{name:'다시 보내기'})).toBeVisible();
  await expect(page.getByLabel('메시지',{exact:true})).toHaveValue('합성 SSE 실패');
  expect(state.sentBodies).toHaveLength(1);
  await page.getByRole('button',{name:'다시 보내기'}).click();
  await expect(page.getByText('합성 응답입니다.',{exact:true})).toBeVisible();
  expect(state.sentBodies).toHaveLength(2);
  expect(state.sentBodies[0]!.clientRequestId).not.toBe(state.sentBodies[1]!.clientRequestId);
});


test('SYNTHETIC ONLY: operator controls start at caption and lexical, including after restoring an off session',async({page})=>{
  await fixtures(page,{operatorMode:true});await login(page);
  await page.getByLabel('새 세션의 RAG 조건').selectOption('caption');
  await expect(page.getByLabel('검색 알고리즘')).toHaveValue('lexical');
  await newSession(page);await expect(page.getByTestId('session-mode')).toHaveText('본문만 · lexical');
  await page.getByLabel('새 세션의 RAG 조건').selectOption('off');await newSession(page);
  await page.reload();await expect(page.getByTestId('session-mode')).toHaveText('RAG 없음');
  await page.getByLabel('새 세션의 RAG 조건').selectOption('caption_image');
  await expect(page.getByLabel('검색 알고리즘')).toHaveValue('lexical');
  await newSession(page);await expect(page.getByTestId('session-mode')).toHaveText('본문 + 이미지 설명 · lexical');
});

test('SYNTHETIC ONLY: unresolved provider submission shows safe notice, never auto-resends and next dialogue works',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);
  state.failOnce('PROVIDER_REQUEST_UNRESOLVED');
  await page.getByLabel('메시지',{exact:true}).fill('합성 실패 요청');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByText('답장이 아직 확인되지 않았어.',{exact:false})).toBeVisible();
  await expect(page.getByLabel('메시지',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'다시 보내기'})).toHaveCount(0);
  expect(state.sentBodies).toHaveLength(1);await page.waitForTimeout(800);expect(state.sentBodies).toHaveLength(1);
  await page.getByLabel('메시지',{exact:true}).fill('다른 합성 대화');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByText('합성 응답입니다.',{exact:true})).toBeVisible();
  expect(state.sentBodies).toHaveLength(2);expect(state.sentBodies[0].clientRequestId).not.toBe(state.sentBodies[1].clientRequestId);
});

test('SYNTHETIC ONLY: unresolved SSE result leaves the composer empty',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);
  state.failOnStreamOnce('PROVIDER_REQUEST_UNRESOLVED');
  await page.getByLabel('메시지',{exact:true}).fill('합성 미확정 SSE 요청');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByText('답장이 아직 확인되지 않았어.',{exact:false})).toBeVisible();
  await expect(page.getByLabel('메시지',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'다시 보내기'})).toHaveCount(0);
  expect(state.sentBodies).toHaveLength(1);
});

for(const kind of ['session','draft'] as const)for(const status of [200,503]) {
  test(`SYNTHETIC ONLY: delayed ${kind} ${status} after logout cannot revive owner cache, stale output or errors`,async({page})=>{
    await fixtures(page,{operatorMode:kind==='draft'});await login(page);if(kind==='draft'){await newSession(page);await page.getByText('가상 포스트 초안 · 실제 활동 근거 아님',{exact:true}).click();await page.getByLabel('창작 브리프').fill('합성 지연 브리프');}
    let releaseWrite!:()=>void;let releaseLogout!:()=>void;const writeGate=new Promise<void>(resolve=>{releaseWrite=resolve;});const logoutGate=new Promise<void>(resolve=>{releaseLogout=resolve;});let writes=0;let staleHistoryReads=0;
    page.on('request',request=>{if(request.method()==='GET'&&new URL(request.url()).pathname.includes('synthetic-stale-session'))staleHistoryReads++;});
    const pattern=kind==='session'?'**/api/proxy/sessions':'**/api/proxy/sessions/*/drafts';
    await page.route(pattern,async route=>{if(route.request().method()!=='POST'){await route.fallback();return;}writes++;await writeGate;await route.fulfill({status,json:status===503?{error:{code:'SYNTHETIC_LATE_ERROR'}}:kind==='session'?{session:{id:'synthetic-stale-session',personId:'synthetic-person-a',personaRevision:'synthetic-v1',retrievalMode:'off',ragCondition:'off',createdAt:'2026-01-01T00:00:00Z'}}:{artifact:{content:'synthetic stale draft must not render'},image:{code:'IMAGE_RUNNER_ONLY'}}});});
    // Hold logout's transport response so the real component remains mounted after owner invalidation.
    await page.route('**/api/auth',async route=>{if(route.request().method()!=='DELETE'){await route.fallback();return;}await logoutGate;await route.fulfill({json:{ok:true}});});
    const writeStarted=page.waitForRequest(request=>request.method()==='POST'&&(kind==='session'?new URL(request.url()).pathname==='/api/proxy/sessions':new URL(request.url()).pathname.endsWith('/drafts')));
    await page.getByRole('button',{name:kind==='session'?'새 대화 시작':'가상 초안 만들기',exact:true}).click();await writeStarted;
    const logoutStarted=page.waitForRequest(request=>request.method()==='DELETE'&&new URL(request.url()).pathname==='/api/auth');await page.getByRole('button',{name:'로그아웃',exact:true}).click();await logoutStarted;
    const writeFinished=page.waitForResponse(response=>response.request().method()==='POST'&&(kind==='session'?new URL(response.url()).pathname==='/api/proxy/sessions':new URL(response.url()).pathname.endsWith('/drafts')));releaseWrite();await writeFinished;await page.waitForTimeout(200);
    await expect(page.locator('.session-button')).toHaveCount(0);await expect(page.locator('.message')).toHaveCount(0);if(kind==='draft')await expect(page.getByLabel('창작 브리프')).toHaveCount(0);await expect(page.getByText('synthetic stale draft must not render')).toHaveCount(0);await expect(page.getByText('SYNTHETIC_LATE_ERROR',{exact:false})).toHaveCount(0);expect(staleHistoryReads).toBe(0);expect(writes).toBe(1);
    releaseLogout();await page.waitForURL('**/login');
  });
}

test('SYNTHETIC ONLY: terminal SSE plus failed history GET clears active lock, allows GET-only refresh and never resubmits generation',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);let failed=true;let historyReads=0;
  await page.route('**/api/proxy/sessions/*',async route=>{if(route.request().method()==='GET'&&/^\/api\/proxy\/sessions\/[^/]+$/.test(new URL(route.request().url()).pathname)){historyReads++;if(failed){await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_HISTORY_UNAVAILABLE'}}});return;}}await route.fallback();});
  await page.getByLabel('메시지',{exact:true}).fill('합성 마지막 상태');await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.locator('.error')).toContainText('잠깐 문제가 생겼어');await expect(page.locator('.workspace')).not.toContainText('SYNTHETIC_HISTORY_UNAVAILABLE');
  await expect(page.getByRole('button',{name:'답장 멈추기',exact:true})).toHaveCount(0);await expect(page.getByLabel('메시지',{exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'새 대화 시작'})).toBeEnabled();expect(state.sentBodies).toHaveLength(1);await page.waitForTimeout(500);expect(state.sentBodies).toHaveLength(1);
  failed=false;await page.getByRole('button',{name:'대화 내역 다시 확인'}).click();await expect(page.getByText('합성 응답입니다.',{exact:true})).toBeVisible();expect(historyReads).toBe(2);expect(state.sentBodies).toHaveLength(1);
});

test('SYNTHETIC ONLY: immediate terminal POST plus history failure offers GET recovery, never same-ID generation POST retry',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);let failed=true;let historyReads=0;
  await page.route('**/api/proxy/sessions/*',async route=>{if(route.request().method()==='GET'&&/^\/api\/proxy\/sessions\/[^/]+$/.test(new URL(route.request().url()).pathname)){historyReads++;if(failed){await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_HISTORY_UNAVAILABLE'}}});return;}}await route.fallback();});
  state.failOnce('PROVIDER_REQUEST_UNRESOLVED');await page.getByLabel('메시지',{exact:true}).fill('합성 즉시 종료 요청');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.locator('.error')).toContainText('잠깐 문제가 생겼어');await expect(page.locator('.workspace')).not.toContainText('SYNTHETIC_HISTORY_UNAVAILABLE');await expect(page.getByRole('button',{name:'답장 확인하기'})).toHaveCount(0);await expect(page.getByLabel('메시지',{exact:true})).toHaveValue('');await expect(page.getByText('답장이 아직 확인되지 않았어.',{exact:false})).toBeVisible();
  await page.waitForTimeout(500);expect(state.sentBodies).toHaveLength(1);failed=false;await page.getByRole('button',{name:'대화 내역 다시 확인'}).click();await expect(page.getByLabel('대화 내역').getByText('합성 즉시 종료 요청',{exact:true})).toBeVisible();expect(historyReads).toBe(2);expect(state.sentBodies).toHaveLength(1);
  await page.getByLabel('메시지',{exact:true}).fill('새로운 합성 대화');await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.getByText('합성 응답입니다.',{exact:true})).toBeVisible();expect(state.sentBodies).toHaveLength(2);expect(state.sentBodies[0]!.clientRequestId).not.toBe(state.sentBodies[1]!.clientRequestId);
});

for(const operatorMode of [false,true])test(`SYNTHETIC ONLY: mismatch notice is single and operator-only (${operatorMode})`,async({page})=>{
  await fixtures(page,{operatorMode,operatorNotice:'운영자 API 옵션이 꺼져 있어요. 설정을 확인해 주세요.'});await login(page);
  await expect(page.getByTestId('operator-notice')).toHaveCount(operatorMode?1:0);
  if(operatorMode){await newSession(page);await expect(page.getByTestId('operator-notice')).toHaveCount(1);}
});

test('SYNTHETIC ONLY: memory requires opt-in and confirms chat deletion',async({page})=>{
  await fixtures(page);let enabled=false;let memories=[{id:'memory-one',kind:'like',text:'합성 취미는 그림 그리기'}];let deleted=false;const writes:string[]=[];
  await page.route('**/api/proxy/sessions/*/memories**',async route=>{const path=new URL(route.request().url()).pathname;if(route.request().method()==='GET')await route.fulfill({json:{memories}});else {writes.push(path);memories=path.endsWith('/memories')?[]:memories.filter(item=>!path.endsWith('/'+item.id));await route.fulfill({json:{deleted:true}});}});
  await page.route('**/api/proxy/sessions/*/memory-consent',async route=>{enabled=route.request().postDataJSON().enabled;writes.push('consent');await route.fulfill({json:{session:{userMemoryConsent:enabled}}});});
  await page.route(/\/api\/proxy\/sessions\/synthetic-session-\d+$/,async route=>{if(route.request().method()!=='DELETE'){await route.fallback();return;}deleted=true;await route.fulfill({json:{deleted:true}});});
  await login(page);await newSession(page);
  await expect(page.getByRole('checkbox',{name:'대화 기억 허용'})).not.toBeChecked();expect(writes).toEqual([]);
  await expect(page.getByText('합성 캐릭터 1이 대화 내용을 기억해도 될까요?')).toBeVisible();
  await page.getByRole('checkbox',{name:'대화 기억 허용'}).click();await expect.poll(()=>enabled).toBe(true);await expect(page.getByRole('checkbox',{name:'대화 기억 허용'})).toBeChecked();
  await expect(page.getByText('합성 취미는 그림 그리기')).toBeVisible();
  await page.getByRole('button',{name:'이 기억 지우기'}).click();await expect(page.getByText('합성 취미는 그림 그리기')).toHaveCount(0);
  memories=[{id:'memory-two',kind:'like',text:'합성 취미는 산책하기'}];await page.reload();await expect(page.getByText('합성 취미는 산책하기')).toBeVisible();
  await page.getByRole('button',{name:'기억 전부 지우기'}).click();await expect(page.getByText('합성 취미는 산책하기')).toHaveCount(0);
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'대화 삭제',exact:true}).click();expect(deleted).toBe(false);
  page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'대화 삭제',exact:true}).click();await expect.poll(()=>deleted).toBe(true);
  await expect(page.getByText('안녕, 편하게 이야기해 줘.')).toHaveCount(0);
});
