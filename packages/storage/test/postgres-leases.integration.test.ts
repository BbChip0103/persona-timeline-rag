import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ChatSession, Persona } from '@ptr/contracts';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository } from '../src/index';

const enabled = process.env.RUN_STORAGE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const integration = enabled ? describe : describe.skip;
integration('turn outbox, per-turn leases, fencing and recovery (synthetic fixtures only)', () => {
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
  const outboxOf = async (turnId: string) => (await pool.query('SELECT seq FROM turn_outbox WHERE turn_id=$1', [turnId])).rows;
  // Dispatch reads are global; only look at this test's turns.
  const myDispatches = async (graceMs: number, ids: string[]) => (await store.pendingDispatches(graceMs, 1000)).filter(d => ids.includes(d.turnId));
  beforeAll(async () => {
    pool = createLocalPool(process.env.DATABASE_URL!);
    store = new PostgresConversationStore(pool);
    await new PostgresPersonaRepository(pool).importPersona(persona);
  });
  afterAll(async () => { await pool?.end(); });

  it('the reservation writes its outbox entry atomically; concurrent claims lease the turn once and retire the entry', async () => {
    const s = await session(); const turn = await enqueue(s, '큐 입력');
    expect(await outboxOf(turn.id)).toEqual([{ seq: 0 }]);
    const claims = await Promise.all([store.claimTurn(turn.id, 'w-a', 5000), store.claimTurn(turn.id, 'w-b', 5000), store.claimTurn(turn.id, 'w-c', 5000)]);
    const won = claims.filter(Boolean);
    expect(won).toHaveLength(1);
    expect(won[0]!.input).toMatchObject({ text: '큐 입력', intent: 'small_talk' });
    expect(won[0]!.fence.attempt).toBe(1);
    expect(await outboxOf(turn.id)).toEqual([]);
    await expect(enqueue(s, '두 번째')).rejects.toMatchObject({ code: 'TURN_ACTIVE' });
  });
  it('fenced writes from a stale lease are rejected after recovery re-dispatches the turn with a new seq', async () => {
    const s = await session(); const turn = await enqueue(s);
    const first = await store.claimTurn(turn.id, 'w-old', 50);
    expect(await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, first!.fence)).toBe(true);
    await sleep(80);
    expect((await store.recoverExpired(3)).requeued).toContain(turn.id);
    expect(await myDispatches(0, [turn.id])).toEqual([{ turnId: turn.id, seq: 1 }]);
    const second = await store.claimTurn(turn.id, 'w-new', 5000);
    expect(second!.fence.attempt).toBe(2);
    expect(await store.transitionTurn(turn.id, ['pending'], 'failed', 'ZOMBIE', first!.fence)).toBe(false);
    expect(await store.renewLease(turn.id, first!.fence, 5000)).toBe(false);
    expect(await store.renewLease(turn.id, second!.fence, 5000)).toBe(true);
    expect(await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, second!.fence)).toBe(true);
  });
  it('exhausted attempts fail with WORKER_LOST, unblocking the session; cancellation ends renewals', async () => {
    const s = await session(); const turn = await enqueue(s);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const claimed = await store.claimTurn(turn.id, `w-${attempt}`, 30);
      await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, claimed!.fence);
      await sleep(50);
      const recovered = await store.recoverExpired(2);
      if (attempt === 2) expect(recovered.failed).toContain(turn.id);
    }
    expect(await store.getTurn(turn.id, s.ownerId)).toMatchObject({ state: 'failed', errorCode: 'WORKER_LOST' });
    expect(await outboxOf(turn.id)).toEqual([]);
    const next = await enqueue(s, '다시'); const claimed = await store.claimTurn(next.id, 'w-c', 5000);
    expect(await store.cancelTurn(next.id, s.ownerId)).toBe(true);
    expect(await store.renewLease(next.id, claimed!.fence, 5000)).toBe(false);
  });
  it('pending dispatches honour the grace period, re-publish at most once per grace, never go to two dispatchers, and drop ended turns', async () => {
    const s1 = await session(), s2 = await session();
    const a = await enqueue(s1), b = await enqueue(s2);
    expect(await myDispatches(60_000, [a.id, b.id])).toEqual([]); // still within the API's own publish window
    await sleep(30);
    const [one, two] = await Promise.all([myDispatches(10, [a.id, b.id]), myDispatches(10, [a.id, b.id])]);
    expect([...one, ...two].map(d => d.turnId).sort()).toEqual([a.id, b.id].sort());
    expect(await myDispatches(60_000, [a.id, b.id])).toEqual([]); // just re-published
    expect(await store.cancelTurn(b.id, s2.ownerId)).toBe(true);
    await sleep(30);
    expect(await myDispatches(10, [a.id, b.id])).toEqual([{ turnId: a.id, seq: 0 }]);
    expect(await outboxOf(b.id)).toEqual([]);
  });
});
