import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createLocalPool, isIsolatedDatabaseIdentity } from '../packages/storage/src/index.js';

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? process.env.PTR_DATABASE_URL;
  if (!url) throw new Error('Private local DATABASE_URL is required');
  const pool = createLocalPool(url);
  try {
    const identity = await pool.query('SELECT current_database() AS db,current_user AS username');
    if (!isIsolatedDatabaseIdentity(identity.rows[0]?.db, identity.rows[0]?.username))
      throw new Error('Connected server identity is not an isolated project database');
    const directory = resolve('supabase/migrations');
    for (const name of (await readdir(directory)).filter(name => /^\d+.*\.sql$/.test(name)).sort()) {
      const registered = await pool.query("SELECT to_regclass('public.ptr_schema_migrations') AS registry");
      if (registered.rows[0]?.registry) {
        const applied = await pool.query('SELECT name FROM ptr_schema_migrations WHERE name=$1', [name]);
        if (applied.rowCount) continue;
      }
      await pool.query(await readFile(resolve(directory, name), 'utf8'));
      console.log(`Applied local migration ${name}`);
    }
  } finally { await pool.end(); }
}
void main().catch(() => { console.error('Private local database migration failed.'); process.exitCode = 1; });
