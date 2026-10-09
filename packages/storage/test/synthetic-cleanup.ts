import type { Pool } from 'pg';

/**
 * Integration suites share their database with the next run, and recovery sweeps are database-wide: queued or generating
 * turns left behind would be picked up later. Each suite removes the conversation rows of its own synthetic scope(s)
 * (sessions.person_id); outbox and lease rows go with their turns. Personas and source posts are immutable by design.
 */
const SYNTHETIC_SCOPE = /^synthetic-(?:[a-z]+-)*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Deletes only on the synthetic load-test database and only for `synthetic-…-<uuid>` scopes: it must never touch research data. */
export async function removeSyntheticConversations(pool: Pool, personIds: string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const database = (await client.query('SELECT current_database() AS db')).rows[0]?.db;
    if (database !== 'ptr_loadtest') throw new Error('Synthetic cleanup runs only on ptr_loadtest');
    if (personIds.length === 0 || !personIds.every(id => SYNTHETIC_SCOPE.test(id))) throw new Error('Synthetic cleanup needs a non-empty list of synthetic-<uuid> scopes');
    const owned = 'SELECT id FROM sessions WHERE person_id=ANY($1::text[])';
    await client.query(`DELETE FROM messages WHERE session_id IN (${owned})`, [personIds]);
    await client.query(`DELETE FROM turns WHERE session_id IN (${owned})`, [personIds]);
    await client.query('DELETE FROM sessions WHERE person_id=ANY($1::text[])', [personIds]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
