import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(__dirname, '..', '..', '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

test('thin backend profile freezes only existing versions and excludes all LLM SDKs', () => {
  const profile = JSON.parse(read('infra/backend/package.json')) as { dependencies: Record<string, string> };
  const lock = read('infra/backend/pnpm-lock.yaml');
  const historicalLock = read('pnpm-lock.yaml');
  for (const [name, version] of Object.entries(profile.dependencies)) {
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(historicalLock).toContain(`${name}@${version}`);
  }
  expect(lock).not.toMatch(/@langchain|@langfuse|openai@|litellm/i);
  expect(profile.dependencies.tsx).toBeDefined();
});

test('final image copies the narrow split sources, never builder dependencies or legacy runtime', () => {
  const dockerfile = read('Dockerfile');
  const runtime = dockerfile.split('FROM node-base AS runtime')[1]!;
  expect(runtime).toContain('COPY --from=backend-deps /app/node_modules');
  expect(runtime).not.toContain('COPY --from=web-builder /app/node_modules');
  expect(runtime).not.toMatch(/COPY[^\n]*(?:packages\s|packages\/providers|src\/runtime\.ts|src\/worker\.ts|scripts\s)/);
  expect(runtime).toContain('apps/api/src/packaged-main.ts');
  expect(runtime).toContain('USER 900:2000');
  expect(runtime).toContain('contracts/llm/v1');
  expect(runtime).toContain('COPY --chmod=0755');
});

test('deployment gives Nest only generated artifacts and Python a separate read-only corpus', () => {
  const compose = read('infra/compose.app.yml');
  const backendMount = compose.split('x-data: &data')[1]!.split('services:')[0]!;
  expect(backendMount).toContain('source: ../data/generated');
  expect(backendMount).not.toMatch(/source: \.\.\/data\s*\n/);
  const worker = compose.split('  worker:')[1]!.split('  web:')[0]!;
  expect(worker).toContain('PTR_LLM_SERVICE_ENV_FILE:?');
  expect(worker).toContain('source: ../data\n');
  expect(worker).toContain('read_only: true');
});

test.each([
  [{ PTR_LLM_SERVICE_MODE: 'legacy' }, 'LEGACY_RUNTIME_NOT_PACKAGED'],
  [{ PTR_LLM_SERVICE_MODE: 'unexpected' }, 'INVALID_SERVICE_MODE'],
  [{ PTR_LLM_SERVICE_MODE: 'split', PTR_API_PORT: '0' }, 'INVALID_PORT'],
])('packaged startup rejects invalid mode or port before connecting to resources (%s)', (settings, code) => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/api/src/packaged-main.ts'], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...settings },
  });
  expect(result.status).toBe(1);
  expect(result.stderr.trim()).toBe(`API_STARTUP_FAILED ${code}`);
  expect(result.stdout).toBe('');
});
