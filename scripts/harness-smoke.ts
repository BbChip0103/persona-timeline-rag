import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Persona, SourcePost } from '@ptr/contracts';
import { createHarnessRuntime, writePrivateReport, type TurnTrace } from './evaluate';

export async function runSmoke(env:NodeJS.ProcessEnv):Promise<{executionMode:'fake';checks:number;offCalls:{retrieval:number;embedding:number};textCalls:number}> {
  // Smoke is deliberately always fake, even if the surrounding environment enables live.
  const runtime=createHarnessRuntime(env,false);
  const suffix=randomUUID(),personId=`synthetic-smoke-${suffix}`,owner=`smoke-owner-${suffix}`;
  const persona:Persona={id:`persona-${suffix}`,personId,revision:'synthetic-smoke-v1',label:'Synthetic fixture',language:'ko',reviewStatus:'synthetic',
    identity:'A fictional test fixture',concept:'Synthetic smoke only',style:['friendly'],boundaries:['No actual activity claims'],sourceRefs:[],greeting:'합성 테스트에 오신 것을 환영해요.'};
  const post:SourcePost={id:`source-${suffix}`,personId,caption:'합성 캡션: 파란 책과 산책 기록.',postedAt:'2024-01-01T00:00:00Z',eventDate:null,
    sourceUrl:'https://example.com/synthetic-fixture',snapshot:'synthetic-smoke-snapshot',hash:`synthetic-${suffix}`,unsafe:false};
  function trace(id:string,mode:'off'|'lexical'|'semantic'):TurnTrace {
    return {id,stage:'smoke',mode,historyKind:'single',personId,goldSourceIds:[],retrievedIds:[],promptHashes:[],latencyMs:0,state:'pending',status:null,
      errors:[],textCalls:0,embeddingCalls:0,retrievalCalls:0,requests:[],sourceRecallAt5:null,validQuotes:0,totalQuotes:0,crossPersonEvidence:0,statusSurrogateMatch:null};
  }
  let checks=0,textCalls=0;
  const offCalls={retrieval:0,embedding:0};
  try {
    await runtime.personas.importPersona(persona);await runtime.sources.importPosts([post],'synthetic_fixture');await runtime.indexFake([post]);
    for(const mode of ['off','lexical','semantic'] as const) {
      const session=await runtime.chat.createSession(owner,{personId,personaId:persona.id,personaRevision:persona.revision,timezone:'UTC',retrievalMode:mode});
      const factual=trace(`factual-${mode}`,mode);runtime.setTrace(factual);
      const input={sessionId:session.id,clientRequestId:`factual-${mode}`,text:'2024년 게시 캡션을 보여 주세요.',intent:'timeline' as const,
        timeline:{query:'파란 책',start:'2024-01-01',end:'2024-01-02',dateBasis:'posted' as const,limit:5}};
      const turn=await runtime.chat.sendTurn(owner,input);assert.equal(turn.state,'completed');checks++;
      assert.equal(turn.reply?.status,mode==='off'?'insufficient_evidence':'answered');checks++;
      if(mode==='off') {
        assert.equal(factual.retrievalCalls,0);assert.equal(factual.embeddingCalls,0);checks+=2;
        offCalls.retrieval=factual.retrievalCalls;offCalls.embedding=factual.embeddingCalls;
      } else {assert.equal(turn.reply?.evidence[0]?.sourceId,post.id);checks++;}
      assert.equal((await runtime.chat.sendTurn(owner,input)).id,turn.id);checks++;
      await assert.rejects(runtime.chat.sendTurn(owner,{...input,text:'different synthetic request'}),error=>!!error&&typeof error==='object'&&'code' in error&&error.code==='IDEMPOTENCY_CONFLICT');checks++;
      await assert.rejects(runtime.chat.history('wrong-owner',session.id));checks++;
      const smalltalk=trace(`smalltalk-${mode}`,mode);runtime.setTrace(smalltalk);
      const friendly=await runtime.chat.sendTurn(owner,{sessionId:session.id,clientRequestId:`friendly-${mode}`,text:'안녕! 편하게 대화해요.',intent:'small_talk'});
      assert.equal(friendly.state,'completed');assert.equal(friendly.reply?.responseKind,'small_talk');checks+=2;
      assert.equal((await runtime.chat.history(owner,session.id)).length,5);checks++;
      textCalls+=factual.textCalls+smalltalk.textCalls;
    }
    runtime.setTrace(undefined);
    return {executionMode:'fake',checks,offCalls,textCalls};
  } finally {await runtime.close();}
}
async function main():Promise<void> {
  if(process.argv.slice(2).length) throw new Error('Smoke accepts no live flag');
  await writePrivateReport(await runSmoke(process.env),'synthetic-smoke');
  console.log('Synthetic SQL smoke passed; private report saved under reports/goal1.');
}
if(require.main===module) void main().catch(()=>{console.error('Synthetic SQL smoke failed; no private input or credentials are printed.');process.exitCode=1;});
