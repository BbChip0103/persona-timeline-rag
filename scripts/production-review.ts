/** Explicit approved final-turn copies. No datasets, model calls or runtime raw tracing. */
import { createHash, createHmac } from 'node:crypto';
import { lstat, readFile, rename, writeFile, unlink, readdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { LangfuseClient } from '../packages/ops/src/langfuse';
import { readOnlyPool, selectDatabaseReview, type Candidate } from './review-sample';

export const REVIEW_ENVIRONMENT = 'production-review';
export const REVIEW_DIMENSIONS = ['ai_disclosure', 'privacy', 'fabrication', 'meta_talk', 'voice', 'language'].map(name =>
  ({ name: `weekly_${name}`, minValue: 0, maxValue: 3, description: 'Human severity: 0 pass, 1 minor, 2 major, 3 critical' }));
const API_OPTIONS = { maxRetries: 0, timeoutInSeconds: 2 };
interface Payload { originalRunAt: string; input: string; output: string; metadata: Record<string, string | boolean> }
interface Span { traceId: string; id: string; end(): unknown }
interface Journal { sourceKey: string; digest: string; originalRunAt: string; projectId: string; queueId: string;
  state: 'reserved' | 'trace-pending' | 'exported' | 'queue-pending' | 'queued'; traceId?: string; observationId?: string; itemId?: string }
export interface ReviewExportOptions { apply?: boolean; confirmProject?: string; queueId: string; stateDir: string; salt: string; approval?: string }
export interface ReviewExportDeps { client: LangfuseClient; now: Date; create(payload: Payload): Span; flush(): Promise<boolean>; persistenceMs?: number }

async function privateDirectory(dir: string): Promise<void> {
  const info = await lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error('PRIVATE_REVIEW_STATE_REQUIRED');
}
async function readJournal(file: string): Promise<Journal | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid?.() || info.size > 8192) throw new Error('PRIVATE_REVIEW_JOURNAL_INVALID');
    const entry = JSON.parse(await readFile(file, 'utf8')) as Journal;
    const allowed = ['sourceKey', 'digest', 'originalRunAt', 'projectId', 'queueId', 'state', 'traceId', 'observationId', 'itemId'];
    if (!entry || typeof entry !== 'object' || Object.keys(entry).some(key => !allowed.includes(key))
      || !/^[a-f0-9]{64}$/.test(entry.sourceKey) || !/^[a-f0-9]{64}$/.test(entry.digest)
      || typeof entry.originalRunAt !== 'string' || !Number.isFinite(Date.parse(entry.originalRunAt))
      || typeof entry.projectId !== 'string' || !entry.projectId || typeof entry.queueId !== 'string' || !entry.queueId
      || !['reserved', 'trace-pending', 'exported', 'queue-pending', 'queued'].includes(entry.state)
      || (entry.state !== 'reserved' && (!/^[a-f0-9]{32}$/.test(entry.traceId ?? '') || !/^[a-f0-9]{16}$/.test(entry.observationId ?? '')))
      || (entry.state === 'queued' && (typeof entry.itemId !== 'string' || !entry.itemId))) throw new Error('PRIVATE_REVIEW_JOURNAL_INVALID');
    return entry;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
async function saveJournal(file: string, entry: Journal, reserve = false): Promise<void> {
  const temporary = reserve ? file : `${file}.pending`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(entry)); await handle.sync(); } finally { await handle.close(); }
  if (!reserve) await rename(temporary, file);
  const directory = await open(resolve(file, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
function cleanReviewText(value: string, redact: (value: unknown) => unknown): string {
  return String(redact(value)).replace(/https?:\/\/[^\s<>]+/gi, '[URL]').replace(/(?:\/(?:home|tmp|etc|app)\/)[^\s]+/g, '[PATH]');
}
async function queueItems(client: LangfuseClient, queueId: string) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const response = await client.api.annotationQueues.listQueueItems(queueId, { page, limit: 100 }, API_OPTIONS);
    if (response.data.some(item => item.queueId !== queueId)) throw new Error('REVIEW_QUEUE_SCOPE_MISMATCH');
    items.push(...response.data);
    if (page >= response.meta.totalPages) return items;
  }
  throw new Error('REVIEW_QUEUE_LIMIT');
}
async function verifyObservation(deps: ReviewExportDeps, entry: Journal): Promise<void> {
  const budget = deps.persistenceMs ?? 8000;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 10000) throw new Error('REVIEW_READBACK_BUDGET');
  const deadline = Date.now() + budget;
  do {
    const response = await deps.client.api.observations.getMany({ traceId: entry.traceId, environment: REVIEW_ENVIRONMENT,
      fields: 'core,basic,time,trace_context,metadata', name: 'production-review', limit: 100 }, API_OPTIONS);
    const rows = response.data.filter(row => row.id === entry.observationId);
    if (rows.length) {
      const row = rows[0]!; const metadata = row.metadata as Record<string, unknown> | null;
      if (rows.length !== 1 || row.traceId !== entry.traceId || row.projectId !== entry.projectId
        || row.environment !== REVIEW_ENVIRONMENT || row.name !== 'production-review' || row.isRootObservation !== true
        || Date.parse(row.startTime) !== Date.parse(entry.originalRunAt) || !row.endTime || Date.parse(row.endTime) !== Date.parse(entry.originalRunAt) || !metadata
        || metadata.managedBy !== 'ptr-production-review' || metadata.sourceKey !== entry.sourceKey
        || metadata.originalRunAt !== entry.originalRunAt || metadata.payloadDigest !== entry.digest
        || metadata.capturePolicy !== 'approved-redacted-final-turn-copy-v1') throw new Error('REVIEW_OBSERVATION_BINDING_MISMATCH');
      return;
    }
    if (Date.now() >= deadline) break;
    await new Promise(done => setTimeout(done, Math.min(100, Math.max(1, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw new Error('REVIEW_OBSERVATION_UNVERIFIED');
}

/** Root private configuration and exact project confirmation authorize mutation, never the serving process. */
export async function exportProductionReview(candidates: Candidate[], options: ReviewExportOptions, deps: ReviewExportDeps) {
  if (!options.queueId || !/^[a-f0-9]{64}$/.test(options.salt) || candidates.length > 100 || !Number.isFinite(deps.now.getTime())) throw new Error('REVIEW_SCOPE_INVALID');
  if (candidates.some(row => row.source !== 'DB' || !row.finishedAt || !Number.isFinite(Date.parse(row.finishedAt))
    || Date.parse(row.finishedAt) > deps.now.getTime() || Date.parse(row.finishedAt) <= deps.now.getTime() - 90 * 86400000)) throw new Error('REVIEW_SOURCE_CLOCK_INVALID');
  const projects = await deps.client.api.projects.get(API_OPTIONS);
  if (projects.data.length !== 1) throw new Error('REVIEW_PROJECT_SCOPE_INVALID');
  const projectId = projects.data[0]!.id;
  if (options.apply && (options.confirmProject !== projectId || options.approval !== 'approved-redacted-final-turn-review')) throw new Error('REVIEW_EXPLICIT_APPROVAL_REQUIRED');
  const queue = await deps.client.api.annotationQueues.getQueue(options.queueId, API_OPTIONS);
  if (queue.id !== options.queueId || queue.scoreConfigIds.length !== REVIEW_DIMENSIONS.length || new Set(queue.scoreConfigIds).size !== REVIEW_DIMENSIONS.length) throw new Error('REVIEW_RUBRIC_MISMATCH');
  const names = [];
  for (const id of queue.scoreConfigIds) {
    const score = await deps.client.api.scoreConfigs.getById(id, API_OPTIONS);
    if (score.dataType !== 'NUMERIC' || score.minValue !== 0 || score.maxValue !== 3 || score.isArchived) throw new Error('REVIEW_RUBRIC_MISMATCH');
    names.push(score.name);
  }
  if (JSON.stringify(names.sort()) !== JSON.stringify(REVIEW_DIMENSIONS.map(d => d.name).sort())) throw new Error('REVIEW_RUBRIC_MISMATCH');
  const counts = { planned: candidates.length, exported: 0, queued: 0, existing: 0, applied: options.apply === true };
  if (!options.apply) return counts;
  const { redactTelemetry } = await import('../packages/ops/src/langfuse');
  await privateDirectory(options.stateDir);
  // Exclusive invocation lock. A crash leaves it fail-closed until operator reconciliation.
  const lock = join(options.stateDir, 'production-review.lock');
  await writeFile(lock, '', { flag: 'wx', mode: 0o600 });
  try {
    for (const row of candidates) {
      const sourceKey = createHmac('sha256', Buffer.from(options.salt, 'hex')).update(JSON.stringify([projectId, options.queueId, row.id, row.finishedAt])).digest('hex');
      const input = cleanReviewText(row.userText, redactTelemetry), output = cleanReviewText(row.reply, redactTelemetry);
      if (Buffer.byteLength(JSON.stringify({ input, output }), 'utf8') > 65536) throw new Error('REVIEW_PAYLOAD_BYTE_LIMIT');
      const digest = createHash('sha256').update(JSON.stringify([input, output])).digest('hex');
      const payload: Payload = { originalRunAt: row.finishedAt!, input, output, metadata: { managedBy: 'ptr-production-review', sourceKey,
        originalRunAt: row.finishedAt!, payloadDigest: digest, capturePolicy: 'approved-redacted-final-turn-copy-v1',
        originalRuntimeTraceLinked: false, notANewModelExecution: true } };
      if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > 65536) throw new Error('REVIEW_PAYLOAD_BYTE_LIMIT');
      const file = join(options.stateDir, `${sourceKey}.json`);
      let entry = await readJournal(file);
      if (entry && (entry.sourceKey !== sourceKey || entry.digest !== digest || entry.originalRunAt !== row.finishedAt
        || entry.projectId !== projectId || entry.queueId !== options.queueId)) throw new Error('REVIEW_JOURNAL_BINDING_MISMATCH');
      if (!entry) {
        entry = { sourceKey, digest, originalRunAt: row.finishedAt!, projectId, queueId: options.queueId, state: 'reserved' };
        await saveJournal(file, entry, true);
        const span = deps.create(payload);
        if (!/^[a-f0-9]{32}$/.test(span.traceId) || !/^[a-f0-9]{16}$/.test(span.id)) throw new Error('REVIEW_NATIVE_IDS_REQUIRED');
        entry = { ...entry, traceId: span.traceId, observationId: span.id, state: 'trace-pending' };
        await saveJournal(file, entry); // Persist actual SDK IDs before any finished-span export.
        span.end();
        if (!await deps.flush()) throw new Error('REVIEW_EXPORT_UNKNOWN');
        counts.exported++;
      }
      if (!entry.traceId || !entry.observationId || entry.state === 'reserved') throw new Error('REVIEW_UNKNOWN_RESERVATION');
      await verifyObservation(deps, entry);
      const matching = (await queueItems(deps.client, options.queueId)).filter(item => item.objectId === entry!.traceId);
      if (matching.length > 1 || matching.some(item => item.objectType !== 'TRACE')) throw new Error('REVIEW_QUEUE_BINDING_MISMATCH');
      if (matching[0]) {
        const actual = await deps.client.api.annotationQueues.getQueueItem(options.queueId, matching[0].id, API_OPTIONS);
        if (actual.queueId !== options.queueId || actual.objectId !== entry.traceId || actual.objectType !== 'TRACE') throw new Error('REVIEW_QUEUE_BINDING_MISMATCH');
        await saveJournal(file, { ...entry, state: 'queued', itemId: actual.id }); counts.existing++; continue;
      }
      if (entry.state === 'queue-pending' || entry.state === 'queued') throw new Error('REVIEW_QUEUE_WRITE_UNKNOWN');
      entry = { ...entry, state: 'queue-pending' }; await saveJournal(file, entry);
      const created = await deps.client.api.annotationQueues.createQueueItem(options.queueId, { objectId: entry.traceId!, objectType: 'TRACE' }, API_OPTIONS);
      const actual = await deps.client.api.annotationQueues.getQueueItem(options.queueId, created.id, API_OPTIONS);
      if (actual.queueId !== options.queueId || actual.objectId !== entry.traceId || actual.objectType !== 'TRACE') throw new Error('REVIEW_QUEUE_BINDING_MISMATCH');
      await saveJournal(file, { ...entry, state: 'queued', itemId: actual.id }); counts.queued++;
    }
    return counts;
  } finally { await unlink(lock); }
}

async function main() {
  const args = process.argv.slice(2); const allowed = new Set(['--since', '--seed', '--queue', '--state-dir', '--apply', '--confirm-project', '--status']);
  for (let i = 0; i < args.length; i++) { if (!allowed.has(args[i]!)) throw new Error('REVIEW_USAGE'); if (!['--apply', '--status'].includes(args[i]!)) { if (!args[++i] || args[i]!.startsWith('--')) throw new Error('REVIEW_USAGE'); } }
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  const stateDir = args.includes('--state-dir') ? resolve(value('--state-dir')!) : '';
  if (args.includes('--status')) {
    await privateDirectory(stateDir); const files = await readdir(stateDir); const counts: Record<string, number> = { journals: 0, unknown: 0, queued: 0, locked: files.includes('production-review.lock') ? 1 : 0 };
    for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) { const entry = await readJournal(join(stateDir, file)); counts.journals!++; if (entry?.state === 'queued') counts.queued!++; else counts.unknown!++; }
    console.log(JSON.stringify(counts)); return;
  }
  const since = /^([1-7])d$/.exec(value('--since') ?? ''); const seed = value('--seed');
  if (!since || !/^\d{1,9}$/.test(seed ?? '') || !args.includes('--queue') || !stateDir) throw new Error('REVIEW_USAGE');
  if (args.includes('--apply') && process.env.PTR_PRODUCTION_REVIEW_APPROVAL !== 'approved-redacted-final-turn-review') throw new Error('REVIEW_EXPLICIT_APPROVAL_REQUIRED');
  const [{ createNativeReviewSpan }, { createLangfuseClient, FrameworkTelemetry }, { evaluationConfig }] = await Promise.all([
    import('../packages/ops/src/production-review-transport'),
    import('../packages/ops/src/langfuse'),
    import('./framework-evaluate'),
  ]);
  const config = { ...evaluationConfig(), environment: REVIEW_ENVIRONMENT, captureContent: true };
  const client = createLangfuseClient(config); const telemetry = new FrameworkTelemetry(config);
  try {
    const now = new Date(); const rows = await selectDatabaseReview(Number(since[1]), Number(seed), { root: resolve(__dirname, '..'), env: process.env, now, connect: readOnlyPool, out: () => undefined, err: () => undefined });
    const result = await exportProductionReview(rows, { queueId: value('--queue')!, stateDir, apply: args.includes('--apply'),
      confirmProject: args.includes('--confirm-project') ? value('--confirm-project') : undefined,
      salt: process.env.PTR_PRODUCTION_REVIEW_SALT ?? '', approval: process.env.PTR_PRODUCTION_REVIEW_APPROVAL },
    { client, now, flush: () => telemetry.flush(), create: createNativeReviewSpan });
    console.log(JSON.stringify(result));
  } finally { await telemetry.shutdown(); await client.shutdown(); }
}
if (require.main === module) void main().catch(() => { console.error('production-review: failed (private details withheld)'); process.exitCode = 1; });
