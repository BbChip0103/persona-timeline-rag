import { randomUUID } from 'node:crypto';
import { CreateSessionSchema, PersonaSchema, SendTurnSchema, TimelineQuerySchema, type ChatReply, type ChatSession, type ChatTurn, type CreateSessionInput, type SendTurnInput, type SourcePost } from '@ptr/contracts';
import { CoreError, type ConversationStore, type PersonaRepository, type Retrieval, type TextProvider } from './ports';
import { buildExperimentContext, buildPrompt } from './prompts';
import { requestFingerprint } from './request-fingerprint';
import { isPostMemoryRequest, retrievalContext, RETRIEVAL_CONTEXT_REVISION } from './conversation-context';
import { containsCredentialPattern, containsUngroundedBiography, isBiographicalRequest } from './safety';
import { filterEvidence, validateExperimentReply, validateSourceBoundReply } from './evidence';
export interface ChatServiceOptions {store:ConversationStore;personas:PersonaRepository;provider:TextProvider;retrieval?:Retrieval;timeoutMs?:number;maxHistoryMessages?:number}
const activeStates=['pending','retrieving','generating','validating'] as const;
export class ChatService {
  private readonly controllers=new Map<string,AbortController>();
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
    const session:ChatSession={id:randomUUID(),ownerId,personId:value.personId,personaId:persona.id,personaRevision:persona.revision,language:persona.language,timezone:value.timezone,retrievalMode:value.retrievalMode,...(value.ragCondition ? {ragCondition:value.ragCondition}:{}),createdAt:new Date().toISOString()};
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
    if(cancelled) this.controllers.get(turnId)?.abort();return cancelled;
  }
  /** Returns the reserved/current turn immediately; final output remains private until validation. */
  startTurn(ownerId:string,input:SendTurnInput):Promise<ChatTurn> {
    return new Promise((resolve,reject)=>{void this.runTurn(ownerId,input,resolve).catch(reject);});
  }
  sendTurn(ownerId:string,input:SendTurnInput):Promise<ChatTurn> { return this.runTurn(ownerId,input); }
  private async runTurn(ownerId:string,input:SendTurnInput,onReserved?:(turn:ChatTurn)=>void):Promise<ChatTurn> {
    const checked=SendTurnSchema.safeParse(input);
    if(!checked.success) throw new CoreError('INVALID_INPUT');
    const value=checked.data;
    if(containsCredentialPattern(value.text)) throw new CoreError('INVALID_INPUT');
    const session=await this.getSession(ownerId,value.sessionId);
    // Verify structured ranges before reserving a turn or calling any external port.
    const queryResult=TimelineQuerySchema.safeParse({personId:session.personId,query:value.timeline?.query ?? value.text.slice(0,500),start:value.timeline?.start,end:value.timeline?.end,dateBasis:value.timeline?.dateBasis ?? 'posted',timezone:session.timezone,limit:value.timeline?.limit ?? 5});
    if(!queryResult.success || containsCredentialPattern(queryResult.data.query??'')) throw new CoreError('INVALID_INPUT');
    const reserved=await this.options.store.reserveTurn(session.id,ownerId,value.clientRequestId,value.text,requestFingerprint(value,session.ragCondition));
    onReserved?.(structuredClone(reserved.turn));
    if(!reserved.created) return reserved.turn;
    const turn=reserved.turn;
    const controller=new AbortController();this.controllers.set(turn.id,controller);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      const execution=this.execute(session,turn,value,queryResult.data,controller);
      const timeout=new Promise<void>((_,reject)=>{
        timer=setTimeout(()=>{controller.abort();reject(new CoreError('TURN_FAILED'));},this.options.timeoutMs ?? 30000);
        controller.signal.addEventListener('abort',()=>reject(new CoreError('TURN_FAILED')),{once:true});
      });
      await Promise.race([execution,timeout]);
    } catch (error) {
      // Never persist/return provider error strings: they can contain raw keys, prompts or paths.
      await this.options.store.transitionTurn(turn.id,[...activeStates],'failed',error instanceof CoreError && error.code==='CONTEXT_LIMIT'?'CONTEXT_LIMIT':'TURN_FAILED');
    } finally { if(timer) clearTimeout(timer); this.controllers.delete(turn.id); }
    return this.getTurn(ownerId,turn.id);
  }
  private async execute(session:ChatSession,turn:ChatTurn,value:ReturnType<typeof SendTurnSchema.parse>,query:ReturnType<typeof TimelineQuerySchema.parse>,controller:AbortController):Promise<void> {
    const history=await this.options.store.history(session.id,session.ownerId);
    if(history.length>(this.options.maxHistoryMessages ?? 100)) {
      await this.options.store.transitionTurn(turn.id,['pending'],'failed','CONTEXT_LIMIT');return;
    }
    const raw=await this.options.personas.get(session.personaId,session.personaRevision);
    const persona=PersonaSchema.parse(raw);
    if(persona.id !== session.personaId || persona.personId !== session.personId || persona.revision !== session.personaRevision) throw new CoreError('PERSONA_UNAVAILABLE');
    const context=retrievalContext(history,value.text,!!value.timeline);
    if(!value.timeline)query={...query,query:context.query};
    let memoryTrace:NonNullable<ChatReply['retrievalContext']>={revision:RETRIEVAL_CONTEXT_REVISION,action:'none',contextTurnIds:context.contextTurnIds,reusedSourceIds:[]};
    const previousMessage=[...history].reverse().find(message=>message.role==='user'&&message.turnId);
    const previous=context.followUp&&previousMessage?.turnId?await this.options.store.getTurn(previousMessage.turnId,session.ownerId):undefined;
    const boundPrevious=previous?.state==='completed'&&previous.ownerId===session.ownerId&&previous.sessionId===session.id
      &&previous.reply?.sessionId===session.id&&previous.reply.turnId===previous.id&&previous.reply.personId===session.personId
      &&previous.reply.personaRevision===session.personaRevision?previous.reply:undefined;
    const sensitive=/phone number|home address|private address|real.time location|rumou?r|secret relationship|연락처|전화번호|집 주소|주거지|실시간 위치|사생활|루머|미성년/i.test(value.text);
    const inferred=context.creative ? 'small_talk' : isBiographicalRequest(value.text) || /\b(when|where|visited|trip|travel|activity|posted|yesterday|last year|in 20\d\d|did you|were you|have you|your past|your family)\b|\d{4}[-년]|언제|어디|활동|여행|방문|그날|게시|지난|어제|그 여행|무슨 일|뭐 했|뭘 했|갔어|했어|가족/i.test(context.followUp?context.query:value.text) ? 'timeline' : 'small_talk';
    // Conservative explicit clarification/unsupported routes never answer or retrieve.
    // Explicit small_talk still cannot downgrade an obviously factual request.
    const intent=sensitive || value.intent==='unsupported' ? 'unsupported'
      : value.intent==='clarification' ? 'clarification'
      : value.timeline || inferred==='timeline' || !context.creative && (isPostMemoryRequest(value.text) || context.followUp && boundPrevious?.responseKind==='timeline') || !context.creative && session.ragCondition && /image|photo|picture|visual|이미지|사진|그림|작품|의도|분위기/i.test(value.text) ? 'timeline' : value.intent ?? inferred;
    let output:Pick<ChatReply,'status'|'content'|'claims'|'evidence'|'limitations'|'grounding'>;
    let sources:SourcePost[]=[];
    const references=context.followUp&&!value.timeline&&boundPrevious?.grounding==='source_bound_quotes'&&boundPrevious.responseKind==='timeline'
      ?boundPrevious.evidence.filter(ref=>ref.personId===session.personId):[];
    const ambiguous=new Set(references.map(ref=>ref.sourceId)).size>1
      || /photo|picture|사진/i.test(value.text)&&new Set(references.flatMap(ref=>ref.annotationId?[ref.annotationId]:[])).size>1;
    let promptEvidence:ChatReply['promptEvidence'];
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
        if(!await this.options.store.transitionTurn(turn.id,['pending'],'retrieving') || controller.signal.aborted) return;
        const lookupOptions={signal:controller.signal,...(session.ragCondition && session.ragCondition!=='off'?{evidenceScope:session.ragCondition}:{})};
        if(references.length&&this.options.retrieval.resolve) {
          const resolved=await this.options.retrieval.resolve(references,{personId:session.personId},lookupOptions);
          // Recheck parent provenance even for a faulty resolver; annotations remain pinned to cited revisions.
          const pinned=resolved.flatMap(source=>{
            const matching=references.filter(ref=>ref.sourceId===source.id&&ref.hash===source.hash&&ref.snapshot===source.snapshot
              &&(ref.annotationId?source.imageAnnotations?.some(annotation=>ref.annotationId===annotation.id&&ref.annotationRevision===annotation.revision&&ref.imageHash===annotation.imageHash&&ref.annotationHash===annotation.annotationHash&&annotation.text.includes(ref.quote)):source.caption.includes(ref.quote)));
            if(!matching.length)return [];
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
      if(!await this.options.store.transitionTurn(turn.id,['pending','retrieving'],'generating') || controller.signal.aborted) return;
      const experiment=session.ragCondition?buildExperimentContext(persona,history,value.text,sources):undefined;
      if(experiment)promptEvidence={sourceIds:experiment.sources.map(source=>source.id),annotationIds:experiment.sources.flatMap(source=>source.imageAnnotations?.map(annotation=>annotation.id)??[]),
        omittedAnnotations:experiment.omittedAnnotations,promptBytes:Buffer.byteLength(JSON.stringify(experiment.messages),'utf8')};
      const result=await this.options.provider.generate(experiment?.messages ?? buildPrompt(persona,history,value.text,sources,intent==='timeline'),{signal:controller.signal});
      if(controller.signal.aborted) return;
      if(session.ragCondition) {
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
    if(controller.signal.aborted || !await this.options.store.transitionTurn(turn.id,['pending','generating'],'validating')) return;
    const reply:ChatReply={...output,retrievalContext:memoryTrace,...(promptEvidence?{promptEvidence}:{}),sessionId:session.id,turnId:turn.id,messageId:randomUUID(),personId:session.personId,personaRevision:session.personaRevision,responseKind:intent==='small_talk'?'small_talk':intent==='clarification'?'clarification':intent==='unsupported'?'unsupported':'timeline'};
    if(!controller.signal.aborted) await this.options.store.completeTurn(turn.id,reply);
  }
}
