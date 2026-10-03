import { Pool, type PoolClient } from 'pg';
import { assertLocalDatabaseUrl } from './local-guard.js';

export function createLocalPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: assertLocalDatabaseUrl(databaseUrl), max: 8, connectionTimeoutMillis: 3000 });
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
