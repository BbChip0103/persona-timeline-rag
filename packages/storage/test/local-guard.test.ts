import { assertLocalDatabaseUrl } from '../src/local-guard.js';

describe('local database isolation guard', () => {
  const valid = 'postgresql://ptr_researcher:synthetic-password@127.0.0.1:56432/ptr_research';
  it('accepts only the dedicated loopback database', () => expect(assertLocalDatabaseUrl(valid)).toBe(valid));
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
