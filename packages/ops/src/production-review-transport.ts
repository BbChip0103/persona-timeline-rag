/** Explicit independent review-copy roots; never inherit a runtime trace. */
import { context, ROOT_CONTEXT } from '@opentelemetry/api';
import { startObservation } from '@langfuse/tracing';

export function createNativeReviewSpan(payload: { originalRunAt: string; input: string; output: string; metadata: Record<string, string | boolean> }) {
  return context.with(ROOT_CONTEXT, () => {
    const span = startObservation('production-review', { input: payload.input, output: payload.output, metadata: payload.metadata }, { startTime: new Date(payload.originalRunAt) });
    return { traceId: span.traceId, id: span.id, end: () => span.end(new Date(payload.originalRunAt)) };
  });
}
