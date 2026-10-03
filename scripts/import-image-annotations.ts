import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { SourcePostSchema, type SourcePost } from '@ptr/contracts';
import { OpenRouterClient, PostgresBudgetLedger, ProviderError, EMBEDDING_MODEL } from '@ptr/providers';
import { createLocalPool, PostgresSourceRepository, ImageAnnotationInputSchema, imageAnnotationHash, type ImageAnnotationInput } from '@ptr/storage';
import { privateJson } from './prepare-research';

const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonempty = z.string().min(1);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const RecordSchema = z.object({
  visual: z.object({ imageId: nonempty, description_ko: nonempty,
    observed_emphasis: z.object({ main_subjects: z.array(z.string()), visual_basis: z.array(z.string()) }),
    communicative_intent: z.object({ epistemic_status: nonempty, hypotheses: z.array(z.object({
      hypothesis_ko: nonempty, visual_basis: z.array(z.string()), confidence: nonempty,
      uncertainty_ko: nonempty, alternatives: z.array(z.string()),
    })) }),
  }),
  source: z.object({ imageId: nonempty, sha256: sha, associations: z.array(z.object({
    person_id: nonempty, source_id: nonempty, source_hash: nonempty, image_position: z.number().int().nonnegative(),
  })).min(1) }),
  provenance: z.object({ model: nonempty, prompt_version: nonempty, human_reviewed: z.literal(false) }),
  intent_style_derivation: z.object({ version: nonempty, hash: sha, human_reviewed: z.literal(false) }).passthrough().optional(),
});
export interface AnnotationPlan {
  annotations: ImageAnnotationInput[];
  inputs: { sourceId: string; revision: string; text: string }[];
  skippedUnsafe: number;
  skippedOversize: number;
}
/** No caption_context, author identification or inferred event date is indexed. */
export function annotationText(record: z.infer<typeof RecordSchema>): string {
  const visual = record.visual;
  return [
    'AI image annotation; not human reviewed. Visible observations do not identify people or establish event dates.',
    `Visual description: ${visual.description_ko}`,
    `Salient visual emphasis: ${visual.observed_emphasis.main_subjects.join('; ')}`,
    `Visual basis: ${visual.observed_emphasis.visual_basis.join('; ')}`,
    'Tentative inferred communicative intent; hypotheses only, NOT confirmed author intention:',
    ...visual.communicative_intent.hypotheses.map(h => [
      `Tentative interpretation: ${h.hypothesis_ko}`, `Confidence: ${h.confidence}`,
      `Visual basis: ${h.visual_basis.join('; ')}`, `Uncertainty: ${h.uncertainty_ko}`,
      `Alternatives: ${h.alternatives.join('; ')}`,
    ].join('\n')),
  ].join('\n');
}
export function prepareImageAnnotations(records: unknown[], sourceInputs: SourcePost[], allowLegacyDryRun = false): AnnotationPlan {
  const sources = sourceInputs.map(input => SourcePostSchema.parse(input));
  const parents = new Map(sources.map(source => [source.id, source]));
  if (parents.size !== sources.length) throw new Error('Duplicate source identities');
  const groups = new Map<string, { position: number; imageHash: string; text: string; model: string; styleHash: string }[]>();
  const seenImages = new Set<string>(); const associations = new Set<string>();
  const unsafe = new Set<string>();
  for (const input of records) {
    const record = RecordSchema.parse(input);
    if (!record.intent_style_derivation && !allowLegacyDryRun) throw new Error('Declarative v5 derivation is required');
    if (record.visual.imageId !== record.source.imageId || seenImages.has(record.source.imageId)) throw new Error('Duplicate or mismatched image identity');
    seenImages.add(record.source.imageId);
    const text = annotationText(record);
    for (const association of record.source.associations) {
      const parent = parents.get(association.source_id);
      if (!parent) throw new Error('Unknown source association');
      if (parent.personId !== association.person_id || parent.hash !== association.source_hash) throw new Error('Source association scope/hash mismatch');
      const key = JSON.stringify([parent.id, association.image_position]);
      if (associations.has(key)) throw new Error('Duplicate image position');
      associations.add(key);
      if (parent.unsafe) { unsafe.add(parent.id); continue; }
      groups.set(parent.id, [...(groups.get(parent.id) ?? []), { position: association.image_position,
        imageHash: record.source.sha256, text, model: record.provenance.model,
        styleHash: record.intent_style_derivation?.hash ?? 'legacy-dry-run-only' }]);
    }
  }
  const annotations: ImageAnnotationInput[] = []; const inputs: AnnotationPlan['inputs'] = [];
  let skippedOversize = 0;
  for (const [sourceId, rows] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    rows.sort((a, b) => a.position - b.position);
    const parent = parents.get(sourceId)!;
    const revision = `image-v5-${digest(rows).slice(0, 24)}`;
    const text = [parent.caption, ...new Set(rows.map(row => row.text))].join('\n');
    // Skip the entire parent rather than storing a partial image revision.
    if (rows.length > 100 || Buffer.byteLength(JSON.stringify(text), 'utf8') > 30000 || rows.some(row => row.text.length > 16000)) { skippedOversize++; continue; }
    for (const row of rows) {
      const unsigned = { id: `image-annotation:${digest([sourceId, revision, row.position])}`, sourceId,
        personId: parent.personId, sourceHash: parent.hash, imagePosition: row.position, imageHash: row.imageHash,
        revision, text: row.text, model: row.model, humanReviewed: false as const };
      annotations.push(ImageAnnotationInputSchema.parse({ ...unsigned, annotationHash: imageAnnotationHash(unsigned) }));
    }
    inputs.push({ sourceId, revision, text });
  }
  return { annotations, inputs, skippedUnsafe: unsafe.size, skippedOversize };
}
export function augmentedBatches(inputs: AnnotationPlan['inputs']): AnnotationPlan['inputs'][] {
  const batches: AnnotationPlan['inputs'][] = []; let batch: AnnotationPlan['inputs'] = []; let bytes = 0;
  for (const input of inputs) {
    const size = Buffer.byteLength(JSON.stringify(input.text), 'utf8');
    if (size > 30000) throw new Error('Oversize augmented embedding input');
    if (batch.length === 8 || bytes + size > 30000) { batches.push(batch); batch = []; bytes = 0; }
    batch.push(input); bytes += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
export async function runImageImport(args: string[]): Promise<void> {
  if (args.some(arg => !['--dry-run', '--import', '--live-index', '--legacy-dry-run'].includes(arg))) throw new Error('Unsupported image importer option');
  const importing = args.includes('--import'); const indexing = args.includes('--live-index');
  const legacy = args.includes('--legacy-dry-run');
  if ((args.includes('--dry-run') && (importing || indexing)) || (indexing && !importing) || (legacy && (importing || indexing))) throw new Error('Conflicting image importer options');
  const directory = legacy ? 'image_descriptions_v4_1' : 'image_descriptions_v5_declarative';
  const records = (await readFile(`data/research/${directory}/images.jsonl`, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as unknown);
  const sources = JSON.parse(await readFile('data/research/sources.json', 'utf8')) as SourcePost[];
  const plan = prepareImageAnnotations(records, sources, legacy);
  const summary = { mode: importing ? (indexing ? 'live-index' : 'import-only') : 'dry-run', annotations: plan.annotations.length,
    parents: plan.inputs.length, estimatedEmbeddingCalls: augmentedBatches(plan.inputs).length,
    skippedUnsafeParents: plan.skippedUnsafe, skippedOversizeParents: plan.skippedOversize, humanReviewed: false };
  if (!importing) { console.log(JSON.stringify(summary)); return; }
  if (indexing && (process.env.GOAL1_LIVE_ENABLED !== 'true' || process.env.GOAL1_ALLOW_EXTERNAL_DATA !== 'true')) throw new ProviderError('LIVE_DISABLED');
  const url = process.env.DATABASE_URL ?? ''; const pool = createLocalPool(url);
  try {
    const repository = new PostgresSourceRepository(pool);
    const imported = await repository.importAnnotations(plan.annotations);
    let indexed = 0;
    if (indexing) {
      const ledger = new PostgresBudgetLedger(pool, url); await ledger.initialize();
      const client = new OpenRouterClient({ apiKey: process.env.OPENROUTER_API_KEY ?? '', liveEnabled: true, allowExternalData: true, databaseUrl: url, ledger });
      await client.verifyPricing(AbortSignal.timeout(60000));
      const existing = await pool.query('SELECT source_id,annotation_revision FROM source_image_vectors WHERE model_revision=$1', [EMBEDDING_MODEL]);
      const done = new Set(existing.rows.map(row => JSON.stringify([row.source_id, row.annotation_revision])));
      for (const batch of augmentedBatches(plan.inputs)) {
        if (batch.every(input => done.has(JSON.stringify([input.sourceId, input.revision])))) continue;
        // OpenRouterClient reuses persistent request hashes; submitted/unknown requests cannot be retried.
        const vectors = await client.embed(batch.map(input => input.text), { signal: AbortSignal.timeout(60000) });
        for (let i = 0; i < batch.length; i++) {
          const input = batch[i]!;
          if (done.has(JSON.stringify([input.sourceId, input.revision]))) continue;
          await repository.importImageVector(input.sourceId, input.revision, EMBEDDING_MODEL, vectors[i]!); indexed++;
        }
        await privateJson('reports/image-index-progress.json', { ...summary, ...imported, indexedThisRun: indexed, model: EMBEDDING_MODEL });
      }
    }
    console.log(JSON.stringify({ ...summary, ...imported, indexedThisRun: indexed }));
  } finally { await pool.end(); }
}
if (require.main === module) void runImageImport(process.argv.slice(2)).catch(error => {
  console.error(error instanceof ProviderError ? error.code : 'Image annotation import failed; details remain private.'); process.exitCode = 1;
});
