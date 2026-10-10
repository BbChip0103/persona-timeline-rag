import type { Pool } from 'pg';
import { retainFrameworkCheckpoints } from './framework-checkpoint-retention';
import { retainFrameworkReceipts } from './framework-receipt-retention';

function splitPool(database = 'ptr_split_test') {
  const query = jest.fn(async (sql: string) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('current_database')) return { rows: [{ db: database, username: 'ptr_split_owner' }] };
    throw new Error('LEGACY_TABLE_QUERY_REACHED');
  });
  return { query, pool: { connect: async () => ({ query, release: jest.fn() }) } as unknown as Pool };
}
test.each(['ptr_split_test', 'ptr_split_research'])('checkpoint retention refuses split before public table queries (%s)', async database => {
  const { pool, query } = splitPool(database);
  await expect(retainFrameworkCheckpoints(pool)).rejects.toThrow('SPLIT_RUNTIME_USE_PTR_LLM_RETENTION');
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT current_database() AS db,current_user AS username', 'ROLLBACK']);
});
test.each(['ptr_split_test', 'ptr_split_research'])('receipt retention refuses split before moved table queries (%s)', async database => {
  const { pool, query } = splitPool(database);
  await expect(retainFrameworkReceipts(pool)).rejects.toThrow('SPLIT_RUNTIME_USE_PTR_LLM_RETENTION');
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT current_database() AS db,current_user AS username', 'ROLLBACK']);
});
