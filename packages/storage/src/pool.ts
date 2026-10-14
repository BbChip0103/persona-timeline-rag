import { Pool, type PoolClient } from 'pg';
import { assertLocalDatabaseUrl } from './local-guard.js';

function sqlState(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'UNKNOWN';
}

export function createLocalPool(databaseUrl: string, options: { max?: number; schema?: 'app' | 'llm' } = {}): Pool {
  const max = options.max ?? 8;
  if (!Number.isInteger(max) || max < 1 || max > 200) throw new Error('Invalid pool size');
  const pool = new Pool({ connectionString: assertLocalDatabaseUrl(databaseUrl), max, connectionTimeoutMillis: 3000, ...(options.schema ? {options:`-c search_path=${options.schema},public`} : {}) });
  pool.on('error', error => {
    console.error('POSTGRES_POOL_ERROR', { code: sqlState(error) });
  });
  return pool;
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
