import { randomUUID } from 'node:crypto';
import { Annotation, END, START, StateGraph, task } from '@langchain/langgraph';
import { CreateSessionSchema, PersonaSchema, SendTurnSchema, TimelineQuerySchema, type ChatMessage, type Persona, type ChatReply, type InputSafetyTrace, type ChatSession, type ChatTurn, type CreateSessionInput, type ProviderMessage, type SendTurnInput, type SourcePost } from '@ptr/contracts';
import { CoreError, LEASE_LOST, PROVIDER_DEADLINE, type ConversationStore, type LeaseFence, type PersonaRepository, type QueuedTurn, type Retrieval, type TextProvider, type TurnDelivery, type TurnDispatch, type TurnEvents, type TurnLeaseStore } from './ports';
import { buildExperimentContext, buildPrompt } from './prompts';
import { requestFingerprint } from './request-fingerprint';
import { rememberSourceContext, retrievalContext, RETRIEVAL_CONTEXT_REVISION } from './conversation-context';
import { containsCredentialPattern, containsInternalPathPattern, containsUngroundedBiography } from './safety';
import { intentSignals, isReentry, isSensitive, needsIntentClassifier, routeIntent, ruleIntent, classifierFallbackReason, type IntentClassification, type IntentSignals, type TurnIntent, type IntentClassifierOptions } from './intent-routing';
import { DEFAULT_SAFETY_THRESHOLDS, RULE_PATH_CATEGORIES, SAFETY_CATEGORIES, SAFETY_DEFLECTION_NOTE, safetyOutcome, safetyReply, startSafetyAssessment, withoutRefusedTurns, type InputSafetyOptions, type SafetyCategory } from './input-safety';
import { AgentVariablesSchema } from './agent-protocol';
import { AGENT_RUNTIME_REVISION, AGENT_PROMPT_REVISION, runCharacterAgent, type AgentValidator } from './agent-runtime';
import { filterEvidence, validateExperimentReply, validateSourceBoundReply } from './evidence';
import { greetingIndexFor, greetingsOf, matchLore, renderLoreMessage } from './persona-card';
import { REPLY_GUARD_REVISION, guardReply, hasUserSelfMarker, splitSentences } from './reply-guard';
import type { GuardrailsClient } from './guardrails';
import { replyText, speechLevel, utteranceLanguage, voiceText, isVoiceText, type VoiceTextKey } from './reply-texts';
export interface ChatServiceOptions {store:ConversationStore;personas:PersonaRepository;provider:TextProvider;retrieval?:Retrieval;timeoutMs?:number;maxHistoryMessages?:number;maxToolRounds?:number;agentValidator?:AgentValidator;
  /** Turns always run queued: startTurn reserves (with an outbox entry) and publishes; TurnWorker calls executeQueued. */
  leases:TurnLeaseStore;delivery:TurnDelivery;
  /**
   * False when the runtime has no real query embedder (self-hosted and gateway chat, R10): semantic sessions are then
   * refused at creation (SEMANTIC_UNAVAILABLE) and turns of an older one fail as RETRIEVAL_UNAVAILABLE, instead of
   * searching an embedding space no source vector is in. Default true.
   */
  semanticSearch?:boolean;
  /** Required by the production composition; omitted only in the isolated domain test harness. */
  guardrails?:Pick<GuardrailsClient,'validateInput'|'validateReply'>;
  /** A bounded tracing adapter; stages have no credentials or raw text in their names. */
  observeStage?:<T>(name:string,work:()=>Promise<T>)=>Promise<T>;
  /** Parent trace surrounds the actual queued turn, not a standalone adapter smoke run. */
  observeTurn?:<T>(queued:QueuedTurn,work:()=>Promise<T>)=>Promise<T>;
  /** Backlog bound for admission control (default 256). */
  maxQueueDepth?:number;
  /** State-change notices for push delivery (SSE); never carries model output. */
  events?:TurnEvents;
  /** Observability hook: failed turns with a sanitized error class/code only (never messages or bodies). */
  onTurnFailure?:(failure:{turnId:string;code:string})=>void;
  /** Optional ambiguity-only intent classifier (off by default); rules stay authoritative for safety and strong signals. */
  intentClassifier?:IntentClassifierOptions;
  /**
   * Optional input safety filter (off by default), asked on every turn the rules did not already refuse. When the
   * intent gate is open too, its single request also answers the intent question in place of `intentClassifier`.
   */
  inputSafety?:InputSafetyOptions;
  /** Observability: the safety filter fell back to rules only (fail-open). Reason class only, never text. */
  onSafetyFallback?:(event:{scope:'turn'|'draft';reason:string})=>void;
  /** Observability: a turn completed with this stored reply (metrics read its internal trace, never its text). */
  onTurnCompleted?:(event:{turnId:string;reply:ChatReply})=>void}
type TurnOutput=Pick<ChatReply,'status'|'content'|'claims'|'evidence'|'limitations'|'grounding'>;
function shouldAskBack(intent:TurnIntent|undefined,condition:ChatSession['ragCondition'],text:string,evidence:ChatReply['evidence']):boolean {
  const sentences=splitSentences(text);
  const question=sentences.some(sentence=>{
    const asked=sentence.split(/(?<=몰라)\s+(?=너|네가|니가|당신)/u).at(-1)??sentence;
    return (/[?？]|(?<![A-Za-z])(?:언제|어디|뭐|누구|어떤|왜|how|when|where|what|who|which)(?![A-Za-z])|(?:니|냐|나요|지)\s*$/iu.test(asked))
      &&!/(?:내일|모레|다음에|다음\s?(?:주|달|번)|앞으로|tomorrow|next\s+(?:week|month)|(?:할|갈)\s?거(?:야|예요)?|(?:할|갈)래|[가-힣]+(?:을|ㄹ)\s?거(?:야|예요)?|[가-힣]+(?:을|ㄹ)래)/iu.test(asked)
      &&!hasUserSelfMarker(asked);
  });
  return intent==='timeline'&&condition!==undefined&&condition!=='off'&&question&&evidence.length===0;
}
function askBackStreak(history:ChatMessage[]):number {
  let count=0;
  for(const message of [...history].reverse()) {
    if(message.role!=='assistant')continue;
    if(!isVoiceText('memory_ask_back',message.content))break;
    count++;
    if(count===2)break;
  }
  return count;
}
interface TurnSnapshot {
  persona:Persona;history:ChatMessage[];promptHistory:ChatMessage[];context:ReturnType<typeof retrievalContext>;
  query:ReturnType<typeof TimelineQuerySchema.parse>;ownedPrevious?:ChatReply;previousAssistantText?:string;references:ChatReply['evidence'];ambiguous:boolean;
  signals:IntentSignals;recentUserTurns:string[];control:boolean;combined:boolean;rule?:NonNullable<InputSafetyTrace['rule']>;
  cardPath:boolean;replyLanguage:string;level:ReturnType<typeof speechLevel>;
}
interface TurnFrame {
  snapshot?:TurnSnapshot;memoryTrace?:NonNullable<ChatReply['retrievalContext']>;
  safety?:InputSafetyTrace;combinedIntent?:IntentClassification;intentFailure?:ReturnType<typeof classifierFallbackReason>;
  intent?:TurnIntent;routing?:ChatReply['intentRouting'];deflect?:boolean;safetyCategory?:Exclude<SafetyCategory,'prompt_injection'>;
  sources:SourcePost[];memorySources:SourcePost[];output?:TurnOutput;agent?:ChatReply['agent'];
  lore?:ProviderMessage;personaContext?:ChatReply['personaContext'];promptEvidence?:ChatReply['promptEvidence'];replyGuard?:ChatReply['replyGuard'];
  agentRun?:Awaited<ReturnType<typeof runCharacterAgent>>;experiment?:ReturnType<typeof buildExperimentContext>;rawReply?:string;
  served:string[];reply?:ChatReply;
}
const TurnAnnotation=Annotation.Root({frame:Annotation<TurnFrame>()});
type TurnGraphState=typeof TurnAnnotation.State;
type TurnGraphUpdate={frame:TurnFrame};
/** Backlog readings are reused briefly so admission control stays cheap while it is rejecting. */
const DEPTH_READING_TTL_MS=200;
/** Upstream names a provider may report for reply.serving; anything else is recorded as `unknown`. */
const UPSTREAM_LABEL=/^[a-z0-9_-]{1,40}$/;
const activeStates=['pending','retrieving','generating','validating'] as const;
/** Store view whose writes are fenced by the worker's lease and announced as events once they apply; reads pass through. */
function fencedStore(store:ConversationStore,fence:LeaseFence,events?:TurnEvents):ConversationStore {
  // Event delivery is best effort: SSE readers re-check the store, so a lost notice only delays the update.
  const announce=(applied:boolean,turnId:string,state:Parameters<ConversationStore['transitionTurn']>[2],errorCode?:string)=>{
    if(applied) void events?.publish({turnId,state,...(errorCode?{errorCode}:{})}).catch(()=>undefined);
    return applied;
  };
  return {
    create:(session,greeting)=>store.create(session,greeting),getOwnedSession:(id,owner)=>store.getOwnedSession(id,owner),
    listOwnedSessions:owner=>store.listOwnedSessions(owner),
    setUserMemoryConsent:(id,owner,enabled)=>store.setUserMemoryConsent(id,owner,enabled),
    getSessionSummary:(id,owner)=>store.getSessionSummary(id,owner),
    listUserMemories:(owner,persona,includeForgotten)=>store.listUserMemories(owner,persona,includeForgotten),
    forgetUserMemory:(id,owner)=>store.forgetUserMemory(id,owner),
    deleteUserMemories:(owner,persona)=>store.deleteUserMemories(owner,persona),
    deleteOwnedSession:(id,owner)=>store.deleteOwnedSession(id,owner),
    history:(id,owner)=>store.history(id,owner),refusedTurnIds:(id,owner)=>store.refusedTurnIds(id,owner),
    reserveTurn:(...args)=>store.reserveTurn(...args),getTurn:(id,owner)=>store.getTurn(id,owner),cancelTurn:(id,owner)=>store.cancelTurn(id,owner),
    transitionTurn:async(id,expected,next,errorCode)=>announce(await store.transitionTurn(id,expected,next,errorCode,fence),id,next,errorCode),
    completeTurn:async(id,reply)=>announce(await store.completeTurn(id,reply,fence),id,'completed'),
  };
}
export class ChatService {
  private depthReading?:{value:number;at:number};
  private depthRefresh?:Promise<void>;
  constructor(private readonly options:ChatServiceOptions) {}
  async createSession(ownerId:string,input:CreateSessionInput):Promise<ChatSession> {
    if(!ownerId.trim()) throw new CoreError('FORBIDDEN');
    // A RAG condition without a mode defaults to semantic, or to lexical where semantic search is unavailable.
    const defaulted=input.retrievalMode===undefined&&input.ragCondition&&input.ragCondition!=='off'&&this.options.semanticSearch===false?{...input,retrievalMode:'lexical' as const}:input;
    const parsed=CreateSessionSchema.safeParse(defaulted);
    if(!parsed.success) throw new CoreError('INVALID_INPUT');
    const value=parsed.data;
    if(value.retrievalMode==='semantic'&&this.options.semanticSearch===false) throw new CoreError('SEMANTIC_UNAVAILABLE');
    const raw=await this.options.personas.get(value.personaId,value.personaRevision);
    const result=PersonaSchema.safeParse(raw);
    if(!result.success) throw new CoreError('PERSONA_UNAVAILABLE');
    const persona=result.data;
    if(persona.id !== value.personaId || persona.revision !== value.personaRevision || persona.personId !== value.personId) throw new CoreError('FORBIDDEN');
    // Greeting: an explicit index (evaluations pin 0) or one derived from the session id. The index is
    // stored only when it was given or there is a choice, so v1 personas keep their session shape.
    const greetings=greetingsOf(persona);
    if(value.greetingIndex!==undefined&&value.greetingIndex>=greetings.length) throw new CoreError('INVALID_INPUT');
    const id=randomUUID();
    const greetingIndex=value.greetingIndex??greetingIndexFor(id,greetings.length);
    const session:ChatSession={id,ownerId,personId:value.personId,personaId:persona.id,personaRevision:persona.revision,language:persona.language,timezone:value.timezone,retrievalMode:value.retrievalMode,...(value.ragCondition ? {ragCondition:value.ragCondition}:value.executionProfile==='agent_loop'?{ragCondition:value.retrievalMode==='off'?'off' as const:'caption' as const}:{}),...(value.executionProfile?{executionProfile:value.executionProfile}:{}),createdAt:new Date().toISOString(),
      ...(value.greetingIndex!==undefined||greetings.length>1?{greetingIndex}:{})};
    await this.options.store.create(session,{id:randomUUID(),sessionId:session.id,turnId:null,role:'assistant',content:greetings[greetingIndex]!,createdAt:session.createdAt});
    return session;
  }
  async getSession(ownerId:string,sessionId:string):Promise<ChatSession> {
    const session=await this.options.store.getOwnedSession(sessionId,ownerId);
    if(!session) throw new CoreError('NOT_FOUND'); return session;
  }
  listSessions(ownerId:string):Promise<ChatSession[]> { return this.options.store.listOwnedSessions(ownerId); }
  async history(ownerId:string,sessionId:string) { await this.getSession(ownerId,sessionId); return this.options.store.history(sessionId,ownerId); }
  async getTurn(ownerId:string,turnId:string):Promise<ChatTurn> {
    const turn=await this.options.store.getTurn(turnId,ownerId);
    if(!turn) throw new CoreError('NOT_FOUND');return turn;
  }
  async cancelTurn(ownerId:string,turnId:string):Promise<boolean> {
    await this.getTurn(ownerId,turnId);
    const cancelled=await this.options.store.cancelTurn(turnId,ownerId);
    // The worker notices through its lease heartbeat and aborts the provider call.
    // Not awaited: the cancel is committed; a slow or failing Redis must not hold the request.
    if(cancelled) void this.options.events?.publish({turnId,state:'cancelled'}).catch(()=>undefined);
    return cancelled;
  }
  /** Whether the input safety filter is configured (the API applies draft admission only then). */
  get inputSafetyEnabled():boolean { return !!this.options.inputSafety; }
  /**
   * Input safety for a creative-draft brief: same questions, whole-text windows and fail-open as a turn, without
   * history (seed = draft id). Refusal/support return the template to show instead of drafting; deflection returns the
   * note for the draft's policy message. With the filter off nothing is checked.
   */
  async screenDraftBrief(brief:string,seed:string,language:string,signal:AbortSignal):Promise<{trace?:InputSafetyTrace;reply?:string;limitations:string[];policyNote?:string}> {
    const options=this.options.inputSafety;
    if(!options&&!this.options.guardrails)return {limitations:[]};
    let trace=options?safetyOutcome(await startSafetyAssessment(options,{text:brief,recentUserTurns:[],seed,intent:false,categories:SAFETY_CATEGORIES},signal).all,options,signal):undefined;
    if(trace?.fallbackReason)this.options.onSafetyFallback?.({scope:'draft',reason:trace.fallbackReason});
    if(this.options.guardrails) {
      try {
        if(trace?.fallbackReason&&trace.action==='none')throw new Error('unavailable');
        const decision=await this.options.guardrails.validateInput({classification:options?'jev':'rules-only',text:brief,probabilities:trace?.probabilities??{},thresholds:options?.thresholds??DEFAULT_SAFETY_THRESHOLDS,categories:SAFETY_CATEGORIES},{signal});
        trace={...(trace??{decidedBy:'rule' as const}),action:decision.action,category:decision.category,fired:decision.fired};
      } catch {
        if(signal.aborted)throw new CoreError('TURN_FAILED','TURN_ABORTED');
        return {trace,reply:voiceText('service_retry',utteranceLanguage(brief,language),'polite',undefined,seed),limitations:['GUARDRAILS_INPUT_UNAVAILABLE']};
      }
    }
    if(!trace)return {limitations:[]};
    if((trace.action==='refuse'||trace.action==='support')&&trace.category)
      return {trace,reply:safetyReply(trace.category as Exclude<SafetyCategory,'prompt_injection'>,language),limitations:trace.action==='support'?['SAFETY_SUPPORT']:[]};
    return {trace,limitations:[],...(trace.action==='deflect'?{policyNote:SAFETY_DEFLECTION_NOTE}:{})};
  }
  /** Returns the reserved/current turn immediately; final output remains private until validation. */
  async startTurn(ownerId:string,input:SendTurnInput):Promise<ChatTurn> { return (await this.submitTurn(ownerId,input)).turn; }
  /**
   * Admission → reservation (turn + outbox entry in one transaction) → publish. A failed publish is not an error:
   * the outbox entry stays until a worker claims the turn and the dispatcher publishes it again.
   */
  async submitTurn(ownerId:string,input:SendTurnInput):Promise<{turn:ChatTurn;created:boolean;dispatch?:TurnDispatch}> {
    // Admission control first: a rejection costs at most one shared backlog reading, no session lookup or write.
    if(!this.depthReading||Date.now()-this.depthReading.at>=DEPTH_READING_TTL_MS) {
      // If the backlog cannot be read (Redis trouble), keep the last reading rather than refuse every turn:
      // reservations still land in the outbox and are delivered once Redis is back.
      this.depthRefresh??=this.options.delivery.backlog().catch(()=>this.depthReading?.value??0)
        .then(value=>{this.depthReading={value,at:Date.now()};}).finally(()=>{this.depthRefresh=undefined;});
      await this.depthRefresh;
    }
    // Check and take a slot with no await in between, so a concurrent burst cannot overshoot the bound.
    const reading=this.depthReading!;
    if(reading.value>=(this.options.maxQueueDepth??256)) throw new CoreError('QUEUE_FULL');
    reading.value++;
    let created=false;
    try {
      const {session,value}=await this.prepare(ownerId,input);
      const reserved=await this.options.store.reserveTurn(session.id,ownerId,value.clientRequestId,value.text,requestFingerprint(value,session.ragCondition),value);
      created=reserved.created;
      if(reserved.dispatch) await this.options.delivery.publish(reserved.dispatch).catch(()=>undefined);
      return reserved;
    } finally {if(!created) reading.value=Math.max(0,reading.value-1);}
  }
  /** Worker entry point: runs a claimed turn with every state write fenced by its lease. */
  async executeQueued(queued:QueuedTurn,controller:AbortController):Promise<void> {
    const work=()=>this.executeQueuedWork(queued,controller);
    if(this.options.observeTurn)await this.options.observeTurn(queued,work);else await work();
  }
  private async executeQueuedWork(queued:QueuedTurn,controller:AbortController):Promise<void> {
    const store=fencedStore(this.options.store,queued.fence,this.options.events);
    let prepared:Awaited<ReturnType<ChatService['prepare']>>;
    try {prepared=await this.prepare(queued.turn.ownerId,queued.input);}
    catch(error) {
      if(controller.signal.reason===LEASE_LOST) return;
      await store.transitionTurn(queued.turn.id,[...activeStates],'failed','TURN_FAILED');
      this.options.onTurnFailure?.({turnId:queued.turn.id,code:error instanceof CoreError?error.code:'PREPARE_FAILED'});
      return;
    }
    await this.runReserved(prepared.session,queued.turn,prepared.value,prepared.query,controller,store);
  }
  private async prepare(ownerId:string,input:SendTurnInput) {
    const checked=SendTurnSchema.safeParse(input);
    if(!checked.success) throw new CoreError('INVALID_INPUT');
    const value=checked.data;
    if(containsCredentialPattern(value.text)) throw new CoreError('INVALID_INPUT');
    const session=await this.getSession(ownerId,value.sessionId);
    // Verify structured ranges before reserving a turn or calling any external port.
    const queryResult=TimelineQuerySchema.safeParse({personId:session.personId,query:value.timeline?.query ?? value.text.slice(0,500),start:value.timeline?.start,end:value.timeline?.end,dateBasis:value.timeline?.dateBasis ?? 'posted',timezone:session.timezone,limit:value.timeline?.limit ?? 5});
    if(!queryResult.success || containsCredentialPattern(queryResult.data.query??'')) throw new CoreError('INVALID_INPUT');
    return {session,value,query:queryResult.data};
  }
  private async runReserved(session:ChatSession,turn:ChatTurn,value:ReturnType<typeof SendTurnSchema.parse>,query:ReturnType<typeof TimelineQuerySchema.parse>,controller:AbortController,store:ConversationStore):Promise<void> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const timeoutMs=this.options.timeoutMs ?? 30000, deadlineAt=Date.now()+timeoutMs;
      const execution=this.execute(session,turn,value,query,controller,store,deadlineAt);
      const timeout=new Promise<void>((_,reject)=>{
        // Reject before aborting: the abort listener fires synchronously and would otherwise win with TURN_ABORTED.
        timer=setTimeout(()=>{reject(new CoreError('TURN_FAILED','TURN_TIMEOUT'));controller.abort();},timeoutMs);
        controller.signal.addEventListener('abort',()=>reject(new CoreError('TURN_FAILED','TURN_ABORTED')),{once:true});
      });
      await Promise.race([execution,timeout]);
    } catch (error) {
      // A worker that lost its lease writes nothing: recovery requeues the turn (or fails it with WORKER_LOST).
      if(controller.signal.reason===LEASE_LOST) return;
      // Never persist/return provider error strings: they can contain raw keys, prompts or paths.
      const providerCode=error instanceof Error&&'code' in error?error.code:undefined;
      const errorCode=error instanceof CoreError&&error.code==='CONTEXT_LIMIT'?'CONTEXT_LIMIT'
        :providerCode==='REQUEST_UNRESOLVED_NO_RESUBMIT'?'PROVIDER_REQUEST_UNRESOLVED'
        :providerCode==='PROVIDER_REQUEST_FAILED'?'PROVIDER_UNAVAILABLE':'TURN_FAILED';
      await store.transitionTurn(turn.id,[...activeStates],'failed',errorCode);
      // A TURN_FAILED CoreError carries its reason (a TurnFailureReason constant) as the message. That reason and a
      // provider error code are logged only when they look like a constant, otherwise as UNSPECIFIED, so free text
      // can never reach the log.
      const constant=(value:string)=>/^[A-Z_]{1,40}$/.test(value)?value:'UNSPECIFIED';
      // The gateway refused or cut a model call at the turn deadline; report the same timeout as the turn timer.
      const message=providerCode===PROVIDER_DEADLINE?'TURN_TIMEOUT'
        :error instanceof CoreError&&error.code==='TURN_FAILED'&&error.message!==error.code?error.message:undefined;
      this.options.onTurnFailure?.({turnId:turn.id,code:message!==undefined?constant(message):typeof providerCode==='string'?constant(providerCode)
        :error instanceof Error?error.constructor.name:'UNKNOWN'});
    } finally { if(timer) clearTimeout(timer); }
  }
  private async execute(session:ChatSession,turn:ChatTurn,value:ReturnType<typeof SendTurnSchema.parse>,initialQuery:ReturnType<typeof TimelineQuerySchema.parse>,controller:AbortController,store:ConversationStore,deadlineAt:number):Promise<void> {
    const check=()=>{if(controller.signal.aborted)throw new CoreError('TURN_FAILED','TURN_ABORTED');};
    const observed=async<T>(name:string,work:()=>Promise<T>):Promise<T>=>this.options.observeStage?this.options.observeStage(name,work):work();
    const stage=(name:string,work:(frame:TurnFrame)=>Promise<TurnFrame>)=>async({frame}:TurnGraphState):Promise<TurnGraphUpdate>=>{
      check();return {frame:await observed(name,()=>work(frame))};
    };
    const transition=async(next:'retrieving'|'generating'|'validating'):Promise<void>=>{
      check();const applied=await store.transitionTurn(turn.id,[...activeStates],next);
      if(!applied){controller.abort(LEASE_LOST);throw new CoreError('TURN_FAILED','TURN_ABORTED');}
    };
    const initialize=task('turn-snapshot',async():Promise<TurnFrame>=>{
      if(session.retrievalMode==='semantic'&&this.options.semanticSearch===false)throw new CoreError('TURN_FAILED','RETRIEVAL_UNAVAILABLE');
      const history=await store.history(session.id,session.ownerId);
      if(history.length>(this.options.maxHistoryMessages??100))throw new CoreError('CONTEXT_LIMIT');
      const persona=PersonaSchema.parse(await this.options.personas.get(session.personaId,session.personaRevision));
      if(persona.id!==session.personaId||persona.personId!==session.personId||persona.revision!==session.personaRevision)throw new CoreError('PERSONA_UNAVAILABLE');
      const promptHistory=this.options.inputSafety?withoutRefusedTurns(history,await store.refusedTurnIds(session.id,session.ownerId)):history;
      const context=retrievalContext(promptHistory,value.text,!!value.timeline),query=value.timeline?initialQuery:{...initialQuery,query:context.query};
      const previousMessage=[...promptHistory].reverse().find(message=>message.role==='user'&&message.turnId);
      const previous=(context.followUp||session.executionProfile==='agent_loop')&&previousMessage?.turnId?await store.getTurn(previousMessage.turnId,session.ownerId):undefined;
      const ownedPrevious=previous?.state==='completed'&&previous.ownerId===session.ownerId&&previous.sessionId===session.id
        &&previous.reply?.sessionId===session.id&&previous.reply.turnId===previous.id&&previous.reply.personId===session.personId
        &&previous.reply.personaRevision===session.personaRevision?previous.reply:undefined;
      const boundPrevious=context.followUp?ownedPrevious:undefined;
      const references=context.followUp&&!value.timeline&&boundPrevious?.grounding==='source_bound_quotes'&&boundPrevious.responseKind==='timeline'
        ?(boundPrevious.sourceContext?.revision===RETRIEVAL_CONTEXT_REVISION?boundPrevious.sourceContext.references:boundPrevious.evidence)
          .filter(ref=>ref.personId===session.personId&&boundPrevious.evidence.some(cited=>cited.sourceId===ref.sourceId&&cited.hash===ref.hash&&cited.snapshot===ref.snapshot)):[];
      const ambiguous=new Set(references.map(ref=>ref.sourceId)).size>1
        ||/photo|picture|사진/i.test(value.text)&&new Set((boundPrevious?.evidence??[]).flatMap(ref=>ref.annotationId?[ref.annotationId]:[])).size>1;
      const signals=intentSignals({text:value.text,context,...(value.intent?{explicitIntent:value.intent}:{}),explicitTimeline:!!value.timeline,
        ...(session.ragCondition?{ragCondition:session.ragCondition}:{}),previousTimeline:boundPrevious?.responseKind==='timeline'});
      const recentUserTurns=history.filter(message=>message.role==='user'&&message.turnId!==null&&!containsCredentialPattern(message.content)&&!isSensitive(message.content)).slice(-2).map(message=>[...message.content].slice(0,300).join(''));
      const control=session.retrievalMode==='off'&&!session.ragCondition;
      const rule=signals.sensitive?'sensitive_pattern' as const:signals.explicitIntent==='unsupported'?'client_unsupported' as const:undefined;
      const combined=!!this.options.inputSafety&&!!this.options.intentClassifier&&!control&&needsIntentClassifier(signals);
      const cardPath=!!session.ragCondition||session.executionProfile==='agent_loop';
      const previousAssistantText=[...promptHistory].reverse().find(message=>message.role==='assistant')?.content;
      return structuredClone({sources:[],memorySources:[],served:[],snapshot:{persona,history,promptHistory,context,query,ownedPrevious,previousAssistantText,references,ambiguous,signals,recentUserTurns,control,combined,rule,
        cardPath,replyLanguage:cardPath?utteranceLanguage(value.text,session.language,promptHistory):session.language,level:speechLevel(persona)},
        memoryTrace:{revision:RETRIEVAL_CONTEXT_REVISION,action:'none',contextTurnIds:context.contextTurnIds,reusedSourceIds:[]}});
    });
    const assess=task('turn-safety',async(frame:TurnFrame):Promise<Pick<TurnFrame,'safety'|'combinedIntent'|'intentFailure'|'output'>>=>{
      const snap=frame.snapshot!,options=this.options.inputSafety;
      let safety:InputSafetyTrace|undefined,combinedIntent:IntentClassification|undefined,intentFailure:TurnFrame['intentFailure'];
      if(options) {
        const results=await startSafetyAssessment(options,{text:value.text,recentUserTurns:snap.recentUserTurns,seed:turn.id,intent:snap.combined,categories:snap.rule?RULE_PATH_CATEGORIES:SAFETY_CATEGORIES},controller.signal).all;
        safety=safetyOutcome(results,options,controller.signal,snap.rule);
        const first=results[0];
        if(snap.combined) {
          if(first.ok&&!(first.value.intent instanceof Error))combinedIntent=first.value.intent;
          else intentFailure=classifierFallbackReason(first.ok?first.value.intent:first.error,controller.signal);
        }
      }
      check();
      if(this.options.guardrails) {
        try {
          // An incomplete Jev check is not silently promoted to safe by an empty validator metadata record.
          if(safety?.fallbackReason&&safety.action==='none')throw new Error('unavailable');
          const decision=await this.options.guardrails.validateInput({classification:options?'jev':'rules-only',text:value.text,probabilities:safety?.probabilities??{},thresholds:options?.thresholds??DEFAULT_SAFETY_THRESHOLDS,
            categories:snap.rule?RULE_PATH_CATEGORIES:SAFETY_CATEGORIES,...(combinedIntent?{intent:combinedIntent}:{})},{signal:controller.signal});
          if(decision.action!=='none'||!snap.rule)safety={...(safety??{decidedBy:'rule' as const}),
            action:decision.action,category:decision.category,fired:decision.fired};
          if(decision.intent)combinedIntent=decision.intent;
        } catch {
          check();return {safety,combinedIntent,intentFailure,output:{status:'insufficient_evidence',content:voiceText('service_retry',snap.replyLanguage,snap.level,snap.previousAssistantText,turn.id),claims:[],evidence:[],grounding:'unverified_model',limitations:['GUARDRAILS_INPUT_UNAVAILABLE']}};
        }
      }
      return {safety,combinedIntent,intentFailure};
    });
    const retrieve=task('turn-retrieve',async(frame:TurnFrame):Promise<Pick<TurnFrame,'sources'|'memoryTrace'>>=>{
      const {references,query}=frame.snapshot!;let sources:SourcePost[]=[];let memoryTrace=frame.memoryTrace!;
      if(!this.options.retrieval)throw new CoreError('TURN_FAILED','RETRIEVAL_UNAVAILABLE');
      const lookupOptions={signal:controller.signal,...(session.ragCondition&&session.ragCondition!=='off'?{evidenceScope:session.ragCondition}:{})};
      if(references.length&&this.options.retrieval.resolve) {
        const resolved=await this.options.retrieval.resolve(references,{personId:session.personId},lookupOptions);
        const pinned=resolved.flatMap(source=>{
          const matching=references.filter(ref=>ref.sourceId===source.id&&ref.hash===source.hash&&ref.snapshot===source.snapshot
            &&(ref.annotationId?source.imageAnnotations?.some(annotation=>ref.annotationId===annotation.id&&ref.annotationRevision===annotation.revision&&ref.imageHash===annotation.imageHash&&ref.annotationHash===annotation.annotationHash&&annotation.text.includes(ref.quote)):source.caption.includes(ref.quote)));
          if(!matching.length||references.some(ref=>ref.sourceId===source.id&&ref.annotationId&&!matching.includes(ref)))return [];
          return [{...source,...(source.imageAnnotations?{imageAnnotations:source.imageAnnotations.filter(annotation=>matching.some(ref=>ref.annotationId===annotation.id))}:{})}];
        });
        sources=filterEvidence(pinned,query,session.personId);
        if(sources.length)memoryTrace={...memoryTrace,action:'reuse',reusedSourceIds:sources.map(source=>source.id)};
      }
      if(!sources.length) {
        sources=filterEvidence(await this.options.retrieval.search(query,{personId:session.personId},{...lookupOptions,mode:session.retrievalMode as 'lexical'|'semantic'}),query,session.personId);
        memoryTrace={...memoryTrace,action:'search',query:query.query};
      }
      if(session.ragCondition!=='caption_image')sources=sources.map(({imageAnnotations:_,...source})=>source);
      return structuredClone({sources,memoryTrace});
    });
    const generate=task('turn-generate',async(frame:TurnFrame):Promise<TurnFrame>=>{
      if(frame.intent==='small_talk'&&!frame.deflect&&isReentry(value.text)) {
        const snap=frame.snapshot!;
        return {...frame,output:{status:'answered',content:voiceText('reentry_recap',snap.replyLanguage,snap.level,snap.previousAssistantText,turn.id),claims:[],evidence:[],grounding:'unverified_model',limitations:[]}};
      }
      if(frame.intent==='small_talk'&&!frame.deflect&&/^\s*(?:nice|cool|really|wow|omg|lol|ㅋㅋ+|ㅎㅎ+|ㄷㄷ+|헐|와|오|대박|좋다|진짜)[!?.~\s]*$/iu.test(value.text)) {
        const snap=frame.snapshot!;
        const key=/[?？]/u.test(value.text)?'reaction_confirm':/^\s*(?:헐|wow|omg|와|대박|ㄷㄷ)/iu.test(value.text)?'reaction_surprise':'reaction';
        return {...frame,output:{status:'answered',content:voiceText(key,snap.replyLanguage,snap.level,snap.previousAssistantText,turn.id),claims:[],evidence:[],grounding:'unverified_model',limitations:[]}};
      }
      const {persona,promptHistory,cardPath,context,query,ownedPrevious}=frame.snapshot!;let lore:ProviderMessage|undefined,personaContext:ChatReply['personaContext'];
      if(cardPath&&persona.lore?.length) {
        const previous:string[]=[];
        if(!frame.deflect)for(const message of promptHistory.filter(message=>message.role==='user'&&message.turnId).slice(-2)) {
          const record=await store.getTurn(message.turnId!,session.ownerId);
          if(record&&(record.reply?.inputSafety?.action??'none')==='none')previous.push(message.content);
        }
        const matched=frame.deflect?{entries:[],omitted:0}:matchLore(persona,{current:value.text,previous});
        personaContext={loreIds:matched.entries.map(entry=>entry.id),loreOmitted:matched.omitted};
        if(matched.entries.length)lore=renderLoreMessage(matched.entries);
      }
      const served:string[]=[],provider:TextProvider={generate:async(messages,options)=>{
        let upstream:string|undefined;
        const text=await this.options.provider.generate(messages,{...options,onServed:name=>{upstream=name;options.onServed?.(name);}});
        served.push(upstream!==undefined&&UPSTREAM_LABEL.test(upstream)?upstream:'unknown');return text;
      }};
      const policyNote=frame.deflect?SAFETY_DEFLECTION_NOTE:undefined;
      const experiment=session.ragCondition&&session.executionProfile!=='agent_loop'?buildExperimentContext(persona,promptHistory,value.text,frame.sources,
        policyNote||lore?{...(policyNote?{policyNote}:{}),...(lore?{afterHistory:[lore]}:{})}:undefined):undefined;
      let memoryTrace=frame.memoryTrace!;
      const agentRun=session.executionProfile==='agent_loop'?await runCharacterAgent({provider,persona,history:promptHistory,text:value.text,sources:frame.sources,signal:controller.signal,
        replyLanguage:frame.snapshot!.replyLanguage,createdAt:turn.createdAt,timezone:session.timezone,
        maxToolRounds:this.options.maxToolRounds,requestKey:turn.id,deadlineAt,variables:AgentVariablesSchema.parse(ownedPrevious?.agent?.variables),
        ...(policyNote?{policyNote}:{}),...(lore?{lore}:{}),
        ...(session.retrievalMode!=='off'&&!context.creative&&!frame.deflect&&this.options.retrieval?{search:async(toolQuery:string)=>{
          check();const scopedQuery=TimelineQuerySchema.parse({...query,query:toolQuery});
          const found=filterEvidence(await this.options.retrieval!.search(scopedQuery,{personId:session.personId},{signal:controller.signal,mode:session.retrievalMode as 'lexical'|'semantic',
            ...(session.ragCondition&&session.ragCondition!=='off'?{evidenceScope:session.ragCondition}:{})}),scopedQuery,session.personId);
          memoryTrace={...memoryTrace,action:'search',query:toolQuery};
          return session.ragCondition==='caption_image'?found:found.map(({imageAnnotations:_,...source})=>source);
        }}:{}),
      }):undefined;
      const rawReply=agentRun?.rawReply??await provider.generate(experiment?.messages??buildPrompt(persona,promptHistory,value.text,frame.sources,frame.intent==='timeline',policyNote),{signal:controller.signal,requestKey:turn.id,deadlineAt});
      // Cheap stages restart on a new attempt; the injected provider alone retains costly completed responses.
      if(agentRun?.agent.toolCalls) {
        const query=agentRun.agent.steps.filter(step=>step.phase==='tool').at(-1)?.query;
        if(query)memoryTrace={...memoryTrace,action:'search',query};
      }
      return structuredClone({...frame,lore,personaContext,experiment,agentRun,rawReply,memorySources:agentRun?.context.sources??experiment?.sources??frame.sources,served:agentRun?.upstreams??served,memoryTrace});
    });
    const validateAgent=task('turn-agent-validator',async(frame:TurnFrame):Promise<'accepted'|'rejected'|'error'>=>{
      try {return await this.options.agentValidator!.validate({question:value.text,answer:frame.output!.content,sources:frame.memorySources,personId:session.personId,signal:controller.signal})==='accept'?'accepted':'rejected';}
      catch {return 'error';}
    });
    const outputGuard=task('turn-output-guard',async(frame:TurnFrame):Promise<Pick<TurnFrame,'output'|'replyGuard'>>=>{
      const snap=frame.snapshot!,candidate=frame.output!;
      if(!snap.cardPath&&!this.options.guardrails)return {output:candidate};
      if(this.options.guardrails) {
        try {
          const guarded=await this.options.guardrails.validateReply({utterance:value.text,reply:candidate.content,realPerson:snap.persona.reviewStatus!=='synthetic',language:snap.replyLanguage,level:snap.level,
            previousAssistantText:snap.previousAssistantText,turnId:turn.id},{signal:controller.signal});
          if(!guarded.content.trim()||guarded.content.length>8000||containsCredentialPattern(guarded.content)||containsInternalPathPattern(guarded.content))throw new Error('invalid validator output');
          const replyGuard:ChatReply['replyGuard']={revision:guarded.revision,action:guarded.reason?guarded.edited?'edited':'replaced':'none',...(guarded.reason?{reason:guarded.reason}:{})};
          if(guarded.reason&&guarded.edited)return {replyGuard,output:{...candidate,content:guarded.content,limitations:[...candidate.limitations,`REPLY_GUARD_${guarded.reason.toUpperCase()}`]}};
          if(guarded.reason)return {replyGuard,output:{status:'out_of_scope',content:guarded.content,claims:[],evidence:[],grounding:'unverified_model',limitations:[`REPLY_GUARD_${guarded.reason.toUpperCase()}`]}};
          return {replyGuard,output:{...candidate,content:guarded.content}};
        } catch {check();return {output:{status:'insufficient_evidence',content:voiceText('service_retry',snap.replyLanguage,snap.level,snap.previousAssistantText,turn.id),claims:[],evidence:[],grounding:'unverified_model',limitations:['GUARDRAILS_OUTPUT_UNAVAILABLE']}};}
      }
      // Offline domain harness only: production supplies Guardrails and never falls back here on a service failure.
      const guarded=guardReply({utterance:value.text,reply:candidate.content,realPerson:snap.persona.reviewStatus!=='synthetic',language:snap.replyLanguage,level:snap.level,previousAssistantText:snap.previousAssistantText,seed:turn.id});
      const replyGuard:ChatReply['replyGuard']=guarded?{revision:REPLY_GUARD_REVISION,action:guarded.edited?'edited':'replaced',reason:guarded.reason}:{revision:REPLY_GUARD_REVISION,action:'none'};
      if(guarded?.edited)return {replyGuard,output:{...candidate,content:guarded.content,limitations:[...candidate.limitations,`REPLY_GUARD_${guarded.reason.toUpperCase()}`]}};
      return {replyGuard,output:guarded?{status:'out_of_scope',content:guarded.content,claims:[],evidence:[],grounding:'unverified_model',limitations:[`REPLY_GUARD_${guarded.reason.toUpperCase()}`]}:candidate};
    });
    const decideIntent=task('turn-intent',async(frame:TurnFrame):Promise<TurnFrame>=>{
        const snap=frame.snapshot!,intentOptions=this.options.intentClassifier;
        if(frame.output)return {...frame,intent:'unsupported'};
        const classifier=snap.combined?{...intentOptions!,classifier:{name:intentOptions!.classifier.name,classify:async()=>{
          if(frame.intentFailure)throw frame.intentFailure==='timeout'?'timeout':Object.assign(new Error('classifier unavailable'),{code:frame.intentFailure==='unresolved'?'REQUEST_UNRESOLVED_NO_RESUBMIT':frame.intentFailure==='budget'?'BUDGET_EXCEEDED':undefined});
          return frame.combinedIntent;
        }}}:intentOptions;
        const routed=snap.control&&intentOptions?{intent:ruleIntent(snap.signals),routing:{decidedBy:'rule' as const,ruleIntent:ruleIntent(snap.signals)}}
          :await routeIntent(snap.signals,{text:[...value.text].slice(0,500).join(''),recentUserTurns:snap.recentUserTurns,seed:turn.id},snap.control?undefined:classifier,controller.signal);
        let intent=routed.intent,safety=frame.safety;const deflect=safety?.action==='deflect';
        const safetyCategory=safety&&(safety.action==='refuse'||safety.action==='support')?safety.category as Exclude<SafetyCategory,'prompt_injection'>:undefined;
        if(safetyCategory)intent='unsupported';else if(deflect&&intent==='timeline'&&session.retrievalMode!=='off'){intent='small_talk';safety={...safety!,intentOverride:'safety_deflect'};}
        return {...frame,intent,routing:routed.routing,safety,deflect,safetyCategory};
    });
    const builder=new StateGraph(TurnAnnotation)
      .addNode('initialize',stage('initialize',async()=>initialize()))
      .addNode('safety',stage('safety',async frame=>{
        const result=await assess(frame);check();
        if(result.safety?.fallbackReason)this.options.onSafetyFallback?.({scope:'turn',reason:result.safety.fallbackReason});
        return {...frame,...result};
      }))
      .addNode('intent',stage('intent',async frame=>decideIntent(frame)))
      .addNode('retrieve',stage('retrieve',async frame=>{
        const snap=frame.snapshot!,intent=frame.intent!;
        const fixed=(key:'rule_refusal'|'clarification'|'ambiguous_reference'|'event_timezone')=>snap.cardPath
          ?voiceText(({rule_refusal:'decline',clarification:'clarification',ambiguous_reference:'ambiguous_reference',event_timezone:'event_timezone'} as const satisfies Record<string,VoiceTextKey>)[key],snap.replyLanguage,snap.level,snap.previousAssistantText,turn.id):replyText(key,session.language);
        if(frame.output)return frame;
        if(intent==='clarification'||intent==='unsupported')return {...frame,output:{status:intent==='clarification'?'needs_clarification':'out_of_scope',content:intent==='clarification'?fixed('clarification'):frame.safetyCategory?safetyReply(frame.safetyCategory,snap.replyLanguage):fixed('rule_refusal'),claims:[],evidence:[],limitations:frame.safetyCategory==='self_harm'?['SAFETY_SUPPORT']:[]}};
        if(intent==='timeline'&&session.retrievalMode!=='off'&&snap.ambiguous)return {...frame,memoryTrace:{...frame.memoryTrace!,action:'clarify'},output:{status:'needs_clarification',content:fixed('ambiguous_reference'),claims:[],evidence:[],limitations:['AMBIGUOUS_SOURCE_REFERENCE']}};
        if(intent==='timeline'&&session.retrievalMode!=='off'&&snap.query.dateBasis==='event'&&snap.query.start&&snap.query.timezone!=='UTC')return {...frame,output:{status:'needs_clarification',content:fixed('event_timezone'),claims:[],evidence:[],limitations:['EVENT_TIMEZONE_UNAVAILABLE']}};
        if(intent==='timeline'&&session.retrievalMode==='off'&&session.ragCondition===undefined)return {...frame,output:{status:'insufficient_evidence',content:replyText('retrieval_off',session.language),claims:[],evidence:[],limitations:['RETRIEVAL_OFF']}};
        if(intent==='timeline'&&session.retrievalMode!=='off') {
          await transition('retrieving');
          const result=await retrieve(frame);check();return {...frame,...result};
        }
        return frame;
      }))
      .addNode('generate',stage('generate',async frame=>{
        await transition('generating');
        const result=await generate(frame);check();return result;
      }))
      .addNode('evidence',stage('evidence',async frame=>{
        if(frame.output)return frame;
        const snap=frame.snapshot!,result=frame.rawReply!,memorySources=frame.memorySources;let output:TurnOutput;let agent:ChatReply['agent'],promptEvidence:ChatReply['promptEvidence'];
        if(frame.agentRun) {
          agent=structuredClone(frame.agentRun.agent);
          output=validateExperimentReply(result,memorySources,session.personId,session.ragCondition??(session.retrievalMode==='off'?'off':'caption'),snap.replyLanguage,snap.level,snap.previousAssistantText,turn.id);
          if(!session.ragCondition&&frame.intent==='timeline')output=validateSourceBoundReply(result,memorySources,session.personId);
          if(!session.ragCondition&&frame.intent==='small_talk'&&containsUngroundedBiography(output.content))output={status:'insufficient_evidence',content:replyText('biography_guard',session.language),claims:[],evidence:[],limitations:['BIOGRAPHY_HEURISTIC_GUARD']};
          agent.steps.push({phase:'validation',iteration:agent.modelCalls-1});
          if(this.options.agentValidator&&(output.status==='answered'||output.limitations.includes('INVALID_MODEL_EVIDENCE')&&output.content!==voiceText('service_retry',snap.replyLanguage,snap.level,snap.previousAssistantText,turn.id))) {
            if(agent.toolCalls)agent.validator='skipped_tool_followup';else {
              agent.validator=await validateAgent({...frame,output});
              if(agent.validator!=='accepted')output={status:'insufficient_evidence',content:voiceText('service_retry',snap.replyLanguage,snap.level,snap.previousAssistantText,turn.id),claims:[],evidence:[],grounding:'unverified_model',limitations:[...output.limitations.filter(code=>/^[A-Z_]+$/.test(code)),`AGENT_VALIDATOR_${agent.validator.toUpperCase()}`]};
            }
          }
        } else if(session.ragCondition)output=validateExperimentReply(result,memorySources,session.personId,session.ragCondition,snap.replyLanguage,snap.level,snap.previousAssistantText,turn.id);
        else if(frame.intent==='timeline')output=validateSourceBoundReply(result,frame.sources,session.personId);
        else {
          const safe=result.trim();if(!safe||safe.length>8000||containsCredentialPattern(safe))throw new CoreError('TURN_FAILED','REPLY_REJECTED');
          output=containsUngroundedBiography(safe)?{status:'insufficient_evidence',content:replyText('biography_guard',session.language),claims:[],evidence:[],limitations:['BIOGRAPHY_HEURISTIC_GUARD']}:{status:'answered',content:safe,claims:[],evidence:[],limitations:[]};
        }
        const context=frame.agentRun?.context??frame.experiment;
        if(context)promptEvidence={sourceIds:context.sources.map(source=>source.id),annotationIds:context.sources.flatMap(source=>source.imageAnnotations?.map(annotation=>annotation.id)??[]),omittedAnnotations:context.omittedAnnotations,promptBytes:Buffer.byteLength(JSON.stringify(context.messages),'utf8'),...(context.omittedSourceIds.length?{omittedSourceIds:context.omittedSourceIds}:{})};
        if(shouldAskBack(frame.intent,session.ragCondition,value.text,output.evidence)
          &&!frame.agentRun?.serviceLimitation&&!output.limitations.some(code=>code.startsWith('AGENT_VALIDATOR_'))
          &&!isVoiceText('service_retry',output.content)) {
          const broaden=askBackStreak(snap.promptHistory)>=2;
          output={status:'needs_clarification',content:voiceText(broaden?'memory_topic_broaden':'memory_ask_back',snap.replyLanguage,snap.level,snap.previousAssistantText,turn.id),
            claims:[],evidence:[],grounding:'unverified_model',limitations:[broaden?'MEMORY_TOPIC_BROADEN':'MEMORY_ASK_BACK']};
        }
        return {...frame,output,agent,promptEvidence};
      }))
      .addNode('output_guard',stage('output_guard',async frame=>{
        // Deterministic safety/support texts do not go through a guard that could erase critical help resources.
        const result=frame.rawReply===undefined?{output:frame.output}:await outputGuard(frame);check();
        const output={...result.output!,limitations:[...result.output!.limitations]},snap=frame.snapshot!;
        let agent=frame.agent?structuredClone(frame.agent):undefined;
        if(agent&&frame.agentRun) {
          if(output.status==='answered'&&!frame.deflect)agent.variables=AgentVariablesSchema.parse({...agent.variables,...frame.agentRun.response.variableUpdates});
          if(frame.agentRun.serviceLimitation)output.limitations.push(frame.agentRun.serviceLimitation);
        }
        const context=frame.agentRun?.context??frame.experiment;
        if(context?.omittedAnnotations)output.limitations.push(`IMAGE_ANNOTATIONS_OMITTED:${context.omittedAnnotations}`);
        if(session.executionProfile==='agent_loop'&&!agent)agent={revision:AGENT_RUNTIME_REVISION,promptRevision:AGENT_PROMPT_REVISION,modelCalls:0,toolCalls:0,variables:AgentVariablesSchema.parse(snap.ownedPrevious?.agent?.variables),steps:[],validator:'disabled'};
        const remembered=rememberSourceContext(frame.memorySources,output.evidence),reply:ChatReply={...output,...(agent?{agent}:{}),...(remembered.length?{sourceContext:{revision:RETRIEVAL_CONTEXT_REVISION,references:remembered}}:{}),retrievalContext:frame.memoryTrace!,
          ...(frame.routing?{intentRouting:frame.routing}:{}),...(frame.safety?{inputSafety:frame.safety}:{}),...(frame.promptEvidence?{promptEvidence:frame.promptEvidence}:{}),...(frame.personaContext?{personaContext:frame.personaContext}:{}),...(result.replyGuard?{replyGuard:result.replyGuard}:{}),
          ...(frame.served.length?{serving:{calls:frame.served.length,upstreams:frame.served,secondaryCalls:frame.served.filter(name=>name==='secondary').length}}:{}),sessionId:session.id,turnId:turn.id,messageId:randomUUID(),personId:session.personId,personaRevision:session.personaRevision,
          responseKind:agent?.toolCalls&&output.evidence.length?'timeline':frame.intent==='small_talk'?'small_talk':frame.intent==='clarification'?'clarification':frame.intent==='unsupported'?'unsupported':'timeline'};
        return {...frame,...result,output,agent,reply};
      }))
      .addNode('persist',stage('persist',async frame=>{
        await transition('validating');check();
        if(!await store.completeTurn(turn.id,frame.reply!)) {
          // Ownership may change after the preceding transition. A rejected final write must leave this
          // attempt uncommitted so a fresh fenced worker can restart the cheap stages safely.
          controller.abort(LEASE_LOST);throw new CoreError('TURN_FAILED','TURN_ABORTED');
        }
        this.options.onTurnCompleted?.({turnId:turn.id,reply:frame.reply!});
        return frame;
      }))
      .addEdge(START,'initialize').addEdge('initialize','safety').addEdge('safety','intent').addEdge('intent','retrieve')
      .addConditionalEdges('retrieve',({frame}:TurnGraphState)=>frame.output?'evidence':'generate',['evidence','generate'])
      .addEdge('generate','evidence').addEdge('evidence','output_guard').addEdge('output_guard','persist').addEdge('persist',END);
    const graph=builder.compile();
    await graph.invoke({frame:{sources:[],memorySources:[],served:[]}},{recursionLimit:32});
  }
}
