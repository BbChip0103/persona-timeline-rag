import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ChatSession, Persona } from '@ptr/contracts';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository } from '../src/index';
import { removeSyntheticConversations } from './synthetic-cleanup';

const enabled = process.env.RUN_STORAGE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const integration = enabled ? describe : describe.skip;
integration('removeSyntheticConversations (synthetic fixtures only)', () => {
  let pool: Pool;
  let store: PostgresConversationStore;
  const scope = `synthetic-cleanup-${randomUUID()}`;
  const other = `synthetic-cleanup-${randomUUID()}`;
  const persona = (personId: string): Persona => ({ id: `persona-${personId}`, personId, revision: 'synthetic-v1', label: 'Synthetic fixture', language: 'ko',
    reviewStatus: 'synthetic', identity: 'Fictional fixture only', concept: 'test', style: [], boundaries: [], sourceRefs: [], greeting: '안녕하세요' });
  async function queued(personId: string) {
    const value: ChatSession = { id: `session-${randomUUID()}`, ownerId: `owner-${personId}`, personId, personaId: `persona-${personId}`,
      personaRevision: 'synthetic-v1', language: 'ko', timezone: 'UTC', retrievalMode: 'off', createdAt: new Date().toISOString() };
    await store.create(value, { id: `greeting-${randomUUID()}`, sessionId: value.id, turnId: null, role: 'assistant', content: '안녕', createdAt: value.createdAt });
    const input = { sessionId: value.id, clientRequestId: randomUUID(), text: '안녕', intent: 'small_talk' as const };
    return (await store.reserveTurn(value.id, value.ownerId, input.clientRequestId, input.text, undefined, input)).turn.id;
  }
  const count = async (table: string, column: string, personId: string) => Number((await pool.query(
    `SELECT count(*) AS n FROM ${table} x JOIN sessions s ON s.id=x.${column} WHERE s.person_id=$1`, [personId])).rows[0].n);
  beforeAll(async () => {
    pool = createLocalPool(process.env.DATABASE_URL!);
    store = new PostgresConversationStore(pool);
    for (const id of [scope, other]) await new PostgresPersonaRepository(pool).importPersona(persona(id));
  });
  afterAll(async () => { try { await removeSyntheticConversations(pool, [scope, other]); } finally { await pool?.end(); } });

  it('removes the queued turns, outbox entries, messages and sessions of the given scope and nothing else', async () => {
    const turnId = await queued(scope); const keptId = await queued(other);
    expect(Number((await pool.query('SELECT count(*) AS n FROM turn_outbox WHERE turn_id=$1', [turnId])).rows[0].n)).toBe(1);
    await removeSyntheticConversations(pool, [scope]);
    expect(await count('turns', 'session_id', scope)).toBe(0);
    expect(await count('messages', 'session_id', scope)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) AS n FROM sessions WHERE person_id=$1', [scope])).rows[0].n)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) AS n FROM turn_outbox WHERE turn_id=ANY($1)', [[turnId]])).rows[0].n)).toBe(0);
    expect(Number((await pool.query('SELECT count(*) AS n FROM turns WHERE id=$1', [keptId])).rows[0].n)).toBe(1);
  });
});
