import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ChatSession, Persona, ProviderMessage } from '@ptr/contracts';
import { type LocalChat, createLocalChat } from '@ptr/core';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository } from '../src';
import { removeSyntheticConversations } from './synthetic-cleanup';

const enabled = process.env.RUN_STORAGE_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
const integration = enabled ? describe : describe.skip;
const variables = { conversationTopic: 'synthetic_state_topic', tone: 'warm' as const };
const reasoning = 'Synthetic summary: acknowledge the fictional greeting.';
const visibleMessage = 'Hello from this fictional research fixture.';
const finalResponse = (updates: Record<string, unknown> = {}): string => JSON.stringify({
  status: 'answered', message: visibleMessage, evidenceRefs: [], variableUpdates: updates, reasoning,
});
// The service adds the turn's replyLanguage (from the utterance; the fixtures are English) and the persona's speechLevel.
// persona-voice fallback for an English utterance (reply-texts `fallback.en`)
const FALLBACK_EN = 'Hmm, nothing comes to mind on that right now~ Shall we talk about something else?';
const serviceFields = { replyLanguage: 'English', speechLevel: '해요체' };
function assertState(messages: ProviderMessage[], expected = variables): void {
  const blocks = messages.filter(message => message.role === 'system' && message.content.startsWith('AGENT_STATE_JSON_DATA'));
  expect(blocks).toHaveLength(1);
  const state = JSON.parse(blocks[0].content.slice('AGENT_STATE_JSON_DATA'.length).trim()) as unknown;
  expect(state).toEqual({ ...expected, ...serviceFields });
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(fulfill => { resolve = fulfill; });
  return { promise, resolve };
}

integration('dedicated loopback agent-loop agent persistence (synthetic provider and persona only)', () => {
  let pool: Pool;
  const scope = `synthetic-agent-state-${randomUUID()}`;
  const owner = `owner-${scope}`;
  const persona: Persona = {
    id: `persona-${scope}`, personId: scope, revision: 'synthetic-v1', label: 'Synthetic agent-state fixture',
    language: 'en', reviewStatus: 'synthetic', identity: 'Entirely fictional test persona.',
    concept: 'Synthetic persistence fixture only.', style: [], boundaries: [], sourceRefs: [], greeting: 'Synthetic greeting.',
  };
  beforeAll(async () => {
    pool = createLocalPool(process.env.DATABASE_URL!);
    await new PostgresPersonaRepository(pool).importPersona(persona);
  });
  afterAll(async () => { try { await removeSyntheticConversations(pool, [scope]); } finally { await pool?.end(); } });

  function fixture(response = finalResponse(variables)) {
    const provider = { generate: jest.fn(async (_messages: ProviderMessage[], _options: { signal: AbortSignal }) => response) };
    const retrieval = { search: jest.fn(async () => []) };
    const store = new PostgresConversationStore(pool);
    const service = createLocalChat({ store, personas: new PostgresPersonaRepository(pool), provider, retrieval });
    return { provider, retrieval, store, service };
  }
  async function create(service: LocalChat): Promise<ChatSession> {
    return service.createSession(owner, {
      personId: scope, personaId: persona.id, personaRevision: persona.revision, executionProfile: 'agent_loop', timezone: 'UTC',
    });
  }
  async function seeded() {
    const fixtureValue = fixture();
    const session = await create(fixtureValue.service);
    const input = { sessionId: session.id, clientRequestId: 'initial', text: 'Start this fictional conversation.' };
    const turn = await fixtureValue.service.sendTurn(owner, input);
    expect(turn.state).toBe('completed');
    expect(turn.reply?.agent?.variables).toEqual(variables);
    return { ...fixtureValue, session, input, turn };
  }

  it('persists the explicit profile and validated variables; fresh service reconstructs system-only state', async () => {
    const original = await seeded();
    expect(original.session.executionProfile).toBe('agent_loop');
    expect(original.session.retrievalMode).toBe('off');
    expect(original.session.ragCondition).toBe('off');
    expect(original.turn.reply?.content).toBe(visibleMessage);
    expect(original.turn.reply?.agent).toMatchObject({ variables, modelCalls: 1, toolCalls: 0, validator: 'disabled' });
    expect(original.turn.reply?.agent?.revision).toEqual(expect.any(String));
    expect(original.turn.reply?.agent?.promptRevision).toEqual(expect.any(String));
    expect(original.turn.reply?.agent?.steps.length).toBeGreaterThan(0);
    expect(original.retrieval.search).not.toHaveBeenCalled();

    const reloaded = fixture(finalResponse());
    expect((await reloaded.service.getSession(owner, original.session.id)).executionProfile).toBe('agent_loop');
    expect((await reloaded.service.getTurn(owner, original.turn.id)).reply?.agent?.variables).toEqual(variables);
    const next = await reloaded.service.sendTurn(owner, {
      sessionId: original.session.id, clientRequestId: 'after-reload', text: 'Continue this fictional conversation.',
    });
    expect(next.state).toBe('completed');
    assertState(reloaded.provider.generate.mock.calls[0][0]);
    expect(next.reply?.agent?.variables).toEqual(variables);
    expect(reloaded.retrieval.search).not.toHaveBeenCalled();

    const history = await reloaded.service.history(owner, original.session.id);
    expect(history.filter(message => message.turnId === original.turn.id).map(message => message.content))
      .toEqual([original.input.text, visibleMessage]);
    expect(history.filter(message => message.role === 'assistant' && message.turnId).map(message => message.content))
      .toEqual([visibleMessage, visibleMessage]);
    const publicHistory = JSON.stringify(history);
    for (const internal of [reasoning, 'AGENT_STATE_JSON_DATA', variables.conversationTopic, 'variableUpdates', 'decisionSummary'])
      expect(publicHistory).not.toContain(internal);
    expect(history.every(message => message.role === 'user' || message.role === 'assistant')).toBe(true);
  });

  it('replays a completed request after restart with zero provider/tool calls', async () => {
    const original = await seeded();
    const reloaded = fixture();
    const replay = await reloaded.service.sendTurn(owner, original.input);
    expect(replay).toEqual(await reloaded.service.getTurn(owner, original.turn.id));
    expect(replay.id).toBe(original.turn.id);
    expect(replay.reply?.agent?.variables).toEqual(variables);
    expect(reloaded.provider.generate).not.toHaveBeenCalled();
    expect(reloaded.retrieval.search).not.toHaveBeenCalled();
    expect((await reloaded.service.history(owner, original.session.id)).filter(message => message.turnId === original.turn.id)).toHaveLength(2);
  });

  it('hides persisted session, turn, history and agent variables from a different owner', async () => {
    const original = await seeded();
    const intruder = `other-${scope}`;
    const reloaded = fixture();
    await expect(reloaded.service.getSession(intruder, original.session.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(reloaded.service.getTurn(intruder, original.turn.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(reloaded.service.history(intruder, original.session.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(reloaded.service.sendTurn(intruder, original.input)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(reloaded.service.cancelTurn(intruder, original.turn.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await reloaded.store.getOwnedSession(original.session.id, intruder)).toBeUndefined();
    expect(await reloaded.store.getTurn(original.turn.id, intruder)).toBeUndefined();
    expect(await reloaded.store.history(original.session.id, intruder)).toEqual([]);
    expect(await reloaded.service.listSessions(intruder)).toEqual([]);
    expect(reloaded.provider.generate).not.toHaveBeenCalled();
    expect(reloaded.retrieval.search).not.toHaveBeenCalled();
  });

  it('an invalid reply answers once with the persona-voice fallback  without changing state or publishing its output', async () => {
    const original = await seeded();
    const malformed = JSON.stringify({ status: 'answered', message: 'SHOULD_NOT_PUBLISH', evidenceRefs: [],
      variableUpdates: { conversationTopic: 'SHOULD_NOT_PERSIST', tone: 'playful', forbidden: true } });
    const failing = fixture(malformed);
    const input = { sessionId: original.session.id, clientRequestId: 'malformed', text: 'Malformed synthetic turn.' };
    const failed = await failing.service.sendTurn(owner, input);
    expect(failed.state).toBe('completed'); expect(failed.reply).toMatchObject({ status: 'insufficient_evidence', evidence: [], agent: { variables } });
    expect(failed.reply?.limitations).toContain('AGENT_REPLY_INVALID'); expect(failed.reply?.content).toBe(FALLBACK_EN);
    expect(failing.provider.generate).toHaveBeenCalledTimes(1);
    expect(failing.retrieval.search).not.toHaveBeenCalled();
    const replay = await failing.service.sendTurn(owner, input);
    expect(replay.id).toBe(failed.id); expect(failing.provider.generate).toHaveBeenCalledTimes(1);
    const history = await failing.service.history(owner, original.session.id);
    expect(history).toHaveLength(5); // the earlier exchange, then this user message and the fallback reply
    expect(history[3]?.content).toBe(input.text); expect(history[4]?.content).toBe(FALLBACK_EN);
    expect(JSON.stringify(history)).not.toContain('SHOULD_NOT_');

    const probe = fixture(finalResponse());
    const next = await probe.service.sendTurn(owner, { sessionId: original.session.id, clientRequestId: 'after-failure', text: 'Resume fictional chat.' });
    expect(next.state).toBe('completed'); assertState(probe.provider.generate.mock.calls[0][0]);
    expect(next.reply?.agent?.variables).toEqual(variables);
  });

  it('cancellation prevents a late model response from committing variables or entering history', async () => {
    const original = await seeded();
    const entered = deferred<void>(); const output = deferred<string>();
    const blocking = fixture();
    blocking.provider.generate.mockImplementationOnce(async () => { entered.resolve(); return output.promise; });
    const input = { sessionId: original.session.id, clientRequestId: 'cancelled', text: 'Cancelled fictional turn.' };
    const pending = blocking.service.sendTurn(owner, input);
    await entered.promise;
    const reserved = await pool.query('SELECT id FROM turns WHERE session_id=$1 AND client_request_id=$2', [original.session.id, input.clientRequestId]);
    const turnId = reserved.rows[0].id as string;
    expect(await blocking.service.cancelTurn(owner, turnId)).toBe(true);
    output.resolve(JSON.stringify({ status: 'answered', message: 'CANCELLED_SHOULD_NOT_PUBLISH', evidenceRefs: [],
      variableUpdates: { conversationTopic: 'CANCELLED_SHOULD_NOT_PERSIST', tone: 'playful' } }));
    const cancelled = await pending;
    expect(cancelled.id).toBe(turnId); expect(cancelled.state).toBe('cancelled'); expect(cancelled.reply).toBeUndefined();
    expect(blocking.provider.generate).toHaveBeenCalledTimes(1); expect(blocking.retrieval.search).not.toHaveBeenCalled();
    const history = await blocking.service.history(owner, original.session.id);
    expect(history).toHaveLength(3);
    expect(JSON.stringify(history)).not.toContain(input.text); expect(JSON.stringify(history)).not.toContain('CANCELLED_SHOULD_NOT_');

    const probe = fixture(finalResponse());
    const next = await probe.service.sendTurn(owner, { sessionId: original.session.id, clientRequestId: 'after-cancellation', text: 'Resume fictional chat.' });
    expect(next.state).toBe('completed'); assertState(probe.provider.generate.mock.calls[0][0]);
    expect(next.reply?.agent?.variables).toEqual(variables);
  });

  it('RAG-off answers a tool request with the persona-voice fallback: no retrieval, model repair or variable persistence', async () => {
    const original = await seeded();
    const requesting = fixture(JSON.stringify({ status: 'answered', message: '', evidenceRefs: [], variableUpdates: {},
      function: { name: 'timeline_search', arguments: { query: 'Synthetic fictional timeline' } } }));
    const failed = await requesting.service.sendTurn(owner, { sessionId: original.session.id, clientRequestId: 'off-tool', text: 'Synthetic tool request.' });
    expect(failed.state).toBe('completed'); expect(failed.reply).toMatchObject({ status: 'insufficient_evidence', evidence: [], agent: { variables } });
    expect(failed.reply?.limitations).toContain('AGENT_TOOL_UNAVAILABLE'); expect(failed.reply?.content).toBe(FALLBACK_EN);
    expect(requesting.provider.generate).toHaveBeenCalledTimes(1); expect(requesting.retrieval.search).not.toHaveBeenCalled();
    const offHistory = await requesting.service.history(owner, original.session.id);
    expect(offHistory).toHaveLength(5); expect(offHistory[3]?.content).toBe('Synthetic tool request.'); expect(offHistory[4]?.content).toBe(FALLBACK_EN);
    const probe = fixture(finalResponse());
    const next = await probe.service.sendTurn(owner, { sessionId: original.session.id, clientRequestId: 'after-off-tool', text: 'Resume fictional chat.' });
    expect(next.state).toBe('completed'); assertState(probe.provider.generate.mock.calls[0][0]);
    expect(next.reply?.agent?.variables).toEqual(variables);
  });
});
