import type { ProviderMessage } from '@ptr/contracts';
import type { TextProvider } from '@ptr/core';
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
}
type Json=Record<string,unknown>;

/**
 * OpenAI-compatible chat adapter for self-hosted serving engines. No billing ledger: GPU time is not
 * charged per request, so cost is accounted per run (GPU hours), not per call.
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
    const body={model:this.options.model,messages:messages.map(({role,content})=>({role,content})),
      max_tokens:this.options.maxOutputTokens??512,temperature:0,stream:true,stream_options:{include_usage:true},
      chat_template_kwargs:{enable_thinking:false},...(json?{response_format:{type:'json_object'}}:{})};
    const timeout=AbortSignal.timeout(this.options.timeoutMs??30000);
    const signal=AbortSignal.any([options.signal,timeout]);
    try {
      const response=await this.fetcher(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal,redirect:'error'});
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
