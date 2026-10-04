import { answerHash, regradeAnswers, type AnswerReference, type AnswerReview } from '../regrade-character-answers';
import { testsetHash } from '../prepare-character-chat-testset';

function fixture() {
  const reference: AnswerReference = { schemaVersion: 'silver-answer-reference-v1', humanReview: 'pending',
    referenceMethod: 'source-first-posthoc-regression', limitations: ['Synthetic, not human gold.'], cases: [{
      conversationId: 'synthetic-conversation', userTurnId: 'synthetic-turn', turnIndex: 0, personId: 'synthetic-person', question: 'Which object was made?',
      kind: 'factual', oracleAnswerability: 'answerable', conditionAnswerability: { off: 'unanswerable', caption: 'answerable', caption_image: 'answerable' },
      sourceIds: ['synthetic-post'], requiredFacts: [{ id: 'object', text: 'A toy bird.', provenance: 'caption' }],
      forbiddenClaims: ['A toy sheep.'], acceptableAlternatives: ['Equivalent wording.'], continuityCriteria: [], creativeCriteria: [], notes: [],
    }] };
  const report = { rows: (['off', 'caption', 'caption_image'] as const).map(condition => ({ executionProfile: 'agent_loop',
    conversationId: 'synthetic-conversation', userTurnId: 'synthetic-turn', turnIndex: 0, personId: 'synthetic-person', condition,
    text: 'Which object was made?', trace: { state: 'completed' }, reply: { content: condition === 'off' ? 'I cannot tell.' : 'A toy bird.', limitations: [] as string[],
      promptEvidence: { sourceIds: condition === 'off' ? [] : ['synthetic-post'], annotationIds: [] } },
  })) };
  const review: AnswerReview = { schemaVersion: 'silver-answer-review-v1', referenceHash: testsetHash(reference), reportHash: testsetHash(report),
    reviewer: 'synthetic reviewer', humanReview: 'pending', limitations: ['Synthetic rubric only.'], rows: report.rows.map(row => ({
      conversationId: row.conversationId, userTurnId: row.userTurnId, condition: row.condition, answerHash: answerHash(row.reply.content),
      coreVerdict: row.condition === 'off' ? 'unanswered' : 'correct', requiredFactIdsCovered: row.condition === 'off' ? [] : ['object'],
      disposition: row.condition === 'off' ? 'abstained' : 'substantive', claims: row.condition === 'off' ? [] : [{ text: 'A toy bird.', material: true,
        oracleSupport: 'supported', offeredSupport: 'supported', sourceIds: ['synthetic-post'], reason: 'Synthetic caption.' }],
      appropriateAbstention: row.condition === 'off', continuity: 'not_applicable', creative: 'not_applicable', interpretive: 'not_applicable', naturalness: 'natural', reason: 'Synthetic assessment.',
    })) };
  return { reference, report, review };
}
test('same factual denominator separates abstention, correctness and no-context grounding', () => {
  const f = fixture(), result = regradeAnswers(f.reference, f.review, f.report);
  expect(result.planned).toBe(3);
  expect(result.summary.off).toMatchObject({ factualQuestions: 1, factualVerdicts: { unanswered: 1 }, cleanFactualAnswers: 0, appropriateAbstentions: 1, offeredContextFaithfulness: null });
  expect(result.summary.caption).toMatchObject({ factualQuestions: 1, cleanFactualAnswers: 1, offeredContextFaithfulness: 1 });
});
test('a correct core answer with an invented extra is not a clean answer', () => {
  const f = fixture(); f.review.rows[1]!.claims.push({ text: 'At midnight.', material: true, oracleSupport: 'not_established',
    offeredSupport: 'not_established', sourceIds: [], reason: 'No recorded time.' });
  const result = regradeAnswers(f.reference, f.review, f.report);
  expect(result.summary.caption).toMatchObject({ cleanFactualAnswers: 0, unsupportedMaterialClaims: 1, turnsWithUnsupportedMaterialClaims: 1 });
});
test('coverage is complete and unique instead of dropping bad observations', () => {
  for (const edit of [(f: ReturnType<typeof fixture>) => f.review.rows.pop(),
    (f: ReturnType<typeof fixture>) => f.review.rows.push(f.review.rows[0]!),
    (f: ReturnType<typeof fixture>) => f.report.rows.pop()]) {
    const f = fixture(); edit(f); f.review.reportHash = testsetHash(f.report);
    expect(() => regradeAnswers(f.reference, f.review, f.report)).toThrow(/coverage|observations/);
  }
});
test('frozen reference, report, answer and person bindings reject drift', () => {
  const f = fixture(); f.reference.cases[0]!.question = 'Changed'; expect(() => regradeAnswers(f.reference, f.review, f.report)).toThrow('fingerprint');
  const g = fixture(); g.report.rows[0]!.reply.content = 'Changed'; g.review.reportHash = testsetHash(g.report);
  expect(() => regradeAnswers(g.reference, g.review, g.report)).toThrow('answer changed');
  const h = fixture(); h.report.rows[0]!.personId = 'wrong-person'; h.review.reportHash = testsetHash(h.report);
  expect(() => regradeAnswers(h.reference, h.review, h.report)).toThrow('binding');
});
test('quote fallback is counted as operational error, never correct or appropriate abstention', () => {
  const f = fixture(); f.report.rows[1]!.reply.limitations = ['INVALID_MODEL_EVIDENCE']; f.review.reportHash = testsetHash(f.report);
  expect(() => regradeAnswers(f.reference, f.review, f.report)).toThrow('fallback');
  Object.assign(f.review.rows[1]!, { coreVerdict: 'unanswered', disposition: 'operational_error', requiredFactIdsCovered: [], claims: [], appropriateAbstention: false });
  expect(regradeAnswers(f.reference, f.review, f.report).summary.caption).toMatchObject({ planned: 1, operationalErrors: 1, cleanFactualAnswers: 0 });
});
test('creative output is not mixed into factual denominators', () => {
  const f = fixture(); Object.assign(f.reference.cases[0]!, { kind: 'creative', requiredFacts: [], oracleAnswerability: 'not_applicable' });
  f.reference.cases[0]!.conditionAnswerability = { off: 'not_applicable', caption: 'not_applicable', caption_image: 'not_applicable' };
  f.review.referenceHash = testsetHash(f.reference);
  for (const row of f.review.rows) Object.assign(row, { coreVerdict: 'not_applicable', creative: 'met', disposition: 'substantive', appropriateAbstention: false, requiredFactIdsCovered: [], claims: [] });
  expect(regradeAnswers(f.reference, f.review, f.report).summary.off).toMatchObject({ factualQuestions: 0, cleanFactualAnswers: 0, creative: { met: 1 }, offeredContextFaithfulness: null });
});
test('unknown required facts and false success-by-abstention fail closed', () => {
  const f = fixture(); f.review.rows[1]!.requiredFactIdsCovered = ['unknown']; expect(() => regradeAnswers(f.reference, f.review, f.report)).toThrow('covered fact');
  const g = fixture(); g.review.rows[1]!.disposition = 'abstained'; expect(() => regradeAnswers(g.reference, g.review, g.report)).toThrow('Abstention');
});

test('interpretive answers use a separate rubric, not fabricated factual truth scores', () => {
  const f = fixture(); f.reference.cases[0]!.kind = 'interpretive'; f.review.referenceHash = testsetHash(f.reference);
  for (const row of f.review.rows) Object.assign(row, { coreVerdict: 'not_applicable', interpretive: 'met' });
  expect(regradeAnswers(f.reference, f.review, f.report).summary.caption).toMatchObject({ factualQuestions: 0, interpretive: { met: 1 } });
});

test('a true reference fact is not automatically supported by unoffered sources', () => {
  const f = fixture(); f.review.rows[1]!.claims[0]!.sourceIds = ['unoffered-source'];
  expect(() => regradeAnswers(f.reference, f.review, f.report)).toThrow('not offered');
});


test('unavailable tool service notice is operational, not a correct fact or appropriate memory abstention',()=>{
  const f=fixture();f.report.rows[0]!.reply.limitations=['AGENT_TOOL_UNAVAILABLE'];f.review.reportHash=testsetHash(f.report);
  expect(()=>regradeAnswers(f.reference,f.review,f.report)).toThrow('fallback');
  Object.assign(f.review.rows[0]!,{disposition:'operational_error',appropriateAbstention:false});
  expect(regradeAnswers(f.reference,f.review,f.report).summary.off).toMatchObject({operationalErrors:1,appropriateAbstentions:0,cleanFactualAnswers:0});
});
