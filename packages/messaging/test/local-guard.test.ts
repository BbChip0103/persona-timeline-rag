import { assertLocalRedisUrl } from '../src/local-guard';

describe('assertLocalRedisUrl', () => {
  it('accepts only the isolated loopback Redis with a password', () => {
    expect(assertLocalRedisUrl('redis://:s3cret@127.0.0.1:56479/0')).toBe('redis://:s3cret@127.0.0.1:56479/0');
  });
  it('accepts the independently owned split proof Redis only on its exact guarded port',()=>{expect(assertLocalRedisUrl('redis://:synthetic-password@127.0.0.1:58479/0')).toContain(':58479/0');expect(()=>assertLocalRedisUrl('redis://:synthetic-password@127.0.0.1:58478/0')).toThrow();});
  it('allows only a named disposable immersion Redis port with a password',()=>{
    const url='redis://:synthetic-password@127.0.0.1:54321/0';
    const env={PTR_IMMERSION_GATE_PROJECT:'ptr-immersion-0123456789',PTR_IMMERSION_GATE_REDIS_PORT:'54321'};
    expect(assertLocalRedisUrl(url,env)).toBe(url);
    expect(()=>assertLocalRedisUrl(url,{...env,PTR_IMMERSION_GATE_PROJECT:''})).toThrow();
    expect(()=>assertLocalRedisUrl(url.replace('synthetic-password@',''),env)).toThrow();
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
  describe('cluster mode allowlist',()=>{
    const clusterEnv={PTR_NETWORK_MODE:'cluster',KUBERNETES_SERVICE_HOST:'10.0.0.1',PTR_CLUSTER_REDIS_URL_ALLOWLIST:'rediss://redis.example.internal:6380'};
    const cluster='rediss://:s3cret@redis.example.internal:6380/0';
    it('accepts a configured rediss target only inside Kubernetes cluster mode',()=>{
      expect(assertLocalRedisUrl(cluster,clusterEnv)).toBe(cluster);
      expect(()=>assertLocalRedisUrl(cluster,{...clusterEnv,KUBERNETES_SERVICE_HOST:''})).toThrow();
      expect(()=>assertLocalRedisUrl(cluster,{...clusterEnv,PTR_NETWORK_MODE:'local'})).toThrow();
    });
    it.each([
      ['unlisted host',cluster.replace('redis.example.internal','redis.other.internal')],
      ['unlisted scheme',cluster.replace('rediss://','redis://')],
      ['default Redis port',cluster.replace('6380','6379')],
      ['query string',`${cluster}?family=6`],
      ['no password','rediss://redis.example.internal:6380/0'],
    ])('rejects cluster %s',(_label,url)=>expect(()=>assertLocalRedisUrl(url,clusterEnv)).toThrow('Redis target must match the cluster Redis allowlist and transport policy'));
    it('allows an ACL username when the allowlist key carries the same username without a password',()=>{
      const acl='rediss://ptr:synthetic-password@redis.example.internal:6380/0';
      expect(assertLocalRedisUrl(acl,{...clusterEnv,PTR_CLUSTER_REDIS_URL_ALLOWLIST:'rediss://ptr@redis.example.internal:6380'})).toBe(acl);
      expect(()=>assertLocalRedisUrl(acl,clusterEnv)).toThrow();
      expect(()=>assertLocalRedisUrl(acl,{...clusterEnv,PTR_CLUSTER_REDIS_URL_ALLOWLIST:'rediss://other@redis.example.internal:6380'})).toThrow();
      expect(()=>assertLocalRedisUrl(acl,{...clusterEnv,PTR_CLUSTER_REDIS_URL_ALLOWLIST:'rediss://ptr:synthetic-password@redis.example.internal:6380'})).toThrow();
    });
    it('requires TLS for off-cluster Redis but permits service DNS without TLS',()=>{
      const plain='redis://:synthetic-password@redis.example.internal:6380/0';
      expect(()=>assertLocalRedisUrl(plain,{...clusterEnv,PTR_CLUSTER_REDIS_URL_ALLOWLIST:'redis://redis.example.internal:6380'})).toThrow();
      const service='redis://ptr:synthetic-password@redis.ptr-data.svc:6379/0';
      expect(assertLocalRedisUrl(service,{...clusterEnv,PTR_CLUSTER_REDIS_URL_ALLOWLIST:'redis://ptr@redis.ptr-data.svc:6379'})).toBe(service);
    });
  });
});
