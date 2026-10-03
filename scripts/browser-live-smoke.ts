import { chromium, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { Persona } from '@ptr/contracts';
import { privateJson } from './prepare-research';
/** Actual local UI/BFF/API check. No raw chat/screenshot/networktrace exports. */
async function main():Promise<void>{
  if(process.env.GOAL1_LIVE_ENABLED!=='true'||!process.env.PTR_UI_PASSWORD)throw new Error('Live UI disabled');
  const personas=JSON.parse(await readFile('data/research/personas.json','utf8')) as Persona[];
  const browser=await chromium.launch({headless:true});const context=await browser.newContext();const page=await context.newPage();
  const checks:unknown[]=[];
  try{
    await page.goto('http://127.0.0.1:56440/login');await page.getByLabel('연구 공간 비밀번호').fill(process.env.PTR_UI_PASSWORD);
    await page.getByRole('button',{name:'로그인',exact:true}).click();await expect(page.getByLabel('연구 페르소나')).toBeVisible({timeout:15000});
    await expect(page.locator('#persona option')).toHaveCount(4);
    const cookies=await context.cookies();if(!cookies.some(cookie=>cookie.httpOnly&&cookie.sameSite==='Strict'))throw new Error('Private session cookie missing');
    for(const p of personas){
      await page.getByLabel('연구 페르소나').selectOption(p.personId);await page.getByLabel('새 세션의 검색 방식').selectOption('off');
      await page.getByRole('button',{name:'새 대화 시작',exact:true}).click();await expect(page.locator('.message.assistant')).toHaveCount(1);
      const texts=p.language==='ko'?['안녕! 이 대화에서 내 별명은 Blue야.','가상의 편안한 아침 아이디어를 추천해줘.','이 대화에서 내 별명이 뭐였지?','분위기 좋은 가상 포스트 아이디어 하나만 더.','고마워. 이 연구 대화는 실제 인물이 아니지?']:['Hello! My nickname in this conversation is Blue.','Suggest a fictional relaxing morning idea.','What nickname did I give in this conversation?','Suggest one more imaginary creative post idea.','Thank you. This is an AI research conversation, not the real person, right?'];
      const began=Date.now();
      for(const [index,text] of texts.entries()){
        await page.getByLabel('메시지').fill(text);await page.getByRole('button',{name:'보내기',exact:true}).click();
        await expect(page.locator('.message.assistant:not(.pending)')).toHaveCount(index+2,{timeout:45000});
        await expect(page.getByRole('button',{name:'보내기',exact:true})).toBeEnabled({timeout:5000});
        if(await page.locator('[role=alert]').count())throw new Error('UI returned a sanitized error');
      }
      await page.reload();await expect(page.locator('.message.assistant:not(.pending)')).toHaveCount(6,{timeout:15000});
      await expect(page.locator('.message.user')).toHaveCount(5);
      checks.push({personId:p.personId,revision:p.revision,turns:5,reload:true,mode:'off',latencyMs:Date.now()-began});
      await privateJson('reports/browser-live-smoke.json',{execution:'live',interface:'browser -> BFF -> Nest -> shared core -> OpenRouter',checks,humanReview:'pending',screenshots:false});
    }
    console.log(JSON.stringify({actualPersonas:4,completedUserTurns:20,reloadChecks:4,execution:'live'}));
  }finally{await context.close();await browser.close();}
}
if(require.main===module)void main().catch(()=>{console.error('Private live browser smoke failed; no raw content or credentials exported.');process.exitCode=1;});
