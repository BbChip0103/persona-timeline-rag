import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderError, type BudgetLedger, type BudgetRequest } from '@ptr/providers';
import type { TurnTrace } from '../evaluate';
import { PILOT_LIMITS, PilotLedger, loadPilotCases, selectMemoryPilot, validatePilotArguments, validatePilotBudget } from '../evaluate-memory-context';
import { userConversation, type ChatCase, type ChatTestset } from '../prepare-character-chat-testset';

const bindings = [['synthetic-person-a', 'caption_memory'], ['synthetic-person-b', 'image_memory'], ['synthetic-person-c', 'creative_preference'], ['synthetic-person-d', 'mixed_memory']] as const;
function fixture() {
  const conversations = bindings.map(([personId, category], index) => ({ id: `synthetic-${index}`, personId, category, personaId: `synthetic-persona-${index}`, personaRevision: 'synthetic-v1',
    turns: [0, 1, 2].map(turn => ({ id: `synthetic-${index}-${turn}`, text: `Synthetic natural turn ${turn}`, evaluator: { hidden: 'never exposed' } })) })) as unknown as ChatCase[];
  const testset = { conversations, smokeIds: conversations.map(item => item.id) } as ChatTestset;
  return { testset, users: conversations.map(userConversation) };
}
const budget = { cap_microusd: 1_000_000, call_cap: 1000, calls: 940, actual_microusd: '208327', unresolved_microusd: '7625' };
test('pilot selects exactly four frozen user-only three-turn conversations without evaluator metadata', () => {
  const f = fixture(), result = selectMemoryPilot(f.testset, f.users, bindings);
  expect(result).toHaveLength(4); expect(result.map(item => item.personId)).toEqual(bindings.map(item => item[0]));
  expect(result.flatMap(item => item.turns)).toHaveLength(12); expect(JSON.stringify(result)).not.toMatch(/evaluator|hidden|category/);
  expect(PILOT_LIMITS).toEqual({ turns: 36, textCalls: 36, embeddingCalls: 24, freshRequests: 60 });
});
test('pilot fails closed on changed text, missing cases or non-frozen selection', () => {
  const f = fixture(); f.users[0]!.turns[0]!.text = 'Changed'; expect(() => selectMemoryPilot(f.testset, f.users, bindings)).toThrow('mismatch');
  const g = fixture(); g.testset.smokeIds.pop(); expect(() => selectMemoryPilot(g.testset, g.users, bindings)).toThrow('missing');
  const h = fixture(); h.testset.conversations.push(h.testset.conversations[0]!); expect(() => selectMemoryPilot(h.testset, h.users, bindings)).toThrow('duplicated');
});
test('live pilot requires explicit opt-ins and preserves the original model', () => {
  const env = { GOAL1_LIVE_ENABLED: 'true', GOAL1_ALLOW_EXTERNAL_DATA: 'true', GOAL1_TEXT_MODEL: 'google/gemini-3-flash-preview' };
  expect(() => validatePilotArguments(['--live'], env)).not.toThrow();
  for (const args of [[], ['--live', '--live'], ['--smoke'], ['--live', '--retry']]) expect(() => validatePilotArguments(args, env)).toThrow();
  expect(() => validatePilotArguments(['--live'], { ...env, GOAL1_LIVE_ENABLED: 'false' })).toThrow();
  expect(() => validatePilotArguments(['--live'], { ...env, GOAL1_ALLOW_EXTERNAL_DATA: 'false' })).toThrow();
  expect(() => validatePilotArguments(['--live'], { ...env, GOAL1_TEXT_MODEL: 'other-model' })).toThrow('baseline');
});
test('existing global budget needs all 60 slots within the $2 / 10000-call ceilings', () => {
  expect(() => validatePilotBudget(budget)).not.toThrow();
  expect(() => validatePilotBudget({ ...budget, cap_microusd: 2_000_000, call_cap: 10_000 })).not.toThrow();
  for (const change of [{ calls: 941 }, { call_cap: 10_001 }, { cap_microusd: 2_000_001 }, { actual_microusd: 1_000_000 }, { unresolved_microusd: 'NaN' }, { calls: -1 }])
    expect(() => validatePilotBudget({ ...budget, ...change })).toThrow();
});
function ledgerFixture() {
  const requests = new Map<string, BudgetRequest>();
  const ledger: BudgetLedger = {
    reserve: jest.fn(async (key: string, amount: number) => { const old = requests.get(key); if (old) return { created: false, request: old };
      const request: BudgetRequest = { key, state: 'reserved', reservedMicrousd: amount, actualMicrousd: null, response: null, generationId: null }; requests.set(key, request); return { created: true, request }; }),
    submitted: jest.fn(async (key: string) => { requests.get(key)!.state = 'submitted'; }),
    finish: jest.fn(async (key: string, cost: number | null) => { const r = requests.get(key)!; r.actualMicrousd = cost; r.state = cost === null ? 'unknown' : 'settled'; }),
    get: jest.fn(async (key: string) => requests.get(key)),
  };
  const trace = { requests: [] } as unknown as TurnTrace;
  return { ledger, trace, pilot: new PilotLedger(ledger, () => trace, () => 'text') };
}
test('provider trace separates cached replay from new submitted settled requests', async () => {
  const f = ledgerFixture(); await f.pilot.reserve('synthetic-key', 10); await f.pilot.submitted('synthetic-key'); await f.pilot.finish('synthetic-key', 3, {}, 'synthetic-generation');
  await f.pilot.reserve('synthetic-key', 10);
  expect(f.trace.requests).toEqual([
    expect.objectContaining({ created: true, submitted: true, actualMicrousd: 3, state: 'settled' }),
    expect.objectContaining({ created: false, submitted: false, actualMicrousd: 3, state: 'settled' }),
  ]);
});
test('fresh request cap stops before underlying reservation and never retries or resets the ledger', async () => {
  const f = ledgerFixture();
  for (let index = 0; index < 60; index++) await f.pilot.reserve(`synthetic-${index}`, 1);
  await expect(f.pilot.reserve('synthetic-extra', 1)).rejects.toThrow('PILOT_REQUEST_LIMIT');
  expect(f.ledger.reserve).toHaveBeenCalledTimes(60);
});


test('fresh cap still permits settled cached replay while refusing fresh keys',async()=>{
  const f=ledgerFixture();for(let i=0;i<60;i++)await f.pilot.reserve(`synthetic-${i}`,1);
  await expect(f.pilot.reserve('synthetic-0',1)).resolves.toMatchObject({created:false});
  await expect(f.pilot.reserve('synthetic-new',1)).rejects.toThrow('PILOT_REQUEST_LIMIT');
});


test('global reservation rejection sets sticky stop even below current budget cap',async()=>{
  const f=ledgerFixture();jest.mocked(f.ledger.reserve).mockRejectedValueOnce(new ProviderError('BUDGET_EXCEEDED'));
  await expect(f.pilot.reserve('synthetic',900000)).rejects.toThrow('BUDGET_EXCEEDED');
  expect(f.pilot.stoppedReason()).toBe('BUDGET_EXCEEDED');
});

function targetsFile(content: string): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'ptr-targets-')), path = join(directory, 'targets.json'); writeFileSync(path, content);
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}
test('pilot targets are read at runtime from the private file named by PTR_EVAL_TARGETS_FILE in order', () => {
  const file = targetsFile(JSON.stringify(bindings));
  try { expect(loadPilotCases({ PTR_EVAL_TARGETS_FILE: file.path })).toEqual(bindings.map(item => [...item])); } finally { file.cleanup(); }
});
test('pilot targets fail clearly when the source is unset, missing or malformed', () => {
  expect(() => loadPilotCases({})).toThrow('PTR_EVAL_TARGETS_FILE');
  expect(() => loadPilotCases({ PTR_EVAL_TARGETS_FILE: join(tmpdir(), 'ptr-targets-does-not-exist.json') })).toThrow('PTR_EVAL_TARGETS_FILE');
  for (const content of ['not json', '{}', '[]', JSON.stringify(bindings.slice(0, 3)), JSON.stringify([...bindings.slice(0, 3), ['synthetic-person-d']])]) {
    const file = targetsFile(content);
    try { expect(() => loadPilotCases({ PTR_EVAL_TARGETS_FILE: file.path })).toThrow('PTR_EVAL_TARGETS_FILE'); } finally { file.cleanup(); }
  }
});
