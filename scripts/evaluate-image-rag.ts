import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { ChatReply, Persona, RagCondition, SourcePost } from '@ptr/contracts';
import { EXPERIMENT_PROMPT_REVISION } from '@ptr/core';
import { ImageAnnotationInputSchema } from '@ptr/storage';
import { EMBEDDING_MODEL, DEFAULT_TEXT_MODEL } from '@ptr/providers';
import { prepareImageAnnotations, type AnnotationPlan } from './import-image-annotations';
import { createHarnessRuntime, sourceRecall, type EvaluationInput, type TurnTrace } from './evaluate';
import { privateJson } from './prepare-research';

export const CONDITIONS: RagCondition[] = ['off', 'caption', 'caption_image'];
function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return value;
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const timelineSchema = z.object({ query: z.string().min(1).max(500), start: z.string().optional(), end: z.string().optional(), dateBasis: z.literal('posted'), limit: z.literal(5) });
const caseSchema = z.object({ id: z.string(), personId: z.string(), personaId: z.string(), personaRevision: z.string(),
  text: z.string(), timeline: timelineSchema, category: z.enum(['caption', 'image', 'both', 'negative']),
  goldSourceIds: z.array(z.string()), goldAnnotationIds: z.array(z.string()), split: z.literal('test') });
export const ExperimentSchema = z.object({ version: z.literal('image-rag-ablation-v1'), revision: z.string(), frozenAt: z.string(),
  sourceFileHash: z.string(), imageFileHash: z.string(), annotationPlanHash: z.string(),
  cases: z.array(caseSchema).length(24), scenarios: z.array(z.object({ id: z.string(), personId: z.string(), caseIds: z.array(z.string()).length(3) })).length(4),
}).superRefine((value, context) => {
  for (const [category, count] of Object.entries({ caption: 8, image: 8, both: 4, negative: 4 }))
    if (value.cases.filter(item => item.category === category).length !== count) context.addIssue({ code: 'custom', message: `Wrong ${category} count` });
  if (new Set(value.cases.map(item => item.id)).size !== 24) context.addIssue({ code: 'custom', message: 'Duplicate case ID' });
  for (const scenario of value.scenarios) for (const id of scenario.caseIds)
    if (value.cases.find(item => item.id === id)?.personId !== scenario.personId) context.addIssue({ code: 'custom', message: 'Scenario crosses person scope' });
});
export type ImageExperiment = z.infer<typeof ExperimentSchema>;
export function experimentRevision(input:Omit<ImageExperiment,'revision'|'frozenAt'>):string {
  return digest({version:input.version,sourceFileHash:input.sourceFileHash,imageFileHash:input.imageFileHash,annotationPlanHash:input.annotationPlanHash,cases:input.cases,scenarios:input.scenarios});
}
interface ImageRecord { visual: { description_ko: string; observed_emphasis: { main_subjects: string[] } }; source: { sha256: string; associations: { source_id: string }[] } }
function postedRange(source: SourcePost): { start: string; end: string } {
  const start = source.postedAt.slice(0, 10);
  return { start, end: new Date(new Date(`${start}T00:00:00Z`).valueOf() + 86400000).toISOString().slice(0, 10) };
}
/** Freeze source-derived silver probes before any response; these are NOT human-gold questions. */
export function prepareExperiment(personas: Persona[], sources: SourcePost[], split: Record<string, string>, seed: EvaluationInput,
  records: unknown[], plan: AnnotationPlan, sourceFileHash: string, imageFileHash: string): ImageExperiment {
  const sourceMap = new Map(sources.map(source => [source.id, source]));
  const selected = new Set<string>(); const cases: z.infer<typeof caseSchema>[] = [];
  const add = (persona: Persona, category: z.infer<typeof caseSchema>['category'], source: SourcePost | undefined,
    text: string, query: string, scoped: boolean, index: number, imageHash?: string): void => {
    const goldAnnotationIds = source && imageHash ? plan.annotations.filter(row => row.sourceId === source.id && row.imageHash === imageHash).map(row => row.id) : [];
    cases.push({ id: `image-rag-${category}-${persona.personId}-${index}`, personId: persona.personId, personaId: persona.id, personaRevision: persona.revision,
      text, timeline: { query, dateBasis: 'posted', limit: 5, ...(source && scoped ? postedRange(source) : {}) }, category,
      goldSourceIds: source ? [source.id] : [], goldAnnotationIds, split: 'test' });
    if (source) selected.add(source.id);
  };
  for (const persona of personas) {
    const captionSeeds = seed.cases.filter(item => item.personId === persona.personId && item.category === 'caption_supported' && item.split === 'test').slice(0, 2);
    if (captionSeeds.length !== 2) throw new Error('Need two held-out caption probes per person');
    for (const [index, item] of captionSeeds.entries()) {
      const source = sourceMap.get(item.goldSourceIds[0]!);
      if (!source || source.unsafe || !item.timeline?.query) throw new Error('Invalid caption gold');
      add(persona, 'caption', source, item.text, item.timeline.query, Boolean(item.timeline.start), index);
    }
    const imageCandidates: { source: SourcePost; record: ImageRecord }[] = [];
    for (const input of records) {
      const record = input as ImageRecord;
      for (const id of new Set(record.source.associations.map(item => item.source_id))) {
        const source = sourceMap.get(id);
        if (source && source.personId === persona.personId && !source.unsafe && split[id] === 'test' && !selected.has(id)
          && plan.annotations.some(row => row.sourceId === id && row.imageHash === record.source.sha256)
          && !imageCandidates.some(candidate => candidate.source.id === id)) imageCandidates.push({ source, record });
      }
    }
    if (imageCandidates.length < 3) throw new Error('Need three distinct held-out image parents per person');
    for (const [index, { source, record }] of imageCandidates.slice(0, 2).entries()) {
      const subject = record.visual.observed_emphasis.main_subjects[0] || record.visual.description_ko.slice(0, 80);
      const scoped = index === 0; const date = source.postedAt.slice(0, 10);
      const text = persona.language === 'ko'
        ? (scoped ? `${date}에 게시한 사진의 중심 대상과 분위기, 강조하는 내용을 설명해 줘.` : `“${subject}”이 나오는 게시물 사진을 찾아, 화면에서 강조하는 내용을 설명해 줘.`)
        : (scoped ? `Describe the main subject, mood and visual emphasis of the photo posted on ${date}.` : `Find a post showing “${subject}” and describe its visible emphasis.`);
      add(persona, 'image', source, text, subject.slice(0, 500), scoped, index, record.source.sha256);
    }
    const { source, record } = imageCandidates[2]!;
    const subject = record.visual.observed_emphasis.main_subjects[0] || record.visual.description_ko.slice(0, 80);
    const date = source.postedAt.slice(0, 10);
    add(persona, 'both', source, persona.language === 'ko' ? `${date}에 올린 게시물의 본문과 사진을 함께 설명하고, 사진에서 전달하는 내용도 해석해 줘.`
      : `Explain both the caption and photo posted on ${date}, including an interpretation of what the photo communicates.`, subject.slice(0, 500), true, 0, record.source.sha256);
    add(persona, 'negative', undefined, persona.language === 'ko' ? '2099년 1월 1일에 게시한 사진과 본문을 설명해 줘.' : 'Describe the photo and caption posted on January 1, 2099.', 'photo caption', false, 0);
    const negative = cases[cases.length - 1]!; negative.timeline.start = '2099-01-01'; negative.timeline.end = '2099-01-02';
  }
  const scenarios = personas.map(persona => ({ id: `image-rag-conversation-${persona.personId}`, personId: persona.personId,
    caseIds: ['caption', 'image', 'both'].map(category => cases.find(item => item.personId === persona.personId && item.category === category)!.id) }));
  const unsigned = { version: 'image-rag-ablation-v1' as const, sourceFileHash, imageFileHash, annotationPlanHash: digest(plan.annotations), cases, scenarios };
  return ExperimentSchema.parse({ ...unsigned, frozenAt: new Date().toISOString(), revision: experimentRevision(unsigned) });
}
export function validateExperimentGold(input: ImageExperiment, sources: SourcePost[], plan: AnnotationPlan): void {
  if(input.revision!==experimentRevision(input))throw new Error('Frozen question/scenario revision changed');
  for (const item of input.cases) {
    for (const id of item.goldSourceIds) {
      const parent = sources.find(source => source.id === id);
      if (!parent || parent.unsafe || parent.personId !== item.personId) throw new Error('Unsafe or wrong-person gold');
    }
    for (const id of item.goldAnnotationIds) if (!plan.annotations.some(row => row.id === id && row.personId === item.personId && item.goldSourceIds.includes(row.sourceId)))
      throw new Error('Wrong-parent image gold');
    if ((item.category === 'image' || item.category === 'both') && !item.goldAnnotationIds.length) throw new Error('Image probe has no annotation gold');
    if (item.category === 'negative' && (item.goldSourceIds.length || item.goldAnnotationIds.length)) throw new Error('Negative probe has gold');
  }
}
export interface CorpusRow {id:string;person_id:string;source_hash:string;content_hash:string;unsafe:boolean;caption_vector_hash:string|null;annotation_revision:string|null;annotation_content_hash:string|null;image_vector_hash:string|null}
export function annotationContentHashes(plan:AnnotationPlan):Map<string,string> {
  const groups=new Map<string,ReturnType<typeof ImageAnnotationInputSchema.parse>[]>();
  for(const raw of plan.annotations){const item=ImageAnnotationInputSchema.parse(raw);const group=groups.get(item.sourceId)??[];group.push(item);groups.set(item.sourceId,group);}
  return new Map([...groups].map(([id,group])=>[id,createHash('sha256').update(JSON.stringify(group.sort((a,b)=>a.imagePosition-b.imagePosition))).digest('hex')]));
}
export function validateCorpus(rows:CorpusRow[],sources:SourcePost[],plan:AnnotationPlan):void {
  const hashes=annotationContentHashes(plan);const byId=new Map(rows.map(row=>[row.id,row]));const expected=new Map(plan.inputs.map(input=>[input.sourceId,input.revision]));
  if(rows.length!==sources.length || byId.size!==rows.length)throw new Error('DB source corpus does not match frozen assets');
  for(const source of sources){
    const row=byId.get(source.id);
    if(!row || row.person_id!==source.personId || row.source_hash!==source.hash || row.unsafe!==source.unsafe)throw new Error('DB parent scope/hash mismatch');
    if(!source.unsafe && !row.caption_vector_hash)throw new Error('Caption embedding corpus incomplete');
    const revision=expected.get(source.id);
    if(revision && (row.annotation_revision!==revision || row.annotation_content_hash!==hashes.get(source.id) || !row.image_vector_hash))throw new Error('Latest image revision/vector is not the frozen v5 corpus');
    if(!revision && row.annotation_revision)throw new Error('Unexpected extra image revision in frozen corpus');
  }
}
async function corpusSnapshot(pool:Pool,sources:SourcePost[],plan:AnnotationPlan):Promise<CorpusRow[]> {
  const result=await pool.query(`SELECT p.id,p.person_id,p.source_hash,p.content_hash,p.unsafe,
    md5(c.embedding::text) AS caption_vector_hash,r.revision AS annotation_revision,r.content_hash AS annotation_content_hash,
    md5(v.embedding::text) AS image_vector_hash FROM source_posts p
    LEFT JOIN source_vectors c ON c.source_id=p.id AND c.model_revision=$1
    LEFT JOIN LATERAL(SELECT revision,content_hash FROM source_image_revisions WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1)r ON true
    LEFT JOIN source_image_vectors v ON v.source_id=p.id AND v.annotation_revision=r.revision AND v.model_revision=$1
    WHERE p.person_id=ANY($2::text[]) ORDER BY p.id`,[EMBEDDING_MODEL,[...new Set(sources.map(source=>source.personId))]]);
  validateCorpus(result.rows as CorpusRow[],sources,plan);return result.rows as CorpusRow[];
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
  return digest(await Promise.all(files.sort().map(async path => [path, digest(await readFile(path, 'utf8'))])));
}
export interface ExperimentRow { caseId: string; condition: RagCondition; history: 'single' | 'evolving'; category: string; personId: string; trace: TurnTrace; reply?: ChatReply; annotationGoldHit: boolean; annotationGoldExposed?:boolean }
export function summarizeRows(rows: ExperimentRow[]): Record<string, unknown> {
  return Object.fromEntries(CONDITIONS.map(condition => {
    const subset = rows.filter(row => row.condition === condition); const supported = subset.filter(row => row.category !== 'negative');
    return [condition, { turns: subset.length, errors: subset.filter(row => row.trace.errors.length || row.trace.state !== 'completed').length,
      answered: subset.filter(row => row.reply?.status === 'answered').length,
      invalidModelEvidence: subset.filter(row => row.reply?.limitations.includes('INVALID_MODEL_EVIDENCE')).length,
      groundedQuoteAnswers: supported.filter(row => row.reply?.grounding === 'source_bound_quotes').length,
      unverifiedAnswers: subset.filter(row => row.reply?.grounding === 'unverified_model').length,
      recallAt5: supported.filter(row => row.trace.sourceRecallAt5 !== null).length ? supported.reduce((sum, row) => sum + (row.trace.sourceRecallAt5 ?? 0), 0) / supported.filter(row => row.trace.sourceRecallAt5 !== null).length : null,
      annotationGoldCitationHit: subset.filter(row => row.annotationGoldHit).length,
      annotationGoldExposureHit:subset.filter(row=>row.annotationGoldExposed).length,
      annotationsOmitted:subset.reduce((sum,row)=>sum+(row.reply?.promptEvidence?.omittedAnnotations??0),0),
      maxPromptBytes:Math.max(0,...subset.map(row=>row.reply?.promptEvidence?.promptBytes??0)),
      imageCitationCount: subset.reduce((sum, row) => sum + (row.reply?.evidence.filter(card => card.origin === 'ai_image_annotation').length ?? 0), 0),
      retrievalCalls: subset.reduce((sum, row) => sum + row.trace.retrievalCalls, 0), embeddingCalls: subset.reduce((sum, row) => sum + row.trace.embeddingCalls, 0),
      textCalls: subset.reduce((sum, row) => sum + row.trace.textCalls, 0),
      actualMicrousd: subset.flatMap(row => row.trace.requests).filter(request => request.created).reduce((sum, request) => sum + (request.actualMicrousd ?? 0), 0),
      meanLatencyMs: subset.length ? subset.reduce((sum, row) => sum + row.trace.latencyMs, 0) / subset.length : null,
      byCategory: Object.fromEntries(['caption','image','both','negative'].map(category=>{
        const group=subset.filter(row=>row.category===category);
        return [category,{turns:group.length,statusCounts:Object.fromEntries(['answered','insufficient_evidence','needs_clarification','out_of_scope'].map(status=>[status,group.filter(row=>row.reply?.status===status).length])),
          unverifiedAnswers:group.filter(row=>row.reply?.grounding==='unverified_model').length,
          invalidModelEvidence:group.filter(row=>row.reply?.limitations.includes('INVALID_MODEL_EVIDENCE')).length,
          annotationGoldHit:group.filter(row=>row.annotationGoldHit).length}];
      })),
    }];
  }));
}
export async function runExperiment(args: string[]): Promise<void> {
  if (args.some(arg => !['--prepare', '--live', '--pilot', '--replay'].includes(arg))) throw new Error('Unknown experiment option');
  const sourcesText = await readFile('data/research/sources.json', 'utf8');
  const imagesText = await readFile('data/research/image_descriptions_v5_declarative/images.jsonl', 'utf8');
  const sources = JSON.parse(sourcesText) as SourcePost[]; const records = imagesText.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as unknown);
  const personas = JSON.parse(await readFile('data/research/personas.json', 'utf8')) as Persona[];
  const plan = prepareImageAnnotations(records, sources); const path = 'data/research/image-rag-experiment.json';
  if (args.includes('--prepare')) {
    let existing = false; try { await readFile(path); existing = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (existing) throw new Error('Frozen experiment exists; never silently replace it');
    const split = JSON.parse(await readFile('data/research/split.json', 'utf8')) as Record<string, string>;
    const seed = JSON.parse(await readFile('data/research/evaluation.json', 'utf8')) as EvaluationInput;
    const experiment = prepareExperiment(personas, sources, split, seed, records, plan, digest(sourcesText), digest(imagesText));
    validateExperimentGold(experiment, sources, plan); await privateJson(path, experiment); console.log(JSON.stringify({ preparedCases: 24, scenarios: 4, revision: experiment.revision })); return;
  }
  if (!args.includes('--live') || process.env.GOAL1_LIVE_ENABLED !== 'true') throw new Error('Live mode must be explicit');
  const experiment = ExperimentSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  if (experiment.sourceFileHash !== digest(sourcesText) || experiment.imageFileHash !== digest(imagesText) || experiment.annotationPlanHash !== digest(plan.annotations)) throw new Error('Frozen assets changed');
  validateExperimentGold(experiment, sources, plan);
  const runtime = createHarnessRuntime({ ...process.env, GOAL1_TEXT_MODEL: process.env.GOAL1_TEXT_MODEL ?? process.env.PTR_MODEL ?? DEFAULT_TEXT_MODEL }, true);
  const before = await codeFingerprint(); const startedAt = new Date().toISOString(); const label = args.includes('--pilot') ? 'pilot' : args.includes('--replay') ? 'replay' : 'full';
  const directory = `reports/image-rag/${label}-${startedAt.replace(/[:.]/g, '-')}`; await mkdir(directory, { recursive: true, mode: 0o700 });
  const rows: ExperimentRow[] = []; const owner = `image-rag-${randomUUID()}`;
  try {
    const corpusBefore=await corpusSnapshot(runtime.pool,sources,plan);await privateJson(`${directory}/corpus-before.json`,corpusBefore);
    const create = async (item: ImageExperiment['cases'][number], condition: RagCondition) => runtime.chat.createSession(owner, {
      personId: item.personId, personaId: item.personaId, personaRevision: item.personaRevision, timezone: 'UTC', ragCondition: condition,
      retrievalMode: condition === 'off' ? 'off' : 'semantic' });
    const execute = async (item: ImageExperiment['cases'][number], condition: RagCondition, history: 'single' | 'evolving', sessionId: string): Promise<void> => {
      const trace: TurnTrace = { id: `${item.id}-${condition}-${history}`, stage: 'image-rag-ablation', mode: condition === 'off' ? 'off' : 'semantic', historyKind: history,
        personId: item.personId, category: item.category, split: item.split, goldSourceIds: item.goldSourceIds, retrievedIds: [], promptHashes: [], latencyMs: 0,
        state: 'pending', status: null, errors: [], textCalls: 0, embeddingCalls: 0, retrievalCalls: 0, requests: [], sourceRecallAt5: null, validQuotes: 0, totalQuotes: 0,
        crossPersonEvidence: 0, statusSurrogateMatch: null, sessionId };
      runtime.setTrace(trace); const began = Date.now(); let reply: ChatReply | undefined;
      try {
        const initial = await runtime.chat.startTurn(owner, { sessionId, clientRequestId: randomUUID(), text: item.text, intent: 'timeline', timeline: item.timeline });
        trace.turnId = initial.id;
        for (let attempt = 0; attempt < 1800; attempt++) {
          const turn = await runtime.chat.getTurn(owner, initial.id);
          if (['completed', 'failed', 'cancelled'].includes(turn.state)) { trace.state = turn.state; reply = turn.reply; if (turn.errorCode) trace.errors.push(turn.errorCode); break; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (trace.state === 'pending') { await runtime.chat.cancelTurn(owner, initial.id); trace.state = 'timeout'; trace.errors.push('HARNESS_TIMEOUT'); }
        trace.status = reply?.status ?? null; trace.reply = reply; trace.sourceRecallAt5 = condition === 'off' ? null : sourceRecall(item.goldSourceIds, trace.retrievedIds);
        trace.totalQuotes = reply?.evidence.length ?? 0; trace.validQuotes = trace.totalQuotes;
        trace.crossPersonEvidence = reply?.evidence.filter(card => card.personId !== item.personId).length ?? 0;
        if (condition === 'off' && (trace.retrievalCalls || trace.embeddingCalls || reply?.evidence.length)) trace.errors.push('OFF_ISOLATION_FAILED');
        if (condition === 'caption' && reply?.evidence.some(card => card.origin === 'ai_image_annotation')) trace.errors.push('CAPTION_IMAGE_LEAK');
      } catch (error) { trace.errors.push(error && typeof error === 'object' && 'code' in error ? String(error.code) : 'HARNESS_ERROR'); trace.state = 'failed'; }
      finally { trace.latencyMs = Date.now() - began; runtime.setTrace(undefined); }
      rows.push({ caseId: item.id, condition, history, category: item.category, personId: item.personId, trace, reply,
        annotationGoldHit: Boolean(reply?.evidence.some(card => card.annotationId && item.goldAnnotationIds.includes(card.annotationId))),
        annotationGoldExposed:Boolean(reply?.promptEvidence?.annotationIds.some(id=>item.goldAnnotationIds.includes(id))) });
      await privateJson(`${directory}/progress.json`, { startedAt, completed: rows.length, summary: summarizeRows(rows) });
      if (trace.errors.length || trace.state !== 'completed') throw new Error('A real trial failed; preserve trace, do not auto-resubmit');
    };
    const singles = args.includes('--pilot') ? [experiment.cases.find(item => item.category === 'image')!] : experiment.cases;
    for (const [index, item] of singles.entries()) for (const condition of CONDITIONS.map((_, offset) => CONDITIONS[(index + offset) % 3]!)) await execute(item, condition, 'single', (await create(item, condition)).id);
    if (!args.includes('--pilot')) for (const [index, scenario] of experiment.scenarios.entries()) for (const condition of CONDITIONS.map((_, offset) => CONDITIONS[(index + offset) % 3]!)) {
      const inputs = scenario.caseIds.map(id => experiment.cases.find(item => item.id === id)!); const session = await create(inputs[0]!, condition);
      for (const input of inputs) await execute(input, condition, 'evolving', session.id);
    }
    const after = await codeFingerprint(); if (before !== after) throw new Error('Code changed during the controlled run');
    const corpusAfter=await corpusSnapshot(runtime.pool,sources,plan);if(digest(corpusBefore)!==digest(corpusAfter))throw new Error('DB retrieval corpus changed during the controlled run');
    const report = { execution: 'live', label, startedAt, finishedAt: new Date().toISOString(), revision: experiment.revision, promptRevision: EXPERIMENT_PROMPT_REVISION,
      model: runtime.model, embeddingModel: EMBEDDING_MODEL, retrievalAlgorithm: 'semantic', topK: 5, codeFingerprint: before, codeUnchanged: before === after,
      corpusFingerprint:digest(corpusBefore),corpusUnchanged:true,
      planned: args.includes('--pilot') ? 3 : 108, completed: rows.length, single: summarizeRows(rows.filter(row => row.history === 'single')),
      evolving: summarizeRows(rows.filter(row => row.history === 'evolving')), rows, humanReview: 'pending',
      limitations: ['Source/AI-description-derived silver questions; no human-gold accuracy or semantic-entailment claim.',
        'Image annotation generation used original caption context; conditions are not independently image-only inputs.',
        'Image queries use source-derived subjects, partly posted-day scoped; optimistic controlled support probes.',
        'Identical initial prompt/model/case/persona; condition order rotates; evolving histories diverge as answers differ.',
        'Caption vectors remain separate; augmented input length differs and no independent reranker ablation is performed.',
        'Latency includes persistent cache replay. Quote binding does not validate natural answer factuality.'] };
    await privateJson(`${directory}/report.json`, report);
    const pointer = 'reports/image-rag/latest.json'; const temporary = `${pointer}.tmp`; await writeFile(temporary, JSON.stringify({ directory, finishedAt: report.finishedAt, completed: rows.length }) + '\n', { mode: 0o600 }); await rename(temporary, pointer);
    console.log(JSON.stringify({ directory, completed: rows.length, model: runtime.model, single: report.single, evolving: report.evolving }));
  } catch (error) { await privateJson(`${directory}/failure.json`, { startedAt, observedAt: new Date().toISOString(), rows, completed: rows.length, codeFingerprint: before, noImplicitRetry: true }); throw error; }
  finally { await runtime.close(); }
}
if (require.main === module) void runExperiment(process.argv.slice(2)).catch(() => { console.error('Image RAG experiment failed; preserved details remain private.'); process.exitCode = 1; });
