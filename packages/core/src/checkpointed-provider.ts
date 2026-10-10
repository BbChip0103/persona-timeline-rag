import { createHash } from 'node:crypto';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { Annotation, END, START, StateGraph, task, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { ProviderMessage } from '@ptr/contracts';
import { CoreError, PROVIDER_DEADLINE, type TextProvider } from './ports';

type GenerateOptions=Parameters<TextProvider['generate']>[1];
interface Receipt {rawResponse:string;upstream?:string;usage?:{promptTokens:number|null;completionTokens:number|null}}
interface CallState {fingerprint:string;receipt?:Receipt}
const State=Annotation.Root({call:Annotation<CallState>()});
const TURN_ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROVIDER_ERROR_CODES=new Set([PROVIDER_DEADLINE,'CANCELLED','PROVIDER_TIMEOUT','INVALID_INPUT','INPUT_LIMIT','INVALID_PROVIDER_RESPONSE','PROVIDER_TRANSPORT']);
function check(options:GenerateOptions):void {
  if(options.signal.aborted)throw new CoreError('TURN_FAILED','TURN_ABORTED');
  if(options.deadlineAt!==undefined&&!Number.isFinite(options.deadlineAt))throw new CoreError('INVALID_INPUT');
  if(options.deadlineAt!==undefined&&Date.now()>=options.deadlineAt)throw Object.assign(new Error(PROVIDER_DEADLINE),{code:PROVIDER_DEADLINE});
}
function validReceipt(value:unknown):value is Receipt {
  if(!value||typeof value!=='object')return false;
  const receipt=value as Receipt;
  const count=(value:unknown)=>value===null||(Number.isSafeInteger(value)&&Number(value)>=0);
  return typeof receipt.rawResponse==='string'&&!!receipt.rawResponse.trim()&&Buffer.byteLength(receipt.rawResponse,'utf8')<=65536&&
    (receipt.upstream===undefined||typeof receipt.upstream==='string'&&/^[a-z0-9_-]{1,40}$/.test(receipt.upstream))&&
    (receipt.usage===undefined||!!receipt.usage&&typeof receipt.usage==='object'&&count(receipt.usage.promptTokens)&&count(receipt.usage.completionTokens));
}
/** Nonbillable TURN calls only. The composition owns provider identity and saver lifecycle.
 * Durable responses avoid repeat successful calls, not upstream exactly-once: a crash before the receipt
 * is written can repeat a nonbillable request. Paid calls must use their independent ambiguous-send ledger.
 * Prompts/options/provider stay in a closure; only a fingerprint and raw response metadata are persisted.
 */
export class CheckpointedTextProvider implements TextProvider {
  constructor(private readonly provider:TextProvider,private readonly options:{checkpointer:BaseCheckpointSaver;identity:string}) {
    if(!options.identity.trim()||options.identity.length>4096)throw new CoreError('INVALID_INPUT');
  }
  async generate(messages:ProviderMessage[],options:GenerateOptions):Promise<string> {
    options={...options};
    check(options);
    if(!options.requestKey||!TURN_ID.test(options.requestKey))throw new CoreError('INVALID_INPUT');
    const captured=messages.map(message=>({role:message.role,content:message.content}));
    const fingerprint=createHash('sha256').update(JSON.stringify({revision:'model-receipt-v1',identity:this.options.identity,messages:captured})).digest('hex');
    const execute=task('model-response',async():Promise<Receipt>=>{
      check(options);
      let upstream:string|undefined,usage:Receipt['usage'];
      let rawResponse:string;
      try {rawResponse=await AsyncLocalStorageProviderSingleton.getInstance().run(undefined,()=>this.provider.generate(captured,{...options,
        onServed:name=>{upstream=/^[a-z0-9_-]{1,40}$/.test(name)?name:'unknown';},
        onUsage:counts=>{usage={promptTokens:counts.promptTokens,completionTokens:counts.completionTokens};}}));
      } catch(error) {
        // LangGraph persists failed-task metadata too. Preserve constant transport codes, not untrusted
        // upstream bodies/messages or arbitrary uppercase secret codes (no automatic retry policy).
        const code=error&&typeof error==='object'&&'code' in error?error.code:undefined;
        const safe=typeof code==='string'&&(PROVIDER_ERROR_CODES.has(code)||/^PROVIDER_HTTP_[1-5][0-9]{2}$/.test(code))?code:'PROVIDER_TRANSPORT';
        throw Object.assign(new Error(safe),{code:safe});
      }
      const receipt={rawResponse,...(upstream!==undefined?{upstream}:{}),...(usage?{usage}:{})};
      if(!validReceipt(receipt))throw new CoreError('TURN_FAILED');
      // Return before checking cancellation: a successful task gets its durable pending-write receipt even
      // when ownership was lost while the upstream answered. The enclosing node still refuses that attempt.
      return receipt;
    });
    const graph=new StateGraph(State).addNode('generate',async({call})=>{
      const receipt=await execute();check(options);
      if(!validReceipt(receipt))throw new CoreError('TURN_FAILED');
      return {call:{fingerprint:call.fingerprint,receipt}};
    }).addEdge(START,'generate').addEdge('generate',END).compile({checkpointer:this.options.checkpointer});
    const config={configurable:{thread_id:`model:${options.requestKey}:${fingerprint}`,checkpoint_ns:''},recursionLimit:4,durability:'sync' as const};
    // Clear LangChain's ENTIRE async context, not just a few pregel keys. getState and invoke must share
    // the detached ROOT scope; parent checkpoint maps/namespaces/run trees must not select another receipt.
    const receipt=await AsyncLocalStorageProviderSingleton.getInstance().run(undefined,async()=>{
      const snapshot=await graph.getState(config);check(options);
      const saved=(snapshot.values as Partial<typeof State.State>).call;
      if(saved) {
        if(saved.fingerprint!==fingerprint)throw new CoreError('TURN_FAILED');
        if(saved.receipt!==undefined) {
          if(!validReceipt(saved.receipt))throw new CoreError('TURN_FAILED');
          return saved.receipt;
        }
        if(!snapshot.next.length)throw new CoreError('TURN_FAILED');
      } else if(snapshot.config?.configurable?.checkpoint_id)throw new CoreError('TURN_FAILED');
      const completed=await graph.invoke(saved?null:{call:{fingerprint}},config);check(options);
      if(completed.call.fingerprint!==fingerprint||!validReceipt(completed.call.receipt))throw new CoreError('TURN_FAILED');
      return completed.call.receipt;
    });
    check(options);
    if(receipt.upstream!==undefined)options.onServed?.(receipt.upstream);
    if(receipt.usage!==undefined)options.onUsage?.({...receipt.usage});
    return receipt.rawResponse;
  }
}
