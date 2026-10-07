import { randomUUID } from 'node:crypto';
import type { ChatTurn, SendTurnInput } from '@ptr/contracts';
import { ChatService, TurnWorker, type ChatServiceOptions, type ConversationStore, type TurnLeaseStore } from '@ptr/core';
import { BullMqTurnDelivery, startTurnConsumer } from './bullmq-delivery.js';
import { RedisTurnEventSource, RedisTurnEvents } from './turn-events.js';

const ended = (turn: ChatTurn) => ['completed', 'failed', 'cancelled'].includes(turn.state);
export type QueuedChat = ChatService & {
  /** Submits through Redis and resolves once this call's turn has ended (replays of an existing turn return at once). */
  sendTurn(ownerId: string, input: SendTurnInput): Promise<ChatTurn>;
  close(): Promise<void>;
};

/**
 * Evaluation scripts: the production queued path (outbox → BullMQ → leased worker with fenced writes → Redis events)
 * with the worker in this process, so per-turn provider/retrieval tracing still sees every call. It uses a private,
 * throwaway queue and event namespace and runs no dispatcher (the dispatcher's outbox sweep is database-wide); a turn
 * whose publish failed therefore surfaces as a timeout instead of being picked up from another system's queue.
 */
export function createQueuedChat(options: Omit<ChatServiceOptions, 'leases' | 'delivery' | 'events'> & {
  store: ConversationStore & TurnLeaseStore; redisUrl: string; concurrency?: number; leaseMs?: number; turnTimeoutMs?: number;
}): QueuedChat {
  const run = `local-${randomUUID()}`;
  const delivery = new BullMqTurnDelivery(options.redisUrl, { queueName: run });
  const events = new RedisTurnEvents(options.redisUrl, { namespace: run });
  const source = new RedisTurnEventSource(options.redisUrl, { namespace: run });
  const chat = new ChatService({ ...options, leases: options.store, delivery, events, maxQueueDepth: options.maxQueueDepth ?? 10_000 });
  const worker = new TurnWorker({ chat, leases: options.store, workerId: run, leaseMs: options.leaseMs ?? 30_000, cancellations: source });
  const consumer = startTurnConsumer(options.redisUrl, dispatch => worker.handle(dispatch), { queueName: run, concurrency: options.concurrency ?? 8 });
  return Object.assign(chat, {
    async sendTurn(ownerId: string, input: SendTurnInput): Promise<ChatTurn> {
      const { turn, dispatch } = await chat.submitTurn(ownerId, input);
      if (!dispatch) return turn;
      let wake = () => undefined as void;
      const unsubscribe = await source.subscribe(turn.id, () => wake());
      try {
        const deadline = Date.now() + (options.turnTimeoutMs ?? 120_000);
        for (;;) {
          const current = await chat.getTurn(ownerId, turn.id); // re-check after subscribing: no missed transition
          if (ended(current)) return current;
          if (Date.now() >= deadline) throw new Error('TURN_WAIT_TIMEOUT');
          await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500); wake = () => { clearTimeout(timer); resolve(); }; });
        }
      } finally { unsubscribe(); }
    },
    async close() {
      await consumer.close(); await worker.stop();
      await Promise.allSettled([delivery.close(true), events.close(), source.close()]);
    },
  });
}
