import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { PersonaSchema, type Persona } from '@ptr/contracts';
import { CoreError, type PersonaRepository } from '@ptr/core';
import { transaction } from './pool.js';

export class PostgresPersonaRepository implements PersonaRepository {
  constructor(private readonly pool: Pool) {}
  async get(id: string, revision?: string): Promise<Persona | undefined> {
    const result = await this.pool.query(`SELECT v.document FROM personas p JOIN persona_versions v
      ON v.persona_id=p.id AND v.revision=COALESCE($2,p.current_revision) WHERE p.id=$1`, [id, revision ?? null]);
    return result.rows[0] ? PersonaSchema.parse(result.rows[0].document) : undefined;
  }
  /**
   * Same revision + same content is idempotent; revision content cannot be replaced. A first-seen revision becomes
   * current; an existing one moves the pointer only with `setCurrent` when the persona publish CLI explicitly sets it.
   */
  async importPersona(input: Persona, options: { setCurrent?: boolean } = {}): Promise<{ inserted: boolean; previousRevision: string | null }> {
    const persona = PersonaSchema.parse(input);
    return transaction(this.pool, client => importOn(client, persona, options));
  }
  /** Several personas in one transaction on one client (the publish CLI): all are imported, or none. */
  async importPersonas(inputs: Persona[], options: { setCurrent?: boolean } = {}): Promise<{ inserted: boolean; previousRevision: string | null }[]> {
    const personas = inputs.map(input => PersonaSchema.parse(input));
    return transaction(this.pool, async client => {
      const results: { inserted: boolean; previousRevision: string | null }[] = [];
      for (const persona of personas) results.push(await importOn(client, persona, options));
      return results;
    });
  }
  /**
   * Publish `--baseline` check (persona CLI), per entry: the baseline is stored for that persona id and person exactly as
   * given (jsonb equality), and the persona's current revision is the baseline (before the publish) or the draft's
   * computed revision (a rerun after the import committed but the list/log step failed).
   */
  async verifyBaselines(entries: { baseline: Persona; draftRevision: string }[]): Promise<boolean[]> {
    const results: boolean[] = [];
    for (const entry of entries) {
      const baseline = PersonaSchema.parse(entry.baseline);
      const found = await this.pool.query(`SELECT p.person_id, p.current_revision, EXISTS(SELECT 1 FROM persona_versions v
        WHERE v.persona_id=p.id AND v.revision=$2 AND v.document=$3::jsonb) AS stored FROM personas p WHERE p.id=$1`, [baseline.id, baseline.revision, JSON.stringify(baseline)]);
      const row = found.rows[0] as { person_id: string; current_revision: string; stored: boolean } | undefined;
      results.push(!!row && row.person_id === baseline.personId && row.stored && (row.current_revision === baseline.revision || row.current_revision === entry.draftRevision));
    }
    return results;
  }
  /**
   * Rollback (persona CLI `restore`), one transaction: each revision must already be stored for this persona and person
   * with exactly this document (jsonb equality); then it becomes current. Nothing is inserted.
   */
  async restoreRevisions(inputs: Persona[]): Promise<{ previousRevision: string | null }[]> {
    const personas = inputs.map(input => PersonaSchema.parse(input));
    return transaction(this.pool, async client => {
      const results: { previousRevision: string | null }[] = [];
      for (const persona of personas) {
        const before = await client.query('SELECT current_revision, person_id FROM personas WHERE id=$1 FOR UPDATE', [persona.id]);
        if (before.rows[0]?.person_id !== persona.personId) throw new CoreError('NOT_FOUND', 'Persona is not stored for this person');
        const stored = await client.query('SELECT 1 FROM persona_versions WHERE persona_id=$1 AND revision=$2 AND document=$3::jsonb', [persona.id, persona.revision, JSON.stringify(persona)]);
        if (!stored.rowCount) throw new CoreError('NOT_FOUND', 'Revision is not stored with this content');
        await client.query('UPDATE personas SET current_revision=$2 WHERE id=$1', [persona.id, persona.revision]);
        results.push({ previousRevision: before.rows[0].current_revision });
      }
      return results;
    });
  }
}
async function importOn(client: PoolClient, persona: Persona, options: { setCurrent?: boolean }): Promise<{ inserted: boolean; previousRevision: string | null }> {
  const hash = createHash('sha256').update(JSON.stringify(persona)).digest('hex');
  const before = await client.query('SELECT current_revision FROM personas WHERE id=$1 FOR UPDATE', [persona.id]);
  await client.query('INSERT INTO personas(id,person_id,current_revision) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [persona.id, persona.personId, persona.revision]);
  const binding = await client.query('SELECT person_id FROM personas WHERE id=$1 FOR UPDATE', [persona.id]);
  if (binding.rows[0]?.person_id !== persona.personId) throw new CoreError('IDEMPOTENCY_CONFLICT', 'Persona identity cannot switch person');
  const existing = await client.query('SELECT content_hash FROM persona_versions WHERE persona_id=$1 AND revision=$2', [persona.id, persona.revision]);
  if (existing.rowCount && existing.rows[0].content_hash !== hash)
    throw new CoreError('IDEMPOTENCY_CONFLICT', 'Persona revision is immutable');
  if (!existing.rowCount)
    await client.query('INSERT INTO persona_versions(persona_id,revision,document,content_hash) VALUES($1,$2,$3,$4)', [persona.id, persona.revision, persona, hash]);
  if (!existing.rowCount || options.setCurrent)
    await client.query('UPDATE personas SET current_revision=$2 WHERE id=$1', [persona.id, persona.revision]);
  return { inserted: !existing.rowCount, previousRevision: before.rows[0]?.current_revision ?? null };
}
