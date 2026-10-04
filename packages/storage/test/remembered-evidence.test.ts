import type { Pool } from 'pg';
import type { EvidenceCard, SourcePost } from '@ptr/contracts';
import { PostgresSourceRepository, PostgresRetrieval, PostgresLexicalRetrieval, PostgresSemanticRetrieval } from '../src/sources';
const post: SourcePost = { id: 'synthetic-post', personId: 'synthetic-person', caption: 'Synthetic painting memory',
  postedAt: '2024-01-01T00:00:00Z', eventDate: null, sourceUrl: 'https://example.com/synthetic', snapshot: 'snapshot-a', hash: 'hash-a', unsafe: false };
const reference: EvidenceCard = { sourceId: post.id, personId: post.personId, sourceUrl: post.sourceUrl, postedAt: post.postedAt,
  eventDate: null, snapshot: post.snapshot, hash: post.hash, quote: 'painting', origin: 'source_caption' };
const annotation = { id: 'annotation-a', revision: 'old-revision', imageHash: 'image-hash', annotationHash: 'annotation-hash',
  text: 'Synthetic laptop painting', model: 'synthetic-model', humanReviewed: false as const };
const imageReference: EvidenceCard = { ...reference, origin: 'ai_image_annotation', annotationId: annotation.id,
  annotationRevision: annotation.revision, imageHash: annotation.imageHash, annotationHash: annotation.annotationHash, quote: 'laptop' };
const signal = new AbortController().signal;
describe('immutable remembered evidence lookup', () => {
  const query = jest.fn<Promise<{ rows: { index: number; document: SourcePost; annotation?: typeof annotation }[] }>, [string, unknown[]]>();
  const repository = new PostgresSourceRepository({ query } as unknown as Pool);
  const options = { signal, evidenceScope: 'caption_image' as const };
  beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });
  it('binds person, parent hash/snapshot and exact image identity in one bounded query, without latest revision', async () => {
    query.mockResolvedValue({ rows: [{ index: 0, document: post, annotation }] });
    expect(await repository.resolveEvidence([imageReference], { personId: post.personId }, options)).toEqual([{ ...post, imageAnnotations: [annotation] }]);
    const [sql, values] = query.mock.calls[0];
    expect(values[0]).toBe(post.personId);
    expect(JSON.parse(values[1] as string)).toEqual([{ index: 0, source_id: post.id, source_hash: post.hash, snapshot: post.snapshot,
      annotation_id: annotation.id, revision: annotation.revision, image_hash: annotation.imageHash, annotation_hash: annotation.annotationHash }]);
    for (const clause of ['NOT p.unsafe', 'p.person_id=$1', 'p.source_hash=refs.source_hash', "p.document->>'snapshot'=refs.snapshot", 'r.revision=refs.revision', 'r.source_hash=p.source_hash', 'a.id=refs.annotation_id', 'a.image_hash=refs.image_hash', 'a.annotation_hash=refs.annotation_hash']) expect(sql).toContain(clause);
    expect(sql).not.toContain('ORDER BY ordinal');
  });
  it('deduplicates parents and includes only pinned annotations, never annotation siblings', async () => {
    query.mockResolvedValue({ rows: [{ index: 0, document: post }, { index: 1, document: post, annotation }, { index: 2, document: post, annotation }] });
    expect(await repository.resolveEvidence([reference, imageReference, imageReference], { personId: post.personId }, options)).toEqual([{ ...post, imageAnnotations: [annotation] }]);
  });
  it('caption scope never returns AI descriptions, even when an image reference resolves', async () => {
    query.mockResolvedValue({ rows: [{ index: 0, document: { ...post, imageAnnotations: [annotation] }, annotation }] });
    expect(await repository.resolveEvidence([imageReference], { personId: post.personId }, { signal, evidenceScope: 'caption' })).toEqual([post]);
  });
  it('rejects mixed people, oversized batches and partial annotation identities before SQL', async () => {
    await expect(repository.resolveEvidence([reference], { personId: 'other' }, options)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(repository.resolveEvidence(Array(21).fill(reference), { personId: post.personId }, options)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(repository.resolveEvidence([{ ...imageReference, annotationRevision: undefined }], { personId: post.personId }, options)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(repository.resolveEvidence([{ ...reference, origin: 'ai_image_annotation' }], { personId: post.personId }, options)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(query).not.toHaveBeenCalled();
  });
  it('empty references and cancellation do not query storage', async () => {
    expect(await repository.resolveEvidence([], { personId: post.personId }, options)).toEqual([]);
    const controller = new AbortController(); controller.abort();
    await expect(repository.resolveEvidence([reference], { personId: post.personId }, { signal: controller.signal })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
  });
  it('drops missing or stale references and mismatched immutable metadata', async () => {
    expect(await repository.resolveEvidence([reference], { personId: post.personId }, options)).toEqual([]);
    for (const mutation of [{ personId: 'other' }, { hash: 'changed' }, { snapshot: 'changed' }, { unsafe: true }]) {
      query.mockResolvedValue({ rows: [{ index: 0, document: { ...post, ...mutation } }] });
      expect(await repository.resolveEvidence([reference], { personId: post.personId }, options)).toEqual([]);
    }
    for (const mutation of [{ revision: 'latest-revision' }, { annotationHash: 'changed' }, { imageHash: 'changed' }, { id: 'other' }, { text: 'different scene' }]) {
      query.mockResolvedValue({ rows: [{ index: 0, document: post, annotation: { ...annotation, ...mutation } }] });
      expect(await repository.resolveEvidence([imageReference], { personId: post.personId }, options)).toEqual([]);
    }
    query.mockResolvedValue({ rows: [{ index: 0, document: post }] });
    expect(await repository.resolveEvidence([{ ...reference, quote: 'not in the caption' }], { personId: post.personId }, options)).toEqual([]);
  });
  it('all retrieval adapters rehydrate evidence without generating embeddings', async () => {
    query.mockResolvedValue({ rows: [{ index: 0, document: post }] });
    const embed = jest.fn(async () => []);
    const adapters = [new PostgresRetrieval(repository, { embed, modelRevision: 'synthetic' }),
      new PostgresSemanticRetrieval(repository, embed, 'synthetic'), new PostgresLexicalRetrieval(repository)];
    for (const adapter of adapters) expect(await adapter.resolve([reference], { personId: post.personId }, options)).toEqual([post]);
    expect(embed).not.toHaveBeenCalled(); expect(query).toHaveBeenCalledTimes(3);
  });
});
