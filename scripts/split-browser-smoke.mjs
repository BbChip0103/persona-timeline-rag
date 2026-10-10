// Actual BFF/Nest/Python/PG/Redis: no route interception or mocked browser responses.
import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch({headless:true});
const page = await browser.newPage();
const gates = {};
try {
  await page.goto('http://127.0.0.1:56448/login');
  await page.getByLabel('연구 공간 비밀번호').fill('synthetic-ui-password-only');
  await page.getByRole('button',{name:'로그인',exact:true}).click();
  await expect(page.getByRole('heading',{name:'대화 공간'})).toBeVisible();
  gates.real_browser_login=true;
  const cookie=(await page.context().cookies()).find(c=>c.name==='ptr_owner');
  gates.real_cookie_boundary=!!cookie?.httpOnly && cookie.sameSite==='Strict' && !(await page.evaluate(()=>document.cookie)).includes('ptr_owner');
  await expect(page.getByLabel('연구 페르소나')).toContainText('Synthetic');
  await page.getByRole('button',{name:'새 대화 시작'}).click();
  let lastReply='';
  for(let i=1;i<=2;i++) {
    await page.getByLabel('메시지',{exact:true}).fill('합성 브라우저 메시지 '+i);
    const created=page.waitForResponse(r=>/\/api\/proxy\/sessions\/[^/]+\/turns$/.test(r.url())&&r.request().method()==='POST');
    await page.getByRole('button',{name:'보내기',exact:true}).click();
    const turn=(await (await created).json()).turn;
    await expect.poll(async()=>page.evaluate(async id=>(await (await fetch('/api/proxy/turns/'+id)).json()).turn.state,turn.id),{timeout:20000}).toBe('completed');
    const final=await page.evaluate(async id=>(await (await fetch('/api/proxy/turns/'+id)).json()).turn,turn.id);
    lastReply=final.reply.content;
    expect(lastReply.length).toBeGreaterThan(0);
    await expect(page.locator('.message.assistant').last()).toContainText(lastReply);
    await expect(page.locator('.message.assistant')).toHaveCount(i+1);

  }
  gates.real_browser_two_turns=true;
  await page.reload();
  await expect(page.getByText('합성 브라우저 메시지 2',{exact:true})).toBeVisible();
  await expect(page.locator('.message.assistant')).toHaveCount(3);
  await expect(page.locator('.message.assistant').last()).toContainText(lastReply);
  gates.real_browser_reload=true;
  gates.real_bff_fixed_routes=(await page.evaluate(async()=>(await fetch('/api/proxy/arbitrary/upstream')).status))===404;
  await page.getByText('가상 포스트 초안 · 실제 활동 근거 아님',{exact:true}).click();
  await page.getByLabel('창작 브리프').fill('가상의 독서 포스트');
  await page.getByRole('button',{name:'가상 초안 만들기',exact:true}).click();
  await expect(page.getByText('[가상 포스트 초안 · AI 생성]',{exact:false})).toBeVisible({timeout:20000});
  gates.real_browser_draft=true;
  process.stdout.write(JSON.stringify(gates));
} finally {await browser.close();}
