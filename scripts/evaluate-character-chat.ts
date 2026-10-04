import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatReply, ExecutionProfile, Persona, RagCondition, SourcePost } from '@ptr/contracts';
import { AGENT_PROMPT_REVISION, AGENT_RUNTIME_REVISION } from '@ptr/core';
import { DEFAULT_TEXT_MODEL, EMBEDDING_MODEL } from '@ptr/providers';
import { createHarnessRuntime, type HarnessRuntime, type TurnTrace } from './evaluate';
import { CONDITIONS, validateCorpus, type CorpusRow } from './evaluate-image-rag';
import { prepareImageAnnotations, type AnnotationPlan } from './import-image-annotations';
import { prepareChatTestset, testsetHash, userConversation, type ChatTestset } from './prepare-character-chat-testset';
import { privateJson } from './prepare-research';

export type UserConversation = ReturnType<typeof userConversation>;
export interface NaturalChatRow {
  conversationId: string; userTurnId: string; turnIndex: number; condition: RagCondition; personId: string;
  text: string; trace: TurnTrace; reply?: ChatReply;
}
/** The only turn input boundary: no evaluator behavior, gold query, date filter, or forced intent. */
export function naturalTurnInput(sessionId: string, turn: { id: string; text: string }) {
  return { sessionId, clientRequestId: randomUUID(), text: turn.text };
}
export function validateUserExport(testset: ChatTestset, value: unknown): UserConversation[] {
  const expected = { version: testset.version, revision: testset.revision, asOf: testset.asOf,
    smokeConversationIds: testset.conversations.filter(item => testset.smokeIds.includes(item.id)).map(item => userConversation(item).id),
    conversations: testset.conversations.map(userConversation) };
  if (testsetHash(expected) !== testsetHash(value)) throw new Error('Frozen user export changed or contains hidden fields');
  return expected.conversations.filter(item => expected.smokeConversationIds.includes(item.id));
}
export async function executeNaturalConversation(runtime: Pick<HarnessRuntime, 'chat' | 'setTrace'>, owner: string,
  conversation: UserConversation, condition: RagCondition, onRow: (row: NaturalChatRow) => Promise<void>, cooldownMs = 0, executionProfile:ExecutionProfile = 'agent_loop'): Promise<void> {
  const session = await runtime.chat.createSession(owner, { personId: conversation.personId, personaId: conversation.personaId,
    personaRevision: conversation.personaRevision, timezone: 'Asia/Seoul', ragCondition: condition, retrievalMode: condition === 'off' ? 'off' : 'semantic',executionProfile });
  for (const [turnIndex, input] of conversation.turns.entries()) {
    const trace: TurnTrace = { id: `${input.id}-${condition}`, stage: 'natural-character-chat', mode: condition === 'off' ? 'off' : 'semantic',
      historyKind: 'evolving', personId: conversation.personId, goldSourceIds: [], retrievedIds: [], promptHashes: [], latencyMs: 0,
      state: 'pending', status: null, errors: [], textCalls: 0, embeddingCalls: 0, retrievalCalls: 0, requests: [], sourceRecallAt5: null,
      validQuotes: 0, totalQuotes: 0, crossPersonEvidence: 0, statusSurrogateMatch: null, sessionId: session.id };
    runtime.setTrace(trace); const began = Date.now(); let reply: ChatReply | undefined;
    try {
      const initial = await runtime.chat.startTurn(owner, naturalTurnInput(session.id, input)); trace.turnId = initial.id;
      for (let attempt = 0; attempt < 1800; attempt++) {
        const turn = await runtime.chat.getTurn(owner, initial.id);
        if (['completed', 'failed', 'cancelled'].includes(turn.state)) {
          trace.state = turn.state; reply = turn.reply; if (turn.errorCode) trace.errors.push(turn.errorCode); break;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (trace.state === 'pending') { await runtime.chat.cancelTurn(owner, initial.id); trace.state = 'timeout'; trace.errors.push('HARNESS_TIMEOUT'); }
      trace.status = reply?.status ?? null; trace.reply = reply;
      trace.totalQuotes = reply?.evidence.length ?? 0; trace.validQuotes = trace.totalQuotes;
      trace.crossPersonEvidence = reply?.evidence.filter(card => card.personId !== conversation.personId).length ?? 0;
      if (trace.crossPersonEvidence) trace.errors.push('CROSS_PERSON_EVIDENCE');
      if (condition === 'off' && (trace.retrievalCalls || trace.embeddingCalls || reply?.evidence.length)) trace.errors.push('OFF_ISOLATION_FAILED');
      if (condition === 'caption' && reply?.evidence.some(card => card.origin === 'ai_image_annotation')) trace.errors.push('CAPTION_IMAGE_LEAK');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
      trace.errors.push(/^[A-Z][A-Z0-9_]{0,80}$/.test(code) ? code : 'HARNESS_ERROR'); trace.state = 'failed';
    } finally { trace.latencyMs = Date.now() - began; runtime.setTrace(undefined); }
    await onRow({ conversationId: conversation.id, userTurnId: input.id, turnIndex, condition, personId: conversation.personId, text: input.text, trace, reply });
    if (trace.state !== 'completed' || trace.errors.length) throw new Error('Trial failed; preserve result without automatic resubmission');
    if (cooldownMs) await new Promise(resolve => setTimeout(resolve, cooldownMs));
  }
}
/** Operational measures only: answered/quote binding are NOT conversational or factual accuracy. */
export function summarizeNaturalRows(rows: NaturalChatRow[]) {
  return Object.fromEntries(CONDITIONS.map(condition => {
    const group = rows.filter(row => row.condition === condition);
    return [condition, { turns: group.length, completed: group.filter(row => row.trace.state === 'completed').length,
      statusCounts: Object.fromEntries(['answered', 'insufficient_evidence', 'needs_clarification', 'out_of_scope'].map(status => [status, group.filter(row => row.reply?.status === status).length])),
      invalidModelEvidence: group.filter(row => row.reply?.limitations.includes('INVALID_MODEL_EVIDENCE')).length,
      groundedTurns: group.filter(row => row.reply?.grounding === 'source_bound_quotes').length,
      retrievalCalls: group.reduce((n, row) => n + row.trace.retrievalCalls, 0), embeddingCalls: group.reduce((n, row) => n + row.trace.embeddingCalls, 0),
      textCalls: group.reduce((n, row) => n + row.trace.textCalls, 0), crossPersonEvidence: group.reduce((n, row) => n + row.trace.crossPersonEvidence, 0),
      createdRequests: group.flatMap(row => row.trace.requests).filter(request => request.created).length,
      actualMicrousd: group.flatMap(row => row.trace.requests).filter(request => request.created).reduce((n, request) => n + (request.actualMicrousd ?? 0), 0),
      meanLatencyMs: group.length ? group.reduce((n, row) => n + row.trace.latencyMs, 0) / group.length : null }];
  }));
}
async function codeFingerprint(): Promise<string> {
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
async function corpusSnapshot(runtime: HarnessRuntime, sources: SourcePost[], plan: AnnotationPlan): Promise<CorpusRow[]> {
  const result = await runtime.pool.query(`SELECT p.id,p.person_id,p.source_hash,p.content_hash,p.unsafe,
    md5(c.embedding::text) AS caption_vector_hash,r.revision AS annotation_revision,r.content_hash AS annotation_content_hash,
    md5(v.embedding::text) AS image_vector_hash FROM source_posts p
    LEFT JOIN source_vectors c ON c.source_id=p.id AND c.model_revision=$1
    LEFT JOIN LATERAL(SELECT revision,content_hash FROM source_image_revisions WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1)r ON true
    LEFT JOIN source_image_vectors v ON v.source_id=p.id AND v.annotation_revision=r.revision AND v.model_revision=$1
    WHERE p.person_id=ANY($2::text[]) ORDER BY p.id`, [EMBEDDING_MODEL, [...new Set(sources.map(source => source.personId))]]);
  validateCorpus(result.rows as CorpusRow[], sources, plan); return result.rows as CorpusRow[];
}
async function budgetSnapshot(runtime: HarnessRuntime) {
  const result = await runtime.pool.query(`SELECT b.cap_microusd,b.call_cap,count(r.key)::int AS calls,
    COALESCE(sum(r.actual_microusd),0)::bigint AS actual_microusd,
    COALESCE(sum(GREATEST(r.reserved_microusd,COALESCE(r.actual_microusd,0))) FILTER(WHERE r.state<>'settled'),0)::bigint AS unresolved_microusd
    FROM ptr_provider_budget b LEFT JOIN ptr_provider_requests r ON true WHERE b.id='global' GROUP BY b.cap_microusd,b.call_cap`);
  if (result.rows.length !== 1) throw new Error('Existing global budget required; never reset it');
  return result.rows[0] as Record<string, number | string>;
}
export async function runNaturalChat(args: string[]): Promise<void> {
  if (args.length !== 2 || !args.includes('--live') || !args.includes('--smoke') || process.env.GOAL1_LIVE_ENABLED !== 'true')
    throw new Error('Only explicit live 8-conversation smoke is supported');
  const pointer = JSON.parse(await readFile('data/research/character-chat-testset.latest.json', 'utf8')) as { directory: string; revision: string };
  if (pointer.directory !== `data/research/character-chat-testsets/${pointer.revision}` || !/^[a-f0-9]{64}$/.test(pointer.revision)) throw new Error('Unsafe testset pointer');
  const evaluator = JSON.parse(await readFile(`${pointer.directory}/evaluator.json`, 'utf8')) as ChatTestset;
  const paths = { seed: 'data/research/character-chat-curation.private.json', personas: 'data/research/personas.json', sources: 'data/research/sources.json',
    split: 'data/research/split.json', images: 'data/research/image_descriptions_v5_declarative/images.jsonl' };
  const texts: Record<string, string> = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, 'utf8')])));
  const sources = JSON.parse(texts.sources!) as SourcePost[];
  const plan = prepareImageAnnotations(texts.images!.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as unknown), sources);
  const personas = JSON.parse(texts.personas!) as Persona[];
  const rebuilt = prepareChatTestset(JSON.parse(texts.seed!), personas, sources, plan,
    JSON.parse(texts.split!) as Record<string, string>, Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, testsetHash(text)])));
  const { frozenAt: _old, ...frozen } = evaluator; const { frozenAt: _new, ...current } = rebuilt;
  if (evaluator.revision !== pointer.revision || testsetHash(frozen) !== testsetHash(current)) throw new Error('Frozen evaluator/assets changed');
  const conversations = validateUserExport(evaluator, JSON.parse(await readFile(`${pointer.directory}/user.json`, 'utf8')));
  if (conversations.length !== 8 || conversations.some(item => item.turns.length !== 3)) throw new Error('Smoke shape changed');
  const runtime = createHarnessRuntime({ ...process.env, GOAL1_TEXT_MODEL: process.env.GOAL1_TEXT_MODEL ?? process.env.PTR_MODEL ?? DEFAULT_TEXT_MODEL }, true);
  const startedAt = new Date().toISOString(); const directory = `reports/character-chat/smoke-${startedAt.replace(/[:.]/g, '-')}`;
  const rows: NaturalChatRow[] = []; const before = await codeFingerprint(); const owner = `natural-chat-${randomUUID()}`;
  try {
    const budgetBefore = await budgetSnapshot(runtime);
    // Require120 available slots, not a completion guarantee: agent-loop tool rounds can add calls.
    // Existing global reservations enforce the unchanged budget and stop without retry.
    if (Number(budgetBefore.call_cap) - Number(budgetBefore.calls) < 120 || Number(budgetBefore.cap_microusd) > 1_000_000)
      throw new Error('Insufficient existing request slots or unsafe budget');
    const corpusBefore = await corpusSnapshot(runtime, sources, plan);
    for (const persona of personas) if (testsetHash(await runtime.personas.get(persona.id, persona.revision)) !== testsetHash(persona))
      throw new Error('Registered persona differs from frozen assets');
    await privateJson(`${directory}/preflight.json`, { startedAt, revision: evaluator.revision, codeFingerprint: before, budgetBefore,
      corpusFingerprint: testsetHash(corpusBefore), corpusBefore, planned: 72, executionProfile: 'agent_loop', noForcedIntentOrQuery: true });
    for (const [index, conversation] of conversations.entries()) {
      for (const condition of CONDITIONS.map((_, offset) => CONDITIONS[(index + offset) % 3]!)) {
        await executeNaturalConversation(runtime, owner, conversation, condition, async row => {
          rows.push(row); await privateJson(`${directory}/progress.json`, { startedAt, observedAt: new Date().toISOString(), completed: rows.length,
            planned: 72, rows, summary: summarizeNaturalRows(rows) });
          console.log(JSON.stringify({ completed: rows.length, planned: 72, condition, state: row.trace.state, status: row.reply?.status,
            retrievalCalls: row.trace.retrievalCalls, errors: row.trace.errors }));
        }, 750);
      }
    }
    const after = await codeFingerprint(); const corpusAfter = await corpusSnapshot(runtime, sources, plan);
    if (before !== after || testsetHash(corpusBefore) !== testsetHash(corpusAfter)) throw new Error('Code or retrieval corpus changed during trial');
    const report = { execution: 'live', label: 'natural-chat-smoke', startedAt, finishedAt: new Date().toISOString(), completed: rows.length, planned: 72,
      revision: evaluator.revision, executionProfile: 'agent_loop', promptRevision: AGENT_PROMPT_REVISION, agentRevision: AGENT_RUNTIME_REVISION, model: runtime.model, embeddingModel: EMBEDDING_MODEL,
      codeFingerprint: before, codeUnchanged: true, corpusFingerprint: testsetHash(corpusBefore), corpusUnchanged: true,
      budgetBefore, budgetAfter: await budgetSnapshot(runtime), summary: summarizeNaturalRows(rows), rows,
      humanReview: 'pending', limitations: [...evaluator.limitations,
        'Eight scripted conversations only; operational measures are not quality scores or causal accuracy estimates.',
        'agent-loop profile fixed across three conditions; tool rounds can add text/embedding calls within the unchanged global budget.',
        'Natural inputs only. Evaluator asOf is recorded, not injected into the unchanged production prompt.',
        'Three real evolving turns per condition; no fixed/oracle assistant history or forced retrieval.',
        'Latency includes SQL and persistent provider caches; 750ms inter-turn cooldown is excluded.',
        'Quote binding validates substrings, not answer entailment; qualitative claim review is separate.'] };
    await privateJson(`${directory}/report.json`, report);
    await privateJson('reports/character-chat/latest.json', { directory, finishedAt: report.finishedAt, completed: rows.length });
    console.log(JSON.stringify({ directory, completed: rows.length, summary: report.summary }));
  } catch (error) {
    await privateJson(`${directory}/failure.json`, { startedAt, observedAt: new Date().toISOString(), completed: rows.length, planned: 72, rows,
      summary: summarizeNaturalRows(rows), executionProfile: 'agent_loop', codeFingerprint: before, noImplicitRetry: true });
    throw error;
  } finally { await runtime.close(); }
}
if (require.main === module) void runNaturalChat(process.argv.slice(2)).catch(() => {
  console.error('Natural chat trial stopped; private progress/failure preserved, no automatic resubmission.'); process.exitCode = 1;
});
