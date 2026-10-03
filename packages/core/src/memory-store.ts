import { randomUUID } from 'node:crypto';
import type { ChatMessage, ChatReply, ChatSession, ChatTurn, Persona, TurnState } from '@ptr/contracts';
import { CoreError, type ConversationStore, type PersonaRepository } from './ports';
import { turnTextFingerprint } from './request-fingerprint';
const terminal = (state:TurnState) => ['completed','failed','cancelled'].includes(state);
/** Synthetic/local testing store. No durability or cross-process exactly-once guarantee. */
export class InMemoryConversationStore implements ConversationStore {
  private sessions = new Map<string,ChatSession>();
  private turns = new Map<string,ChatTurn>();
  private requestHashes = new Map<string,string>();
  private messages = new Map<string,ChatMessage[]>();
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
  async reserveTurn(sessionId:string,ownerId:string,clientRequestId:string,text:string,requestHash?:string):Promise<{turn:ChatTurn;created:boolean}> {
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
    this.turns.set(turn.id,turn); this.requestHashes.set(turn.id,fingerprint); return {turn:structuredClone(turn),created:true};
  }
  async transitionTurn(id:string,expected:TurnState[],next:TurnState,errorCode?:string):Promise<boolean> {
    const turn = this.turns.get(id);
    if (!turn || terminal(turn.state) || !expected.includes(turn.state)) return false;
    turn.state=next;
    if (errorCode) turn.errorCode=errorCode;
    if (terminal(next)) turn.finishedAt=new Date().toISOString();
    return true;
  }
  async completeTurn(id:string,reply:ChatReply):Promise<boolean> {
    const turn = this.turns.get(id);
    if (!turn || turn.state !== 'validating' || reply.turnId !== id || reply.sessionId !== turn.sessionId) return false;
    const session=this.sessions.get(turn.sessionId);
    if (!session || reply.personId !== session.personId || reply.personaRevision !== session.personaRevision) return false;
    turn.state='completed';turn.finishedAt=new Date().toISOString();turn.reply=structuredClone(reply);
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
}
export class InMemoryPersonaRepository implements PersonaRepository {
  constructor(private readonly personas:Persona[]) {}
  async get(id:string,revision?:string):Promise<Persona|undefined> {
    const found=this.personas.find(p => p.id === id && (!revision || p.revision === revision));
    return found ? structuredClone(found) : undefined;
  }
}
