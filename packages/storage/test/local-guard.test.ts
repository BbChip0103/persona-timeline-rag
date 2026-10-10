import { assertLocalDatabaseUrl } from '../src/local-guard.js';

describe('local database isolation guard', () => {
  const valid = 'postgresql://ptr_researcher:synthetic-password@127.0.0.1:56432/ptr_research';
  const loadtest = 'postgresql://ptr_loadtester:synthetic-password@127.0.0.1:56432/ptr_loadtest';
  it('accepts only the dedicated loopback database', () => expect(assertLocalDatabaseUrl(valid)).toBe(valid));
  it('accepts the separate synthetic load-test database with its own role', () => expect(assertLocalDatabaseUrl(loadtest)).toBe(loadtest));
  it('accepts only exact split role/database/58432 pairs',()=>{const split='postgresql://ptr_split_app:synthetic-password@127.0.0.1:58432/ptr_split_test';expect(assertLocalDatabaseUrl(split)).toBe(split);expect(()=>assertLocalDatabaseUrl(split.replace('58432','56432'))).toThrow();expect(()=>assertLocalDatabaseUrl(split.replace('ptr_split_app:','ptr_researcher:'))).toThrow();});
  it.each([
    loadtest.replace('ptr_loadtester:', 'ptr_researcher:'),
    valid.replace('ptr_researcher:', 'ptr_loadtester:'),
    loadtest.replace('56432', '54322'),
  ])('rejects mixed or relocated load-test identities', raw => expect(() => assertLocalDatabaseUrl(raw)).toThrow());
  it.each([
    valid.replace('127.0.0.1', 'example-shared-db.internal'),
    valid.replace('127.0.0.1', 'localhost'),
    valid.replace('56432', '54322'),
    valid.replace('/ptr_research', '/other-project'),
    valid.replace('/ptr_research', '/other-project-db'),
    valid.replace('ptr_researcher:', 'postgres:'),
    valid + '?host=example-shared-db.internal',
    valid.replace('synthetic-password', ''),
    'not-a-url',
  ])('rejects an unsafe target without connecting', raw => expect(() => assertLocalDatabaseUrl(raw)).toThrow());
});
