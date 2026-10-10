import { assertPreparationDatabaseUrl } from './prepare-research';

test.each(['ptr_split_test', 'ptr_split_research'])('legacy preparation refuses split before reading private inputs (%s)', database => {
  expect(() => assertPreparationDatabaseUrl({ DATABASE_URL: `postgresql://ptr_split_owner:synthetic@127.0.0.1:58432/${database}` })).toThrow('SPLIT_RUNTIME_PREPARATION_NOT_MIGRATED');
});
test('legacy preparation retains validated historical synthetic target', () => {
  const url = 'postgresql://ptr_loadtester:synthetic@127.0.0.1:56432/ptr_loadtest';
  expect(assertPreparationDatabaseUrl({ DATABASE_URL: url })).toBe(url);
});
