import type { ProviderMessage } from '@ptr/contracts';
import { AGENT_RESPONSE_JSON_SCHEMA, PROVIDER_DEADLINE, type TextProvider } from '@ptr/core';
import { ProviderError } from './budget';
import { neutralizeMessages } from './control-tokens';

export interface CallMetrics {
  model:string;ok:boolean;error?:string;
  ttftMs:number|null;totalMs:number;promptTokens:number|null;completionTokens:number|null;attempts:number;
}
export interface OpenAICompatibleOptions {
  baseUrl:string;model:string;maxOutputTokens?:number;timeoutMs?:number;fetch?:typeof fetch;
  onMetrics?:(metrics:CallMetrics)=>void;structuredAgentReplies?:boolean;apiKey?:string;
}
const SERVED=new Set(['primary','secondary','local','local-pool','fake','direct']);
function loopback(baseUrl:string):boolean {
  let url:URL;try {url=new URL(baseUrl);} catch {return false;}
  return url.protocol==='http:'&&url.hostname==='127.0.0.1'&&!url.username&&!url.password&&!url.search&&!url.hash;
}
const endpointOf=(baseUrl:string)=>`${baseUrl.replace(/\/$/,'')}/chat/completions`;
type Json=Record<string,unknown>;
const requestKeyHeader=(value:string|undefined)=>value&&/^[A-Za-z0-9._:-]{1,128}$/.test(value)?value:undefined;

export class OpenAICompatibleTextProvider implements TextProvider {
  private readonly fetcher:typeof fetch;
  private readonly endpoint:string;
  constructor(private readonly options:OpenAICompatibleOptions) {
    if(!loopback(options.baseUrl)) throw new ProviderError('ENDPOINT_NOT_LOOPBACK');
    if(!options.model.trim()) throw new ProviderError('MODEL_NOT_ALLOWED');
    this.endpoint=endpointOf(options.baseUrl);
    this.fetcher=options.fetch??fetch;
  }
  async generate(messages:ProviderMessage[],options:{signal:AbortSignal;requestKey?:string;deadlineAt?:number;priority?:1|0|-1;
    onServed?:(upstream:string)=>void;onUsage?:(usage:{promptTokens:number|null;completionTokens:number|null})=>void}):Promise<string> {
    if(options.signal.aborted) throw new ProviderError('CANCELLED');
    if(options.deadlineAt!==undefined&&Date.now()>=options.deadlineAt) throw new ProviderError(PROVIDER_DEADLINE);
    const started=performance.now();let ttftMs:number|null=null;
    let promptTokens:number|null=null,completionTokens:number|null=null,attempts=0;
    const report=(ok:boolean,error?:string)=>this.options.onMetrics?.({model:this.options.model,ok,...(error?{error}:{}),ttftMs,
      totalMs:Math.round(performance.now()-started),promptTokens,completionTokens,attempts});
    const json=messages.some(message=>message.role==='system'&&/TIMELINE_JSON_REPLY|AGENT_JSON_REPLY/.test(message.content));
    const agent=messages.some(message=>message.role==='system'&&message.content.includes('AGENT_JSON_REPLY'));
    const responseFormat=agent&&this.options.structuredAgentReplies
      ?{type:'json_schema',json_schema:{name:'agent_reply',schema:AGENT_RESPONSE_JSON_SCHEMA}}
      :json?{type:'json_object'}:undefined;
    const body={model:this.options.model,messages:neutralizeMessages(messages),
      max_tokens:this.options.maxOutputTokens??512,temperature:0,stream:true,stream_options:{include_usage:true},
      chat_template_kwargs:{enable_thinking:false},...(responseFormat?{response_format:responseFormat}:{})};
    const timeoutMs=this.options.timeoutMs??30000;
    const deadlineRemaining=options.deadlineAt===undefined?timeoutMs:Math.max(1,options.deadlineAt-Date.now());
    const effectiveTimeout=Math.min(timeoutMs,deadlineRemaining);
    const deadlineOwnsTimeout=options.deadlineAt!==undefined&&deadlineRemaining<=timeoutMs;
    const timeout=AbortSignal.timeout(effectiveTimeout);
    const signal=AbortSignal.any([options.signal,timeout]);
    try {
      attempts++;
      const requestKey=requestKeyHeader(options.requestKey);
      const response=await this.fetcher(this.endpoint,{method:'POST',headers:{'Content-Type':'application/json',...(this.options.apiKey?{Authorization:`Bearer ${this.options.apiKey}`}:{}),
        ...(requestKey?{'X-PTR-Request-Key':requestKey}:{}),
        ...(options.priority!==undefined?{'X-PTR-Priority':String(options.priority)}:{})},
        body:JSON.stringify(body),signal,redirect:'error'});
      if(!response.ok||!response.body) throw new ProviderError(`PROVIDER_HTTP_${response.status}`);
      let text='',buffer='',complete=false;
      const decoder=new TextDecoder();
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
            if(usage) {
              promptTokens=Number(usage.prompt_tokens??0)||null;
              completionTokens=Number(usage.completion_tokens??0)||null;
            }
            for(const choice of (parsed.choices as Json[]|undefined)??[]) {
              if(choice.finish_reason) complete=true;
              const content=(choice.delta as Json|undefined)?.content;
              if(typeof content==='string'&&content) {if(ttftMs===null) ttftMs=Math.round(performance.now()-started);text+=content;}
            }
          }
        }
        if(text.length>65536) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
      }
      if(!complete||!text.trim()) throw new ProviderError('INVALID_PROVIDER_RESPONSE');
      options.onUsage?.({promptTokens,completionTokens});
      const upstream=response.headers.get('x-ptr-upstream');
      options.onServed?.(upstream===null?'direct':SERVED.has(upstream)?upstream:'unknown');
      report(true);return text;
    } catch(error) {
      const code=error instanceof ProviderError?error.code:options.signal.aborted?'CANCELLED':timeout.aborted&&deadlineOwnsTimeout?PROVIDER_DEADLINE:timeout.aborted?'PROVIDER_TIMEOUT':'PROVIDER_TRANSPORT';
      report(false,code);
      throw error instanceof ProviderError?error:new ProviderError(code);
    }
  }
}
