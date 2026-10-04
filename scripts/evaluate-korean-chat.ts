import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { PersonaSchema, type Persona, type SourcePost } from '@ptr/contracts';
import { AGENT_PROMPT_REVISION, AGENT_RUNTIME_REVISION } from '@ptr/core';
import { EMBEDDING_MODEL, MAX_PROVIDER_CALLS, MAX_TOTAL_MICROUSD } from '@ptr/providers';
import { executeNaturalConversation, summarizeNaturalRows, validateUserExport, type UserConversation, type NaturalChatRow } from './evaluate-character-chat';
import { budgetSnapshot, codeFingerprint, corpusSnapshot, createMemoryPilotRuntime, selectMemoryPilot, validatePilotArguments } from './evaluate-memory-context';
import { CONDITIONS } from './evaluate-image-rag';
import { prepareImageAnnotations } from './import-image-annotations';
import { testsetHash, type ChatTestset } from './prepare-character-chat-testset';
import { privateJson } from './prepare-research';

export const KOREAN_LIMITS = { turns: 72, textCalls: 216, embeddingCalls: 96, freshRequests: 90 } as const;
export const RECOLLECTION_LIMITS = { ...KOREAN_LIMITS, freshRequests: 60 } as const;
interface KoreanRow extends NaturalChatRow { executionProfile: 'agent_loop'; conversationKind: 'memory' | 'style' }
const koreanText = z.string().min(1).max(1000).refine(text => /[가-힣]/u.test(text), 'Korean question required');
export const KoreanSeedSchema = z.object({
  translations: z.record(koreanText), styleProbe: z.array(koreanText).length(3),
  styleRubricHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export function prepareKoreanStudy(personaInputs: Persona[], memories: UserConversation[], seedInput: unknown) {
  const seed = KoreanSeedSchema.parse(seedInput), original = personaInputs.map(p => PersonaSchema.parse(p));
  if (original.length !== 4 || memories.length !== 4 || new Set(original.map(p => p.personId)).size !== 4 || new Set(memories.map(c => c.personId)).size !== 4)
    throw new Error('Exactly four independent person bindings required');
  const translationsNeeded = memories.flatMap(c => {
    const persona = original.find(p => p.personId === c.personId);
    if (!persona || c.personaId !== persona.id || c.personaRevision !== persona.revision || c.turns.length !== 3) throw new Error('Memory/persona binding changed');
    return persona.language === 'ko' ? [] : c.turns.map(t => t.id);
  });
  if (translationsNeeded.length !== Object.keys(seed.translations).length || translationsNeeded.some(id => !seed.translations[id])) throw new Error('Exact foreign-question translation coverage required');
  const personas = original.map(persona => {
    if (persona.language === 'ko') return persona;
    const translated = { ...persona, id: `${persona.id}:ko-study`, language: 'ko',
      style: persona.style.map(rule => rule === 'Use natural English.' ? 'Use natural Korean.' : rule),
      greeting: '안녕! 실제 인물이 아닌 연구용 AI야. 공개 게시물 근거와 가상 아이디어를 구분해서 이야기할게.' };
    if (translated.style.some(rule => /Use natural English/i.test(rule))) throw new Error('Conflicting language instructions');
    return PersonaSchema.parse({ ...translated, revision: `ko-study-${testsetHash(translated).slice(0, 24)}` });
  });
  const conversations = memories.flatMap(memory => {
    const persona = personas.find(p => p.personId === memory.personId)!;
    const binding = { personId: persona.personId, personaId: persona.id, personaRevision: persona.revision };
    const translated: UserConversation = { ...binding, id: `ko-memory:${memory.id}`, turns: memory.turns.map(turn => ({
      id: `ko:${turn.id}`, text: seed.translations[turn.id] ?? koreanText.parse(turn.text) })) };
    const style: UserConversation = { ...binding, id: `ko-style:${memory.personId}`, turns: seed.styleProbe.map((text, i) => ({ id: `ko-style:${memory.personId}:${i + 1}`, text })) };
    return [translated, style];
  });
  return { executionProfile: 'agent_loop' as const, personas, conversations, styleRubricHash: seed.styleRubricHash,
    originalPersonaHashes: original.map(p => ({ id: p.id, revision: p.revision, hash: testsetHash(p) })),
    languageVariantPersonas: personas.filter(p => !original.some(old => old.id === p.id)).map(p => p.id) };
}
export function validateKoreanBudget(budget: Record<string, string | number>, freshLimit: number = KOREAN_LIMITS.freshRequests) {
  if (!Number.isSafeInteger(freshLimit) || freshLimit < 1 || freshLimit > KOREAN_LIMITS.freshRequests) throw new Error('Invalid bounded Korean request limit');
  const { cap_microusd: cap, call_cap: max, calls, actual_microusd: actual, unresolved_microusd: unresolved } = budget;
  if (![cap, max, calls, actual, unresolved].map(Number).every(n => Number.isSafeInteger(n) && n >= 0) || Number(cap) < 1 || Number(cap) > MAX_TOTAL_MICROUSD || Number(max) > MAX_PROVIDER_CALLS ||
    Number(max) < 1 || Number(max) - Number(calls) < freshLimit || Number(actual) + Number(unresolved) >= Number(cap)) throw new Error('Existing global budget must retain requested slots; never reset');
}
export async function runKoreanChat(args: string[], recollection = false) {
  validatePilotArguments(args, process.env);
  const pointer = JSON.parse(await readFile('data/research/character-chat-testset.latest.json', 'utf8')) as { directory: string; revision: string };
  if (!/^[a-f0-9]{64}$/.test(pointer.revision) || pointer.directory !== `data/research/character-chat-testsets/${pointer.revision}`) throw new Error('Unsafe frozen pointer');
  const evaluator = JSON.parse(await readFile(`${pointer.directory}/evaluator.json`, 'utf8')) as ChatTestset;
  if (evaluator.revision !== pointer.revision) throw new Error('Frozen testset mismatch');
  const users = validateUserExport(evaluator, JSON.parse(await readFile(`${pointer.directory}/user.json`, 'utf8')));
  const baseline = JSON.parse(await readFile('data/research/personas.json', 'utf8')) as Persona[];
  const seed = JSON.parse(await readFile('data/research/korean-chat-seed.private.json', 'utf8')) as unknown;
  const rubric = JSON.parse(await readFile('reports/korean-chat/style-rubric.private.json', 'utf8')) as unknown;
  const study = prepareKoreanStudy(baseline, selectMemoryPilot(evaluator, users), seed);
  if (testsetHash(rubric) !== study.styleRubricHash) throw new Error('Style rubric changed before run');
  const sources = JSON.parse(await readFile('data/research/sources.json', 'utf8')) as SourcePost[];
  const images = (await readFile('data/research/image_descriptions_v5_declarative/images.jsonl', 'utf8')).split('\n').filter(t => t.trim()).map(t => JSON.parse(t) as unknown);
  const limits = recollection ? RECOLLECTION_LIMITS : KOREAN_LIMITS;
  let parent: { directory: string; reportHash: string } | undefined, recollectionRubricHash: string | undefined;
  if (recollection) {
    const archived = JSON.parse(await readFile('reports/korean-chat/latest.json', 'utf8')) as { directory: string };
    if (!/^reports\/korean-chat\/run-[0-9TZ-]+$/.test(archived.directory)) throw new Error('Unsafe baseline pointer');
    const report = JSON.parse(await readFile(`${archived.directory}/report.json`, 'utf8')) as { studyHash: string; completed: number; model: string };
    if (report.studyHash !== testsetHash(study) || report.completed !== 72 || report.model !== (process.env.GOAL1_TEXT_MODEL ?? process.env.PTR_MODEL)) throw new Error('Paired Korean baseline changed');
    parent = { directory: archived.directory, reportHash: testsetHash(report) };
    recollectionRubricHash = testsetHash(JSON.parse(await readFile('reports/recollection-chat/recollection-rubric.private.json', 'utf8')));
  }
  const plan = prepareImageAnnotations(images, sources), runtime = createMemoryPilotRuntime(process.env, limits);
  const startedAt = new Date().toISOString(), directory = `reports/${recollection ? 'recollection-chat' : 'korean-chat'}/run-${startedAt.replace(/[:.]/g, '-')}`, owner = `ko-study-${randomUUID()}`;
  const rows: KoreanRow[] = [], failures: unknown[] = [];
  try {
    const budgetBefore = await budgetSnapshot(runtime.pool); validateKoreanBudget(budgetBefore, limits.freshRequests);
    const codeBefore = await codeFingerprint(), corpusBefore = await corpusSnapshot(runtime.pool, sources, plan);
    const originalDbHashes = await Promise.all(baseline.map(async p => testsetHash(await runtime.personas.get(p.id, p.revision))));
    if (originalDbHashes.some((hash, i) => hash !== testsetHash(baseline[i]))) throw new Error('Baseline registered persona mismatch');
    const originalCurrentHashes = await Promise.all(baseline.map(async p => testsetHash(await runtime.personas.get(p.id))));
    for (const persona of study.personas) if (study.languageVariantPersonas.includes(persona.id)) await runtime.personas.importPersona(persona);
    await privateJson(`${directory}/preflight.json`, { startedAt, study, studyHash: testsetHash(study), limits, parent, recollectionRubricHash, promptRevision: AGENT_PROMPT_REVISION,
      codeCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), codeFingerprint: codeBefore,
      corpusFingerprint: testsetHash(corpusBefore), budgetBefore, model: runtime.model, maxToolRounds: 2, validator: 'disabled',
      note: 'Original persona/current pointers preserved. Planned72; bounded fresh cap can stop completion. Recollection mode prioritizes memory conversations, preserving all question text and study bindings.' });
    const conversations = recollection ? [...study.conversations.filter(c => c.id.startsWith('ko-memory:')), ...study.conversations.filter(c => c.id.startsWith('ko-style:'))] : study.conversations;
    conversationLoop: for (const [index, conversation] of conversations.entries()) for (const condition of CONDITIONS.map((_, offset) => CONDITIONS[(index + offset) % 3]!)) {
      try {
        await executeNaturalConversation(runtime, owner, conversation, condition, async row => {
          rows.push({ ...row, executionProfile: 'agent_loop', conversationKind: conversation.id.startsWith('ko-memory:') ? 'memory' : 'style' });
          await privateJson(`${directory}/progress.json`, { startedAt, observedAt: new Date().toISOString(), planned: 72, rows, failures });
          console.log(JSON.stringify({ observed: rows.length, planned: 72, condition, conversationKind: conversation.id.startsWith('ko-memory:') ? 'memory' : 'style', state: row.trace.state }));
        }, 750, 'agent_loop');
      } catch {
        failures.push({ conversationId: conversation.id, condition, observedAt: new Date().toISOString(), skippedFollowups: 3 - rows.filter(r => r.conversationId === conversation.id && r.condition === condition).length });
        if (runtime.haltedReason()) break conversationLoop;
      }
    }
    if (codeBefore !== await codeFingerprint() || testsetHash(corpusBefore) !== testsetHash(await corpusSnapshot(runtime.pool, sources, plan))) throw new Error('Code/corpus changed');
    for (const [i, p] of baseline.entries()) if (testsetHash(await runtime.personas.get(p.id)) !== originalCurrentHashes[i]) throw new Error('Original persona current pointer changed');
    const keys = [...new Set(rows.flatMap(r => r.trace.requests.map(q => q.key)))];
    const accounting = await runtime.pool.query('SELECT key,state,reserved_microusd,actual_microusd,generation_id,response_json FROM ptr_provider_requests WHERE key=ANY($1::text[])', [keys]);
    await privateJson(`${directory}/provider-responses.private.json`, accounting.rows);
    const report = { execution: 'live', label: recollection ? 'first-person-recollection-three-condition-study' : 'korean-three-condition-persona-study', startedAt, finishedAt: new Date().toISOString(),
      planned: 72, limits, parent, recollectionRubricHash, haltedReason: runtime.haltedReason() ?? null, skipped: 72 - rows.length, observed: rows.length, completed: rows.filter(r => r.trace.state === 'completed').length, rows, failures,
      study, studyHash: testsetHash(study), baselineTestsetRevision: evaluator.revision, model: runtime.model,
      executionProfile: 'agent_loop', promptRevision: AGENT_PROMPT_REVISION, agentRevision: AGENT_RUNTIME_REVISION, embeddingModel: EMBEDDING_MODEL,
      budgetBefore, budgetAfter: await budgetSnapshot(runtime.pool), codeUnchanged: true, corpusUnchanged: true,
      originalPersonasUnchanged: true, summary: summarizeNaturalRows(rows), humanReview: 'pending', limitations: [
        'Korean translations and foreign language-only persona variants jointly differ from previous English runs; not an isolated language-effect experiment.',
        'Existing generic silver persona definition adherence, not real-person personality/voice fidelity.',
        'Previously seen memory conversations plus a same-persona casual probe; not unseen human-gold accuracy.',
        'Failed requests are not retried; dependent followups are skipped. Local cache replay is not fresh billing.',
      ] };
    await privateJson(`${directory}/report.json`, report); await privateJson(`reports/${recollection ? 'recollection-chat' : 'korean-chat'}/latest.json`, { directory, finishedAt: report.finishedAt });
    console.log(JSON.stringify({ directory, completed: report.completed, observed: rows.length, failures: failures.length }));
  } catch {
    await privateJson(`${directory}/failure.json`, { startedAt, observedAt: new Date().toISOString(), planned: 72, rows, failures, noRetry: true });
    throw new Error('Korean study stopped; private observations preserved');
  } finally { await runtime.close(); }
}
if (require.main === module) {
  const args = process.argv.slice(2), recollection = args.length === 2 && args[0] === '--live' && args[1] === '--recollection';
  void runKoreanChat(recollection ? ['--live'] : args, recollection).catch(() => {
    console.error('Korean study stopped; no automatic retry or budget reset.'); process.exitCode = 1;
  });
}
