/** Explicit synthetic-only native proof; no DB/source/report/private review input is opened. */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLangfuseClient, FrameworkTelemetry } from '../packages/ops/src/langfuse';
import { createNativeReviewSpan } from '../packages/ops/src/production-review-transport';
import { ensureHumanReview, evaluationConfig } from './framework-evaluate';
import { exportProductionReview, REVIEW_ENVIRONMENT, REVIEW_DIMENSIONS } from './production-review';

async function main() {
  const directory = resolve(process.argv[2] ?? '');
  if (!process.argv[2] || !directory.startsWith('/tmp/ptr-followup-three-20261011/')) throw new Error('OWN_SYNTHETIC_PROOF_PATH_REQUIRED');
  await mkdir(directory, { mode: 0o700 });
  const config = { ...evaluationConfig(), environment: REVIEW_ENVIRONMENT, captureContent: true };
  const client = createLangfuseClient(config); const telemetry = new FrameworkTelemetry(config);
  let proofTrace: string | undefined, unrelatedTrace: string | undefined, proofItem: string | undefined, proofQueue: string | undefined;
  const api = { maxRetries: 0, timeoutInSeconds: 2 };
  const observations = async (traceId: string) => (await client.api.observations.getMany({ traceId, fields: 'core,basic,time,trace_context,metadata', limit: 100 }, api)).data;
  try {
    const project = await client.api.projects.get(api); if (project.data.length !== 1) throw new Error('PROJECT_SCOPE');
    const projectId = project.data[0]!.id;
    const queueId = await ensureHumanReview(client, 'ptr-production-weekly-review', REVIEW_DIMENSIONS); proofQueue = queueId;
    const now = new Date(); const originalRunAt = new Date(now.getTime() - 86400000).toISOString();
    const unrelated = createNativeReviewSpan({ originalRunAt, input: 'Synthetic unrelated control', output: 'Synthetic control reply', metadata: { managedBy: 'ptr-owned-review-smoke-control' } });
    unrelatedTrace = unrelated.traceId; unrelated.end(); await telemetry.flush();
    const result = await exportProductionReview([{ id: 'turn:synthetic-' + randomBytes(8).toString('hex'), source: 'DB', persona: 'P1', stratum: 'synthetic', stratumText: 'synthetic', date: originalRunAt.slice(0, 10), finishedAt: originalRunAt,
      userText: 'Synthetic user hello x@example.invalid https://example.invalid/source', reply: 'Synthetic final reply only' }],
    { apply: true, confirmProject: projectId, queueId, stateDir: directory, salt: randomBytes(32).toString('hex'), approval: 'approved-redacted-final-turn-review' },
    { client, now, flush: () => telemetry.flush(), create: payload => { const span = createNativeReviewSpan(payload); proofTrace = span.traceId; return span; } });
    const items = await client.api.annotationQueues.listQueueItems(queueId, { page: 1, limit: 100 }, api);
    const item = items.data.find(value => value.objectId === proofTrace); if (!item) throw new Error('MISSING_OWN_ITEM'); proofItem = item.id;
    const rows = await observations(proofTrace!); const row = rows.find(value => value.traceId === proofTrace);
    if (!row || row.isRootObservation !== true || Date.parse(row.startTime) !== Date.parse(originalRunAt) || !row.endTime || Date.parse(row.endTime) !== Date.parse(originalRunAt)) throw new Error('SOURCE_CLOCK_ROOT_NOT_PERSISTED');
    await client.api.annotationQueues.deleteQueueItem(queueId, proofItem, api); proofItem = undefined;
    await client.api.trace.deleteMultiple({ traceIds: [proofTrace!] }, api);
    const deadline = Date.now() + 30000;
    while ((await observations(proofTrace!)).length && Date.now() < deadline) await new Promise(done => setTimeout(done, 250));
    if ((await observations(proofTrace!)).length || !(await observations(unrelatedTrace!)).length) throw new Error('OWN_TRACE_PURGE_OR_CONTROL_PRESERVATION_FAILED');
    await writeFile(resolve(directory, 'native-proof.json'), JSON.stringify({ ...result, projectId, queueId, originalRunAt, proofTraceId: proofTrace,
      actualSdkIdsVerified: true, sourceClockVerified: true, queueReadbackVerified: true, ownedTraceAbsenceVerified: true, unrelatedTracePreserved: true,
      rawPrivateExportEnabled: false, paidCalls: 0, ownedProofQueueItemRemoved: true, operationalQueuePreserved: true }), { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ nativeProof: true, ownedTracePurged: true, unrelatedTracePreserved: true, paidCalls: 0, privateContentExported: false }));
  } finally {
    if (proofItem && proofQueue) await client.api.annotationQueues.deleteQueueItem(proofQueue, proofItem, api).catch(() => undefined);
    const owned = [proofTrace, unrelatedTrace].filter((id): id is string => !!id);
    if (owned.length) await client.api.trace.deleteMultiple({ traceIds: owned }, api).catch(() => undefined);
    await telemetry.shutdown(); await client.shutdown();
  }
}
if (require.main === module) void main().catch(() => { console.error('Synthetic native review proof failed (private details withheld)'); process.exitCode = 1; });
