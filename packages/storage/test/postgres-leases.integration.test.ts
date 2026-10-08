import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { ChatReply, ChatSession, Persona } from '@ptr/contracts';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository } from '../src/index';

// Recovery, reconciliation and dispatch sweeps are database-wide. Run these tests on a database no dispatcher or load
// test is using at the same time (e.g. ptr_loadtest while idle); assertions only look at this file's own turns.
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
  const leaseOf = async (turnId: string) => (await pool.query('SELECT owner, attempt, expires_at FROM turn_leases WHERE turn_id=$1', [turnId])).rows;
  // xmin changes whenever the turns row gets a new version, i.e. on any UPDATE of it.
  const turnRow = async (turnId: string) => (await pool.query('SELECT xmin::text AS xmin, lease_owner, attempts, state FROM turns WHERE id=$1', [turnId])).rows[0];
  const reply = (s: ChatSession, turnId: string): ChatReply => ({ sessionId: s.id, turnId, messageId: randomUUID(), personId: scope,
    personaRevision: persona.revision, responseKind: 'small_talk', status: 'answered', content: 'synthetic', claims: [], evidence: [], limitations: [] });
  /** An open transaction on its own connection, used to hold locks while another operation runs. */
  const holders = new Set<() => Promise<void>>();
  async function holder(): Promise<{ client: PoolClient; pid: number; end: (sql: 'COMMIT' | 'ROLLBACK') => Promise<void> }> {
    const client = await pool.connect();
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
    await client.query('BEGIN');
    await client.query('SELECT now()');
    const end = async (sql: 'COMMIT' | 'ROLLBACK') => { holders.delete(abort); try { await client.query(sql); } finally { client.release(); } };
    const abort = () => end('ROLLBACK');
    holders.add(abort);
    return { client, pid, end };
  }
  afterEach(async () => { for (const abort of [...holders]) await abort(); }); // a failed assertion must not leave locks behind
  /** A store whose statements run inside that open transaction (single-statement methods only). */
  const storeOn = (client: PoolClient) => new PostgresConversationStore({ query: (text: string, values?: unknown[]) => client.query(text, values) } as unknown as Pool);
  /** Resolves once `count` other backends wait on `pid`, directly or behind another waiter (e.g. a tuple lock queue). */
  async function waitingOn(pid: number, count = 1): Promise<void> {
    for (const end = Date.now() + 5000; Date.now() < end; await sleep(5)) {
      const waiting = Number((await pool.query(`WITH RECURSIVE w(pid) AS (
          SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
          UNION SELECT a.pid FROM pg_stat_activity a JOIN w ON w.pid = ANY(pg_blocking_pids(a.pid)))
        SELECT count(*) AS n FROM w`, [pid])).rows[0].n);
      if (waiting >= count) return;
    }
    throw new Error('operation never waited on the held lock');
  }
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

  describe('lease expiry lives in turn_leases, not in turns', () => {
    it('turns no longer carries the lease expiry; the claim writes the fence on turns and the expiry in turn_leases', async () => {
      const columns = (await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='turns' AND table_schema=current_schema()`)).rows.map(r => r.column_name);
      expect(columns).toEqual(expect.arrayContaining(['lease_owner', 'attempts']));
      expect(columns).not.toContain('lease_expires_at');
      const s = await session(); const turn = await enqueue(s);
      const before = Date.now();
      const claimed = await store.claimTurn(turn.id, 'w-a', 5000);
      expect(await turnRow(turn.id)).toMatchObject({ lease_owner: 'w-a', attempts: 1, state: 'pending' });
      const [lease] = await leaseOf(turn.id);
      expect(lease).toMatchObject({ owner: 'w-a', attempt: claimed!.fence.attempt });
      expect(new Date(lease.expires_at).getTime()).toBeGreaterThan(before + 3000);
    });
    it('a renewal extends turn_leases only and never writes the turns row', async () => {
      const s = await session(); const turn = await enqueue(s);
      const claimed = await store.claimTurn(turn.id, 'w-a', 1000);
      expect(await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, claimed!.fence)).toBe(true);
      const row = await turnRow(turn.id); const [lease] = await leaseOf(turn.id);
      await sleep(20);
      expect(await store.renewLease(turn.id, claimed!.fence, 5000)).toBe(true);
      expect((await turnRow(turn.id)).xmin).toBe(row.xmin);
      expect(new Date((await leaseOf(turn.id))[0].expires_at).getTime()).toBeGreaterThan(new Date(lease.expires_at).getTime() + 3000);
    });
    it('concurrent claims of a pending turn whose lease expired re-lease it exactly once with the next attempt', async () => {
      const s = await session(); const turn = await enqueue(s);
      await store.claimTurn(turn.id, 'w-dead', 20); // claimed, never started, worker gone
      await sleep(40);
      const claims = await Promise.all(['w-a', 'w-b', 'w-c', 'w-d'].map(w => store.claimTurn(turn.id, w, 5000)));
      const won = claims.filter(Boolean);
      expect(won).toHaveLength(1);
      expect(won[0]!.fence.attempt).toBe(2);
      expect(await turnRow(turn.id)).toMatchObject({ lease_owner: won[0]!.fence.workerId, attempts: 2 });
      expect(await leaseOf(turn.id)).toEqual([expect.objectContaining({ owner: won[0]!.fence.workerId, attempt: 2 })]);
      expect(await store.renewLease(turn.id, { workerId: 'w-dead', attempt: 1 }, 5000)).toBe(false);
    });
    it('after recovery, the old lease can neither renew nor write, and its lease row is gone', async () => {
      const s = await session(); const turn = await enqueue(s);
      const first = await store.claimTurn(turn.id, 'w-old', 30);
      expect(await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, first!.fence)).toBe(true);
      await sleep(50);
      expect((await store.recoverExpired(3)).requeued).toContain(turn.id);
      expect(await leaseOf(turn.id)).toEqual([]);
      expect(await turnRow(turn.id)).toMatchObject({ lease_owner: null, state: 'pending' });
      expect(await store.renewLease(turn.id, first!.fence, 5000)).toBe(false);
      expect(await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, first!.fence)).toBe(false);
      expect(await leaseOf(turn.id)).toEqual([]);
    });
    it('two concurrent dispatchers recover each expired lease exactly once', async () => {
      const turns: string[] = [];
      for (let i = 0; i < 6; i++) {
        const s = await session(); const turn = await enqueue(s);
        const claimed = await store.claimTurn(turn.id, `w-${i}`, 20);
        await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, claimed!.fence);
        turns.push(turn.id);
      }
      await sleep(40);
      const [one, two] = await Promise.all([store.recoverExpired(3), store.recoverExpired(3)]);
      const mine = [...one.requeued, ...two.requeued, ...one.failed, ...two.failed].filter(id => turns.includes(id));
      expect(mine.sort()).toEqual([...turns].sort());
      for (const id of turns) {
        expect(await outboxOf(id)).toEqual([{ seq: 1 }]);
        expect(await leaseOf(id)).toEqual([]);
      }
    });
    it('a renewal cannot revive an expired lease that a waiting claim already saw as expired', async () => {
      const s = await session(); const turn = await enqueue(s);
      const old = (await store.claimTurn(turn.id, 'w-old', 20))!.fence;
      await sleep(40);
      const lock = await holder();
      await lock.client.query('SELECT 1 FROM turns WHERE id=$1 FOR UPDATE', [turn.id]);
      const claim = store.claimTurn(turn.id, 'w-new', 5000);
      await waitingOn(lock.pid);
      expect(await store.renewLease(turn.id, old, 5000)).toBe(false);
      await lock.end('ROLLBACK');
      const claimed = await claim;
      expect(claimed!.fence).toEqual({ workerId: 'w-new', attempt: 2 });
      expect(await leaseOf(turn.id)).toEqual([expect.objectContaining({ owner: 'w-new', attempt: 2 })]);
      expect(await store.renewLease(turn.id, old, 5000)).toBe(false);
    });
    it('a lease that expired without being recovered refuses renewal, and recovery then requeues it with the next attempt', async () => {
      const s = await session(); const turn = await enqueue(s);
      const fence = (await store.claimTurn(turn.id, 'w-late', 20))!.fence;
      await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, fence);
      await sleep(40);
      expect(await store.renewLease(turn.id, fence, 5000)).toBe(false); // the worker aborts with LEASE_LOST and writes nothing
      expect(await turnRow(turn.id)).toMatchObject({ state: 'generating', lease_owner: 'w-late', attempts: 1 });
      expect((await store.recoverExpired(3)).requeued).toContain(turn.id);
      expect((await store.claimTurn(turn.id, 'w-next', 5000))!.fence.attempt).toBe(2);
    });
    it.each(['fail', 'cancel'] as const)('a terminal %s queued behind a claim also removes the lease row that claim commits', async op => {
      const s = await session(); const turn = await enqueue(s);
      const lock = await holder();
      await lock.client.query('SELECT 1 FROM turns WHERE id=$1 FOR UPDATE', [turn.id]);
      const claim = store.claimTurn(turn.id, 'w-a', 5000);
      await waitingOn(lock.pid, 1);
      const end = op === 'fail' ? store.transitionTurn(turn.id, ['pending'], 'failed', 'SYNTHETIC') : store.cancelTurn(turn.id, s.ownerId);
      await waitingOn(lock.pid, 2);
      await lock.end('ROLLBACK');
      expect(await claim).toBeDefined();
      expect(await end).toBe(true);
      expect((await turnRow(turn.id)).state).toBe(op === 'fail' ? 'failed' : 'cancelled');
      expect(await leaseOf(turn.id)).toEqual([]);
    });
    it('a claim queued behind recovery takes the requeued turn with the next attempt and a matching lease row', async () => {
      const s = await session(); const turn = await enqueue(s);
      await store.claimTurn(turn.id, 'w-dead', 20);
      await sleep(40);
      const recovery = await holder();
      expect((await storeOn(recovery.client).recoverExpired(3)).requeued).toContain(turn.id);
      const claim = store.claimTurn(turn.id, 'w-new', 5000);
      await waitingOn(recovery.pid);
      await recovery.end('COMMIT');
      expect((await claim)!.fence).toEqual({ workerId: 'w-new', attempt: 2 });
      expect(await turnRow(turn.id)).toMatchObject({ lease_owner: 'w-new', attempts: 2, state: 'pending' });
      expect(await leaseOf(turn.id)).toEqual([expect.objectContaining({ owner: 'w-new', attempt: 2 })]);
    });
    it('a renewal queued behind recovery returns false once recovery commits', async () => {
      const s = await session(); const turn = await enqueue(s);
      const fence = (await store.claimTurn(turn.id, 'w-a', 300))!.fence;
      await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, fence);
      const renewer = await holder(); // its now() is fixed while the lease was still valid
      await sleep(350);
      const recovery = await holder();
      expect((await storeOn(recovery.client).recoverExpired(3)).requeued).toContain(turn.id);
      const renewal = storeOn(renewer.client).renewLease(turn.id, fence, 5000);
      await waitingOn(recovery.pid);
      await recovery.end('COMMIT');
      expect(await renewal).toBe(false);
      await renewer.end('COMMIT');
      expect(await turnRow(turn.id)).toMatchObject({ lease_owner: null, state: 'pending' });
      expect(await leaseOf(turn.id)).toEqual([]);
    });
    it('recovery skips a lease row that is being renewed instead of waiting for it', async () => {
      const s = await session(); const turn = await enqueue(s);
      const fence = (await store.claimTurn(turn.id, 'w-a', 20))!.fence;
      await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, fence);
      await sleep(40);
      const renewal = await holder();
      await renewal.client.query("UPDATE turn_leases SET expires_at=now()+interval '5 seconds' WHERE turn_id=$1", [turn.id]);
      expect((await store.recoverExpired(3)).requeued).not.toContain(turn.id);
      await renewal.end('COMMIT');
      expect(await turnRow(turn.id)).toMatchObject({ lease_owner: 'w-a', state: 'generating' });
      expect(await store.renewLease(turn.id, fence, 5000)).toBe(true);
      await store.transitionTurn(turn.id, ['generating'], 'failed', 'TEST_DONE', fence);
    });
    it('exhausted attempts fail with WORKER_LOST and drop the lease row', async () => {
      const s = await session(); const turn = await enqueue(s);
      const claimed = await store.claimTurn(turn.id, 'w-1', 20);
      await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, claimed!.fence);
      await sleep(40);
      expect((await store.recoverExpired(1)).failed).toContain(turn.id);
      expect(await turnRow(turn.id)).toMatchObject({ state: 'failed', lease_owner: null });
      expect(await leaseOf(turn.id)).toEqual([]);
    });
    it('terminal transitions (completed, failed, cancelled) remove the lease row', async () => {
      const ended: string[] = [];
      const s1 = await session(); const done = await enqueue(s1);
      const f1 = (await store.claimTurn(done.id, 'w-done', 5000))!.fence;
      await store.transitionTurn(done.id, ['pending'], 'generating', undefined, f1);
      await store.transitionTurn(done.id, ['generating'], 'validating', undefined, f1);
      expect(await leaseOf(done.id)).toHaveLength(1);
      expect(await store.completeTurn(done.id, reply(s1, done.id), f1)).toBe(true);
      ended.push(done.id);
      const s2 = await session(); const failed = await enqueue(s2);
      const f2 = (await store.claimTurn(failed.id, 'w-fail', 5000))!.fence;
      expect(await store.transitionTurn(failed.id, ['pending'], 'failed', 'SYNTHETIC', f2)).toBe(true);
      ended.push(failed.id);
      const s3 = await session(); const cancelled = await enqueue(s3);
      await store.claimTurn(cancelled.id, 'w-cancel', 5000);
      expect(await store.cancelTurn(cancelled.id, s3.ownerId)).toBe(true);
      ended.push(cancelled.id);
      for (const id of ended) expect(await leaseOf(id)).toEqual([]);
    });
  });

  describe('lease reconciliation (token without a matching lease row, leftover lease rows)', () => {
    async function orphan() {
      const s = await session(); const turn = await enqueue(s);
      const fence = (await store.claimTurn(turn.id, 'w-a', 5000))!.fence;
      await store.transitionTurn(turn.id, ['pending'], 'generating', undefined, fence);
      await pool.query('DELETE FROM turn_leases WHERE turn_id=$1', [turn.id]); // e.g. a mixed-version deploy
      return { s, turn, fence };
    }
    it('requeues an orphaned active turn once it is older than the grace period, and the old fence is dead', async () => {
      const { turn, fence } = await orphan();
      expect((await store.reconcileLeases(3, 60_000)).requeued).not.toContain(turn.id);
      expect((await store.reconcileLeases(3, 0)).requeued).toContain(turn.id);
      expect(await turnRow(turn.id)).toMatchObject({ lease_owner: null, state: 'pending', attempts: 1 });
      expect(await outboxOf(turn.id)).toEqual([{ seq: 1 }]);
      expect(await store.transitionTurn(turn.id, ['pending'], 'failed', 'ZOMBIE', fence)).toBe(false);
      expect((await store.claimTurn(turn.id, 'w-b', 5000))!.fence.attempt).toBe(2);
    });
    it('fails an orphan with WORKER_LOST when its attempts are exhausted', async () => {
      const { turn } = await orphan();
      expect((await store.reconcileLeases(1, 0)).failed).toContain(turn.id);
      expect(await store.getTurn(turn.id, `owner-${scope}`)).toMatchObject({ state: 'failed', errorCode: 'WORKER_LOST' });
      expect(await outboxOf(turn.id)).toEqual([]);
    });
    it('deletes lease rows of ended turns and rows whose token no longer matches; live leases are untouched', async () => {
      const s1 = await session(); const ended = await enqueue(s1);
      await store.claimTurn(ended.id, 'w-e', 5000);
      await store.cancelTurn(ended.id, s1.ownerId);
      await pool.query("INSERT INTO turn_leases(turn_id,owner,attempt,expires_at) VALUES($1,'w-e',1,now()+interval '1 hour')", [ended.id]);
      const s2 = await session(); const drifted = await enqueue(s2);
      await store.claimTurn(drifted.id, 'w-d', 5000);
      await pool.query('UPDATE turn_leases SET attempt=attempt+5 WHERE turn_id=$1', [drifted.id]);
      const s3 = await session(); const live = await enqueue(s3);
      const liveFence = (await store.claimTurn(live.id, 'w-l', 5000))!.fence;
      const result = await store.reconcileLeases(3, 0);
      expect(result.dropped).toBeGreaterThanOrEqual(2);
      expect(result.requeued).toContain(drifted.id); // its token had no matching lease any more
      expect(await leaseOf(ended.id)).toEqual([]);
      expect(await leaseOf(drifted.id)).toEqual([]);
      expect(await leaseOf(live.id)).toEqual([expect.objectContaining({ owner: 'w-l', attempt: 1 })]);
      expect(await store.renewLease(live.id, liveFence, 5000)).toBe(true);
    });
    it('two concurrent reconcilers handle each orphan exactly once', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) ids.push((await orphan()).turn.id);
      const [one, two] = await Promise.all([store.reconcileLeases(3, 0), store.reconcileLeases(3, 0)]);
      const mine = [...one.requeued, ...two.requeued].filter(id => ids.includes(id));
      expect(mine.sort()).toEqual([...ids].sort());
      for (const id of ids) expect(await outboxOf(id)).toEqual([{ seq: 1 }]);
    });
    it('skips an orphan whose turn row is locked, and leaves it alone once its lease row is restored', async () => {
      const { turn, fence } = await orphan();
      const lock = await holder();
      await lock.client.query('SELECT 1 FROM turns WHERE id=$1 FOR UPDATE', [turn.id]);
      expect((await store.reconcileLeases(3, 0)).requeued).not.toContain(turn.id);
      await lock.client.query("INSERT INTO turn_leases(turn_id,owner,attempt,expires_at) VALUES($1,$2,$3,now()+interval '5 seconds')", [turn.id, fence.workerId, fence.attempt]);
      await lock.end('COMMIT');
      expect((await store.reconcileLeases(3, 0)).requeued).not.toContain(turn.id);
      expect(await turnRow(turn.id)).toMatchObject({ lease_owner: 'w-a', state: 'generating' });
      await store.transitionTurn(turn.id, ['generating'], 'failed', 'TEST_DONE', fence);
    });
  });

  it('migration 0008 carries active leases over from turns, drops the old column and index, and is idempotent', async () => {
    const client = await pool.connect();
    const schema = `ptr_migtest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      await client.query(`CREATE TABLE ptr_schema_migrations(name text PRIMARY KEY);
        CREATE TABLE turns(id text PRIMARY KEY, state text NOT NULL, lease_owner text, lease_expires_at timestamptz, attempts integer NOT NULL DEFAULT 0);
        CREATE INDEX turns_active_leases ON turns(lease_expires_at) WHERE lease_expires_at IS NOT NULL AND state IN ('pending','retrieving','generating','validating');
        INSERT INTO turns VALUES ('live','generating','w-a','2030-01-01T00:00:00Z',2), ('expired','pending','w-b','2020-01-01T00:00:00Z',1),
          ('unleased','pending',NULL,NULL,0), ('requeued','pending',NULL,NULL,1), ('done','completed','w-c','2030-01-01T00:00:00Z',1);`);
      const sql = await readFile(resolve(__dirname, '../../../supabase/migrations/0008_turn_leases.sql'), 'utf8');
      await client.query(sql);
      await client.query(sql);
      expect((await client.query('SELECT turn_id, owner, attempt, expires_at FROM turn_leases ORDER BY turn_id')).rows).toEqual([
        { turn_id: 'expired', owner: 'w-b', attempt: 1, expires_at: new Date('2020-01-01T00:00:00Z') },
        { turn_id: 'live', owner: 'w-a', attempt: 2, expires_at: new Date('2030-01-01T00:00:00Z') },
      ]);
      const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='turns'`, [schema])).rows.map(r => r.column_name);
      expect(columns.sort()).toEqual(['attempts', 'id', 'lease_owner', 'state']);
      expect((await client.query('SELECT indexname FROM pg_indexes WHERE schemaname=$1 ORDER BY indexname', [schema])).rows.map(r => r.indexname))
        .toEqual(['ptr_schema_migrations_pkey', 'turn_leases_pkey', 'turns_pkey']);
      const options = (await client.query(`SELECT reloptions FROM pg_class WHERE oid=to_regclass($1)`, [`${schema}.turn_leases`])).rows[0].reloptions;
      expect(options).toEqual(expect.arrayContaining(['fillfactor=70']));
      expect((await client.query('SELECT name FROM ptr_schema_migrations')).rows).toEqual([{ name: '0008_turn_leases.sql' }]);
    } finally {
      await client.query('RESET search_path').catch(() => undefined);
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); // only the scratch schema this test created
      client.release();
    }
  });
});
