import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { removeSyntheticConversations } from './synthetic-cleanup';

/** A pool whose client records its statements; no database is needed. */
function fakePool(database: string) {
  const statements: string[] = [];
  const client = {
    query: jest.fn(async (text: string) => { statements.push(text); return text.includes('current_database') ? { rows: [{ db: database }] } : { rows: [], rowCount: 0 }; }),
    release: jest.fn(),
  };
  return { pool: { connect: async () => client } as unknown as Pool, statements, client };
}
const deletes = (statements: string[]) => statements.filter(text => /DELETE/i.test(text));

describe('removeSyntheticConversations guards', () => {
  it('refuses any database other than ptr_loadtest before deleting', async () => {
    for (const database of ['ptr_research', 'postgres']) {
      const { pool, statements, client } = fakePool(database);
      await expect(removeSyntheticConversations(pool, [`synthetic-queue-${randomUUID()}`])).rejects.toThrow(/ptr_loadtest/);
      expect(deletes(statements)).toEqual([]); expect(statements).toContain('ROLLBACK'); expect(client.release).toHaveBeenCalled();
    }
  });
  it('refuses an empty list and ids outside the synthetic scope pattern before deleting', async () => {
    for (const ids of [[], ['persona-real'], ['synthetic-'], ['synthetic-queue-not-a-uuid'], [`synthetic-queue-${randomUUID()}`, 'loadtest-person-1'], [`x-synthetic-queue-${randomUUID()}`]]) {
      const { pool, statements } = fakePool('ptr_loadtest');
      await expect(removeSyntheticConversations(pool, ids)).rejects.toThrow(/synthetic/i);
      expect(deletes(statements)).toEqual([]);
    }
  });
  it('deletes for a ptr_loadtest database and well-formed scopes', async () => {
    const { pool, statements } = fakePool('ptr_loadtest');
    await removeSyntheticConversations(pool, [`synthetic-${randomUUID()}`, `synthetic-agent-state-${randomUUID()}`]);
    expect(deletes(statements)).toHaveLength(3); expect(statements).toContain('COMMIT');
  });
});
