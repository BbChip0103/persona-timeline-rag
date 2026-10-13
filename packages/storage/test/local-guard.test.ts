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
  describe('cluster mode allowlist',()=>{
    const clusterEnv={PTR_NETWORK_MODE:'cluster',KUBERNETES_SERVICE_HOST:'10.0.0.1',PTR_CLUSTER_DATABASE_URL_ALLOWLIST:'postgresql://postgres.example.internal:5432',PTR_CLUSTER_DATABASE_IDENTITIES:'ptr_split_research:ptr_split_app'};
    const cluster='postgresql://ptr_split_app:synthetic-password@postgres.example.internal:5432/ptr_split_research?sslmode=require';
    it('accepts the configured cluster host, identity, and sslmode only inside Kubernetes cluster mode',()=>{
      expect(assertLocalDatabaseUrl(cluster,clusterEnv)).toBe(cluster);
      expect(()=>assertLocalDatabaseUrl(cluster,{...clusterEnv,KUBERNETES_SERVICE_HOST:''})).toThrow();
      expect(()=>assertLocalDatabaseUrl(cluster,{...clusterEnv,PTR_NETWORK_MODE:'local'})).toThrow();
    });
    it.each([
      ['unlisted host',cluster.replace('postgres.example.internal','postgres.other.internal')],
      ['unlisted database',cluster.replace('/ptr_split_research','/ptr_research')],
      ['unlisted user',cluster.replace('ptr_split_app:','ptr_split_llm:')],
      ['missing sslmode',cluster.replace('?sslmode=require','')],
      ['unexpected query',cluster.replace('sslmode=require','sslmode=require&connect_timeout=3')],
      ['duplicate sslmode',cluster.replace('sslmode=require','sslmode=require&sslmode=disable')],
    ])('rejects cluster %s',(_label,raw)=>expect(()=>assertLocalDatabaseUrl(raw,clusterEnv)).toThrow());
    it('allows service DNS without sslmode, but requires it for off-cluster hosts',()=>{
      const plain=cluster.replace('?sslmode=require','');
      expect(()=>assertLocalDatabaseUrl(plain,clusterEnv)).toThrow();
      const service='postgresql://ptr_split_app:synthetic-password@postgres.ptr-data.svc:5432/ptr_split_research';
      expect(assertLocalDatabaseUrl(service,{...clusterEnv,PTR_CLUSTER_DATABASE_URL_ALLOWLIST:'postgresql://postgres.ptr-data.svc:5432'})).toBe(service);
      expect(()=>assertLocalDatabaseUrl(`${service}?sslmode=disable`,{...clusterEnv,PTR_CLUSTER_DATABASE_URL_ALLOWLIST:'postgresql://postgres.ptr-data.svc:5432'})).toThrow();
    });
    it('uses a cluster-specific rejection message',()=>{
      expect(()=>assertLocalDatabaseUrl(cluster.replace('postgres.example.internal','other.example.internal'),clusterEnv)).toThrow('Database target must match the cluster database allowlist and transport policy');
    });
  });
});
