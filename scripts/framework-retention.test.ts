import { createLangfuseClient } from '../packages/ops/src/langfuse';
import { retainFrameworkData } from './framework-retention';
import { SyntheticLangfuseServer } from './framework-langfuse.test-helper';

describe('90-day OSS trace retention and explicit logical dataset deletion', () => {
  let server: SyntheticLangfuseServer;
  let client: ReturnType<typeof createLangfuseClient>;
  const scope = { environment: 'synthetic', from: '2025-01-01T00:00:00.000Z', now: new Date('2026-10-10T00:00:00.000Z'), datasetNames: ['managed'], queueIds: ['managed-queue'] };
  beforeEach(async () => {
    server = new SyntheticLangfuseServer(); await server.start();
    client = createLangfuseClient({ enabled: true, baseUrl: server.baseUrl, publicKey: 'synthetic-public', secretKey: 'synthetic-secret', environment: 'synthetic', release: 'test', allowInsecureLocal: true });
    server.observations = [
      { id: 'obs-old', traceId: 'old', projectId: 'synthetic-project', environment: 'synthetic', startTime: '2026-01-01T00:00:00.000Z' },
      { id: 'obs-duplicate', traceId: 'old', projectId: 'synthetic-project', environment: 'synthetic', startTime: '2026-01-02T00:00:00.000Z' },
      { id: 'obs-new', traceId: 'new', projectId: 'synthetic-project', environment: 'synthetic', startTime: '2026-10-01T00:00:00.000Z' },
      { id: 'obs-other', traceId: 'other', projectId: 'synthetic-project', environment: 'production', startTime: '2026-01-01T00:00:00.000Z' },
    ];
    server.items.set('old-item', { id: 'old-item', datasetName: 'managed', createdAt: '2026-10-01T00:00:00.000Z', metadata: { originalRunAt: '2026-01-01T00:00:00.000Z' } });
    server.items.set('new-item', { id: 'new-item', datasetName: 'managed', createdAt: '2026-10-01T00:00:00.000Z' });
    server.items.set('other-item', { id: 'other-item', datasetName: 'other', createdAt: '2026-01-01T00:00:00.000Z' });
    server.queueItems.set('old-review', { id: 'old-review', queueId: 'managed-queue', objectId: 'old', createdAt: '2026-10-01T00:00:00.000Z' });
  });
  afterEach(async () => { await client.shutdown(); await server.close(); });
  it('dry-run makes no writes and reports fixed cutoff and deduplicated scoped inventory', async () => {
    const plan = await retainFrameworkData(client, scope);
    expect(plan).toMatchObject({ cutoff: '2026-07-12T00:00:00.000Z', traceIds: ['old'], applied: false, deletionSubmitted: false,
      datasetDeletionSemantics: 'version-tombstone', historicalDatasetErasureVerified: false });
    expect(plan.datasetItems).toEqual([{ id: 'old-item', datasetName: 'managed' }]);
    expect(server.requests.every(request => request.method === 'GET')).toBe(true);
    expect(server.requests.some(request => request.path === '/api/public/traces')).toBe(false);
  });
  it('requires correct project confirmation and at least 90 days before deleting', async () => {
    await expect(retainFrameworkData(client, { ...scope, apply: true, confirmProject: 'wrong' })).rejects.toThrow('confirmation');
    await expect(retainFrameworkData(client, { ...scope, days: 30 })).rejects.toThrow('90');
    expect(server.requests.every(request => request.method === 'GET')).toBe(true);
  });
  it('blocks all mutations after complete inventory unless logical dataset deletion is explicit', async () => {
    await expect(retainFrameworkData(client, { ...scope, apply: true, confirmProject: 'synthetic-project' }))
      .rejects.toThrow('Logical dataset deletion requires explicit opt-in');
    expect(server.requests.some(request => request.path.includes('/dataset-items'))).toBe(true);
    expect(server.requests.some(request => request.path.includes('/annotation-queues'))).toBe(true);
    expect(server.requests.every(request => request.method === 'GET')).toBe(true);
    expect(server.items.has('old-item')).toBe(true);
    expect(server.queueItems.has('old-review')).toBe(true);
  });
  it('submits explicit logical item deletions without claiming historical erasure', async () => {
    const options = { ...scope, apply: true, confirmProject: 'synthetic-project', allowLogicalDatasetDeletion: true };
    const result = await retainFrameworkData(client, options);
    expect(result).toMatchObject({ applied: true, deletionSubmitted: true,
      datasetDeletionSemantics: 'version-tombstone', historicalDatasetErasureVerified: false });
    expect(server.observations.map(item => item.traceId)).toEqual(['new', 'other']);
    expect([...server.items.keys()]).toEqual(['new-item', 'other-item']); expect(server.queueItems.size).toBe(0);
    expect(server.requests.find(request => request.method === 'DELETE' && request.path === '/api/public/traces')?.body.toString()).toBe('{"traceIds":["old"]}');
    expect(server.requests.some(request => request.path.includes('/runs/'))).toBe(false);
  });
  it('allows trace and review retention without opt-in when no dataset items expire', async () => {
    server.items.delete('old-item');
    const result = await retainFrameworkData(client, { ...scope, apply: true, confirmProject: 'synthetic-project' });
    expect(result).toMatchObject({ applied: true, deletionSubmitted: true, datasetItems: [], historicalDatasetErasureVerified: false });
    expect(server.queueItems.size).toBe(0);
    expect(server.requests.some(request => request.method === 'DELETE' && request.path.includes('/dataset-items'))).toBe(false);
  });
  it('enforces complete inventory cap before any deletion', async () => {
    await expect(retainFrameworkData(client, { ...scope, apply: true, confirmProject: 'synthetic-project', maxEntities: 1 })).rejects.toThrow('limit');
    expect(server.requests.every(request => request.method === 'GET')).toBe(true);
  });
});
