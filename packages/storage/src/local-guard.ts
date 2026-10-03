/** No connection is opened until the entire private local target is validated. */
export function assertLocalDatabaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid local database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || url.hostname !== '127.0.0.1'
    || url.port !== '56432'
    || url.pathname !== '/ptr_research'
    || decodeURIComponent(url.username) !== 'ptr_researcher'
    || !url.password
    || url.search || url.hash) {
    throw new Error('Database target must be the isolated ptr_goal1 loopback database');
  }
  return raw;
}
