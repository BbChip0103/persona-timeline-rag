import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest { method: string; path: string; body: Buffer; headers: Record<string, string | string[] | undefined> }
interface FakeDataset { id: string; name: string; metadata?: unknown; description?: string; createdAt: string; updatedAt: string }
export class SyntheticLangfuseServer {
  readonly requests: FakeRequest[] = [];
  readonly datasets = new Map<string, FakeDataset>();
  readonly items = new Map<string, Record<string, unknown>>();
  readonly configs = new Map<string, Record<string, unknown>>();
  readonly queues = new Map<string, Record<string, unknown>>();
  readonly queueItems = new Map<string, Record<string, unknown>>();
  readonly scores = new Map<string, Record<string, unknown>>();
  observations: Array<Record<string, unknown>> = [];
  failExports = false;
  failScores = false;
  dropScoreIngestion = false;
  hangExports = false;
  baseUrl = '';
  private readonly server: Server;
  constructor() {
    this.server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const url = new URL(request.url!, 'http://localhost');
      const actualPath = decodeURIComponent(url.pathname);
      const path = actualPath.replace('/api/public/v2/datasets', '/api/public/datasets');
      this.requests.push({ method: request.method!, path: actualPath, body: raw, headers: request.headers });
      const parsed = raw.length && request.headers['content-type']?.includes('json') ? JSON.parse(raw.toString()) as Record<string, unknown> : {};
      const now = new Date().toISOString();
      const result = (body: unknown, code = 200) => { response.writeHead(code, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
      const page = (data: unknown[]) => ({ data, meta: { page: 1, limit: 100, totalItems: data.length, totalPages: 1 } });
      if (path === '/api/public/otel/v1/traces') {
        if (this.hangExports) return;
        result({}, this.failExports ? 503 : 200); return;
      }
      if (path === '/api/public/scores' && request.method === 'POST') {
        if (this.failScores) { result({ message: 'synthetic score failure' }, 503); return; }
        this.scores.set(String(parsed.id), parsed); result({ id: parsed.id }); return;
      }
      if (path === '/api/public/ingestion') {
        const batch = parsed.batch as Array<{ id: string; type: string; body: Record<string, unknown> }>;
        for (const event of batch) if (!this.dropScoreIngestion && event.type === 'score-create') this.scores.set(String(event.body.id), event.body);
        result({ successes: batch.map(event => ({ id: event.id, status: 201 })), errors: [] }, 207); return;
      }
      if (path === '/api/public/v3/scores' && request.method === 'GET') {
        const traceId = url.searchParams.get('traceId');
        result({ data: [...this.scores.values()].filter(score => !traceId || score.traceId === traceId).map(score => ({ ...score, dataType: score.dataType ?? (typeof score.value === 'string' ? 'CATEGORICAL' : 'NUMERIC') })), meta: { limit: 100 } }); return;
      }
      if (path === '/api/public/dataset-run-items' && request.method === 'POST') { result({ id: 'synthetic-run-link', datasetRunId: `run-${parsed.runName}`, datasetItemId: parsed.datasetItemId, traceId: parsed.traceId, observationId: parsed.observationId, createdAt: now, updatedAt: now }); return; }
      if (path === '/api/public/projects') { result({ data: [{ id: 'synthetic-project', name: 'synthetic' }] }); return; }
      if (path === '/api/public/v2/observations') {
        const to = url.searchParams.get('toStartTime'); const env = url.searchParams.get('environment');
        result({ data: this.observations.filter(item => (!to || String(item.startTime) < to) && (!env || item.environment === env)), meta: { cursor: null } }); return;
      }
      if (path === '/api/public/datasets' && request.method === 'POST') {
        const name = String(parsed.name); const dataset = { ...parsed, id: `dataset-${name}`, name, createdAt: now, updatedAt: now };
        this.datasets.set(name, dataset); result(dataset); return;
      }
      if (path.startsWith('/api/public/datasets/') && request.method === 'GET') {
        const dataset = this.datasets.get(path.slice('/api/public/datasets/'.length));
        result(dataset ?? { message: 'not found' }, dataset ? 200 : 404); return;
      }
      if (path === '/api/public/dataset-items' && request.method === 'POST') {
        const dataset = this.datasets.get(String(parsed.datasetName));
        const item = { ...parsed, datasetId: dataset?.id, status: 'ACTIVE', sourceTraceId: null, sourceObservationId: null, mediaReferences: [], createdAt: now, updatedAt: now };
        this.items.set(String(parsed.id), item); result(item); return;
      }
      if (path === '/api/public/dataset-items' && request.method === 'GET') { result(page([...this.items.values()].filter(item => item.datasetName === url.searchParams.get('datasetName')))); return; }
      if (path.startsWith('/api/public/dataset-items/') && request.method === 'DELETE') { this.items.delete(path.split('/').at(-1)!); result({ success: true }); return; }
      if (path === '/api/public/score-configs' && request.method === 'GET') { result(page([...this.configs.values()])); return; }
      if (path.startsWith('/api/public/score-configs/') && request.method === 'GET') { result([...this.configs.values()].find(config => config.id === path.split('/').at(-1))); return; }
      if (path === '/api/public/score-configs' && request.method === 'POST') {
        const config = { ...parsed, id: `config-${parsed.name}`, projectId: 'synthetic-project', isArchived: false, createdAt: now, updatedAt: now };
        this.configs.set(String(parsed.name), config); result(config); return;
      }
      if (path === '/api/public/annotation-queues' && request.method === 'GET') { result(page([...this.queues.values()])); return; }
      if (path === '/api/public/annotation-queues' && request.method === 'POST') {
        const queue = { ...parsed, id: `queue-${parsed.name}`, projectId: 'synthetic-project', createdAt: now, updatedAt: now };
        this.queues.set(String(queue.id), queue); result(queue); return;
      }
      if (request.method === 'GET' && path.startsWith('/api/public/annotation-queues/') && !path.includes('/items')) { result(this.queues.get(path.split('/').at(-1)!)); return; }
      const match = path.match(/^\/api\/public\/annotation-queues\/([^/]+)\/items(?:\/([^/]+))?$/);
      if (match) {
        const [, queueId, itemId] = match;
        if (request.method === 'GET') { result(itemId ? this.queueItems.get(itemId) : page([...this.queueItems.values()].filter(item => item.queueId === queueId))); return; }
        if (request.method === 'POST') {
          const id = `item-${queueId}-${parsed.objectId}`; const item = { ...parsed, id, queueId, status: 'PENDING', createdAt: now, updatedAt: now };
          this.queueItems.set(id, item); result(item); return;
        }
        if (request.method === 'PATCH') { const item = { ...this.queueItems.get(itemId), ...parsed }; this.queueItems.set(itemId, item); result(item); return; }
        if (request.method === 'DELETE') { this.queueItems.delete(itemId); result({ success: true, message: 'deleted' }); return; }
      }
      if (path === '/api/public/traces' && request.method === 'DELETE') {
        const ids = new Set(parsed.traceIds as string[]); this.observations = this.observations.filter(item => !ids.has(String(item.traceId))); result({ success: true }); return;
      }
      result({ message: `Unexpected synthetic endpoint ${path}` }, 404);
    });
  }
  async start(): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> { this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve())); }
}
