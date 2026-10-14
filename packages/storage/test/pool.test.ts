import type { Pool } from 'pg';
import { createLocalPool } from '../src/pool';

describe('Postgres pool error handling', () => {
  const databaseUrl = 'postgresql://ptr_researcher:synthetic-password@127.0.0.1:56432/ptr_research';

  afterEach(() => jest.restoreAllMocks());

  it('keeps idle client errors handled and logs only a fixed code', async () => {
    const pool = createLocalPool(databaseUrl);
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = Object.assign(new Error('private connection string and host details'), { code: '57P01' });

    try {
      expect(() => pool.emit('error', error)).not.toThrow();
    } finally {
      await pool.end();
    }

    expect(log).toHaveBeenCalledWith('POSTGRES_POOL_ERROR', { code: '57P01' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(error.message);
  });

  it('redacts non-SQLSTATE error codes from idle client errors', async () => {
    const pool = createLocalPool(databaseUrl) as Pool;
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = Object.assign(new Error('private details'), { code: 'postgresql://secret@127.0.0.1/db' });

    try {
      expect(() => pool.emit('error', error)).not.toThrow();
    } finally {
      await pool.end();
    }

    expect(log).toHaveBeenCalledWith('POSTGRES_POOL_ERROR', { code: 'UNKNOWN' });
    expect(JSON.stringify(log.mock.calls)).not.toContain(error.code);
  });
});
