import * as fsp from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportProductionReview, REVIEW_ENVIRONMENT, REVIEW_DIMENSIONS, type ReviewExportDeps } from './production-review';
import type { Candidate } from './review-sample';

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, open: jest.fn(actual.open) };
});

const NOW = new Date('2026-10-12T00:00:00Z');
const source: Candidate = { id: 'turn:private-source-id', persona: 'P1', source: 'DB', stratum: 'small_talk|none|unverified_model|none',
  stratumText: 'small_talk', date: '2026-10-11', finishedAt: '2026-10-11T00:00:00.000Z',
  userText: 'Email me x@example.invalid https://private.invalid/source Bearer abcsecret', reply: 'Final user reply +82 10 1234 5678' };
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'ptr-central-review-')); roots.push(dir);
  const writes: unknown[] = [], observations: Record<string, unknown>[] = [], items: Record<string, unknown>[] = [];
  let seq = 0;
  const client = { api: {
    projects: { get: async () => ({ data: [{ id: 'approved-project' }] }) },
    scoreConfigs: { getById: async (id: string) => ({ id, name: REVIEW_DIMENSIONS[Number(id)]!.name, dataType: 'NUMERIC', minValue: 0, maxValue: 3 }) },
    observations: { getMany: async () => ({ data: observations, meta: {} }) },
    annotationQueues: {
      getQueue: async () => ({ id: 'queue', scoreConfigIds: REVIEW_DIMENSIONS.map((_, i) => `${i}`) }),
      listQueueItems: async () => ({ data: items, meta: { totalPages: 1 } }),
      createQueueItem: async (_queue: string, value: Record<string, unknown>) => {
        const item = { ...value, id: 'native-item', queueId: 'queue' }; items.push(item); writes.push(item); return item;
      },
      getQueueItem: async () => items[0],
    },
  } } as unknown as ReviewExportDeps['client'];
  const deps: ReviewExportDeps = { client, now: NOW, flush: async () => true,
    create: payload => {
      writes.push(payload); seq++;
      const traceId = String(seq).padStart(32, '0'), id = String(seq).padStart(16, '0');
      return { traceId, id, end: () => observations.push({ id, traceId, projectId: 'approved-project', environment: REVIEW_ENVIRONMENT,
        name: 'production-review', isRootObservation: true, startTime: payload.originalRunAt, endTime: payload.originalRunAt, metadata: payload.metadata }) };
    },
  };
  const options = { apply: true, confirmProject: 'approved-project', queueId: 'queue', stateDir: dir,
    approval: 'approved-redacted-final-turn-review', salt: 'a'.repeat(64) };
  return { dir, writes, observations, items, deps, options };
}

test('default dry-run is GET-only with no journal, traces, datasets or queue writes', async () => {
  const f = await fixture();
  expect(await exportProductionReview([source], { ...f.options, apply: false, approval: '' }, f.deps)).toMatchObject({ planned: 1, exported: 0, queued: 0, applied: false });
  expect(f.writes).toEqual([]); expect(await readdir(f.dir)).toEqual([]);
});

test('exports only redacted final text and native verified review-copy IDs; preserves source clock and retry identity', async () => {
  const f = await fixture();
  expect(await exportProductionReview([source], f.options, f.deps)).toMatchObject({ exported: 1, queued: 1 });
  const payload = JSON.stringify(f.writes);
  for (const hidden of ['private-source-id', 'private.invalid', 'x@example.invalid', 'abcsecret', '+82 10 1234 5678']) expect(payload).not.toContain(hidden);
  expect(payload).toContain('2026-10-11T00:00:00.000Z');
  expect(payload).not.toContain('dataset');
  const [journal] = await readdir(f.dir); const body = await readFile(join(f.dir, journal!), 'utf8');
  expect(body).not.toContain(source.userText); expect(body).not.toContain(source.reply); expect(body).not.toContain(source.id);
  expect((await stat(join(f.dir, journal!))).mode & 0o777).toBe(0o600);
  expect(await exportProductionReview([source], f.options, f.deps)).toMatchObject({ exported: 0, queued: 0, existing: 1 });
  expect(f.writes).toHaveLength(2);
});

test.each(['approval', 'confirmation', 'expired', 'future', 'wrong-source'])('invalid %s fails before all writes', async condition => {
  const f = await fixture(); let row = source;
  if (condition === 'approval') f.options.approval = '';
  if (condition === 'confirmation') f.options.confirmProject = 'different';
  if (condition === 'expired') row = { ...source, finishedAt: '2020-01-01T00:00:00.000Z' };
  if (condition === 'future') row = { ...source, finishedAt: '2030-01-01T00:00:00.000Z' };
  if (condition === 'wrong-source') row = { ...source, source: 'S8' };
  await expect(exportProductionReview([row], f.options, f.deps)).rejects.toThrow(); expect(f.writes).toEqual([]);
});

test('unknown trace reservation never gets a blind second export', async () => {
  const f = await fixture(); f.deps.flush = async () => false;
  await expect(exportProductionReview([source], f.options, f.deps)).rejects.toThrow();
  f.observations.length = 0;
  await expect(exportProductionReview([source], f.options, { ...f.deps, persistenceMs: 10 })).rejects.toThrow();
  expect(f.writes).toHaveLength(1); expect(f.items).toHaveLength(0);
});

test('wrong project/root/source/time readback cannot enqueue', async () => {
  const f = await fixture(); const create = f.deps.create;
  f.deps.create = payload => { const span = create(payload); return { ...span, end: () => { span.end(); f.observations[0]!.isRootObservation = false; } }; };
  await expect(exportProductionReview([source], f.options, { ...f.deps, persistenceMs: 10 })).rejects.toThrow(); expect(f.items).toEqual([]);
});

test('queue POST timeout stays fail-closed instead of duplicating targets', async () => {
  const f = await fixture(); Object.assign(f.deps.client.api.annotationQueues, { createQueueItem: async () => { throw new Error('private remote body'); } });
  await expect(exportProductionReview([source], f.options, f.deps)).rejects.toThrow();
  await expect(exportProductionReview([source], f.options, f.deps)).rejects.toThrow();
  expect(f.writes).toHaveLength(1); expect(f.items).toEqual([]);
});


test('invalid journal states fail closed without another native export or target', async () => {
  const f = await fixture(); await exportProductionReview([source], f.options, f.deps);
  const [file] = await readdir(f.dir); const path = join(f.dir, file!);
  const journal = JSON.parse(await readFile(path, 'utf8')); journal.state = 'unsupported';
  await writeFile(path, JSON.stringify(journal));
  await expect(exportProductionReview([source], f.options, f.deps)).rejects.toThrow('PRIVATE_REVIEW_JOURNAL_INVALID');
  expect(f.writes).toHaveLength(2);
});

test('full UTF-8 content budget fails before native export', async () => {
  const f = await fixture();
  await expect(exportProductionReview([{ ...source, userText: '😀'.repeat(8192), reply: '😀'.repeat(8192) }], f.options, f.deps)).rejects.toThrow('REVIEW_PAYLOAD_BYTE_LIMIT');
  expect(f.writes).toEqual([]);
});


test('reservation fsync failure stops before a native span or network write', async () => {
  const f = await fixture();
  const actual = jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises');
  (fsp.open as jest.MockedFunction<typeof fsp.open>).mockImplementationOnce(async (...args) => {
    const handle = await actual.open(...args);
    handle.sync = async () => { throw new Error('synthetic fsync failure'); };
    return handle;
  });
  await expect(exportProductionReview([source], f.options, f.deps)).rejects.toThrow('synthetic fsync failure');
  expect(f.writes).toEqual([]);
});

test.each(['project', 'source', 'clock', 'capturePolicy'])('mismatched %s observation readback cannot enqueue', async mismatch => {
  const f = await fixture(); const create = f.deps.create;
  f.deps.create = payload => { const span = create(payload); return { ...span, end: () => {
    span.end(); const row = f.observations[0]!;
    if (mismatch === 'project') row.projectId = 'different-project';
    if (mismatch === 'source') (row.metadata as Record<string, unknown>).sourceKey = 'different-source';
    if (mismatch === 'clock') row.endTime = NOW.toISOString();
    if (mismatch === 'capturePolicy') (row.metadata as Record<string, unknown>).capturePolicy = 'unsafe';
  } }; };
  await expect(exportProductionReview([source], f.options, f.deps)).rejects.toThrow('REVIEW_OBSERVATION_BINDING_MISMATCH');
  expect(f.items).toEqual([]);
});
