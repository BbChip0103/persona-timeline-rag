import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ChatSession, Persona } from '@ptr/contracts';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository } from '../src/index';

const enabled = process.env.RUN_STORAGE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const integration = enabled ? describe : describe.skip;
integration('durable turn queue: leases, fencing and recovery (synthetic fixtures only)', () => {
  let pool: Pool;
  let store: PostgresConversationStore;
  const scope = `synthetic-queue-${randomUUID()}`;
  const persona: Persona = { id: `persona-${scope}`, personId: scope, revision: 'synthetic-v1', label: 'Synthetic fixture', language: 'ko',
    reviewStatus: 'synthetic', identity: 'Fictional fixture only', concept: 'test', style: [], boundaries: [], sourceRefs: [], greeting: '안녕하세요' };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  async function session(): Promise<ChatSession> {
    const value: ChatSession = { id: `session-${randomUUID()}`, ownerId: `owner-${scope}`, personId: scope, personaId: persona.id,
      personaRevision: persona.revision, language: 'ko', timezone: 'UTC', retrievalMode: 'off', createdAt: new Date().toISOString() };
    await store.create(value, { id: `greeting-${randomUUID()}`, sessionId: value.id, turnId: null, role: 'assistant', content: '안녕', createdAt: value.createdAt });
    return value;
  }
  async function enqueue(s: ChatSession, text = '안녕') {
    const input = { sessionId: s.id, clientRequestId: randomUUID(), text, intent: 'small_talk' as const };
    return (await store.reserveTurn(s.id, s.ownerId, input.clientRequestId, text, undefined, input)).turn;
  }
  // Claims are global; only look at this test's turns.
  const mine = async (workerId: string, leaseMs: number, limit: number) =>
    (await store.claimTurns(workerId, leaseMs, limit)).filter(item => item.turn.ownerId === `owner-${scope}`);
  beforeAll(async () => {
    pool = createLocalPool(process.env.DATABASE_URL!);
    store = new PostgresConversationStore(pool);
    await new PostgresPersonaRepository(pool).importPersona(persona);
    // Drain leftovers from earlier runs so claims below only see fresh rows.
    await pool.query("UPDATE turns SET state='cancelled',finished_at=now() WHERE state='pending' AND request_input IS NOT NULL");
  });
  afterAll(async () => { await pool?.end(); });

  it('concurrent workers never claim the same turn (SKIP LOCKED) and the original input round-trips', async () => {
    const s = await session(); const turn = await enqueue(s, '큐 입력');
    const [a, b] = await Promise.all([mine('w-a', 5000, 10), mine('w-b', 5000, 10)]);
    const all = [...a, ...b].filter(item => item.turn.id === turn.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.input).toMatchObject({ text: '큐 입력', intent: 'small_talk' });
    expect(all[0]!.fence.attempt).toBe(1);
  });
  it('fenced writes from a stale lease are rejected after another worker reclaims the turn', async () => {
    const s = await session(); await enqueue(s);
    const [first] = await mine('w-old', 50, 1);
    expect(await store.transitionTurn(first!.turn.id, ['pending'], 'generating', undefined, first!.fence)).toBe(true);
    await sleep(80);
    expect(await store.recoverExpired(3)).toMatchObject({ requeued: expect.any(Number) });
    const [second] = await mine('w-new', 5000, 1);
    expect(second!.turn.id).toBe(first!.turn.id);expect(second!.fence.attempt).toBe(2);
    expect(await store.transitionTurn(first!.turn.id, ['pending'], 'failed', 'ZOMBIE', first!.fence)).toBe(false);
    expect(await store.renewLease(first!.turn.id, first!.fence, 5000)).toBe(false);
    expect(await store.renewLease(second!.turn.id, second!.fence, 5000)).toBe(true);
    expect(await store.transitionTurn(second!.turn.id, ['pending'], 'generating', undefined, second!.fence)).toBe(true);
  });
  it('exhausted attempts fail with WORKER_LOST, unblocking the session; cancellation ends renewals', async () => {
    const s = await session(); const turn = await enqueue(s);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const [claimed] = await mine(`w-${attempt}`, 30, 1);
      await store.transitionTurn(claimed!.turn.id, ['pending'], 'generating', undefined, claimed!.fence);
      await sleep(50); await store.recoverExpired(2);
    }
    const failed = await store.getTurn(turn.id, s.ownerId);
    expect(failed).toMatchObject({ state: 'failed', errorCode: 'WORKER_LOST' });
    const next = await enqueue(s, '다시'); const [claimed] = await mine('w-c', 5000, 1);
    expect(await store.cancelTurn(next.id, s.ownerId)).toBe(true);
    expect(await store.renewLease(next.id, claimed!.fence, 5000)).toBe(false);
  });
  it('queue depth counts only unleased pending queued turns', async () => {
    await pool.query("UPDATE turns SET state='cancelled',finished_at=now() WHERE state='pending' AND request_input IS NOT NULL");
    const before = await store.queueDepth();
    const s1 = await session(), s2 = await session();
    await enqueue(s1); await enqueue(s2);
    expect(await store.queueDepth()).toBe(before + 2);
    await mine('w-depth', 5000, 1);
    expect(await store.queueDepth()).toBe(before + 1);
  });
});
