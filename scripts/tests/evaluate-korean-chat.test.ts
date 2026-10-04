import type { Persona } from '@ptr/contracts';
import type { UserConversation } from '../evaluate-character-chat';
import { KOREAN_LIMITS, prepareKoreanStudy, validateKoreanBudget } from '../evaluate-korean-chat';
import { testsetHash } from '../prepare-character-chat-testset';
function fixture() {
  const personas: Persona[] = [0, 1, 2, 3].map(i => ({ id: `synthetic-persona-${i}`, personId: `synthetic-person-${i}`, revision: 'synthetic-v1',
    label: 'Synthetic', language: i < 2 ? 'ko' : 'en', reviewStatus: 'synthetic', identity: 'Fictional research persona', concept: 'Creative conversation',
    style: [i < 2 ? 'Use natural Korean.' : 'Use natural English.', 'Prefer concise responses.'], boundaries: ['No biography invention.'], greeting: 'Synthetic greeting', sourceRefs: [] }));
  const memories: UserConversation[] = personas.map(p => ({ id: `case-${p.personId}`, personId: p.personId, personaId: p.id, personaRevision: p.revision,
    turns: [0, 1, 2].map(i => ({ id: `${p.personId}:${i}`, text: p.language === 'ko' ? `합성 질문 ${i}` : `Synthetic question ${i}` })) }));
  const seed = { translations: Object.fromEntries(memories.slice(2).flatMap(c => c.turns.map(t => [t.id, '한국어로 번역한 합성 질문']))),
    styleProbe: ['오늘 간단한 기분 전환을 추천해줘.', '더 간단하게 하고 싶어.', '5분만 쓸 수 있어.'], styleRubricHash: 'a'.repeat(64) };
  return { personas, memories, seed };
}
test('study fixes agent-loop and Korean for72slots without changing original personality or IDs', () => {
  const f = fixture(), before = testsetHash(f.personas), result = prepareKoreanStudy(f.personas, f.memories, f.seed);
  expect(result.executionProfile).toBe('agent_loop'); expect(result.conversations).toHaveLength(8);
  expect(result.conversations.reduce((n, c) => n + c.turns.length * 3, 0)).toBe(KOREAN_LIMITS.turns);
  expect(result.personas.every(p => p.language === 'ko')).toBe(true); expect(testsetHash(f.personas)).toBe(before);
  expect(result.personas[0]).toEqual(f.personas[0]); expect(result.personas[2]!.id).not.toBe(f.personas[2]!.id);
  expect(result.personas[2]!.identity).toBe(f.personas[2]!.identity); expect(result.personas[2]!.boundaries).toEqual(f.personas[2]!.boundaries);
  expect(result.personas[2]!.style).toEqual(['Use natural Korean.', 'Prefer concise responses.']);
});
test('question export stays user-only and identical style probe is used for all4', () => {
  const f = fixture(), result = prepareKoreanStudy(f.personas, f.memories, f.seed);
  for (const c of result.conversations) for (const t of c.turns) expect(Object.keys(t).sort()).toEqual(['id', 'text']);
  for (const c of result.conversations.filter(c => c.id.startsWith('ko-style:'))) expect(c.turns.map(t => t.text)).toEqual(f.seed.styleProbe);
});
test('missing, extra or English translations fail rather than silently changing the study', () => {
  const f = fixture(); delete f.seed.translations[Object.keys(f.seed.translations)[0]!]; expect(() => prepareKoreanStudy(f.personas, f.memories, f.seed)).toThrow('coverage');
  const g = fixture(); g.seed.translations.extra = '추가 번역'; expect(() => prepareKoreanStudy(g.personas, g.memories, g.seed)).toThrow('coverage');
  const h = fixture(); h.seed.styleProbe[0] = 'English only'; expect(() => prepareKoreanStudy(h.personas, h.memories, h.seed)).toThrow();
});
test('persona or memory binding mismatch is rejected before generation', () => {
  const f = fixture(); f.memories[0]!.personaId = 'wrong'; expect(() => prepareKoreanStudy(f.personas, f.memories, f.seed)).toThrow('binding');
});
test('Korean pilot requires90existing slots, not a budget reset or guaranteed completion', () => {
  const budget = { cap_microusd: '1000000', call_cap: 1000, calls: 898, actual_microusd: '274453', unresolved_microusd: '7625' };
  expect(() => validateKoreanBudget(budget)).not.toThrow();
  for (const patch of [{ calls: 911 }, { call_cap: 1001 }, { cap_microusd: '1000001' }, { unresolved_microusd: 'NaN' }, { calls: -1 }, { actual_microusd: '1000000' }])
    expect(() => validateKoreanBudget({ ...budget, ...patch })).toThrow();
  expect(KOREAN_LIMITS.freshRequests).toBeLessThan(102);
});
