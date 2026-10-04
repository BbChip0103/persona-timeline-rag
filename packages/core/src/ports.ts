import type { ChatMessage, ChatReply, ChatSession, ChatTurn, EvidenceCard, Persona, ProviderMessage, SendTurnInput, SourcePost, TimelineQuery, TurnState } from '@ptr/contracts';
export interface TextProvider { generate(messages:ProviderMessage[],options:{signal:AbortSignal}):Promise<string> }
export interface Retrieval {
  search(query:TimelineQuery,trusted:{personId:string},options:{signal:AbortSignal;mode:'lexical'|'semantic';evidenceScope?:'caption'|'caption_image'}):Promise<SourcePost[]>;
  resolve?(references:EvidenceCard[],trusted:{personId:string},options:{signal:AbortSignal;evidenceScope?:'caption'|'caption_image'}):Promise<SourcePost[]>;
}
export interface PersonaRepository { get(id:string,revision?:string):Promise<Persona|undefined> }
export interface ConversationStore {
  create(session:ChatSession,greeting:ChatMessage):Promise<void>;
  getOwnedSession(sessionId:string,ownerId:string):Promise<ChatSession|undefined>;
  listOwnedSessions(ownerId:string):Promise<ChatSession[]>;
  history(sessionId:string,ownerId:string):Promise<ChatMessage[]>;
  /** `input` is persisted only for queued execution, so a worker can rebuild the exact structured request. */
  reserveTurn(sessionId:string,ownerId:string,clientRequestId:string,text:string,requestHash?:string,input?:SendTurnInput):Promise<{turn:ChatTurn;created:boolean}>;
  /** With a fence, the write applies only while that worker still holds that attempt's lease. */
  transitionTurn(turnId:string,expected:TurnState[],next:TurnState,errorCode?:string,fence?:LeaseFence):Promise<boolean>;
  completeTurn(turnId:string,reply:ChatReply,fence?:LeaseFence):Promise<boolean>;
  getTurn(turnId:string,ownerId:string):Promise<ChatTurn|undefined>;
  cancelTurn(turnId:string,ownerId:string):Promise<boolean>;
}
/** Fencing token for queued execution: a worker may only write a turn while it owns this exact lease attempt. */
export interface LeaseFence { workerId:string; attempt:number }
export interface QueuedTurn { turn:ChatTurn; input:SendTurnInput; fence:LeaseFence }
/** Durable turn queue (Goal2). Leases are time-bounded; expired leases are recovered, never silently dropped. */
export interface TurnQueue {
  claimTurns(workerId:string,leaseMs:number,limit:number):Promise<QueuedTurn[]>;
  /** Extends the lease while the turn is still active under this fence; false means stop (cancelled or lost). */
  renewLease(turnId:string,fence:LeaseFence,leaseMs:number):Promise<boolean>;
  /** Active turns with expired leases go back to pending, or fail with WORKER_LOST after maxAttempts. */
  recoverExpired(maxAttempts:number):Promise<{requeued:number;failed:number}>;
  /** Pending turns not currently leased: the backlog that admission control bounds. */
  queueDepth():Promise<number>;
}
export class CoreError extends Error {
  constructor(public readonly code:'NOT_FOUND'|'FORBIDDEN'|'TURN_ACTIVE'|'IDEMPOTENCY_CONFLICT'|'INVALID_INPUT'|'TURN_FAILED'|'CONTEXT_LIMIT'|'PERSONA_UNAVAILABLE'|'QUEUE_FULL',message:string = code) { super(message); this.name='CoreError'; }
}
