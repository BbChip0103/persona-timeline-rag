/** Goal2 Redis is the dedicated `ptr_goal2_redis` container on loopback only (infra/compose.redis.yml). */
export function assertLocalRedisUrl(raw: string): string {
  let url: URL | undefined;
  try { url = new URL(raw); } catch { url = undefined; }
  if (!url || url.protocol !== 'redis:' || url.hostname !== '127.0.0.1' || !['56479','57479'].includes(url.port)
    || !url.password || !/^\/(?:[0-9]|1[0-5])$/.test(url.pathname) || url.search || url.hash) {
    // Never include the URL: it carries the password.
    throw new Error('Redis target must be the isolated ptr_goal2 loopback Redis');
  }
  return raw;
}
