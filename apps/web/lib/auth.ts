import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
export const COOKIE_NAME='ptr_owner';
const ORIGIN='http://127.0.0.1:56440';
function secret():string { const value=process.env.PTR_SESSION_SECRET??''; if(value.length<32) throw new Error('AUTH_UNAVAILABLE'); return value; }
export function equal(left:string,right:string):boolean { return timingSafeEqual(createHash('sha256').update(left).digest(),createHash('sha256').update(right).digest()); }
export function localHost(request:Request):boolean { return request.headers.get('host')==='127.0.0.1:56440'; }
export function sameOrigin(request:Request):boolean {
  // Next normalizes its internal Request URL hostname; validate the actual Host header.
  return localHost(request)&&request.headers.get('origin')===ORIGIN&& !['cross-site','same-site'].includes(request.headers.get('sec-fetch-site')??'');
}
function signature(payload:string):string { return createHmac('sha256',secret()).update(payload).digest('base64url'); }
export function signOwnerCookie():string {
  // Stable private single-user ownership allows history after login/session expiry.
  const owner='local-'+createHmac('sha256',secret()).update('ptr-local-research-owner-v1').digest('hex').slice(0,40);
  const payload=Buffer.from(JSON.stringify({owner,expires:Date.now()+7*24*60*60*1000})).toString('base64url');
  return `${payload}.${signature(payload)}`;
}
export function verifyOwnerCookie(raw:string|undefined):string|undefined {
  if(!raw||raw.length>1024) return;
  const [payload,supplied,...extra]=raw.split('.');
  if(!payload||!supplied||extra.length||!equal(signature(payload),supplied)) return;
  try {
    const data=JSON.parse(Buffer.from(payload,'base64url').toString('utf8')) as {owner?:unknown;expires?:unknown};
    if(typeof data.owner==='string'&&/^local-[a-f0-9]{40}$/.test(data.owner)&&typeof data.expires==='number'&&Number.isFinite(data.expires)&&data.expires>Date.now()&&data.expires<=Date.now()+7*24*60*60*1000) return data.owner;
  } catch { /* Invalid cookie is unauthenticated. */ }
}
export async function signedOwner():Promise<string|undefined> {
  try { return verifyOwnerCookie((await cookies()).get(COOKIE_NAME)?.value); } catch { return; }
}
