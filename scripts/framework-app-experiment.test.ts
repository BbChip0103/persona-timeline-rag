import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { appEvaluator, createAppTask, createCoreAppExperiment, createExtractionTask, extractionEvaluator, createHttpAppTask, migrateLegacyCaseRegistry, migrateLegacyExtractionRegistry, migrateNaturalCaseRegistry, naturalReviewDimensions, validateAppHttpConfig, type AppExperimentInput, type AppExperimentResult } from './framework-app-experiment';
import { InMemoryConversationStore, InMemoryPersonaRepository } from '../packages/core/src/memory-store';
import type { ChatTestset } from './prepare-character-chat-testset';
import { EXTRACTION_PROMPT_REVISION, EXTRACTION_SYSTEM_PROMPT } from './evaluate';
import type { ChatReply, ChatTurn, ProviderMessage, SourcePost } from '@ptr/contracts';

const input: AppExperimentInput = { personId: 'synthetic-person', personaId: 'synthetic-card', personaRevision: 'synthetic-v1', timezone: 'UTC', retrievalMode: 'off', ragCondition: 'off', historyKind: 'evolving', fixedHistory: [], sources: [], requireGuardOutcome: false, requireRetrievalTrace: false,
  turns: [{ id: 'hello1', text: 'hello', goldSourceIds: [] }, { id: 'hello2', text: 'hello again', goldSourceIds: [] }], versions: { code: 'v1', prompt: 'v1', model: 'synthetic/fake-text-v1', cases: 'v1', rubric: 'v1' } };
const reply = (sessionId: string, turnId: string): ChatReply => ({ sessionId, turnId, messageId: `msg-${turnId}`, personId: input.personId, personaRevision: input.personaRevision, responseKind: 'small_talk', status: 'answered', content: 'hello synthetic friend', claims: [], evidence: [], limitations: [] });

describe('existing application task adapter', () => {
  let server: Server;
  let baseUrl: string;
  const requests: Array<{ method: string; path: string; body: unknown; authorization?: string; owner?: string }> = [];
  const turns = new Map<string, ChatTurn>();
  let sessionCount = 0;
  beforeAll(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown> : {};
      requests.push({ method: request.method!, path: request.url!, body, authorization: request.headers.authorization, owner: String(request.headers['x-ptr-owner']) });
      const send = (value: unknown) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.url === '/api/sessions') { sessionCount++; send({ session: { id: `session-${sessionCount}`, ...input, language: 'en', createdAt: new Date().toISOString() } }); return; }
      const post = request.url?.match(/^\/api\/sessions\/([^/]+)\/turns$/);
      if (post) { const turnId = `turn-${turns.size}`; const turn: ChatTurn = { id: turnId, sessionId: post[1], ownerId: 'synthetic', clientRequestId: String(body.clientRequestId), userText: String(body.text), sequence: turns.size + 1, state: 'completed', createdAt: new Date().toISOString(), reply: reply(post[1], turnId) }; turns.set(turnId, turn); send({ turn: { ...turn, state: 'pending' } }); return; }
      const get = request.url?.match(/^\/api\/turns\/([^/]+)$/);
      if (get) { send({ turn: turns.get(get[1]) }); return; }
      response.writeHead(404); response.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  it('uses one real API session for evolving turns, polls completion, and never sends hidden rubric/gold/token in body', async () => {
    const task = createHttpAppTask({ baseUrl, token: 'synthetic-secret-token', modelRevision: input.versions.model, synthetic: true, pollMs: 1 });
    const output = await task({ input, metadata: { privateRubric: 'RUBRIC_SENTINEL' } }) as AppExperimentResult;
    expect(sessionCount).toBe(1); expect(output.rows).toHaveLength(2); expect(output.guardCoverage).toBe('public-dto-hidden');
    const scores = await appEvaluator({ input, output });
    expect(Array.isArray(scores) && scores.every(score => score.value === 1)).toBe(true);
    expect(requests.filter(request => request.method === 'POST').every(request => !JSON.stringify(request.body).includes('RUBRIC_SENTINEL') && !JSON.stringify(request.body).includes('synthetic-secret-token') && !JSON.stringify(request.body).includes('goldSourceIds'))).toBe(true);
    expect(requests.every(request => request.authorization === 'Bearer synthetic-secret-token' && /^lt-[a-z0-9-]{1,40}$/.test(request.owner!))).toBe(true);
  });
  it('fails rather than inventing frozen assistant history through the public API', async () => {
    const task = createHttpAppTask({ baseUrl, token: 'synthetic', modelRevision: input.versions.model, synthetic: true });
    await expect(task({ input: { ...input, historyKind: 'fixed', fixedHistory: [{ role: 'assistant', content: 'frozen' }] } })).rejects.toThrow('injected');
  });
  it('supports existing in-process fixed-history and internal guard coverage without a separate service', async () => {
    let sessions = 0;
    const task = createAppTask({ fixedHistorySupported: true, internalDiagnostics: true,
      createSession: async () => ({ id: `fixed-${++sessions}`, ownerId: 'synthetic', personId: input.personId, personaId: input.personaId, personaRevision: input.personaRevision, language: 'en', timezone: 'UTC', retrievalMode: 'off', createdAt: new Date().toISOString() }),
      sendTurn: async sessionId => ({ id: 't', sessionId, ownerId: 'synthetic', clientRequestId: 'c', userText: 'hello', sequence: 1, state: 'completed', createdAt: new Date().toISOString(), reply: { ...reply(sessionId, 't'), replyGuard: { revision: 'v1', action: 'none' } } }) });
    const fixed = { ...input, historyKind: 'fixed', fixedHistory: [{ role: 'assistant', content: 'frozen' }], requireGuardOutcome: true };
    const output = await task({ input: fixed });
    expect(sessions).toBe(2); expect((output as AppExperimentResult).guardCoverage).toBe('internal');
    const scores = await appEvaluator({ input: fixed, output }); expect(Array.isArray(scores) && scores.find(score => score.name === 'guard_outcome_observed')?.value).toBe(1);
  });
  it('runs the real existing core graph with frozen versus evolving history and original ownership/validation', async () => {
    const prompts: ProviderMessage[][] = [];
    const store = new InMemoryConversationStore();
    const experiment = createCoreAppExperiment({ modelRevision: input.versions.model, core: { store,
      personas: new InMemoryPersonaRepository([{ id: input.personaId, personId: input.personId, revision: input.personaRevision, label: 'Synthetic', language: 'ko', reviewStatus: 'synthetic', identity: 'Fictional', concept: 'Research', style: [], boundaries: [], sourceRefs: [], greeting: '안녕하세요.' }]),
      provider: { async generate(messages) { prompts.push(structuredClone(messages)); return JSON.stringify({ status: 'insufficient_evidence', answer: '합성 대화 응답이에요.', evidenceRefs: [] }); } },
    } });
    const korean = { ...input, turns: input.turns.map((turn, index) => ({ ...turn, text: `오늘 이야기 ${index} 어때요?`, intent: 'small_talk' as const })) };
    try {
      await experiment.task({ input: { ...korean, historyKind: 'fixed', fixedHistory: [{ role: 'assistant', content: '동일한 고정 대화' }] } });
      expect(prompts).toHaveLength(2);
      expect(prompts.every(messages => messages.some(message => message.role === 'assistant' && message.content === '동일한 고정 대화'))).toBe(true);
      expect(prompts[1].some(message => message.role === 'user' && message.content === korean.turns[0].text)).toBe(false);
      prompts.length = 0;
      const result = await experiment.task({ input: korean }) as AppExperimentResult;
      expect(prompts).toHaveLength(2);
      expect(prompts[1].some(message => message.role === 'user' && message.content === korean.turns[0].text)).toBe(true);
      expect(result.rows.every(row => row.turn.state === 'completed' && row.guardObservable)).toBe(true);
    } finally { await experiment.close(); }
  });

  it('rejects remote/redirectable endpoints, missing explicit model and unapproved live settings', () => {
    expect(() => validateAppHttpConfig({ baseUrl: 'https://example.com', token: 't', modelRevision: 'm', synthetic: false })).toThrow('loopback');
    expect(() => validateAppHttpConfig({ baseUrl, token: 't', modelRevision: 'paid/model', synthetic: false })).toThrow('approval');
    expect(() => validateAppHttpConfig({ baseUrl, token: 't', modelRevision: 'paid/model', synthetic: true })).toThrow('synthetic');
  });
  it('rejects wrong-person evidence and does not call hidden guard observations a pass', async () => {
    const output: AppExperimentResult = { personId: input.personId, personaRevision: input.personaRevision, condition: 'off', historyKind: 'evolving', versions: input.versions, guardCoverage: 'public-dto-hidden', limits: [], rows: input.turns.map((request, i) => ({ input: request, guardObservable: false, retrievedIds: [], turn: { id: `t${i}`, sessionId: 's', ownerId: 'synthetic', clientRequestId: 'c', userText: request.text, sequence: i, state: 'completed', createdAt: new Date().toISOString(), reply: reply('s', `t${i}`) } })) };
    const scores = await appEvaluator({ input: { ...input, requireGuardOutcome: true }, output });
    expect(Array.isArray(scores) && scores.find(score => score.name === 'guard_outcome_observed')?.value).toBe(0);
  });
  it('distinguishes visible prompt coverage from hidden raw retrieval recall', async () => {
    const captionInput = { ...input, ragCondition: 'caption', retrievalMode: 'lexical', requireRetrievalTrace: true, turns: [{ ...input.turns[0], goldSourceIds: ['synthetic-source'] }] };
    const output: AppExperimentResult = { personId: input.personId, personaRevision: input.personaRevision, condition: 'caption', historyKind: 'evolving', versions: input.versions, guardCoverage: 'public-dto-hidden', limits: [], rows: [{ input: captionInput.turns[0], guardObservable: false, retrievalObservable: false, retrievedIds: [], promptSourceIds: ['synthetic-source'], turn: { id: 't', sessionId: 's', ownerId: 'synthetic', clientRequestId: 'c', userText: 'hello', sequence: 1, state: 'completed', createdAt: new Date().toISOString(), reply: reply('s', 't') } }] };
    const scores = await appEvaluator({ input: captionInput, output });
    expect(Array.isArray(scores) && scores.find(score => score.name === 'prompt_gold_coverage')?.value).toBe(1);
    expect(Array.isArray(scores) && scores.find(score => score.name === 'source_recall_at5')?.value).toBe(0);
  });

  it('executes extraction through the existing provider using original prompt and exact surface validator', async () => {
    const source: SourcePost = { id: 'synthetic-source', personId: input.personId, caption: '2026-01-03 합성 행사 기록.', postedAt: '2026-04-01T00:00:00Z', eventDate: null, sourceUrl: 'https://example.invalid/synthetic', hash: 'synthetic-hash', snapshot: 'synthetic-snapshot', unsafe: false };
    const extraction = { kind: 'extraction', source, definition: { id: 'synthetic-extract', sourceId: source.id, split: 'test', silverExpectedEventDate: null }, versions: { ...input.versions, prompt: EXTRACTION_PROMPT_REVISION } };
    let sent: ProviderMessage[] = [];
    const task = createExtractionTask({ modelRevision: input.versions.model, async generate(messages) { sent = messages; return JSON.stringify({ eventDate: '2026-01-03', timeExpression: '2026-01-03', quote: source.caption }); } });
    const output = await task({ input: extraction });
    expect(sent[0].content).toBe(EXTRACTION_SYSTEM_PROMPT);
    expect(sent[1].content).not.toContain('postedAt'); expect(sent[1].content).not.toContain('silverExpectedEventDate');
    expect(output).toMatchObject({ schemaValid: true, exactQuote: true, explicitDateSurfaceValid: true, conservativeEventDate: '2026-01-03', correctnessAccuracy: null, humanReview: 'pending' });
    const scores = await extractionEvaluator({ input: extraction, output }); expect(Array.isArray(scores) && scores.every(score => score.value === 1)).toBe(true);
    const malformed = createExtractionTask({ modelRevision: input.versions.model, generate: async () => 'not-json' });
    const rejected = await malformed({ input: extraction });
    expect(rejected).toMatchObject({ schemaValid: false, conservativeEventDate: null });
    const rejectedScores = await extractionEvaluator({ input: extraction, output: rejected }); expect(Array.isArray(rejectedScores) && rejectedScores.every(score => score.value === 0)).toBe(true);
  });

  it('preserves full natural case/rubric/provenance while separating lexical versus semantic method revisions', () => {
    const testset: ChatTestset = { version: 'natural-character-chat-testset-v1', revision: 'frozen-original-v1', frozenAt: '2026-01-01T00:00:00Z', asOf: '2025-12-31', reviewStatus: 'draft_silver', assetHashes: { source: 'original-source-hash' }, smokeIds: ['conversation-0'], limitations: ['original limitation'], rubric: { scale: '0=poor 1=partial 2=good', naturalness: 'Original description', continuity: 'Original continuity' }, conversations: Array.from({ length: 32 }, (_, index) => ({ id: `conversation-${index}`, personId: input.personId, personaId: input.personaId, personaRevision: input.personaRevision, language: 'en', category: 'casual', turns: Array.from({ length: 3 }, (_, turn) => ({ id: `original-turn-${turn}`, text: 'hello synthetic', evaluator: { behavior: 'social', contextFrom: [], retrievalExpectation: 'unnecessary', targets: [], supportedClaims: [], unsupportedClaims: ['private facts'], acceptableAlternatives: ['normal conversation'], requireNewVisualContribution: false, checks: ['naturalness', 'continuity'] } })) })) };
    const versions = { code: 'new-code', prompt: 'new-prompt', model: input.versions.model };
    const lexical = migrateNaturalCaseRegistry(testset, [], versions);
    expect(lexical.cases).toHaveLength(96);
    expect(lexical.cases[1].input).toMatchObject({ retrievalMode: 'lexical', versions: { cases: testset.revision, prompt: 'new-prompt' } });
    expect(lexical.cases[0].rubric).toMatchObject({ frozenAt: testset.frozenAt, assetHashes: testset.assetHashes, isOriginalSmoke: true, originalTurnIds: ['original-turn-0', 'original-turn-1', 'original-turn-2'], retrievalMethod: { retrievalMode: 'lexical', revision: 'framework-lexical-v1' } });
    const semantic = migrateNaturalCaseRegistry(testset, [], versions, { retrievalMode: 'semantic', revision: 'approved-semantic-v2' });
    expect(semantic.cases[1].input).toMatchObject({ retrievalMode: 'semantic', versions: { cases: testset.revision } });
    expect(naturalReviewDimensions(testset)).toEqual([{ name: 'naturalness', description: 'Original description', minValue: 0, maxValue: 2 }, { name: 'continuity', description: 'Original continuity', minValue: 0, maxValue: 2 }]);
  });

  it('imports full original registry shapes/versions and keeps fixed/evolving comparisons', () => {
    const binding = { personId: input.personId, personaId: input.personaId, personaRevision: input.personaRevision, timezone: 'UTC' };
    const categories = [...Array(32).fill('caption_supported'), ...Array(8).fill('event_date_unknown'), ...Array(6).fill('absent'), ...Array(4).fill('clarification')];
    const registry = { version: 'goal1-eval-v1' as const, labelStatus: 'silver_nonhuman' as const, revision: 'old-v12',
      cases: categories.map((category, i) => ({ ...binding, id: `case-${i}`, text: 'synthetic input', category, split: 'test' as const, splitProxy: 'person_posted_day' as const, goldSourceIds: category === 'caption_supported' ? ['synthetic-source'] : [] })),
      extraction: Array.from({ length: 50 }, (_, i) => ({ id: `extract-${i}`, sourceId: 'synthetic-source', split: 'test' as const, silverExpectedEventDate: null })),
      scenarios: Array.from({ length: 12 }, (_, i) => ({ ...binding, id: `scenario-${i}`, turns: Array.from({ length: 5 }, (_, j) => ({ id: `turn-${j}`, text: 'synthetic turn' })) })) };
    const migration = migrateLegacyCaseRegistry(registry as Parameters<typeof migrateLegacyCaseRegistry>[0], [], { code: 'new', prompt: 'same-prompt', model: input.versions.model });
    expect(migration.cases).toHaveLength(222); // 50*3 singles +12*3*2 multi scenarios.
    expect(migration.cases.some(item => (item.input as AppExperimentInput).historyKind === 'fixed')).toBe(true);
    expect((migration.cases[0].input as AppExperimentInput).versions.cases).toBe('old-v12');
    const source: SourcePost = { id: 'synthetic-source', personId: input.personId, caption: 'Fictional caption.', postedAt: '2026-01-01T00:00:00Z', eventDate: null, sourceUrl: 'https://example.invalid', hash: 'h', snapshot: 's', unsafe: false };
    const extraction = migrateLegacyExtractionRegistry(registry as Parameters<typeof migrateLegacyExtractionRegistry>[0], [source], { code: 'new', prompt: 'ignored-original-preserved', model: input.versions.model });
    expect(extraction.cases).toHaveLength(50); expect(extraction.cases[0].input).toMatchObject({ kind: 'extraction', versions: { prompt: EXTRACTION_PROMPT_REVISION, cases: 'old-v12' } });
  });
});
