import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Evaluator, ExperimentTask } from '../packages/ops/src/langfuse';
import { z } from 'zod';
import { createLangfuseClient, FrameworkTelemetry, redactTelemetry, type FrameworkTelemetryConfig } from '../packages/ops/src/langfuse';

const historicScore = z.object({ name: z.string().min(1).max(35), value: z.union([z.number().finite(), z.string()]), comment: z.string().optional(), reviewer: z.string().optional() }).strict();
const evaluationCase = z.object({
  id: z.string().min(1).max(200), input: z.unknown(), expectedOutput: z.unknown().optional(),
  rubric: z.record(z.unknown()).default({}),
  historical: z.object({ originalRunAt: z.string().datetime(), originalVersion: z.string().min(1), output: z.unknown(), scores: z.array(historicScore).default([]), status: z.enum(['PENDING', 'COMPLETED']).default('PENDING'), sourceTraceId: z.string().regex(/^[a-f0-9]{32}$/).optional() }).strict().optional(),
}).strict();
export const migrationSchema = z.object({ source: z.enum(['synthetic', 'approved-private']), revision: z.string().min(1), cases: z.array(evaluationCase).min(1).max(10000) }).strict();
export type EvaluationMigration = z.infer<typeof migrationSchema>;
type Client = ReturnType<typeof createLangfuseClient>;
const apiOptions = { maxRetries: 0, timeoutInSeconds: 5 };
export function migrationId(...keys: string[]): string { return createHash('sha256').update(JSON.stringify(keys)).digest('hex'); }

/** Only this explicit, operator-invoked path reads an approved private export. Never searches reports. */
export async function loadApprovedMigration(file: string, approval: string): Promise<EvaluationMigration> {
  if (approval !== 'approved-private-import') throw new Error('Private import needs explicit approval marker');
  const fullPath = resolve(file);
  const info = await stat(fullPath);
  if (!info.isFile() || info.size > 16 * 1024 * 1024 || (info.mode & 0o077) !== 0) throw new Error('Private import must be a regular owner-only file under 16 MiB');
  const migration = migrationSchema.parse(JSON.parse(await readFile(fullPath, 'utf8')));
  if (migration.source !== 'approved-private') throw new Error('Private export must declare approved-private provenance');
  return migration;
}

export async function migrateDataset(client: Client, datasetName: string, input: EvaluationMigration): Promise<{ items: number; historicalScores: number; unlinkedHistorical: number }> {
  const migration = migrationSchema.parse(input);
  try { await client.api.datasets.get(datasetName, apiOptions); }
  catch (error) {
    if (!(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 404)) throw error;
    await client.api.datasets.create({ name: datasetName, description: 'Versioned persona regression cases; imported results retain original provenance', metadata: { migration: 'framework-v4', source: migration.source } }, apiOptions);
  }
  let historicalScores = 0;
  let unlinkedHistorical = 0;
  for (const item of migration.cases) {
    const id = migrationId(datasetName, migration.revision, item.id);
    await client.api.datasetItems.create({
      id, datasetName, input: item.input, expectedOutput: item.expectedOutput,
      metadata: { caseId: item.id, revision: migration.revision, rubric: item.rubric, source: migration.source, managedBy: 'ptr-framework',
        originalRunAt: item.historical?.originalRunAt, originalVersion: item.historical?.originalVersion,
        historicalArchive: item.historical ? { output: item.historical.output, scores: item.historical.scores, status: item.historical.status, notANewExecution: true } : undefined },
      sourceTraceId: item.historical?.sourceTraceId,
    }, apiOptions);
    if (item.historical && !item.historical.sourceTraceId) unlinkedHistorical++;
    if (item.historical?.sourceTraceId) {
      for (const score of item.historical.scores) {
        await client.api.scores.create({ id: migrationId(id, score.name), traceId: item.historical.sourceTraceId, name: score.name, value: score.value,
          comment: redactTelemetry(score.comment) as string | undefined,
          metadata: { source: 'historical-import', originalRunAt: item.historical.originalRunAt, originalVersion: item.historical.originalVersion, reviewer: redactTelemetry(score.reviewer), originalStatus: item.historical.status, notANewEvaluation: true }, dataType: typeof score.value === 'number' ? 'NUMERIC' : 'CATEGORICAL' }, apiOptions);
        historicalScores++;
      }
    }
  }
  await client.flush();
  return { items: migration.cases.length, historicalScores, unlinkedHistorical };
}

export const reviewDimensions = ['persona_fidelity', 'evidence_match', 'language_match', 'safety'] as const;
export interface ReviewDimension { name: string; minValue: number; maxValue: number; description: string }
export async function ensureHumanReview(client: Client, name: string, dimensions: ReviewDimension[] = reviewDimensions.map(name => ({ name, minValue: 0, maxValue: 1, description: 'Synthetic regression rubric: 0 fail, 1 pass' }))): Promise<string> {
  if (!dimensions.length || new Set(dimensions.map(dimension => dimension.name)).size !== dimensions.length || dimensions.some(dimension => !Number.isFinite(dimension.minValue) || !Number.isFinite(dimension.maxValue) || dimension.minValue >= dimension.maxValue)) throw new Error('Invalid review dimensions');
  const configs = [];
  for (let page = 1; ; page++) {
    const response = await client.api.scoreConfigs.get({ page, limit: 100 }, apiOptions);
    configs.push(...response.data);
    if (page >= response.meta.totalPages) break;
  }
  const ids: string[] = [];
  for (const dimension of dimensions) {
    const matches = configs.filter(config => config.name === dimension.name && !config.isArchived);
    if (matches.length > 1) throw new Error('Ambiguous duplicate review score configs');
    if (matches[0] && (matches[0].dataType !== 'NUMERIC' || matches[0].minValue !== dimension.minValue || matches[0].maxValue !== dimension.maxValue)) throw new Error('Existing review rubric differs from requested rubric');
    const config = matches[0] ?? await client.api.scoreConfigs.create({ ...dimension, dataType: 'NUMERIC' }, apiOptions);
    ids.push(config.id);
  }
  const queues = [];
  for (let page = 1; ; page++) {
    const response = await client.api.annotationQueues.listQueues({ page, limit: 100 }, apiOptions);
    queues.push(...response.data.filter(queue => queue.name === name));
    if (page >= response.meta.totalPages) break;
  }
  if (queues.length > 1) throw new Error('Ambiguous duplicate review queues');
  if (queues[0]) {
    if (JSON.stringify([...queues[0].scoreConfigIds].sort()) !== JSON.stringify([...ids].sort())) throw new Error('Existing review queue has different score configuration');
    return queues[0].id;
  }
  return (await client.api.annotationQueues.createQueue({ name, scoreConfigIds: ids, description: 'Persona regression review; original imported results are explicitly labeled' }, apiOptions)).id;
}

export async function enqueueHumanReview(client: Client, queueId: string, traceIds: string[]): Promise<void> {
  const existing = new Set<string>();
  for (let page = 1; ; page++) {
    const response = await client.api.annotationQueues.listQueueItems(queueId, { page, limit: 100 }, apiOptions);
    response.data.forEach(item => existing.add(item.objectId));
    if (page >= response.meta.totalPages) break;
  }
  for (const traceId of new Set(traceIds)) if (!existing.has(traceId)) await client.api.annotationQueues.createQueueItem(queueId, { objectId: traceId, objectType: 'TRACE' }, apiOptions);
}

export async function recordHumanReview(client: Client, queueId: string, queueItemId: string, traceId: string, scores: Array<{ name: string; configId: string; value: number; comment?: string }>): Promise<void> {
  if (!scores.length || scores.some(score => !Number.isFinite(score.value))) throw new Error('Review requires bounded scores');
  const item = await client.api.annotationQueues.getQueueItem(queueId, queueItemId, apiOptions);
  if (item.objectId !== traceId || item.objectType !== 'TRACE') throw new Error('Review target does not match annotation queue item');
  const queue = await client.api.annotationQueues.getQueue(queueId, apiOptions);
  const supplied = new Set(scores.map(score => score.configId));
  if (supplied.size !== scores.length || supplied.size !== queue.scoreConfigIds.length || queue.scoreConfigIds.some(id => !supplied.has(id))) throw new Error('Review completion requires every configured rubric dimension exactly once');
  for (const score of scores) {
    const config = await client.api.scoreConfigs.getById(score.configId, apiOptions);
    if (config.dataType !== 'NUMERIC' || config.name !== score.name || (config.minValue != null && score.value < config.minValue) || (config.maxValue != null && score.value > config.maxValue)) throw new Error('Review score differs from the configured original rubric');
  }
  for (const score of scores) await client.api.scores.create({ ...score, id: migrationId(queueId, queueItemId, score.name), traceId, queueId, dataType: 'NUMERIC', source: 'ANNOTATION', comment: redactTelemetry(score.comment) as string | undefined }, apiOptions);
  await client.flush();
  await client.api.annotationQueues.updateQueueItem(queueId, queueItemId, { status: 'COMPLETED' }, apiOptions);
}

export type ExperimentScoreRule =
  | { name: string; kind: 'numeric'; min: number; max: number; passMin: number; passMax: number }
  | { name: string; kind: 'categorical'; values: string[]; passValues: string[] };
/** A versioned domain policy declares the exact metric multiplicity for every case. */
export interface ExperimentScorePolicy { rules: ExperimentScoreRule[]; expected(input: unknown): Record<string, number> }
export const syntheticScorePolicy: ExperimentScorePolicy = { rules: [{ name: 'exact_match', kind: 'numeric', min: 0, max: 1, passMin: 1, passMax: 1 }], expected: () => ({ exact_match: 1 }) };
const experimentScoreSchema = z.object({ name: z.string().min(1).max(200), value: z.union([z.number().finite(), z.string().min(1)]), comment: z.string().optional(), metadata: z.record(z.unknown()).optional(), dataType: z.enum(['NUMERIC', 'BOOLEAN', 'CATEGORICAL']).optional(), configId: z.string().optional() }).strict();

/** SDK score.flush() swallows transport errors; native v3 readback is the success boundary. */
export async function verifyExperimentScores(client: Client, items: Array<{ traceId?: string; evaluations: Array<{ name: string; value: string | number; dataType?: string }> }>, timeoutMs = 20000): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('Invalid score persistence deadline');
  const deadline = Date.now() + timeoutMs;
  const key = (name: string, value: string | number | boolean, dataType?: string) => JSON.stringify([name, typeof value === 'boolean' ? Number(value) : value, dataType ?? (typeof value === 'string' ? 'CATEGORICAL' : 'NUMERIC')]);
  for (const item of items) {
    if (!item.traceId || !item.evaluations.length) throw new Error('Experiment omitted score/trace binding');
    const required = new Map<string, number>();
    for (const score of item.evaluations) { const id = key(score.name, score.value, score.dataType); required.set(id, (required.get(id) ?? 0) + 1); }
    let persisted = false;
    while (Date.now() < deadline) {
      const actual = new Map<string, number>(); const cursors = new Set<string>(); let cursor: string | undefined;
      do {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Experiment score persistence deadline exceeded');
        const response = await client.api.scoresV3.getManyV3({ traceId: item.traceId, limit: 100, cursor }, { ...apiOptions, abortSignal: AbortSignal.timeout(remaining) });
        for (const score of response.data) { const id = key(score.name, score.value, score.dataType); actual.set(id, (actual.get(id) ?? 0) + 1); }
        cursor = response.meta.cursor;
        if (cursor && cursors.has(cursor)) throw new Error('Score cursor repeated');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      if ([...required].every(([id, count]) => (actual.get(id) ?? 0) >= count)) { persisted = true; break; }
      await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
    if (!persisted) throw new Error('Experiment score persistence deadline exceeded');
  }
}

/** Existing application task/domain evaluators are injected, never a second evaluation service. */
export async function runFrameworkExperiment(options: {
  client: Client; datasetName: string; runName: string; versions: Record<string, string>;
  task: ExperimentTask; evaluators: Evaluator[]; scorePolicy: ExperimentScorePolicy; queueName?: string; reviewDimensions?: ReviewDimension[]; scorePersistenceTimeoutMs?: number; telemetry?: Pick<FrameworkTelemetry, 'flush'>;
}): Promise<{ runName: string; cases: number; failedScores: number; missingScores: number; taskFailures: number; traceIds: string[] }> {
  if (!options.evaluators.length) throw new Error('Regression experiments require evaluators');
  if (options.queueName && !options.telemetry) throw new Error('Human review requires a tracing flush boundary');
  const policy = options.scorePolicy;
  if (!policy?.rules?.length || typeof policy.expected !== 'function' || new Set(policy.rules.map(rule => rule.name)).size !== policy.rules.length) throw new Error('Explicit unique experiment score policy required');
  for (const rule of policy.rules) {
    if (!rule.name || (rule.kind === 'numeric' ? ![rule.min, rule.max, rule.passMin, rule.passMax].every(Number.isFinite) || rule.min > rule.passMin || rule.passMin > rule.passMax || rule.passMax > rule.max : rule.kind !== 'categorical' || !rule.values.length || !rule.passValues.length || rule.passValues.some(value => !rule.values.includes(value)))) throw new Error('Invalid score pass policy');
  }
  const rules = new Map(policy.rules.map(rule => [rule.name, rule]));
  const dataset = await options.client.dataset.get(options.datasetName);
  if (!dataset.items.length) throw new Error('Regression dataset must not be empty');
  const expectedFor = (input: unknown): Record<string, number> => {
    const expected = policy.expected(input);
    if (!expected || !Object.keys(expected).length || Object.entries(expected).some(([name, count]) => !rules.has(name) || !Number.isInteger(count) || count < 1)) throw new Error('Invalid required metrics for dataset case');
    return expected;
  };
  dataset.items.forEach(item => expectedFor(item.input)); // Validate all case semantics before any app/model calls.
  let failedScores = 0; let missingScores = 0; let taskFailures = 0;
  const failedOutputs = new WeakSet<object>();
  const guardedEvaluator: Evaluator = async params => {
    const expected = expectedFor(params.input);
    if (params.output && typeof params.output === 'object' && failedOutputs.has(params.output)) {
      missingScores += Object.values(expected).reduce((sum, count) => sum + count, 0);
      failedScores++;
      return { name: 'application_task_failed', value: 0, comment: 'Application failed; private details withheld' };
    }
    const scores: Array<z.infer<typeof experimentScoreSchema>> = [];
    for (const evaluator of options.evaluators) {
      let evaluated: unknown;
      try { evaluated = await evaluator(params); } catch { failedScores++; continue; }
      for (const raw of Array.isArray(evaluated) ? evaluated : [evaluated]) {
        const checked = experimentScoreSchema.safeParse(raw);
        const rule = checked.success ? rules.get(checked.data.name) : undefined;
        if (!checked.success || !rule || !expected[checked.data.name]) { failedScores++; continue; }
        const score = checked.data;
        const valid = rule.kind === 'numeric' ? typeof score.value === 'number' && score.value >= rule.min && score.value <= rule.max && score.dataType !== 'CATEGORICAL' && (score.dataType !== 'BOOLEAN' || score.value === 0 || score.value === 1) : typeof score.value === 'string' && rule.values.includes(score.value) && (!score.dataType || score.dataType === 'CATEGORICAL');
        if (!valid) { failedScores++; continue; }
        const pass = rule.kind === 'numeric' ? Number(score.value) >= rule.passMin && Number(score.value) <= rule.passMax : rule.passValues.includes(String(score.value));
        if (!pass) failedScores++;
        scores.push({ ...score, comment: redactTelemetry(score.comment) as string | undefined, metadata: redactTelemetry(score.metadata) as Record<string, unknown> | undefined });
      }
    }
    for (const [name, required] of Object.entries(expected)) {
      const actual = scores.filter(score => score.name === name).length;
      missingScores += Math.max(0, required - actual);
      failedScores += Math.max(0, actual - required); // Duplicate metrics cannot hide missing dimensions.
    }
    return scores.length ? scores : [{ name: 'evaluation_invalid', value: 0, comment: 'Required metric missing or invalid' }];
  };
  const result = await dataset.runExperiment({ name: 'persona-regression', runName: options.runName, metadata: options.versions,
    task: async item => { try { return await options.task(item); } catch { taskFailures++; const failed = { applicationTaskFailed: true }; failedOutputs.add(failed); return failed; } },
    evaluators: [guardedEvaluator], maxConcurrency: 1 });
  if (result.itemResults.length !== dataset.items.length) { missingScores += dataset.items.length - result.itemResults.length; failedScores++; }
  await options.client.flush();
  const traceIds = result.itemResults.flatMap(item => item.traceId ? [item.traceId] : []);
  if (options.telemetry && !await options.telemetry.flush()) throw new Error('Experiment trace export failed');
  await verifyExperimentScores(options.client, result.itemResults, options.scorePersistenceTimeoutMs);
  if (options.queueName) await enqueueHumanReview(options.client, await ensureHumanReview(options.client, options.queueName, options.reviewDimensions), traceIds);
  return { runName: result.runName, cases: result.itemResults.length, traceIds, failedScores, missingScores, taskFailures };
}

export const syntheticMigration: EvaluationMigration = { source: 'synthetic', revision: 'synthetic-v1', cases: [
  { id: 'hello-ko', input: '안녕', expectedOutput: '안녕!', rubric: { language: 'ko', privacy: true } },
  { id: 'hello-en', input: 'hello', expectedOutput: 'hello!', rubric: { language: 'en', privacy: true } },
] };

export function evaluationConfig(env: NodeJS.ProcessEnv = process.env): FrameworkTelemetryConfig {
  return { enabled: true, baseUrl: env.LANGFUSE_BASE_URL, publicKey: env.LANGFUSE_PUBLIC_KEY, secretKey: env.LANGFUSE_SECRET_KEY,
    environment: env.LANGFUSE_TRACING_ENVIRONMENT ?? env.PTR_ENVIRONMENT ?? 'synthetic', release: env.FRAMEWORK_RELEASE ?? env.PTR_RELEASE ?? 'framework-development',
    allowInsecureLocal: env.LANGFUSE_ALLOW_LOCAL_HTTP === 'true' || env.PTR_LANGFUSE_LOCAL === '1', captureContent: true };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const file = value('--private-file');
  const migration = file ? await loadApprovedMigration(file, value('--approval') ?? '') : syntheticMigration;
  const existingDataset = args.includes('--existing-dataset');
  if (existingDataset && (!value('--dataset') || file)) throw new Error('Existing dataset mode requires --dataset and no private-file import');
  const config = evaluationConfig();
  const telemetry = new FrameworkTelemetry(config);
  const client = createLangfuseClient(config);
  try {
    const datasetName = value('--dataset') ?? 'ptr-synthetic-regression';
    const imported = existingDataset ? { items: 0, historicalScores: 0, unlinkedHistorical: 0 } : await migrateDataset(client, datasetName, migration);
    const taskPath = value('--task');
    if (file && !taskPath) { console.log(JSON.stringify(imported)); return; }
    let task: ExperimentTask = async ({ input }) => `${String(input)}!`;
    let scorePolicy = syntheticScorePolicy;
    let review: ReviewDimension[] | undefined;
    let evaluators: Evaluator[] = [async ({ output, expectedOutput }) => ({ name: 'exact_match', value: output === expectedOutput ? 1 : 0 })];
    if (taskPath) {
      const injected = await import(pathToFileURL(resolve(taskPath)).href) as { task?: ExperimentTask; evaluators?: Evaluator[]; scorePolicy?: ExperimentScorePolicy; reviewDimensions?: ReviewDimension[] };
      if (!injected.task || !injected.evaluators?.length || !injected.scorePolicy) throw new Error('Task module must export task, evaluators and scorePolicy');
      task = injected.task; evaluators = injected.evaluators; scorePolicy = injected.scorePolicy; review = injected.reviewDimensions;
    }
    const result = await runFrameworkExperiment({ client, datasetName, runName: value('--run') ?? `synthetic-${Date.now()}`,
      versions: { code: config.release, cases: existingDataset ? value('--cases-revision') ?? 'existing-dataset-version' : migration.revision, engine: taskPath ? 'injected-app' : 'synthetic-no-model' }, task, evaluators, scorePolicy,
      queueName: value('--review-queue'), reviewDimensions: review, telemetry });
    console.log(JSON.stringify({ ...imported, ...result, diagnostics: telemetry.diagnostics() }));
    if (result.failedScores || result.missingScores) process.exitCode = 1;
  } finally { await client.shutdown(); if (!await telemetry.shutdown()) process.exitCode = 1; }
}
if (require.main === module) void main().catch(() => { console.error('Framework evaluation failed (details withheld to protect private data)'); process.exitCode = 1; });
