import type { ProviderMessage } from '@ptr/contracts';
import type { TextProvider } from '@ptr/core';

export interface ChatCompletionRequest { messages:{role:string;content:string}[]; stream?:boolean; [key:string]:unknown }
/** What an upstream hands back: an HTTP-like status and a body the gateway relays as-is. */
export interface UpstreamResult { status:number; contentType:string; body:AsyncIterable<Uint8Array>|string }
export interface Upstream { readonly model:string; complete(request:ChatCompletionRequest,signal:AbortSignal):Promise<UpstreamResult> }

/** Self-hosted OpenAI-compatible engine (vLLM/SGLang through an SSH tunnel); the gateway pins the model. */
export class OpenAICompatibleUpstream implements Upstream {
  readonly model:string;
  private readonly endpoint:string;
  constructor(options:{baseUrl:string;model:string}) {
    const url=new URL(options.baseUrl);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash) throw new Error('UPSTREAM_NOT_LOOPBACK');
    this.model=options.model;this.endpoint=`${options.baseUrl.replace(/\/$/,'')}/chat/completions`;
  }
  async complete(request:ChatCompletionRequest,signal:AbortSignal):Promise<UpstreamResult> {
    const response=await fetch(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...request,model:this.model}),signal,redirect:'error'});
    // Error bodies are never relayed; release the connection now instead of at garbage collection.
    if(!response.ok){await response.body?.cancel().catch(()=>undefined);return {status:response.status,contentType:'application/json',body:''};}
    return {status:response.status,contentType:response.headers.get('content-type')??'application/json',
      body:response.body?(response.body as unknown as AsyncIterable<Uint8Array>):''};
  }
}

/** Wraps an in-process TextProvider (fake load model, or the OpenRouter client with its budget ledger) as an upstream. */
export class TextProviderUpstream implements Upstream {
  constructor(private readonly provider:TextProvider,readonly model:string) {}
  async complete(request:ChatCompletionRequest,signal:AbortSignal):Promise<UpstreamResult> {
    const messages=request.messages.map(({role,content})=>({role,content})) as ProviderMessage[];
    const content=await this.provider.generate(messages,{signal});
    const created=Math.floor(Date.now()/1000);
    if(!request.stream) return {status:200,contentType:'application/json',body:JSON.stringify({object:'chat.completion',created,model:this.model,
      choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]})};
    const chunk=(data:unknown)=>`data: ${JSON.stringify(data)}\n\n`;
    return {status:200,contentType:'text/event-stream',body:
      chunk({object:'chat.completion.chunk',created,model:this.model,choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}]})+'data: [DONE]\n\n'};
  }
}
