import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { testsetHash } from './prepare-character-chat-testset';
import { privateJson } from './prepare-research';

const id = z.string().min(1);
const answerability = z.enum(['answerable', 'partial', 'unanswerable', 'not_applicable']);
const referenceCase = z.object({
  conversationId: id, userTurnId: id, turnIndex: z.number().int().nonnegative(), personId: id, question: id,
  kind: z.enum(['factual', 'interpretive', 'creative']), oracleAnswerability: answerability,
  conditionAnswerability: z.object({ off: answerability, caption: answerability, caption_image: answerability }).strict(),
  sourceIds: z.array(id),
  requiredFacts: z.array(z.object({ id, text: id, provenance: z.enum(['caption', 'original_image', 'user_context']) }).strict()),
  forbiddenClaims: z.array(id), acceptableAlternatives: z.array(id), continuityCriteria: z.array(id),
  creativeCriteria: z.array(id), notes: z.array(id),
}).strict();
export const AnswerReferenceSchema = z.object({
  schemaVersion: z.literal('silver-answer-reference-v1'), humanReview: z.literal('pending'),
  referenceMethod: z.literal('source-first-posthoc-regression'), limitations: z.array(id), cases: z.array(referenceCase).min(1),
}).strict();
export type AnswerReference = z.infer<typeof AnswerReferenceSchema>;
const reviewRow = z.object({
  conversationId: id, userTurnId: id, condition: z.enum(['off', 'caption', 'caption_image']),
  answerHash: z.string().regex(/^[a-f0-9]{64}$/),
  coreVerdict: z.enum(['correct', 'partial', 'incorrect', 'unanswered', 'unverifiable', 'not_applicable']),
  requiredFactIdsCovered: z.array(id),
  disposition: z.enum(['substantive', 'abstained', 'clarification', 'operational_error', 'not_observed']),
  claims: z.array(z.object({
    text: id, material: z.boolean(), oracleSupport: z.enum(['supported', 'contradicted', 'not_established', 'interpretation']),
    offeredSupport: z.enum(['supported', 'contradicted', 'not_established', 'not_applicable']),
    sourceIds: z.array(id), reason: id,
  }).strict()),
  appropriateAbstention: z.boolean(), continuity: z.enum(['not_applicable', 'retained', 'partial', 'broken']),
  creative: z.enum(['not_applicable', 'met', 'partial', 'violated']),
  interpretive: z.enum(['not_applicable', 'met', 'partial', 'violated']),
  naturalness: z.enum(['natural', 'stilted', 'not_applicable']), reason: id,
}).strict();
export const AnswerReviewSchema = z.object({
  schemaVersion: z.literal('silver-answer-review-v1'), referenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/), humanReview: z.literal('pending'),
  reviewer: id, limitations: z.array(id), rows: z.array(reviewRow),
}).strict();
export type AnswerReview = z.infer<typeof AnswerReviewSchema>;
const observedRow = z.object({
  executionProfile: id, conversationId: id, userTurnId: id, turnIndex: z.number().int().nonnegative(),
  condition: z.enum(['off', 'caption', 'caption_image']), personId: id, text: id,
  trace: z.object({ state: id }).passthrough(),
  reply: z.object({ content: z.string(), limitations: z.array(z.string()),
    promptEvidence: z.object({ sourceIds: z.array(id), annotationIds: z.array(id) }).passthrough().optional(),
  }).passthrough().optional(),
}).passthrough();
export const answerHash = (content: string): string => createHash('sha256').update(content).digest('hex');
const caseKey = (row: { conversationId: string; userTurnId: string }) => JSON.stringify([row.conversationId, row.userTurnId]);
const rowKey = (row: { conversationId: string; userTurnId: string; condition: string }) => JSON.stringify([row.conversationId, row.userTurnId, row.condition]);
const conditions = ['off', 'caption', 'caption_image'] as const;
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }

/** Aggregates supplied silver judgements; this does NOT perform or validate semantic judging. */
export function regradeAnswers(referenceInput: unknown, reviewInput: unknown, reportInput: unknown) {
  const reference = AnswerReferenceSchema.parse(referenceInput), review = AnswerReviewSchema.parse(reviewInput);
  const report = z.object({ rows: z.array(observedRow) }).passthrough().parse(reportInput);
  assert(review.referenceHash === testsetHash(referenceInput), 'Reference fingerprint changed');
  assert(review.reportHash === testsetHash(reportInput), 'Archived report fingerprint changed');
  const refs = new Map(reference.cases.map(item => [caseKey(item), item]));
  assert(refs.size === reference.cases.length, 'Duplicate reference case');
  for (const item of reference.cases) assert(new Set(item.requiredFacts.map(f => f.id)).size === item.requiredFacts.length, 'Duplicate required fact');
  const rows = report.rows.filter(row => row.executionProfile === 'agent_loop');
  const observed = new Map(rows.map(row => [rowKey(row), row]));
  assert(rows.length === reference.cases.length * 3 && observed.size === rows.length, 'Incomplete or duplicate three-condition observations');
  const judged = new Map(review.rows.map(row => [rowKey(row), row]));
  assert(judged.size === review.rows.length && judged.size === observed.size, 'Incomplete or duplicate review coverage');
  const scored = reference.cases.flatMap(item => conditions.map(condition => {
    const key = rowKey({ ...item, condition }), row = observed.get(key), judgement = judged.get(key);
    assert(row && judgement, 'Missing case-condition pair');
    assert(row.personId === item.personId && row.turnIndex === item.turnIndex && row.text === item.question, 'Question/person binding changed');
    assert(judgement.answerHash === answerHash(row.reply?.content ?? ''), 'Archived answer changed');
    assert(new Set(judgement.requiredFactIdsCovered).size === judgement.requiredFactIdsCovered.length &&
      judgement.requiredFactIdsCovered.every(f => item.requiredFacts.some(required => required.id === f)), 'Unknown or duplicate covered fact');
    const factual = item.kind === 'factual';
    assert(factual ? judgement.coreVerdict !== 'not_applicable' : judgement.coreVerdict === 'not_applicable', 'Factual and rubric denominators must remain separate');
    assert(item.kind === 'creative' ? judgement.creative !== 'not_applicable' : judgement.creative === 'not_applicable', 'Creative rubric binding changed');
    assert(item.kind === 'interpretive' ? judgement.interpretive !== 'not_applicable' : judgement.interpretive === 'not_applicable', 'Interpretive rubric binding changed');
    const operationalError = row.trace.state !== 'completed' || !row.reply || row.reply.limitations.some(value=>['INVALID_MODEL_EVIDENCE','AGENT_TOOL_UNAVAILABLE'].includes(value));
    if (operationalError) {
      assert(['operational_error', 'not_observed'].includes(judgement.disposition), 'Operational fallback cannot be scored as an answered success');
      assert(!judgement.requiredFactIdsCovered.length && !judgement.claims.length && judgement.coreVerdict !== 'correct', 'Operational fallback has no accepted facts');
    } else assert(!['operational_error', 'not_observed'].includes(judgement.disposition), 'Completed substantive observation cannot be hidden as missing');
    if (judgement.coreVerdict === 'correct') {
      assert(!operationalError, 'Failed answer cannot be correct');
      assert(judgement.requiredFactIdsCovered.length === item.requiredFacts.length, 'Correct answer omitted required facts');
      assert(item.oracleAnswerability !== 'answerable' || judgement.disposition === 'substantive', 'Abstention is not a correct answer to an answerable question');
    }
    if (judgement.appropriateAbstention) assert(!operationalError && ['abstained', 'clarification'].includes(judgement.disposition) &&
      item.conditionAnswerability[condition] !== 'answerable', 'Unsupported appropriate-abstention label');
    if (condition === 'off') assert(judgement.claims.every(c => c.offeredSupport === 'not_applicable'), 'Off context grounding must be N/A');
    for (const claim of judgement.claims) if (claim.offeredSupport === 'supported' && claim.sourceIds.length)
      assert(claim.sourceIds.every(source => row.reply?.promptEvidence?.sourceIds.includes(source)), 'Claim cites a source not offered to the model');
    const material = judgement.claims.filter(c => c.material);
    const unsupported = material.filter(c => ['contradicted', 'not_established'].includes(c.oracleSupport));
    const factualCorrect = factual && judgement.coreVerdict === 'correct';
    return { conversationId: item.conversationId, userTurnId: item.userTurnId, condition, kind: item.kind,
      observedState: row.trace.state, operationalError, oracleAnswerability: item.oracleAnswerability,
      evidenceAnswerability: item.conditionAnswerability[condition], coreVerdict: judgement.coreVerdict,
      requiredFactCount: item.requiredFacts.length, coveredFactCount: judgement.requiredFactIdsCovered.length,
      cleanAnswerPass: factual ? factualCorrect && unsupported.length === 0 : null,
      materialClaimCount: material.length, unsupportedMaterialClaims: unsupported.length,
      contradictedMaterialClaims: material.filter(c => c.oracleSupport === 'contradicted').length,
      notEstablishedMaterialClaims: material.filter(c => c.oracleSupport === 'not_established').length,
      offeredSupportedClaims: material.filter(c => c.offeredSupport === 'supported').length,
      offeredEvaluableClaims: material.filter(c => c.offeredSupport !== 'not_applicable').length,
      disposition: judgement.disposition, appropriateAbstention: judgement.appropriateAbstention,
      continuity: judgement.continuity, creative: judgement.creative, interpretive: judgement.interpretive, naturalness: judgement.naturalness };
  }));
  const summary = Object.fromEntries(conditions.map(condition => {
    const group = scored.filter(row => row.condition === condition), facts = group.filter(row => row.kind === 'factual');
    const material = group.reduce((n, row) => n + row.materialClaimCount, 0);
    const unsupported = group.reduce((n, row) => n + row.unsupportedMaterialClaims, 0);
    const offered = group.reduce((n, row) => n + row.offeredEvaluableClaims, 0);
    return [condition, { planned: group.length, completed: group.filter(r => r.observedState === 'completed').length,
      operationalErrors: group.filter(r => r.operationalError).length, factualQuestions: facts.length,
      factualVerdicts: Object.fromEntries(['correct', 'partial', 'incorrect', 'unanswered', 'unverifiable'].map(v => [v, facts.filter(r => r.coreVerdict === v).length])),
      cleanFactualAnswers: facts.filter(r => r.cleanAnswerPass).length,
      requiredFacts: facts.reduce((n, r) => n + r.requiredFactCount, 0), coveredFacts: facts.reduce((n, r) => n + r.coveredFactCount, 0),
      materialClaims: material, unsupportedMaterialClaims: unsupported, unsupportedClaimFraction: material ? unsupported / material : null,
      turnsWithUnsupportedMaterialClaims: group.filter(r => r.unsupportedMaterialClaims > 0).length,
      offeredContextFaithfulness: offered ? group.reduce((n, r) => n + r.offeredSupportedClaims, 0) / offered : null,
      appropriateAbstentions: group.filter(r => r.appropriateAbstention).length,
      dispositions: Object.fromEntries(['substantive', 'abstained', 'clarification', 'operational_error', 'not_observed'].map(v => [v, group.filter(r => r.disposition === v).length])),
      continuity: Object.fromEntries(['retained', 'partial', 'broken', 'not_applicable'].map(v => [v, group.filter(r => r.continuity === v).length])),
      creative: Object.fromEntries(['met', 'partial', 'violated', 'not_applicable'].map(v => [v, group.filter(r => r.creative === v).length])),
      interpretive: Object.fromEntries(['met', 'partial', 'violated', 'not_applicable'].map(v => [v, group.filter(r => r.interpretive === v).length])),
      naturalness: Object.fromEntries(['natural', 'stilted', 'not_applicable'].map(v => [v, group.filter(r => r.naturalness === v).length])),
    }];
  }));
  return { schemaVersion: 'silver-three-condition-regrading-v1', executionProfile: 'agent_loop', humanReview: 'pending',
    referenceHash: review.referenceHash, reportHash: review.reportHash, reviewHash: testsetHash(reviewInput), planned: scored.length,
    summary, rows: scored, limitations: [...reference.limitations, ...review.limitations,
      'Post-hoc regrading of previously seen development answers, not unseen human-gold accuracy.',
      'Aggregate validation checks coverage, hashes and rubric consistency, NOT semantic judgement correctness.',
      'No new chatbot/provider calls; offline Codex assessment usage is separately accounted.'] };
}
async function main(args: string[]) {
  if (args.length !== 4 || args[0] !== '--offline') throw new Error('Explicit --offline reference review archived-report paths required');
  if (args.slice(1).some(path => !path.startsWith('reports/') || path.includes('..'))) throw new Error('Private reports paths only');
  const [reference, review, report] = await Promise.all(args.slice(1).map(async path => JSON.parse(await readFile(path, 'utf8')) as unknown));
  const result = regradeAnswers(reference, review, report);
  const output = 'reports/answer-regrading/summary.private.json';
  await privateJson(output, result);
  console.log(JSON.stringify({ output, planned: result.planned, summary: result.summary }));
}
if (require.main === module) void main(process.argv.slice(2)).catch(() => {
  console.error('Offline regrading stopped: preserve private inputs; no provider calls or automatic repair.'); process.exitCode = 1;
});
