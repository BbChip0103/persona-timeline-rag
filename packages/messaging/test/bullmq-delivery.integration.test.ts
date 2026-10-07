import { randomUUID } from 'node:crypto';
import type { TurnDispatch, TurnEvent } from '@ptr/core';
import { BullMqTurnDelivery, RedisTurnEventSource, RedisTurnEvents, startTurnConsumer } from '../src';

const url = process.env.PTR_REDIS_URL ?? '';
const run = process.env.RUN_REDIS_TESTS === '1' ? describe : describe.skip;
const until = async (check: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('condition not met'); };

run('BullMQ delivery and Redis turn events (opt-in RUN_REDIS_TESTS=1)', () => {
  it('a dispatch is accepted once, counted as backlog until consumed, and delivered with its payload', async () => {
    const queueName = `test-turns-${randomUUID()}`;
    const delivery = new BullMqTurnDelivery(url, { queueName });
    const handled: TurnDispatch[] = [];
    try {
      const dispatch = { turnId: randomUUID(), seq: 0 };
      await delivery.publish(dispatch); await delivery.publish(dispatch); // same job id: no-op
      await delivery.publish({ ...dispatch, seq: 1 }); // a requeue is a new job
      expect(await delivery.backlog()).toBe(2);
      const consumer = startTurnConsumer(url, async d => { handled.push(d); }, { queueName, concurrency: 2 });
      await until(() => handled.length === 2);
      await consumer.close();
      expect(handled.map(d => d.seq).sort()).toEqual([0, 1]);
      expect(handled.every(d => d.turnId === dispatch.turnId)).toBe(true);
      expect(await delivery.backlog()).toBe(0);
      await delivery.publish(dispatch); // a finished job is replaced (the outbox only re-publishes unclaimed turns)
      expect(await delivery.backlog()).toBe(1);
    } finally { await delivery.close(true); }
  });
  it('a dispatch whose job finished (failed or done) can be published again; a waiting one stays deduplicated', async () => {
    const queueName = `test-turns-${randomUUID()}`;
    const delivery = new BullMqTurnDelivery(url, { queueName });
    let calls = 0;
    try {
      const dispatch = { turnId: randomUUID(), seq: 0 };
      await delivery.publish(dispatch);
      const consumer = startTurnConsumer(url, async () => { calls++; if (calls === 1) throw new Error('claim failed'); }, { queueName, concurrency: 1 });
      await until(() => calls === 1);
      await new Promise(r => setTimeout(r, 100)); // job is now failed (attempts: 1)
      await delivery.publish(dispatch);
      await until(() => calls === 2);
      await consumer.close();
      await delivery.publish(dispatch); await delivery.publish(dispatch);
      expect(await delivery.backlog()).toBe(1);
    } finally { await delivery.close(true); }
  });
  it('consumer concurrency bounds jobs in flight; close waits for them', async () => {
    const queueName = `test-turns-${randomUUID()}`;
    const delivery = new BullMqTurnDelivery(url, { queueName });
    let inFlight = 0, peak = 0, done = 0;
    try {
      for (let i = 0; i < 8; i++) await delivery.publish({ turnId: randomUUID(), seq: 0 });
      const consumer = startTurnConsumer(url, async () => { inFlight++; peak = Math.max(peak, inFlight); await new Promise(r => setTimeout(r, 40)); inFlight--; done++; }, { queueName, concurrency: 3 });
      await until(() => done === 8);
      await consumer.close();
      expect(peak).toBe(3);
    } finally { await delivery.close(true); }
  });
  it('turn events reach subscribers of that turn only, and stop after unsubscribe', async () => {
    const namespace = `test-${randomUUID()}`;
    const events = new RedisTurnEvents(url, { namespace });
    const source = new RedisTurnEventSource(url, { namespace });
    const mine: TurnEvent[] = [], other: TurnEvent[] = [];
    try {
      const turnId = randomUUID();
      const off = await source.subscribe(turnId, e => mine.push(e));
      await source.subscribe(randomUUID(), e => other.push(e));
      await events.publish({ turnId, state: 'generating' });
      await events.publish({ turnId, state: 'failed', errorCode: 'TURN_FAILED' });
      await until(() => mine.length === 2);
      expect(mine).toEqual([{ turnId, state: 'generating' }, { turnId, state: 'failed', errorCode: 'TURN_FAILED' }]);
      off();
      await events.publish({ turnId, state: 'completed' });
      await new Promise(r => setTimeout(r, 100));
      expect(mine).toHaveLength(2);
      expect(other).toEqual([]);
    } finally { await events.close(); await source.close(); }
  });
  it('concurrent subscribers of a new turn all receive an event published right after their subscribe resolves', async () => {
    const namespace = `test-${randomUUID()}`;
    const events = new RedisTurnEvents(url, { namespace });
    const source = new RedisTurnEventSource(url, { namespace });
    const a: TurnEvent[] = [], b: TurnEvent[] = [];
    try {
      const turnId = randomUUID();
      await Promise.all([source.subscribe(turnId, e => a.push(e)), source.subscribe(turnId, e => b.push(e))]);
      await events.publish({ turnId, state: 'completed' });
      await until(() => a.length === 1 && b.length === 1);
    } finally { await events.close(); await source.close(); }
  });
  it('malformed messages on a turn channel are ignored', async () => {
    const namespace = `test-${randomUUID()}`;
    const source = new RedisTurnEventSource(url, { namespace });
    const raw = new RedisTurnEvents(url, { namespace });
    const seen: TurnEvent[] = [];
    try {
      const turnId = randomUUID();
      await source.subscribe(turnId, e => seen.push(e));
      await raw.publishRaw(turnId, 'not json');
      await raw.publishRaw(turnId, JSON.stringify({ turnId, state: 'exploded' }));
      await raw.publishRaw(turnId, JSON.stringify({ turnId: 'someone-else', state: 'completed' }));
      await raw.publish({ turnId, state: 'completed' });
      await until(() => seen.length === 1);
      await new Promise(r => setTimeout(r, 50));
      expect(seen).toEqual([{ turnId, state: 'completed' }]);
    } finally { await source.close(); await raw.close(); }
  });
});
