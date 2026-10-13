/** Exact database/role pairs on the isolated container: research data, and synthetic-only load tests. */
export const ISOLATED_DATABASES: ReadonlyArray<{ database: string; user: string }> = [
  { database: 'ptr_research', user: 'ptr_researcher' },
  { database: 'ptr_loadtest', user: 'ptr_loadtester' },
  { database: 'ptr_framework_test', user: 'ptr_framework_tester' },
  ...['ptr_split_test','ptr_split_research'].flatMap(database => ['ptr_split_app','ptr_split_llm','ptr_split_owner'].map(user => ({database,user}))),
];
export function isIsolatedDatabaseIdentity(database: unknown, user: unknown): boolean {
  return ISOLATED_DATABASES.some(pair => pair.database === database && pair.user === user);
}
type GuardEnv = Record<string,string|undefined>;
const isClusterMode=(env:GuardEnv)=>env.PTR_NETWORK_MODE==='cluster'&&!!env.KUBERNETES_SERVICE_HOST;
const list=(raw:string|undefined)=>raw?.split(',').map(value=>value.trim()).filter(Boolean)??[];
const hasClusterDatabaseTarget=(url:URL,env:GuardEnv)=>list(env.PTR_CLUSTER_DATABASE_URL_ALLOWLIST).some(raw=>{
  let allowed:URL;try{allowed=new URL(raw);}catch{return false;}
  return ['postgres:','postgresql:'].includes(allowed.protocol)&&!allowed.username&&!allowed.password&&!allowed.search&&!allowed.hash
    && ['', '/'].includes(allowed.pathname)&&!!allowed.port&&allowed.protocol===url.protocol&&allowed.hostname===url.hostname&&allowed.port===url.port;
});
const hasClusterDatabaseIdentity=(database:string,user:string,env:GuardEnv)=>list(env.PTR_CLUSTER_DATABASE_IDENTITIES).some(raw=>{
  const [allowedDatabase,allowedUser,...rest]=raw.split(':');
  return rest.length===0&&allowedDatabase===database&&allowedUser===user;
});
/** No connection is opened until the entire private local target is validated. */
export function assertLocalDatabaseUrl(raw: string, env: GuardEnv = process.env): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(isClusterMode(env)?'Database target must match the cluster database allowlist and transport policy':'Invalid local database URL'); }
  if (isClusterMode(env)) {
    const sslmode=url.searchParams.get('sslmode');
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !hasClusterDatabaseTarget(url,env)
      || !hasClusterDatabaseIdentity(url.pathname.slice(1), decodeURIComponent(url.username), env)
      || !url.password
      || (!/\.svc(?:\.cluster\.local)?$/.test(url.hostname) && !sslmode)
      || (sslmode!==null && !['require','verify-ca','verify-full'].includes(sslmode))
      || url.searchParams.size>(sslmode===null?0:1)
      || [...url.searchParams.keys()].some(key=>key!=='sslmode')
      || url.hash) {
      throw new Error('Database target must match the cluster database allowlist and transport policy');
    }
    return raw;
  }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || url.hostname !== '127.0.0.1'
    || (url.pathname.startsWith('/ptr_split_') ? url.port !== '58432' : url.pathname === '/ptr_framework_test' ? url.port !== '57432' : url.port !== '56432')
    || !isIsolatedDatabaseIdentity(url.pathname.slice(1), decodeURIComponent(url.username))
    || !url.password
    || url.search || url.hash) {
    throw new Error('Database target must be the isolated ptr_goal1 loopback database');
  }
  return raw;
}
