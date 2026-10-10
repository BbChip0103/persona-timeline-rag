import { context, trace } from '@opentelemetry/api';
import { FrameworkTelemetry, redactTelemetry, validateLangfuseConfig } from '../src/langfuse';
import { SyntheticLangfuseServer } from '../../../scripts/framework-langfuse.test-helper';

describe('Langfuse OTel SDK against synthetic local receiver', () => {
  let server: SyntheticLangfuseServer;
  let telemetry: FrameworkTelemetry;
  beforeAll(async () => {
    server = new SyntheticLangfuseServer(); await server.start();
    telemetry = new FrameworkTelemetry({ enabled: true, baseUrl: server.baseUrl, publicKey: 'synthetic-public', secretKey: 'synthetic-secret', environment: 'synthetic', release: 'test-v1', allowInsecureLocal: true, captureContent: true, timeoutMs: 1500 });
  });
  afterAll(async () => { await telemetry.shutdown(); trace.disable(); context.disable(); await server.close(); });

  it('exports one turn with nested graph/model, usage, cost and no secret sentinel', async () => {
    const output = await telemetry.turn({ turnId: 't1', sessionId: 's1', personId: 'p1', userId: 'u1', input: { question: 'synthetic hello', apiKey: 'SECRET_SENTINEL' } }, () => telemetry.stage('retrieve', async retrieval => {
      retrieval.update({ metadata: { count: 2, rawEvidence: 'PRIVATE_SENTINEL' } });
      return telemetry.generation('model', async generation => { generation.update({ model: 'synthetic-model', usageDetails: { input: 5, output: 7 }, costDetails: { total: 0.001 }, input: 'me@example.com', output: 'synthetic response' }); return 'synthetic response'; });
    }));
    expect(output).toBe('synthetic response'); expect(await telemetry.flush()).toBe(true);
    const exports = server.requests.filter(request => request.path.endsWith('/otel/v1/traces'));
    expect(exports.length).toBeGreaterThan(0);
    expect(exports[0].headers['x-langfuse-ingestion-version']).toBe('4');
    const payload = Buffer.concat(exports.map(request => request.body)).toString();
    expect(payload).toContain('synthetic-model'); expect(payload).toContain('synthetic response');
    expect(payload).not.toContain('SECRET_SENTINEL'); expect(payload).not.toContain('PRIVATE_SENTINEL'); expect(payload).not.toContain('me@example.com');
    expect(telemetry.diagnostics()).toMatchObject({ turns: 1, observations: 3 });
    expect(telemetry.diagnostics().authoredPayloadBytes).toBeGreaterThan(0);
  });

  it('preserves task errors but does not export raw exception text', async () => {
    await expect(telemetry.stage('failure', async () => { throw new Error('ERROR_SECRET_SENTINEL'); })).rejects.toThrow('ERROR_SECRET_SENTINEL');
    await telemetry.flush();
    expect(Buffer.concat(server.requests.map(request => request.body)).toString()).not.toContain('ERROR_SECRET_SENTINEL');
  });

  it('does not await unreachable export during normal task execution', async () => {
    server.hangExports = true;
    const started = performance.now();
    expect(await telemetry.stage('export_failure', async () => 7)).toBe(7);
    expect(performance.now() - started).toBeLessThan(100);
    await telemetry.flush();
    server.hangExports = false;
  });
});

describe('content-disabled turn outcome telemetry', () => {
  it('exports explicitly sanitized outcome metadata without user/model bodies', async () => {
    const server = new SyntheticLangfuseServer(); await server.start();
    const telemetry = new FrameworkTelemetry({ enabled: true, baseUrl: server.baseUrl, publicKey: 'synthetic-public', secretKey: 'synthetic-secret', environment: 'synthetic', release: 'test-v1', allowInsecureLocal: true, captureContent: false });
    try {
      await telemetry.turn({ turnId: 'outcome', sessionId: 'session', personId: 'person', input: 'PRIVATE_INPUT_SENTINEL' }, async span => {
        span.update({ metadata: { turnState: 'completed', evidenceCount: 2, guardAction: 'none', rawEvidence: 'PRIVATE_EVIDENCE_SENTINEL' } });
        return 'PRIVATE_OUTPUT_SENTINEL';
      });
      expect(await telemetry.flush()).toBe(true);
      const payload = Buffer.concat(server.requests.filter(request => request.path.endsWith('/otel/v1/traces')).map(request => request.body)).toString();
      expect(payload).toContain('turnState'); expect(payload).toContain('completed'); expect(payload).toContain('evidenceCount');
      expect(payload).not.toContain('PRIVATE_INPUT_SENTINEL'); expect(payload).not.toContain('PRIVATE_OUTPUT_SENTINEL'); expect(payload).not.toContain('PRIVATE_EVIDENCE_SENTINEL');
    } finally { await telemetry.shutdown(); trace.disable(); context.disable(); await server.close(); }
  });
});

describe('telemetry configuration/privacy', () => {
  it('disabled telemetry has zero effects', async () => {
    const telemetry = new FrameworkTelemetry({ enabled: false, environment: 'synthetic', release: 'x' });
    expect(await telemetry.turn({ turnId: 't', personId: 'p', sessionId: 's' }, async () => 1)).toBe(1);
    expect(telemetry.diagnostics().observations).toBe(0); expect(await telemetry.shutdown()).toBe(true);
  });
  it('never silently exports to cloud without explicit credentials/base URL', () => {
    expect(() => validateLangfuseConfig({ enabled: true, environment: 'test', release: 'v1' })).toThrow();
    expect(() => validateLangfuseConfig({ enabled: true, baseUrl: 'http://example.org', publicKey: 'p', secretKey: 's', environment: 'test', release: 'v1', allowInsecureLocal: true })).toThrow('TLS');
  });
  it('redacts keys, tokens, email and base64 media with bounded size/depth', () => {
    expect(redactTelemetry({ cookie: 'sentinel', foo: 'Bearer abc abc@example.com data:image/png;base64,YWJj' })).toEqual({ cookie: '[REDACTED]', foo: '[REDACTED] [EMAIL] [MEDIA]' });
    expect((redactTelemetry('x'.repeat(20000)) as string).length).toBe(16384);
  });
});
