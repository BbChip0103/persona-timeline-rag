import { prepareImageAnnotations, augmentedBatches, runImageImport } from '../import-image-annotations';
import type { SourcePost } from '@ptr/contracts';
const source: SourcePost = { id: 'synthetic:post', personId: 'synthetic', caption: 'Original synthetic caption',
  postedAt: '2024-01-01T00:00:00Z', eventDate: null, sourceUrl: 'https://example.com/synthetic', hash: 'source-hash', snapshot: 'fixture', unsafe: false };
function record() {
  return { visual: { imageId: 'synthetic-image', description_ko: '합성 빨간 의자와 나무 🌳', observed_emphasis: { main_subjects: ['의자'], visual_basis: ['빨간색'] },
    communicative_intent: { epistemic_status: 'tentative', hypotheses: [{ hypothesis_ko: '편안한 분위기를 보여주는 이미지다.', confidence: 'low', visual_basis: ['의자'], uncertainty_ko: '작성자 의도는 확인하지 못했다.', alternatives: ['색상 연습'] }] } },
  caption_context: [{ caption_based_summary_ko: 'NEVER_INDEX_CONTEXT' }],
  source: { imageId: 'synthetic-image', sha256: 'a'.repeat(64), associations: [{ person_id: source.personId, source_id: source.id, source_hash: source.hash, image_position: 0 }] },
  provenance: { model: 'synthetic-vision', prompt_version: 'synthetic-v3', human_reviewed: false },
  intent_style_derivation: { version: 'synthetic-v5', hash: 'b'.repeat(64), human_reviewed: false } };
}
describe('private image annotation import planning (synthetic fixtures)', () => {
  it('preserves source caption and excludes caption_context while marking tentative intent', () => {
    const plan = prepareImageAnnotations([record()], [source]);
    expect(plan.annotations).toHaveLength(1); expect(plan.inputs).toHaveLength(1);
    expect(plan.annotations[0].text).toContain('합성 빨간 의자와 나무 🌳');
    expect(plan.annotations[0].text).toContain('Tentative interpretation:');
    expect(plan.annotations[0].text).toContain('Uncertainty:');
    expect(plan.annotations[0].text).not.toContain('NEVER_INDEX_CONTEXT');
    expect(plan.inputs[0].text.startsWith(source.caption)).toBe(true);
    expect(source.caption).toBe('Original synthetic caption');
    expect(prepareImageAnnotations([record()], [source])).toEqual(plan);
  });
  it('refuses unknown, different-person, different-hash and duplicate-position association', () => {
    for (const mutation of [{ source_id: 'unknown' }, { person_id: 'other' }, { source_hash: 'wrong' }]) {
      const row = record(); Object.assign(row.source.associations[0], mutation);
      expect(() => prepareImageAnnotations([row], [source])).toThrow();
    }
    const row = record(); row.source.associations.push({ ...row.source.associations[0] });
    expect(() => prepareImageAnnotations([row], [source])).toThrow('Duplicate image position');
    expect(() => prepareImageAnnotations([record(), record()], [source])).toThrow('Duplicate');
  });
  it('skips an entire unsafe parent and never creates a partial oversize parent revision', () => {
    expect(prepareImageAnnotations([record()], [{ ...source, unsafe: true }])).toMatchObject({ annotations: [], inputs: [], skippedUnsafe: 1 });
    const row = record(); row.visual.description_ko = '가'.repeat(12000);
    expect(prepareImageAnnotations([row], [source])).toMatchObject({ annotations: [], inputs: [], skippedOversize: 1 });
    row.visual.description_ko = 'x'.repeat(17000);
    expect(prepareImageAnnotations([row], [source])).toMatchObject({ annotations: [], inputs: [], skippedOversize: 1 });
  });
  it('keeps duplicate image position links while deduplicating visual embedding text', () => {
    const row = record(); row.source.associations.push({ ...row.source.associations[0], image_position: 1 });
    const plan = prepareImageAnnotations([row], [source]);
    expect(plan.annotations.map(item => item.imagePosition)).toEqual([0, 1]);
    expect(new Set(plan.annotations.map(item => item.id)).size).toBe(2);
    expect(plan.inputs[0].text.split('AI image annotation;').length - 1).toBe(1);
  });
  it('requires declarative v5 for real import and isolates old-style dry-run', async () => {
    const { intent_style_derivation: _style, ...old } = record();
    expect(() => prepareImageAnnotations([old], [source])).toThrow('v5');
    expect(prepareImageAnnotations([old], [source], true).annotations).toHaveLength(1);
    await expect(runImageImport(['--legacy-dry-run', '--import'])).rejects.toThrow();
    await expect(runImageImport(['--live-index'])).rejects.toThrow();
    await expect(runImageImport(['--dry-run', '--import'])).rejects.toThrow();
  });
  it('changes revision on annotation change and batches by <=8 and 30000 UTF-8 JSON bytes', () => {
    const before = prepareImageAnnotations([record()], [source]); const row = record(); row.visual.description_ko += ' 다른 합성 색상';
    expect(prepareImageAnnotations([row], [source]).inputs[0].revision).not.toBe(before.inputs[0].revision);
    const batches = augmentedBatches(Array.from({ length: 19 }, (_, i) => ({ sourceId: String(i), revision: 'fixture', text: '가'.repeat(1500) })));
    expect(batches.flat()).toHaveLength(19);
    for (const batch of batches) { expect(batch.length).toBeLessThanOrEqual(8); expect(batch.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.text)), 0)).toBeLessThanOrEqual(30000); }
    expect(() => augmentedBatches([{ sourceId: 'fixture', revision: 'v1', text: '가'.repeat(10001) }])).toThrow();
  });
});
