import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ChatReply, ChatSession, Persona, SourcePost, TimelineQuery } from '@ptr/contracts';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository, PostgresSourceRepository } from '../src/index';

const enabled = process.env.RUN_STORAGE_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const integration = enabled ? describe : describe.skip;
integration('dedicated loopback Postgres storage (synthetic fixtures only)', () => {
  let pool: Pool;
  let conversations: PostgresConversationStore;
  let personas: PostgresPersonaRepository;
  let sources: PostgresSourceRepository;
  const scope = `synthetic-${randomUUID()}`;
  const persona: Persona = { id: `persona-${scope}`, personId: scope, revision: 'synthetic-v1', label: 'Synthetic fixture', language: 'ko',
    reviewStatus: 'synthetic', identity: 'Fictional fixture only', concept: 'test', style: [], boundaries: [], sourceRefs: [], greeting: '안녕하세요' };
  const session: ChatSession = { id: `session-${scope}`, ownerId: `owner-${scope}`, personId: scope, personaId: persona.id,
    personaRevision: persona.revision, language: 'ko', timezone: 'Asia/Seoul', retrievalMode: 'off', createdAt: new Date().toISOString() };
  const signal = new AbortController().signal;
  const query = (overrides: Partial<TimelineQuery> = {}): TimelineQuery => ({ personId: scope, query: '일상', start: '2024-01-01', end: '2024-01-02',
    dateBasis: 'posted', timezone: 'Asia/Seoul', limit: 5, ...overrides });
  function post(suffix: string, overrides: Partial<SourcePost> = {}): SourcePost {
    return { id: `${scope}-${suffix}`, personId: scope, caption: '합성 일상 테스트', postedAt: '2023-12-31T15:00:00Z', eventDate: null,
      sourceUrl: 'https://example.com/synthetic', hash: `synthetic-hash-${suffix}`, snapshot: 'synthetic-snapshot', unsafe: false, ...overrides };
  }
  const posts = [post('start'), post('end', { postedAt: '2024-01-01T15:00:00Z' }),
    post('unsafe', { unsafe: true }), post('other-person', { personId: `${scope}-other` }),
    post('event', { eventDate: '2024-01-01', postedAt: '2020-01-01T00:00:00Z' })];
  beforeAll(async () => {
    pool = createLocalPool(process.env.DATABASE_URL!);
    conversations = new PostgresConversationStore(pool);
    personas = new PostgresPersonaRepository(pool);
    sources = new PostgresSourceRepository(pool);
    await personas.importPersona(persona);
    await conversations.create(session, { id: `greeting-${scope}`, sessionId: session.id, turnId: null, role: 'assistant', content: persona.greeting, createdAt: session.createdAt });
    await sources.importPosts(posts, 'synthetic_fixture');
  });
  afterAll(async () => { await pool?.end(); });
  it('keeps persona revisions immutable and pinned', async () => {
    await personas.importPersona(persona);
    await expect(personas.importPersona({ ...persona, greeting: 'mutated' })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await personas.importPersona({ ...persona, revision: 'synthetic-v2', greeting: 'new synthetic greeting' });
    await personas.importPersona(persona); // replaying an older immutable import does not roll the pointer back
    expect((await personas.get(persona.id))?.revision).toBe('synthetic-v2');
    expect((await personas.get(persona.id, persona.revision))?.greeting).toBe(persona.greeting);
    expect((await conversations.getOwnedSession(session.id, session.ownerId))?.personaRevision).toBe(persona.revision);
  });
  it('hides sessions, turns and history from other owners', async () => {
    expect(await conversations.getOwnedSession(session.id, 'wrong-owner')).toBeUndefined();
    expect(await conversations.history(session.id, 'wrong-owner')).toEqual([]);
    await expect(conversations.reserveTurn(session.id, 'wrong-owner', 'bad-owner', 'test')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('serializes concurrent reservations, request replay, and conflicting text', async () => {
    const results = await Promise.all([
      conversations.reserveTurn(session.id, session.ownerId, 'same', 'synthetic question'),
      conversations.reserveTurn(session.id, session.ownerId, 'same', 'synthetic question'),
    ]);
    expect(results.map(result => result.created).sort()).toEqual([false, true]);
    expect(results[0].turn.id).toBe(results[1].turn.id);
    await expect(conversations.reserveTurn(session.id, session.ownerId, 'same', 'different')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(conversations.reserveTurn(session.id, session.ownerId, 'another', 'test')).rejects.toMatchObject({ code: 'TURN_ACTIVE' });
    const turnId = results[0].turn.id;
    expect(await conversations.transitionTurn(turnId, ['pending'], 'generating')).toBe(true);
    expect(await conversations.transitionTurn(turnId, ['pending'], 'validating')).toBe(false);
    expect(await conversations.cancelTurn(turnId, 'wrong-owner')).toBe(false);
    expect(await conversations.cancelTurn(turnId, session.ownerId)).toBe(true);
    expect(await conversations.transitionTurn(turnId, ['generating'], 'validating')).toBe(false);
    expect(await conversations.getTurn(turnId, 'wrong-owner')).toBeUndefined();
    expect(await conversations.history(session.id, session.ownerId)).toHaveLength(1);
  });
  it('commits completed messages atomically and rejects late cancellation', async () => {
    const { turn } = await conversations.reserveTurn(session.id, session.ownerId, 'complete', 'complete synthetic question');
    await conversations.transitionTurn(turn.id, ['pending'], 'generating');
    await conversations.transitionTurn(turn.id, ['generating'], 'validating');
    const reply: ChatReply = { sessionId: session.id, turnId: turn.id, messageId: randomUUID(), personId: scope, personaRevision: persona.revision,
      responseKind: 'small_talk', status: 'answered', content: 'synthetic response', claims: [], evidence: [], limitations: [] };
    await expect(conversations.completeTurn(turn.id, { ...reply, personId: 'wrong' })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await conversations.getTurn(turn.id, session.ownerId))?.state).toBe('validating');
    await expect(conversations.completeTurn(turn.id, { ...reply, messageId: `greeting-${scope}` })).rejects.toThrow();
    expect((await conversations.getTurn(turn.id, session.ownerId))?.state).toBe('validating');
    expect(await conversations.history(session.id, session.ownerId)).toHaveLength(1);
    expect(await conversations.completeTurn(turn.id, reply)).toBe(true);
    expect(await conversations.completeTurn(turn.id, reply)).toBe(false);
    expect(await conversations.cancelTurn(turn.id, session.ownerId)).toBe(false);
    expect((await conversations.history(session.id, session.ownerId)).map(message => message.content))
      .toEqual([persona.greeting, 'complete synthetic question', 'synthetic response']);
  });
  it('keeps failed partials out of history and permits the next turn', async () => {
    const { turn } = await conversations.reserveTurn(session.id, session.ownerId, 'fail', 'failed synthetic question');
    expect(await conversations.transitionTurn(turn.id, ['pending'], 'failed', 'SYNTHETIC_FAILURE')).toBe(true);
    expect((await conversations.history(session.id, session.ownerId)).some(message => message.content === turn.userText)).toBe(false);
    const next = await conversations.reserveTurn(session.id, session.ownerId, 'after-fail', 'next synthetic question');
    expect(next.turn.sequence).toBe(turn.sequence + 1);
    await conversations.cancelTurn(next.turn.id, session.ownerId);
  });
  it('enforces one active turn across different concurrent requests', async () => {
    const results = await Promise.allSettled([
      conversations.reserveTurn(session.id, session.ownerId, 'different-a', 'question a'),
      conversations.reserveTurn(session.id, session.ownerId, 'different-b', 'question b'),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'TURN_ACTIVE' });
    const fulfilled = results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof conversations.reserveTurn>>>;
    await conversations.cancelTurn(fulfilled.value.turn.id, session.ownerId);
  });
  it('makes completion and cancellation mutually exclusive even for canned direct validation', async () => {
    const { turn } = await conversations.reserveTurn(session.id, session.ownerId, 'completion-race', 'synthetic race');
    expect(await conversations.transitionTurn(turn.id, ['pending'], 'validating')).toBe(true);
    const reply: ChatReply = { sessionId: session.id, turnId: turn.id, messageId: randomUUID(), personId: scope, personaRevision: persona.revision,
      responseKind: 'clarification', status: 'needs_clarification', content: 'synthetic clarification', claims: [], evidence: [], limitations: [] };
    const results = await Promise.all([
      conversations.completeTurn(turn.id, reply), conversations.cancelTurn(turn.id, session.ownerId),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const saved = await conversations.getTurn(turn.id, session.ownerId);
    const messages = (await conversations.history(session.id, session.ownerId)).filter(message => message.turnId === turn.id);
    expect(messages).toHaveLength(saved?.state === 'completed' ? 2 : 0);
  });
  it('idempotently imports source snapshots and rejects overwrites/generated origins', async () => {
    expect(await sources.importPosts(posts, 'synthetic_fixture')).toEqual({ inserted: 0, existing: posts.length });
    await expect(sources.importPosts([{ ...posts[0], caption: 'mutated' }], 'synthetic_fixture')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(sources.importPosts([], 'generated' as 'synthetic_fixture')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('applies timezone boundary, safe person scope and event-null distinction', async () => {
    expect((await sources.searchLexical(query(), { personId: scope }, { signal })).map(item => item.id)).toEqual([posts[0].id]);
    expect((await sources.searchLexical(query({ dateBasis: 'event' }), { personId: scope }, { signal })).map(item => item.id)).toEqual([posts[4].id]);
    await expect(sources.searchLexical(query(), { personId: 'other' }, { signal })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(sources.searchLexical(query({ timezone: 'Invalid/Timezone' }), { personId: scope }, { signal })).rejects.toThrow();
  });
  it('ranks semantic similarity only after person/date/safety scoping', async () => {
    const axis = (index: number): number[] => Array.from({ length: 1536 }, (_, dimension) => dimension === index ? 1 : 0);
    for (const source of posts) await sources.importVector(source.id, 'synthetic-1536', axis(source === posts[0] ? 1 : 0));
    const result = await sources.searchSemantic(query(), { personId: scope }, axis(0), 'synthetic-1536', { signal });
    expect(result.map(item => item.id)).toEqual([posts[0].id]);
    await sources.importVector(posts[0].id, 'synthetic-1536', axis(1));
    await expect(sources.importVector(posts[0].id, 'synthetic-1536', axis(0))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
});
