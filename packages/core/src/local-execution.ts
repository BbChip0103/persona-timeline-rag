import type { ChatTurn, SendTurnInput } from '@ptr/contracts';
import { ChatService, type ChatServiceOptions } from './chat-service';
import type { ConversationStore, TurnLeaseStore } from './ports';
import { InMemoryTurnDelivery, InMemoryTurnEvents } from './memory-queue';
import { TurnWorker } from './turn-worker';

export type LocalChat=ChatService&{
  delivery:InMemoryTurnDelivery;events:InMemoryTurnEvents;worker:TurnWorker;
  /** Submits through the queued path and resolves once this call's turn has been handled (replays return at once). */
  sendTurn(ownerId:string,input:SendTurnInput):Promise<ChatTurn>;
  stop():Promise<void>;
};

/**
 * Tests and offline tooling only: the same queued path (reservation + outbox → delivery → leased worker with fenced
 * writes) with in-memory delivery and events in one process. Not a runtime mode of the API.
 */
export function createLocalChat(options:Omit<ChatServiceOptions,'leases'|'delivery'|'events'>&{store:ConversationStore&TurnLeaseStore;leaseMs?:number;concurrency?:number}):LocalChat {
  const delivery=new InMemoryTurnDelivery();const events=new InMemoryTurnEvents();
  const chat=new ChatService({...options,leases:options.store,delivery,events,maxQueueDepth:options.maxQueueDepth??10_000});
  const worker=new TurnWorker({chat,leases:options.store,workerId:'local-worker',leaseMs:options.leaseMs??30_000,cancellations:events});
  const stopConsumer=delivery.consume(dispatch=>worker.handle(dispatch).then(()=>undefined),{concurrency:options.concurrency??64});
  return Object.assign(chat,{delivery,events,worker,
    async sendTurn(ownerId:string,input:SendTurnInput):Promise<ChatTurn> {
      const {turn,dispatch}=await chat.submitTurn(ownerId,input);
      if(!dispatch) return turn;
      await delivery.whenHandled(dispatch);
      return chat.getTurn(ownerId,turn.id);
    },
    stop:stopConsumer});
}
