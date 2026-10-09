/**
 * Speed and cost of Jev decisions, Gemma 4 26B-A4B via OpenRouter and self-hosted Gemma 4 26B-A4B (vLLM NVFP4) on the
 * same app-built workload.
 *
 *   capture:    GOAL1_LIVE_ENABLED=true node --env-file=.env.local --import tsx scripts/bench-jev-gemma.ts capture --live --data-root=<checkout> --max-usd=0.10
 *   openrouter: ... bench-jev-gemma.ts openrouter --live --workload=<dir> --max-usd=0.30
 *   jev:        ... bench-jev-gemma.ts jev --live --workload=<dir> --max-usd=0.05
 *   selfhosted: ... bench-jev-gemma.ts selfhosted --workload=<dir> --base-url=http://127.0.0.1:18000/v1 --model=gemma-4-26b-a4b-nvfp4
 *   verify:     ... bench-jev-gemma.ts verify --workload=<dir>   (rebuilt bodies == app ledger keys)
 *   sweep:      ... bench-jev-gemma.ts sweep --workload=<dir> --model=<served name> --levels=4,8,16 --duration=60 --out=<dir>
 *   report:     ... bench-jev-gemma.ts report --workload=<dir> --gpu-usd-per-hour=0.78
 *
 * capture runs the Jev-on arm of evaluate-jev-e2e (in-memory conversations, research DB read-only, caption_image RAG,
 * agent_loop agent) and records every agent prompt and Jev decision request the app built; replays come from the ledger.
 * The benches then send the selected bodies unchanged except for transport: OpenRouter Gemma gets the app's body with
 * stream:true + include_usage; self-hosted goes through the app's own OpenAICompatibleTextProvider (structured agent
 * replies on). Every OpenRouter call reserves and settles a unique key in the shared research ledger. Outputs are private.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderMessage } from '@ptr/contracts';
import { AGENT_RESPONSE_JSON_SCHEMA, createLocalChat, InMemoryConversationStore, parseAgentResponse, type Retrieval, type TextProvider } from '@ptr/core';
import { EMBEDDING_MODEL, JevIntentClassifier, OpenAICompatibleTextProvider, OpenRouterClient, PostgresBudgetLedger, ProviderError, liveOptionsFromEnvironment, type BudgetLedger } from '@ptr/providers';
import { createLocalPool, PostgresPersonaRepository, PostgresRetrieval, PostgresSourceRepository } from '@ptr/storage';
import { validateUserExport } from './evaluate-character-chat';
import { percentile } from './loadtest-lib';
import type { ChatTestset } from './prepare-character-chat-testset';

const CHAT_MODEL='google/gemma-4-26b-a4b-it';
const JEV_MODEL='typesafe/jev-1.13';
const PRICE={prompt:0.09,completion:0.3,jevPrompt:0.05};
const MAX_TOKENS=512;
const LEVELS=[1,8,32];
const SAMPLE=48;
type Json=Record<string,unknown>;
export interface ChatCall { id:string; conversationId:string; turnIndex:number; iteration:number; language:string; category:string; bytes:number; messages:ProviderMessage[] }
export interface DecisionCall { id:string; conversationId:string; turnIndex:number; language:string; bytes:number; request:{model:string;state:Json;questions:Json} }
interface Workload { createdAt:string; testsetRevision:string; turns:number; chatCalls:number; decisionCalls:number; chat:ChatCall[]; decisions:DecisionCall[]; selected:{chat:string[];decisions:string[];decisionsFromSameTurns:number}; capture:Json }
export interface Sample { level:number; index:number; id:string; ok:boolean; error?:string; schemaValid:boolean; ttftMs:number|null; totalMs:number;
  promptTokens:number|null; completionTokens:number|null; cachedTokens?:number|null; costMicrousd?:number|null; provider?:string }

function args():Record<string,string> {
  return Object.fromEntries(process.argv.slice(3).map(arg=>{const [key,...rest]=arg.replace(/^--/,'').split('=');return [key!,rest.join('=')||'true'];}));
}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesOf=(value:unknown)=>Buffer.byteLength(JSON.stringify(value),'utf8');

/** 2 languages x 3 size tertiles, evenly spaced inside each cell; short cells are topped up from the rest so the total stays `count`. */
export function selectStratified<T extends {id:string;language:string;bytes:number}>(items:T[],count:number):T[] {
  const sorted=[...items].sort((a,b)=>a.bytes-b.bytes||a.id.localeCompare(b.id));
  const size=(item:T)=>Math.min(2,Math.floor(3*sorted.indexOf(item)/sorted.length));
  const languages=[...new Set(sorted.map(item=>item.language))].sort();
  const cells=languages.flatMap(language=>[0,1,2].map(tier=>sorted.filter(item=>item.language===language&&size(item)===tier)));
  const per=Math.floor(count/Math.max(1,cells.length));
  const picked=new Set<T>();
  for(const cell of cells) for(let i=0;i<Math.min(per,cell.length);i++) picked.add(cell[Math.floor((i+0.5)*cell.length/Math.min(per,cell.length))]!);
  for(const item of sorted) {if(picked.size>=count) break;picked.add(item);}
  return [...picked].slice(0,count);
}
/** Self-hosted cost: an always-on GPU at `utilisation` of the measured throughput. */
export function gpuUsdPerRequest(usdPerHour:number,requestsPerSecond:number,utilisation=1):number {
  if(!(requestsPerSecond>0)||!(utilisation>0)) return Number.NaN;
  return usdPerHour/3600/(requestsPerSecond*utilisation);
}

async function budgetSnapshot(pool:ReturnType<typeof createLocalPool>) {
  const row=(await pool.query(`SELECT count(*)::int calls,COALESCE(sum(actual_microusd) FILTER(WHERE state='settled'),0)::bigint settled,
    COALESCE(sum(GREATEST(reserved_microusd,COALESCE(actual_microusd,0))) FILTER(WHERE state<>'settled'),0)::bigint unresolved FROM ptr_provider_requests`)).rows[0] as Record<string,string|number>;
  return {calls:Number(row.calls),settledMicrousd:Number(row.settled),unresolvedMicrousd:Number(row.unresolved)};
}
function researchPool() {
  const databaseUrl=process.env.DATABASE_URL??'';
  if(new URL(databaseUrl).pathname!=='/ptr_research') throw new Error('Live calls must use the shared research ledger');
  return {databaseUrl,pool:createLocalPool(databaseUrl)};
}
function requireLive(options:Record<string,string>) {
  if(options.live!=='true'||process.env.GOAL1_LIVE_ENABLED!=='true') throw new Error('Explicit --live and GOAL1_LIVE_ENABLED=true required');
}

async function capture(options:Record<string,string>):Promise<void> {
  requireLive(options);
  const maxUsd=Number(options['max-usd']??0.1);
  const root=options['data-root']??'.';
  const pointer=JSON.parse(await readFile(join(root,'data/research/character-chat-testset.latest.json'),'utf8')) as {directory:string;revision:string};
  if(pointer.directory!==`data/research/character-chat-testsets/${pointer.revision}`||!/^[a-f0-9]{64}$/.test(pointer.revision)) throw new Error('Unsafe testset pointer');
  const evaluator=JSON.parse(await readFile(join(root,pointer.directory,'evaluator.json'),'utf8')) as ChatTestset;
  validateUserExport(evaluator,JSON.parse(await readFile(join(root,pointer.directory,'user.json'),'utf8')));
  if(evaluator.revision!==pointer.revision||evaluator.conversations.length!==32) throw new Error('Unexpected test set');
  const {databaseUrl,pool}=researchPool();
  try {
    const before=await budgetSnapshot(pool);
    const base=new PostgresBudgetLedger(pool,databaseUrl);const open=new Set<string>();
    const run={created:0,replayed:0,settledMicrousd:0,unknownMicrousd:0,capReached:false};
    const ledger:BudgetLedger={
      async reserve(key,amount) {
        if(run.settledMicrousd+run.unknownMicrousd+amount>maxUsd*1e6) {run.capReached=true;throw new ProviderError('BUDGET_EXCEEDED');}
        const saved=await base.reserve(key,amount);
        if(saved.created){run.created++;run.unknownMicrousd+=amount;open.add(key);} else run.replayed++;
        return saved;
      },
      submitted:key=>base.submitted(key),get:key=>base.get(key),
      async finish(key,cost,response,generationId) {
        await base.finish(key,cost,response,generationId);
        if(!open.delete(key)) return;
        const reserved=(await base.get(key))?.reservedMicrousd??0;
        if(cost!==null){run.unknownMicrousd-=reserved;run.settledMicrousd+=cost;}
      },
    };
    // Fidelity check: every body that reaches the network must equal the body this bench rebuilds from the messages.
    const seenBodies:Json[]=[];
    const recordingFetch:typeof fetch=async(url,init)=>{
      if(String(url).endsWith('/chat/completions')&&typeof init?.body==='string') seenBodies.push(JSON.parse(init.body) as Json);
      return fetch(url,init);
    };
    const client=new OpenRouterClient({...liveOptionsFromEnvironment({...process.env,GOAL1_DATABASE_URL:databaseUrl,GOAL1_TEXT_MODEL:CHAT_MODEL},ledger),fetch:recordingFetch});
    let current={conversationId:'',turnIndex:0,iteration:0,language:'',category:''};
    const chatCalls:ChatCall[]=[];const decisions:DecisionCall[]=[];
    const provider:TextProvider={generate:(messages,o)=>{
      chatCalls.push({id:`c${chatCalls.length}`,...current,bytes:bytesOf(messages),messages:messages.map(({role,content})=>({role,content}))});current.iteration++;
      return client.generate(messages,o);
    }};
    const personas=new PostgresPersonaRepository(pool);const sources=new PostgresSourceRepository(pool);
    const retrieval=new PostgresRetrieval(sources,{modelRevision:EMBEDDING_MODEL,embed:(text,o)=>client.embed([text],o).then(vectors=>vectors[0]!)});
    const tracked:Retrieval={search:(...a)=>retrieval.search(...a),resolve:(...a)=>retrieval.resolve(...a)};
    const jev=new JevIntentClassifier({decide:(request,o)=>{
      decisions.push({id:`d${decisions.length}`,conversationId:current.conversationId,turnIndex:current.turnIndex,language:current.language,bytes:bytesOf(request),request:structuredClone(request)});
      return client.decide(request,o);
    }});
    const chat=createLocalChat({store:new InMemoryConversationStore(),personas,provider,retrieval:tracked,
      intentClassifier:{classifier:jev,minConfidence:Number(process.env.PTR_JEV_MIN_CONFIDENCE??0.6),timeoutMs:Number(process.env.PTR_JEV_TIMEOUT_MS??1500)}});
    let turns=0;const states:Record<string,number>={};
    try {
      for(const conversation of evaluator.conversations) {
        if(run.capReached) break;
        const owner=`bench-capture-${randomUUID()}`;
        const session=await chat.createSession(owner,{greetingIndex:0,personId:conversation.personId,personaId:conversation.personaId,personaRevision:conversation.personaRevision,
          timezone:'Asia/Seoul',ragCondition:'caption_image',retrievalMode:'semantic',executionProfile:'agent_loop'});
        for(const [turnIndex,item] of conversation.turns.entries()) {
          current={conversationId:conversation.id,turnIndex,iteration:0,language:conversation.language,category:conversation.category};
          const result=await chat.sendTurn(owner,{sessionId:session.id,clientRequestId:randomUUID(),text:item.text});
          turns++;states[result.state]=(states[result.state]??0)+1;
          if(run.capReached) break;
        }
      }
    } finally {await chat.stop();}
    const rebuilt=new Set(chatCalls.map(call=>hash(openRouterBody(call.messages,false))));
    const mismatched=seenBodies.filter(body=>!rebuilt.has(hash(body))).length;
    if(mismatched) throw new Error(`${mismatched} app chat bodies differ from the rebuilt bench body`);
    const chosen=selectStratified(chatCalls,SAMPLE);
    const turnKeys=new Set(chosen.map(call=>`${call.conversationId}#${call.turnIndex}`));
    const sameTurn=decisions.filter(d=>turnKeys.has(`${d.conversationId}#${d.turnIndex}`));
    const rest=selectStratified(decisions.filter(d=>!sameTurn.includes(d)),Math.max(0,SAMPLE-sameTurn.length));
    const workload:Workload={createdAt:new Date().toISOString(),testsetRevision:evaluator.revision,turns,chatCalls:chatCalls.length,decisionCalls:decisions.length,
      chat:chatCalls,decisions,selected:{chat:chosen.map(c=>c.id),decisions:[...sameTurn,...rest].slice(0,SAMPLE).map(d=>d.id),decisionsFromSameTurns:Math.min(SAMPLE,sameTurn.length)},
      capture:{states,run,ledger:{before,after:await budgetSnapshot(pool)},networkChatBodiesChecked:seenBodies.length,structuredOutputs:seenBodies.some(body=>body.response_format!==undefined)}};
    const directory=join(__dirname,'..','reports','jev-gemma-bench',workload.createdAt.replace(/[:.]/g,'-'));
    await mkdir(directory,{recursive:true,mode:0o700});
    await writeFile(join(directory,'workload.private.json'),JSON.stringify(workload,null,1),{mode:0o600});
    console.log(JSON.stringify({turns,states,chatCalls:chatCalls.length,decisionCalls:decisions.length,selected:{chat:chosen.length,decisions:workload.selected.decisions.length,decisionsFromSameTurns:workload.selected.decisionsFromSameTurns},
      checkedBodies:seenBodies.length,run,ledger:workload.capture.ledger}));
    console.log(`workload: ${directory}`);
  } finally {await pool.end();}
}

/** The app's OpenRouter agent body (OpenRouterClient.generate, json_schema verified in capture), optionally streamed. */
export function openRouterBody(messages:ProviderMessage[],stream:boolean):Json {
  return {model:CHAT_MODEL,messages:messages.map(({role,content})=>({role,content})),max_tokens:MAX_TOKENS,temperature:0,stream,
    ...(stream?{stream_options:{include_usage:true}}:{}),
    provider:{require_parameters:true,data_collection:'deny',zdr:true,allow_fallbacks:false,max_price:{prompt:PRICE.prompt,completion:PRICE.completion,request:0}},
    reasoning:{enabled:false},response_format:{type:'json_schema',json_schema:{name:'agent_reply',strict:true,schema:AGENT_RESPONSE_JSON_SCHEMA}}};
}
/** The app's Decisions API body (OpenRouterClient.decide). */
function decisionBody(request:DecisionCall['request']):Json {
  return {model:request.model,state:request.state,questions:request.questions,provider:{data_collection:'deny',zdr:true,allow_fallbacks:false,
    max_price:{prompt:String(PRICE.jevPrompt),completion:'0',request:'0'}}};
}
function schemaValid(text:string):boolean { try {parseAgentResponse(text);return true;} catch {return false;} }
const costMicrousd=(usage:Json|undefined)=>typeof usage?.cost==='number'&&Number.isFinite(usage.cost)&&usage.cost>=0?Math.ceil(usage.cost*1e6):null;

/** Ledgered direct POST: unique key (never replayed), reserve -> submitted -> network -> settle with usage.cost. */
async function ledgered<T extends {costMicrousd?:number|null}>(ledger:BudgetLedger,tag:string,body:Json,reserve:number,send:()=>Promise<T&{response:Json|null}>):Promise<T> {
  const key=hash({bench:'jev-gemma-v1',tag,body,nonce:randomUUID()});
  const saved=await ledger.reserve(key,reserve);
  if(!saved.created) throw new ProviderError('UNEXPECTED_REPLAY');
  await ledger.submitted(key);
  try {
    const result=await send();
    await ledger.finish(key,result.costMicrousd??null,result.response,typeof result.response?.id==='string'?result.response.id:null);
    return result;
  } catch(error) {await ledger.finish(key,null,null,null);throw error;}
}
async function runLevels(ids:string[],run:(id:string,level:number,index:number)=>Promise<Sample>,stop:()=>boolean,warmup=0):Promise<{samples:Sample[];walls:Record<number,number>}> {
  for(let i=0;i<warmup;i++) await run(ids[i%ids.length]!,0,i);
  const samples:Sample[]=[];const walls:Record<number,number>={};
  for(const level of LEVELS) {
    const queue=level>=32?[...ids,...ids]:[...ids];let next=0;const began=performance.now();
    await Promise.all(Array.from({length:level},async()=>{
      while(next<queue.length&&!stop()){const index=next++;samples.push(await run(queue[index]!,level,index));}
    }));
    walls[level]=(performance.now()-began)/1000;
    const rows=samples.filter(s=>s.level===level);
    console.log(JSON.stringify({level,requests:rows.length,ok:rows.filter(s=>s.ok).length,wallS:+walls[level]!.toFixed(1),p50:percentile(rows.map(s=>s.totalMs),50)}));
    if(stop()) break;
  }
  return {samples,walls};
}
async function readWorkload(options:Record<string,string>):Promise<{directory:string;workload:Workload}> {
  const directory=options.workload??'';
  return {directory,workload:JSON.parse(await readFile(join(directory,'workload.private.json'),'utf8')) as Workload};
}

async function benchOpenRouter(options:Record<string,string>,system:'openrouter'|'jev'):Promise<void> {
  requireLive(options);
  const {directory,workload}=await readWorkload(options);
  const maxUsd=Number(options['max-usd']??(system==='jev'?0.05:0.3));
  const apiKey=process.env.OPENROUTER_API_KEY??'';if(!apiKey) throw new Error('OPENROUTER_API_KEY missing');
  const {databaseUrl,pool}=researchPool();
  try {
    const ledger=new PostgresBudgetLedger(pool,databaseUrl);const before=await budgetSnapshot(pool);
    let spentMicrousd=0;let reservedOpen=0;
    const stop=()=>spentMicrousd+reservedOpen>maxUsd*1e6;
    const chat=new Map(workload.chat.map(c=>[c.id,c]));const dec=new Map(workload.decisions.map(d=>[d.id,d]));
    const headers={Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'};
    const run=async(id:string,level:number,index:number):Promise<Sample> => {
      const started=performance.now();let ttftMs:number|null=null;
      const base={level,index,id,ttftMs:null as number|null,promptTokens:null,completionTokens:null};
      let reserve=0;
      try {
        if(system==='jev') {
          const call=dec.get(id)!;const body=decisionBody(call.request);
          reserve=Math.ceil((bytesOf(body)+2048)*PRICE.jevPrompt);reservedOpen+=reserve;
          const result=await ledgered(ledger,'jev',body,reserve,async()=>{
            const t0=performance.now();
            const response=await fetch('https://openrouter.ai/api/alpha/decisions',{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
            if(!response.ok) {await response.body?.cancel();throw new ProviderError(`PROVIDER_HTTP_${response.status}`);}
            const json=await response.json() as Json;const totalMs=Math.round(performance.now()-t0);
            const usage=json.usage as Json|undefined;
            return {response:json,totalMs,costMicrousd:costMicrousd(usage),promptTokens:Number(usage?.prompt_tokens??usage?.input_tokens??NaN)||null,provider:typeof json.provider==='string'?json.provider:undefined};
          });
          // The app's own validator: the classifier re-reads exactly this response.
          const valid=await new JevIntentClassifier({decide:async()=>result.response!}).classify({text:'x',recentUserTurns:[],seed:'x'},{signal:new AbortController().signal}).then(()=>true,()=>false);
          spentMicrousd+=result.costMicrousd??reserve;
          return {...base,ok:true,schemaValid:valid,totalMs:result.totalMs,promptTokens:result.promptTokens,completionTokens:null,costMicrousd:result.costMicrousd,...(result.provider?{provider:result.provider}:{})};
        }
        const call=chat.get(id)!;const body=openRouterBody(call.messages,true);
        const bytes=bytesOf(call.messages);
        reserve=Math.ceil((bytes+call.messages.length*64+1024)*2*PRICE.prompt+MAX_TOKENS*PRICE.completion);reservedOpen+=reserve;
        const result=await ledgered(ledger,'gemma-openrouter',body,reserve,async()=>{
          const t0=performance.now();
          const response=await fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST',headers,body:JSON.stringify(body),signal:AbortSignal.timeout(60000)});
          if(!response.ok||!response.body) {await response.body?.cancel();throw new ProviderError(`PROVIDER_HTTP_${response.status}`);}
          let text='',buffer='',usage:Json|undefined,provider:string|undefined,model:string|undefined,id:string|undefined,streamError:string|undefined;
          const decoder=new TextDecoder();
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            buffer+=decoder.decode(chunk,{stream:true});let boundary:number;
            while((boundary=buffer.indexOf('\n\n'))>=0) {
              const event=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
              for(const line of event.split('\n')) {
                if(!line.startsWith('data: ')) continue;const data=line.slice(6).trim();if(data==='[DONE]') continue;
                const parsed=JSON.parse(data) as Json;
                if(parsed.error) streamError='PROVIDER_STREAM_ERROR';
                if(typeof parsed.provider==='string') provider=parsed.provider;if(typeof parsed.model==='string') model=parsed.model;if(typeof parsed.id==='string') id=parsed.id;
                if(parsed.usage) usage=parsed.usage as Json;
                for(const choice of (parsed.choices as Json[]|undefined)??[]) {
                  const content=(choice.delta as Json|undefined)?.content;
                  if(typeof content==='string'&&content){if(ttftMs===null) ttftMs=Math.round(performance.now()-t0);text+=content;}
                }
              }
            }
          }
          const totalMs=Math.round(performance.now()-t0);
          const response_={id,model,provider,usage,choices:[{message:{content:text}}]};
          if(streamError) throw new ProviderError(streamError);
          if(model!==undefined&&model!==CHAT_MODEL) throw new ProviderError('MODEL_MISMATCH');
          const details=usage?.prompt_tokens_details as Json|undefined;
          return {response:response_,text,totalMs,provider,costMicrousd:costMicrousd(usage),promptTokens:Number(usage?.prompt_tokens??NaN)||null,
            completionTokens:Number(usage?.completion_tokens??NaN)||null,cachedTokens:details?Number(details.cached_tokens??0):null};
        });
        spentMicrousd+=result.costMicrousd??reserve;
        return {...base,ok:true,schemaValid:schemaValid(result.text),ttftMs,totalMs:result.totalMs,promptTokens:result.promptTokens,completionTokens:result.completionTokens,
          cachedTokens:result.cachedTokens,costMicrousd:result.costMicrousd,...(result.provider?{provider:result.provider}:{})};
      } catch(error) {
        spentMicrousd+=reserve;
        return {...base,ok:false,error:error instanceof ProviderError?error.code:error instanceof Error?error.name:'error',schemaValid:false,ttftMs,totalMs:Math.round(performance.now()-started)};
      } finally {reservedOpen-=reserve;}
    };
    const ids=system==='jev'?workload.selected.decisions:workload.selected.chat;
    const {samples,walls}=await runLevels(ids,run,stop);
    const result={system,model:system==='jev'?JEV_MODEL:CHAT_MODEL,levels:LEVELS,walls,stoppedByCap:stop(),spentUsd:+(spentMicrousd/1e6).toFixed(6),ledger:{before,after:await budgetSnapshot(pool)},samples};
    await writeFile(join(directory,`${system}.private.json`),JSON.stringify(result,null,1),{mode:0o600});
    console.log(JSON.stringify({system,spentUsd:result.spentUsd,stoppedByCap:result.stoppedByCap,ledger:result.ledger}));
  } finally {await pool.end();}
}

async function benchSelfHosted(options:Record<string,string>):Promise<void> {
  const {directory,workload}=await readWorkload(options);
  const chat=new Map(workload.chat.map(c=>[c.id,c]));
  // The app's self-hosted adapter (streaming, include_usage, structured agent replies, thinking off). One provider per
  // call so its metrics callback belongs to that call.
  const run=async(id:string,level:number,index:number):Promise<Sample> => {
    let metrics:Omit<Sample,'level'|'index'|'id'|'schemaValid'>|undefined;
    const provider=new OpenAICompatibleTextProvider({baseUrl:options['base-url']??'http://127.0.0.1:18000/v1',model:options.model??'gemma-4-26b-a4b-nvfp4',
      maxOutputTokens:MAX_TOKENS,timeoutMs:120000,structuredAgentReplies:true,onMetrics:m=>{metrics={ok:m.ok,...(m.error?{error:m.error}:{}),ttftMs:m.ttftMs,totalMs:m.totalMs,promptTokens:m.promptTokens,completionTokens:m.completionTokens};}});
    const text=await provider.generate(chat.get(id)!.messages,{signal:new AbortController().signal}).catch(()=>undefined);
    return {level,index,id,...metrics!,schemaValid:text!==undefined&&schemaValid(text)};
  };
  const {samples,walls}=await runLevels(workload.selected.chat,run,()=>false,Number(options.warmup??3));
  await writeFile(join(directory,'selfhosted.private.json'),JSON.stringify({system:'selfhosted',model:options.model??'gemma-4-26b-a4b-nvfp4',levels:LEVELS,walls,samples},null,1),{mode:0o600});
  console.log('selfhosted done');
}

async function report(options:Record<string,string>):Promise<void> {
  const {directory,workload}=await readWorkload(options);
  const usdPerHour=Number(options['gpu-usd-per-hour']??0.78);
  const chat=new Map(workload.chat.map(c=>[c.id,c]));
  const turnsWithChat=workload.turns;const chatPerTurn=workload.chatCalls/turnsWithChat;const jevPerTurn=workload.decisionCalls/turnsWithChat;
  const out:Json={workload:{turns:workload.turns,chatCalls:workload.chatCalls,decisionCalls:workload.decisionCalls,chatCallsPerTurn:+chatPerTurn.toFixed(3),jevCallsPerTurn:+jevPerTurn.toFixed(3),
    selectedChat:workload.selected.chat.length,selectedDecisions:workload.selected.decisions.length,decisionsFromSameTurns:workload.selected.decisionsFromSameTurns,
    selectedLanguages:Object.fromEntries(['ko','en'].map(l=>[l,workload.selected.chat.filter(id=>chat.get(id)!.language===l).length])),
    selectedBytes:{p50:percentile(workload.selected.chat.map(id=>chat.get(id)!.bytes),50),min:Math.min(...workload.selected.chat.map(id=>chat.get(id)!.bytes)),max:Math.max(...workload.selected.chat.map(id=>chat.get(id)!.bytes))}},systems:{}};
  for(const system of ['jev','openrouter','selfhosted']) {
    let data:{walls:Record<string,number>;samples:Sample[];spentUsd?:number;ledger?:Json};
    try {data=JSON.parse(await readFile(join(directory,`${system}.private.json`),'utf8'));} catch {continue;}
    const perTurn=system==='jev'?jevPerTurn:chatPerTurn;
    const levels:Json={};
    for(const level of LEVELS) {
      const rows=data.samples.filter(s=>s.level===level);if(!rows.length) continue;
      const ok=rows.filter(s=>s.ok);const wall=data.walls[level]!;
      const lat=ok.map(s=>s.totalMs),ttft=ok.flatMap(s=>s.ttftMs===null?[]:[s.ttftMs]);
      const out_=ok.reduce((n,s)=>n+(s.completionTokens??0),0);const rps=ok.length/wall;
      const costs=ok.flatMap(s=>typeof s.costMicrousd==='number'?[s.costMicrousd]:[]);
      const usdPerRequest=system==='selfhosted'?gpuUsdPerRequest(usdPerHour,rps):costs.reduce((a,b)=>a+b,0)/Math.max(1,costs.length)/1e6;
      levels[level]={requests:rows.length,ok:ok.length,failurePct:+(100*(rows.length-ok.length)/rows.length).toFixed(1),
        schemaValidPct:+(100*rows.filter(s=>s.schemaValid).length/rows.length).toFixed(1),
        latencyMs:{p50:percentile(lat,50),p95:percentile(lat,95),max:lat.length?Math.max(...lat):null},ttftMs:{p50:percentile(ttft,50),p95:percentile(ttft,95)},
        reqPerS:+rps.toFixed(3),outputTokPerS:+(out_/wall).toFixed(1),wallS:+wall.toFixed(1),
        promptTokens:{mean:+(ok.reduce((n,s)=>n+(s.promptTokens??0),0)/Math.max(1,ok.length)).toFixed(0),p50:percentile(ok.flatMap(s=>s.promptTokens?[s.promptTokens]:[]),50),p95:percentile(ok.flatMap(s=>s.promptTokens?[s.promptTokens]:[]),95)},
        completionTokensMean:+(out_/Math.max(1,ok.length)).toFixed(1),
        cachedTokensTotal:ok.reduce((n,s)=>n+(s.cachedTokens??0),0),
        providers:Object.fromEntries([...new Set(ok.map(s=>s.provider??'-'))].map(p=>[p,ok.filter(s=>(s.provider??'-')===p).length])),
        errors:Object.fromEntries([...new Set(rows.filter(s=>!s.ok).map(s=>s.error))].map(e=>[e,rows.filter(s=>s.error===e).length])),
        usdPerRequest:+usdPerRequest.toPrecision(3),usdPer1kTurns:+(usdPerRequest*perTurn*1000).toPrecision(3),
        ...(system==='selfhosted'?{usdPer1kTurnsAt50pct:+(gpuUsdPerRequest(usdPerHour,rps,0.5)*perTurn*1000).toPrecision(3),usdPer1kTurnsAt10pct:+(gpuUsdPerRequest(usdPerHour,rps,0.1)*perTurn*1000).toPrecision(3)}:{})};
    }
    (out.systems as Json)[system]={levels,...(data.spentUsd!==undefined?{spentUsd:data.spentUsd,ledger:data.ledger}:{})};
  }
  // Prompt token distribution of the selected chat bodies, from the OpenRouter usage (fallback: self-hosted usage).
  const tokens=new Map<string,number>();
  for(const system of ['openrouter','selfhosted']) {
    try {const data=JSON.parse(await readFile(join(directory,`${system}.private.json`),'utf8')) as {samples:Sample[]};
      for(const s of data.samples) if(s.promptTokens&&!tokens.has(`${system}:${s.id}`)) tokens.set(`${system}:${s.id}`,s.promptTokens);} catch {/* absent system */}
  }
  for(const system of ['openrouter','selfhosted']) {
    const values=workload.selected.chat.flatMap(id=>tokens.has(`${system}:${id}`)?[tokens.get(`${system}:${id}`)!]:[]);
    if(values.length) (out.workload as Json)[`promptTokens_${system}`]={n:values.length,min:Math.min(...values),p25:percentile(values,25),p50:percentile(values,50),p75:percentile(values,75),p95:percentile(values,95),max:Math.max(...values),
      byLanguage:Object.fromEntries(['ko','en'].map(l=>{const v=workload.selected.chat.filter(id=>chat.get(id)!.language===l&&tokens.has(`${system}:${id}`)).map(id=>tokens.get(`${system}:${id}`)!);return [l,{n:v.length,p50:percentile(v,50),max:v.length?Math.max(...v):null}];}))};
  }
  await writeFile(join(directory,'summary.private.json'),JSON.stringify(out,null,1),{mode:0o600});
  console.log(JSON.stringify(out,null,1));
}

/** Replayed calls never reach the network: the rebuilt bodies must hash to the app's own ledger keys (OpenRouterClient.request). */
async function verify(options:Record<string,string>):Promise<void> {
  const {workload}=await readWorkload(options);const {pool}=researchPool();
  try {
    const keys=workload.chat.map(call=>hash({endpoint:'chat/completions',body:openRouterBody(call.messages,false),schema:'goal1-provider-v1'}));
    const found=(await pool.query('SELECT count(DISTINCT key)::int n FROM ptr_provider_requests WHERE key = ANY($1)',[keys])).rows[0] as {n:number};
    console.log(JSON.stringify({chatCalls:keys.length,uniqueBodies:new Set(keys).size,appLedgerKeysFound:found.n}));
  } finally {await pool.end();}
}

/** Prometheus text -> the vLLM gauges/counters the sweep tracks (summed over label sets). */
export function scrapeVllm(text:string):Record<string,number> {
  const wanted=['kv_cache_usage_perc','gpu_cache_usage_perc','num_requests_running','num_requests_waiting','num_preemptions_total','prefix_cache_queries_total','prefix_cache_hits_total'];
  const out:Record<string,number>={};
  for(const line of text.split('\n')) {
    const match=/^vllm:([a-z_]+)(?:\{[^}]*\})?\s+([-+0-9.eE]+|NaN)$/.exec(line.trim());
    if(match&&wanted.includes(match[1]!)) out[match[1]!]=(out[match[1]!]??0)+Number(match[2]);
  }
  return out;
}
/**
 * Closed-loop sweep against one self-hosted engine: per level, 3 sequential warm-ups (excluded), then `level` workers
 * send the 48 selected bodies in order (shared cursor, cycling) for `duration` seconds; in-flight requests drain.
 * /metrics is scraped every second through the tunnel. GPU samples are taken on the pod and joined by UTC window later.
 */
async function sweep(options:Record<string,string>):Promise<void> {
  const {workload}=await readWorkload(options);
  const baseUrl=options['base-url']??'http://127.0.0.1:18000/v1';const model=options.model??'';
  const levels=(options.levels??'4,8,16').split(',').map(Number);const duration=Number(options.duration??60)*1000;
  const chat=new Map(workload.chat.map(c=>[c.id,c]));const ids=workload.selected.chat;
  const send=async(id:string)=>{
    let metrics:{ok:boolean;error?:string;ttftMs:number|null;totalMs:number;promptTokens:number|null;completionTokens:number|null}|undefined;
    const provider=new OpenAICompatibleTextProvider({baseUrl,model,maxOutputTokens:MAX_TOKENS,timeoutMs:120000,structuredAgentReplies:true,onMetrics:m=>{metrics=m;}});
    const text=await provider.generate(chat.get(id)!.messages,{signal:new AbortController().signal}).catch(()=>undefined);
    return {...metrics!,schemaValid:text!==undefined&&schemaValid(text)};
  };
  const metricsUrl=baseUrl.replace(/\/v1\/?$/,'')+'/metrics';
  const results=[];
  for(const level of levels) {
    for(let i=0;i<3;i++) await send(ids[i]!);
    const scrapes:{t:number;values:Record<string,number>}[]=[];
    const startedAt=new Date().toISOString();const t0=performance.now();
    const scrape=async()=>{try {scrapes.push({t:Math.round(performance.now()-t0),values:scrapeVllm(await (await fetch(metricsUrl,{signal:AbortSignal.timeout(900)})).text())});} catch {/* missed sample */}};
    await scrape();const timer=setInterval(()=>void scrape(),1000);
    let cursor=0;const requests:Json[]=[];
    await Promise.all(Array.from({length:level},async()=>{
      while(performance.now()-t0<duration) {
        const id=ids[cursor++%ids.length]!;const startMs=Math.round(performance.now()-t0);
        const result=await send(id);requests.push({id,startMs,endMs:Math.round(performance.now()-t0),...result});
      }
    }));
    clearInterval(timer);await scrape();
    const finishedAt=new Date().toISOString();
    results.push({level,startedAt,finishedAt,durationMs:duration,drainMs:Math.round(performance.now()-t0)-duration,requests,scrapes});
    console.log(JSON.stringify({level,requests:requests.length,ok:requests.filter(r=>r.ok).length,startedAt,finishedAt}));
  }
  const out=options.out??'reports/gpu-sweep';await mkdir(out,{recursive:true,mode:0o700});
  await writeFile(join(out,`sweep-${model}.private.json`),JSON.stringify({model,baseUrl,levels,results},null,1),{mode:0o600});
  console.log(`sweep: ${join(out,`sweep-${model}.private.json`)}`);
}

async function main():Promise<void> {
  const mode=process.argv[2];const options=args();
  if(mode==='capture') return capture(options);
  if(mode==='openrouter'||mode==='jev') return benchOpenRouter(options,mode);
  if(mode==='selfhosted') return benchSelfHosted(options);
  if(mode==='report') return report(options);
  if(mode==='verify') return verify(options);
  if(mode==='sweep') return sweep(options);
  throw new Error('mode must be capture|verify|openrouter|jev|selfhosted|sweep|report');
}
if(require.main===module) void main().catch(error=>{console.error(error instanceof Error?error.message.slice(0,200):'bench failed');process.exitCode=1;});
