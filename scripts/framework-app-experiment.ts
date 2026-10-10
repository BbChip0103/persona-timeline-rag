import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CreateSessionSchema, SendTurnSchema, SourcePostSchema, type ChatSession, type ChatTurn, type SourcePost, type ChatMessage, type ExecutionProfile, type ProviderMessage } from '@ptr/contracts';
import { createLocalChat } from '../packages/core/src/local-execution';
import type { ChatServiceOptions } from '../packages/core/src/chat-service';
import type { ConversationStore, TurnLeaseStore } from '../packages/core/src/ports';
import { validateExperimentReply } from '../packages/core/src/evidence';
import { containsCredentialPattern, containsInternalPathPattern } from '../packages/core/src/safety';
import { textLanguage, leakFindings } from './s8-gates';
import { EvaluationSchema, sourceRecall, validateExtractionCandidate, EXTRACTION_PROMPT_REVISION, EXTRACTION_SYSTEM_PROMPT, type EvaluationInput } from './evaluate';
import { userConversation, type ChatTestset } from './prepare-character-chat-testset';
import type { EvaluationMigration, ExperimentScorePolicy, ReviewDimension } from './framework-evaluate';
import type { Evaluator, ExperimentTask } from '../packages/ops/src/langfuse';

const turn = SendTurnSchema.omit({ sessionId: true, clientRequestId: true }).extend({ id: z.string().min(1), goldSourceIds: z.array(z.string()).default([]), category: z.string().optional(), expectedStatus: z.enum(['answered','insufficient_evidence','needs_clarification','out_of_scope']).optional() }).strict();
export const AppExperimentInputSchema = z.object({
  personId: z.string().min(1), personaId: z.string().min(1), personaRevision: z.string().min(1), timezone: z.string().default('UTC'),
  retrievalMode: z.enum(['off', 'lexical', 'semantic']), ragCondition: z.enum(['off','caption','caption_image']),
  historyKind: z.enum(['single','fixed','evolving']).default('evolving'),
  fixedHistory: z.array(z.object({ role: z.enum(['user','assistant']), content: z.string() })).max(20).default([]),
  turns: z.array(turn).min(1).max(20), sources: z.array(SourcePostSchema).max(1000).default([]),
  versions: z.object({ code: z.string().min(1), prompt: z.string().min(1), model: z.string().min(1), cases: z.string().min(1), rubric: z.string().min(1) }).strict(),
  requireGuardOutcome: z.boolean().default(false), requireRetrievalTrace: z.boolean().default(false),
}).strict().superRefine((input, ctx) => {
  if ((input.ragCondition === 'off') !== (input.retrievalMode === 'off')) ctx.addIssue({ code: 'custom', message: 'RAG condition/retrieval mismatch' });
  if (input.sources.some(source => source.personId !== input.personId || source.unsafe)) ctx.addIssue({ code: 'custom', message: 'Evaluation source scope mismatch' });
});
export type AppExperimentInput = z.infer<typeof AppExperimentInputSchema>;
export interface AppExperimentRow { input: AppExperimentInput['turns'][number]; turn: ChatTurn; guardObservable: boolean; retrievedIds: string[]; promptSourceIds?: string[]; retrievalObservable?: boolean }
export interface AppExperimentResult { personId: string; personaRevision: string; condition: string; historyKind: string; versions: AppExperimentInput['versions']; rows: AppExperimentRow[]; guardCoverage: 'internal' | 'public-dto-hidden'; limits: string[] }
/** Existing runtime injection provides fixed-history/internal guard diagnostics without adding a service. */
export interface AppExperimentRuntime {
  createSession(input: AppExperimentInput): Promise<ChatSession>;
  sendTurn(sessionId: string, input: AppExperimentInput['turns'][number]): Promise<ChatTurn>;
  fixedHistorySupported: boolean;
  internalDiagnostics: boolean;
  retrievalIds?(turnId: string): string[] | undefined;
}
export function createAppTask(runtime: AppExperimentRuntime): ExperimentTask {
  return async item => {
    const input = AppExperimentInputSchema.parse(item.input);
    if (input.historyKind === 'fixed' && input.fixedHistory.length && !runtime.fixedHistorySupported) throw new Error('Fixed assistant history requires an injected existing runtime; HTTP cannot fabricate it');
    const rows: AppExperimentRow[] = [];
    let session: ChatSession | undefined;
    for (const request of input.turns) {
      if (!session || input.historyKind !== 'evolving') session = await runtime.createSession(input);
      if (session.personId !== input.personId || session.personaRevision !== input.personaRevision || session.personaId !== input.personaId || session.retrievalMode !== input.retrievalMode) throw new Error('Application session binding/version mismatch');
      const completed = await runtime.sendTurn(session.id, request);
      if (completed.sessionId !== session.id || completed.state !== 'completed' || !completed.reply) throw new Error('Application turn failed or was not completed');
      if (completed.reply.personId !== input.personId || completed.reply.personaRevision !== input.personaRevision) throw new Error('Application reply persona/version mismatch');
      rows.push({ input: request, turn: completed, guardObservable: runtime.internalDiagnostics && !!(completed.reply.replyGuard || completed.reply.inputSafety), retrievedIds: runtime.retrievalIds?.(completed.id) ?? [], retrievalObservable: runtime.retrievalIds?.(completed.id) !== undefined, promptSourceIds: completed.reply.promptEvidence?.sourceIds ?? [] });
    }
    return { personId: input.personId, personaRevision: input.personaRevision, condition: input.ragCondition, historyKind: input.historyKind, versions: input.versions, rows,
      guardCoverage: runtime.internalDiagnostics ? 'internal' : 'public-dto-hidden', limits: ['Quote binding is not entailment/factual accuracy.', 'Persona fidelity and nuanced safety still require original human rubric.', ...(!runtime.internalDiagnostics ? ['Public HTTP hides guard outcomes, raw retrievaltop5 and retrieval/embedding call counts; these are not certified by this runner.'] : [])] } satisfies AppExperimentResult;
  };
}

/** Same core graph, store ownership/lease/fencing and validators; only transport is local to this CLI. */
export function createCoreAppExperiment(options: {
  core: Omit<ChatServiceOptions, 'leases' | 'delivery' | 'events'> & { store: ConversationStore & TurnLeaseStore };
  modelRevision: string; executionProfile?: ExecutionProfile;
}): { task: ExperimentTask; close(): Promise<void> } {
  if (!options.modelRevision) throw new Error('Core experiment requires an explicit model revision');
  const ownerId = `lt-framework-core-${randomUUID().replace(/-/g, '')}`;
  let frozen: AppExperimentInput['fixedHistory'] | undefined;
  // Existing history port injection from the original harness: no assistant text is sent as user input.
  const historyStore = new Proxy(options.core.store, { get(target, key) {
    if (key === 'history') return async (sessionId: string, owner: string): Promise<ChatMessage[]> => {
      const history = await target.history(sessionId, owner); // Retain normal ownership checks.
      return frozen === undefined ? history : [...history.filter(message => message.turnId === null), ...frozen.map((message, index) => ({ ...message, id: `fixed-${index}`, sessionId, turnId: null, createdAt: '2000-01-01T00:00:00.000Z' }))];
    };
    const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value;
  } });
  let captured: string[] = [];
  const retrievedByTurn = new Map<string, string[]>();
  const originalRetrieval = options.core.retrieval;
  const chat = createLocalChat({ ...options.core, store: historyStore, retrieval: originalRetrieval ? { async search(query, trusted, searchOptions) { const sources = await originalRetrieval.search(query, trusted, searchOptions); captured.push(...sources.slice(0, 5).map(source => source.id)); return sources; } } : undefined });
  const runtime: AppExperimentRuntime = {
    fixedHistorySupported: true, internalDiagnostics: true,
    async createSession(input) {
      if (input.versions.model !== options.modelRevision) throw new Error('Case model revision differs from selected core provider');
      frozen = input.historyKind === 'fixed' ? structuredClone(input.fixedHistory) : undefined;
      return chat.createSession(ownerId, { personId: input.personId, personaId: input.personaId, personaRevision: input.personaRevision, timezone: input.timezone, retrievalMode: input.retrievalMode, ragCondition: input.ragCondition, executionProfile: options.executionProfile ?? 'legacy' });
    },
    async sendTurn(sessionId, input) { captured = []; const completed = await chat.sendTurn(ownerId, SendTurnSchema.parse({ sessionId, clientRequestId: randomUUID(), text: input.text, intent: input.intent, timeline: input.timeline })); retrievedByTurn.set(completed.id, [...new Set(captured)]); return completed; },
    retrievalIds: turnId => retrievedByTurn.get(turnId),
  };
  const app = createAppTask(runtime);
  let active = false;
  return {
    async task(item) {
      if (active) throw new Error('Controlled fixed-history experiments require sequential case execution');
      active = true; try { return await app(item); } finally { frozen = undefined; captured = []; retrievedByTurn.clear(); active = false; }
    },
    close: () => chat.stop(),
  };
}

export interface AppHttpConfig { baseUrl: string; token: string; modelRevision: string; synthetic: boolean; allowLive?: boolean; timeoutMs?: number; pollMs?: number }
export function validateAppHttpConfig(config: AppHttpConfig): void {
  const url = new URL(config.baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1','[::1]'].includes(url.hostname) || !url.port || (url.pathname !== '/' && url.pathname !== '') || url.username || url.password || url.search || url.hash) throw new Error('App evaluation requires an explicit numeric loopback base URL');
  if (!config.token || /[\r\n]/.test(config.token) || !config.modelRevision) throw new Error('Explicit app synthetic token and model revision required');
  if (!config.synthetic && !config.allowLive) throw new Error('Live app evaluation requires separate bounded-call approval');
  if (config.synthetic && !/^(?:synthetic\/|fake|primary$)/.test(config.modelRevision)) throw new Error('Synthetic app evaluation must identify a synthetic model');
  if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120000)) throw new Error('Invalid app evaluation timeout');
}
export function createHttpAppTask(config: AppHttpConfig): ExperimentTask {
  validateAppHttpConfig(config);
  const owner = `lt-framework-eval-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const request = async (path: string, method: string, body?: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/api${path}`, { method, redirect: 'error',
      headers: { authorization: `Bearer ${config.token}`, 'X-PTR-Owner': owner, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.min(config.timeoutMs ?? 90000, 10000)) });
    if (!response.ok) throw new Error(`APP_HTTP_${response.status}`);
    return await response.json() as Record<string, unknown>;
  };
  const runtime: AppExperimentRuntime = {
    fixedHistorySupported: false, internalDiagnostics: false,
    async createSession(input) {
      if (input.versions.model !== config.modelRevision) throw new Error('Case model revision differs from selected app deployment');
      const body = CreateSessionSchema.parse({ personId: input.personId, personaId: input.personaId, personaRevision: input.personaRevision, timezone: input.timezone, retrievalMode: input.retrievalMode, ragCondition: input.ragCondition, executionProfile: 'agent_loop' });
      const response = await request('/sessions', 'POST', { personId: body.personId, timezone: body.timezone, retrievalMode: body.retrievalMode, ragCondition: body.ragCondition, executionProfile: body.executionProfile });
      return response.session as ChatSession;
    },
    async sendTurn(sessionId, input) {
      // Never send evaluator rubric, gold sources, target claims or forced history to the production model.
      const body = SendTurnSchema.parse({ sessionId, clientRequestId: randomUUID(), text: input.text, ...(input.intent ? { intent: input.intent } : {}), ...(input.timeline ? { timeline: input.timeline } : {}) });
      const { sessionId: _sessionId, ...payload } = body;
      let current = (await request(`/sessions/${encodeURIComponent(sessionId)}/turns`, 'POST', payload)).turn as ChatTurn;
      const deadline = Date.now() + (config.timeoutMs ?? 90000);
      while (!['completed', 'failed', 'cancelled'].includes(current.state)) {
        if (Date.now() >= deadline) {
          await request(`/turns/${encodeURIComponent(current.id)}/cancel`, 'POST', {});
          throw new Error('APP_EVALUATION_TIMEOUT_NO_RESUBMIT');
        }
        await new Promise(resolve => setTimeout(resolve, config.pollMs ?? 50));
        current = (await request(`/turns/${encodeURIComponent(current.id)}`, 'GET')).turn as ChatTurn;
      }
      return current;
    },
  };
  return createAppTask(runtime);
}

/** All policy checks reuse existing core/evaluator functions. Missing observations are not called passes. */
export const appEvaluator: Evaluator = async ({ input: raw, output }) => {
  const input = AppExperimentInputSchema.parse(raw);
  const result = output as AppExperimentResult;
  const scores: Array<{ name: string; value: number; comment?: string }> = [];
  const pass = (name: string, condition: boolean, comment?: string) => scores.push({ name, value: condition ? 1 : 0, ...(comment ? { comment } : {}) });
  pass('all_turns_completed', result.rows.length === input.turns.length && result.rows.every(row => row.turn.state === 'completed'));
  pass('persona_binding', result.rows.every(row => row.turn.reply?.personId === input.personId && row.turn.reply?.personaRevision === input.personaRevision));
  pass('no_secret_or_prompt_leak', result.rows.every(row => { const text = row.turn.reply!.content; return !containsCredentialPattern(text) && !containsInternalPathPattern(text) && leakFindings(text, []).length === 0; }));
  pass('language_match', result.rows.every(row => { const expected = textLanguage(row.input.text); return expected === null || textLanguage(row.turn.reply!.content) === expected; }));
  pass('condition_isolation', result.rows.every(row => input.ragCondition !== 'off' || (!row.turn.reply!.evidence.length && row.retrievedIds.length === 0 && !row.promptSourceIds?.length)) && result.rows.every(row => input.ragCondition !== 'caption' || !row.turn.reply!.evidence.some(card => card.origin === 'ai_image_annotation')));
  pass('cross_person_evidence', result.rows.every(row => row.turn.reply!.evidence.every(card => card.personId === input.personId)));
  pass('quote_binding', result.rows.every(row => {
    const reply = row.turn.reply!;
    if (!reply.evidence.length && !reply.claims.length) return true;
    const checked = validateExperimentReply(JSON.stringify({ status: reply.status, answer: reply.content, evidenceRefs: reply.claims.flatMap(claim => claim.evidenceRefs) }), input.sources, input.personId, input.ragCondition);
    return !checked.limitations.includes('INVALID_MODEL_EVIDENCE') && checked.evidence.length === reply.evidence.length;
  }), 'Exact binding only; no factual/entailment claim');
  for (const row of result.rows) {
    if (row.input.goldSourceIds.length && input.ragCondition !== 'off') {
      scores.push({ name: 'prompt_gold_coverage', value: sourceRecall(row.input.goldSourceIds, row.promptSourceIds ?? []) ?? 0, comment: 'Visible validated prompt source coverage, including reused context; NOT raw retrievaltop5 recall' });
      if (input.requireRetrievalTrace) scores.push({ name: 'source_recall_at5', value: row.retrievalObservable ? sourceRecall(row.input.goldSourceIds, row.retrievedIds) ?? 0 : 0, comment: row.retrievalObservable ? 'Original retrieval port top5/gold metric; no human accuracy claim' : 'Raw retrieval trace unavailable: not a pass' });
    }
    if (row.input.expectedStatus) pass('status_silver_surrogate', row.turn.reply!.status === row.input.expectedStatus, 'Original silver status surrogate, not answer accuracy');
  }
  if (input.requireGuardOutcome) pass('guard_outcome_observed', result.rows.every(row => row.guardObservable), 'Public DTO hides internal guard traces; use injected existing runtime for this gate');
  return scores;
};
export const evaluators: Evaluator[] = [appEvaluator];
const baseMetrics = ['all_turns_completed', 'persona_binding', 'no_secret_or_prompt_leak', 'language_match', 'condition_isolation', 'cross_person_evidence', 'quote_binding'];
export const scorePolicy: ExperimentScorePolicy = {
  rules: [...baseMetrics, 'prompt_gold_coverage', 'source_recall_at5', 'status_silver_surrogate', 'guard_outcome_observed'].map(name => ({ name, kind: 'numeric' as const, min: 0, max: 1, passMin: 1, passMax: 1 })),
  expected(raw) {
    const input = AppExperimentInputSchema.parse(raw);
    const required = Object.fromEntries(baseMetrics.map(name => [name, 1]));
    const recall = input.ragCondition === 'off' ? 0 : input.turns.filter(turn => turn.goldSourceIds.length).length;
    const status = input.turns.filter(turn => turn.expectedStatus).length;
    if (recall) { required.prompt_gold_coverage = recall; if (input.requireRetrievalTrace) required.source_recall_at5 = recall; }
    if (status) required.status_silver_surrogate = status;
    if (input.requireGuardOutcome) required.guard_outcome_observed = 1;
    return required;
  },
};
/** CLI --task entry; environment credentials stay server-side and are never added to dataset/trace metadata. */
export const task: ExperimentTask = async item => createHttpAppTask({ baseUrl: process.env.PTR_FRAMEWORK_EVAL_API_URL ?? '', token: process.env.PTR_FRAMEWORK_EVAL_TOKEN ?? '',
  modelRevision: process.env.PTR_FRAMEWORK_EVAL_MODEL_REVISION ?? '', synthetic: process.env.PTR_FRAMEWORK_EVAL_SYNTHETIC === 'true',
  allowLive: process.env.PTR_FRAMEWORK_EVAL_LIVE_APPROVAL === 'approved-bounded-live' })(item);

export function migrateNaturalCaseRegistry(testset: ChatTestset, sources: SourcePost[], versions: Omit<AppExperimentInput['versions'], 'cases' | 'rubric'>, method: { retrievalMode: 'lexical' | 'semantic'; revision: string } = { retrievalMode: 'lexical', revision: 'framework-lexical-v1' }): EvaluationMigration {
  if (!method.revision || !['lexical', 'semantic'].includes(method.retrievalMode)) throw new Error('Explicit supported retrieval method/revision required');
  if (testset.conversations.length !== 32 || new Set(testset.conversations.map(conversation => conversation.id)).size !== 32 || testset.conversations.some(conversation => conversation.turns.length !== 3)) throw new Error('Expected original frozen32 three-turn conversation definitions');
  const cases: EvaluationMigration['cases'] = [];
  for (const conversation of testset.conversations) for (const condition of ['off','caption','caption_image'] as const) {
    const user = userConversation(conversation); // Existing boundary removes hidden evaluator targets from sent utterances.
    const input = AppExperimentInputSchema.parse({ personId: conversation.personId, personaId: conversation.personaId, personaRevision: conversation.personaRevision, timezone: 'Asia/Seoul',
      retrievalMode: condition === 'off' ? 'off' : method.retrievalMode, ragCondition: condition, historyKind: 'evolving', sources: sources.filter(source => source.personId === conversation.personId && !source.unsafe),
      versions: { ...versions, cases: testset.revision, rubric: `${testset.version}:original` },
      turns: user.turns.map((turn, index) => ({ ...turn, goldSourceIds: [...new Set(conversation.turns[index].evaluator.targets.map(target => target.sourceId))] })) });
    cases.push({ id: `${conversation.id}:${condition}`, input, rubric: { ...testset.rubric, retrievalMethod: method, originalMethodologyUnchanged: true, category: conversation.category, originalEvaluators: conversation.turns.map(turn => turn.evaluator), reviewStatus: testset.reviewStatus, asOf: testset.asOf, frozenAt: testset.frozenAt, assetHashes: testset.assetHashes, isOriginalSmoke: testset.smokeIds.includes(conversation.id), originalTurnIds: conversation.turns.map(turn => turn.id), limitations: testset.limitations } });
  }
  return { source: 'approved-private', revision: testset.revision, cases };
}

/** Original names/descriptions and 0..2 ordinal scale, not normalized synthetic gates. */
export function naturalReviewDimensions(testset: ChatTestset): ReviewDimension[] {
  const dimensions = Object.entries(testset.rubric).filter(([name]) => name !== 'scale').map(([name, description]) => ({ name, description, minValue: 0, maxValue: 2 }));
  if (!dimensions.length) throw new Error('Original natural-chat rubric has no review dimensions');
  return dimensions;
}

/** Original50 single +12 five-turn scenarios, fixed/evolving semantics retained as data, not silently dropped. */
export function migrateLegacyCaseRegistry(raw: EvaluationInput, sources: SourcePost[], versions: Omit<AppExperimentInput['versions'], 'cases' | 'rubric'>): EvaluationMigration {
  const registry = EvaluationSchema.parse(raw);
  const cases: EvaluationMigration['cases'] = [];
  for (const mode of ['off','lexical','semantic'] as const) {
    const condition = mode === 'off' ? 'off' : 'caption';
    const inputFor = (binding: { personId: string; personaId: string; personaRevision: string; timezone: string }, requests: unknown[], historyKind: string, fixedHistory: unknown[] = []) => AppExperimentInputSchema.parse({ personId: binding.personId, personaId: binding.personaId, personaRevision: binding.personaRevision, timezone: binding.timezone, retrievalMode: mode, ragCondition: condition, historyKind, fixedHistory, requireRetrievalTrace: true,
      turns: requests, sources: sources.filter(source => source.personId === binding.personId && !source.unsafe), versions: { ...versions, cases: registry.revision, rubric: registry.version } });
    for (const item of registry.cases) {
      const expectedStatus = item.category === 'clarification' ? 'needs_clarification' : item.category === 'caption_supported' ? mode === 'off' ? 'insufficient_evidence' : 'answered' : undefined;
      cases.push({ id: `${item.id}:${mode}`, input: inputFor(item, [{ id: item.id, text: item.text, intent: item.intent, timeline: item.timeline, goldSourceIds: item.goldSourceIds, category: item.category, expectedStatus }], 'single'), rubric: { category: item.category, split: item.split, splitProxy: item.splitProxy, labelStatus: registry.labelStatus, methodology: registry.methodology, statusIsSilverSurrogate: true } });
    }
    for (const scenario of registry.scenarios) for (const historyKind of ['fixed','evolving'] as const) cases.push({ id: `${scenario.id}:${mode}:${historyKind}`, input: inputFor(scenario, scenario.turns, historyKind, historyKind === 'fixed' ? scenario.fixedHistory ?? [] : []), rubric: { split: scenario.split, splitProxy: scenario.splitProxy, labelStatus: registry.labelStatus, fixedHistorySemantics: 'identical-frozen-assistant-history-per-turn', methodology: registry.methodology } });
  }
  cases[0].rubric.originalExtractionRegistry = registry.extraction;
  cases[0].rubric.extractionExecution = 'Separate existing extraction task required; chat API does not implement extraction';
  return { source: 'approved-private', revision: registry.revision, cases };
}


export const ExtractionExperimentInputSchema = z.object({
  kind: z.literal('extraction'), source: SourcePostSchema.refine(source => !source.unsafe, 'Unsafe extraction source'),
  definition: EvaluationSchema.innerType().shape.extraction.element,
  versions: AppExperimentInputSchema.innerType().shape.versions,
}).strict().superRefine((input, ctx) => {
  if (input.source.id !== input.definition.sourceId || input.versions.prompt !== EXTRACTION_PROMPT_REVISION) ctx.addIssue({ code: 'custom', message: 'Extraction source or original prompt revision mismatch' });
});
export interface ExtractionExperimentResult { schemaValid: boolean; exactQuote: boolean; explicitDateSurfaceValid: boolean; conservativeEventDate: string | null; correctnessAccuracy: null; humanReview: 'pending'; execution: 'caption_candidate_unreviewed'; promptRevision: string; modelRevision: string }
/** Uses original prompt and validator through the injected existing provider/ledger, never another eval service. */
export function createExtractionTask(runtime: { modelRevision: string; generate(messages: ProviderMessage[], options: { signal: AbortSignal }): Promise<string> }): ExperimentTask {
  return async ({ input: raw }) => {
    const input = ExtractionExperimentInputSchema.parse(raw);
    if (input.versions.model !== runtime.modelRevision) throw new Error('Extraction provider revision mismatch');
    const candidate = await runtime.generate([{ role: 'system', content: EXTRACTION_SYSTEM_PROMPT }, { role: 'user', content: `UNTRUSTED_CAPTION_JSON_DATA ${JSON.stringify({ caption: input.source.caption })}` }], { signal: AbortSignal.timeout(30000) });
    const checked = validateExtractionCandidate(candidate, input.source.caption);
    return { ...checked, schemaValid: checked.schemaValid === true, exactQuote: checked.exactQuote === true, explicitDateSurfaceValid: checked.explicitDateSurfaceValid === true, conservativeEventDate: typeof checked.conservativeEventDate === 'string' ? checked.conservativeEventDate : null,
      correctnessAccuracy: null, humanReview: 'pending', execution: 'caption_candidate_unreviewed', promptRevision: EXTRACTION_PROMPT_REVISION, modelRevision: runtime.modelRevision } satisfies ExtractionExperimentResult;
  };
}
export const extractionEvaluator: Evaluator = async ({ input: raw, output }) => {
  ExtractionExperimentInputSchema.parse(raw);
  const result = output as ExtractionExperimentResult;
  return [{ name: 'candidate_schema', value: result.schemaValid ? 1 : 0 }, { name: 'candidate_surface_safe', value: result.schemaValid && (result.conservativeEventDate === null || result.exactQuote && result.explicitDateSurfaceValid) ? 1 : 0, comment: 'Original exact full-date surface gate; NOT extraction accuracy or human truth' }];
};
export const extractionScorePolicy: ExperimentScorePolicy = { rules: ['candidate_schema', 'candidate_surface_safe'].map(name => ({ name, kind: 'numeric' as const, min: 0, max: 1, passMin: 1, passMax: 1 })), expected: () => ({ candidate_schema: 1, candidate_surface_safe: 1 }) };
export function migrateLegacyExtractionRegistry(raw: EvaluationInput, sources: SourcePost[], versions: Omit<AppExperimentInput['versions'], 'cases' | 'rubric'>): EvaluationMigration {
  const registry = EvaluationSchema.parse(raw);
  const cases = registry.extraction.map(definition => {
    const source = sources.find(source => source.id === definition.sourceId);
    if (!source) throw new Error('Missing explicitly provided extraction source');
    return { id: definition.id, input: ExtractionExperimentInputSchema.parse({ kind: 'extraction', source, definition, versions: { ...versions, prompt: EXTRACTION_PROMPT_REVISION, cases: registry.revision, rubric: registry.version } }),
      rubric: { labelStatus: registry.labelStatus, originalDefinition: definition, originalMethodology: registry.methodology, correctnessAccuracy: null, humanReview: 'pending', limitation: 'Model candidates validated for exact surface only; original human correctness still pending' } };
  });
  return { source: 'approved-private', revision: registry.revision, cases };
}
