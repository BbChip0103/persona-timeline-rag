import { z } from 'zod';
import { CoreError } from './ports';
import { containsCredentialPattern } from './safety';

const tone = z.enum(['neutral', 'warm', 'playful']);
/** Initial state defaults are not applied to patches: omitted patch fields leave state unchanged. */
export const AgentVariablesSchema = z.object({
  conversationTopic: z.string().max(200).default(''),
  tone: tone.default('neutral'),
}).strict().default({});
const variableUpdates = z.object({ conversationTopic: z.string().max(200).optional(), tone: tone.optional() }).strict();
const reference = z.object({
  sourceId: z.string().min(1).max(200),
  annotationId: z.string().min(1).max(200).optional(),
  quote: z.string().min(1).max(96),
}).strict();
const search = z.object({
  name: z.literal('timeline_search'),
  arguments: z.object({
    query: z.string().trim().min(1).refine(value => [...value].length <= 500, 'Query exceeds 500 Unicode codepoints'),
  }).strict(),
}).strict();
/** `reasoning` is an optional short decision summary, not a chain-of-thought request. */
export const AgentResponseSchema = z.object({
  message: z.string().max(8000).refine(value => [...value].length <= 180, 'Message exceeds 180 Unicode codepoints'),
  status: z.enum(['answered', 'insufficient_evidence', 'needs_clarification', 'out_of_scope']),
  evidenceRefs: z.array(reference).max(2),
  reasoning: z.string().max(160).optional(),
  variableUpdates: variableUpdates.default({}),
  function: search.optional(),
}).strict().superRefine((value, context) => {
  if (value.function) {
    if (value.message !== '' || value.evidenceRefs.length !== 0 || Object.keys(value.variableUpdates).length !== 0)
      context.addIssue({ code: 'custom', message: 'Pending function responses cannot contain a message or evidence' });
  } else if (!value.message.trim()) {
    context.addIssue({ code: 'custom', message: 'Final response requires a nonempty message' });
  }
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;
export type AgentVariables = z.infer<typeof AgentVariablesSchema>;

/** Inspect decoded keys and strings too, so escaped credentials cannot bypass raw-text detection. */
function containsDecodedCredential(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && containsCredentialPattern(item)) return true;
    if (Array.isArray(item)) pending.push(...item);
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (containsCredentialPattern(key)) return true;
        pending.push(child);
      }
    }
  }
  return false;
}
/** Fail once, without repair/retry, and never expose raw model output or validation details. */
export function parseAgentResponse(raw: string): AgentResponse {
  try {
    if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 65536 || containsCredentialPattern(raw)) throw new Error();
    const decoded: unknown = JSON.parse(raw);
    if (containsDecodedCredential(decoded)) throw new Error();
    return AgentResponseSchema.parse(decoded);
  } catch {
    throw new CoreError('TURN_FAILED');
  }
}
