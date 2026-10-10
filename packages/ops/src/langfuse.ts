import { createHash } from 'node:crypto';
import { LangfuseClient } from '@langfuse/client';
export type { LangfuseClient, Evaluator, ExperimentTask } from '@langfuse/client';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { propagateAttributes, startActiveObservation, type LangfuseGenerationAttributes } from '@langfuse/tracing';
import { NodeSDK } from '@opentelemetry/sdk-node';

export interface FrameworkTelemetryConfig {
  enabled: boolean;
  baseUrl?: string;
  publicKey?: string;
  secretKey?: string;
  environment: string;
  release: string;
  captureContent?: boolean;
  timeoutMs?: number;
  allowInsecureLocal?: boolean;
}

/** Explicit self-hosted endpoint: never silently fall back to Langfuse Cloud. */
export function validateLangfuseConfig(config: FrameworkTelemetryConfig): void {
  if (!config.enabled) return;
  if (!config.baseUrl || !config.publicKey || !config.secretKey) throw new Error('Langfuse endpoint and project credentials are required');
  const url = new URL(config.baseUrl);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid Langfuse endpoint');
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.hostname === 'langfuse-web';
  if (url.protocol !== 'https:' && !(config.allowInsecureLocal && local)) throw new Error('Langfuse requires TLS outside explicit local tests');
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(config.environment) || config.environment.startsWith('langfuse')) throw new Error('Invalid Langfuse environment');
  if (!config.release || config.release.length > 200) throw new Error('Langfuse release is required');
  if (config.timeoutMs !== undefined && (!Number.isFinite(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 10000)) throw new Error('Invalid Langfuse timeout');
}

const sensitiveKey = /(?:authorization|cookie|secret|api[_-]?key|password|credential|access[_-]?token|raw[_-]?(?:source|image|evidence)|private[_-]?evidence)/i;
function cleanText(text: string): string {
  const bounded = text.slice(0, 16384);
  return bounded
    .replace(/(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{8,}|pk-lf-[A-Za-z0-9_-]+)/gi, '[REDACTED]')
    .replace(/[^\s@]{1,128}@[^\s@]{1,128}\.[A-Za-z]{2,}/g, '[EMAIL]')
    .replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, '[MEDIA]')
    .replace(/\b(?:\+?\d[\d ()-]{7,}\d)\b/g, '[PHONE]')
    .slice(0, 16384);
}

/** Depth/size bound, secret-key stripping and no raw image/corpus exports. */
export function redactTelemetry(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[DEPTH_LIMIT]';
  if (typeof value === 'string') {
    if (/^\s*[\[{]/.test(value) && value.length <= 1048576) {
      try { return JSON.stringify(redactTelemetry(JSON.parse(value), depth + 1)); } catch { /* Ordinary text that happens to begin with a bracket. */ }
    }
    return cleanText(value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 64).map(item => redactTelemetry(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0, 64).map(([key, item]) => [key, sensitiveKey.test(key) ? '[REDACTED]' : redactTelemetry(item, depth + 1)]));
  return null;
}

export function pseudonymousId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function createLangfuseClient(config: FrameworkTelemetryConfig): LangfuseClient {
  validateLangfuseConfig(config);
  if (!config.enabled) throw new Error('Langfuse client requires explicit enabled configuration');
  return new LangfuseClient({ baseUrl: config.baseUrl, publicKey: config.publicKey, secretKey: config.secretKey, timeout: (config.timeoutMs ?? 2000) / 1000 });
}

export interface TurnTelemetryContext {
  turnId: string;
  sessionId: string;
  personId: string;
  userId?: string;
  input?: unknown;
  versions?: Record<string, string>;
}

export interface TelemetryDiagnostics {
  turns: number;
  observations: number;
  /** Serialized, redacted authored payload bytes, not transport/disk bytes. */
  authoredPayloadBytes: number;
  operationErrors: number;
  flushFailures: number;
  flushTimeouts: number;
}

export interface FrameworkObservation {
  update(values: { input?: unknown; output?: unknown; metadata?: Record<string, unknown>; model?: string; usageDetails?: Record<string, number>; costDetails?: Record<string, number> }): void;
}

/** One instance per process, before loading application modules. Uses OTel's bounded batch queue. */
export class FrameworkTelemetry {
  private readonly sdk?: NodeSDK;
  private readonly processor?: LangfuseSpanProcessor;
  private readonly counters: TelemetryDiagnostics = { turns: 0, observations: 0, authoredPayloadBytes: 0, operationErrors: 0, flushFailures: 0, flushTimeouts: 0 };

  constructor(private readonly config: FrameworkTelemetryConfig) {
    validateLangfuseConfig(config);
    if (!config.enabled) return;
    this.processor = new LangfuseSpanProcessor({
      baseUrl: config.baseUrl, publicKey: config.publicKey, secretKey: config.secretKey,
      environment: config.environment, release: config.release, timeout: (config.timeoutMs ?? 2000) / 1000,
      flushAt: 64, flushInterval: 1, mediaUploadEnabled: false,
      additionalHeaders: { 'x-langfuse-ingestion-version': '4' },
      mask: ({ data }) => redactTelemetry(data),
      shouldExportSpan: ({ otelSpan }) => otelSpan.instrumentationScope.name === 'langfuse-sdk',
    });
    this.sdk = new NodeSDK({ spanProcessors: [this.processor], autoDetectResources: false });
    this.sdk.start();
  }

  diagnostics(): TelemetryDiagnostics { return { ...this.counters }; }

  private authored(values: Parameters<FrameworkObservation['update']>[0]): LangfuseGenerationAttributes {
    const safe = redactTelemetry({ ...values, input: this.config.captureContent ? values.input : undefined, output: this.config.captureContent ? values.output : undefined }) as LangfuseGenerationAttributes;
    this.counters.authoredPayloadBytes += Buffer.byteLength(JSON.stringify(safe));
    return safe;
  }

  async turn<T>(ctx: TurnTelemetryContext, task: (span: FrameworkObservation) => Promise<T>): Promise<T> {
    if (!this.config.enabled) return task({ update: () => undefined });
    this.counters.turns++;
    return propagateAttributes({
      sessionId: pseudonymousId(ctx.sessionId), userId: ctx.userId ? pseudonymousId(ctx.userId) : undefined,
      version: this.config.release, traceName: 'persona-turn', environment: this.config.environment,
      metadata: { turnId: pseudonymousId(ctx.turnId), personId: pseudonymousId(ctx.personId), ...(redactTelemetry(ctx.versions ?? {}) as Record<string, string>) },
      asBaggage: false,
    }, () => this.stage('turn', async span => {
      span.update({ input: ctx.input });
      const output = await task(span);
      span.update({ output });
      return output;
    }));
  }

  async stage<T>(name: string, task: (span: FrameworkObservation) => Promise<T>): Promise<T> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Observation names must be static safe identifiers');
    if (!this.config.enabled) return task({ update: () => undefined });
    this.counters.observations++;
    const result = await startActiveObservation(name, async span => {
      const observation: FrameworkObservation = { update: values => { try { span.update(this.authored(values)); } catch { this.counters.operationErrors++; } } };
      try { return { ok: true as const, value: await task(observation) }; }
      catch (error) {
        // Throwing inside SDK context copies raw error.message into OTel status, bypassing its IO mask.
        span.update({ level: 'ERROR', statusMessage: 'operation_failed' });
        span.otelSpan.setStatus({ code: 2, message: 'operation_failed' });
        return { ok: false as const, error };
      }
    });
    if (!result.ok) throw result.error;
    return result.value;
  }

  async generation<T>(name: string, task: (span: FrameworkObservation) => Promise<T>): Promise<T> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(name)) throw new Error('Generation names must be static safe identifiers');
    if (!this.config.enabled) return task({ update: () => undefined });
    this.counters.observations++;
    const result = await startActiveObservation(name, async span => {
      try { return { ok: true as const, value: await task({ update: values => { try { span.update(this.authored(values)); } catch { this.counters.operationErrors++; } } }) }; }
      catch (error) {
        span.update({ level: 'ERROR', statusMessage: 'model_failed' });
        span.otelSpan.setStatus({ code: 2, message: 'model_failed' });
        return { ok: false as const, error };
      }
    }, { asType: 'generation' });
    if (!result.ok) throw result.error;
    return result.value;
  }

  /** Never called on the chat request path; bounded shutdown/CLI export. */
  async flush(): Promise<boolean> {
    if (!this.processor) return true;
    return this.bounded(() => this.processor!.forceFlush());
  }

  async shutdown(): Promise<boolean> {
    if (!this.sdk) return true;
    return this.bounded(() => this.sdk!.shutdown());
  }

  private async bounded(operation: () => Promise<void>): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        operation().then(() => true, () => { this.counters.flushFailures++; return false; }),
        new Promise<boolean>(resolve => { timer = setTimeout(() => { this.counters.flushTimeouts++; resolve(false); }, (this.config.timeoutMs ?? 2000) + 100); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  }
}
