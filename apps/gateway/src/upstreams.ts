import type { ProviderMessage } from '@ptr/contracts';
import type { FailoverMetrics, PoolMetrics } from './pool';

export interface ChatCompletionRequest { messages:{role:string;content:string}[]; stream?:boolean; [key:string]:unknown }
/** Per-request context from the caller: `requestKey` (X-PTR-Request-Key, the worker's turn id) scopes billing idempotency. */
export interface RequestContext {
  requestKey?:string;
  /** X-PTR-Priority: 1 = a running turn's follow-up call, 0 = a turn's first call (default), −1 = batch (sheddable). */
  priority?:1|0|-1;
  /** X-PTR-Flow: fairness key for DRR (hex, e.g. a hash of the owner). */
  flow?:string;
}
/** What an upstream hands back: an HTTP-like status and a body the gateway relays as-is. `upstream`: set by failover only. */
export interface UpstreamResult { status:number; contentType:string; body:AsyncIterable<Uint8Array>|string; upstream?:'primary'|'secondary' }
export interface Upstream {
  readonly model:string; complete(request:ChatCompletionRequest,signal:AbortSignal,context?:RequestContext):Promise<UpstreamResult>;
  failoverMetrics?():FailoverMetrics;
  /** Upstream pools (file or registry discovery) only. */
  poolMetrics?():PoolMetrics;
  /** Checked once before the gateway listens; a rejection fails startup. */
  ready?(signal:AbortSignal):Promise<void>;
  /** A pool that owns admission (S3): the gateway skips its own limiter and reports these numbers. */
  admission?():{inFlight:number;queued:number;maxConcurrent:number;maxQueue:number};
  /** Stops background work (registry polling) at shutdown. */
  close?():Promise<void>;
}

/**
 * A primary call that failed before any response arrived. `certain`: the request provably never left this process
 * (the connection was never established), so another upstream may serve it without any chance of a duplicate.
 */
export class UpstreamConnectError extends Error {
  constructor(readonly reason:'connect_refused'|'connect_timeout'|'connect_error'|'dns'|'closed_before_response',readonly certain:boolean) {
    super(reason);this.name='UpstreamConnectError';
  }
}
/**
 * Classifies a rejected fetch. Connection-phase errors (refused, connect timeout, any error raised by the `connect`
 * syscall, name resolution) happen before undici writes a byte. A socket closed or reset after connecting
 * (UND_ERR_SOCKET, ECONNRESET on read, EPIPE) may follow a fully sent request: ambiguous. Aborts/timeouts: undefined.
 */
export function classifyTransportError(error:unknown):UpstreamConnectError|undefined {
  // fetch rejects with TypeError('fetch failed') + cause; checked by name because undici may run in another realm.
  if((error as {name?:unknown})?.name!=='TypeError') return undefined;
  const cause=(error as {cause?:{code?:unknown;syscall?:unknown}}).cause;
  const code=typeof cause?.code==='string'?cause.code:'', syscall=cause?.syscall;
  // undici's own headers/body timeouts follow a fully sent request: possibly reached, so not a connect failure.
  if(code==='UND_ERR_HEADERS_TIMEOUT'||code==='UND_ERR_BODY_TIMEOUT') return undefined;
  if(code==='ECONNREFUSED') return new UpstreamConnectError('connect_refused',true);
  if(code==='UND_ERR_CONNECT_TIMEOUT') return new UpstreamConnectError('connect_timeout',true);
  if(syscall==='connect') return new UpstreamConnectError('connect_error',true);
  if(syscall==='getaddrinfo'||code==='ENOTFOUND'||code==='EAI_AGAIN') return new UpstreamConnectError('dns',true);
  return new UpstreamConnectError('closed_before_response',false);
}

/** vLLM's /metrics is tens of KiB; anything far larger is not read into memory. */
const METRICS_MAX_BYTES=1024*1024;
/** Self-hosted OpenAI-compatible engine (vLLM/SGLang through an SSH tunnel); the gateway pins the model. */
export class OpenAICompatibleUpstream implements Upstream {
  readonly model:string;
  private readonly endpoint:string;
  private readonly healthUrl:string;
  constructor(options:{baseUrl:string;model:string}) {
    const url=new URL(options.baseUrl);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash) throw new Error('UPSTREAM_NOT_LOOPBACK');
    this.model=options.model;this.endpoint=`${options.baseUrl.replace(/\/$/,'')}/chat/completions`;this.healthUrl=`${url.origin}/health`;
  }
  async complete(request:ChatCompletionRequest,signal:AbortSignal):Promise<UpstreamResult> {
    let response:Response;
    try {response=await fetch(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,model:this.model}),signal,redirect:'error'});}
    catch(error) {
      if(signal.aborted) throw error;
      const code=(error as {cause?:{code?:unknown}})?.cause?.code;
      if(code==='UND_ERR_HEADERS_TIMEOUT'||code==='UND_ERR_BODY_TIMEOUT') throw new DOMException('upstream response timeout','TimeoutError');
      throw classifyTransportError(error)??error;
    }
    // Error bodies are never relayed; release the connection now instead of at garbage collection.
    if(!response.ok){await response.body?.cancel().catch(()=>undefined);return {status:response.status,contentType:'application/json',body:''};}
    return {status:response.status,contentType:response.headers.get('content-type')??'application/json',
      body:response.body?(response.body as unknown as AsyncIterable<Uint8Array>):''};
  }
  /** The engine's Prometheus text (`GET {origin}/metrics`) for the telemetry filter; null on a non-200 answer or over 1 MiB. */
  async metrics(signal:AbortSignal):Promise<string|null> {
    const response=await fetch(`${new URL(this.healthUrl).origin}/metrics`,{signal,redirect:'error'});
    if(!response.ok||!response.body) {await response.body?.cancel().catch(()=>undefined);return null;}
    const chunks:Uint8Array[]=[];let size=0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size+=chunk.byteLength;
      if(size>METRICS_MAX_BYTES) {await response.body.cancel().catch(()=>undefined);return null;}
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  /** vLLM/SGLang `GET /health`: 200 only while the engine is alive (vLLM answers 503 once EngineCore is dead). */
  async health(signal:AbortSignal):Promise<boolean> {
    try {const response=await fetch(this.healthUrl,{signal,redirect:'error'});await response.body?.cancel().catch(()=>undefined);return response.ok;}
    catch {return false;}
  }
}

/** In-process model; the OpenRouter client also takes a ledger idempotency key, an output cap and a usage callback. */
export interface InProcessTextProvider {
  generate(messages:ProviderMessage[],options:{signal:AbortSignal;idempotencyKey?:string;maxOutputTokens?:number;
    onUsage?:(usage:{promptTokens:number|null;completionTokens:number|null})=>void}):Promise<string>;
}
/** Wraps an in-process TextProvider (fake load model, or the OpenRouter client with its budget ledger) as an upstream. */
export class TextProviderUpstream implements Upstream {
  constructor(private readonly provider:InProcessTextProvider,readonly model:string,readonly ready?:(signal:AbortSignal)=>Promise<void>) {}
  async complete(request:ChatCompletionRequest,signal:AbortSignal,context?:RequestContext):Promise<UpstreamResult> {
    const messages=request.messages.map(({role,content})=>({role,content})) as ProviderMessage[];
    let usage:{prompt_tokens:number|null;completion_tokens:number|null}|undefined;
    // The caller's max_tokens may lower the provider's own cap; temperature stays the provider's (0, as the worker sends).
    const content=await this.provider.generate(messages,{signal,...(context?.requestKey?{idempotencyKey:context.requestKey}:{}),
      ...(typeof request.max_tokens==='number'?{maxOutputTokens:request.max_tokens}:{}),
      onUsage:reported=>{usage={prompt_tokens:reported.promptTokens,completion_tokens:reported.completionTokens};}});
    const created=Math.floor(Date.now()/1000);
    if(!request.stream) return {status:200,contentType:'application/json',body:JSON.stringify({object:'chat.completion',created,model:this.model,
      choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],...(usage?{usage}:{})})};
    const chunk=(data:unknown)=>`data: ${JSON.stringify(data)}\n\n`;
    // One chunk: the whole reply (time to first token equals the total for this upstream), with usage when reported.
    return {status:200,contentType:'text/event-stream',body:
      chunk({object:'chat.completion.chunk',created,model:this.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],...(usage?{usage}:{})})+'data: [DONE]\n\n'};
  }
}
