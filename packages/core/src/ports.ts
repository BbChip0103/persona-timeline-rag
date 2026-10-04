import type { ChatMessage, ChatReply, ChatSession, ChatTurn, EvidenceCard, Persona, ProviderMessage, SourcePost, TimelineQuery, TurnState } from '@ptr/contracts';
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
  reserveTurn(sessionId:string,ownerId:string,clientRequestId:string,text:string,requestHash?:string):Promise<{turn:ChatTurn;created:boolean}>;
  transitionTurn(turnId:string,expected:TurnState[],next:TurnState,errorCode?:string):Promise<boolean>;
  completeTurn(turnId:string,reply:ChatReply):Promise<boolean>;
  getTurn(turnId:string,ownerId:string):Promise<ChatTurn|undefined>;
  cancelTurn(turnId:string,ownerId:string):Promise<boolean>;
}
export class CoreError extends Error {
  constructor(public readonly code:'NOT_FOUND'|'FORBIDDEN'|'TURN_ACTIVE'|'IDEMPOTENCY_CONFLICT'|'INVALID_INPUT'|'TURN_FAILED'|'CONTEXT_LIMIT'|'PERSONA_UNAVAILABLE',message:string = code) { super(message); this.name='CoreError'; }
}
