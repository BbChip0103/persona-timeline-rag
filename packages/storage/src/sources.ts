import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { SourcePostSchema, TimelineQuerySchema, type SourcePost, type TimelineQuery } from '@ptr/contracts';
import { CoreError, type Retrieval } from '@ptr/core';
import { transaction } from './pool.js';
import { ImageAnnotationInputSchema, imageAnnotationHash, imageAnnotationEvidence, type ImageAnnotationInput, type EvidenceScope } from './image-annotations.js';

export type SourceOrigin = 'licensed_source' | 'synthetic_fixture';
export type QueryEmbedder = (text: string, options: { signal: AbortSignal; evidenceScope?: EvidenceScope }) => Promise<number[]>;
function checkedVector(vector: number[]): string {
  const normalized = vector.map(value => Math.fround(value));
  if (normalized.length !== 1536 || normalized.some(value => !Number.isFinite(value)) || !normalized.some(value => value !== 0))
    throw new CoreError('INVALID_INPUT', 'Expected a finite, nonzero 1536-dimensional embedding');
  return JSON.stringify(normalized);
}
function parameters(query: TimelineQuery, trusted: { personId: string }): unknown[] {
  const parsed = TimelineQuerySchema.parse(query);
  if (parsed.personId !== trusted.personId) throw new CoreError('FORBIDDEN', 'Retrieval person scope mismatch');
  return [trusted.personId, parsed.start ?? null, parsed.end ?? null, parsed.timezone, parsed.dateBasis];
}
// Posted date uses the requested local midnight instant; event dates are calendar dates,
// not timestamps or guessed posted dates. Both ranges are [start,end).
const scope = `p.person_id=$1 AND NOT p.unsafe AND (
  $2::date IS NULL OR CASE WHEN $5='event' THEN p.event_date >= $2::date AND p.event_date < $3::date
  ELSE p.posted_at >= ($2::date::timestamp AT TIME ZONE $4)
    AND p.posted_at < ($3::date::timestamp AT TIME ZONE $4) END)`;

export class PostgresSourceRepository {
  constructor(private readonly pool: Pool) {}
  async importPosts(inputs: SourcePost[], origin: SourceOrigin): Promise<{ inserted: number; existing: number }> {
    if (origin !== 'licensed_source' && origin !== 'synthetic_fixture')
      throw new CoreError('INVALID_INPUT', 'Generated material is not a source origin');
    const posts = inputs.map(input => {
      const post = SourcePostSchema.parse(input);
      if (post.imageAnnotations !== undefined) throw new CoreError('INVALID_INPUT', 'Generated annotations must be imported separately');
      return post;
    });
    return transaction(this.pool, async client => {
      let inserted = 0;
      let existing = 0;
      for (const post of posts) {
        const hash = createHash('sha256').update(JSON.stringify({ post, origin })).digest('hex');
        const result = await client.query(`INSERT INTO source_posts(id,person_id,posted_at,event_date,caption,unsafe,source_url,snapshot,source_hash,content_hash,origin,document)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING RETURNING id`,
        [post.id, post.personId, post.postedAt, post.eventDate, post.caption, post.unsafe, post.sourceUrl, post.snapshot, post.hash, hash, origin, post]);
        if (result.rowCount) inserted++;
        else {
          const previous = await client.query('SELECT content_hash FROM source_posts WHERE id=$1', [post.id]);
          if (previous.rows[0]?.content_hash !== hash)
            throw new CoreError('IDEMPOTENCY_CONFLICT', 'Source snapshot cannot be overwritten');
          existing++;
        }
      }
      return { inserted, existing };
    });
  }
  async importAnnotations(inputs: ImageAnnotationInput[]): Promise<{ inserted: number; existing: number }> {
    const rows = inputs.map(input => ImageAnnotationInputSchema.parse(input));
    const groups = new Map<string, ImageAnnotationInput[]>();
    for (const row of rows) {
      const { annotationHash, ...unsigned } = row;
      if (imageAnnotationHash(unsigned) !== annotationHash) throw new CoreError('INVALID_INPUT', 'Annotation hash mismatch');
      const key = JSON.stringify([row.sourceId, row.revision]);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return transaction(this.pool, async client => {
      let inserted = 0; let existing = 0;
      for (const group of groups.values()) {
        group.sort((a, b) => a.imagePosition - b.imagePosition);
        const first = group[0]!;
        if (group.length > 100) throw new CoreError('INVALID_INPUT', 'Too many image annotations for one parent');
        if (new Set(group.map(row => row.imagePosition)).size !== group.length || new Set(group.map(row => row.id)).size !== group.length)
          throw new CoreError('INVALID_INPUT', 'Duplicate annotation association');
        const parent = await client.query('SELECT person_id,source_hash,unsafe FROM source_posts WHERE id=$1', [first.sourceId]);
        if (!parent.rows[0]) throw new CoreError('NOT_FOUND', 'Unknown annotation parent');
        if (parent.rows[0].unsafe || group.some(row => row.personId !== parent.rows[0].person_id || row.sourceHash !== parent.rows[0].source_hash))
          throw new CoreError('FORBIDDEN', 'Annotation parent scope mismatch or unsafe source');
        const hash = createHash('sha256').update(JSON.stringify(group)).digest('hex');
        const result = await client.query(`INSERT INTO source_image_revisions(source_id,revision,person_id,source_hash,content_hash,document)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING source_id`,
        [first.sourceId, first.revision, first.personId, first.sourceHash, hash, JSON.stringify(group.map(imageAnnotationEvidence))]);
        if (!result.rowCount) {
          const previous = await client.query('SELECT content_hash FROM source_image_revisions WHERE source_id=$1 AND revision=$2', [first.sourceId, first.revision]);
          if (previous.rows[0]?.content_hash !== hash) throw new CoreError('IDEMPOTENCY_CONFLICT', 'Annotation revision cannot be overwritten');
          existing += group.length; continue;
        }
        for (const row of group) await client.query(`INSERT INTO source_image_annotations(id,source_id,revision,image_position,image_hash,annotation_hash,document)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [row.id, row.sourceId, row.revision, row.imagePosition, row.imageHash, row.annotationHash, imageAnnotationEvidence(row)]);
        inserted += group.length;
      }
      return { inserted, existing };
    });
  }
  async importImageVector(sourceId: string, annotationRevision: string, modelRevision: string, embedding: number[]): Promise<void> {
    if (!annotationRevision.trim() || !modelRevision.trim()) throw new CoreError('INVALID_INPUT');
    const vector = checkedVector(embedding);
    await transaction(this.pool, async client => {
      const parent = await client.query('SELECT source_id FROM source_image_revisions WHERE source_id=$1 AND revision=$2', [sourceId, annotationRevision]);
      if (!parent.rowCount) throw new CoreError('NOT_FOUND', 'Unknown annotation revision');
      const result = await client.query(`INSERT INTO source_image_vectors(source_id,annotation_revision,model_revision,embedding)
        VALUES($1,$2,$3,$4::vector) ON CONFLICT DO NOTHING RETURNING source_id`, [sourceId, annotationRevision, modelRevision, vector]);
      if (!result.rowCount) {
        const previous = await client.query('SELECT embedding::text AS vector FROM source_image_vectors WHERE source_id=$1 AND annotation_revision=$2 AND model_revision=$3', [sourceId, annotationRevision, modelRevision]);
        const stored = JSON.parse(previous.rows[0]?.vector ?? 'null') as number[] | null;
        if (!stored || stored.length !== embedding.length || stored.some((value, index) => Math.fround(value) !== Math.fround(embedding[index]!)))
          throw new CoreError('IDEMPOTENCY_CONFLICT', 'Augmented embedding revision is immutable');
      }
    });
  }
  async importVector(sourceId: string, modelRevision: string, embedding: number[]): Promise<void> {
    if (!modelRevision.trim()) throw new CoreError('INVALID_INPUT');
    const vector = checkedVector(embedding);
    await transaction(this.pool, async client => {
      const result = await client.query(`INSERT INTO source_vectors(source_id,model_revision,embedding) VALUES($1,$2,$3::vector)
        ON CONFLICT DO NOTHING RETURNING source_id`, [sourceId, modelRevision, vector]);
      if (!result.rowCount) {
        const previous = await client.query('SELECT embedding::text AS vector FROM source_vectors WHERE source_id=$1 AND model_revision=$2', [sourceId, modelRevision]);
        const stored = JSON.parse(previous.rows[0]?.vector ?? 'null') as number[] | null;
        // pgvector stores float32; compare with the same normalization.
        if (!stored || stored.some((value, index) => Math.fround(value) !== Math.fround(embedding[index]!)))
          throw new CoreError('IDEMPOTENCY_CONFLICT', 'Embedding model revision is immutable');
      }
    });
  }
  async searchLexical(query: TimelineQuery, trusted: { personId: string }, options: { signal: AbortSignal; evidenceScope?: EvidenceScope }): Promise<SourcePost[]> {
    options.signal.throwIfAborted();
    const values = parameters(query, trusted);
    const phrase = query.query?.toLocaleLowerCase().normalize('NFC') ?? '';
    const tokens = [...new Set(phrase.match(/[\p{L}\p{N}]+/gu) ?? [])];
    if (options.evidenceScope === 'caption_image') {
      const result = await this.pool.query(`WITH augmented AS (
        SELECT p.*,r.document AS annotations,p.caption || E'\\n' || COALESCE((SELECT string_agg(DISTINCT a->>'text',E'\\n') FROM jsonb_array_elements(r.document) a),'') AS combined
        FROM source_posts p LEFT JOIN LATERAL (SELECT document FROM source_image_revisions
          WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1) r ON true WHERE ${scope}
      ) SELECT document,annotations,CASE WHEN $6='' THEN 0 ELSE CASE WHEN position($6 IN lower(combined))>0 THEN 10 ELSE 0 END
        + (SELECT count(*) FROM unnest($7::text[]) token WHERE position(token IN lower(combined))>0) END AS score
        FROM augmented WHERE $6='' OR position($6 IN lower(combined))>0
        OR EXISTS(SELECT 1 FROM unnest($7::text[]) token WHERE position(token IN lower(combined))>0)
        ORDER BY score DESC,posted_at DESC,id ASC LIMIT $8`, [...values, phrase, tokens, query.limit]);
      options.signal.throwIfAborted();
      return result.rows.map(row => SourcePostSchema.parse({ ...row.document, ...(row.annotations ? { imageAnnotations: row.annotations } : {}) }));
    }
    // Multilingual substring/token ranking, deliberately not advertised as BM25.
    const result = await this.pool.query(`SELECT p.document,
      CASE WHEN $6='' THEN 0 ELSE CASE WHEN position($6 IN lower(p.caption))>0 THEN 10 ELSE 0 END
        + (SELECT count(*) FROM unnest($7::text[]) token WHERE position(token IN lower(p.caption))>0) END AS score
      FROM source_posts p WHERE ${scope}
      AND ($6='' OR position($6 IN lower(p.caption))>0
        OR EXISTS(SELECT 1 FROM unnest($7::text[]) token WHERE position(token IN lower(p.caption))>0))
      ORDER BY score DESC,p.posted_at DESC,p.id ASC LIMIT $8`, [...values, phrase, tokens, query.limit]);
    options.signal.throwIfAborted();
    return result.rows.map(row => SourcePostSchema.parse(row.document));
  }
  async searchSemantic(query: TimelineQuery, trusted: { personId: string }, embedding: number[], modelRevision: string, options: { signal: AbortSignal; evidenceScope?: EvidenceScope }): Promise<SourcePost[]> {
    options.signal.throwIfAborted();
    const values = parameters(query, trusted);
    if (options.evidenceScope === 'caption_image') {
      const result = await this.pool.query(`WITH scoped AS MATERIALIZED (
        SELECT p.id,p.document,p.posted_at,r.document AS annotations,v.embedding FROM source_posts p
        JOIN LATERAL (SELECT revision,document FROM source_image_revisions WHERE source_id=p.id ORDER BY ordinal DESC LIMIT 1) r ON true
        JOIN source_image_vectors v ON v.source_id=p.id AND v.annotation_revision=r.revision AND v.model_revision=$6 WHERE ${scope}
        UNION ALL SELECT p.id,p.document,p.posted_at,NULL::jsonb AS annotations,v.embedding FROM source_posts p
        JOIN source_vectors v ON v.source_id=p.id AND v.model_revision=$6 WHERE ${scope}
        AND NOT EXISTS(SELECT 1 FROM source_image_revisions r WHERE r.source_id=p.id)
      ) SELECT document,annotations FROM scoped ORDER BY embedding <=> $7::vector,posted_at DESC,id ASC LIMIT $8`,
      [...values, modelRevision, checkedVector(embedding), query.limit]);
      options.signal.throwIfAborted();
      return result.rows.map(row => SourcePostSchema.parse({ ...row.document, ...(row.annotations ? { imageAnnotations: row.annotations } : {}) }));
    }
    const result = await this.pool.query(`WITH scoped AS MATERIALIZED (
      SELECT p.id,p.document,p.posted_at,v.embedding FROM source_posts p
      JOIN source_vectors v ON v.source_id=p.id AND v.model_revision=$6 WHERE ${scope}
    ) SELECT document FROM scoped ORDER BY embedding <=> $7::vector,posted_at DESC,id ASC LIMIT $8`,
    [...values, modelRevision, checkedVector(embedding), query.limit]);
    options.signal.throwIfAborted();
    return result.rows.map(row => SourcePostSchema.parse(row.document));
  }
}
export class PostgresLexicalRetrieval implements Retrieval {
  constructor(private readonly sources: PostgresSourceRepository) {}
  search(query: TimelineQuery, trusted: { personId: string }, options: { signal: AbortSignal; evidenceScope?: EvidenceScope }): Promise<SourcePost[]> {
    return this.sources.searchLexical(query, trusted, options);
  }
}
export class PostgresSemanticRetrieval implements Retrieval {
  constructor(private readonly sources: PostgresSourceRepository, private readonly embed: QueryEmbedder, private readonly modelRevision: string) {}
  async search(query: TimelineQuery, trusted: { personId: string }, options: { signal: AbortSignal; evidenceScope?: EvidenceScope }): Promise<SourcePost[]> {
    parameters(query, trusted); // reject invalid scope before any embedding/provider call
    options.signal.throwIfAborted();
    const embedding = await this.embed(query.query ?? '', options);
    return this.sources.searchSemantic(query, trusted, embedding, this.modelRevision, options);
  }
}
/** One adapter shared by HTTP and evaluation harness; off mode never reaches this port. */
export class PostgresRetrieval implements Retrieval {
  constructor(private readonly sources: PostgresSourceRepository,
    private readonly semantic?: { embed: QueryEmbedder; modelRevision: string }) {}
  async search(query: TimelineQuery, trusted: { personId: string }, options: { signal: AbortSignal; mode: 'lexical' | 'semantic'; evidenceScope?: EvidenceScope }): Promise<SourcePost[]> {
    parameters(query, trusted);
    options.signal.throwIfAborted();
    if (options.mode === 'lexical') return this.sources.searchLexical(query, trusted, options);
    if (!this.semantic) throw new CoreError('INVALID_INPUT', 'Semantic retrieval is not configured');
    const embedding = await this.semantic.embed(query.query ?? '', options);
    return this.sources.searchSemantic(query, trusted, embedding, this.semantic.modelRevision, options);
  }
}
