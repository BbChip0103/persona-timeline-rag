import type { ProviderMessage } from '@ptr/contracts';
import { AGENT_RESPONSE_JSON_SCHEMA, type TextProvider } from '@ptr/core';
import { ProviderError } from './budget';

/** Per-call serving metrics; TTFT comes from the first streamed content delta. */
export interface CallMetrics {
  model:string; ok:boolean; error?:string;
  ttftMs:number|null; totalMs:number; promptTokens:number|null; completionTokens:number|null;
}
export interface OpenAICompatibleOptions {
  /** Self-hosted engine (vLLM/SGLang) reached through an SSH tunnel: loopback only. */
  baseUrl:string; model:string;
  maxOutputTokens?:number; timeoutMs?:number; fetch?:typeof fetch;
  onMetrics?:(metrics:CallMetrics)=>void;
  /** Guided decoding: send the agent reply JSON Schema so the engine enforces the shape the app validates. */
  structuredAgentReplies?:boolean;
  /** Bearer token, e.g. for the LLM gateway. */
  apiKey?:string;
}
/** The gateway marks requests it refused before contacting any upstream; only those are safe to resend. */
const GATEWAY_REJECTED='rejected';
const sleep=(ms:number,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(resolve,ms);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(new ProviderError('CANCELLED'));},{once:true});
});
type Json=Record<string,unknown>;

/**
 * OpenAI-compatible chat adapter for self-hosted serving engines or the LLM gateway in front of them. No billing
 * ledger here: GPU time is accounted per run, and a billable upstream behind the gateway keeps its own ledger.
 * Gateway admission rejections (429/503 marked `X-PTR-Gateway: rejected`) are retried after Retry-After until the
 * caller's signal or the timeout ends the call; every other error surfaces at once.
 */
export class OpenAICompatibleTextProvider implements TextProvider {
  private readonly fetcher:typeof fetch;
  private readonly endpoint:string;
  constructor(private readonly options:OpenAICompatibleOptions) {
    const url=new URL(options.baseUrl);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash)
      throw new ProviderError('ENDPOINT_NOT_LOOPBACK');
    if(!options.model.trim()) throw new ProviderError('MODEL_NOT_ALLOWED');
    this.endpoint=`${options.baseUrl.replace(/\/$/,'')}/chat/completions`;
    this.fetcher=options.fetch??fetch;
  }
  async generate(messages:ProviderMessage[],options:{signal:AbortSignal}):Promise<string> {
    if(options.signal.aborted) throw new ProviderError('CANCELLED');
    const started=performance.now();let ttftMs:number|null=null;
    let promptTokens:number|null=null, completionTokens:number|null=null;
    const report=(ok:boolean,error?:string)=>this.options.onMetrics?.({model:this.options.model,ok,...(error?{error}:{}),ttftMs,
      totalMs:Math.round(performance.now()-started),promptTokens,completionTokens});
    const json=messages.some(message=>message.role==='system'&&/TIMELINE_JSON_REPLY|AGENT_JSON_REPLY/.test(message.content));
    const agent=messages.some(message=>message.role==='system'&&message.content.includes('AGENT_JSON_REPLY'));
    const responseFormat=agent&&this.options.structuredAgentReplies
      ?{type:'json_schema',json_schema:{name:'agent_reply',schema:AGENT_RESPONSE_JSON_SCHEMA}}
      :json?{type:'json_object'}:undefined;
    const body={model:this.options.model,messages:messages.map(({role,content})=>({role,content})),
      max_tokens:this.options.maxOutputTokens??512,temperature:0,stream:true,stream_options:{include_usage:true},
      chat_template_kwargs:{enable_thinking:false},...(responseFormat?{response_format:responseFormat}:{})};
    const timeout=AbortSignal.timeout(this.options.timeoutMs??30000);
    const signal=AbortSignal.any([options.signal,timeout]);
    try {
      const headers={'Content-Type':'application/json',...(this.options.apiKey?{Authorization:`Bearer ${this.options.apiKey}`}:{})};
      let response:Response;
      for(;;) {
        response=await this.fetcher(this.endpoint,{method:'POST',headers,body:JSON.stringify(body),signal,redirect:'error'});
        if((response.status===429||response.status===503)&&response.headers.get('x-ptr-gateway')===GATEWAY_REJECTED) {
          await response.body?.cancel().catch(()=>undefined);
          const after=Number(response.headers.get('retry-after'));
          await sleep(Number.isFinite(after)&&after>=0?Math.min(after*1000,5000):250,signal);
          continue;
        }
        break;
      }
      if(!response.ok||!response.body) throw new ProviderError(`PROVIDER_HTTP_${response.status}`);
      let text='', buffer='';
      const decoder=new TextDecoder();
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer+=decoder.decode(chunk,{stream:true});
        let boundary:number;
        while((boundary=buffer.indexOf('\n\n'))>=0) {
          const event=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);
          for(const line of event.split('\n')) {
            if(!line.startsWith('data: ')) continue;
            const data=line.slice(6).trim();
            if(data==='[DONE]') continue;
            const parsed=JSON.parse(data) as Json;
            const usage=parsed.usage as Json|undefined;
            if(usage) {promptTokens=Number(usage.prompt_tokens??0)||null;completionTokens=Number(usage.completion_tokens??0)||null;}
            for(const choice of (parsed.choices as Json[]|undefined)??[]) {
              const content=(choice.delta as Json|undefined)?.content;
              if(typeof content==='string'&&content) {if(ttftMs===null) ttftMs=Math.round(performance.now()-started);text+=content;}
            }
          }
        }
        if(text.length>65536) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
      }
      if(!text.trim()) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
      report(true);return text;
    } catch(error) {
      const code=error instanceof ProviderError?error.code:options.signal.aborted?'CANCELLED':timeout.aborted?'PROVIDER_TIMEOUT':'PROVIDER_TRANSPORT';
      report(false,code);
      throw error instanceof ProviderError?error:new ProviderError(code);
    }
  }
}
