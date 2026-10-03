import type { Persona, SourcePost } from '@ptr/contracts';
import type { AnnotationPlan } from '../import-image-annotations';
import { CHAT_CATEGORIES, prepareChatTestset, testsetHash, userConversation, type ChatSeed } from '../prepare-character-chat-testset';

function fixture() {
  const personas: Persona[] = []; const sources: SourcePost[] = []; const split: Record<string, string> = {};
  const plan: AnnotationPlan = { annotations: [], inputs: [], skippedUnsafe: 0, skippedOversize: 0 };
  const conversations: ChatSeed['conversations'] = [];
  for (let i = 0; i < 4; i++) {
    const personId = `synthetic-person-${i}`;
    const persona: Persona = { id: `synthetic-persona-${i}`, personId, label: 'Synthetic', language: 'en', revision: 'synthetic-v1', reviewStatus: 'synthetic',
      identity: 'Fictional', concept: 'Synthetic test', style: [], boundaries: [], sourceRefs: [], greeting: 'Hello' };
    personas.push(persona);
    const source: SourcePost = { id: `synthetic-source-${i}`, personId, caption: 'A synthetic public memory.', postedAt: '2020-01-01T00:00:00Z', eventDate: null,
      sourceUrl: 'https://example.invalid/synthetic', hash: `source-hash-${i}`, snapshot: 'synthetic', unsafe: false };
    sources.push(source); split[source.id] = 'test';
    plan.annotations.push({ id: `synthetic-annotation-${i}`, sourceId: source.id, personId, sourceHash: source.hash, imagePosition: 0, imageHash: 'a'.repeat(64),
      annotationHash: 'b'.repeat(64), revision: 'synthetic-v5', text: 'Visual description: A synthetic red shape.\nTentative interpretation: An abstract color study.', model: 'synthetic', humanReviewed: false });
    for (const category of CHAT_CATEGORIES) conversations.push({ id: `chat-${personId}-${category}`, personId, category,
      turns: Array.from({ length: 3 }, (_, index) => ({ text: index ? 'What about that?' : 'Hi, how about a little chat?', behavior: 'social' as const,
        contextFrom: Array.from({ length: index }, (_, previous) => previous), targets: [], supportedClaims:[],unsupportedClaims:['No invented biography.'],acceptableAlternatives:['Natural paraphrases.'],requireNewVisualContribution:false,checks: ['Be conversational.', 'Do not invent private facts.'] })) });
  }
  const smokeIds = CHAT_CATEGORIES.map((category, i) => `chat-synthetic-person-${Math.floor(i / 2)}-${category}`);
  const seed: ChatSeed = { version: 'natural-character-chat-seed-v1', asOf: '2026-10-04', smokeIds, conversations };
  const build = () => prepareChatTestset(seed, personas, sources, plan, split, { synthetic: 'fixture-hash' });
  return { seed, personas, sources, split, plan, build };
}

test('freezes balanced32 dialogues/96 turns and broad24-turn smoke deterministically', () => {
  const f = fixture(); const a = f.build(); const b = f.build();
  expect(a.revision).toBe(b.revision); expect(a.conversations).toHaveLength(32);
  expect(a.conversations.flatMap(item => item.turns)).toHaveLength(96); expect(a.reviewStatus).toBe('draft_silver');
  expect(a.smokeIds).toHaveLength(8); expect(a.limitations.join(' ')).toContain('not a blind');
  f.seed.conversations[0]!.turns[0]!.text += ' Changed.'; expect(f.build().revision).not.toBe(a.revision);
});
test('strict seed refuses hidden query/date hints and future context references', () => {
  const f = fixture(); const row = f.seed.conversations[0]!.turns[0]!;
  (row as unknown as Record<string, unknown>).timeline = { query: 'hidden answer', start: '2020-01-01' };
  expect(() => f.build()).toThrow(); delete (row as unknown as Record<string, unknown>).timeline;
  row.text = 'Explain the post from 2020-01-01 UTC.'; expect(() => f.build()).toThrow('Machine-like'); row.text = 'Natural chat';
  row.contextFrom = [0]; expect(() => f.build()).toThrow('dependency'); row.contextFrom = [];
});
test('caption and image gold preserve source/annotation provenance without user leakage', () => {
  const f = fixture(); const row = f.seed.conversations[0]!.turns[0]!;
  row.behavior = 'grounded_both'; row.supportedClaims=['Synthetic scene']; row.targets = [{ sourceId: f.sources[0]!.id }, { sourceId: f.sources[0]!.id, imagePosition: 0, imageKind: 'observation' }];
  const built = f.build(); const conversation = built.conversations[0]!;
  expect(conversation.turns[0]!.evaluator.targets.map(item => item.kind)).toEqual(['caption_statement', 'ai_visual_observation']);
  expect(conversation.turns[0]!.evaluator.targets[1]).toMatchObject({ annotationId: f.plan.annotations[0]!.id, annotationHash: 'b'.repeat(64), sourceHash: f.sources[0]!.hash, humanReviewed: false });
  const visible = userConversation(conversation); const json = JSON.stringify(visible);
  for (const hidden of ['evaluator', 'targets', 'checks', 'behavior', 'sourceId', 'annotationId', 'retrievalExpectation', 'source-hash', 'synthetic red shape']) expect(json).not.toContain(hidden);
  expect(visible.turns[0]).toEqual({ id: expect.stringMatching(/^turn-[a-f0-9]{16}$/), text: row.text });
  expect(visible.id).toMatch(/^scenario-[a-f0-9]{16}$/);expect(json).not.toContain('casual');
  expect(conversation.turns[0]!.evaluator.retrievalExpectation).toBe('memory_required_context_reuse_allowed');
});
test('rejects unsafe, cross-person, non-test and conflicting annotation provenance', () => {
  const f = fixture(); const row = f.seed.conversations[0]!.turns[0]!; row.behavior = 'grounded_caption'; row.targets = [{ sourceId: f.sources[0]!.id }];
  f.sources[0]!.unsafe = true; expect(() => f.build()).toThrow('unsafe'); f.sources[0]!.unsafe = false;
  row.targets[0]!.sourceId = f.sources[1]!.id; expect(() => f.build()).toThrow('cross-person'); row.targets[0]!.sourceId = f.sources[0]!.id;
  f.split[f.sources[0]!.id] = 'dev'; expect(() => f.build()).toThrow('held out'); f.split[f.sources[0]!.id] = 'test';
  row.behavior = 'grounded_image'; row.targets = [{ sourceId: f.sources[0]!.id, imagePosition: 0, imageKind: 'observation' }];
  f.plan.annotations[0]!.sourceHash = 'wrong'; expect(() => f.build()).toThrow('provenance');
});
test('requires actual recorded support and disallows fabricated interpretation or forged caption quotes', () => {
  const f = fixture(); const row = f.seed.conversations[0]!.turns[0]!;
  row.behavior = 'grounded_image'; expect(() => f.build()).toThrow('support missing');
  row.behavior = 'interpretation'; row.supportedClaims=['Synthetic interpretation']; row.targets = [{ sourceId: f.sources[0]!.id, imagePosition: 0, imageKind: 'interpretation' },{ sourceId: f.sources[0]!.id,imagePosition:0,imageKind:'observation'}];
  expect(f.build().conversations[0]!.turns[0]!.evaluator.targets[0]!.kind).toBe('ai_intent_interpretation');
  f.plan.annotations[0]!.text = 'Visual description: A synthetic red shape.'; expect(() => f.build()).toThrow('No recorded');
  row.behavior = 'grounded_caption'; row.targets = [{ sourceId: f.sources[0]!.id, captionQuote: 'Not in source' }]; expect(() => f.build()).toThrow('exact unique');
  row.targets = [{ sourceId: f.sources[0]!.id, captionQuote: 'synthetic' }]; f.sources[0]!.caption = 'synthetic synthetic'; expect(() => f.build()).toThrow('exact unique');
});
test('refuses forced retrieval for ordinary chat and unbalanced/unknown smoke selection', () => {
  const f = fixture(); f.seed.conversations[0]!.turns[0]!.targets = [{ sourceId: f.sources[0]!.id }]; expect(() => f.build()).toThrow('force a source');
  f.seed.conversations[0]!.turns[0]!.targets = []; f.seed.smokeIds[0] = 'missing'; expect(() => f.build()).toThrow('Smoke');
  f.seed.smokeIds[0] = f.seed.smokeIds[1]!; expect(() => f.build()).toThrow('Duplicate');
});
test('stable revision does not depend on object key ordering', () => {
  expect(testsetHash({ b: 2, a: [{ z: 1, y: 2 }] })).toBe(testsetHash({ a: [{ y: 2, z: 1 }], b: 2 }));
});
