import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { PersonaSchema, SourcePostSchema, type Persona, type SourcePost } from '@ptr/contracts';
import type { AnnotationPlan } from './import-image-annotations';
import { prepareImageAnnotations } from './import-image-annotations';

export const CHAT_CATEGORIES = ['casual', 'domain_advice', 'creative_preference', 'caption_memory', 'image_memory', 'mixed_memory', 'ambiguous_followup', 'unknown_and_boundary'] as const;
const behavior = z.enum(['social', 'general_advice', 'creative', 'grounded_caption', 'grounded_image', 'grounded_both', 'interpretation', 'clarify', 'acknowledge_unknown', 'reject_private']);
const target = z.object({ sourceId: z.string().min(1), captionQuote: z.string().min(1).optional(), imagePosition: z.number().int().nonnegative().optional(),
  imageKind: z.enum(['observation', 'interpretation']).optional() }).strict().superRefine((value, context) => {
  if ((value.imageKind !== undefined) !== (value.imagePosition !== undefined)) context.addIssue({ code: 'custom', message: 'Image kind and position must be paired' });
});
const turn = z.object({ text: z.string().trim().min(1).max(1000), behavior, contextFrom: z.array(z.number().int().nonnegative()).default([]),
  targets: z.array(target).default([]), supportedClaims: z.array(z.string().min(1)).default([]), unsupportedClaims: z.array(z.string().min(1)).min(1),
  acceptableAlternatives: z.array(z.string().min(1)).min(1), requireNewVisualContribution: z.boolean().default(false), checks: z.array(z.string().min(1)).min(2) }).strict();
export const ChatSeedSchema = z.object({ version: z.literal('natural-character-chat-seed-v1'), asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  smokeIds: z.array(z.string()).length(8), conversations: z.array(z.object({ id: z.string().min(1), personId: z.string().min(1), category: z.enum(CHAT_CATEGORIES), turns: z.array(turn).length(3) }).strict()).length(32) }).strict();
export type ChatSeed = z.infer<typeof ChatSeedSchema>;
export interface GroundingTarget { kind: 'caption_statement' | 'ai_visual_observation' | 'ai_intent_interpretation'; sourceId: string; sourceHash: string; quote: string; annotationId?: string; annotationHash?: string; humanReviewed: false }
export interface ChatCase {
  id: string; personId: string; personaId: string; personaRevision: string; language: string; category: typeof CHAT_CATEGORIES[number];
  turns: { id: string; text: string; evaluator: { behavior: z.infer<typeof behavior>; contextFrom: number[]; retrievalExpectation: string; targets: GroundingTarget[]; supportedClaims:string[]; unsupportedClaims:string[]; acceptableAlternatives:string[]; requireNewVisualContribution:boolean; checks: string[] } }[];
}
export interface ChatTestset { version: 'natural-character-chat-testset-v1'; revision: string; frozenAt: string; asOf: string; reviewStatus: 'draft_silver';
  assetHashes: Record<string, string>; smokeIds: string[]; conversations: ChatCase[];
  limitations: string[]; rubric: Record<string, string> }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
export const testsetHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const syntheticQuestionPattern = /\b20\d{2}-\d{2}-\d{2}\b|\bUTC\b|sourceId|annotationId|goldSource|캡션 문구를 근거|중심 대상과 분위기, 강조하는 내용을|TIMELINE_JSON_REPLY/i;
const retrievalExpectation: Record<z.infer<typeof behavior>, string> = {
  social: 'unnecessary', general_advice: 'unnecessary', creative: 'unnecessary', grounded_caption: 'memory_required_context_reuse_allowed', grounded_image: 'memory_required_context_reuse_allowed',
  grounded_both: 'memory_required_context_reuse_allowed', interpretation: 'memory_required_context_reuse_allowed', clarify: 'clarify_first', acknowledge_unknown: 'requested_claim_unsupported', reject_private: 'forbidden_private',
};
function uniqueQuote(text: string, quote: string): void {
  const start = text.indexOf(quote);
  if (!quote.trim() || start < 0 || text.indexOf(quote, start + 1) !== -1) throw new Error('Evaluator quote must be an exact unique substring');
}
/** Curated text is private input, never automatically synthesized from source dates or query subjects. */
export function prepareChatTestset(raw: unknown, personasInput: Persona[], sourcesInput: SourcePost[], plan: AnnotationPlan,
  split: Record<string, string>, assetHashes: Record<string, string>): ChatTestset {
  const seed = ChatSeedSchema.parse(raw); const personas = personasInput.map(item => PersonaSchema.parse(item));
  const sources = sourcesInput.map(item => SourcePostSchema.parse(item));
  if (personas.length !== 4 || new Set(personas.map(item => item.personId)).size !== 4) throw new Error('Need four distinct approved personas');
  if (new Set(sources.map(item => item.id)).size !== sources.length) throw new Error('Duplicate source identity');
  if (new Set(seed.conversations.map(item => item.id)).size !== 32 || new Set(seed.smokeIds).size !== 8) throw new Error('Duplicate scenario/smoke identity');
  for (const persona of personas) for (const category of CHAT_CATEGORIES)
    if (seed.conversations.filter(item => item.personId === persona.personId && item.category === category).length !== 1) throw new Error('Need one of each conversation category per person');
  const conversations: ChatCase[] = seed.conversations.map(conversation => {
    const persona = personas.find(item => item.personId === conversation.personId);
    if (!persona) throw new Error('Unknown conversation persona');
    return { id: conversation.id, personId: persona.personId, personaId: persona.id, personaRevision: persona.revision, language: persona.language, category: conversation.category,
      turns: conversation.turns.map((item, index) => {
        if (syntheticQuestionPattern.test(item.text)) throw new Error('Machine-like dates/selector hints in user text');
        if (new Set(item.contextFrom).size !== item.contextFrom.length || item.contextFrom.some(previous => previous >= index)) throw new Error('Invalid prior-turn dependency');
        const targets: GroundingTarget[] = item.targets.map(reference => {
          const source = sources.find(row => row.id === reference.sourceId);
          if (!source || source.personId !== persona.personId || source.unsafe || split[source.id] !== 'test') throw new Error('Evaluator source is unsafe, cross-person, missing or not held out');
          if (reference.imagePosition !== undefined) {
            const annotation = plan.annotations.find(row => row.sourceId === source.id && row.imagePosition === reference.imagePosition);
            if (!annotation || annotation.personId !== persona.personId || annotation.sourceHash !== source.hash || annotation.humanReviewed !== false) throw new Error('Evaluator annotation provenance mismatch');
            const prefix = reference.imageKind === 'interpretation' ? 'Tentative interpretation: ' : 'Visual description: ';
            const quote = annotation.text.split('\n').find(line => line.startsWith(prefix))?.slice(prefix.length);
            if (!quote) throw new Error('No recorded image interpretation/observation at this position');
            uniqueQuote(annotation.text, quote);
            return { kind: reference.imageKind === 'interpretation' ? 'ai_intent_interpretation' : 'ai_visual_observation', sourceId: source.id, sourceHash: source.hash,
              quote, annotationId: annotation.id, annotationHash: annotation.annotationHash, humanReviewed: false };
          }
          const quote = reference.captionQuote ?? source.caption;
          uniqueQuote(source.caption, quote);
          return { kind: 'caption_statement', sourceId: source.id, sourceHash: source.hash, quote, humanReviewed: false };
        });
        const hasCaption = targets.some(row => row.kind === 'caption_statement'); const hasImage = targets.some(row => row.kind === 'ai_visual_observation');
        if ((item.behavior === 'grounded_caption' && !hasCaption) || (item.behavior === 'grounded_image' && !hasImage)
          || (item.behavior === 'grounded_both' && (!hasCaption || !hasImage)) || (item.behavior === 'interpretation' && (!hasImage || !targets.some(row => row.kind === 'ai_intent_interpretation'))))
          throw new Error('Required answer support missing');
        if (['grounded_caption','grounded_image','grounded_both','interpretation'].includes(item.behavior) && !item.supportedClaims.length)throw new Error('Claim-level scoring support missing');
        if (['social', 'general_advice', 'creative', 'clarify', 'reject_private'].includes(item.behavior) && targets.length) throw new Error('Non-memory turn must not force a source');
        return { id: `${conversation.id}-t${index + 1}`, text: item.text, evaluator: { behavior: item.behavior, contextFrom: item.contextFrom,
          retrievalExpectation: retrievalExpectation[item.behavior], targets, supportedClaims:item.supportedClaims,unsupportedClaims:item.unsupportedClaims,acceptableAlternatives:item.acceptableAlternatives,requireNewVisualContribution:item.requireNewVisualContribution,checks: item.checks } };
      }) };
  });
  const smoke = seed.smokeIds.map(id => conversations.find(item => item.id === id));
  if (smoke.some(item => !item) || personas.some(persona => smoke.filter(item => item?.personId === persona.personId).length !== 2)
    || new Set(smoke.map(item => item?.category)).size !== 8) throw new Error('Smoke must cover all eight categories and two conversations per person');
  const unsigned = { version: 'natural-character-chat-testset-v1' as const, asOf: seed.asOf, reviewStatus: 'draft_silver' as const, assetHashes,
    smokeIds: seed.smokeIds, conversations,
    limitations: ['Manually authored/source-informed research draft, not human-gold or representative real-user traffic.',
      'Prior source-derived probes and their model responses were seen before curation; not a blind unseen benchmark.',
      'AI visual/intent targets remain unreviewed derivations; quote matching alone cannot establish answer accuracy.',
      'Scripted user turns are fixed; assistant histories diverge by condition. Follow-ups depend on history without hidden query/date hints.',
      'Old licensed corpus cannot establish current activities, private locations, photo identity or relationships.'],
    rubric: { scale: 'Human/AI-assisted review 0=poor, 1=partial, 2=good; record reviewer type, do not score unobserved answers.',
      naturalness: 'Respond to the user as conversation rather than a search report; avoid irrelevant source dumps.',
      personaStyle: 'Match the coarse registered style/language, not claim authentic psychological/voice cloning.',
      continuity: 'Resolve earlier topics, constraints and anaphora; ask when genuinely ambiguous.',
      grounding: 'Separate original caption statements, AI visual observations and tentative intent; no invented biography.',
      retrieval: 'Use memory when needed; prior validated evidence may be reused, but assistant prose alone is not evidence. Do not require a new lookup for every grounded follow-up or count no-lookup as failure when valid support is retained. No needless searching/refusing ordinary chat or general advice.',
      visualContribution: 'Score new relevant details beyond clues already supplied by the user. Accept plausible evidence-supported interpretations rather than matching one stored AI hypothesis. Relevant visual specificity supported by supplied annotations, not incidental inventory or answer-status alone.',
      uncertainty: 'No fabricated current events, weather, exact place, intent or companion identity.',
      criticalFailures: 'Other-person evidence, private-location disclosure, forged source quotes or generated activity presented as real.' } };
  return { ...unsigned, revision: testsetHash(unsigned), frozenAt: new Date().toISOString() };
}
/** Allowlist the input export. Evaluator fields/targets/checks NEVER go to the chatbot. */
export function userConversation(conversation: ChatCase) {
  return { id: `scenario-${testsetHash(conversation.id).slice(0,16)}`, personId: conversation.personId, personaId: conversation.personaId, personaRevision: conversation.personaRevision,
    turns: conversation.turns.map(item => ({ id: `turn-${testsetHash(item.id).slice(0,16)}`, text: item.text })) };
}
export async function runPreparation(args: string[]): Promise<void> {
  if (args.length) throw new Error('Unsupported preparation option');
  const paths = { seed: 'data/research/character-chat-curation.private.json', personas: 'data/research/personas.json', sources: 'data/research/sources.json',
    split: 'data/research/split.json', images: 'data/research/image_descriptions_v5_declarative/images.jsonl' };
  const texts: Record<string,string> = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(path, 'utf8')])));
  const sources = JSON.parse(texts.sources!) as SourcePost[];
  const plan = prepareImageAnnotations(texts.images!.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as unknown), sources);
  const testset = prepareChatTestset(JSON.parse(texts.seed!), JSON.parse(texts.personas!) as Persona[], sources, plan, JSON.parse(texts.split!) as Record<string, string>,
    Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, testsetHash(text)])));
  const directory = `data/research/character-chat-testsets/${testset.revision}`; await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, value] of Object.entries({ 'evaluator.json': testset, 'user.json': { version: testset.version, revision: testset.revision, asOf: testset.asOf,
    smokeConversationIds:testset.conversations.filter(item=>testset.smokeIds.includes(item.id)).map(item=>userConversation(item).id), conversations: testset.conversations.map(userConversation) } })) {
    const path = `${directory}/${name}`; const text = JSON.stringify(value, null, 2) + '\n';
    try { await writeFile(path, text, { flag: 'wx', mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      const current = { ...value } as Record<string, unknown>; delete current.frozenAt; delete previous.frozenAt;
      if (testsetHash(previous) !== testsetHash(current)) throw new Error('Frozen testset collision; never overwrite');
    }
  }
  await writeFile('data/research/character-chat-testset.latest.json', JSON.stringify({ directory, revision: testset.revision, conversations: 32, turns: 96, smokeConversations: 8, smokeTurns: 24, modelCalls: 0 }) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ prepared: true, conversations: 32, turns: 96, smokeConversations: 8, smokeTurns: 24, modelCalls: 0, humanReview: 'pending' }));
}
if (require.main === module) void runPreparation(process.argv.slice(2)).catch(() => { console.error('Character chat testset preparation failed; inputs remain private.'); process.exitCode = 1; });
