/** Historical legacy regression only; forward three-condition evaluation uses evaluate-character-chat.ts. */
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { Persona, SourcePost } from '@ptr/contracts';
import { ChatService, EXPERIMENT_PROMPT_REVISION, RETRIEVAL_CONTEXT_REVISION, type Retrieval } from '@ptr/core';
import { createLocalPool, PostgresConversationStore, PostgresPersonaRepository, PostgresRetrieval, PostgresSourceRepository } from '@ptr/storage';
import { EMBEDDING_MODEL, OpenRouterClient, PostgresBudgetLedger, ProviderError, liveOptionsFromEnvironment, type BudgetLedger, type BudgetRequest } from '@ptr/providers';
import type { RequestTrace, TurnTrace } from './evaluate';
import { executeNaturalConversation, summarizeNaturalRows, validateUserExport, type NaturalChatRow, type UserConversation } from './evaluate-character-chat';
import { CONDITIONS, validateCorpus, type CorpusRow } from './evaluate-image-rag';
import { prepareImageAnnotations, type AnnotationPlan } from './import-image-annotations';
import { prepareChatTestset, testsetHash, userConversation, type ChatTestset } from './prepare-character-chat-testset';
import { privateJson } from './prepare-research';

const PILOT_CASES = [['creator_a', 'caption_memory'], ['creator_b', 'image_memory'], ['creator_c', 'creative_preference'], ['creator_d', 'mixed_memory']] as const;
export const PILOT_LIMITS = { turns: 36, textCalls: 36, embeddingCalls: 24, freshRequests: 60 } as const;
export interface MemoryTrace extends TurnTrace { sourceLookupCalls: number; searchQueries: string[]; resolvedIds: string[] }
export function selectMemoryPilot(testset: ChatTestset, users: UserConversation[]): UserConversation[] {
  const selected = PILOT_CASES.map(([person, category]) => {
    const matches = testset.conversations.filter(item => item.personId === person && item.category === category && testset.smokeIds.includes(item.id));
    if (matches.length !== 1) throw new Error('Frozen pilot case missing or duplicated');
    const visible = userConversation(matches[0]!); const found = users.find(item => item.id === visible.id);
    if (!found || testsetHash(found) !== testsetHash(visible) || found.turns.length !== 3) throw new Error('Pilot user export mismatch');
    return found;
  });
  if (new Set(selected.map(item => item.id)).size !== 4) throw new Error('Pilot identity collision');
  return selected;
}
export function validatePilotArguments(args: string[], env: NodeJS.ProcessEnv): void {
  if (args.length !== 1 || args[0] !== '--live' || env.GOAL1_LIVE_ENABLED !== 'true' || env.GOAL1_ALLOW_EXTERNAL_DATA !== 'true')
    throw new Error('Explicit --live and existing live/external-data opt-ins required');
  if ((env.GOAL1_TEXT_MODEL ?? env.PTR_MODEL) !== 'google/gemini-3-flash-preview') throw new Error('Pilot must preserve the baseline text model');
}
export function validatePilotBudget(budget: Record<string, number | string>): void {
  const cap = Number(budget.cap_microusd), calls = Number(budget.calls), callCap = Number(budget.call_cap);
  const actual = Number(budget.actual_microusd), unresolved = Number(budget.unresolved_microusd);
  if (![actual, unresolved].every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid existing budget accounting');
  if (![cap, calls, callCap].every(Number.isSafeInteger) || cap < 1 || cap > 1_000_000 || calls < 0 || callCap < 1 || callCap > 1000 || callCap - calls < PILOT_LIMITS.freshRequests)
    throw new Error('Existing global budget must have 60 request slots and remain within $1 / 1000 calls');
  if (actual + unresolved >= cap) throw new Error('Existing global budget exhausted');
}
/** Uses only the existing global ledger: no initialization, reset or independent allowance. */
export class PilotLedger implements BudgetLedger {
  private entries = new Map<string, RequestTrace[]>();
  private fresh = 0;
  private stopCode:string|undefined;
  stoppedReason():string|undefined{return this.stopCode;}
  constructor(private ledger: BudgetLedger, private trace: () => TurnTrace | undefined, private kind: () => 'text' | 'embedding',private freshLimit:number=PILOT_LIMITS.freshRequests) {}
  async reserve(key: string, amount: number): Promise<{ created: boolean; request: BudgetRequest }> {
    if (this.fresh >= this.freshLimit && !await this.ledger.get(key)){this.stopCode='PILOT_REQUEST_LIMIT';throw new ProviderError('PILOT_REQUEST_LIMIT');}
    let result:Awaited<ReturnType<BudgetLedger['reserve']>>;
    try{result=await this.ledger.reserve(key,amount);}catch(error){if(error instanceof ProviderError&&error.code==='BUDGET_EXCEEDED')this.stopCode=error.code;throw error;} if (result.created) this.fresh++;
    const trace = this.trace();
    if (trace) {
      const entry: RequestTrace = { key, created: result.created, submitted: false, kind: this.kind(), reservedMicrousd: result.request.reservedMicrousd,
        actualMicrousd: result.request.actualMicrousd, state: result.request.state };
      trace.requests.push(entry); this.entries.set(key, [...(this.entries.get(key) ?? []), entry]);
    }
    return result;
  }
  async submitted(key: string): Promise<void> { await this.ledger.submitted(key); for (const entry of this.entries.get(key) ?? []) if (entry.created) entry.submitted = true; }
  async finish(key: string, cost: number | null, response: unknown | null, id: string | null): Promise<void> {
    await this.ledger.finish(key, cost, response, id); const result = await this.ledger.get(key);
    if (result) for (const entry of this.entries.get(key) ?? []) { entry.actualMicrousd = result.actualMicrousd; entry.state = result.state; }
  }
  get(key: string): Promise<BudgetRequest | undefined> { return this.ledger.get(key); }
}
export function createMemoryPilotRuntime(env: NodeJS.ProcessEnv,limits:{textCalls:number;embeddingCalls:number;freshRequests:number}=PILOT_LIMITS) {
  if(Object.values(limits).some(value=>!Number.isSafeInteger(value)||value<1||value>1000))throw new ProviderError('INVALID_PILOT_LIMITS');
  const databaseUrl = env.GOAL1_DATABASE_URL ?? env.DATABASE_URL ?? ''; const pool = createLocalPool(databaseUrl);
  const store = new PostgresConversationStore(pool), personas = new PostgresPersonaRepository(pool), sources = new PostgresSourceRepository(pool);
  let current: MemoryTrace | undefined; let kind: 'text' | 'embedding' = 'text'; let textCalls = 0, embeddingCalls = 0;let portStop:string|undefined;
  const ledger = new PilotLedger(new PostgresBudgetLedger(pool, databaseUrl), () => current, () => kind,limits.freshRequests);
  const client = new OpenRouterClient(liveOptionsFromEnvironment({ ...env, GOAL1_DATABASE_URL: databaseUrl, GOAL1_TEXT_MODEL: env.GOAL1_TEXT_MODEL ?? env.PTR_MODEL }, ledger));
  const retrieval = new PostgresRetrieval(sources, { modelRevision: EMBEDDING_MODEL, async embed(text, options) {
    if (++embeddingCalls > limits.embeddingCalls){portStop='PILOT_EMBEDDING_LIMIT';throw new ProviderError(portStop);}
    if (current) current.embeddingCalls++; kind = 'embedding'; return (await client.embed([text], options))[0]!;
  } });
  const trackedRetrieval: Retrieval = {
    async search(query, trusted, options) {
      if (current) { current.retrievalCalls++; current.searchQueries.push(query.query ?? ''); }
      const found = await retrieval.search(query, trusted, options); current?.retrievedIds.push(...found.map(item => item.id)); return found;
    },
    async resolve(references, trusted, options) {
      if (current) current.sourceLookupCalls++; const found = await retrieval.resolve(references, trusted, options);
      current?.resolvedIds.push(...found.map(item => item.id)); return found;
    },
  };
  const chat = new ChatService({ store, personas, retrieval: trackedRetrieval, provider: { async generate(messages, options) {
    if (++textCalls > limits.textCalls){portStop='PILOT_TEXT_LIMIT';throw new ProviderError(portStop);}
    if (current) { current.textCalls++; current.promptHashes.push(testsetHash(messages)); } kind = 'text'; return client.generate(messages, options);
  } } });
  return { chat, pool, store, personas, sources, model: env.GOAL1_TEXT_MODEL ?? env.PTR_MODEL!,
    setTrace(trace?: TurnTrace) { current = trace as MemoryTrace | undefined; if (current) { current.sourceLookupCalls = 0; current.searchQueries = []; current.resolvedIds = []; } },
    haltedReason:()=>ledger.stoppedReason()??portStop,close: () => pool.end() };
}
export async function budgetSnapshot(pool: Pool): Promise<Record<string, number | string>> {
  const result = await pool.query(`SELECT b.cap_microusd,b.call_cap,count(r.key)::int AS calls,
    COALESCE(sum(r.actual_microusd),0)::bigint AS actual_microusd,
    COALESCE(sum(GREATEST(r.reserved_microusd,COALESCE(r.actual_microusd,0))) FILTER(WHERE r.state<>'settled'),0)::bigint AS unresolved_microusd
    FROM ptr_provider_budget b LEFT JOIN ptr_provider_requests r ON true WHERE b.id='global' GROUP BY b.cap_microusd,b.call_cap`);
  if (result.rows.length !== 1) throw new Error('Existing global budget required; never reset it'); return result.rows[0] as Record<string, number | string>;
}
export async function codeFingerprint(): Promise<string> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !['node_modules', '.next'].includes(entry.name)) await walk(path);
      else if (entry.isFile() && /\.(ts|tsx|sql)$/.test(entry.name)) files.push(path);
    }
  };
  for (const directory of ['packages', 'apps/api', 'apps/web/app', 'scripts', 'supabase/migrations']) await walk(directory);
  return testsetHash(await Promise.all(files.sort().map(async path => [path, testsetHash(await readFile(path, 'utf8'))])));
}
export async function corpusSnapshot(pool: Pool, sources: SourcePost[], plan: AnnotationPlan): Promise<CorpusRow[]> {
  const result = await pool.query(`SELECT p.id,p.person_id,p.source_hash,p.content_hash,p.unsafe,
    md5(c.embedding::text) AS caption_vector_hash,r.revision AS annotation_revision,r.content_hash AS annotation_content_hash,
    md5(v.embedding::text) AS image_vector_hash FROM source_posts p
    LEFT JOIN source_vectors c ON c.source_id=p.id AND c.model_revision=$1
    LEFT JOIN LATERAL(SELECT revision,content_hash FROM source_image_revisions WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1)r ON true
    LEFT JOIN source_image_vectors v ON v.source_id=p.id AND v.annotation_revision=r.revision AND v.model_revision=$1
    WHERE p.person_id=ANY($2::text[]) ORDER BY p.id`, [EMBEDDING_MODEL, [...new Set(sources.map(source => source.personId))]]);
  validateCorpus(result.rows as CorpusRow[], sources, plan); return result.rows as CorpusRow[];
}
export async function runMemoryPilot(args: string[]): Promise<void> {
  validatePilotArguments(args, process.env);
  const pointer = JSON.parse(await readFile('data/research/character-chat-testset.latest.json', 'utf8')) as { directory: string; revision: string };
  if (pointer.directory !== `data/research/character-chat-testsets/${pointer.revision}` || !/^[a-f0-9]{64}$/.test(pointer.revision)) throw new Error('Unsafe frozen testset pointer');
  const evaluator = JSON.parse(await readFile(`${pointer.directory}/evaluator.json`, 'utf8')) as ChatTestset;
  const paths = { seed: 'data/research/character-chat-curation.private.json', personas: 'data/research/personas.json', sources: 'data/research/sources.json',
    split: 'data/research/split.json', images: 'data/research/image_descriptions_v5_declarative/images.jsonl' };
  const texts: Record<string, string> = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, 'utf8')])));
  const sources = JSON.parse(texts.sources!) as SourcePost[], personas = JSON.parse(texts.personas!) as Persona[];
  const plan = prepareImageAnnotations(texts.images!.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as unknown), sources);
  const rebuilt = prepareChatTestset(JSON.parse(texts.seed!), personas, sources, plan, JSON.parse(texts.split!) as Record<string, string>,
    Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, testsetHash(text)])));
  const { frozenAt: _old, ...frozen } = evaluator, { frozenAt: _new, ...current } = rebuilt;
  if (evaluator.revision !== pointer.revision || testsetHash(frozen) !== testsetHash(current)) throw new Error('Frozen evaluator/assets changed');
  const conversations = selectMemoryPilot(evaluator, validateUserExport(evaluator, JSON.parse(await readFile(`${pointer.directory}/user.json`, 'utf8'))));
  const runtime = createMemoryPilotRuntime(process.env), rows: NaturalChatRow[] = [];
  const startedAt = new Date().toISOString(), directory = `reports/memory-context/pilot-${startedAt.replace(/[:.]/g, '-')}`, owner = `memory-pilot-${randomUUID()}`;
  try {
    const before = await codeFingerprint(), codeCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), budgetBefore = await budgetSnapshot(runtime.pool); validatePilotBudget(budgetBefore);
    const corpusBefore = await corpusSnapshot(runtime.pool, sources, plan);
    for (const persona of personas) if (testsetHash(await runtime.personas.get(persona.id, persona.revision)) !== testsetHash(persona)) throw new Error('Registered persona differs from frozen assets');
    await privateJson(`${directory}/preflight.json`, { startedAt, testsetRevision: evaluator.revision, codeCommit, codeFingerprint: before, corpusFingerprint: testsetHash(corpusBefore), budgetBefore,
      limits: PILOT_LIMITS, executionProfile: 'legacy', noForcedIntentOrQuery: true, conditionOrder: 'rotating', selectedConversationIds: conversations.map(item => item.id) });
    for (const [index, conversation] of conversations.entries()) for (const condition of CONDITIONS.map((_, offset) => CONDITIONS[(index + offset) % 3]!)) {
      await executeNaturalConversation(runtime, owner, conversation, condition, async row => {
        rows.push(row); await privateJson(`${directory}/progress.json`, { startedAt, observedAt: new Date().toISOString(), planned: PILOT_LIMITS.turns, completed: rows.length, rows, summary: summarizeNaturalRows(rows) });
        console.log(JSON.stringify({ completed: rows.length, planned: PILOT_LIMITS.turns, condition, state: row.trace.state, status: row.reply?.status,
          action: row.reply?.retrievalContext?.action, textCalls: row.trace.textCalls, embeddingCalls: row.trace.embeddingCalls, sourceLookupCalls: (row.trace as MemoryTrace).sourceLookupCalls, errors: row.trace.errors }));
      }, 750, 'legacy');
    }
    const after = await codeFingerprint(), corpusAfter = await corpusSnapshot(runtime.pool, sources, plan);
    if (before !== after || testsetHash(corpusBefore) !== testsetHash(corpusAfter)) throw new Error('Code or retrieval corpus changed during pilot');
    const report = { execution: 'live', label: 'memory-context-pilot', executionProfile: 'legacy', startedAt, finishedAt: new Date().toISOString(), completed: rows.length, planned: PILOT_LIMITS.turns,
      revision: evaluator.revision, promptRevision: EXPERIMENT_PROMPT_REVISION, contextRevision: RETRIEVAL_CONTEXT_REVISION, model: runtime.model, embeddingModel: EMBEDDING_MODEL,
      codeCommit, codeFingerprint: before, codeUnchanged: true, corpusFingerprint: testsetHash(corpusBefore), corpusUnchanged: true, budgetBefore, budgetAfter: await budgetSnapshot(runtime.pool),
      limits: PILOT_LIMITS, rows, summary: summarizeNaturalRows(rows), humanReview: 'pending', limitations: [...evaluator.limitations,
        'Four previously observed conversations: a regression pilot, not a blind accuracy benchmark or controlled causal estimate.',
        'Same user-only natural inputs, evolving assistant histories, no forced evaluator query, intent or date.',
        'Source lookup is original evidence revalidation, not an extra text-model or embedding request.',
        'Port calls and created billed requests differ because persistent provider caches may replay responses.',
        'Exact quote binding and answered status are operational measures, not factual or conversational accuracy.'] };
    await privateJson(`${directory}/report.json`, report);
    await privateJson('reports/memory-context/latest.json', { directory, finishedAt: report.finishedAt, completed: rows.length });
    console.log(JSON.stringify({ directory, completed: rows.length, summary: report.summary }));
  } catch (error) {
    await privateJson(`${directory}/failure.json`, { startedAt, observedAt: new Date().toISOString(), completed: rows.length, planned: PILOT_LIMITS.turns, rows,
      budgetAfter: await budgetSnapshot(runtime.pool).catch(() => ({ unavailable: true })), noImplicitRetry: true }); throw error;
  } finally { await runtime.close(); }
}
if (require.main === module) void runMemoryPilot(process.argv.slice(2)).catch(() => {
  console.error('Memory pilot stopped; private progress/failure preserved without automatic resubmission.'); process.exitCode = 1;
});
