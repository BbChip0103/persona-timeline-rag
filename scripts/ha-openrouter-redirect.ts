/**
 * Test-only preload for scripts/gateway-ha-acceptance.ts scenario D (`node --import tsx --import ./scripts/ha-openrouter-redirect.ts
 * apps/gateway/src/main.ts`): every fetch to https://openrouter.ai/ goes to the harness's fake OpenRouter on loopback
 * (PTR_TEST_OPENROUTER_REDIRECT=http://127.0.0.1:<port>), so the real gateway composition (OpenRouterClient + Postgres
 * ledger + pool) runs without a single external call. The harness also passes a synthetic API key, so even a missing
 * redirect could not be billed. Refuses to load without a loopback target.
 */
const target=process.env.PTR_TEST_OPENROUTER_REDIRECT??'';
if(!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(target)) throw new Error('PTR_TEST_OPENROUTER_REDIRECT must be http://127.0.0.1:<port>');
const original=globalThis.fetch;
const PREFIX='https://openrouter.ai/';
globalThis.fetch=((input:string|URL|Request,init?:RequestInit)=>{
  const url=typeof input==='string'?input:input instanceof URL?input.href:input.url;
  if(url.startsWith(PREFIX)) {
    const redirected=`${target}/${url.slice(PREFIX.length)}`;
    // A Request keeps its method, headers and body (and signal) on the new URL; init, if any, still overrides them.
    return original(input instanceof Request?new Request(redirected,input):redirected,init);
  }
  if(!/^http:\/\/127\.0\.0\.1[:/]/.test(url)) return Promise.reject(new TypeError('external fetch blocked in the HA acceptance gateway'));
  return original(input,init);
}) as typeof fetch;
