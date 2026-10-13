/** Thin service image entrypoint: historical in-process LLM runtime is not packaged. */
import { createApiApplication } from './app';
import { createSplitRuntime } from './split-runtime';
import { apiBindHost } from './bind-host';

async function main(): Promise<void> {
  const mode = process.env.PTR_LLM_SERVICE_MODE;
  if (mode !== undefined && mode !== 'split') {
    throw Object.assign(new Error('Unsupported packaged runtime'), {
      code: mode === 'legacy' ? 'LEGACY_RUNTIME_NOT_PACKAGED' : 'INVALID_SERVICE_MODE',
    });
  }
  const port = Number(process.env.PTR_API_PORT ?? 56441);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw Object.assign(new Error('Invalid port'), { code: 'INVALID_PORT' });
  }
  const host = apiBindHost(process.env.PTR_API_HOST);
  const runtime = createSplitRuntime();
  let app: Awaited<ReturnType<typeof createApiApplication>> | undefined;
  try {
    app = await createApiApplication(runtime, process.env.PTR_API_TOKEN ?? '', {
      syntheticToken: process.env.PTR_API_SYNTHETIC_TOKEN || undefined,
    });
    await app.listen(port, host);
  } catch (error) {
    if(app) await app.close().catch(() => undefined);
    else await runtime.close().catch(() => undefined);
    throw error;
  }
  process.stdout.write(`Research API listening on ${host}:${port}\n`);
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void app!.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

void main().catch((error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  const safeCode = typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? ` ${code}` : '';
  process.stderr.write(`API_STARTUP_FAILED${safeCode}\n`);
  process.exitCode = 1;
});
