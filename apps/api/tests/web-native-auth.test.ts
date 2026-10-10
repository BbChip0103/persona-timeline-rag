import { createHmac } from 'node:crypto';
import { POST, DELETE } from '../../web/app/api/auth/route';
import { verifyOwnerCookie, sameOrigin, signedOwner } from '../../web/lib/auth';
import { sealData } from 'iron-session';
import { loginFailures } from '../../web/lib/login-limiter';
import { RateLimiterMemory } from 'rate-limiter-flexible';
jest.mock('next/headers',()=>({cookies:jest.fn(async()=>({get:()=>undefined}))}));
const secret='synthetic-session-secret-at-least-32-characters';
const password='synthetic-password-only';
const owner='local-'+createHmac('sha256',secret).update('ptr-local-research-owner-v1').digest('hex').slice(0,40);
function request(body:unknown={password},origin='http://127.0.0.1:56440') {
  return new Request('http://127.0.0.1:56440/api/auth',{method:'POST',headers:{host:'127.0.0.1:56440',origin,'content-type':'application/json'},body:typeof body==='string'?body:JSON.stringify(body)});
}
function cookie(response:Response) {return response.headers.get('set-cookie')!.split(';')[0]!.slice('ptr_owner='.length);}
beforeEach(async()=>{await loginFailures.delete('local-owner');jest.useFakeTimers({doNotFake:['nextTick','queueMicrotask','setImmediate']});jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));process.env.PTR_SESSION_SECRET=secret;process.env.PTR_UI_PASSWORD=password;delete process.env.PTR_SYNTHETIC_UI;});
afterEach(()=>{jest.useRealTimers();});
test('native cookie workflow keeps stable research ownership, flags and exactly seven days without sliding',async()=>{
 const first=await POST(request());expect(first.status).toBe(200);const raw=cookie(first);
 expect(first.headers.get('set-cookie')).toMatch(/HttpOnly/i);expect(first.headers.get('set-cookie')).toMatch(/SameSite=Strict/i);expect(first.headers.get('set-cookie')).toContain('Max-Age=604800');
 expect(raw).toMatch(/^Fe26\.2/);expect(raw).not.toContain(owner);expect(await verifyOwnerCookie(raw)).toBe(owner);
 expect(await verifyOwnerCookie(raw+'tampered')).toBeUndefined();expect(await verifyOwnerCookie('x'.repeat(1025))).toBeUndefined();
 jest.setSystemTime(Date.now()+604800000-1);expect(await verifyOwnerCookie(raw)).toBe(owner);
 jest.setSystemTime(Date.now()+1);expect(await verifyOwnerCookie(raw)).toBeUndefined();
 const again=await POST(request());expect(await verifyOwnerCookie(cookie(again))).toBe(owner);
 const logout=await DELETE(request());expect(logout.status).toBe(200);expect(logout.headers.get('set-cookie')).toContain('Max-Age=0');
 expect(await signedOwner()).toBeUndefined();
});
test.each([null,{}, {owner:'bad',expires:Date.now()+10}, {owner,expires:'later'}, {owner,expires:0}])('SDK-authenticated but invalid session payload is denied: %p',async data=>{
 const raw=await sealData(data,{password:secret,ttl:604800});expect(await verifyOwnerCookie(raw)).toBeUndefined();
});
test('future, boundary expiry and wrong session password fail closed',async()=>{
 for(const expires of [Date.now(),Date.now()+604800001])expect(await verifyOwnerCookie(await sealData({owner,expires},{password:secret,ttl:604800}))).toBeUndefined();
 expect(await verifyOwnerCookie(await sealData({owner,expires:Date.now()+1},{password:secret+'different',ttl:604800}))).toBeUndefined();
});
test('origin denial occurs before body reads, and host/fetch-site restrictions remain',async()=>{
 const denied=request({password},'https://untrusted.example');const read=jest.spyOn(denied,'text');expect((await POST(denied)).status).toBe(403);expect(read).not.toHaveBeenCalled();
 expect(sameOrigin(new Request('http://127.0.0.1',{headers:{host:'evil',origin:'http://127.0.0.1:56440'}}))).toBe(false);
 expect(sameOrigin(new Request('http://127.0.0.1',{headers:{host:'127.0.0.1:56440',origin:'http://127.0.0.1:56440','sec-fetch-site':'same-site'}}))).toBe(false);
});
test('login counts wrong credentials only, checks tenth-failure threshold before body, resets count without moving TTL',async()=>{
 // Reset shared module counter with a success, then use a fresh minute.
 await POST(request());jest.setSystemTime(Date.now()+61000);
 expect((await POST(request('{'))).status).toBe(503);
 for(let i=0;i<9;i++)expect((await POST(request({password:'wrong'}))).status).toBe(403);
 jest.setSystemTime(Date.now()+30000);expect((await POST(request())).status).toBe(200);
 for(let i=0;i<10;i++)expect((await POST(request({password:'wrong'}))).status).toBe(403);
 const blocked=request();const read=jest.spyOn(blocked,'text');expect((await POST(blocked)).status).toBe(429);expect(read).not.toHaveBeenCalled();
 jest.setSystemTime(Date.now()+30001);expect((await POST(request())).status).toBe(200);
});
test('unavailable configuration and oversized body preserve safe public errors',async()=>{
 await POST(request());process.env.PTR_UI_PASSWORD='short';const unavailable=request();const read=jest.spyOn(unavailable,'text');expect((await POST(unavailable)).status).toBe(503);expect(read).not.toHaveBeenCalled();
 process.env.PTR_UI_PASSWORD=password;expect((await POST(request(' '.repeat(2049)))).status).toBe(413);
});

test('native limiter owns failed-login storage, and SDK refuses non-JSON session numbers',async()=>{expect(loginFailures).toBeInstanceOf(RateLimiterMemory);const penalty=jest.spyOn(RateLimiterMemory.prototype,'penalty');expect((await POST(request({password:'wrong'}))).status).toBe(403);expect(penalty).toHaveBeenCalledWith('local-owner',1);penalty.mockRestore();await expect(sealData({owner,expires:Infinity},{password:secret,ttl:604800})).rejects.toThrow();});
test('concurrent admitted bad logins count natively and subsequent request is blocked before its body',async()=>{
 const responses=await Promise.all(Array.from({length:15},()=>POST(request({password:'wrong'}))));expect(responses.every(value=>value.status===403)).toBe(true);
 const next=request();const text=jest.spyOn(next,'text');expect((await POST(next)).status).toBe(429);expect(text).not.toHaveBeenCalled();
});

test('logout remains native cookie expiration and 200 even when the session secret is unavailable',async()=>{delete process.env.PTR_SESSION_SECRET;const response=await DELETE(request());expect(response.status).toBe(200);expect(response.headers.get('set-cookie')).toMatch(/ptr_owner=;.*Max-Age=0/);expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/i);expect(response.headers.get('set-cookie')).toMatch(/SameSite=Strict/i);});
