import type { ProviderMessage } from '@ptr/contracts';
import { AGENT_RESPONSE_JSON_SCHEMA, type TextProvider } from '@ptr/core';
import { ProviderError } from './budget';

/** Per-call serving metrics; TTFT comes from the first streamed content delta. */
export interface CallMetrics {
  model:string; ok:boolean; error?:string;
  ttftMs:number|null; totalMs:number; promptTokens:number|null; completionTokens:number|null;
  /** HTTP requests this call sent (1 + retries). */
  attempts:number;
}
export interface OpenAICompatibleOptions {
  /**
   * Self-hosted engine (vLLM/SGLang) reached through an SSH tunnel, or the LLM gateway: loopback only. A list is in
   * priority order: calls start at the first and move to the next on a refused/reset connection or a `draining` rejection.
   */
  baseUrl:string|readonly string[]; model:string;
  maxOutputTokens?:number; timeoutMs?:number; fetch?:typeof fetch;
  onMetrics?:(metrics:CallMetrics)=>void;
  /** Guided decoding: send the agent reply JSON Schema so the engine enforces the shape the app validates. */
  structuredAgentReplies?:boolean;
  /** Bearer token, e.g. for the LLM gateway. */
  apiKey?:string;
  /**
   * Gateway connection resets (closed before headers, or while reading the stream) retried per call; only for calls
   * with a request key, which makes a resend idempotent at the gateway. Default 0: direct engines and benchmarks fail.
   */
  resetRetries?:number;
  /** A reset is retried only while at least this much remains of the call deadline and the turn's `deadlineAt` (default 5000 ms). */
  retryMinRemainingMs?:number;
  /** Uniform [0,1) source for retry jitter (tests inject a seeded one). */
  random?:()=>number;
}
/** Per-turn request key accepted by the gateway (`X-PTR-Request-Key`). */
export const REQUEST_KEY=/^[A-Za-z0-9._:-]{1,128}$/;
/** The gateway marks requests it refused before contacting any upstream; those are safe to resend. */
const GATEWAY_REJECTED='rejected';
/** A refused connection means the request never left this process (e.g. the gateway is restarting): also safe to resend. */
const refused=(error:unknown)=>(error as {cause?:{code?:string}})?.cause?.code==='ECONNREFUSED';
/**
 * Undici transport codes treated as a reset: the connection broke before the headers or mid-stream (undici rejects
 * fetch with TypeError('fetch failed', {cause}) and errors the body with TypeError('terminated', {cause})), or it could
 * not connect at all. Anything else (bad port, unexpected redirect, a TypeError without a cause) is not retried.
 */
const RESET_CODES=new Set(['ECONNRESET','EPIPE','ECONNABORTED','UND_ERR_SOCKET','UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT','EHOSTUNREACH','ENETUNREACH']);
/** A 200 stream that ended cleanly without `[DONE]` or a finish_reason: cut short, so treated like a mid-stream reset. */
class StreamEndedEarly extends Error {}
/** Checked by name, not instanceof: jest runs tests in another realm. */
const transportReset=(error:unknown)=>error instanceof StreamEndedEarly
  ||(error as {name?:unknown})?.name==='TypeError'&&RESET_CODES.has(String((error as {cause?:{code?:unknown}}).cause?.code));
/** Full jitter for reset retry `attempt` (0-based): U(0, min(2000, 200·2^attempt)) ms. */
export const gatewayResetBackoffMs=(attempt:number,random:()=>number)=>random()*Math.min(2000,200*2**attempt);
/**
 * Wait after a marked gateway rejection: min(Retry-After (else 250 ms), 5 s) × U(0.5, 1.5). The cap comes before the
 * jitter so retries after a long Retry-After still spread out (2.5–7.5 s) instead of bunching at the cap.
 */
export function gatewayRejectedBackoffMs(retryAfter:string|null,random:()=>number):number {
  const after=retryAfter===null||retryAfter.trim()===''?NaN:Number(retryAfter);
  return Math.min(Number.isFinite(after)&&after>=0?after*1000:250,5000)*(0.5+random());
}
const sleep=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  const onAbort=()=>{clearTimeout(timer);reject(new ProviderError('CANCELLED'));};
  const timer=setTimeout(()=>{signal.removeEventListener('abort',onAbort);resolve();},ms);
  signal.addEventListener('abort',onAbort,{once:true});
});
type Json=Record<string,unknown>;

/**
 * OpenAI-compatible chat adapter for self-hosted serving engines or the LLM gateway in front of them. No billing
 * ledger here: GPU time is accounted per run, and a billable upstream behind the gateway keeps its own ledger.
 * Gateway admission rejections (429/503 marked `X-PTR-Gateway: rejected`) and refused connections are retried
 * (jittered Retry-After, or a short backoff) until the caller's signal or the timeout ends the call. Connection resets
 * (before the headers or mid-stream) are retried only when `resetRetries` is set and the call has a request key, a
 * bounded number of times and only with `retryMinRemainingMs` left. Every other error (HTTP errors, our abort or
 * timeout, invalid output) surfaces at once, because the request may already have reached a model.
 */
export class OpenAICompatibleTextProvider implements TextProvider {
  private readonly fetcher:typeof fetch;
  private readonly endpoints:string[];
  constructor(private readonly options:OpenAICompatibleOptions) {
    const baseUrls=typeof options.baseUrl==='string'?[options.baseUrl]:[...options.baseUrl];
    if(!baseUrls.length) throw new ProviderError('ENDPOINT_NOT_LOOPBACK');
    if(new Set(baseUrls.map(baseUrl=>baseUrl.replace(/\/$/,''))).size!==baseUrls.length) throw new ProviderError('ENDPOINT_DUPLICATE');
    for(const baseUrl of baseUrls) {
      const url=new URL(baseUrl);
      if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash)
        throw new ProviderError('ENDPOINT_NOT_LOOPBACK');
    }
    if(!options.model.trim()) throw new ProviderError('MODEL_NOT_ALLOWED');
    this.endpoints=baseUrls.map(baseUrl=>`${baseUrl.replace(/\/$/,'')}/chat/completions`);
    this.fetcher=options.fetch??fetch;
  }
  async generate(messages:ProviderMessage[],options:{signal:AbortSignal;requestKey?:string;deadlineAt?:number}):Promise<string> {
    if(options.signal.aborted) throw new ProviderError('CANCELLED');
    const started=performance.now();let ttftMs:number|null=null;
    let promptTokens:number|null=null, completionTokens:number|null=null, attempts=0;
    const report=(ok:boolean,error?:string)=>this.options.onMetrics?.({model:this.options.model,ok,...(error?{error}:{}),ttftMs,
      totalMs:Math.round(performance.now()-started),promptTokens,completionTokens,attempts});
    const json=messages.some(message=>message.role==='system'&&/TIMELINE_JSON_REPLY|AGENT_JSON_REPLY/.test(message.content));
    const agent=messages.some(message=>message.role==='system'&&message.content.includes('AGENT_JSON_REPLY'));
    const responseFormat=agent&&this.options.structuredAgentReplies
      ?{type:'json_schema',json_schema:{name:'agent_reply',schema:AGENT_RESPONSE_JSON_SCHEMA}}
      :json?{type:'json_object'}:undefined;
    const body={model:this.options.model,messages:messages.map(({role,content})=>({role,content})),
      max_tokens:this.options.maxOutputTokens??512,temperature:0,stream:true,stream_options:{include_usage:true},
      chat_template_kwargs:{enable_thinking:false},...(responseFormat?{response_format:responseFormat}:{})};
    const timeoutMs=this.options.timeoutMs??30000, deadline=started+timeoutMs;
    const timeout=AbortSignal.timeout(timeoutMs);
    const signal=AbortSignal.any([options.signal,timeout]);
    const random=this.options.random??Math.random;
    try {
      const keyed=!!options.requestKey&&REQUEST_KEY.test(options.requestKey);
      const headers={'Content-Type':'application/json',...(this.options.apiKey?{Authorization:`Bearer ${this.options.apiKey}`}:{}),
        // The gateway scopes a billable secondary's ledger entry to this key (the turn id); malformed keys are not sent.
        ...(keyed?{'X-PTR-Request-Key':options.requestKey!}:{})};
      // Calls start at the first URL; `next()` moves on and reports whether it wrapped around to the first again.
      let index=0, refusedAttempt=0, resets=0;
      const next=()=>{index=(index+1)%this.endpoints.length;return index===0;};
      // Time left: the earlier of this call's deadline and the turn's (the turn usually ends first: 30 s vs 60 s).
      const remainingMs=()=>Math.min(deadline-performance.now(),options.deadlineAt===undefined?Infinity:options.deadlineAt-Date.now());
      // A reset may have reached a model, but the request key makes the resend idempotent at the gateway (§ reset retries).
      const minRemainingMs=this.options.retryMinRemainingMs??5000;
      // A resend is pointless when its wait would leave less than retryMinRemainingMs of the call or turn.
      const canResend=(waitMs:number)=>remainingMs()>=waitMs+minRemainingMs;
      const retryReset=async(error:unknown)=>{
        if(signal.aborted||!keyed||!transportReset(error)||resets>=(this.options.resetRetries??0)
          ||!canResend(0)) throw error;
        next();await sleep(gatewayResetBackoffMs(resets++,random),signal);
      };
      for(;;) {
        let response:Response;
        attempts++;
        try {response=await this.fetcher(this.endpoints[index]!,{method:'POST',headers,body:JSON.stringify(body),signal,redirect:'error'});}
        catch(error) {
          if(refused(error)&&!signal.aborted) {
            const wrapped=next(), waitMs=wrapped?Math.min(100*2**refusedAttempt,1000):0;
            if(!canResend(waitMs)) throw error;
            if(wrapped) {refusedAttempt++;await sleep(waitMs,signal);}
            continue;
          }
          await retryReset(error);continue;
        }
        if((response.status===429||response.status===503)&&response.headers.get('x-ptr-gateway')===GATEWAY_REJECTED) {
          await response.body?.cancel().catch(()=>undefined);
          // A draining gateway sends us to the next URL at once; otherwise wait (jittered) and try the same one again.
          // Either way, too little time left for the wait plus retryMinRemainingMs fails now with the rejection's code.
          const rejected=new ProviderError(`PROVIDER_HTTP_${response.status}`);
          if(response.headers.get('x-ptr-gateway-reason')==='draining'&&!next()) {if(!canResend(0)) throw rejected;continue;}
          const waitMs=gatewayRejectedBackoffMs(response.headers.get('retry-after'),random);
          if(!canResend(waitMs)) throw rejected;
          await sleep(waitMs,signal);
          continue;
        }
        if(!response.ok||!response.body) throw new ProviderError(`PROVIDER_HTTP_${response.status}`);
        let text='', buffer='', complete=false;
        const decoder=new TextDecoder();
        try {
          for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
            buffer+=decoder.decode(chunk,{stream:true});
            let boundary:number;
            while((boundary=buffer.indexOf('\n\n'))>=0) {
              const event=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
              for(const line of event.split('\n')) {
                if(!line.startsWith('data: ')) continue;
                const data=line.slice(6).trim();
                if(data==='[DONE]') {complete=true;continue;}
                const parsed=JSON.parse(data) as Json;
                const usage=parsed.usage as Json|undefined;
                if(usage) {promptTokens=Number(usage.prompt_tokens??0)||null;completionTokens=Number(usage.completion_tokens??0)||null;}
                for(const choice of (parsed.choices as Json[]|undefined)??[]) {
                  if(choice.finish_reason) complete=true;
                  const content=(choice.delta as Json|undefined)?.content;
                  if(typeof content==='string'&&content) {if(ttftMs===null) ttftMs=Math.round(performance.now()-started);text+=content;}
                }
              }
            }
            if(text.length>65536) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
          }
          if(!complete) throw new StreamEndedEarly();
        } catch(error) {
          // The stream broke: the partial text is dropped (only a complete answer is ever returned), with its metrics.
          await retryReset(error);
          ttftMs=null;promptTokens=null;completionTokens=null;continue;
        }
        if(!text.trim()) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
        report(true);return text;
      }
    } catch(error) {
      const code=error instanceof ProviderError?error.code:options.signal.aborted?'CANCELLED':timeout.aborted?'PROVIDER_TIMEOUT':'PROVIDER_TRANSPORT';
      report(false,code);
      throw error instanceof ProviderError?error:new ProviderError(code);
    }
  }
}

/** Admission capacity a gateway reports in `/metrics`: Σ upstream concurrency caps + its queue bound. */
export interface GatewayCapacity { maxConcurrent:number; maxQueue:number; total:number }
/**
 * Operating rule: Σ worker concurrency ≤ Σ upstream caps + gateway max queue. Above it, a burst gets 429
 * GATEWAY_QUEUE_FULL and those calls wait in jittered client retries (bounded by the turn deadline) rather than in
 * BullMQ, where waiting costs nothing. Advisory only.
 */
export function gatewayCapacityWarning({workerConcurrency,replicas,capacity}:{workerConcurrency:number;replicas:number;capacity:GatewayCapacity}):string|null {
  const total=workerConcurrency*replicas;
  return total<=capacity.total?null:`WARNING gateway capacity: worker concurrency ${workerConcurrency} x replicas ${replicas} = ${total} > gateway capacity ${capacity.total} (upstream caps ${capacity.maxConcurrent} + queue ${capacity.maxQueue}); calls above it are refused with 429 and wait in client retries until the turn deadline instead of in BullMQ`;
}
/** Capacity from the first loopback gateway whose `/metrics` answers with one; null when none does. Never throws. */
export async function fetchGatewayCapacity(baseUrls:readonly string[],token:string,fetcher:typeof fetch=fetch,timeoutMs=2000):Promise<GatewayCapacity|null> {
  for(const baseUrl of baseUrls) {
    try {
      const url=new URL('/metrics',baseUrl);if(url.hostname!=='127.0.0.1') continue;
      const response=await fetcher(String(url),{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
      if(!response.ok) continue;
      const capacity=((await response.json()) as {capacity?:Partial<GatewayCapacity>}).capacity;
      if(capacity&&[capacity.maxConcurrent,capacity.maxQueue,capacity.total].every(Number.isFinite)) return capacity as GatewayCapacity;
    } catch {/* next URL */}
  }
  return null;
}
