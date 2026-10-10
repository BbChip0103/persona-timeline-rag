/** Synthetic non-root packaging probe. No database, queue, LLM endpoint or private inputs. */
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { createApiApplication } from '../../apps/api/src/app';
import type { SplitApiRuntime } from '../../apps/api/src/split-runtime';

async function main() {
  assert.equal(process.getuid?.(), 900);
  const forbidden = /(?:langchain|langfuse|(?:^|\/)openai(?:@|\/)|litellm)/i;
  assert.equal(readdirSync('/app/node_modules/.pnpm').filter(name => forbidden.test(name)).length, 0);
  for (const path of ['data', 'reports', 'packages/providers', 'apps/llm-service', 'apps/api/src/runtime.ts', 'apps/api/src/worker.ts']) {
    assert.equal(existsSync(`/app/${path}`), false, `unexpected image path: ${path}`);
  }
  let closed = 0;
  const runtime = {
    kind: 'split', providerName: 'synthetic', model: 'synthetic/no-provider', billable: false,
    controlToken: 'synthetic-control-token-000000000000',
    health: async () => ({ database: true, redis: true }), listPersonas: async () => [],
    close: async () => { closed++; },
  } as unknown as SplitApiRuntime;
  const app = await createApiApplication(runtime, 'synthetic-public-token-000000000000');
  try {
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/api/personas`)).status, 403);
    assert.equal(Object.keys(require.cache).filter(path => forbidden.test(path)).length, 0);
  } finally {
    await app.close();
  }
  assert.equal(closed, 1);
  console.log(JSON.stringify({ status: 'PASS', uid: 900, llmSdkInstalled: 0, llmSdkLoaded: 0, httpStartupShutdown: true }));
}
void main().catch(() => { console.error('BACKEND_IMAGE_SMOKE_FAILED'); process.exitCode = 1; });
