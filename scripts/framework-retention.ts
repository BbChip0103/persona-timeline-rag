import type { LangfuseClient } from '../packages/ops/src/langfuse';
import { createLangfuseClient } from '../packages/ops/src/langfuse';
import { evaluationConfig } from './framework-evaluate';

export interface RetentionOptions {
  environment: string;
  /** Fixed start of managed history; no unreliable empty-month stopping heuristic. */
  from: string;
  now?: Date;
  days?: number;
  datasetNames?: string[];
  queueIds?: string[];
  apply?: boolean;
  /** Accept version tombstones only; historical dataset payloads are not erased. */
  allowLogicalDatasetDeletion?: boolean;
  confirmProject?: string;
  maxEntities?: number;
}
export interface RetentionPlan {
  projectId: string;
  environment: string;
  from: string;
  cutoff: string;
  traceIds: string[];
  datasetItems: Array<{ id: string; datasetName: string }>;
  queueItems: Array<{ id: string; queueId: string }>;
  applied: boolean;
  /** APIs submit asynchronous deletion; this is not proof of physical erasure. */
  deletionSubmitted: boolean;
  datasetDeletionSemantics: 'version-tombstone';
  /** Public item DELETE preserves historical versions; never claim hard erasure. */
  historicalDatasetErasureVerified: false;
}
const apiOptions = { maxRetries: 0, timeoutInSeconds: 5 };
function expired(timestamp: string, cutoff: string): boolean { return Number.isFinite(Date.parse(timestamp)) && Date.parse(timestamp) < Date.parse(cutoff); }

/** Project-scoped OSS public APIs only. All enumeration precedes any mutation. */
export async function retainFrameworkData(client: LangfuseClient, options: RetentionOptions): Promise<RetentionPlan> {
  const now = options.now ?? new Date();
  const days = options.days ?? 90;
  const maxEntities = options.maxEntities ?? 100000;
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(options.environment) || !Number.isFinite(now.getTime()) || !Number.isInteger(days) || days < 90 || !Number.isInteger(maxEntities) || maxEntities < 1) throw new Error('Invalid retention scope: minimum retention is 90 days');
  const cutoff = new Date(now.getTime() - days * 86400000).toISOString();
  if (!Number.isFinite(Date.parse(options.from)) || Date.parse(options.from) >= Date.parse(cutoff)) throw new Error('Retention requires explicit history start before cutoff');
  const projects = await client.api.projects.get(apiOptions);
  if (projects.data.length !== 1) throw new Error('Retention requires a single project-scoped credential');
  const projectId = projects.data[0].id;
  if (options.apply && options.confirmProject !== projectId) throw new Error('Destructive retention requires exact project confirmation');
  const plan: RetentionPlan = { projectId, environment: options.environment, from: new Date(options.from).toISOString(), cutoff, traceIds: [], datasetItems: [], queueItems: [], applied: false, deletionSubmitted: false,
    datasetDeletionSemantics: 'version-tombstone', historicalDatasetErasureVerified: false };
  const enforceLimit = () => { if (plan.traceIds.length + plan.datasetItems.length + plan.queueItems.length > maxEntities) throw new Error('Retention plan limit exceeded; subdivide the time range'); };
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const response = await client.api.observations.getMany({ fields: 'core,basic,time,trace_context', environment: options.environment,
      fromStartTime: plan.from, toStartTime: cutoff, isRootObservation: true, limit: 1000, cursor }, apiOptions);
    for (const observation of response.data) {
      if (observation.projectId !== projectId) throw new Error('Observation belongs to a different project');
      if (observation.environment !== options.environment || !expired(observation.startTime, cutoff)) throw new Error('Server returned observation outside retention scope');
      if (observation.traceId && !ids.has(observation.traceId)) { ids.add(observation.traceId); plan.traceIds.push(observation.traceId); enforceLimit(); }
    }
    cursor = response.meta.cursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error('Observation cursor repeated');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  for (const datasetName of new Set(options.datasetNames ?? [])) {
    if (!datasetName) throw new Error('Empty dataset scope');
    for (let page = 1; ; page++) {
      const response = await client.api.datasetItems.list({ datasetName, page, limit: 100 }, apiOptions);
      for (const item of response.data) {
        if (item.datasetName !== datasetName) throw new Error('Dataset item outside retention scope');
        const metadata = item.metadata && typeof item.metadata === 'object' ? item.metadata as Record<string, unknown> : {};
        // Reimporting historic content does not reset its retention clock.
        const retentionTime = typeof metadata.originalRunAt === 'string' ? metadata.originalRunAt : item.createdAt;
        if (expired(retentionTime, cutoff)) { plan.datasetItems.push({ id: item.id, datasetName }); enforceLimit(); }
      }
      if (page >= response.meta.totalPages) break;
    }
  }
  for (const queueId of new Set(options.queueIds ?? [])) {
    if (!queueId) throw new Error('Empty queue scope');
    for (let page = 1; ; page++) {
      const response = await client.api.annotationQueues.listQueueItems(queueId, { page, limit: 100 }, apiOptions);
      for (const item of response.data) {
        if (item.queueId !== queueId) throw new Error('Annotation item outside retention scope');
        if (expired(item.createdAt, cutoff) || ids.has(item.objectId)) { plan.queueItems.push({ id: item.id, queueId }); enforceLimit(); }
      }
      if (page >= response.meta.totalPages) break;
    }
  }
  if (!options.apply) return plan;
  // Check after complete inventory, before any write (including review/trace deletion).
  if (plan.datasetItems.length > 0 && options.allowLogicalDatasetDeletion !== true) {
    throw new Error('Logical dataset deletion requires explicit opt-in; historical dataset erasure is unsupported');
  }
  // Remove review links and logically remove dataset items; history remains.
  for (const item of plan.queueItems) await client.api.annotationQueues.deleteQueueItem(item.queueId, item.id, apiOptions);
  for (const item of plan.datasetItems) await client.api.datasetItems.delete(item.id, apiOptions);
  for (let start = 0; start < plan.traceIds.length; start += 1000) await client.api.trace.deleteMultiple({ traceIds: plan.traceIds.slice(start, start + 1000) }, apiOptions);
  plan.applied = true;
  plan.deletionSubmitted = plan.traceIds.length + plan.datasetItems.length + plan.queueItems.length > 0;
  return plan;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (flag: string) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
  const values = (flag: string) => args.flatMap((arg, i) => arg === flag && args[i + 1] ? [args[i + 1]] : []);
  const environment = value('--environment');
  const from = value('--from');
  if (!environment || !from) throw new Error('Explicit --environment and --from required');
  const client = createLangfuseClient(evaluationConfig());
  try {
    const plan = await retainFrameworkData(client, { environment, from, datasetNames: values('--dataset'), queueIds: values('--queue'),
      apply: args.includes('--apply'), confirmProject: value('--confirm-project'),
      allowLogicalDatasetDeletion: args.includes('--allow-logical-dataset-deletion') });
    console.log(JSON.stringify(plan));
  } finally { await client.shutdown(); }
}
if (require.main === module) void main().catch(() => { console.error('Retention failed; no secrets or payload details logged'); process.exitCode = 1; });
