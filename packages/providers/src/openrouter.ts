import { createHash } from 'node:crypto';
import { AGENT_RESPONSE_JSON_SCHEMA, type TextProvider } from '@ptr/core';
import type { ProviderMessage } from '@ptr/contracts';
import { assertLocalDatabaseUrl } from '@ptr/storage';
import { neutralizeJsonStrings, neutralizeMessages } from './control-tokens';
import { ProviderError, type BudgetLedger } from './budget';

const API='https://openrouter.ai/api/v1';
export const DEFAULT_TEXT_MODEL='google/gemini-3-flash-preview';
export const EMBEDDING_MODEL='openai/text-embedding-3-small';
export const EMBEDDING_DIMENSIONS=1536;
/** Observed upstream alias is explicitly allowlisted; never accept arbitrary vendor/suffix matches. */
export function normalizeEmbeddingModel(model:unknown):typeof EMBEDDING_MODEL|undefined {
  return model===EMBEDDING_MODEL||model==='text-embedding-3-small'?EMBEDDING_MODEL:undefined;
}
function reportedCostMicrousd(result:Json):number|null {
  if(!result.usage||typeof result.usage!=='object'||Array.isArray(result.usage)) return null;
  const cost=(result.usage as Json).cost;
  if(typeof cost!=='number'||!Number.isFinite(cost)||cost<0) return null;
  const microusd=Math.ceil(cost*1_000_000);
  // Unrepresentable accounting values cannot release a conservative reservation.
  return Number.isSafeInteger(microusd)?microusd:null;
}
// Price ceilings in USD per million tokens (OpenRouter max_price unit) and per-model reasoning.
// Gemini 3 Flash cannot disable reasoning, only minimize it.
/**
 * `agentSchema`: constrain agent replies with the shared AGENT_RESPONSE_JSON_SCHEMA (strict json_schema) when the
 * catalog advertises structured outputs. Opt-in per model: strict modes differ by vendor (OpenAI strict rejects
 * optional properties), so models that were not verified keep json_object.
 */
// Control-token neutralization (control-tokens.ts) covers the Gemma 4 tokenizer's special tokens plus generic and legacy
// chat-template shapes. If a non-Gemma model is added here, revisit that token set against its tokenizer.
const TEXT_MODELS:Record<string,{prompt:number;completion:number;reasoning?:Json;agentSchema?:boolean}>={
  [DEFAULT_TEXT_MODEL]:{prompt:0.5,completion:3,reasoning:{effort:'minimal'}},
  'google/gemini-2.5-flash-lite':{prompt:0.1,completion:0.4,reasoning:{enabled:false}},
  'openai/gpt-4.1-nano':{prompt:0.1,completion:0.4},
  // Catalog price (2026-10-08); optional reasoning stays off. The `:free` variant is never allowed.
  'google/gemma-4-26b-a4b-it':{prompt:0.09,completion:0.3,reasoning:{enabled:false},agentSchema:true},
};
/** The chat-model allowlist (the client's constructor refuses anything else with MODEL_NOT_ALLOWED); also read by the config check. */
export function isAllowedTextModel(model:string):boolean {return Object.hasOwn(TEXT_MODELS,model);}
/** Decision models (Decisions API): input-only pricing ceiling in USD per million tokens; output tokens are free. Pinned ids only. */
const DECISION_MODELS:Record<string,{prompt:number}>={'typesafe/jev-1.13':{prompt:0.05}};
export const DECISION_MODEL_IDS=Object.keys(DECISION_MODELS);
export const DECISION_BASE_ALLOWANCE=1024;
export const DECISION_QUESTION_ALLOWANCE=512;
const DECISIONS_URL='https://openrouter.ai/api/alpha/decisions';
const SCHEMA_REVISION='goal1-provider-v1';
type Fetch=typeof fetch;
type Json=Record<string,unknown>;
function object(value:unknown):Json { if (!value||typeof value!=='object'||Array.isArray(value)) throw new ProviderError('INVALID_PROVIDER_RESPONSE'); return value as Json; }
function hash(value:unknown):string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function aborted(signal:AbortSignal):void { if (signal.aborted) throw new ProviderError('CANCELLED'); }
/** Waits for shared work (cached checks) without tying that work to one caller's signal. */
function untilAborted<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  aborted(signal);
  return new Promise<T>((resolve,reject)=>{
    const stop=()=>reject(new ProviderError('CANCELLED'));
    signal.addEventListener('abort',stop,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));
  });
}
export interface OpenRouterOptions {
  apiKey:string; liveEnabled:boolean; allowExternalData:boolean; databaseUrl:string; ledger:BudgetLedger;
  textModel?:string; maxOutputTokens?:number; maxInputBytes?:number; timeoutMs?:number; fetch?:Fetch;
  /** Share of the ledger call_cap that decision (Jev) calls must leave free for chat; default 0.2, 0 disables. */
  decisionReservedCallFraction?:number;
}
export function liveOptionsFromEnvironment(env:NodeJS.ProcessEnv,ledger:BudgetLedger):OpenRouterOptions {
  return {apiKey:env.OPENROUTER_API_KEY??'',liveEnabled:env.GOAL1_LIVE_ENABLED==='true',
    allowExternalData:env.GOAL1_ALLOW_EXTERNAL_DATA==='true',databaseUrl:env.GOAL1_DATABASE_URL??'',ledger,
    textModel:env.GOAL1_TEXT_MODEL??DEFAULT_TEXT_MODEL,
    // A blank value is an error (INVALID_LIMIT), never silently 0.
    ...(env.PTR_JEV_RESERVED_CALL_FRACTION===undefined?{}:{decisionReservedCallFraction:env.PTR_JEV_RESERVED_CALL_FRACTION.trim()?Number(env.PTR_JEV_RESERVED_CALL_FRACTION):Number.NaN})};
}
export class OpenRouterClient {
  private readonly fetcher:Fetch;
  private readonly model:string;
  private readonly outputTokens:number;
  private readonly inputBytes:number;
  private readonly timeoutMs:number;
  private readonly reservedCallFraction:number;
  private priceCheck:Promise<void>|undefined;
  /** From the verified catalog entry of the chat model. */
  private structuredOutputs=false;
  private readonly decisionPriceChecks=new Map<string,Promise<void>>();
  constructor(private readonly options:OpenRouterOptions) {
    if (!options.liveEnabled||!options.allowExternalData||!options.apiKey.trim()) throw new ProviderError('LIVE_DISABLED');
    assertLocalDatabaseUrl(options.databaseUrl);
    this.model=options.textModel??DEFAULT_TEXT_MODEL;
    if (!isAllowedTextModel(this.model)) throw new ProviderError('MODEL_NOT_ALLOWED');
    this.outputTokens=options.maxOutputTokens??512;
    this.inputBytes=options.maxInputBytes??32768;
    this.timeoutMs=options.timeoutMs??30000;
    this.reservedCallFraction=options.decisionReservedCallFraction??0.2;
    if (!(this.reservedCallFraction>=0&&this.reservedCallFraction<1)) throw new ProviderError('INVALID_LIMIT');
    if (!Number.isInteger(this.outputTokens)||this.outputTokens<1||this.outputTokens>1024||!Number.isInteger(this.inputBytes)||this.inputBytes<1||this.inputBytes>65536||!Number.isInteger(this.timeoutMs)||this.timeoutMs<1||this.timeoutMs>60000) throw new ProviderError('INVALID_LIMIT');
    this.options={...options};
    this.fetcher=options.fetch??fetch;
  }
  // Invoke once at the start of each run. Public catalogs never receive a credential.
  async verifyPricing(signal:AbortSignal):Promise<void> {
    aborted(signal);
    if (!this.priceCheck) {
      const check=this.checkPrices(signal);this.priceCheck=check;
      // A failed or cancelled check is not kept: the next caller verifies again instead of failing forever.
      check.catch(()=>{ if (this.priceCheck===check) this.priceCheck=undefined; });
    }
    return this.priceCheck;
  }
  private async checkedFetch(url:string,init:RequestInit,signal:AbortSignal):Promise<Json> {
    aborted(signal);
    const timeout=AbortSignal.timeout(this.timeoutMs);
    const combined=AbortSignal.any([signal,timeout]);
    try {
      const response=await this.fetcher(url,{...init,signal:combined,redirect:'error'});
      if (!response.ok) throw new ProviderError(`PROVIDER_HTTP_${response.status}`);
      // Bound response allocation, including vector/catalog JSON, before parsing.
      const limit=2*1024*1024;
      if (Number(response.headers.get('content-length')??0)>limit||!response.body) throw new ProviderError('PROVIDER_RESPONSE_LIMIT');
      const reader=response.body.getReader(); const chunks:Uint8Array[]=[]; let total=0;
      try {
        while(true) {
          if (combined.aborted) throw new ProviderError(signal.aborted?'CANCELLED':'PROVIDER_TIMEOUT');
          const chunk=await reader.read(); if(chunk.done) break;
          total+=chunk.value.byteLength;
          if(total>limit) throw new ProviderError('PROVIDER_RESPONSE_LIMIT');
          chunks.push(chunk.value);
        }
      } catch(error) { await reader.cancel(); throw error; } finally { reader.releaseLock(); }
      // Do not expose response/error bodies, headers, input text, or secrets in errors.
      return object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    } catch(error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(signal.aborted?'CANCELLED':timeout.aborted?'PROVIDER_TIMEOUT':'PROVIDER_TRANSPORT');
    }
  }
  private async checkPrices(signal:AbortSignal):Promise<void> {
    const chat=await this.checkedFetch(`${API}/models`,{},signal);
    const embeddings=await this.checkedFetch(`${API}/embeddings/models`,{},signal);
    const text=TEXT_MODELS[this.model]!;
    for (const [catalog,model,prompt,completion] of [[chat,this.model,text.prompt*1e-6,text.completion*1e-6],[embeddings,EMBEDDING_MODEL,0.00000002,0]] as const) {
      if (!Array.isArray(catalog.data)) throw new ProviderError('PRICING_UNVERIFIED');
      const entry=catalog.data.find((value:unknown)=>object(value).id===model);
      if (!entry) throw new ProviderError('PRICING_UNVERIFIED');
      const metadata=object(entry);
      if (model===this.model) this.structuredOutputs=Array.isArray(metadata.supported_parameters)&&metadata.supported_parameters.includes('structured_outputs');
      if (metadata.reasoning&&object(metadata.reasoning).mandatory===true) throw new ProviderError('MANDATORY_REASONING_NOT_ALLOWED');
      const pricing=object(metadata.pricing);
      if (pricing.prompt===undefined||pricing.completion===undefined) throw new ProviderError('PRICING_UNVERIFIED');
      for (const [key,value] of Object.entries(pricing)) {
        const amount=Number(value);
        const disabledTextFeatures=['image','audio','input_audio_cache','web_search'];
        const disabled=completion>0&&disabledTextFeatures.includes(key);
        const limit=key==='prompt'?prompt:key==='completion'||key==='internal_reasoning'?completion:
          key==='input_cache_read'||key==='input_cache_write'?prompt:0;
        // Positive prices for known absent image/audio/search events cannot affect a text-only request.
        // Unknown charges fail closed, and cache write/read + reasoning stay within reserved bounds.
        if (!Number.isFinite(amount)||amount<0||(!disabled&&amount>limit)) throw new ProviderError('PRICING_CHANGED_OR_UNKNOWN_FEE');
      }
    }
  }
  // A failed check is not cached, so one slow catalog read cannot disable decisions for the process lifetime.
  private checkDecisionPrice(model:string):Promise<void> {
    let check=this.decisionPriceChecks.get(model);
    if (!check) {
      check=(async()=>{
        const result=await this.checkedFetch(`${API}/models/${model}/endpoints`,{},AbortSignal.timeout(this.timeoutMs));
        const endpoints=object(result.data).endpoints;
        if (!Array.isArray(endpoints)||!endpoints.length) throw new ProviderError('PRICING_UNVERIFIED');
        for (const endpoint of endpoints) for (const [key,value] of Object.entries(object(object(endpoint).pricing))) {
          const amount=Number(value);
          // Prompt within the ceiling; completion and every other fee must be zero.
          if (!Number.isFinite(amount)||amount<0||amount>(key==='prompt'?DECISION_MODELS[model]!.prompt*1e-6:0)) throw new ProviderError('PRICING_CHANGED_OR_UNKNOWN_FEE');
        }
      })();
      this.decisionPriceChecks.set(model,check);
      check.catch(()=>this.decisionPriceChecks.delete(model));
    }
    return check;
  }
  private provider(embedding:boolean):Json {
    const text=TEXT_MODELS[this.model]!;
    return {require_parameters:true,data_collection:'deny',zdr:true,allow_fallbacks:false,
      max_price:{prompt:embedding?0.02:text.prompt,completion:embedding?0:text.completion,request:0}};
  }
  /** `idempotencyKey` (never sent) scopes the ledger key, e.g. to one turn; without it identical requests share one key. */
  private async request(body:Json,endpoint:string,reservation:number,signal:AbortSignal,idempotencyKey?:string):Promise<Json> {
    aborted(signal);
    // Decisions verify their own model's endpoint price; text/embedding catalogs are irrelevant to them.
    if (endpoint!=='decisions') await this.verifyPricing(signal);
    const key=hash({endpoint,body,schema:SCHEMA_REVISION,...(idempotencyKey===undefined?{}:{idempotencyKey})});
    // Decisions are optional helpers: they keep a share of the call cap free so they can never starve chat.
    const saved=endpoint==='decisions'?await this.options.ledger.reserve(key,reservation,{reservedCallFraction:this.reservedCallFraction}):await this.options.ledger.reserve(key,reservation);
    if (!saved.created) {
      if (saved.request.response!==null) {
        const result=object(saved.request.response);
        const cost=reportedCostMicrousd(result);
        // Old cached embedding responses may contain cost despite a previously unknown ledger state.
        // Reconcile locally from that response; never submit a second billable request.
        if(saved.request.state==='unknown'&&cost!==null) await this.options.ledger.finish(key,cost,null,saved.request.generationId);
        if(cost!==null&&cost>saved.request.reservedMicrousd) throw new ProviderError('PROVIDER_COST_EXCEEDS_RESERVATION');
        return result;
      }
      throw new ProviderError('REQUEST_UNRESOLVED_NO_RESUBMIT');
    }
    if (signal.aborted) { await this.options.ledger.finish(key,0,null,null); throw new ProviderError('CANCELLED'); }
    // Mark before network I/O. Crashes/timeouts keep the reservation and cannot trigger a repeat POST.
    await this.options.ledger.submitted(key);
    try {
      const result=await this.checkedFetch(endpoint==='decisions'?DECISIONS_URL:`${API}/${endpoint}`,{method:'POST',headers:{Authorization:`Bearer ${this.options.apiKey}`,'Content-Type':'application/json'},body:JSON.stringify(body)},signal);
      const generationId=typeof result.id==='string'?result.id:null;
      // Settle an explicitly reported valid cost for either endpoint. Missing/invalid cost stays unknown.
      const cost=reportedCostMicrousd(result);
      await this.options.ledger.finish(key,cost,result,generationId);
      if (cost!==null&&cost>reservation) throw new ProviderError('PROVIDER_COST_EXCEEDS_RESERVATION');
      return result;
    } catch(error) {
      await this.options.ledger.finish(key,null,null,null);
      throw error instanceof ProviderError?error:new ProviderError('PROVIDER_REQUEST_FAILED');
    }
  }
  /**
   * `idempotencyKey` (never sent) scopes the ledger entry, e.g. to one turn; `maxOutputTokens` may lower (never raise)
   * the configured output cap; `onUsage` receives the reported token counts.
   */
  async generate(messages:ProviderMessage[],options:{signal:AbortSignal;idempotencyKey?:string;maxOutputTokens?:number;
    onUsage?:(usage:{promptTokens:number|null;completionTokens:number|null})=>void;onServed?:(upstream:string)=>void}):Promise<string> {
    aborted(options.signal);
    if (!Array.isArray(messages)||!messages.length||messages.length>64||messages.some(message=>!message||!['system','user','assistant'].includes(message.role)||typeof message.content!=='string'||Object.keys(message).some(key=>!['role','content'].includes(key)))) throw new ProviderError('INVALID_INPUT');
    const bytes=Buffer.byteLength(JSON.stringify(messages),'utf8');
    if (bytes>this.inputBytes) throw new ProviderError('INPUT_LIMIT');
    const timeline=messages.some(message=>message.role==='system'&&message.content.includes('TIMELINE_JSON_REPLY'));
    const agent=messages.some(message=>message.role==='system'&&message.content.includes('AGENT_JSON_REPLY'));
    // The catalog decides structured-output support, so it is read before the body is built.
    await this.verifyPricing(options.signal);
    const responseFormat=agent&&TEXT_MODELS[this.model]!.agentSchema&&this.structuredOutputs
      ?{type:'json_schema',json_schema:{name:'agent_reply',strict:true,schema:AGENT_RESPONSE_JSON_SCHEMA}}
      :timeline?{type:'json_object'}:undefined;
    const outputTokens=Number.isInteger(options.maxOutputTokens)&&options.maxOutputTokens!>=1?Math.min(options.maxOutputTokens!,this.outputTokens):this.outputTokens;
    // Choke point: chat-template control tokens are neutralized before the body (and its ledger key) is built.
    const body:Json={model:this.model,messages:neutralizeMessages(messages),max_tokens:outputTokens,temperature:0,stream:false,provider:this.provider(false),
      ...(TEXT_MODELS[this.model]!.reasoning?{reasoning:TEXT_MODELS[this.model]!.reasoning}:{}),
      ...(responseFormat?{response_format:responseFormat}:{})};
    // UTF8 bytes upper-bound content tokenization; generous per-message + fixed envelope overhead.
    const inputUpperBound=bytes+messages.length*64+1024;
    // Reserve both full prompt and maximum cache-write price, even if automatic caching occurs.
    const {prompt,completion}=TEXT_MODELS[this.model]!;
    const reserved=Math.ceil(inputUpperBound*2*prompt+outputTokens*completion);
    const result=await this.request(body,'chat/completions',reserved,options.signal,options.idempotencyKey);
    if (result.model!==undefined&&result.model!==this.model) throw new ProviderError('MODEL_MISMATCH');
    if (!Array.isArray(result.choices)||result.choices.length!==1) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
    const content=object(object(result.choices[0]).message).content;
    if (typeof content!=='string'||!content.trim()||Buffer.byteLength(content,'utf8')>65536) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
    if (options.onUsage&&result.usage&&typeof result.usage==='object') {
      const usage=result.usage as Json;const count=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>=0?value:null;
      options.onUsage({promptTokens:count(usage.prompt_tokens),completionTokens:count(usage.completion_tokens)});
    }
    options.onServed?.('openrouter');
    return content;
  }
  /** Decisions API (System One models such as Jev): same ledger, caps and no-resubmission rule as text/embeddings. */
  async decide(request:{model:string;state:Json;questions:Json},options:{signal:AbortSignal;idempotencyKey?:string}):Promise<Json> {
    aborted(options.signal);
    if (!Object.hasOwn(DECISION_MODELS,request.model)) throw new ProviderError('MODEL_NOT_ALLOWED');
    const body:Json={model:request.model,state:neutralizeJsonStrings(request.state),questions:request.questions,provider:{data_collection:'deny',zdr:true,allow_fallbacks:false,
      // Decisions API ProviderPreferences.max_price (string USD per million tokens); output tokens are free.
      max_price:{prompt:String(DECISION_MODELS[request.model]!.prompt),completion:'0',request:'0'}}};
    const bytes=Buffer.byteLength(JSON.stringify(body),'utf8');
    if (bytes>this.inputBytes) throw new ProviderError('INPUT_LIMIT');
    await untilAborted(this.checkDecisionPrice(request.model),options.signal);
    // UTF8 bytes upper-bound tokens; the allowance covers the provider's decision template (measured 2026-10-08: about
    // 490 input tokens for one question and 1570 for eight, including state, so 1024 + 512 per question stays conservative).
    const questions=Math.max(1,Object.keys(request.questions).length);
    const result=await this.request(body,'decisions',Math.ceil((bytes+DECISION_BASE_ALLOWANCE+DECISION_QUESTION_ALLOWANCE*questions)*DECISION_MODELS[request.model]!.prompt),options.signal,options.idempotencyKey);
    // Responses name the dated snapshot that served the pinned release.
    if (typeof result.model!=='string'||result.model!==request.model&&!(result.model.startsWith(`${request.model}-`)&&/^\d{8}$/.test(result.model.slice(request.model.length+1)))) throw new ProviderError('MODEL_MISMATCH');
    return result;
  }
  async embed(inputs:string[],options:{signal:AbortSignal}):Promise<number[][]> {
    aborted(options.signal);
    if (!Array.isArray(inputs)||!inputs.length||inputs.length>32||inputs.some(input=>typeof input!=='string'||!input.trim())) throw new ProviderError('INVALID_INPUT');
    const bytes=Buffer.byteLength(JSON.stringify(inputs),'utf8');
    if (bytes>this.inputBytes) throw new ProviderError('INPUT_LIMIT');
    const body:Json={model:EMBEDDING_MODEL,input:[...inputs],encoding_format:'float',dimensions:EMBEDDING_DIMENSIONS,provider:this.provider(true)};
    const result=await this.request(body,'embeddings',Math.ceil((bytes+inputs.length*64+1024)*0.02),options.signal);
    if (normalizeEmbeddingModel(result.model)!==EMBEDDING_MODEL||!Array.isArray(result.data)||result.data.length!==inputs.length) throw new ProviderError('INVALID_EMBEDDINGS');
    const vectors:number[][]=new Array(inputs.length);
    for (const value of result.data) {
      const item=object(value); const index=item.index; const vector=item.embedding;
      if (typeof index!=='number'||!Number.isInteger(index)||index<0||index>=inputs.length||vectors[index]||!Array.isArray(vector)||vector.length!==EMBEDDING_DIMENSIONS||vector.some(number=>typeof number!=='number'||!Number.isFinite(number))) throw new ProviderError('INVALID_EMBEDDINGS');
      vectors[index]=vector as number[];
    }
    return vectors;
  }
  // Explicit reconciliation is GET-only and never resubmits an ambiguous generation.
  async reconcile(requestKey:string,signal:AbortSignal):Promise<void> {
    const request=await this.options.ledger.get(requestKey);
    if (!request?.generationId) throw new ProviderError('GENERATION_ID_UNAVAILABLE');
    const result=await this.checkedFetch(`${API}/generation?id=${encodeURIComponent(request.generationId)}`,{headers:{Authorization:`Bearer ${this.options.apiKey}`}},signal);
    const data=object(result.data); const cost=data.total_cost;
    if (typeof cost!=='number'||!Number.isFinite(cost)||cost<0) throw new ProviderError('COST_UNAVAILABLE');
    await this.options.ledger.finish(requestKey,Math.ceil(cost*1_000_000),null,request.generationId);
  }
}
/**
 * Direct (no gateway) chat provider. The core's per-turn `requestKey` is deliberately NOT used as the ledger
 * `idempotencyKey`: direct callers keep body-only keys so research reruns replay settled responses. Only the gateway
 * maps X-PTR-Request-Key to `idempotencyKey`.
 */
export class OpenRouterTextProvider implements TextProvider {
  constructor(private readonly client:OpenRouterClient) {}
  generate(messages:ProviderMessage[],options:{signal:AbortSignal}):Promise<string> { return this.client.generate(messages,options); }
}
export class OpenRouterEmbeddingProvider {
  readonly model=EMBEDDING_MODEL;
  readonly dimensions=EMBEDDING_DIMENSIONS;
  constructor(private readonly client:OpenRouterClient) {}
  embed(inputs:string[],options:{signal:AbortSignal}):Promise<number[][]> { return this.client.embed(inputs,options); }
}
