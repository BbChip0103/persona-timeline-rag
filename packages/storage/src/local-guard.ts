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
/** No connection is opened until the entire private local target is validated. */
export function assertLocalDatabaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid local database URL'); }
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
