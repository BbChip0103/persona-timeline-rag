import { expect, test, type Page } from '@playwright/test';
const password='synthetic-ui-password-only';
type Session={id:string;personId:string;personaRevision:string;retrievalMode:string;ragCondition?:string;createdAt:string};
type Message={id:string;turnId:string|null;role:string;content:string};
type Turn={id:string;sessionId:string;clientRequestId:string;userText:string;state:string;errorCode?:string;reply?:Record<string,unknown>};
async function fixtures(page:Page) {
  const sessions:Session[]=[];const histories=new Map<string,Message[]>();const turns=new Map<string,Turn>();const polls=new Map<string,number>();const transport={streams:0,progressPolls:0};const requestIds=new Map<string,Turn>();let counter=0;let abortNext=false;let failNext:string|undefined;let failOnStream:string|undefined;const sentBodies:Record<string,unknown>[]=[];
  await page.route('**/api/proxy/**',async route=>{
    const path=new URL(route.request().url()).pathname.slice('/api/proxy/'.length);const body=route.request().method()==='POST'?route.request().postDataJSON() as Record<string,unknown>:undefined;
    let value:unknown;
    if(path==='personas')value={personas:['a','b','c','d'].map((id,index)=>({id:'synthetic-persona-'+id,personId:'synthetic-person-'+id,label:`합성 페르소나 ${index+1}`,language:'ko',revision:'synthetic-v1',reviewStatus:'synthetic',aiDisclosure:'연구용 AI 시뮬레이션 · 비공식'}))};
    else if(path==='sessions'&&!body)value={sessions};
    else if(path==='sessions'&&body){const session={id:'synthetic-session-'+(++counter),personId:String(body.personId),personaRevision:'synthetic-v1',retrievalMode:String(body.retrievalMode),ragCondition:String(body.ragCondition),createdAt:'2026-01-01T00:00:00Z'};sessions.unshift(session);histories.set(session.id,[{id:'synthetic-greeting-'+counter,turnId:null,role:'assistant',content:'합성 연구 페르소나입니다. 편하게 이야기해 주세요.'}]);value={session};}
    else if(/^sessions\/[^/]+$/.test(path)){const id=path.split('/')[1]!;value={session:sessions.find(session=>session.id===id),history:histories.get(id)??[]};}
    else if(/^sessions\/[^/]+\/turns$/.test(path)&&body){sentBodies.push(body);const id=String(body.clientRequestId);let turn=requestIds.get(id);
      if(!turn){turn={id:'synthetic-turn-'+(++counter),sessionId:path.split('/')[1]!,clientRequestId:id,userText:String(body.text),state:'generating'};turns.set(turn.id,turn);requestIds.set(id,turn);histories.get(turn.sessionId)!.push({id:'synthetic-user-'+counter,turnId:turn.id,role:'user',content:turn.userText});}
      if(failNext){turn.state='failed';turn.errorCode=failNext;failNext=undefined;}
      value={turn};if(abortNext){abortNext=false;await route.abort('failed');return;}
    }
    else if(/^turns\/[^/]+\/cancel$/.test(path)){const turn=turns.get(path.split('/')[1]!)!;turn.state='cancelled';value={cancelled:true};}
    // Poll and SSE share the fixture: each poll or stream connection advances the turn once (completes on the second),
    // and a stream carries one snapshot then ends, like the API's max-duration close, so the client reconnects.
    else if(/^turns\/[^/]+(\/events)?$/.test(path)){const turn=turns.get(path.split('/')[1]!)!;if(path.endsWith('/events'))transport.streams++;else if(turn.state==='generating')transport.progressPolls++;/* reply reads after completion are not polling */const count=(polls.get(turn.id)??0)+1;polls.set(turn.id,count);
      if(turn.state==='generating'&&count>=2&&failOnStream){turn.state='failed';turn.errorCode=failOnStream;failOnStream=undefined;}
      if(turn.state==='generating'&&count>=2){turn.state='completed';const timeline=sentBodies.find(body=>body.clientRequestId===turn.clientRequestId)?.intent==='timeline';const image=sessions.find(item=>item.id===turn.sessionId)?.ragCondition==='caption_image';turn.reply={content:timeline?'캡션 원문: 합성 기록입니다.':'합성 응답입니다. 대화를 이어 가요.',status:'answered',evidence:timeline?[{...(image?{origin:'ai_image_annotation',annotationId:'synthetic-image-description',annotationRevision:'synthetic-v5',annotationHash:'a'.repeat(64),imageHash:'b'.repeat(64)}:{origin:'source_caption'}),sourceId:'synthetic-source',sourceUrl:'https://example.com/synthetic',postedAt:'2026-01-02T00:00:00Z',eventDate:null,quote:'합성 기록입니다.'},{sourceId:'synthetic-unsafe-url',sourceUrl:'javascript:alert(1)',postedAt:'2026-01-02T00:00:00Z',eventDate:'2026-01-01',quote:'안전한 텍스트만 표시합니다.'}]:[],limitations:timeline?['합성 테스트 캡션이며 실제 활동 근거가 아닙니다.']:[]};histories.get(turn.sessionId)!.push({id:'synthetic-assistant-'+turn.id,turnId:turn.id,role:'assistant',content:String(turn.reply.content)});}
      if(path.endsWith('/events')){await route.fulfill({status:200,headers:{'content-type':'text/event-stream; charset=utf-8'},body:`event: turn\ndata: ${JSON.stringify(turn)}\n\n`});return;}
      value={turn};
    }
    else if(/^sessions\/[^/]+\/drafts$/.test(path))value={artifact:{content:'[가상 포스트 초안 · AI 생성]\n합성 창작 초안입니다.'},image:{code:'IMAGE_RUNNER_ONLY'}};
    else {await route.fulfill({status:404,json:{error:{code:'NOT_FOUND'}}});return;}
    await route.fulfill({json:value});
  });
  return {transport,sentBodies,turns,abortOnce:()=>{abortNext=true;},failOnce:(code:string)=>{failNext=code;},failOnStreamOnce:(code:string)=>{failOnStream=code;}};
}
async function login(page:Page) {await page.goto('/login');await page.getByLabel('연구 공간 비밀번호').fill(password);const responsePromise=page.waitForResponse('**/api/auth');await page.getByRole('button',{name:'로그인',exact:true}).click();const response=await responsePromise;expect(response.status()).toBe(200);await expect(page.getByRole('heading',{name:'대화 공간'})).toBeVisible();await expect(page.getByLabel('연구 페르소나')).toContainText('합성 페르소나 1');}
async function newSession(page:Page) {await expect(page.getByLabel('연구 페르소나')).toContainText('합성 페르소나 1');await page.getByRole('button',{name:'새 대화 시작'}).click();await expect(page.getByText('합성 연구 페르소나입니다. 편하게 이야기해 주세요.').last()).toBeVisible();}

test('SYNTHETIC ONLY: five turns persist on reload and session mode stays pinned',async({page})=>{
  const {transport}=await fixtures(page);await login(page);await newSession(page);
  await expect(page.getByText('연구용 AI 시뮬레이션 · 비공식',{exact:true})).toBeVisible();
  for(let index=1;index<=5;index++){await page.getByLabel('메시지',{exact:true}).fill(`합성 메시지 ${index}`);await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.locator('.message.assistant').filter({hasText:'합성 응답입니다.'})).toHaveCount(index);}
  await page.getByLabel('새 세션의 RAG 조건').selectOption('caption');await page.getByLabel('검색 알고리즘').selectOption('lexical');await expect(page.getByTestId('session-mode')).toHaveText('RAG 없음');
  expect(transport.streams).toBeGreaterThan(0);expect(transport.progressPolls).toBe(0); // progress arrives by SSE, not polling
  await page.reload();await expect(page.getByText('합성 메시지 5',{exact:true})).toBeVisible();await expect(page.locator('.message.assistant').filter({hasText:'합성 응답입니다.'})).toHaveCount(5);
  await expect(page.getByTestId('session-mode')).toHaveText('RAG 없음');
});
test('SYNTHETIC ONLY: cancellation and failed transport reuse idempotency key',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);
  await page.getByLabel('메시지',{exact:true}).fill('합성 취소 요청');await page.getByRole('button',{name:'보내기',exact:true}).click();await page.getByRole('button',{name:'생성 취소',exact:true}).click();await expect(page.getByText('생성을 취소했습니다.',{exact:false})).toBeVisible();
  expect([...state.turns.values()][0]!.state).toBe('cancelled');
  state.abortOnce();await page.getByLabel('메시지',{exact:true}).fill('합성 네트워크 재확인');await page.getByRole('button',{name:'보내기',exact:true}).click();await page.getByRole('button',{name:'같은 요청 ID로 다시 확인'}).click();await expect(page.getByText('합성 응답입니다. 대화를 이어 가요.',{exact:true})).toBeVisible();
  expect(state.sentBodies[1]!.clientRequestId).toBe(state.sentBodies[2]!.clientRequestId);expect(state.turns.size).toBe(2);
});
test('SYNTHETIC ONLY: explicit UTC filters hide evidence cards and preserve fictional draft boundary',async({page})=>{
  const state=await fixtures(page);await login(page);await page.getByLabel('새 세션의 RAG 조건').selectOption('caption');await page.getByLabel('검색 알고리즘').selectOption('lexical');await newSession(page);
  await page.getByLabel('대화 종류').selectOption('timeline');await page.getByLabel('타임라인 검색어').fill('합성');await page.getByLabel('날짜 기준',{exact:true}).selectOption('posted');await page.getByLabel('시작일 포함',{exact:true}).fill('2026-01-01');await page.getByLabel('종료일 제외',{exact:true}).fill('2026-02-01');
  await page.getByLabel('메시지',{exact:true}).fill('합성 캡션 근거를 보여 주세요.');await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.getByText('캡션 원문: 합성 기록입니다.',{exact:true})).toBeVisible();
  expect(state.sentBodies[0]!.timeline).toEqual({query:'합성',start:'2026-01-01',end:'2026-02-01',dateBasis:'posted',limit:5});await expect(page.locator('.source-card')).toHaveCount(0);await expect(page.getByRole('link',{name:'원본 링크 ↗'})).toHaveCount(0);
  await page.getByText('가상 포스트 초안 · 실제 활동 근거 아님',{exact:true}).click();await page.getByLabel('창작 브리프').fill('합성 창작 브리프');await page.getByRole('button',{name:'가상 초안 만들기',exact:true}).click();await expect(page.getByText('[가상 포스트 초안 · AI 생성]',{exact:false})).toBeVisible();await expect(page.getByText('External image 이미지: 별도 무료 runner',{exact:false})).toBeVisible();
});
test('real BFF boundary: HttpOnly signed cookie, origin restriction and fixed routes',async({page,request})=>{
  expect((await request.get('/api/proxy/personas',{headers:{'X-PTR-Owner':'forged-owner'}})).status()).toBe(403);
  expect((await request.post('/api/auth',{data:{password}})).status()).toBe(403);
  await fixtures(page);await login(page);
  const cookie=(await page.context().cookies()).find(value=>value.name==='ptr_owner')!;expect(cookie.httpOnly).toBe(true);expect(cookie.sameSite).toBe('Strict');expect(cookie.value).not.toContain(password);
  await page.unroute('**/api/proxy/**');
  const status=await page.evaluate(async()=>{const response=await fetch('/api/proxy/arbitrary/upstream');return response.status;});expect(status).toBe(404);
  expect(await page.evaluate(()=>document.cookie)).not.toContain('ptr_owner');
  await page.context().addCookies([{...cookie,value:cookie.value+'tampered'}]);
  const forged=await page.evaluate(async()=>(await fetch('/api/proxy/personas')).status);expect(forged).toBe(403);
  expect((await request.post('/api/auth',{headers:{Origin:'https://untrusted.example'},data:{password}})).status()).toBe(403);
});

test('SYNTHETIC ONLY: three condition controls persist without exposing image provenance',async({page})=>{
  await fixtures(page);await login(page);
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
  await expect(page.getByText('합성 응답입니다. 대화를 이어 가요.',{exact:true})).toBeVisible();
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
  await expect(page.getByText('합성 응답입니다. 대화를 이어 가요.',{exact:true})).toBeVisible();
  expect(state.sentBodies).toHaveLength(2);
  expect(state.sentBodies[0]!.clientRequestId).not.toBe(state.sentBodies[1]!.clientRequestId);
});


test('SYNTHETIC ONLY: RAG defaults to semantic, including after restoring an off session',async({page})=>{
  await fixtures(page);await login(page);
  await page.getByLabel('새 세션의 RAG 조건').selectOption('caption');
  await expect(page.getByLabel('검색 알고리즘')).toHaveValue('semantic');
  await newSession(page);await expect(page.getByTestId('session-mode')).toHaveText('본문만 · semantic');
  await page.getByLabel('새 세션의 RAG 조건').selectOption('off');await newSession(page);
  await page.reload();await expect(page.getByTestId('session-mode')).toHaveText('RAG 없음');
  await page.getByLabel('새 세션의 RAG 조건').selectOption('caption_image');
  await expect(page.getByLabel('검색 알고리즘')).toHaveValue('semantic');
  await newSession(page);await expect(page.getByTestId('session-mode')).toHaveText('본문 + 이미지 설명 · semantic');
});

test('SYNTHETIC ONLY: unresolved provider submission shows safe notice, never auto-resends and next dialogue works',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);
  state.failOnce('PROVIDER_REQUEST_UNRESOLVED');
  await page.getByLabel('메시지',{exact:true}).fill('합성 실패 요청');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByText('이전 외부 요청의 처리 결과가 미확정이라',{exact:false})).toBeVisible();
  await expect(page.getByLabel('메시지',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'다시 보내기'})).toHaveCount(0);
  expect(state.sentBodies).toHaveLength(1);await page.waitForTimeout(800);expect(state.sentBodies).toHaveLength(1);
  await page.getByLabel('메시지',{exact:true}).fill('다른 합성 대화');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByText('합성 응답입니다. 대화를 이어 가요.',{exact:true})).toBeVisible();
  expect(state.sentBodies).toHaveLength(2);expect(state.sentBodies[0].clientRequestId).not.toBe(state.sentBodies[1].clientRequestId);
});

test('SYNTHETIC ONLY: unresolved SSE result leaves the composer empty',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);
  state.failOnStreamOnce('PROVIDER_REQUEST_UNRESOLVED');
  await page.getByLabel('메시지',{exact:true}).fill('합성 미확정 SSE 요청');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByText('이전 외부 요청의 처리 결과가 미확정이라',{exact:false})).toBeVisible();
  await expect(page.getByLabel('메시지',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'다시 보내기'})).toHaveCount(0);
  expect(state.sentBodies).toHaveLength(1);
});

for(const kind of ['session','draft'] as const)for(const status of [200,503]) {
  test(`SYNTHETIC ONLY: delayed ${kind} ${status} after logout cannot revive owner cache, stale output or errors`,async({page})=>{
    await fixtures(page);await login(page);if(kind==='draft'){await newSession(page);await page.getByText('가상 포스트 초안 · 실제 활동 근거 아님',{exact:true}).click();await page.getByLabel('창작 브리프').fill('합성 지연 브리프');}
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
    await expect(page.locator('.session-button')).toHaveCount(0);await expect(page.locator('.message')).toHaveCount(0);if(kind==='draft')await expect(page.getByLabel('창작 브리프')).toHaveValue('');await expect(page.getByText('synthetic stale draft must not render')).toHaveCount(0);await expect(page.getByText('SYNTHETIC_LATE_ERROR',{exact:false})).toHaveCount(0);expect(staleHistoryReads).toBe(0);expect(writes).toBe(1);
    releaseLogout();await page.waitForURL('**/login');
  });
}

test('SYNTHETIC ONLY: terminal SSE plus failed history GET clears active lock, allows GET-only refresh and never resubmits generation',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);let failed=true;let historyReads=0;
  await page.route('**/api/proxy/sessions/*',async route=>{if(route.request().method()==='GET'&&/^\/api\/proxy\/sessions\/[^/]+$/.test(new URL(route.request().url()).pathname)){historyReads++;if(failed){await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_HISTORY_UNAVAILABLE'}}});return;}}await route.fallback();});
  await page.getByLabel('메시지',{exact:true}).fill('합성 마지막 상태');await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.getByText('SYNTHETIC_HISTORY_UNAVAILABLE',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'생성 취소',exact:true})).toHaveCount(0);await expect(page.getByLabel('메시지',{exact:true})).toBeEnabled();await expect(page.getByRole('button',{name:'새 대화 시작'})).toBeEnabled();expect(state.sentBodies).toHaveLength(1);await page.waitForTimeout(500);expect(state.sentBodies).toHaveLength(1);
  failed=false;await page.getByRole('button',{name:'대화 내역 다시 확인'}).click();await expect(page.getByText('합성 응답입니다. 대화를 이어 가요.',{exact:true})).toBeVisible();expect(historyReads).toBe(2);expect(state.sentBodies).toHaveLength(1);
});

test('SYNTHETIC ONLY: immediate terminal POST plus history failure offers GET recovery, never same-ID generation POST retry',async({page})=>{
  const state=await fixtures(page);await login(page);await newSession(page);let failed=true;let historyReads=0;
  await page.route('**/api/proxy/sessions/*',async route=>{if(route.request().method()==='GET'&&/^\/api\/proxy\/sessions\/[^/]+$/.test(new URL(route.request().url()).pathname)){historyReads++;if(failed){await route.fulfill({status:503,json:{error:{code:'SYNTHETIC_HISTORY_UNAVAILABLE'}}});return;}}await route.fallback();});
  state.failOnce('PROVIDER_REQUEST_UNRESOLVED');await page.getByLabel('메시지',{exact:true}).fill('합성 즉시 종료 요청');await page.getByRole('button',{name:'보내기',exact:true}).click();
  await expect(page.getByText('SYNTHETIC_HISTORY_UNAVAILABLE',{exact:false})).toBeVisible();await expect(page.getByRole('button',{name:'같은 요청 ID로 다시 확인'})).toHaveCount(0);await expect(page.getByLabel('메시지',{exact:true})).toHaveValue('');await expect(page.getByText('이전 외부 요청의 처리 결과가 미확정이라',{exact:false})).toBeVisible();
  await page.waitForTimeout(500);expect(state.sentBodies).toHaveLength(1);failed=false;await page.getByRole('button',{name:'대화 내역 다시 확인'}).click();await expect(page.getByLabel('대화 내역').getByText('합성 즉시 종료 요청',{exact:true})).toBeVisible();expect(historyReads).toBe(2);expect(state.sentBodies).toHaveLength(1);
  await page.getByLabel('메시지',{exact:true}).fill('새로운 합성 대화');await page.getByRole('button',{name:'보내기',exact:true}).click();await expect(page.getByText('합성 응답입니다. 대화를 이어 가요.',{exact:true})).toBeVisible();expect(state.sentBodies).toHaveLength(2);expect(state.sentBodies[0]!.clientRequestId).not.toBe(state.sentBodies[1]!.clientRequestId);
});
