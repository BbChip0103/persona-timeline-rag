import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { getIronSession, type SessionOptions } from 'iron-session';
export const COOKIE_NAME='ptr_owner';
const SESSION_SECONDS=7*24*60*60;
// Synthetic UI has an isolated port and build cache; production remains fixed loopback.
const HOST=process.env.PTR_SYNTHETIC_UI==='1'?'127.0.0.1:56448':'127.0.0.1:56440';
const ORIGIN=`http://${HOST}`;
type OwnerSession={owner:string;expires:number};
function secret():string { const value=process.env.PTR_SESSION_SECRET??''; if(value.length<32) throw new Error('AUTH_UNAVAILABLE'); return value; }
function options():SessionOptions {return {cookieName:COOKIE_NAME,password:secret(),ttl:SESSION_SECONDS,chunk:false,cookieOptions:{httpOnly:true,sameSite:'strict',secure:false,path:'/',maxAge:SESSION_SECONDS}};}
export function equal(left:string,right:string):boolean { return timingSafeEqual(createHash('sha256').update(left).digest(),createHash('sha256').update(right).digest()); }
export function localHost(request:Request):boolean { return request.headers.get('host')===HOST; }
export function sameOrigin(request:Request):boolean {
  // Next normalizes its internal Request URL hostname; validate the actual Host header.
  return localHost(request)&&request.headers.get('origin')===ORIGIN&& !['cross-site','same-site'].includes(request.headers.get('sec-fetch-site')??'');
}
export async function saveOwnerSession(request:Request,response:Response):Promise<void> {
  const session=await getIronSession<OwnerSession>(request,response,options());
  // Stable private single-user ownership allows history after login/session expiry.
  session.owner='local-'+createHmac('sha256',secret()).update('ptr-local-research-owner-v1').digest('hex').slice(0,40);
  session.expires=Date.now()+SESSION_SECONDS*1000;
  await session.save();
}
export async function verifyOwnerCookie(raw:string|undefined):Promise<string|undefined> {
  // The SDK treats its unsigned version suffix as metadata; our single-format cookie rejects appended junk.
  if(!raw||raw.length>1024||!raw.endsWith('~2')||raw.indexOf('~')!==raw.length-2)return;
  try {
    const session=await getIronSession<OwnerSession>({read:name=>name===COOKIE_NAME?raw:undefined,write:()=>{throw new Error('READ_ONLY_SESSION');}},options());
    // SDK seals allow clock skew; authorization remains the exact seven-day policy.
    const now=Date.now();
    if(typeof session.owner==='string'&&/^local-[a-f0-9]{40}$/.test(session.owner)&&typeof session.expires==='number'&&Number.isFinite(session.expires)&&session.expires>now&&session.expires<=now+SESSION_SECONDS*1000)return session.owner;
  }catch{/* Invalid cookies/configuration are unauthenticated. Reads never save or slide. */}
}
export async function signedOwner():Promise<string|undefined> {
  try {return await verifyOwnerCookie((await cookies()).get(COOKIE_NAME)?.value);}catch{return;}
}
