import { context, trace } from '@opentelemetry/api';
import { FrameworkTelemetry } from '../src/langfuse';
import { createNativeReviewSpan } from '../src/production-review-transport';
import { SyntheticLangfuseServer } from '../../../scripts/framework-langfuse.test-helper';

it('installed native SDK creates an independent review root even inside an ambient runtime span', async () => {
  const server = new SyntheticLangfuseServer(); await server.start();
  const telemetry = new FrameworkTelemetry({ enabled: true, baseUrl: server.baseUrl, publicKey: 'synthetic-public', secretKey: 'synthetic-secret',
    environment: 'production-review', release: 'synthetic-review-transport', allowInsecureLocal: true, captureContent: true });
  try {
    const originalRunAt = '2026-10-01T00:00:00.000Z';
    await telemetry.stage('ambient-runtime', async () => {
      const ambientId = trace.getSpan(context.active())!.spanContext().traceId;
      const review = createNativeReviewSpan({ originalRunAt, input: 'Synthetic review input', output: 'Synthetic final reply', metadata: { originalRunAt, originalRuntimeTraceLinked: false } });
      expect(review.traceId).toMatch(/^[a-f0-9]{32}$/); expect(review.id).toMatch(/^[a-f0-9]{16}$/);
      expect(review.traceId).not.toBe(ambientId); review.end();
    });
    expect(await telemetry.flush()).toBe(true);
    const requests = server.requests.filter(row => row.path.endsWith('/otel/v1/traces'));
    const wire = Buffer.concat(requests.map(row => row.body)).toString();
    expect(wire).toContain('production-review'); expect(wire).toContain('Synthetic final reply');
    expect(wire).toContain('2026-10-01T00:00:00.000Z'); expect(requests[0]!.headers['x-langfuse-ingestion-version']).toBe('4');
  } finally { await telemetry.shutdown(); trace.disable(); context.disable(); await server.close(); }
});
