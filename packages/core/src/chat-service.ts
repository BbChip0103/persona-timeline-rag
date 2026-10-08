import { randomUUID } from 'node:crypto';
import { CreateSessionSchema, PersonaSchema, SendTurnSchema, TimelineQuerySchema, type ChatReply, type ChatSession, type ChatTurn, type CreateSessionInput, type SendTurnInput, type SourcePost } from '@ptr/contracts';
import { CoreError, LEASE_LOST, type ConversationStore, type LeaseFence, type PersonaRepository, type QueuedTurn, type Retrieval, type TextProvider, type TurnDelivery, type TurnDispatch, type TurnEvents, type TurnLeaseStore } from './ports';
import { buildExperimentContext, buildPrompt } from './prompts';
import { requestFingerprint } from './request-fingerprint';
import { isPostMemoryRequest, rememberSourceContext, retrievalContext, RETRIEVAL_CONTEXT_REVISION } from './conversation-context';
import { containsCredentialPattern, containsUngroundedBiography, isBiographicalRequest } from './safety';
import { AgentVariablesSchema } from './agent-protocol';
import { AGENT_RUNTIME_REVISION, AGENT_PROMPT_REVISION, runCharacterAgent, type AgentValidator } from './agent-runtime';
import { filterEvidence, validateExperimentReply, validateSourceBoundReply } from './evidence';
export interface ChatServiceOptions {store:ConversationStore;personas:PersonaRepository;provider:TextProvider;retrieval?:Retrieval;timeoutMs?:number;maxHistoryMessages?:number;maxToolRounds?:number;agentValidator?:AgentValidator;
  /** Turns always run queued: startTurn reserves (with an outbox entry) and publishes; TurnWorker calls executeQueued. */
  leases:TurnLeaseStore;delivery:TurnDelivery;
  /** Backlog bound for admission control (default 256). */
  maxQueueDepth?:number;
  /** State-change notices for push delivery (SSE); never carries model output. */
  events?:TurnEvents;
  /** Observability hook: failed turns with a sanitized error class/code only (never messages or bodies). */
  onTurnFailure?:(failure:{turnId:string;code:string})=>void}
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
    listOwnedSessions:owner=>store.listOwnedSessions(owner),history:(id,owner)=>store.history(id,owner),
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
    const session:ChatSession={id:randomUUID(),ownerId,personId:value.personId,personaId:persona.id,personaRevision:persona.revision,language:persona.language,timezone:value.timezone,retrievalMode:value.retrievalMode,...(value.ragCondition ? {ragCondition:value.ragCondition}:value.executionProfile==='agent_loop'?{ragCondition:value.retrievalMode==='off'?'off' as const:'caption' as const}:{}),...(value.executionProfile?{executionProfile:value.executionProfile}:{}),createdAt:new Date().toISOString()};
    await this.options.store.create(session,{id:randomUUID(),sessionId:session.id,turnId:null,role:'assistant',content:`AI 연구용 시뮬레이션입니다. ${persona.greeting}`,createdAt:session.createdAt});
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
    catch {
      if(controller.signal.reason!==LEASE_LOST) await store.transitionTurn(queued.turn.id,[...activeStates],'failed','TURN_FAILED');
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
      const execution=this.execute(session,turn,value,query,controller,store);
      const timeout=new Promise<void>((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject(new CoreError('TURN_FAILED'));},this.options.timeoutMs ?? 30000);
        controller.signal.addEventListener('abort',()=>reject(new CoreError('TURN_FAILED')),{once:true});
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
      this.options.onTurnFailure?.({turnId:turn.id,code:typeof providerCode==='string'?providerCode
        :error instanceof Error?error.constructor.name:'UNKNOWN'});
    } finally { if(timer) clearTimeout(timer); }
  }
  private async execute(session:ChatSession,turn:ChatTurn,value:ReturnType<typeof SendTurnSchema.parse>,query:ReturnType<typeof TimelineQuerySchema.parse>,controller:AbortController,store:ConversationStore):Promise<void> {
    const history=await store.history(session.id,session.ownerId);
    if(history.length>(this.options.maxHistoryMessages ?? 100)) {
      await store.transitionTurn(turn.id,['pending'],'failed','CONTEXT_LIMIT');return;
    }
    const raw=await this.options.personas.get(session.personaId,session.personaRevision);
    const persona=PersonaSchema.parse(raw);
    if(persona.id !== session.personaId || persona.personId !== session.personId || persona.revision !== session.personaRevision) throw new CoreError('PERSONA_UNAVAILABLE');
    const context=retrievalContext(history,value.text,!!value.timeline);
    if(!value.timeline)query={...query,query:context.query};
    let memoryTrace:NonNullable<ChatReply['retrievalContext']>={revision:RETRIEVAL_CONTEXT_REVISION,action:'none',contextTurnIds:context.contextTurnIds,reusedSourceIds:[]};
    const previousMessage=[...history].reverse().find(message=>message.role==='user'&&message.turnId);
    const previous=(context.followUp||session.executionProfile==='agent_loop')&&previousMessage?.turnId?await store.getTurn(previousMessage.turnId,session.ownerId):undefined;
    const ownedPrevious=previous?.state==='completed'&&previous.ownerId===session.ownerId&&previous.sessionId===session.id
      &&previous.reply?.sessionId===session.id&&previous.reply.turnId===previous.id&&previous.reply.personId===session.personId
      &&previous.reply.personaRevision===session.personaRevision?previous.reply:undefined;
    const boundPrevious=context.followUp?ownedPrevious:undefined;
    const sensitive=/phone number|home address|private address|real.time location|rumou?r|secret relationship|연락처|전화번호|집 주소|주거지|실시간 위치|사생활|루머|미성년/i.test(value.text);
    const inferred=context.creative ? 'small_talk' : isBiographicalRequest(value.text) || /\b(when|where|visited|trip|travel|activity|posted|yesterday|last year|in 20\d\d|did you|were you|have you|your past|your family)\b|\d{4}[-년]|언제|어디|활동|여행|방문|그날|게시|지난|어제|그 여행|무슨 일|뭐 했|뭘 했|갔어|했어|가족/i.test(context.followUp?context.query:value.text) ? 'timeline' : 'small_talk';
    // Conservative explicit clarification/unsupported routes never answer or retrieve.
    // Explicit small_talk still cannot downgrade an obviously factual request.
    const intent=sensitive || value.intent==='unsupported' ? 'unsupported'
      : value.intent==='clarification' ? 'clarification'
      : value.timeline || inferred==='timeline' || !context.creative && (isPostMemoryRequest(value.text) || context.followUp && boundPrevious?.responseKind==='timeline') || !context.creative && session.ragCondition && /image|photo|picture|visual|이미지|사진|그림|작품|의도|분위기/i.test(value.text) ? 'timeline' : value.intent ?? inferred;
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
    if(intent==='clarification' || intent==='unsupported') {
      output={status:intent==='clarification'?'needs_clarification':'out_of_scope',content:intent==='clarification'?'어떤 날짜와 주제를 기준으로 볼까요?':'이 연구 자료 범위에서는 확인할 수 없어요.',claims:[],evidence:[],limitations:[]};
    } else if(intent==='timeline' && session.retrievalMode!=='off' && ambiguous) {
      memoryTrace={...memoryTrace,action:'clarify'};
      output={status:'needs_clarification',content:'앞에서 여러 게시물을 봤어요. 어느 글이나 사진을 말하는 건가요?',claims:[],evidence:[],limitations:['AMBIGUOUS_SOURCE_REFERENCE']};
    } else if(intent==='timeline' && session.retrievalMode !== 'off' && query.dateBasis==='event' && query.start && query.timezone !== 'UTC') {
      output={status:'needs_clarification',content:'사건 날짜의 현지 시간대가 확인되지 않았어요. 게시일 기준으로 확인할까요?',claims:[],evidence:[],limitations:['EVENT_TIMEZONE_UNAVAILABLE']};
    } else if(intent==='timeline' && session.retrievalMode==='off' && session.ragCondition===undefined) {
      output={status:'insufficient_evidence',content:'검색을 끈 상태에서는 실제 활동 근거를 확인할 수 없어요.',claims:[],evidence:[],limitations:['RETRIEVAL_OFF']};
    } else {
      if(intent==='timeline' && session.retrievalMode!=='off') {
        if(!this.options.retrieval) throw new CoreError('TURN_FAILED');
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
      const experiment=session.ragCondition&&session.executionProfile!=='agent_loop'?buildExperimentContext(persona,history,value.text,sources):undefined;
      memorySources=experiment?.sources??sources;
      if(experiment)promptEvidence={sourceIds:experiment.sources.map(source=>source.id),annotationIds:experiment.sources.flatMap(source=>source.imageAnnotations?.map(annotation=>annotation.id)??[]),
        omittedAnnotations:experiment.omittedAnnotations,promptBytes:Buffer.byteLength(JSON.stringify(experiment.messages),'utf8')};
      const agentRun=session.executionProfile==='agent_loop'?await runCharacterAgent({
        provider:this.options.provider,persona,history,text:value.text,sources,signal:controller.signal,maxToolRounds:this.options.maxToolRounds,
        variables:AgentVariablesSchema.parse(ownedPrevious?.agent?.variables),
        ...(session.retrievalMode!=='off'&&!context.creative&&this.options.retrieval?{search:async(toolQuery:string)=>{
          if(controller.signal.aborted)throw new CoreError('TURN_FAILED');
          const scopedQuery=TimelineQuerySchema.parse({...query,query:toolQuery});
          const found=filterEvidence(await this.options.retrieval!.search(scopedQuery,{personId:session.personId},{signal:controller.signal,mode:session.retrievalMode as 'lexical'|'semantic',
            ...(session.ragCondition&&session.ragCondition!=='off'?{evidenceScope:session.ragCondition}:{})}),scopedQuery,session.personId);
          memoryTrace={...memoryTrace,action:'search',query:toolQuery};
          return session.ragCondition==='caption_image'?found:found.map(({imageAnnotations:_,...source})=>source);
        }}:{}),
      }):undefined;
      const result=agentRun?.rawReply??await this.options.provider.generate(experiment?.messages ?? buildPrompt(persona,history,value.text,sources,intent==='timeline'),{signal:controller.signal});
      if(controller.signal.aborted) return;
      if(agentRun) {
        agent=agentRun.agent;memorySources=agentRun.context.sources;
        promptEvidence={sourceIds:memorySources.map(source=>source.id),annotationIds:memorySources.flatMap(source=>source.imageAnnotations?.map(annotation=>annotation.id)??[]),
          omittedAnnotations:agentRun.context.omittedAnnotations,promptBytes:Buffer.byteLength(JSON.stringify(agentRun.context.messages),'utf8')};
        output=validateExperimentReply(result,memorySources,session.personId,session.ragCondition??(session.retrievalMode==='off'?'off':'caption'));
        if(!session.ragCondition&&intent==='timeline')output=validateSourceBoundReply(result,memorySources,session.personId);
        if(!session.ragCondition&&intent==='small_talk'&&containsUngroundedBiography(output.content))output={status:'insufficient_evidence',content:'실제 생애나 과거 활동에 대한 근거 없이 이야기할 수 없어요.',claims:[],evidence:[],limitations:['BIOGRAPHY_HEURISTIC_GUARD']};
        agent.steps.push({phase:'validation',iteration:agent.modelCalls-1});
        if(this.options.agentValidator&&output.status==='answered') {
          if(agent.toolCalls)agent.validator='skipped_tool_followup';
          else {
            try {agent.validator=await this.options.agentValidator.validate({question:value.text,answer:output.content,sources:memorySources,personId:session.personId,signal:controller.signal})==='accept'?'accepted':'rejected';}
            catch {agent.validator='error';}
            if(agent.validator!=='accepted')output={status:'insufficient_evidence',content:'지금 자료만으로는 확실하게 이야기하기 어려워요.',claims:[],evidence:[],limitations:[`AGENT_VALIDATOR_${agent.validator.toUpperCase()}`]};
          }
        }
        if(output.status==='answered')agent.variables=AgentVariablesSchema.parse({...agent.variables,...agentRun.response.variableUpdates});
        if(agentRun.serviceLimitation)output.limitations.push(agentRun.serviceLimitation);
        if(agentRun.context.omittedAnnotations)output.limitations.push(`IMAGE_ANNOTATIONS_OMITTED:${agentRun.context.omittedAnnotations}`);
      }
      else if(session.ragCondition) {
        output=validateExperimentReply(result,experiment!.sources,session.personId,session.ragCondition);
        if(experiment!.omittedAnnotations)output.limitations.push(`IMAGE_ANNOTATIONS_OMITTED:${experiment!.omittedAnnotations}`);
      }
      else if(intent==='timeline') output=validateSourceBoundReply(result,sources,session.personId);
      else {
        const safe=result.trim();
        if(!safe || safe.length>8000 || containsCredentialPattern(safe)) throw new CoreError('TURN_FAILED');
        output=containsUngroundedBiography(safe)
          ? {status:'insufficient_evidence',content:'실제 생애나 과거 활동에 대한 근거 없이 이야기할 수 없어요.',claims:[],evidence:[],limitations:['BIOGRAPHY_HEURISTIC_GUARD']}
          : {status:'answered',content:safe,claims:[],evidence:[],limitations:[]};
      }
    }
    if(controller.signal.aborted || !await store.transitionTurn(turn.id,['pending','generating'],'validating')) return;
    if(session.executionProfile==='agent_loop'&&!agent)agent={revision:AGENT_RUNTIME_REVISION,promptRevision:AGENT_PROMPT_REVISION,modelCalls:0,toolCalls:0,variables:AgentVariablesSchema.parse(ownedPrevious?.agent?.variables),steps:[],validator:'disabled'};
    const remembered=rememberSourceContext(memorySources,output.evidence);
    const reply:ChatReply={...output,...(agent?{agent}:{}),...(remembered.length?{sourceContext:{revision:RETRIEVAL_CONTEXT_REVISION,references:remembered}}:{}),retrievalContext:memoryTrace,...(promptEvidence?{promptEvidence}:{}),sessionId:session.id,turnId:turn.id,messageId:randomUUID(),personId:session.personId,personaRevision:session.personaRevision,responseKind:agent?.toolCalls&&output.evidence.length?'timeline':intent==='small_talk'?'small_talk':intent==='clarification'?'clarification':intent==='unsupported'?'unsupported':'timeline'};
    if(!controller.signal.aborted) await store.completeTurn(turn.id,reply);
  }
}
