import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PersonaSchema, SourcePostSchema, type Persona, type SourcePost } from '@ptr/contracts';
import { unsafeCaption } from './prepare-research';

export const REFINEMENT_REVISION = 'dev-style-dialogue-design-v1';
export type DialogueDesign = 'beauty-practical' | 'lifestyle-everyday' | 'travel-narrative' | 'travel-visual';
interface Target { username: string; category: string }
type Split = Record<string, 'dev' | 'test'>;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const CUES = {
  beauty: /make.?up|메이크업|뷰티|beauty|lipstick|립스틱|화장/iu,
  lifestyle: /일상|카페|데일리|daily|cafe|coffee|food|맛집|패션|fashion/iu,
  narrative: /\bvlog\b|\badventure\b|road.?trip|\bjourney\b|브이로그|모험/iu,
  visual: /\bview\b|\bsunset\b|\bcolou?r\b|\bsky\b|\blight\b|풍경|노을|색감/iu,
};
export interface DevelopmentStyle {
  count: number; medianCharacters: number; hashtagRate: number; emojiRate: number;
  shortRate: number; questionRate: number; koreanReactionRate: number;
  cues: Record<keyof typeof CUES, number>;
}
interface FieldProvenance {
  pointer: string; valueHash: string;
  basis: 'observed_development_style' | 'authored_dialogue_design' | 'unknown';
  sourceIds: string[]; rationale: string;
}
export interface RefinementProfile {
  personaId: string; personId: string; originalRevision: string; refinedRevision: string;
  design: DialogueDesign; developmentStyle: DevelopmentStyle; developmentInputHash: string;
  fieldProvenance: FieldProvenance[];
  unknown: { actualPersonality: 'unknown'; actualSpokenVoice: 'unknown' };
  reviewStatus: 'silver';
}
const DESIGNS: Record<DialogueDesign, { concept: string; style: string[] }> = {
  'beauty-practical': {
    concept: 'An unofficial beauty-creator dialogue design: playful hands-on experimentation, practical comparisons and one approachable suggestion. This is authored chat behavior, not a claim about the real creator’s personality.',
    style: [
      'For beauty ideas, contrast one practical choice with another and explain what effect each is meant to create; do not claim personal use or endorsement without evidence.',
      'Keep a brisk, lightly playful conversational rhythm. Offer one easy experiment rather than a polished lecture or product catalogue.',
      'When the user is uncertain, ask about the effect they want before prescribing a routine. Original reactions are welcome; do not copy catchphrases.',
    ],
  },
  'lifestyle-everyday': {
    concept: 'An unofficial everyday-lifestyle dialogue design: warm conversation about small everyday choices, simple styling, food and outings. The breadth is development-content-inspired; warmth is authored, not verified real personality.',
    style: [
      'Connect everyday creative ideas across outfits, food, outings and ordinary routines without turning those topics into claims about actual habits.',
      'Use a warm, relatable rhythm: acknowledge the user’s mood, suggest one low-effort option, then leave space for their response.',
      'Prefer an accessible detail or a friendly comparison over grand travel narration or a beauty tutorial. Avoid inventing private relationships or past shared experiences.',
    ],
  },
  'travel-narrative': {
    concept: 'An unofficial narrative-travel dialogue design: movement, discovery and the progression of a scene. Narrative emphasis comes from development-caption cues; curiosity and chat rhythm are authored design.',
    style: [
      'For fictional travel ideas, describe a small progression: what catches attention, what to try next, and why the scene would make an interesting story.',
      'Use an inviting, curious conversational rhythm and one concrete action-oriented suggestion rather than a list of photogenic objects.',
      'Ask what the user would like to explore. Actual journeys, companions and dates still need source evidence; do not insert invented adventures into factual recollections.',
    ],
  },
  'travel-visual': {
    concept: 'An unofficial visual-travel dialogue design: atmosphere, composition and the feeling of a place, with selective details rather than exhaustive scene narration. The visual emphasis is development-content-inspired; sensitivity and chat rhythm are authored.',
    style: [
      'For fictional travel or image ideas, choose one visual focal point and its atmosphere; mention light, colour or framing only when useful to the user’s idea.',
      'Use a calm but friendly conversational rhythm, concise evocative phrasing and one composition-oriented suggestion rather than an adventure itinerary.',
      'Ask what feeling the user wants the scene to convey. Do not treat designed atmosphere as evidence of the real author’s feelings or infer identities from appearance.',
    ],
  },
};
function developmentStyle(rows: SourcePost[]): DevelopmentStyle {
  const count = rows.length;
  const rate = (predicate: (caption: string) => boolean): number => Number((rows.filter(r => predicate(r.caption)).length / count).toFixed(6));
  const lengths = rows.map(r => [...r.caption].length).sort((a, b) => a - b);
  return {
    count, medianCharacters: lengths[Math.floor(count / 2)]!,
    hashtagRate: rate(c => c.includes('#')), emojiRate: rate(c => /\p{Extended_Pictographic}/u.test(c)),
    shortRate: rate(c => [...c].length < 160), questionRate: rate(c => /[?？]/u.test(c)),
    koreanReactionRate: rate(c => /[ㅋㅎ]{2,}|[ㅠㅜ]{2,}/u.test(c)),
    cues: Object.fromEntries(Object.entries(CUES).map(([key, cue]) => [key, rows.filter(r => cue.test(r.caption)).length])) as DevelopmentStyle['cues'],
  };
}
function dialogueDesign(category: string, observed: DevelopmentStyle): DialogueDesign {
  if (/beauty|뷰티|makeup/iu.test(category)) return 'beauty-practical';
  if (/travel|여행/iu.test(category)) return observed.cues.narrative > observed.cues.visual ? 'travel-narrative' : 'travel-visual';
  if (/food|lifestyle|fashion|일상|음식|패션/iu.test(category)) return 'lifestyle-everyday';
  throw new Error('Unsupported content category; an explicit authored design is required');
}
/** Offline silver refinement. No evaluation questions, annotations, models or DB connection. */
export function refinePersonas(inputs: { personas: Persona[]; sources: SourcePost[]; split: Split; targets: Target[] }) {
  const originals = inputs.personas.map(p => PersonaSchema.parse(p));
  const sources = inputs.sources.map(s => SourcePostSchema.parse(s));
  if (originals.length !== 4 || new Set(originals.map(p => p.personId)).size !== 4 || new Set(originals.map(p => p.id)).size !== 4)
    throw new Error('Exactly four independent persona bindings required');
  if (inputs.targets.length !== 4 || new Set(inputs.targets.map(t => t.username)).size !== 4 ||
    inputs.targets.some(t => !originals.some(p => p.personId === t.username))) throw new Error('Target/persona scope mismatch');
  if (new Set(sources.map(s => s.id)).size !== sources.length || sources.some(s => !originals.some(p => p.personId === s.personId)))
    throw new Error('Source collision or foreign person scope');
  const personas: Persona[] = [], profiles: RefinementProfile[] = [];
  for (const original of originals) {
    const target = inputs.targets.find(t => t.username === original.personId)!;
    const rows = sources.filter(s => s.personId === original.personId && inputs.split[s.id] === 'dev' &&
      !s.unsafe && !unsafeCaption(s.caption) && s.caption.trim()).sort((a, b) => a.id.localeCompare(b.id, 'en'));
    if (rows.length < 5) throw new Error('Insufficient safe development captions');
    const rowIds = rows.map(r => r.id);
    if (original.sourceRefs.some(id => !rowIds.includes(id))) throw new Error('Original persona provenance must be safe development-only');
    const observed = developmentStyle(rows), design = dialogueDesign(target.category, observed);
    if (!['ko', 'en'].includes(original.language)) throw new Error('Unsupported language; preserve an explicit reviewed language contract');
    const language = original.language === 'ko' ? 'Use natural Korean.' : 'Use natural English.';
    const style = [language, ...DESIGNS[design].style,
      observed.shortRate > 0.5 ? 'Prefer compact replies; expand only when the user asks.' : 'Allow a little description, but keep each conversational reply focused.',
      observed.emojiRate > 0.3 ? 'Use light expressive emoji, not a sequence of decorative symbols.' : 'Keep emoji restrained.',
      observed.hashtagRate > 0.5 ? 'Occasional topical hashtags are suitable for fictional post drafts, not ordinary chat replies.' : 'Use few hashtags even in fictional post drafts.',
      'Respond as the disclosed research character, not a third-person analyst. Accept corrections naturally and clarify or find another source when the user means a different event.',
      'Light humour, reactions, metaphors and imagined atmosphere may enrich dialogue. Never turn them into verified source facts, contradict established core events or actors, or invent important real-life events.',
    ];
    const definition = { ...original, concept: DESIGNS[design].concept, style, reviewStatus: 'silver' as const,
      sourceRefs: rowIds.slice(0, 12) };
    const { revision: _oldRevision, ...revisionInput } = definition;
    const revision = `dialogue-${hash({ algorithm: REFINEMENT_REVISION, definition: revisionInput,
      development: rows.map(r => ({ id: r.id, caption: r.caption, hash: r.hash, snapshot: r.snapshot })), category: target.category }).slice(0, 24)}`;
    const refined = PersonaSchema.parse({ ...definition, revision });
    const fieldProvenance: FieldProvenance[] = [];
    for (const [key, value] of Object.entries(refined)) {
      if (key === 'style') continue;
      const basis: FieldProvenance['basis'] = key === 'sourceRefs' ? 'observed_development_style' :
        ['label', 'identity'].includes(key) ? 'unknown' : 'authored_dialogue_design';
      fieldProvenance.push({ pointer: `/${key}`, valueHash: hash(value), basis,
        sourceIds: key === 'sourceRefs' || key === 'concept' ? rowIds : [],
        rationale: key === 'concept' ? 'Authored conversational lens informed by manifest category and development-only aggregate cues; not real personality.' :
          ['label', 'identity'].includes(key) ? 'Preserved original research definition; not independently verified by caption-style analysis.' :
            key === 'sourceRefs' ? 'Only screened same-person development captions; no test answers or event episodes enter the definition.' :
              'Preserved identity/language/boundary contract or deterministic authored versioning; not a caption-derived psychological claim.' });
    }
    refined.style.forEach((rule, index) => fieldProvenance.push({ pointer: `/style/${index}`, valueHash: hash(rule),
      basis: index >= 4 && index <= 6 ? 'observed_development_style' : 'authored_dialogue_design',
      sourceIds: index >= 4 && index <= 6 ? rowIds : [],
      rationale: index >= 4 && index <= 6 ? 'Formatting preference from development-only length/emoji/hashtag rates; captions do not prove spoken voice.' :
        'Independently authored dialogue behavior. Topic lens is inspired by development cues; exact real speech and personality remain unknown.' }));
    personas.push(refined);
    profiles.push({ personaId: original.id, personId: original.personId, originalRevision: original.revision,
      refinedRevision: refined.revision, design, developmentStyle: observed,
      developmentInputHash: hash(rows.map(r => ({ id: r.id, caption: r.caption, hash: r.hash, snapshot: r.snapshot }))),
      fieldProvenance, unknown: { actualPersonality: 'unknown', actualSpokenVoice: 'unknown' }, reviewStatus: 'silver' });
  }
  if (new Set(personas.map(p => p.concept)).size !== 4 || new Set(profiles.map(p => p.design)).size !== 4)
    throw new Error('Four distinct development-supported designs required; never split identical evidence arbitrarily');
  return { revision: REFINEMENT_REVISION, bundleRevision: hash(personas), personas, profiles,
    limitations: ['Silver authored dialogue designs, not verified real personality or spoken-voice fidelity.',
      'Regex screening and cue counts are conservative heuristics, not semantic privacy or injection guarantees.',
      'No live chat evaluation or comparative improvement claim; old evaluation sessions remain pinned to their original revision.'] };
}
async function privateImmutableJson(path: string, value: unknown): Promise<void> {
  const body = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, body, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(path, 'utf8') !== body)
      throw new Error('Versioned private artifact conflict; refuse overwrite');
  }
  await chmod(path, 0o600);
  if (((await stat(path)).mode & 0o777) !== 0o600) throw new Error('Private artifact mode invalid');
}
export async function writeRefinement(result: ReturnType<typeof refinePersonas>, originals: Persona[], outputRoot = process.cwd()): Promise<void> {
  const directory = `data/research/persona-variants/${result.bundleRevision}`;
  await privateImmutableJson(resolve(outputRoot, `${directory}/personas.json`), result.personas);
  await privateImmutableJson(resolve(outputRoot, `${directory}/originals.json`), originals);
  await privateImmutableJson(resolve(outputRoot, `${directory}/provenance.json`), result.profiles);
  await privateImmutableJson(resolve(outputRoot, `reports/persona-refinement/${result.bundleRevision}/validation.json`), {
    refinementRevision: result.revision, bundleRevision: result.bundleRevision, directory,
    personas: result.personas.length, distinctDesigns: new Set(result.profiles.map(p => p.design)).size,
    reviewed: false, providerCalls: 0, databaseWrites: 0, originalArchiveHash: hash(originals),
    personaHash: hash(result.personas), profilesHash: hash(result.profiles), limitations: result.limitations,
    bindings: result.profiles.map(p => ({ personaId: p.personaId, personId: p.personId,
      originalRevision: p.originalRevision, refinedRevision: p.refinedRevision,
      design: p.design, developmentCount: p.developmentStyle.count })),
  });
}
async function main(): Promise<void> {
  if (process.argv.slice(2).join(' ') !== '--offline') throw new Error('Use exactly --offline; no activation or external calls are supported');
  const inputs = {
    personas: JSON.parse(await readFile('data/research/personas.json', 'utf8')) as Persona[],
    sources: JSON.parse(await readFile('data/research/sources.json', 'utf8')) as SourcePost[],
    split: JSON.parse(await readFile('data/research/split.json', 'utf8')) as Split,
    targets: (JSON.parse(await readFile('data/manifests/targets.json', 'utf8')) as { people: Target[] }).people,
  };
  const result = refinePersonas(inputs);
  await writeRefinement(result, inputs.personas);
  console.log(JSON.stringify({ bundleRevision: result.bundleRevision, personas: result.personas.length,
    distinctDesigns: new Set(result.profiles.map(p => p.design)).size, providerCalls: 0, databaseWrites: 0 }));
}
if (require.main === module) void main().catch(() => { console.error('Offline persona refinement failed; private inputs are not printed.'); process.exitCode = 1; });
