import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { SourcePostSchema, TimelineQuerySchema, type SourcePost, type TimelineQuery } from '@ptr/contracts';
import { CoreError, type Retrieval } from '@ptr/core';
import { transaction } from './pool.js';

export type SourceOrigin = 'licensed_source' | 'synthetic_fixture';
export type QueryEmbedder = (text: string, options: { signal: AbortSignal }) => Promise<number[]>;
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
    const posts = inputs.map(input => SourcePostSchema.parse(input));
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
  async searchLexical(query: TimelineQuery, trusted: { personId: string }, options: { signal: AbortSignal }): Promise<SourcePost[]> {
    options.signal.throwIfAborted();
    const values = parameters(query, trusted);
    const phrase = query.query?.toLocaleLowerCase().normalize('NFC') ?? '';
    const tokens = [...new Set(phrase.match(/[\p{L}\p{N}]+/gu) ?? [])];
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
  async searchSemantic(query: TimelineQuery, trusted: { personId: string }, embedding: number[], modelRevision: string, options: { signal: AbortSignal }): Promise<SourcePost[]> {
    options.signal.throwIfAborted();
    const values = parameters(query, trusted);
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
  search(query: TimelineQuery, trusted: { personId: string }, options: { signal: AbortSignal }): Promise<SourcePost[]> {
    return this.sources.searchLexical(query, trusted, options);
  }
}
export class PostgresSemanticRetrieval implements Retrieval {
  constructor(private readonly sources: PostgresSourceRepository, private readonly embed: QueryEmbedder, private readonly modelRevision: string) {}
  async search(query: TimelineQuery, trusted: { personId: string }, options: { signal: AbortSignal }): Promise<SourcePost[]> {
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
  async search(query: TimelineQuery, trusted: { personId: string }, options: { signal: AbortSignal; mode: 'lexical' | 'semantic' }): Promise<SourcePost[]> {
    parameters(query, trusted);
    options.signal.throwIfAborted();
    if (options.mode === 'lexical') return this.sources.searchLexical(query, trusted, options);
    if (!this.semantic) throw new CoreError('INVALID_INPUT', 'Semantic retrieval is not configured');
    const embedding = await this.semantic.embed(query.query ?? '', options);
    return this.sources.searchSemantic(query, trusted, embedding, this.semantic.modelRevision, options);
  }
}
