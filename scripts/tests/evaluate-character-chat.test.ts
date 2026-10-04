import type { ChatReply } from '@ptr/contracts';
import type { HarnessRuntime, TurnTrace } from '../evaluate';
import { executeNaturalConversation, naturalTurnInput, summarizeNaturalRows, validateUserExport, type NaturalChatRow, type UserConversation } from '../evaluate-character-chat';
import { userConversation, type ChatCase, type ChatTestset } from '../prepare-character-chat-testset';

const conversation: UserConversation = { id: 'scenario-synthetic', personId: 'synthetic-person', personaId: 'synthetic-persona', personaRevision: 'synthetic-v1',
  turns: [{ id: 'turn-a', text: 'Can we plan a fictional picnic?' }, { id: 'turn-b', text: 'Keep it inexpensive.' }, { id: 'turn-c', text: 'And remember, no cooking.' }] };
const reply: ChatReply = { sessionId: 'synthetic-session', turnId: 'synthetic-turn', messageId: 'synthetic-message', personId: 'synthetic-person', personaRevision: 'synthetic-v1',
  responseKind: 'small_talk', status: 'answered', content: 'A fictional picnic sounds fun.', claims: [], evidence: [], limitations: [], grounding: 'unverified_model' };
function runtimeFixture(options: { failed?: boolean; offLeak?: boolean } = {}) {
  let trace: TurnTrace | undefined; const inputs: unknown[] = []; const history: string[] = []; const histories: string[][] = [];
  const createSession = jest.fn(async (_owner: string, _input: unknown) => ({ id: 'synthetic-session' }));
  const startTurn = jest.fn(async (_owner: string, input: { sessionId: string; text: string }) => {
    inputs.push(input); histories.push([...history]); history.push(input.text, reply.content);
    if (trace && options.offLeak) trace.retrievalCalls++;
    return { id: `synthetic-turn-${inputs.length}` };
  });
  const chat = { createSession, startTurn, getTurn: jest.fn(async () => options.failed
    ? { state: 'failed', errorCode: 'TURN_FAILED' } : { state: 'completed', reply }), cancelTurn: jest.fn() };
  const runtime = { chat, setTrace(value?: TurnTrace) { trace = value; } } as unknown as Pick<HarnessRuntime, 'chat' | 'setTrace'>;
  return { runtime, inputs, histories, createSession, startTurn };
}
test('only text/session/requestID cross the turn boundary, even if input has hidden evaluator fields', () => {
  const input = { id: 'synthetic', text: 'Natural user text', evaluator: { behavior: 'timeline', targets: ['hidden-secret'] }, timeline: { query: 'hidden query' } };
  const visible = naturalTurnInput('session', input);
  expect(Object.keys(visible).sort()).toEqual(['clientRequestId', 'sessionId', 'text']); expect(visible.text).toBe(input.text);
  expect(JSON.stringify(visible)).not.toMatch(/hidden|timeline|evaluator/);
});
test('all three natural turns share one real session without fixed/oracle history or forced intent', async () => {
  const f = runtimeFixture(); const rows: NaturalChatRow[] = [];
  await executeNaturalConversation(f.runtime, 'synthetic-owner', conversation, 'off', async row => { rows.push(row); });
  expect(f.createSession).toHaveBeenCalledTimes(1);
  expect(f.createSession.mock.calls[0]).toEqual(['synthetic-owner', expect.objectContaining({ ragCondition: 'off', retrievalMode: 'off', timezone: 'Asia/Seoul' })]);
  expect(f.inputs).toHaveLength(3); expect(f.histories.map(history => history.length)).toEqual([0, 2, 4]);
  for (const input of f.inputs) expect(Object.keys(input as object).sort()).toEqual(['clientRequestId', 'sessionId', 'text']);
  expect(rows.map(row => row.text)).toEqual(conversation.turns.map(turn => turn.text));
  expect(rows.every(row => row.trace.historyKind === 'evolving' && !row.trace.goldSourceIds.length)).toBe(true);
});
test('failed provider trial is persisted once and stops without retries or remaining follow-ups', async () => {
  const f = runtimeFixture({ failed: true }); const rows: NaturalChatRow[] = [];
  await expect(executeNaturalConversation(f.runtime, 'owner', conversation, 'caption', async row => { rows.push(row); })).rejects.toThrow('without automatic');
  expect(f.startTurn).toHaveBeenCalledTimes(1); expect(rows).toHaveLength(1); expect(rows[0]!.trace.errors).toContain('TURN_FAILED');
});
test('RAG off fails closed if retrieval isolation regresses', async () => {
  const f = runtimeFixture({ offLeak: true }); const rows: NaturalChatRow[] = [];
  await expect(executeNaturalConversation(f.runtime, 'owner', conversation, 'off', async row => { rows.push(row); })).rejects.toThrow();
  expect(rows[0]!.trace.errors).toContain('OFF_ISOLATION_FAILED'); expect(f.startTurn).toHaveBeenCalledTimes(1);
});
test('user export verification detects hidden metadata or changed texts instead of silently filtering them', () => {
  const item = { id: 'synthetic-case', personId: 'synthetic-person', personaId: 'synthetic-persona', personaRevision: 'synthetic-v1', category: 'casual',
    turns: [{ id: 'synthetic-turn', text: 'Hi!', evaluator: { behavior: 'social' } }] } as unknown as ChatCase;
  const testset = { version: 'natural-character-chat-testset-v1', revision: 'synthetic-revision', asOf: '2026-10-04', smokeIds: [item.id], conversations: [item] } as ChatTestset;
  const visible = userConversation(item); const value = { version: testset.version, revision: testset.revision, asOf: testset.asOf, smokeConversationIds: [visible.id], conversations: [visible] };
  expect(validateUserExport(testset, value)).toEqual([visible]);
  expect(() => validateUserExport(testset, { ...value, evaluator: 'hidden' })).toThrow('hidden');
  value.conversations[0]!.turns[0]!.text = 'Changed'; expect(() => validateUserExport(testset, value)).toThrow('changed');
});
test('operational summary separates invalid output from completion and never claims conversational accuracy', async () => {
  const f = runtimeFixture(); const rows: NaturalChatRow[] = [];
  await executeNaturalConversation(f.runtime, 'owner', conversation, 'off', async row => { rows.push(row); });
  rows[0]!.reply = { ...reply, status: 'insufficient_evidence', limitations: ['INVALID_MODEL_EVIDENCE'] };
  const summary = summarizeNaturalRows(rows);
  expect(summary.off).toMatchObject({ turns: 3, completed: 3, invalidModelEvidence: 1, statusCounts: { answered: 2, insufficient_evidence: 1 } });
  expect(JSON.stringify(summary)).not.toMatch(/accuracy|qualityScore/);
});

test('agent-loop evaluation pins profile only at session creation, never leaks it or gold into user turns',async()=>{
  const f=runtimeFixture();
  await executeNaturalConversation(f.runtime,'synthetic-owner',conversation,'off',async()=>{},0,'agent_loop');
  expect(f.createSession.mock.calls[0][1]).toMatchObject({executionProfile:'agent_loop'});
  for(const input of f.inputs)expect(Object.keys(input as object).sort()).toEqual(['clientRequestId','sessionId','text']);
});


test.each(['off', 'caption', 'caption_image'] as const)('forward natural evaluation pins agent-loop in %s', async condition => {
  const f = runtimeFixture();
  await executeNaturalConversation(f.runtime, 'synthetic-owner', conversation, condition, async () => {});
  expect(f.createSession.mock.calls[0][1]).toMatchObject({ executionProfile: 'agent_loop', ragCondition: condition });
  for (const input of f.inputs) expect(Object.keys(input as object).sort()).toEqual(['clientRequestId', 'sessionId', 'text']);
});

test('historical legacy evaluation requires an explicit profile, without altering old sessions', async () => {
  const f = runtimeFixture();
  await executeNaturalConversation(f.runtime, 'synthetic-owner', conversation, 'caption', async () => {}, 0, 'legacy');
  expect(f.createSession.mock.calls[0][1]).toMatchObject({ executionProfile: 'legacy', ragCondition: 'caption' });
});
