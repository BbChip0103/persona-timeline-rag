import type { Pool } from 'pg';
import { PostgresSourceRepository, PostgresRetrieval } from '../src/sources';
import { imageAnnotationHash, ImageAnnotationInputSchema } from '../src/image-annotations';
const query = { personId: 'synthetic', query: '의자', dateBasis: 'posted' as const, timezone: 'UTC', limit: 2 };
const signal = new AbortController().signal;
describe('separate image annotation retrieval SQL', () => {
  const sql = jest.fn(async (_query: string, _values?: unknown[]) => ({ rows: [], rowCount: 0 }));
  const pool = { query: sql } as unknown as Pool;
  const repository = new PostgresSourceRepository(pool);
  beforeEach(() => sql.mockClear());
  it('caption lexical branch remains unchanged and emits no annotation joins', async () => {
    await repository.searchLexical(query, { personId: 'synthetic' }, { signal });
    expect(sql.mock.calls[0][0]).not.toContain('source_image'); expect(sql.mock.calls[0][0]).toContain('lower(p.caption)');
    const legacy = sql.mock.calls[0]; sql.mockClear();
    await repository.searchLexical(query, { personId: 'synthetic' }, { signal, evidenceScope: 'caption' });
    expect(sql.mock.calls[0]).toEqual(legacy);
  });
  it('augmented lexical includes latest revision and original scoped parent topK', async () => {
    await repository.searchLexical(query, { personId: 'synthetic' }, { signal, evidenceScope: 'caption_image' });
    expect(sql.mock.calls[0][0]).toContain('source_image_revisions');
    expect(sql.mock.calls[0][0]).toContain('ORDER BY ordinal DESC LIMIT 1');
    expect(sql.mock.calls[0][0]).toContain('p.person_id=$1 AND NOT p.unsafe');
    expect(sql.mock.calls[0][1]?.slice(-1)).toEqual([2]);
  });
  it('semantic image vectors isolate source + annotation revision + model; unannotated sources use existing caption vectors', async () => {
    const vector = [1, ...Array(1535).fill(0)] as number[];
    await repository.searchSemantic(query, { personId: 'synthetic' }, vector, 'fixture-model', { signal, evidenceScope: 'caption_image' });
    expect(sql.mock.calls[0][0]).toContain('v.annotation_revision=r.revision AND v.model_revision=$6');
    expect(sql.mock.calls[0][0]).toContain('NOT EXISTS(SELECT 1 FROM source_image_revisions');
    sql.mockClear(); await repository.searchSemantic(query, { personId: 'synthetic' }, vector, 'fixture-model', { signal });
    expect(sql.mock.calls[0][0]).not.toContain('source_image');
  });
  it('adapter forwards scope and rejects mixed person before any query embedding', async () => {
    const embed = jest.fn(async () => [1, ...Array(1535).fill(0)] as number[]);
    const retrieval = new PostgresRetrieval(repository, { embed, modelRevision: 'fixture' });
    await expect(retrieval.search(query, { personId: 'other' }, { signal, mode: 'semantic', evidenceScope: 'caption_image' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(embed).not.toHaveBeenCalled(); expect(sql).not.toHaveBeenCalled();
    await retrieval.search(query, { personId: 'synthetic' }, { signal, mode: 'lexical', evidenceScope: 'caption_image' });
    expect(sql.mock.calls[0][0]).toContain('source_image_revisions');
  });
  it('validates annotation hashes/provenance independently and refuses annotations as licensed source', async () => {
    const unsigned = { id: 'fixture', sourceId: 'synthetic', personId: 'synthetic', sourceHash: 'hash', imagePosition: 0,
      imageHash: 'a'.repeat(64), revision: 'v5-fixture', text: '합성 이미지 🌳', model: 'fixture', humanReviewed: false as const };
    expect(ImageAnnotationInputSchema.parse({ ...unsigned, annotationHash: imageAnnotationHash(unsigned) }).text).toBe(unsigned.text);
    expect(() => ImageAnnotationInputSchema.parse({ ...unsigned, text: 'x'.repeat(16001), annotationHash: imageAnnotationHash(unsigned) })).toThrow();
    expect(() => ImageAnnotationInputSchema.parse({ ...unsigned, humanReviewed: true, annotationHash: imageAnnotationHash(unsigned) })).toThrow();
    await expect(repository.importAnnotations([{ ...unsigned, annotationHash: '0'.repeat(64) }])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(repository.importPosts([{ id: 'synthetic', personId: 'synthetic', caption: 'fixture', postedAt: '2024-01-01T00:00:00Z', eventDate: null,
      sourceUrl: 'https://example.com', snapshot: 'fixture', hash: 'hash', unsafe: false, imageAnnotations: [] }], 'licensed_source')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
