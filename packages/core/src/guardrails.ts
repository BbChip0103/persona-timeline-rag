import { z } from 'zod';
import type { IntentClassification } from './intent-routing';
import { SAFETY_CATEGORIES, type SafetyCategory, type SafetyProbabilities, type SafetyScores } from './input-safety';
import type { SpeechLevel } from './reply-texts';

const categorySchema=z.enum(SAFETY_CATEGORIES);
const revisionSchema=z.literal('reply-guard-v8');
const intentSchema=z.object({label:z.enum(['timeline','small_talk']),confidence:z.number().min(0).max(1),
  probabilities:z.object({timeline:z.number().min(0).max(1),small_talk:z.number().min(0).max(1)}).strict()}).strict();
const inputResponse=z.object({revision:revisionSchema,action:z.enum(['none','support','refuse','deflect']),
  category:categorySchema.optional(),fired:z.array(categorySchema),intent:intentSchema.optional()}).strict().superRefine((value,context)=>{
  const refusal=['sexual','violence_gore','illegal_dangerous','hate_harassment','private_info'];
  if(new Set(value.fired).size!==value.fired.length||value.action==='none'&&(value.category!==undefined||value.fired.length!==0)
    ||value.action!=='none'&&(value.category===undefined||!value.fired.includes(value.category))
    ||value.action==='support'&&value.category!=='self_harm'||value.action==='deflect'&&value.category!=='prompt_injection'
    ||value.action==='refuse'&&!refusal.includes(value.category??'')) context.addIssue({code:'custom',message:'invalid safety decision'});
});
const outputResponse=z.object({revision:revisionSchema,content:z.string().max(64000),
  reason:z.enum(['human_impersonation','missing_ai_disclosure','private_life','background_denial','meta_talk','formatting']).optional(),
  edited:z.literal(true).optional()}).strict();

export type GuardrailsInputResult=z.infer<typeof inputResponse>;
export type GuardrailsReplyResult=z.infer<typeof outputResponse>;
export interface GuardrailsInput {
  classification?:'jev'|'rules-only';text:string;probabilities:SafetyProbabilities;thresholds:SafetyScores;categories:readonly SafetyCategory[];intent?:IntentClassification;
}
export interface GuardrailsReply {utterance:string;reply:string;realPerson:boolean;language:string;level?:SpeechLevel;previousAssistantText?:string;turnId?:string}
export interface GuardrailsOptions {baseUrl:string;apiKey:string;timeoutMs:number;fetch?:typeof globalThis.fetch}

/** No request/response body, URL, provider error or token appears in this error. The caller must fail closed. */
export class GuardrailsUnavailableError extends Error {
  readonly code='GUARDRAILS_UNAVAILABLE';
  constructor(readonly reason:'timeout'|'aborted'|'transport'|'http'|'invalid_response') {
    super(`Guardrails validation unavailable (${reason})`);this.name='GuardrailsUnavailableError';
  }
}

/** Stateless internal HTTP adapter. One validation request, no automatic retries or generation/reask. */
export class GuardrailsClient {
  private readonly baseUrl:string;
  private readonly fetch:typeof globalThis.fetch;
  constructor(private readonly options:GuardrailsOptions) {
    const url=new URL(options.baseUrl);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash) throw new Error('Invalid Guardrails URL');
    if(options.apiKey.length<16||/[\r\n]/.test(options.apiKey)) throw new Error('Invalid Guardrails API key');
    if(!Number.isFinite(options.timeoutMs)||options.timeoutMs<=0) throw new Error('Invalid Guardrails timeout');
    this.baseUrl=options.baseUrl.replace(/\/+$/u,'');this.fetch=options.fetch??globalThis.fetch;
  }
  async validateInput(input:GuardrailsInput,options:{signal:AbortSignal}):Promise<GuardrailsInputResult> {
    // Explicit projection: runtime callers cannot accidentally send RAG sources, credentials or turn ids.
    if(input.classification==='rules-only'&&Object.keys(input.probabilities).length)throw new Error('Invalid Guardrails rules-only metadata');
    const probabilities=Object.fromEntries(input.categories.map(category=>[category,input.probabilities[category]]));
    return this.request('/validate/input',{text:input.text,metadata:{probabilities,...(input.classification?{classification:input.classification}:{}),
      thresholds:Object.fromEntries(SAFETY_CATEGORIES.map(category=>[category,input.thresholds[category]])),categories:[...input.categories],
      ...(input.intent?{intent:{label:input.intent.label,confidence:input.intent.confidence,
        probabilities:{timeline:input.intent.probabilities.timeline,small_talk:input.intent.probabilities.small_talk}}}:{})}},inputResponse,options.signal);
  }
  async validateReply(input:GuardrailsReply,options:{signal:AbortSignal}):Promise<GuardrailsReplyResult> {
    return this.request('/validate/output',{text:input.reply,metadata:{utterance:input.utterance,realPerson:input.realPerson,
      language:input.language,level:input.level??'polite',...(input.previousAssistantText?{previousAssistantText:input.previousAssistantText}:{}),
      ...(input.turnId?{turnId:input.turnId}:{})}},outputResponse,options.signal);
  }
  private async request<T>(path:string,body:unknown,schema:z.ZodType<T>,signal:AbortSignal):Promise<T> {
    if(signal.aborted) throw new GuardrailsUnavailableError('aborted');
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
    let fail:((reason:GuardrailsUnavailableError)=>void)|undefined;
    const cancellation=new Promise<never>((_,reject)=>{fail=reject;});
    const stop=(reason:'aborted'|'timeout')=>{controller.abort();fail?.(new GuardrailsUnavailableError(reason));};
    const abort=()=>stop('aborted');signal.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>stop('timeout'),this.options.timeoutMs);
    try {
      const operation=(async()=>{
        let response:Response;
        try {response=await this.fetch(`${this.baseUrl}${path}`,{method:'POST',headers:{'content-type':'application/json',
          authorization:`Bearer ${this.options.apiKey}`},body:JSON.stringify(body),signal:controller.signal,redirect:'error'});}
        catch {throw new GuardrailsUnavailableError(signal.aborted?'aborted':'transport');}
        if(!response.ok) throw new GuardrailsUnavailableError('http');
        // Bound both successful and malformed bodies before JSON parsing. Timeout also covers a stalled response body.
        const reader=response.body?.getReader();
        if(!reader) throw new GuardrailsUnavailableError('invalid_response');
        const chunks:Uint8Array[]=[];let size=0;
        try {
          for(;;) {const {value,done}=await reader.read();if(done) break;size+=value.byteLength;
            if(size>512_000) {await reader.cancel();throw new GuardrailsUnavailableError('invalid_response');}chunks.push(value);}
          const joined=new Uint8Array(size);let offset=0;
          for(const chunk of chunks) {joined.set(chunk,offset);offset+=chunk.byteLength;}
          const parsed=schema.safeParse(JSON.parse(new TextDecoder().decode(joined)) as unknown);
          if(!parsed.success) throw new GuardrailsUnavailableError('invalid_response');
          return parsed.data;
        } catch(error) {if(error instanceof GuardrailsUnavailableError) throw error;throw new GuardrailsUnavailableError('invalid_response');}
        finally {reader.releaseLock();}
      })();
      return await Promise.race([operation,cancellation]);
    } finally {if(timer) clearTimeout(timer);signal.removeEventListener('abort',abort);controller.abort();}
  }
}
