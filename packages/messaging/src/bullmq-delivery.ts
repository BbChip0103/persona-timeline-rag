import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { TurnDelivery, TurnDispatch } from '@ptr/core';
import { assertLocalRedisUrl } from './local-guard.js';
import { REDIS_PREFIX, createRedisConnection } from './redis.js';

export const TURN_QUEUE = 'turns';
/** No ':' (BullMQ reserves it) and never all digits. */
export const turnJobId = (dispatch: TurnDispatch) => `t-${dispatch.turnId}-${dispatch.seq}`;
function isDispatch(value: unknown): value is TurnDispatch {
  const v = value as TurnDispatch;
  return !!v && typeof v.turnId === 'string' && v.turnId.length > 0 && v.turnId.length <= 200 && Number.isInteger(v.seq) && v.seq >= 0;
}

/**
 * Publishes reserved turns to BullMQ. Job ids are per dispatch, so re-publishing one the queue still holds waiting or
 * active is a no-op; a finished one is replaced. BullMQ retries are off: recovery is driven by Postgres leases and the
 * outbox, not by the delivery queue.
 */
export class BullMqTurnDelivery implements TurnDelivery {
  private opened?: Queue;
  private connection?: Redis;
  private readonly queueName: string;
  /** Validates the target at once; connects on first use, so composing a runtime opens no connection. */
  constructor(private readonly url: string, options: { queueName?: string } = {}) {
    assertLocalRedisUrl(url); this.queueName = options.queueName ?? TURN_QUEUE;
  }
  private get queue(): Queue {
    // BullMQ does not close a connection it was given, so this class owns and closes it.
    if (!this.opened) { this.connection = createRedisConnection(this.url); this.opened = new Queue(this.queueName, { connection: this.connection, prefix: REDIS_PREFIX }); }
    return this.opened;
  }
  async publish(dispatch: TurnDispatch): Promise<void> {
    // A finished job with this id means the turn was not claimed under it (claim failed or was skipped) while its
    // outbox entry is still pending: replace it, or the re-publish would be a silent no-op until retention expires.
    const state = await this.queue.getJobState(turnJobId(dispatch));
    if (state === 'completed' || state === 'failed') await this.queue.remove(turnJobId(dispatch)).catch(() => undefined);
    await this.queue.add('turn', { turnId: dispatch.turnId, seq: dispatch.seq }, {
      jobId: turnJobId(dispatch), attempts: 1,
      removeOnComplete: { age: 3600 }, removeOnFail: { age: 24 * 3600 },
    });
  }
  async backlog(): Promise<number> { return (await this.queue.getJobCounts('wait')).wait ?? 0; }
  /** `obliterate` is for throwaway test queues only. */
  async close(obliterate = false): Promise<void> {
    if (!this.opened) return;
    if (obliterate) await this.opened.obliterate({ force: true });
    await this.opened.close(); await this.connection?.quit();
  }
}

export interface TurnConsumer { close(): Promise<void> }
/** BullMQ worker that hands each dispatch to `handler` (TurnWorker.handle); `concurrency` bounds turns in flight. */
export function startTurnConsumer(url: string, handler: (dispatch: TurnDispatch) => Promise<unknown>,
  options: { concurrency: number; queueName?: string; onError?: (error: unknown) => void }): TurnConsumer {
  const connection = createRedisConnection(url, { blocking: true });
  const worker = new Worker(options.queueName ?? TURN_QUEUE, async (job: Job) => {
    if (!isDispatch(job.data)) return; // never trust payload shape; a bad job is dropped, Postgres stays authoritative
    await handler({ turnId: job.data.turnId, seq: job.data.seq });
  }, { connection, prefix: REDIS_PREFIX, concurrency: options.concurrency });
  worker.on('error', error => options.onError?.(error));
  // Graceful: stop taking jobs, wait for in-flight handlers, then release the connection BullMQ will not close.
  return { close: async () => { await worker.close(); await connection.quit(); } };
}
