import { createLocalPool } from '@ptr/storage';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { setupFrameworkCheckpoints } from './framework-checkpoints';

jest.mock('@ptr/storage', () => ({ ...jest.requireActual('@ptr/storage'), createLocalPool: jest.fn() }));
jest.mock('@langchain/langgraph-checkpoint-postgres', () => ({ PostgresSaver: jest.fn() }));

test.each(['ptr_split_test', 'ptr_split_research'])('TS saver setup refuses split before DDL (%s)', async database => {
  const query = jest.fn(async () => ({ rows: [{ db: database, username: 'ptr_split_owner' }] }));
  const end = jest.fn();
  (createLocalPool as jest.Mock).mockReturnValue({ query, end });
  await expect(setupFrameworkCheckpoints('synthetic-no-connection')).rejects.toThrow('SPLIT_RUNTIME_USE_PTR_LLM_CHECKPOINT_SETUP');
  expect(query).toHaveBeenCalledTimes(1);
  expect(PostgresSaver).not.toHaveBeenCalled();
  expect(end).toHaveBeenCalledTimes(1);
});
