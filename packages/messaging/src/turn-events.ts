import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { TurnEvent, TurnEventSource, TurnEvents } from '@ptr/core';
import { assertLocalRedisUrl } from './local-guard.js';
import { REDIS_PREFIX, createRedisConnection } from './redis.js';

const EventSchema = z.object({
  turnId: z.string().min(1).max(200),
  state: z.enum(['pending', 'retrieving', 'generating', 'validating', 'completed', 'failed', 'cancelled']),
  errorCode: z.string().max(100).optional(),
}).strict();
const channel = (namespace: string, turnId: string) => `${REDIS_PREFIX}:${namespace}:turn:${turnId}`;

/** Publishes turn state notices on `ptr:<namespace>:turn:<id>` (fire-and-forget pub/sub; readers re-check Postgres). */
export class RedisTurnEvents implements TurnEvents {
  private opened?: Redis;
  private readonly namespace: string;
  /** Validates the target at once; connects on first publish. */
  constructor(private readonly url: string, options: { namespace?: string } = {}) {
    assertLocalRedisUrl(url); this.namespace = options.namespace ?? 'events';
  }
  private get redis(): Redis { this.opened ??= createRedisConnection(this.url); return this.opened; }
  async publish(event: TurnEvent): Promise<void> {
    await this.publishRaw(event.turnId, JSON.stringify(EventSchema.parse(event)));
  }
  /** Exposed for tests that need to inject malformed traffic. */
  async publishRaw(turnId: string, payload: string): Promise<void> { await this.redis.publish(channel(this.namespace, turnId), payload); }
  async close(): Promise<void> { await this.opened?.quit(); }
}

/**
 * One subscriber connection per process shared by every listener (SSE responses, worker cancellation watches).
 * Channels are subscribed on first listener and dropped on last; ioredis re-subscribes after reconnects.
 */
export class RedisTurnEventSource implements TurnEventSource {
  private opened?: Redis;
  private readonly namespace: string;
  private readonly listeners = new Map<string, Set<(event: TurnEvent) => void>>();
  /** Every caller waits for the channel's SUBSCRIBE to be confirmed, so nothing published after `subscribe` resolves is missed. */
  private readonly ready = new Map<string, Promise<unknown>>();
  /** Validates the target at once; the subscriber connection opens on first subscribe. */
  constructor(private readonly url: string, options: { namespace?: string } = {}) {
    assertLocalRedisUrl(url); this.namespace = options.namespace ?? 'events';
  }
  private get redis(): Redis {
    if (this.opened) return this.opened;
    this.opened = createRedisConnection(this.url);
    this.opened.on('message', (name: string, message: string) => {
      const turnId = name.slice(channel(this.namespace, '').length);
      let parsed: TurnEvent | undefined;
      try { const result = EventSchema.safeParse(JSON.parse(message)); parsed = result.success ? result.data : undefined; } catch { parsed = undefined; }
      if (!parsed || parsed.turnId !== turnId) return;
      for (const listener of this.listeners.get(turnId) ?? []) listener({ ...parsed });
    });
    return this.opened;
  }
  async subscribe(turnId: string, listener: (event: TurnEvent) => void): Promise<() => void> {
    let set = this.listeners.get(turnId);
    if (!set) {
      set = new Set(); this.listeners.set(turnId, set);
      this.ready.set(turnId, this.redis.subscribe(channel(this.namespace, turnId)));
    }
    set.add(listener);
    const own = set;
    try { await this.ready.get(turnId); } catch (error) { own.delete(listener); throw error; }
    return () => {
      own.delete(listener);
      if (!own.size && this.listeners.get(turnId) === own) {
        this.listeners.delete(turnId); this.ready.delete(turnId);
        void this.redis.unsubscribe(channel(this.namespace, turnId)).catch(() => undefined);
      }
    };
  }
  async close(): Promise<void> { await this.opened?.quit(); }
}
