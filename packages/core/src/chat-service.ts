import { randomUUID } from 'node:crypto';
import { CreateSessionSchema, PersonaSchema, SendTurnSchema, TimelineQuerySchema, type ChatReply, type InputSafetyTrace, type ChatSession, type ChatTurn, type CreateSessionInput, type ProviderMessage, type SendTurnInput, type SourcePost } from '@ptr/contracts';
import { CoreError, LEASE_LOST, type ConversationStore, type LeaseFence, type PersonaRepository, type QueuedTurn, type Retrieval, type TextProvider, type TurnDelivery, type TurnDispatch, type TurnEvents, type TurnLeaseStore } from './ports';
import { buildExperimentContext, buildPrompt } from './prompts';
import { requestFingerprint } from './request-fingerprint';
import { rememberSourceContext, retrievalContext, RETRIEVAL_CONTEXT_REVISION } from './conversation-context';
import { containsCredentialPattern, containsUngroundedBiography } from './safety';
import { intentSignals, isSensitive, needsIntentClassifier, routeIntent, ruleIntent, type IntentClassifierOptions } from './intent-routing';
import { RULE_PATH_CATEGORIES, SAFETY_CATEGORIES, SAFETY_DEFLECTION_NOTE, safetyOutcome, safetyReply, startSafetyAssessment, withoutRefusedTurns, type InputSafetyOptions, type SafetyCategory } from './input-safety';
import { AgentVariablesSchema } from './agent-protocol';
import { AGENT_RUNTIME_REVISION, AGENT_PROMPT_REVISION, runCharacterAgent, type AgentValidator } from './agent-runtime';
import { filterEvidence, validateExperimentReply, validateSourceBoundReply } from './evidence';
import { aiDisclosurePrefix, greetingIndexFor, greetingsOf, matchLore, renderLoreMessage } from './persona-card';
import { REPLY_GUARD_REVISION, guardReply } from './reply-guard';
import { replyText } from './reply-texts';
export interface ChatServiceOptions {store:ConversationStore;personas:PersonaRepository;provider:TextProvider;retrieval?:Retrieval;timeoutMs?:number;maxHistoryMessages?:number;maxToolRounds?:number;agentValidator?:AgentValidator;
  /** Turns always run queued: startTurn reserves (with an outbox entry) and publishes; TurnWorker calls executeQueued. */
  leases:TurnLeaseStore;delivery:TurnDelivery;
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
  onSafetyFallback?:(event:{scope:'turn'|'draft';reason:string})=>void}
/** Backlog readings are reused briefly so admission control stays cheap while it is rejecting. */
const DEPTH_READING_TTL_MS=200;
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
    listOwnedSessions:owner=>store.listOwnedSessions(owner),history:(id,owner)=>store.history(id,owner),refusedTurnIds:(id,owner)=>store.refusedTurnIds(id,owner),
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
    const parsed=CreateSessionSchema.safeParse(input);
    if(!parsed.success) throw new CoreError('INVALID_INPUT');
    const value=parsed.data;
    const raw=await this.options.personas.get(value.personaId,value.personaRevision);
    const result=PersonaSchema.safeParse(raw);
    if(!result.success) throw new CoreError('PERSONA_UNAVAILABLE');
    const persona=result.data;
    if(persona.id !== value.personaId || persona.revision !== value.personaRevision || persona.personId !== value.personId) throw new CoreError('FORBIDDEN');
    // Greeting : an explicit index (evaluations pin 0) or one derived from the session id. The index is
    // stored only when it was given or there is a choice, so v1 personas keep their session shape.
    const greetings=greetingsOf(persona);
    if(value.greetingIndex!==undefined&&value.greetingIndex>=greetings.length) throw new CoreError('INVALID_INPUT');
    const id=randomUUID();
    const greetingIndex=value.greetingIndex??greetingIndexFor(id,greetings.length);
    const session:ChatSession={id,ownerId,personId:value.personId,personaId:persona.id,personaRevision:persona.revision,language:persona.language,timezone:value.timezone,retrievalMode:value.retrievalMode,...(value.ragCondition ? {ragCondition:value.ragCondition}:value.executionProfile==='agent_loop'?{ragCondition:value.retrievalMode==='off'?'off' as const:'caption' as const}:{}),...(value.executionProfile?{executionProfile:value.executionProfile}:{}),createdAt:new Date().toISOString(),
      ...(value.greetingIndex!==undefined||greetings.length>1?{greetingIndex}:{})};
    await this.options.store.create(session,{id:randomUUID(),sessionId:session.id,turnId:null,role:'assistant',content:`${aiDisclosurePrefix(persona.language)}${greetings[greetingIndex]}`,createdAt:session.createdAt});
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
    if(!options) return {limitations:[]};
    const trace=safetyOutcome(await startSafetyAssessment(options,{text:brief,recentUserTurns:[],seed,intent:false,categories:SAFETY_CATEGORIES},signal).all,options,signal);
    if(trace.fallbackReason) this.options.onSafetyFallback?.({scope:'draft',reason:trace.fallbackReason});
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
      const message=error instanceof CoreError&&error.code==='TURN_FAILED'&&error.message!==error.code?error.message:undefined;
      this.options.onTurnFailure?.({turnId:turn.id,code:message!==undefined?constant(message):typeof providerCode==='string'?constant(providerCode)
        :error instanceof Error?error.constructor.name:'UNKNOWN'});
    } finally { if(timer) clearTimeout(timer); }
  }
  private async execute(session:ChatSession,turn:ChatTurn,value:ReturnType<typeof SendTurnSchema.parse>,query:ReturnType<typeof TimelineQuerySchema.parse>,controller:AbortController,store:ConversationStore,deadlineAt:number):Promise<void> {
    const history=await store.history(session.id,session.ownerId);
    if(history.length>(this.options.maxHistoryMessages ?? 100)) {
      await store.transitionTurn(turn.id,['pending'],'failed','CONTEXT_LIMIT');return;
    }
    const raw=await this.options.personas.get(session.personaId,session.personaRevision);
    const persona=PersonaSchema.parse(raw);
    if(persona.id !== session.personaId || persona.personId !== session.personId || persona.revision !== session.personaRevision) throw new CoreError('PERSONA_UNAVAILABLE');
    // With the filter on, refused turns (from their turn records) are dropped from everything that builds prompts or
    // retrieval queries; the full history still sizes the session and feeds the safety classifier's context.
    const promptHistory=this.options.inputSafety?withoutRefusedTurns(history,await store.refusedTurnIds(session.id,session.ownerId)):history;
    const context=retrievalContext(promptHistory,value.text,!!value.timeline);
    if(!value.timeline)query={...query,query:context.query};
    let memoryTrace:NonNullable<ChatReply['retrievalContext']>={revision:RETRIEVAL_CONTEXT_REVISION,action:'none',contextTurnIds:context.contextTurnIds,reusedSourceIds:[]};
    const previousMessage=[...promptHistory].reverse().find(message=>message.role==='user'&&message.turnId);
    const previous=(context.followUp||session.executionProfile==='agent_loop')&&previousMessage?.turnId?await store.getTurn(previousMessage.turnId,session.ownerId):undefined;
    const ownedPrevious=previous?.state==='completed'&&previous.ownerId===session.ownerId&&previous.sessionId===session.id
      &&previous.reply?.sessionId===session.id&&previous.reply.turnId===previous.id&&previous.reply.personId===session.personId
      &&previous.reply.personaRevision===session.personaRevision?previous.reply:undefined;
    const boundPrevious=context.followUp?ownedPrevious:undefined;
    const signals=intentSignals({text:value.text,context,...(value.intent?{explicitIntent:value.intent}:{}),explicitTimeline:!!value.timeline,
      ...(session.ragCondition?{ragCondition:session.ragCondition}:{}),previousTimeline:boundPrevious?.responseKind==='timeline'});
    // Only the current text and the last two non-sensitive user turns may reach a classifier: no persona, posts, replies or IDs.
    const recentUserTurns=history.filter(message=>message.role==='user'&&message.turnId!==null&&!containsCredentialPattern(message.content)&&!isSensitive(message.content)).slice(-2).map(message=>[...message.content].slice(0,300).join(''));
    // Retrieval-off control sessions keep the pure rule routing (no classifier call) so experiment arms stay
    // unchanged; with a classifier configured, the internal trace still records that the rule decided.
    const control=session.retrievalMode==='off'&&!session.ragCondition;
    const classifierInput={text:[...value.text].slice(0,500).join(''),recentUserTurns,seed:turn.id};
    // Input safety runs on every turn (control sessions included) over the whole message. Turns the rules refuse ask
    // only self_harm (support may replace the refusal). When the intent gate is open, window 0 also answers intent.
    const safetyOptions=this.options.inputSafety;const intentOptions=this.options.intentClassifier;
    const rule=signals.sensitive?'sensitive_pattern' as const:signals.explicitIntent==='unsupported'?'client_unsupported' as const:undefined;
    const combined=!!safetyOptions&&!!intentOptions&&!control&&needsIntentClassifier(signals);
    const safetyRun=safetyOptions?startSafetyAssessment(safetyOptions,{text:value.text,recentUserTurns,seed:turn.id,intent:combined,categories:rule?RULE_PATH_CATEGORIES:SAFETY_CATEGORIES},controller.signal):undefined;
    const classifier=safetyRun&&combined?{...intentOptions!,classifier:{name:intentOptions!.classifier.name,classify:async()=>{
      const settled=await safetyRun.first;
      if(!settled.ok) throw settled.error;
      if(settled.value.intent instanceof Error) throw settled.value.intent;
      return settled.value.intent;
    }}}:intentOptions;
    const routed=control&&intentOptions?{intent:ruleIntent(signals),routing:{decidedBy:'rule' as const,ruleIntent:ruleIntent(signals)}}
      :await routeIntent(signals,classifierInput,control?undefined:classifier,controller.signal);
    const routing=routed.routing;let intent=routed.intent;
    let safety=safetyRun?safetyOutcome(await safetyRun.all,safetyOptions!,controller.signal,rule):undefined;
    if(controller.signal.aborted) return;
    if(safety?.fallbackReason) this.options.onSafetyFallback?.({scope:'turn',reason:safety.fallbackReason});
    // Refusal/support replies are deterministic templates (no chat model); deflection answers without retrieval.
    const safetyCategory=safety?.decidedBy==='classifier'&&(safety.action==='refuse'||safety.action==='support')?safety.category as Exclude<SafetyCategory,'prompt_injection'>:undefined;
    const deflect=safety?.action==='deflect';
    if(safetyCategory) intent='unsupported';
    else if(deflect&&intent==='timeline'&&session.retrievalMode!=='off') {intent='small_talk';safety={...safety!,intentOverride:'safety_deflect'};}
    let output:Pick<ChatReply,'status'|'content'|'claims'|'evidence'|'limitations'|'grounding'>;
    let sources:SourcePost[]=[];
    let memorySources:SourcePost[]=[];
    const references=context.followUp&&!value.timeline&&boundPrevious?.grounding==='source_bound_quotes'&&boundPrevious.responseKind==='timeline'
      ?(boundPrevious.sourceContext?.revision===RETRIEVAL_CONTEXT_REVISION?boundPrevious.sourceContext.references:boundPrevious.evidence)
        .filter(ref=>ref.personId===session.personId&&boundPrevious.evidence.some(cited=>cited.sourceId===ref.sourceId&&cited.hash===ref.hash&&cited.snapshot===ref.snapshot)):[];
    const ambiguous=new Set(references.map(ref=>ref.sourceId)).size>1
      || /photo|picture|사진/i.test(value.text)&&new Set((boundPrevious?.evidence??[]).flatMap(ref=>ref.annotationId?[ref.annotationId]:[])).size>1;
    let promptEvidence:ChatReply['promptEvidence'];
    let agent:ChatReply['agent'];
    let personaContext:ChatReply['personaContext'];let lore:ProviderMessage|undefined;
    let replyGuard:ChatReply['replyGuard'];
    // Reply guard (agent and experiment paths, S8 follow-up): fail-closed fixed reply in the session language.
    const guard=(candidate:typeof output):typeof output=>{
      const guarded=guardReply({utterance:value.text,reply:candidate.content,realPerson:persona.reviewStatus!=='synthetic',language:session.language});
      replyGuard=guarded?{revision:REPLY_GUARD_REVISION,action:'replaced',reason:guarded.reason}:{revision:REPLY_GUARD_REVISION,action:'none'};
      return guarded?{status:'out_of_scope',content:guarded.content,claims:[],evidence:[],grounding:'unverified_model',limitations:[`REPLY_GUARD_${guarded.reason.toUpperCase()}`]}:candidate;
    };
    if(intent==='clarification' || intent==='unsupported') {
      output={status:intent==='clarification'?'needs_clarification':'out_of_scope',content:intent==='clarification'?replyText('clarification',session.language):safetyCategory?safetyReply(safetyCategory,session.language):replyText('rule_refusal',session.language),claims:[],evidence:[],limitations:safetyCategory==='self_harm'?['SAFETY_SUPPORT']:[]};
    } else if(intent==='timeline' && session.retrievalMode!=='off' && ambiguous) {
      memoryTrace={...memoryTrace,action:'clarify'};
      output={status:'needs_clarification',content:replyText('ambiguous_reference',session.language),claims:[],evidence:[],limitations:['AMBIGUOUS_SOURCE_REFERENCE']};
    } else if(intent==='timeline' && session.retrievalMode !== 'off' && query.dateBasis==='event' && query.start && query.timezone !== 'UTC') {
      output={status:'needs_clarification',content:replyText('event_timezone',session.language),claims:[],evidence:[],limitations:['EVENT_TIMEZONE_UNAVAILABLE']};
    } else if(intent==='timeline' && session.retrievalMode==='off' && session.ragCondition===undefined) {
      output={status:'insufficient_evidence',content:replyText('retrieval_off',session.language),claims:[],evidence:[],limitations:['RETRIEVAL_OFF']};
    } else {
      if(intent==='timeline' && session.retrievalMode!=='off') {
        if(!this.options.retrieval) throw new CoreError('TURN_FAILED','RETRIEVAL_UNAVAILABLE');
        if(!await store.transitionTurn(turn.id,['pending'],'retrieving') || controller.signal.aborted) return;
        const lookupOptions={signal:controller.signal,...(session.ragCondition && session.ragCondition!=='off'?{evidenceScope:session.ragCondition}:{})};
        if(references.length&&this.options.retrieval.resolve) {
          const resolved=await this.options.retrieval.resolve(references,{personId:session.personId},lookupOptions);
          // Recheck parent provenance even for a faulty resolver; annotations remain pinned to cited revisions.
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
        if(session.ragCondition!=='caption_image') sources=sources.map(({imageAnnotations:_,...source})=>source);
      }
      if(!await store.transitionTurn(turn.id,['pending','retrieving'],'generating') || controller.signal.aborted) return;
      const policyNote=deflect?SAFETY_DEFLECTION_NOTE:undefined;
      // Persona lore , experiment and agent paths only: never on a deflected turn; the last two user
      // messages count unless the input-safety filter acted on their turn (deflected injections stay in the history).
      const cardPath=!!session.ragCondition||session.executionProfile==='agent_loop';
      if(cardPath&&persona.lore?.length) {
        const previous:string[]=[];
        if(!deflect) for(const message of promptHistory.filter(message=>message.role==='user'&&message.turnId).slice(-2)) {
          // Fail closed: a turn whose record cannot be read counts as flagged.
          const record=await store.getTurn(message.turnId!,session.ownerId);
          if(record&&(record.reply?.inputSafety?.action??'none')==='none') previous.push(message.content);
        }
        const matched=deflect?{entries:[],omitted:0}:matchLore(persona,{current:value.text,previous});
        personaContext={loreIds:matched.entries.map(entry=>entry.id),loreOmitted:matched.omitted};
        if(matched.entries.length) lore=renderLoreMessage(matched.entries);
      }
      const experiment=session.ragCondition&&session.executionProfile!=='agent_loop'?buildExperimentContext(persona,promptHistory,value.text,sources,policyNote||lore?{...(policyNote?{policyNote}:{}),...(lore?{afterHistory:[lore]}:{})}:undefined):undefined;
      memorySources=experiment?.sources??sources;
      if(experiment)promptEvidence={sourceIds:experiment.sources.map(source=>source.id),annotationIds:experiment.sources.flatMap(source=>source.imageAnnotations?.map(annotation=>annotation.id)??[]),
        omittedAnnotations:experiment.omittedAnnotations,promptBytes:Buffer.byteLength(JSON.stringify(experiment.messages),'utf8')};
      const agentRun=session.executionProfile==='agent_loop'?await runCharacterAgent({
        provider:this.options.provider,persona,history:promptHistory,text:value.text,sources,signal:controller.signal,maxToolRounds:this.options.maxToolRounds,requestKey:turn.id,deadlineAt,
        variables:AgentVariablesSchema.parse(ownedPrevious?.agent?.variables),...(policyNote?{policyNote}:{}),...(lore?{lore}:{}),
        ...(session.retrievalMode!=='off'&&!context.creative&&!deflect&&this.options.retrieval?{search:async(toolQuery:string)=>{
          if(controller.signal.aborted)throw new CoreError('TURN_FAILED','TURN_ABORTED');
          const scopedQuery=TimelineQuerySchema.parse({...query,query:toolQuery});
          const found=filterEvidence(await this.options.retrieval!.search(scopedQuery,{personId:session.personId},{signal:controller.signal,mode:session.retrievalMode as 'lexical'|'semantic',
            ...(session.ragCondition&&session.ragCondition!=='off'?{evidenceScope:session.ragCondition}:{})}),scopedQuery,session.personId);
          memoryTrace={...memoryTrace,action:'search',query:toolQuery};
          return session.ragCondition==='caption_image'?found:found.map(({imageAnnotations:_,...source})=>source);
        }}:{}),
      }):undefined;
      const result=agentRun?.rawReply??await this.options.provider.generate(experiment?.messages ?? buildPrompt(persona,promptHistory,value.text,sources,intent==='timeline',policyNote),{signal:controller.signal,requestKey:turn.id,deadlineAt});
      if(controller.signal.aborted) return;
      if(agentRun) {
        agent=agentRun.agent;memorySources=agentRun.context.sources;
        promptEvidence={sourceIds:memorySources.map(source=>source.id),annotationIds:memorySources.flatMap(source=>source.imageAnnotations?.map(annotation=>annotation.id)??[]),
          omittedAnnotations:agentRun.context.omittedAnnotations,promptBytes:Buffer.byteLength(JSON.stringify(agentRun.context.messages),'utf8')};
        output=validateExperimentReply(result,memorySources,session.personId,session.ragCondition??(session.retrievalMode==='off'?'off':'caption'),session.language);
        if(!session.ragCondition&&intent==='timeline')output=validateSourceBoundReply(result,memorySources,session.personId);
        if(!session.ragCondition&&intent==='small_talk'&&containsUngroundedBiography(output.content))output={status:'insufficient_evidence',content:replyText('biography_guard',session.language),claims:[],evidence:[],limitations:['BIOGRAPHY_HEURISTIC_GUARD']};
        agent.steps.push({phase:'validation',iteration:agent.modelCalls-1});
        if(this.options.agentValidator&&output.status==='answered') {
          if(agent.toolCalls)agent.validator='skipped_tool_followup';
          else {
            try {agent.validator=await this.options.agentValidator.validate({question:value.text,answer:output.content,sources:memorySources,personId:session.personId,signal:controller.signal})==='accept'?'accepted':'rejected';}
            catch {agent.validator='error';}
            if(agent.validator!=='accepted')output={status:'insufficient_evidence',content:replyText('validator_rejected',session.language),claims:[],evidence:[],limitations:[`AGENT_VALIDATOR_${agent.validator.toUpperCase()}`]};
          }
        }
        output=guard(output);
        // A deflected turn never updates the conversational state the injection attempt may have targeted.
        if(output.status==='answered'&&!deflect)agent.variables=AgentVariablesSchema.parse({...agent.variables,...agentRun.response.variableUpdates});
        if(agentRun.serviceLimitation)output.limitations.push(agentRun.serviceLimitation);
        if(agentRun.context.omittedAnnotations)output.limitations.push(`IMAGE_ANNOTATIONS_OMITTED:${agentRun.context.omittedAnnotations}`);
      }
      else if(session.ragCondition) {
        output=guard(validateExperimentReply(result,experiment!.sources,session.personId,session.ragCondition,session.language));
        if(experiment!.omittedAnnotations)output.limitations.push(`IMAGE_ANNOTATIONS_OMITTED:${experiment!.omittedAnnotations}`);
      }
      else if(intent==='timeline') output=validateSourceBoundReply(result,sources,session.personId);
      else {
        const safe=result.trim();
        if(!safe || safe.length>8000 || containsCredentialPattern(safe)) throw new CoreError('TURN_FAILED','REPLY_REJECTED');
        output=containsUngroundedBiography(safe)
          ? {status:'insufficient_evidence',content:replyText('biography_guard',session.language),claims:[],evidence:[],limitations:['BIOGRAPHY_HEURISTIC_GUARD']}
          : {status:'answered',content:safe,claims:[],evidence:[],limitations:[]};
      }
    }
    if(controller.signal.aborted || !await store.transitionTurn(turn.id,['pending','generating'],'validating')) return;
    if(session.executionProfile==='agent_loop'&&!agent)agent={revision:AGENT_RUNTIME_REVISION,promptRevision:AGENT_PROMPT_REVISION,modelCalls:0,toolCalls:0,variables:AgentVariablesSchema.parse(ownedPrevious?.agent?.variables),steps:[],validator:'disabled'};
    const remembered=rememberSourceContext(memorySources,output.evidence);
    const reply:ChatReply={...output,...(agent?{agent}:{}),...(remembered.length?{sourceContext:{revision:RETRIEVAL_CONTEXT_REVISION,references:remembered}}:{}),retrievalContext:memoryTrace,...(routing?{intentRouting:routing}:{}),...(safety?{inputSafety:safety}:{}),...(promptEvidence?{promptEvidence}:{}),...(personaContext?{personaContext}:{}),...(replyGuard?{replyGuard}:{}),sessionId:session.id,turnId:turn.id,messageId:randomUUID(),personId:session.personId,personaRevision:session.personaRevision,responseKind:agent?.toolCalls&&output.evidence.length?'timeline':intent==='small_talk'?'small_talk':intent==='clarification'?'clarification':intent==='unsupported'?'unsupported':'timeline'};
    if(!controller.signal.aborted) await store.completeTurn(turn.id,reply);
  }
}
