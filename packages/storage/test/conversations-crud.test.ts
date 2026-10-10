import type { Pool } from 'pg';
import { InsertQueryBuilder, Kysely, PostgresDialect } from 'kysely';
import type { ChatMessage, ChatReply, ChatSession } from '@ptr/contracts';
import { PostgresConversationStore } from '../src/conversations';

const session: ChatSession = {
  id: "synthetic-session'; DROP TABLE sessions; --", ownerId: 'synthetic-owner {owner}',
  personId: 'synthetic-person', personaId: 'synthetic-persona', personaRevision: 'synthetic-v1',
  language: 'ko', timezone: 'Asia/Seoul', retrievalMode: 'off', createdAt: '2026-10-01T03:04:05.000Z',
};
const greeting: ChatMessage = {
  id: 'synthetic-greeting', sessionId: session.id, turnId: null, role: 'assistant',
  content: '합성 인사 😀 {"literal": "${value}"}\n두 번째 줄', createdAt: session.createdAt,
};
const reply: ChatReply = {
  sessionId: session.id, turnId: 'synthetic-turn', messageId: 'synthetic-answer',
  personId: session.personId, personaRevision: session.personaRevision,
  responseKind: 'small_talk', status: 'answered', content: '합성 답변', claims: [], evidence: [], limitations: [],
};
const turnRow = {
  id: 'synthetic-turn', session_id: session.id, owner_id: session.ownerId,
  client_request_id: 'synthetic-request', user_text: '질문 {"value": "${literal}"}', sequence: 3,
  state: 'completed', created_at: new Date(session.createdAt), finished_at: '2026-10-01T04:05:06+00:00',
  reply, error_code: 'SYNTHETIC_ERROR', lease_owner: 'synthetic-worker', attempts: 2,
};

const normalize = (sql: string): string => sql.replaceAll('"', '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Exercise either implementation through the real pg-shaped driver boundary, never a database. */
function harness(selectRows: Array<Array<Record<string, unknown>>> = [], failMessages = false) {
  const rows = [...selectRows];
  const calls: Array<{ sql: string; parameters: unknown[] }> = [];
  const failure = new Error('SYNTHETIC_INSERT_FAILED');
  const query = jest.fn(async (sql: string, parameters: unknown[] = []) => {
    calls.push({ sql, parameters });
    const statement = normalize(sql);
    if (failMessages && statement.startsWith('insert into messages')) throw failure;
    const result = statement.startsWith('select') ? rows.shift() ?? [] : [];
    return { rows: result, rowCount: statement.startsWith('insert') ? 1 : result.length,
      command: statement.split(' ')[0]!.toUpperCase() };
  });
  const release = jest.fn();
  const client = { query, release };
  const connect = jest.fn(async () => client);
  const poolQuery = jest.fn(query);
  const end = jest.fn(async () => undefined);
  const pool = { query: poolQuery, connect, end } as unknown as Pool;
  return { store: new PostgresConversationStore(pool), pool, calls, query, poolQuery, connect, release, end, failure };
}

describe('conversation generic CRUD regression contract (synthetic only)', () => {
  it('construction is lazy, leaves pool ownership with its caller and performs no startup DDL', () => {
    const h = harness();
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
    expect(h.end).not.toHaveBeenCalled();
  });

  it('returns the owned JSON document unchanged, including Unicode and literal format tokens', async () => {
    const document = { ...session, syntheticLiteral: '{"nested": "${untrusted}"} 😀' };
    const h = harness([[{ document }], []]);
    expect(await h.store.getOwnedSession(session.id, session.ownerId)).toBe(document);
    expect(await h.store.getOwnedSession(session.id, 'synthetic-other-owner')).toBeUndefined();
    expect(h.calls.map(call => call.parameters)).toEqual([
      [session.id, session.ownerId], [session.id, 'synthetic-other-owner'],
    ]);
    for (const call of h.calls) {
      expect(normalize(call.sql)).toMatch(/where id\s*=\s*\$1 and owner_id\s*=\s*\$2/);
      expect(call.sql).not.toContain(session.id);
    }
    expect(h.end).not.toHaveBeenCalled();
  });

  it('preserves session ordering and does not rewrite returned JSON objects', async () => {
    const second = { ...session, id: 'synthetic-second' };
    const h = harness([[{ document: second }, { document: session }], []]);
    expect(await h.store.listOwnedSessions(session.ownerId)).toEqual([second, session]);
    expect(await h.store.listOwnedSessions('synthetic-other-owner')).toEqual([]);
    expect(normalize(h.calls[0]!.sql)).toMatch(/order by created_at desc,\s*id(?: asc)?$/);
    expect(h.calls[0]!.parameters).toEqual([session.ownerId]);
  });

  it('keeps owner/completed-turn history filters, ordinal order, null turn ids and ISO dates', async () => {
    const h = harness([[
      { id: greeting.id, session_id: session.id, turn_id: null, role: greeting.role,
        content: greeting.content, created_at: new Date(session.createdAt), ordinal: '1' },
      { id: reply.messageId, session_id: session.id, turn_id: reply.turnId, role: 'assistant',
        content: reply.content, created_at: '2026-10-01T04:05:06+00:00', ordinal: '9' },
    ], []]);
    expect(await h.store.history(session.id, session.ownerId)).toEqual([
      greeting, { id: reply.messageId, sessionId: session.id, turnId: reply.turnId, role: 'assistant',
        content: reply.content, createdAt: '2026-10-01T04:05:06.000Z' },
    ]);
    expect(await h.store.history(session.id, 'synthetic-other-owner')).toEqual([]);
    const call = h.calls[0]!;
    expect(call.parameters.slice(0, 2)).toEqual([session.id, session.ownerId]);
    expect(normalize(call.sql)).toContain('left join turns');
    expect(normalize(call.sql)).toMatch(/m\.turn_id is null or t\.state\s*=/);
    expect(normalize(call.sql)).toMatch(/order by m\.ordinal(?: asc)?$/);
    expect(call.sql).not.toContain(session.id);
  });

  it('preserves the refusal JSON predicate and string id output', async () => {
    const h = harness([[{ id: 'synthetic-refused' }, { id: 42 }], []]);
    expect(await h.store.refusedTurnIds(session.id, session.ownerId)).toEqual(['synthetic-refused', '42']);
    expect(await h.store.refusedTurnIds(session.id, 'synthetic-other-owner')).toEqual([]);
    expect(h.calls[0]!.parameters.slice(0, 2)).toEqual([session.id, session.ownerId]);
    expect(normalize(h.calls[0]!.sql)).toContain("t.reply->'inputsafety'->>'action'");
    expect(h.calls[0]!.sql).toContain("->'inputSafety'->>'action'");
  });

  it('preserves complete turn DTO bytes and omission of nullable optional fields', async () => {
    const h = harness([[turnRow], [{ ...turnRow, finished_at: null, reply: null, error_code: null }], []]);
    const full = await h.store.getTurn(turnRow.id, session.ownerId);
    expect(JSON.stringify(full)).toBe(JSON.stringify({
      id: turnRow.id, sessionId: session.id, ownerId: session.ownerId, clientRequestId: turnRow.client_request_id,
      userText: turnRow.user_text, sequence: 3, state: 'completed', createdAt: session.createdAt,
      finishedAt: '2026-10-01T04:05:06.000Z', reply, errorCode: 'SYNTHETIC_ERROR',
    }));
    const nullable = await h.store.getTurn(turnRow.id, session.ownerId);
    expect(nullable).not.toHaveProperty('finishedAt');
    expect(nullable).not.toHaveProperty('reply');
    expect(nullable).not.toHaveProperty('errorCode');
    expect(await h.store.getTurn(turnRow.id, 'synthetic-other-owner')).toBeUndefined();
    expect(h.calls[0]!.parameters).toEqual([turnRow.id, session.ownerId]);
    expect(normalize(h.calls[0]!.sql)).toMatch(/t\.id\s*=\s*\$1 and s\.owner_id\s*=\s*\$2/);
  });

  it.each([
    [{ state: 'pending', lease_owner: 'synthetic-worker', attempts: 2 }, 'current'],
    [{ state: 'retrieving', lease_owner: 'synthetic-worker', attempts: 2 }, 'current'],
    [{ state: 'generating', lease_owner: 'synthetic-worker', attempts: 2 }, 'current'],
    [{ state: 'validating', lease_owner: 'synthetic-worker', attempts: 2 }, 'current'],
    [{ state: 'cancelled', lease_owner: null, attempts: 0 }, 'cancelled'],
    [{ state: 'completed', lease_owner: 'synthetic-worker', attempts: 2 }, 'lost'],
    [{ state: 'failed', lease_owner: 'synthetic-worker', attempts: 2 }, 'lost'],
    [{ state: 'pending', lease_owner: 'synthetic-other-worker', attempts: 2 }, 'lost'],
    [{ state: 'pending', lease_owner: 'synthetic-worker', attempts: 3 }, 'lost'],
    [{ state: 'pending', lease_owner: null, attempts: 2 }, 'lost'],
    [undefined, 'lost'],
  ])('retains execution status/fence semantics for %j', async (row, expected) => {
    const h = harness([row ? [row] : []]);
    expect(await h.store.executionStatus(turnRow.id, { workerId: 'synthetic-worker', attempt: 2 })).toBe(expected);
    expect(h.calls[0]!.parameters).toEqual([turnRow.id]);
    expect(normalize(h.calls[0]!.sql)).toMatch(/state,\s*lease_owner,\s*attempts/);
  });

  it('creates bound session JSON and greeting together on one supplied connection, without closing its pool', async () => {
    const h = harness();
    await h.store.create(session, greeting);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.poolQuery).not.toHaveBeenCalled();
    expect(normalize(h.calls[0]!.sql)).toBe('begin');
    expect(normalize(h.calls.at(-1)!.sql)).toBe('commit');
    expect(h.calls).toHaveLength(4);
    expect(h.calls[1]!.parameters).toEqual([
      session.id, session.ownerId, session.personId, session.personaId, session.personaRevision, session, session.createdAt,
    ]);
    expect(h.calls[1]!.parameters[5]).toBe(session);
    expect(h.calls[2]!.parameters.filter(value => value !== null)).toEqual([
      greeting.id, session.id, greeting.role, greeting.content, greeting.createdAt,
    ]);
    expect(h.calls[2]!.sql).not.toContain(greeting.content);
    expect(h.end).not.toHaveBeenCalled();
  });

  it('rolls back both inserts on greeting failure, releases exactly once and never retries', async () => {
    const h = harness([], true);
    await expect(h.store.create(session, greeting)).rejects.toBe(h.failure);
    expect(h.calls).toHaveLength(4);
    expect(normalize(h.calls.at(-1)!.sql)).toBe('rollback');
    expect(h.calls.some(call => normalize(call.sql) === 'commit')).toBe(false);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.end).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: 'synthetic-other-session' }, { turnId: 'synthetic-turn' }, { role: 'user' as const },
  ])('rejects invalid greeting binding before connection acquisition: %j', async patch => {
    const h = harness();
    await expect(h.store.create(session, { ...greeting, ...patch })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
});

describe('native Kysely execution (no SDK builder mocks)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('executes all six read methods through native builders and the supplied pg pool', async () => {
    const h = harness();
    const probe = new Kysely<{ sessions: { id: string } }>({ dialect: new PostgresDialect({ pool: h.pool }) });
    const selectPrototype = Object.getPrototypeOf(probe.selectFrom('sessions').select('id')) as {
      execute(): Promise<unknown[]>;
    };
    const selectFrom = jest.spyOn(Kysely.prototype, 'selectFrom');
    const execute = jest.spyOn(selectPrototype, 'execute');
    await h.store.getOwnedSession(session.id, session.ownerId);
    await h.store.listOwnedSessions(session.ownerId);
    await h.store.history(session.id, session.ownerId);
    await h.store.refusedTurnIds(session.id, session.ownerId);
    await h.store.getTurn(turnRow.id, session.ownerId);
    await h.store.executionStatus(turnRow.id, { workerId: 'synthetic-worker', attempt: 2 });
    expect(selectFrom.mock.calls.map(([table]) => table)).toEqual([
      'sessions', 'sessions', 'messages as m', 'turns as t', 'turns as t', 'turns',
    ]);
    expect(execute).toHaveBeenCalledTimes(6);
    expect(h.poolQuery).not.toHaveBeenCalled();
    expect(h.connect).toHaveBeenCalledTimes(6);
    expect(h.release).toHaveBeenCalledTimes(6);
    expect(h.calls).toHaveLength(6);
    expect(h.calls.every(call => normalize(call.sql).startsWith('select '))).toBe(true);
    expect(h.calls.map(call => call.parameters)).toEqual([
      [session.id, session.ownerId], [session.ownerId], [session.id, session.ownerId, 'completed'],
      [session.id, session.ownerId, 'completed', 'refuse'], [turnRow.id, session.ownerId], [turnRow.id],
    ]);
    expect(h.end).not.toHaveBeenCalled();
  });

  it('uses native transaction and insert execution, not compiled SQL forwarded through a manual wrapper', async () => {
    const transaction = jest.spyOn(Kysely.prototype, 'transaction');
    const insertInto = jest.spyOn(Kysely.prototype, 'insertInto');
    const execute = jest.spyOn(InsertQueryBuilder.prototype, 'execute');
    const h = harness();
    await h.store.create(session, greeting);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(insertInto.mock.calls.map(([table]) => table)).toEqual(['sessions', 'messages']);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.end).not.toHaveBeenCalled();
  });

  it('releases a failed read without retrying, closing the shared pool or changing error identity', async () => {
    const h = harness();
    h.query.mockRejectedValueOnce(h.failure);
    await expect(h.store.getOwnedSession(session.id, session.ownerId)).rejects.toBe(h.failure);
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.end).not.toHaveBeenCalled();
  });
});
