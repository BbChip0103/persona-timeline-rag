import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { SourcePost, TimelineQuery } from '@ptr/contracts';
import { createLocalPool, PostgresSourceRepository, imageAnnotationHash, type ImageAnnotationInput } from '../src';
const enabled = process.env.RUN_STORAGE_DB_TESTS === '1' && Boolean(process.env.DATABASE_URL);
(enabled ? describe : describe.skip)('local image annotation SQL (synthetic only, additive)', () => {
  let pool: Pool; let sources: PostgresSourceRepository;
  const personId = `synthetic-images-${randomUUID()}`;
  const signal = new AbortController().signal;
  const posts: SourcePost[] = ['safe', 'other', 'unsafe', 'outside', 'caption-only'].map((kind, i) => ({
    id: `${personId}-${kind}`, personId: kind === 'other' ? `${personId}-other` : personId,
    caption: '합성 캡션', postedAt: kind === 'outside' ? '2020-01-01T00:00:00Z' : '2024-01-01T00:00:00Z',
    eventDate: null, sourceUrl: 'https://example.com/synthetic', snapshot: 'synthetic', hash: `hash-${i}`, unsafe: kind === 'unsafe',
  }));
  const query: TimelineQuery = { personId, query: '빨간 의자', dateBasis: 'posted', timezone: 'UTC', start: '2024-01-01', end: '2024-01-02', limit: 3 };
  const axis = (index: number): number[] => Array.from({ length: 1536 }, (_, dimension) => dimension === index ? 1 : 0);
  function annotation(post: SourcePost, revision = 'synthetic-v5', text = '합성 빨간 의자 🌳; Tentative interpretation, not confirmed author intent'): ImageAnnotationInput {
    const unsigned = { id: `${post.id}-${revision}`, sourceId: post.id, personId: post.personId, sourceHash: post.hash,
      imagePosition: 0, imageHash: 'a'.repeat(64), revision, text, model: 'synthetic-vision', humanReviewed: false as const };
    return { ...unsigned, annotationHash: imageAnnotationHash(unsigned) };
  }
  beforeAll(async () => {
    pool = createLocalPool(process.env.DATABASE_URL!); sources = new PostgresSourceRepository(pool);
    await sources.importPosts(posts, 'synthetic_fixture');
    for (const post of posts) await sources.importVector(post.id, 'synthetic-embedding', axis(0));
  });
  afterAll(async () => { await pool?.end(); });
  it('imports immutable revisions idempotently and preserves caption/document/hash', async () => {
    const row = annotation(posts[0]);
    const before = await pool.query('SELECT caption,document,source_hash,content_hash FROM source_posts WHERE id=$1', [posts[0].id]);
    expect(await sources.importAnnotations([row])).toEqual({ inserted: 1, existing: 0 });
    expect(await sources.importAnnotations([row])).toEqual({ inserted: 0, existing: 1 });
    await expect(sources.importAnnotations([annotation(posts[0], row.revision, 'mutated')])).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const after = await pool.query('SELECT caption,document,source_hash,content_hash FROM source_posts WHERE id=$1', [posts[0].id]);
    expect(after.rows).toEqual(before.rows);
    await expect(pool.query('UPDATE source_image_annotations SET annotation_hash=$1 WHERE id=$2', ['b'.repeat(64), row.id])).rejects.toThrow();
  });
  it('rejects unknown, unsafe, wrong person/hash parents and duplicate position', async () => {
    await expect(sources.importAnnotations([annotation({ ...posts[0], id: `${personId}-missing` })])).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(sources.importAnnotations([annotation(posts[2])])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const mutation of [{ personId: 'other-person' }, { hash: 'wrong' }])
      await expect(sources.importAnnotations([annotation({ ...posts[0], ...mutation }, 'bad-revision')])).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const row = annotation(posts[0], 'duplicate');
    await expect(sources.importAnnotations([row, row])).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('lexical augmentation returns same scoped parent with separate provenance; caption stays unchanged', async () => {
    await sources.importAnnotations([annotation(posts[1]), annotation(posts[3])]);
    expect(await sources.searchLexical(query, { personId }, { signal })).toEqual([]);
    const result = await sources.searchLexical(query, { personId }, { signal, evidenceScope: 'caption_image' });
    expect(result.map(row => row.id)).toEqual([posts[0].id]);
    expect(result[0].caption).toBe(posts[0].caption); expect(result[0].imageAnnotations).toEqual([{
      id: annotation(posts[0]).id, imageHash: 'a'.repeat(64), annotationHash: annotation(posts[0]).annotationHash,
      revision: 'synthetic-v5', text: annotation(posts[0]).text, model: 'synthetic-vision', humanReviewed: false,
    }]);
    const caption = await sources.searchLexical({ ...query, query: '합성 캡션' }, { personId }, { signal });
    expect(caption.every(row => row.imageAnnotations === undefined)).toBe(true);
  });
  it('semantic uses isolated augmented model/revision and caption fallback without cross-scope leakage', async () => {
    for (const post of [posts[0], posts[1], posts[3]]) await sources.importImageVector(post.id, 'synthetic-v5', 'synthetic-embedding', axis(1));
    const result = await sources.searchSemantic(query, { personId }, axis(1), 'synthetic-embedding', { signal, evidenceScope: 'caption_image' });
    expect(result.map(row => row.id)).toEqual([posts[0].id, posts[4].id]);
    expect(result[0].imageAnnotations).toHaveLength(1); expect(result[1].imageAnnotations).toBeUndefined();
    await sources.importImageVector(posts[0].id, 'synthetic-v5', 'synthetic-embedding', axis(1));
    await expect(sources.importImageVector(posts[0].id, 'synthetic-v5', 'synthetic-embedding', axis(0))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(sources.importImageVector(posts[0].id, 'missing', 'synthetic-embedding', axis(0))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const caption = await sources.searchSemantic(query, { personId }, axis(0), 'synthetic-embedding', { signal });
    expect(caption.every(row => row.imageAnnotations === undefined)).toBe(true);
  });
  it('new revision is selected while replaying older revision cannot roll back; no old-vector reuse', async () => {
    await sources.importAnnotations([annotation(posts[0], 'synthetic-v6', '합성 파란 컵')]);
    await sources.importAnnotations([annotation(posts[0])]);
    expect(await sources.searchLexical(query, { personId }, { signal, evidenceScope: 'caption_image' })).toEqual([]);
    const newResult = await sources.searchLexical({ ...query, query: '파란 컵' }, { personId }, { signal, evidenceScope: 'caption_image' });
    expect(newResult[0].imageAnnotations?.[0].revision).toBe('synthetic-v6');
    const beforeVector = await sources.searchSemantic(query, { personId }, axis(1), 'synthetic-embedding', { signal, evidenceScope: 'caption_image' });
    expect(beforeVector.map(row => row.id)).not.toContain(posts[0].id);
    await sources.importImageVector(posts[0].id, 'synthetic-v6', 'synthetic-embedding', axis(1));
    const afterVector = await sources.searchSemantic(query, { personId }, axis(1), 'synthetic-embedding', { signal, evidenceScope: 'caption_image' });
    expect(afterVector[0].imageAnnotations?.[0].revision).toBe('synthetic-v6');
  });
});
