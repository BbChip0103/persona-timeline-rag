import { Pool, type PoolClient } from 'pg';
import { assertLocalDatabaseUrl } from './local-guard.js';

export function createLocalPool(databaseUrl: string, options: { max?: number; schema?: 'app' | 'llm' } = {}): Pool {
  const max = options.max ?? 8;
  if (!Number.isInteger(max) || max < 1 || max > 200) throw new Error('Invalid pool size');
  return new Pool({ connectionString: assertLocalDatabaseUrl(databaseUrl), max, connectionTimeoutMillis: 3000, ...(options.schema ? {options:`-c search_path=${options.schema},public`} : {}) });
}
export async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
