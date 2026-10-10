import { createHash } from 'node:crypto';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage, isAIMessage } from '@langchain/core/messages';
import type { ProviderMessage } from '@ptr/contracts';
import { AGENT_RESPONSE_JSON_SCHEMA, PROVIDER_DEADLINE, type TextProvider } from '@ptr/core';
import { ProviderError, providerRequestScope, type BudgetLedger } from './budget';
import { neutralizeMessages } from './control-tokens';

export interface LiteLLMCallMetrics {
  model:string; ok:boolean; error?:string; ttftMs:null; totalMs:number;
  promptTokens:number|null; completionTokens:number|null; attempts:number; costMicrousd:number|null;
}
export interface LiteLLMTextProviderOptions {
  /** Trusted internal LiteLLM Proxy base URL, including /v1. Never a provider URL. */
  baseUrl:string; model:string; apiKey:string;
  maxOutputTokens?:number; timeoutMs?:number; inputBytes?:number; fetch?:typeof fetch;
  onMetrics?:(metrics:LiteLLMCallMetrics)=>void;
  /** A conservative per-call ceiling. Missing upstream cost keeps this reservation unknown. */
  billable?:{ledger:BudgetLedger; reservationMicrousd:number};
}
interface Usage { promptTokens:number|null; completionTokens:number|null }
interface Receipt { text:string; usage:Usage; upstream:string }
interface GenerateOptions {
  signal:AbortSignal; requestKey?:string; deadlineAt?:number; priority?:1|0|-1;
  onServed?:(upstream:string)=>void; onUsage?:(usage:Usage)=>void;
}
const count=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
function checkedText(value:unknown):string {
  if(typeof value!=='string'||!value.trim()||Buffer.byteLength(value,'utf8')>65536) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
  return value;
}
function receipt(value:unknown):Receipt {
  const saved=value as Partial<Receipt>|null;
  if(!saved||!saved.usage||typeof saved.upstream!=='string') throw new ProviderError('INVALID_PROVIDER_RESPONSE');
  return {text:checkedText(saved.text),usage:{promptTokens:count(saved.usage.promptTokens),completionTokens:count(saved.usage.completionTokens)},upstream:saved.upstream};
}

/** Actual LangChain chat transport; LiteLLM owns routing. No local fallback or HTTP retry loop. */
export class LiteLLMTextProvider implements TextProvider {
  constructor(private readonly options:LiteLLMTextProviderOptions) {
    let url:URL;try {url=new URL(options.baseUrl);} catch {throw new ProviderError('INVALID_PROXY_URL');}
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)
      throw new ProviderError('INVALID_PROXY_URL');
    if(!options.model.trim()||!options.apiKey.trim()) throw new ProviderError('INVALID_PROVIDER_CONFIG');
    for(const value of [options.maxOutputTokens??512,options.timeoutMs??30000,options.inputBytes??65536])
      if(!Number.isSafeInteger(value)||value<1) throw new ProviderError('INVALID_PROVIDER_CONFIG');
    if(options.billable&&(!Number.isSafeInteger(options.billable.reservationMicrousd)||options.billable.reservationMicrousd<1))
      throw new ProviderError('INVALID_PROVIDER_CONFIG');
  }
  async generate(messages:ProviderMessage[],options:GenerateOptions):Promise<string> {
    if(options.signal.aborted) throw new ProviderError('CANCELLED');
    if(!Array.isArray(messages)||!messages.length||messages.length>64||messages.some(message=>!message||
      !['system','user','assistant'].includes(message.role)||typeof message.content!=='string'||
      Object.keys(message).some(key=>!['role','content'].includes(key)))) throw new ProviderError('INVALID_INPUT');
    if(Buffer.byteLength(JSON.stringify(messages),'utf8')>(this.options.inputBytes??65536)) throw new ProviderError('INPUT_LIMIT');
    if(options.deadlineAt!==undefined&&!Number.isFinite(options.deadlineAt)) throw new ProviderError('INVALID_INPUT');
    const now=Date.now(), timeoutMs=this.options.timeoutMs??30000;
    const deadlineAt=Math.min(now+timeoutMs,options.deadlineAt??Infinity);
    if(deadlineAt<=now) throw new ProviderError(PROVIDER_DEADLINE);
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),Math.max(1,Math.ceil(deadlineAt-now)));
    const signal=AbortSignal.any([options.signal,controller.signal]);
    const started=performance.now();let attempts=0, usage:Usage={promptTokens:null,completionTokens:null};
    let upstream='litellm', costMicrousd:number|null=null, generationId:string|null=null;
    let key:string|undefined, submitted=false, finished=false;
    const ledger=this.options.billable?.ledger;
    const aborted=()=>new ProviderError(options.signal.aborted?'CANCELLED':options.deadlineAt===deadlineAt?PROVIDER_DEADLINE:'PROVIDER_TIMEOUT');
    const report=(ok:boolean,error?:string)=>this.options.onMetrics?.({model:this.options.model,ok,...(error?{error}:{}),
      ttftMs:null,totalMs:Math.round(performance.now()-started),...usage,attempts,costMicrousd});
    const finishSuccess=(result:Receipt)=>{
      usage=result.usage;options.onUsage?.(usage);options.onServed?.(result.upstream);report(true);return result.text;
    };
    try {
      const safeMessages=neutralizeMessages(messages);
      const agent=messages.some(message=>message.role==='system'&&message.content.includes('AGENT_JSON_REPLY'));
      const timeline=messages.some(message=>message.role==='system'&&message.content.includes('TIMELINE_JSON_REPLY'));
      const maxTokens=this.options.maxOutputTokens??512;
      if(ledger) {
        // Scope by turn AND call content: a tool follow-up is new work, a replay of the same call is not.
        key=createHash('sha256').update(JSON.stringify({revision:'litellm-langchain-v1',baseUrl:this.options.baseUrl,
          model:this.options.model,messages:safeMessages,maxTokens,agent,timeline,requestKey:options.requestKey??null})).digest('hex');
        const scope=providerRequestScope(options.requestKey,'chat');
        const saved=await ledger.reserve(key,this.options.billable!.reservationMicrousd,scope?{scope}:undefined);
        if(signal.aborted) {
          if(saved.created) {await ledger.finish(key,0,null,null);finished=true;}
          throw aborted();
        }
        if(!saved.created) {
          if(saved.request.actualMicrousd!==null&&saved.request.actualMicrousd>saved.request.reservedMicrousd)
            throw new ProviderError('PROVIDER_COST_EXCEEDS_RESERVATION');
          if(saved.request.response!==null) {costMicrousd=saved.request.actualMicrousd;return finishSuccess(receipt(saved.request.response));}
          throw new ProviderError('REQUEST_UNRESOLVED_NO_RESUBMIT');
        }
        // Persist BEFORE any SDK network I/O. Ambiguous failures retain a reservation, never resubmit.
        await ledger.submitted(key);submitted=true;
      }
      const fetcher:typeof fetch=async(input,init)=>{
        attempts++;
        const response=await (this.options.fetch??fetch)(input,{...init,redirect:'error'});
        const served=response.headers.get('x-litellm-model-id')??response.headers.get('x-ptr-upstream');
        if(served&&['primary','secondary','fake'].includes(served)) upstream=served;
        // The OpenAI SDK drops nonstandard cost fields. Observe, never replace, its actual transport response.
        if(ledger&&response.ok) {
          const raw=await response.clone().json() as {id?:unknown;usage?:{cost?:unknown;prompt_tokens?:unknown;completion_tokens?:unknown}};
          generationId=typeof raw.id==='string'?raw.id:null;
          usage={promptTokens:count(raw.usage?.prompt_tokens),completionTokens:count(raw.usage?.completion_tokens)};
          const cost=raw.usage?.cost;
          if(typeof cost==='number'&&Number.isFinite(cost)&&cost>=0&&Number.isSafeInteger(Math.ceil(cost*1_000_000)))
            costMicrousd=Math.ceil(cost*1_000_000);
        }
        return response;
      };
      const model=new ChatOpenAI({model:this.options.model,apiKey:this.options.apiKey,temperature:0,
        maxTokens,timeout:timeoutMs,maxRetries:0,streaming:false,useResponsesApi:false,
        configuration:{baseURL:this.options.baseUrl,fetch:fetcher,maxRetries:0}});
      const input=safeMessages.map(message=>message.role==='system'?new SystemMessage(message.content):
        message.role==='user'?new HumanMessage(message.content):new AIMessage(message.content));
      let raw:AIMessage;
      if(agent) {
        const result=await model.withStructuredOutput(AGENT_RESPONSE_JSON_SCHEMA,{name:'agent_reply',
          method:'jsonSchema',strict:false,includeRaw:true}).invoke(input,{signal});
        if(result.parsed===null||result.parsed===undefined) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
        if(!isAIMessage(result.raw)) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
        raw=result.raw;
      } else {
        raw=await model.invoke(input,{signal,...(timeline?{response_format:{type:'json_object' as const}}:{})});
      }
      if(signal.aborted) throw aborted();
      usage={promptTokens:count(raw.usage_metadata?.input_tokens),completionTokens:count(raw.usage_metadata?.output_tokens)};
      const result:Receipt={text:checkedText(raw.content),usage,upstream};
      if(ledger&&key) {
        await ledger.finish(key,costMicrousd,result,generationId);finished=true;
        if(costMicrousd!==null&&costMicrousd>this.options.billable!.reservationMicrousd) throw new ProviderError('PROVIDER_COST_EXCEEDS_RESERVATION');
      }
      if(signal.aborted) throw aborted();
      return finishSuccess(result);
    } catch(error) {
      if(ledger&&key&&submitted&&!finished) await ledger.finish(key,costMicrousd,null,generationId);
      const status=(error as {status?:unknown})?.status;
      const code=error instanceof ProviderError?error.code:error instanceof SyntaxError?'INVALID_PROVIDER_RESPONSE':options.signal.aborted?'CANCELLED':controller.signal.aborted?
        options.deadlineAt===deadlineAt?PROVIDER_DEADLINE:'PROVIDER_TIMEOUT':typeof status==='number'?`PROVIDER_HTTP_${status}`:'PROVIDER_TRANSPORT';
      report(false,code);throw new ProviderError(code);
    } finally {clearTimeout(timer);}
  }
}
