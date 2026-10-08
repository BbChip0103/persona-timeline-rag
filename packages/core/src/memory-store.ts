import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatReply, ChatSession, ChatTurn, Persona, SendTurnInput, TurnState } from '@ptr/contracts';
import { CoreError, type ConversationStore, type LeaseFence, type PersonaRepository, type QueuedTurn, type TurnDispatch, type TurnLeaseStore } from './ports';
import { turnTextFingerprint } from './request-fingerprint';
const terminal = (state:TurnState) => ['completed','failed','cancelled'].includes(state);
/** Synthetic/local testing store. No durability or cross-process exactly-once guarantee. */
export class InMemoryConversationStore implements ConversationStore, TurnLeaseStore {
  private sessions = new Map<string,ChatSession>();
  private turns = new Map<string,ChatTurn>();
  private requestHashes = new Map<string,string>();
  private messages = new Map<string,ChatMessage[]>();
  private inputs = new Map<string,SendTurnInput>();
  private leases = new Map<string,{owner?:string;expiresAt:number;attempts:number}>();
  /** Reservation outbox: one entry per turn until a worker claims it. */
  private outbox = new Map<string,{seq:number;createdAt:number;publishedAt?:number}>();
  private dispatchSeq = new Map<string,number>();
  async create(session:ChatSession,greeting:ChatMessage):Promise<void> {
    if (this.sessions.has(session.id)) throw new CoreError('INVALID_INPUT');
    this.sessions.set(session.id,structuredClone(session)); this.messages.set(session.id,[structuredClone(greeting)]);
  }
  async getOwnedSession(id:string,owner:string):Promise<ChatSession|undefined> {
    const session = this.sessions.get(id); return session?.ownerId === owner ? structuredClone(session) : undefined;
  }
  async listOwnedSessions(owner:string):Promise<ChatSession[]> {
    return [...this.sessions.values()].filter(s => s.ownerId === owner).map(s => structuredClone(s));
  }
  async history(id:string,owner:string):Promise<ChatMessage[]> {
    if (!await this.getOwnedSession(id,owner)) throw new CoreError('NOT_FOUND');
    return structuredClone(this.messages.get(id) ?? []);
  }
  async reserveTurn(sessionId:string,ownerId:string,clientRequestId:string,text:string,requestHash?:string,input?:SendTurnInput):Promise<{turn:ChatTurn;created:boolean;dispatch?:TurnDispatch}> {
    const fingerprint=requestHash??turnTextFingerprint(text);
    if(!/^[a-f0-9]{64}$/.test(fingerprint)) throw new CoreError('INVALID_INPUT');
    // No await between validation and write: atomic in this single-process store.
    if (this.sessions.get(sessionId)?.ownerId !== ownerId) throw new CoreError('NOT_FOUND');
    const existing = [...this.turns.values()].find(t => t.sessionId === sessionId && t.clientRequestId === clientRequestId);
    if (existing) {
      if (existing.userText !== text || this.requestHashes.get(existing.id)!==fingerprint) throw new CoreError('IDEMPOTENCY_CONFLICT');
      return {turn:structuredClone(existing),created:false};
    }
    const turns = [...this.turns.values()].filter(t => t.sessionId === sessionId);
    if (turns.some(t => !terminal(t.state))) throw new CoreError('TURN_ACTIVE');
    const turn:ChatTurn = {id:randomUUID(),sessionId,ownerId,clientRequestId,userText:text,sequence:turns.length+1,state:'pending',createdAt:new Date().toISOString()};
    this.turns.set(turn.id,turn); this.requestHashes.set(turn.id,fingerprint);
    if(!input) return {turn:structuredClone(turn),created:true};
    this.inputs.set(turn.id,structuredClone(input));
    this.dispatchSeq.set(turn.id,0);this.outbox.set(turn.id,{seq:0,createdAt:Date.now()});
    return {turn:structuredClone(turn),created:true,dispatch:{turnId:turn.id,seq:0}};
  }
  private fenced(id:string,fence?:LeaseFence):boolean {
    if(!fence) return true;
    const lease=this.leases.get(id);
    return !!lease && lease.owner===fence.workerId && lease.attempts===fence.attempt;
  }
  async transitionTurn(id:string,expected:TurnState[],next:TurnState,errorCode?:string,fence?:LeaseFence):Promise<boolean> {
    const turn = this.turns.get(id);
    if (!turn || terminal(turn.state) || !expected.includes(turn.state) || !this.fenced(id,fence)) return false;
    turn.state=next;
    if (errorCode) turn.errorCode=errorCode;
    if (terminal(next)) {turn.finishedAt=new Date().toISOString();this.leases.delete(id);}
    return true;
  }
  async completeTurn(id:string,reply:ChatReply,fence?:LeaseFence):Promise<boolean> {
    const turn = this.turns.get(id);
    if (!turn || turn.state !== 'validating' || reply.turnId !== id || reply.sessionId !== turn.sessionId || !this.fenced(id,fence)) return false;
    const session=this.sessions.get(turn.sessionId);
    if (!session || reply.personId !== session.personId || reply.personaRevision !== session.personaRevision) return false;
    turn.state='completed';turn.finishedAt=new Date().toISOString();turn.reply=structuredClone(reply);this.leases.delete(id);
    this.messages.get(turn.sessionId)!.push(
      {id:randomUUID(),sessionId:turn.sessionId,turnId:id,role:'user',content:turn.userText,createdAt:turn.createdAt},
      {id:reply.messageId,sessionId:turn.sessionId,turnId:id,role:'assistant',content:reply.content,createdAt:turn.finishedAt},
    );
    return true;
  }
  async getTurn(id:string,owner:string):Promise<ChatTurn|undefined> {
    const turn = this.turns.get(id); return turn?.ownerId === owner ? structuredClone(turn) : undefined;
  }
  async cancelTurn(id:string,owner:string):Promise<boolean> {
    const turn = this.turns.get(id);
    return turn?.ownerId === owner && !terminal(turn.state) ? this.transitionTurn(id,[turn.state],'cancelled') : false;
  }
  async claimTurn(turnId:string,workerId:string,leaseMs:number):Promise<QueuedTurn|undefined> {
    const now=Date.now();const turn=this.turns.get(turnId);const lease=this.leases.get(turnId);
    if(!turn||turn.state!=='pending'||!this.inputs.has(turnId)||(lease&&lease.owner&&lease.expiresAt>=now)) return undefined;
    const attempts=(lease?.attempts??0)+1;
    this.leases.set(turnId,{owner:workerId,expiresAt:now+leaseMs,attempts});this.outbox.delete(turnId);
    return {turn:structuredClone(turn),input:structuredClone(this.inputs.get(turnId)!),fence:{workerId,attempt:attempts}};
  }
  async renewLease(id:string,fence:LeaseFence,leaseMs:number):Promise<boolean> {
    const turn=this.turns.get(id);
    if(!turn||terminal(turn.state)||!this.fenced(id,fence)||this.leases.get(id)!.expiresAt<Date.now()) return false;
    this.leases.get(id)!.expiresAt=Date.now()+leaseMs;return true;
  }
  async recoverExpired(maxAttempts:number):Promise<{requeued:string[];failed:string[]}> {
    const now=Date.now();const requeued:string[]=[],failed:string[]=[];
    for(const turn of this.turns.values()) {
      const lease=this.leases.get(turn.id);
      if(!lease?.owner||terminal(turn.state)||lease.expiresAt>=now) continue;
      if(lease.attempts>=maxAttempts) {turn.state='failed';turn.errorCode='WORKER_LOST';turn.finishedAt=new Date().toISOString();this.leases.delete(turn.id);failed.push(turn.id);continue;}
      turn.state='pending';this.leases.set(turn.id,{expiresAt:0,attempts:lease.attempts});
      const seq=(this.dispatchSeq.get(turn.id)??0)+1;this.dispatchSeq.set(turn.id,seq);
      this.outbox.set(turn.id,{seq,createdAt:now});requeued.push(turn.id);
    }
    return {requeued,failed};
  }
  /** Token and expiry share one record here, so they cannot drift apart; nothing to repair. */
  async reconcileLeases():Promise<{requeued:string[];failed:string[];dropped:number}> {return {requeued:[],failed:[],dropped:0};}
  async pendingDispatches(graceMs:number,limit:number):Promise<TurnDispatch[]> {
    const now=Date.now();const due:TurnDispatch[]=[];
    for(const [turnId,entry] of this.outbox) {
      if(this.turns.get(turnId)?.state!=='pending') {this.outbox.delete(turnId);continue;}
      if(due.length>=limit||now-entry.createdAt<graceMs||(entry.publishedAt!==undefined&&now-entry.publishedAt<graceMs)) continue;
      entry.publishedAt=now;due.push({turnId,seq:entry.seq});
    }
    return due;
  }
}
export class InMemoryPersonaRepository implements PersonaRepository {
  constructor(private readonly personas:Persona[]) {}
  async get(id:string,revision?:string):Promise<Persona|undefined> {
    const found=this.personas.find(p => p.id === id && (!revision || p.revision === revision));
    return found ? structuredClone(found) : undefined;
  }
}
