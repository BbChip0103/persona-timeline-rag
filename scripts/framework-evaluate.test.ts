import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLangfuseClient, FrameworkTelemetry, type Evaluator } from '../packages/ops/src/langfuse';
import { ensureHumanReview, enqueueHumanReview, loadApprovedMigration, migrateDataset, recordHumanReview, runFrameworkExperiment, syntheticMigration, syntheticScorePolicy } from './framework-evaluate';
import { SyntheticLangfuseServer } from './framework-langfuse.test-helper';

// Real generated Langfuse client performs HTTP against synthetic endpoint.
describe('Langfuse dataset, experiment, score and annotation migration', () => {
  let server: SyntheticLangfuseServer;
  let telemetry: FrameworkTelemetry;
  let client: ReturnType<typeof createLangfuseClient>;
  beforeAll(async () => {
    server = new SyntheticLangfuseServer(); await server.start();
    const config = { enabled: true, baseUrl: server.baseUrl, publicKey: 'synthetic-public', secretKey: 'synthetic-secret', environment: 'synthetic', release: 'test-v1', allowInsecureLocal: true };
    client = createLangfuseClient(config); telemetry = new FrameworkTelemetry(config);
  });
  afterAll(async () => { await client.shutdown(); await telemetry.shutdown(); await server.close(); });

  it('idempotently upserts versioned datasets and preserves unlinked historic provenance', async () => {
    const migration = { ...syntheticMigration, cases: [...syntheticMigration.cases, { id: 'past-row', input: 'synthetic past input', rubric: { original: 'v12' }, historical: { originalRunAt: '2026-01-01T00:00:00.000Z', originalVersion: 'v12', output: 'synthetic past output', scores: [{ name: 'persona_fidelity', value: 1 }], status: 'COMPLETED' as const } }] };
    expect(await migrateDataset(client, 'regression', migration)).toMatchObject({ items: 3, historicalScores: 0, unlinkedHistorical: 1 });
    await migrateDataset(client, 'regression', migration);
    expect(server.datasets.size).toBe(1); expect(server.items.size).toBe(3);
    const archive = [...server.items.values()].find(item => (item.metadata as { caseId: string }).caseId === 'past-row')!;
    expect(archive.metadata).toMatchObject({ originalVersion: 'v12', historicalArchive: { notANewExecution: true, status: 'COMPLETED' } });
    expect(server.requests.some(request => request.path.includes('dataset-run-items'))).toBe(false);
  });

  it('runs real SDK experiment task/evaluators and binds review to resulting traces', async () => {
    await migrateDataset(client, 'experiment', syntheticMigration);
    const evaluators: Evaluator[] = [async ({ output, expectedOutput }) => ({ name: 'exact_match', value: output === expectedOutput ? 1 : 0 })];
    const result = await runFrameworkExperiment({ client, datasetName: 'experiment', runName: 'synthetic-fixed-run', versions: { code: 'v1', cases: 'synthetic-v1' },
      task: async ({ input }) => `${String(input)}!`, evaluators, scorePolicy: syntheticScorePolicy, queueName: 'synthetic-review', telemetry });
    expect(result).toMatchObject({ runName: 'synthetic-fixed-run', cases: 2, failedScores: 0, missingScores: 0 });
    expect(result.traceIds).toHaveLength(2); expect(server.scores.size).toBe(2);
    expect(server.configs.size).toBe(4); expect(server.queueItems.size).toBe(2);
    const queueId = await ensureHumanReview(client, 'synthetic-review');
    await enqueueHumanReview(client, queueId, result.traceIds);
    expect(server.queues.size).toBe(1); expect(server.queueItems.size).toBe(2);
    await telemetry.flush();
    expect(server.requests.filter(request => request.path.includes('/otel/v1/traces')).length).toBeGreaterThan(0);
    const exportPayload = Buffer.concat(server.requests.filter(request => request.path.includes('/otel/v1/traces')).map(request => request.body)).toString();
    expect(exportPayload).toContain('synthetic-fixed-run');
  });

  it('stores human scores before marking correct queue target completed', async () => {
    const item = [...server.queueItems.values()][0];
    const config = server.configs.get('persona_fidelity')!;
    await expect(recordHumanReview(client, String(item.queueId), String(item.id), 'wrong-trace', [{ name: 'persona_fidelity', configId: String(config.id), value: 1 }])).rejects.toThrow('target');
    await recordHumanReview(client, String(item.queueId), String(item.id), String(item.objectId), [...server.configs.values()].map(config => ({ name: String(config.name), configId: String(config.id), value: 1, comment: 'synthetic reviewed' })));
    expect(server.queueItems.get(String(item.id))?.status).toBe('COMPLETED');
    const completed = server.requests.findIndex(request => request.method === 'PATCH');
    expect(server.requests.slice(0, completed).some(request => request.path.endsWith('/scores'))).toBe(true);
  });

  it('never marks review complete when score API rejects persistence', async () => {
    const queueId = await ensureHumanReview(client, 'rejection-review');
    await enqueueHumanReview(client, queueId, ['a'.repeat(32)]);
    const item = [...server.queueItems.values()].find(value => value.queueId === queueId)!;
    server.failScores = true;
    try {
      await expect(recordHumanReview(client, queueId, String(item.id), String(item.objectId), [...server.configs.values()].map(config => ({ name: String(config.name), configId: String(config.id), value: 1 })))).rejects.toThrow();
      expect(server.queueItems.get(String(item.id))?.status).toBe('PENDING');
    } finally { server.failScores = false; }
  });

  it('turns skipped tasks/failed evaluators into explicit CI failure counts', async () => {
    const result = await runFrameworkExperiment({ client, datasetName: 'experiment', runName: 'synthetic-evaluator-failure', versions: { code: 'v1' }, task: async () => 'synthetic',
      evaluators: [async () => { throw new Error('PRIVATE_EVALUATOR_ERROR'); }], scorePolicy: syntheticScorePolicy, telemetry });
    expect(result.missingScores).toBe(2); expect(result.failedScores).toBe(2);
    const payload = Buffer.concat(server.requests.map(request => request.body)).toString();
    expect(payload).not.toContain('PRIVATE_EVALUATOR_ERROR');
  });

  it('fails closed on NaN, categorical without policy, duplicates, omitted metrics and task errors', async () => {
    const samples: Evaluator[] = [async () => ({ name: 'exact_match', value: NaN }), async () => ({ name: 'exact_match', value: 'PASS' }), async () => [], async () => [{ name: 'exact_match', value: 1 }, { name: 'exact_match', value: 1 }]];
    for (const [index, evaluator] of samples.entries()) {
      const result = await runFrameworkExperiment({ client, datasetName: 'experiment', runName: `invalid-${index}`, versions: { code: 'v1' }, task: async () => 'synthetic', evaluators: [evaluator], scorePolicy: syntheticScorePolicy, telemetry });
      expect(result.failedScores + result.missingScores).toBeGreaterThan(0);
    }
    const result = await runFrameworkExperiment({ client, datasetName: 'experiment', runName: 'failed-task', versions: { code: 'v1' }, task: async () => { throw new Error('PRIVATE_TASK_ERROR'); }, evaluators: [async () => ({ name: 'exact_match', value: 1 })], scorePolicy: syntheticScorePolicy, telemetry });
    expect(result).toMatchObject({ taskFailures: 2, missingScores: 2, failedScores: 2 });
    expect(Buffer.concat(server.requests.map(request => request.body)).toString()).not.toContain('PRIVATE_TASK_ERROR');
  });

  it('requires every declared metric and supports categorical gates only with declared accepted/pass values', async () => {
    const policy = { rules: [{ name: 'verdict', kind: 'categorical' as const, values: ['PASS', 'FAIL'], passValues: ['PASS'] }, { name: 'coverage', kind: 'numeric' as const, min: 0, max: 2, passMin: 2, passMax: 2 }], expected: () => ({ verdict: 1, coverage: 1 }) };
    const run = async (evaluators: Evaluator[], name: string) => runFrameworkExperiment({ client, datasetName: 'experiment', runName: name, versions: { code: 'v1' }, task: async () => 'synthetic', evaluators, scorePolicy: policy, telemetry });
    expect(await run([async () => [{ name: 'verdict', value: 'PASS', dataType: 'CATEGORICAL' }, { name: 'coverage', value: 2 }]], 'declared-pass')).toMatchObject({ failedScores: 0, missingScores: 0 });
    expect((await run([async () => [{ name: 'verdict', value: 'PASS' }]], 'omitted-coverage')).missingScores).toBe(2);
    expect((await run([async () => [{ name: 'verdict', value: 'UNKNOWN' }, { name: 'coverage', value: 2 }]], 'invalid-category')).failedScores).toBe(2);
  });

  it('does not call a successful SDK flush proof that scores persisted', async () => {
    server.dropScoreIngestion = true;
    try {
      await expect(runFrameworkExperiment({ client, datasetName: 'experiment', runName: 'score-drop', versions: { code: 'v1' }, task: async () => 'synthetic', evaluators: [async () => ({ name: 'exact_match', value: 1 })], scorePolicy: syntheticScorePolicy, scorePersistenceTimeoutMs: 50, telemetry })).rejects.toThrow('persistence');
    } finally { server.dropScoreIngestion = false; }
  });

  it('keeps the original 0..2 human rubric and rejects missing dimensions or out-of-range completion', async () => {
    const queueId = await ensureHumanReview(client, 'original-rubric', [{ name: 'original-persona', minValue: 0, maxValue: 2, description: 'Original human ordinal scale' }]);
    await enqueueHumanReview(client, queueId, ['b'.repeat(32)]);
    const item = [...server.queueItems.values()].find(value => value.queueId === queueId)!;
    const config = server.configs.get('original-persona')!;
    await expect(recordHumanReview(client, queueId, String(item.id), String(item.objectId), [{ name: String(config.name), configId: String(config.id), value: 3 }])).rejects.toThrow('rubric');
    await recordHumanReview(client, queueId, String(item.id), String(item.objectId), [{ name: String(config.name), configId: String(config.id), value: 2 }]);
    expect(server.queueItems.get(String(item.id))?.status).toBe('COMPLETED');
  });

  it('requires owner-only file and explicit approval before reading private export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ptr-import-synthetic-'));
    const file = join(dir, 'synthetic.json');
    try {
      await writeFile(file, JSON.stringify({ ...syntheticMigration, source: 'approved-private' }), { mode: 0o600 });
      await expect(loadApprovedMigration(file, '')).rejects.toThrow('approval');
      expect((await loadApprovedMigration(file, 'approved-private-import')).source).toBe('approved-private');
      await chmod(file, 0o644);
      await expect(loadApprovedMigration(file, 'approved-private-import')).rejects.toThrow('owner-only');
    } finally { await rm(dir, { recursive: true }); }
  });
});
