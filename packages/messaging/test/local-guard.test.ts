import { assertLocalRedisUrl } from '../src/local-guard';

describe('assertLocalRedisUrl', () => {
  it('accepts only the isolated loopback Redis with a password', () => {
    expect(assertLocalRedisUrl('redis://:s3cret@127.0.0.1:56479/0')).toBe('redis://:s3cret@127.0.0.1:56479/0');
  });
  it.each([
    ['other host', 'redis://:s3cret@10.0.0.5:56479/0'],
    ['localhost name', 'redis://:s3cret@localhost:56479/0'],
    ['default port', 'redis://:s3cret@127.0.0.1:6379/0'],
    ['no password', 'redis://127.0.0.1:56479/0'],
    ['tls scheme', 'rediss://:s3cret@127.0.0.1:56479/0'],
    ['non-numeric db', 'redis://:s3cret@127.0.0.1:56479/x'],
    ['query string', 'redis://:s3cret@127.0.0.1:56479/0?family=6'],
    ['garbage', 'not a url'],
  ])('rejects %s', (_label, url) => {
    expect(() => assertLocalRedisUrl(url)).toThrow('Redis target must be the isolated ptr_goal2 loopback Redis');
  });
  it('never echoes the URL (it carries the password) in the error', () => {
    expect(() => assertLocalRedisUrl('redis://:leakme@10.0.0.5:56479/0')).toThrow(expect.objectContaining({ message: expect.not.stringContaining('leakme') }));
  });
});
