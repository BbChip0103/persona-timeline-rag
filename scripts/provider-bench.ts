/**
 * Provider-call latency for the same app-shaped synthetic prompt across
 * OpenRouter (API baseline) and self-hosted engines reached through an SSH tunnel.
 *
 *   pnpm exec tsx scripts/provider-bench.ts openrouter --levels=1,4,8 --requests=12 --max-usd=0.25
 *   pnpm exec tsx scripts/provider-bench.ts selfhosted --base-url=http://127.0.0.1:18000/v1 --model=gemma-4-e4b --levels=1,4,8,16
 *
 * Synthetic prompts only. OpenRouter calls reserve/settle in the shared research-DB ledger (US$2 cap)
 * and this run stops before exceeding --max-usd. Each request carries a nonce so the ledger's
 * response cache can never replay a previous answer as a "fast" call.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderMessage } from '@ptr/contracts';
import type { TextProvider } from '@ptr/core';
import { createLocalPool } from '@ptr/storage';
import { OpenAICompatibleTextProvider, OpenRouterClient, PostgresBudgetLedger, liveOptionsFromEnvironment, type CallMetrics } from '@ptr/providers';
import { percentile } from './loadtest-lib';

// ~1.3k-token synthetic persona context, matching Goal1 live prompt p50 (1165 tokens).
const PERSONA=['너는 연구용 AI 캐릭터 \'하루\'다. 합성 페르소나: 20대 카페 바리스타, 밝고 장난스러운 반말, 커피와 산책을 좋아함. 실존 인물이 아니다.',
  ...Array.from({length:24},(_,i)=>`합성 기록 ${i+1}: 오늘은 ${['라떼아트 연습','새 원두 시음','공원 산책','손님과의 대화','비 오는 오후','주말 시장 구경'][i%6]}을 했고, 짧은 메모를 남겼다. 이 기록은 부하 테스트용 가상 자료다.`),
  '반드시 JSON 한 개만 출력한다: {"message": 캐릭터의 한국어 대답(1~3문장), "mood": 한 단어}. AGENT_JSON_REPLY'].join('\n');
const QUESTIONS=['안녕! 오늘 뭐 했어?','요즘 제일 좋아하는 커피 메뉴 추천해줘','비 오는 날엔 주로 뭐 해?','라떼아트 하다가 망한 적 있어?','산책 코스 하나만 알려줘','주말 계획 있어?'];
function messages(i:number):ProviderMessage[] {
  return [{role:'system',content:PERSONA},{role:'user',content:`${QUESTIONS[i%QUESTIONS.length]} (요청 ${randomUUID().slice(0,8)})`}];
}
function args():Record<string,string> {
  return Object.fromEntries(process.argv.slice(3).map(arg=>{const [key,...rest]=arg.replace(/^--/,'').split('=');return [key!,rest.join('=')];}));
}
const microusd=(value:unknown)=>Number(value??0);

async function main():Promise<void> {
  const target=process.argv[2];const options=args();
  const levels=(options.levels??'1,4,8').split(',').map(Number);const perLevel=Number(options.requests??12);
  const metrics:(CallMetrics&{level:number})[]=[];let level=0;
  let provider:TextProvider;let spend:(()=>Promise<number>)|undefined;let close=async()=>{};
  if(target==='openrouter') {
    const databaseUrl=process.env.DATABASE_URL??'';
    const pool=createLocalPool(databaseUrl);close=()=>pool.end();
    if(new URL(databaseUrl).pathname!=='/ptr_research') throw new Error('Live calls must use the shared research ledger');
    const ledger=new PostgresBudgetLedger(pool,databaseUrl);
    const client=new OpenRouterClient({...liveOptionsFromEnvironment({...process.env,GOAL1_DATABASE_URL:databaseUrl},ledger),maxOutputTokens:256});
    const started=new Date();
    // Spend attributed to this run: everything reserved/settled in the shared ledger since it began.
    spend=async()=>{const row=(await pool.query(`SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual_microusd ELSE GREATEST(reserved_microusd,COALESCE(actual_microusd,0)) END),0) AS m
      FROM ptr_provider_requests WHERE created_at >= $1`,[started])).rows[0];return microusd(row.m)/1e6;};
    provider={generate:async(m,o)=>{
      const t0=performance.now();
      try {const text=await client.generate(m,o);metrics.push({model:'openrouter/google/gemini-3-flash-preview',ok:true,ttftMs:null,totalMs:Math.round(performance.now()-t0),promptTokens:null,completionTokens:null,attempts:1,level});return text;}
      catch(error) {metrics.push({model:'openrouter',ok:false,error:error instanceof Error?error.message:'error',ttftMs:null,totalMs:Math.round(performance.now()-t0),promptTokens:null,completionTokens:null,attempts:1,level});throw error;}
    }};
  } else if(target==='selfhosted') {
    provider=new OpenAICompatibleTextProvider({baseUrl:options['base-url']??'http://127.0.0.1:18000/v1',model:options.model??'gemma-4-e4b',
      maxOutputTokens:256,timeoutMs:60000,onMetrics:m=>metrics.push({...m,level})});
  } else throw new Error('target must be openrouter or selfhosted');
  const maxUsd=Number(options['max-usd']??0.25);
  const results=[];
  try {
    for(level of levels) {
      if(spend && await spend()>=maxUsd) {results.push({level,skipped:'RUN_BUDGET_REACHED'});break;}
      const started=performance.now();let next=0;
      await Promise.all(Array.from({length:level},async()=>{
        while(next<perLevel){const i=next++;await provider.generate(messages(i),{signal:new AbortController().signal}).catch(()=>undefined);}
      }));
      const wall=(performance.now()-started)/1000;
      const rows=metrics.filter(m=>m.level===level);const ok=rows.filter(m=>m.ok);
      const totals=ok.map(m=>m.totalMs), ttfts=ok.flatMap(m=>m.ttftMs===null?[]:[m.ttftMs]);
      const summary={level,requests:rows.length,ok:ok.length,errors:Object.fromEntries([...new Set(rows.filter(m=>!m.ok).map(m=>m.error))].map(e=>[e,rows.filter(m=>m.error===e).length])),
        reqPerSecond:+(ok.length/wall).toFixed(2),totalMs:{p50:percentile(totals,50),p95:percentile(totals,95)},ttftMs:{p50:percentile(ttfts,50),p95:percentile(ttfts,95)},
        completionTokensMean:ok.length?+(ok.reduce((s,m)=>s+(m.completionTokens??0),0)/ok.length).toFixed(1):null,
        ...(spend?{runSpendUsd:+(await spend()).toFixed(6)}:{})};
      results.push(summary);console.log(JSON.stringify(summary));
    }
  } finally {await close();}
  const directory=join('reports','provider-bench');await mkdir(directory,{recursive:true,mode:0o700});
  const file=join(directory,`${new Date().toISOString().replace(/[:.]/g,'-')}-${target}-${options.model??'gemini-3-flash-preview'}.json`);
  await writeFile(file,JSON.stringify({target,model:options.model??'google/gemini-3-flash-preview',levels,perLevel,results,calls:metrics},null,1),{mode:0o600});
  console.log(`report: ${file}`);
}
void main().catch(error=>{console.error('provider bench failed:',error instanceof Error?error.message:'unknown');process.exitCode=1;});
