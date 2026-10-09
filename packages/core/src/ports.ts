import type { ChatMessage, ChatReply, ChatSession, ChatTurn, EvidenceCard, Persona, ProviderMessage, SendTurnInput, SourcePost, TimelineQuery, TurnState } from '@ptr/contracts';
/**
 * `requestKey`: a stable per-turn key (the turn id) a gateway may use to scope billing idempotency; providers may ignore it.
 * `deadlineAt`: when the turn times out (epoch ms), so a provider does not start retries the turn cannot wait for.
 * `priority`: 0 = a turn's first model call, 1 = a follow-up call of the same turn (the LLM gateway serves those first so
 * running turns finish), −1 = batch; providers may ignore it.
 */
export interface TextProvider { generate(messages:ProviderMessage[],options:{signal:AbortSignal;requestKey?:string;deadlineAt?:number;priority?:1|0|-1}):Promise<string> }
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
  /** Completed turns of the session whose stored reply records an input-safety refusal (reply.inputSafety.action). */
  refusedTurnIds(sessionId:string,ownerId:string):Promise<string[]>;
  /** With `input`, the exact structured request is persisted and an outbox dispatch is written in the same transaction. */
  reserveTurn(sessionId:string,ownerId:string,clientRequestId:string,text:string,requestHash?:string,input?:SendTurnInput):Promise<{turn:ChatTurn;created:boolean;dispatch?:TurnDispatch}>;
  /** With a fence, the write applies only while that worker still holds that attempt's lease. */
  transitionTurn(turnId:string,expected:TurnState[],next:TurnState,errorCode?:string,fence?:LeaseFence):Promise<boolean>;
  completeTurn(turnId:string,reply:ChatReply,fence?:LeaseFence):Promise<boolean>;
  getTurn(turnId:string,ownerId:string):Promise<ChatTurn|undefined>;
  cancelTurn(turnId:string,ownerId:string):Promise<boolean>;
}
/** Fencing token for queued execution: a worker may only write a turn while it owns this exact lease attempt. */
export interface LeaseFence { workerId:string; attempt:number }
export interface QueuedTurn { turn:ChatTurn; input:SendTurnInput; fence:LeaseFence }
/**
 * Abort reason of a worker that no longer holds (or cannot confirm) the turn's lease. The turn is not ended: the
 * dispatcher's recovery requeues it with the next attempt, or fails it with WORKER_LOST after the last one.
 */
export const LEASE_LOST='LEASE_LOST';
/** One hand-off of a reserved turn to the delivery queue; `seq` grows with each requeue so redeliveries stay distinct. */
export interface TurnDispatch { turnId:string; seq:number }
/**
 * Durable side of queued execution (Postgres): the reservation outbox, per-turn leases with fencing, and recovery.
 * Delivery queues are not a source of truth; anything they lose is re-dispatched from here. The fencing token is
 * written only on claim and recovery; a renewal extends only the lease expiry, and a turn that ends drops its lease.
 */
export interface TurnLeaseStore {
  /**
   * Leases one dispatched turn to this worker only if it is pending and not held by a live lease; otherwise undefined.
   * With `maxQueueMs`, a turn that has waited longer than that since it was last queued (its outbox entry: the
   * reservation, or the latest requeue) is not claimed either (expireQueued fails it).
   */
  claimTurn(turnId:string,workerId:string,leaseMs:number,maxQueueMs?:number):Promise<QueuedTurn|undefined>;
  /**
   * Extends the lease while the turn is still active under this fence and the lease has not expired yet (an expired
   * lease may already be claimed by another worker); false means stop (cancelled, lost or expired).
   */
  renewLease(turnId:string,fence:LeaseFence,leaseMs:number):Promise<boolean>;
  /** Active turns with expired leases go back to pending with a new dispatch, or fail with WORKER_LOST after maxAttempts. */
  recoverExpired(maxAttempts:number):Promise<{requeued:string[];failed:string[]}>;
  /**
   * Low-frequency repair of state the normal paths never produce: active turns (older than graceMs) whose token has
   * no lease are requeued or failed like recoverExpired, and leases that match no active token are dropped.
   */
  reconcileLeases(maxAttempts:number,graceMs:number):Promise<{requeued:string[];failed:string[];dropped:number}>;
  /**
   * Outbox entries of turns still pending and never claimed, older than graceMs and not re-published within graceMs.
   * An entry lives until a worker claims the turn (or the turn ends), so a dispatch lost by the delivery queue is
   * published again; re-publishing a dispatch the queue still holds is a no-op there.
   */
  pendingDispatches(graceMs:number,limit:number):Promise<TurnDispatch[]>;
  /**
   * Fails every pending turn that no worker holds and that has waited longer than maxQueueMs since it was last queued:
   * QUEUE_TIMEOUT when it never ran (attempts 0), WORKER_LOST when it was requeued after a lost worker (an earlier
   * attempt may have reached a model). Compare-and-set on the state and the empty token, so a turn claimed at the same
   * moment is left alone and a failed one can no longer be claimed.
   */
  expireQueued(maxQueueMs:number):Promise<{turnId:string;errorCode:'QUEUE_TIMEOUT'|'WORKER_LOST'}[]>;
}
/** Hands reserved turns to workers (BullMQ in production). Publishing the same dispatch twice must be harmless. */
export interface TurnDelivery {
  publish(dispatch:TurnDispatch):Promise<void>;
  /** Dispatches waiting for a worker: the backlog that admission control bounds. */
  backlog():Promise<number>;
}
/** State change notice; carries no model output (that stays private until validated and is read from the store). */
export interface TurnEvent { turnId:string; state:TurnState; errorCode?:string }
export interface TurnEvents { publish(event:TurnEvent):Promise<void> }
/** Listening side of turn events (SSE readers; workers watching for cancellation). Returns an unsubscribe function. */
export interface TurnEventSource { subscribe(turnId:string,listener:(event:TurnEvent)=>void):Promise<()=>void> }
export type CoreErrorCode='NOT_FOUND'|'FORBIDDEN'|'TURN_ACTIVE'|'IDEMPOTENCY_CONFLICT'|'INVALID_INPUT'|'TURN_FAILED'|'CONTEXT_LIMIT'|'PERSONA_UNAVAILABLE'|'QUEUE_FULL'|'SEMANTIC_UNAVAILABLE';
/** Why a turn failed: a constant logged by onTurnFailure, never free text (the stored/client code stays TURN_FAILED). */
export type TurnFailureReason='TURN_ABORTED'|'TURN_TIMEOUT'|'REPLY_REJECTED'|'TOOL_QUERY_REJECTED'|'TOOL_LIMIT'|'TOOL_REPEATED'|'RETRIEVAL_UNAVAILABLE';
export class CoreError extends Error {
  constructor(code:'TURN_FAILED',reason?:TurnFailureReason);
  constructor(code:Exclude<CoreErrorCode,'TURN_FAILED'>,message?:string);
  constructor(public readonly code:CoreErrorCode,message:string = code) { super(message); this.name='CoreError'; }
}
