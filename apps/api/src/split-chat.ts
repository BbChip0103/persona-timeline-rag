import {randomUUID} from 'node:crypto';
import {CreateSessionSchema,SendTurnSchema,TimelineQuerySchema,type ChatMessage,type ChatSession,type ChatTurn,type CreateSessionInput,type SendTurnInput} from '@ptr/contracts';
import {CoreError,type ConversationStore,type TurnDelivery,type TurnEvents} from '../../../packages/core/src/ports';
import {containsCredentialPattern} from '../../../packages/core/src/safety';
import {requestFingerprint} from '../../../packages/core/src/request-fingerprint';
import {greetingIndexFor} from '../../../packages/core/src/persona-card';
import type {PersonaProjection} from '../../../contracts/llm/v2/validate';
/** Backend domain operations only: no persona DB access, provider, safety model or graph composition. */
export class SplitChatService {
  private depth?:{value:number;at:number};private refresh?:Promise<void>;
  constructor(private readonly store:ConversationStore,private readonly catalogue:()=>Promise<PersonaProjection[]>,private readonly delivery:TurnDelivery,private readonly events:TurnEvents,private readonly maxQueueDepth=256,private readonly semanticSearch=true) {}
  async createSession(ownerId:string,input:CreateSessionInput):Promise<ChatSession> {
    if(!ownerId.trim())throw new CoreError('FORBIDDEN');
    const value=CreateSessionSchema.parse(input);if(value.retrievalMode==='semantic'&&!this.semanticSearch)throw new CoreError('SEMANTIC_UNAVAILABLE');
    const persona=(await this.catalogue()).find(p=>p.id===value.personaId&&p.revision===value.personaRevision&&p.personId===value.personId);
    if(!persona)throw new CoreError('PERSONA_UNAVAILABLE');
    const greetings=[persona.greeting,...persona.alternateGreetings??[]];
    if(value.greetingIndex!==undefined&&value.greetingIndex>=greetings.length)throw new CoreError('INVALID_INPUT');
    const id=randomUUID(),index=value.greetingIndex??greetingIndexFor(id,greetings.length);
    const session:ChatSession={id,ownerId,userMemoryConsent:false,personId:value.personId,personaId:persona.id,personaRevision:persona.revision,language:persona.language,timezone:value.timezone,retrievalMode:value.retrievalMode,...(value.ragCondition?{ragCondition:value.ragCondition}:value.executionProfile==='agent_loop'?{ragCondition:value.retrievalMode==='off'?'off' as const:'caption' as const}:{}),...(value.executionProfile?{executionProfile:value.executionProfile}:{}),createdAt:new Date().toISOString(),...(value.greetingIndex!==undefined||greetings.length>1?{greetingIndex:index}:{})};
    await this.store.create(session,{id:randomUUID(),sessionId:id,turnId:null,role:'assistant',content:greetings[index]!,createdAt:session.createdAt});return session;
  }
  async getSession(ownerId:string,id:string):Promise<ChatSession> {const session=await this.store.getOwnedSession(id,ownerId);if(!session)throw new CoreError('NOT_FOUND');return session;}
  listSessions(ownerId:string) {return this.store.listOwnedSessions(ownerId);}
  async history(ownerId:string,id:string):Promise<ChatMessage[]> {await this.getSession(ownerId,id);return this.store.history(id,ownerId);}
  async setUserMemoryConsent(ownerId:string,id:string,enabled:boolean):Promise<ChatSession> {
    await this.getSession(ownerId,id);return this.store.setUserMemoryConsent(id,ownerId,enabled);
  }
  async listUserMemories(ownerId:string,id:string) {
    const session=await this.getSession(ownerId,id);
    return (await this.store.listUserMemories(ownerId,session.personaId)).filter(memory=>!memory.forgotten).map(({id,kind,text})=>({id,kind,text}));
  }
  async forgetUserMemory(ownerId:string,id:string,memoryId:string):Promise<boolean> {
    const memories=await this.listUserMemories(ownerId,id);
    if(!memories.some(memory=>memory.id===memoryId))return false;
    return this.store.forgetUserMemory(memoryId,ownerId);
  }
  async deleteUserMemories(ownerId:string,id:string):Promise<number> {
    const session=await this.getSession(ownerId,id);return this.store.deleteUserMemories(ownerId,session.personaId);
  }
  async deleteSession(ownerId:string,id:string):Promise<boolean> {
    await this.getSession(ownerId,id);return this.store.deleteOwnedSession(id,ownerId);
  }
  async getTurn(ownerId:string,id:string):Promise<ChatTurn> {const turn=await this.store.getTurn(id,ownerId);if(!turn)throw new CoreError('NOT_FOUND');return turn;}
  async cancelTurn(ownerId:string,id:string):Promise<boolean> {await this.getTurn(ownerId,id);const applied=await this.store.cancelTurn(id,ownerId);if(applied)void this.events.publish({turnId:id,state:'cancelled'}).catch(()=>undefined);return applied;}
  async submitTurn(ownerId:string,input:SendTurnInput) {
    if(!this.depth||Date.now()-this.depth.at>=100) {
      this.refresh??=this.delivery.backlog().catch(()=>this.depth?.value??0).then(value=>{this.depth={value,at:Date.now()};}).finally(()=>{this.refresh=undefined;});await this.refresh;
    }
    const reading=this.depth!;if(reading.value>=this.maxQueueDepth)throw new CoreError('QUEUE_FULL');reading.value++;
    let created=false;
    try {
      const value=SendTurnSchema.parse(input);if(containsCredentialPattern(value.text))throw new CoreError('INVALID_INPUT');
      const session=await this.getSession(ownerId,value.sessionId);
      const query=TimelineQuerySchema.safeParse({personId:session.personId,query:value.timeline?.query??value.text.slice(0,500),start:value.timeline?.start,end:value.timeline?.end,dateBasis:value.timeline?.dateBasis??'posted',timezone:session.timezone,limit:value.timeline?.limit??5});
      if(!query.success||containsCredentialPattern(query.data.query??''))throw new CoreError('INVALID_INPUT');
      const reserved=await this.store.reserveTurn(session.id,ownerId,value.clientRequestId,value.text,requestFingerprint(value,session.ragCondition),value);created=reserved.created;
      if(reserved.dispatch)await this.delivery.publish(reserved.dispatch).catch(()=>undefined);return reserved;
    } finally {if(!created)reading.value=Math.max(0,reading.value-1);}
  }
}
