/** Goal2 Redis is the dedicated `ptr_goal2_redis` container on loopback only (infra/compose.redis.yml). */
type GuardEnv = Record<string,string|undefined>;
const isClusterMode=(env:GuardEnv)=>env.PTR_NETWORK_MODE==='cluster'&&!!env.KUBERNETES_SERVICE_HOST;
const list=(raw:string|undefined)=>raw?.split(',').map(value=>value.trim()).filter(Boolean)??[];
const immersionGateRedis=(url:URL,env:GuardEnv)=>env.PTR_IMMERSION_GATE_PROJECT?.match(/^ptr-immersion-[0-9a-f]{10}$/)
  && url.port!==''&&url.port!=='58479'&&url.port===env.PTR_IMMERSION_GATE_REDIS_PORT;
const hasClusterRedisTarget=(url:URL,env:GuardEnv)=>list(env.PTR_CLUSTER_REDIS_URL_ALLOWLIST).some(raw=>{
  let allowed:URL;try{allowed=new URL(raw);}catch{return false;}
  return ['redis:','rediss:'].includes(allowed.protocol)&&!allowed.password&&!allowed.search&&!allowed.hash
    && ['', '/'].includes(allowed.pathname)&&!!allowed.port&&allowed.protocol===url.protocol&&allowed.username===url.username&&allowed.hostname===url.hostname&&allowed.port===url.port;
});
export function assertLocalRedisUrl(raw: string, env: GuardEnv = process.env): string {
  let url: URL | undefined;
  try { url = new URL(raw); } catch { url = undefined; }
  if (isClusterMode(env)) {
    if (!url || !hasClusterRedisTarget(url,env) || !url.password || !/^\/(?:[0-9]|1[0-5])$/.test(url.pathname) || url.search || url.hash
      || url.protocol==='redis:' && !/\.svc(?:\.cluster\.local)?$/.test(url.hostname)) {
      // Never include the URL: it carries the password.
      throw new Error('Redis target must match the cluster Redis allowlist and transport policy');
    }
    return raw;
  }
  if (!url || url.protocol !== 'redis:' || url.hostname !== '127.0.0.1' || !['56479','57479','58479'].includes(url.port)&&!immersionGateRedis(url,env)
    || !url.password || !/^\/(?:[0-9]|1[0-5])$/.test(url.pathname) || url.search || url.hash) {
    // Never include the URL: it carries the password.
    throw new Error('Redis target must be the isolated ptr_goal2 loopback Redis');
  }
  return raw;
}
