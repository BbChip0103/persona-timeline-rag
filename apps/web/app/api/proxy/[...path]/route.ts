import { NextResponse } from 'next/server';
import { localHost, sameOrigin, signedOwner } from '../../../../lib/auth';
import { operatorAvailability } from '../../../../lib/operator-availability';
import { apiUrl } from '../../../../lib/config';
export const runtime='nodejs';
const id='[a-zA-Z0-9_-]{1,200}';
const events=new RegExp(`^turns/${id}/events$`);
const routes={GET:new RegExp(`^(personas|sessions|sessions/${id}|turns/${id}|turns/${id}/events)$`),POST:new RegExp(`^(sessions|sessions/${id}/(turns|drafts)|turns/${id}/cancel)$`)};
async function proxy(request:Request,context:{params:Promise<{path:string[]}>}) {
  if(!localHost(request)||(request.method==='POST'&&!sameOrigin(request))) return NextResponse.json({error:{code:'FORBIDDEN_ORIGIN'}},{status:403});
  const owner=await signedOwner(); if(!owner) return NextResponse.json({error:{code:'UNAUTHORIZED'}},{status:403});
  const path=(await context.params).path.join('/');
  if(!(request.method==='GET'?routes.GET:routes.POST).test(path)||new URL(request.url).search) return NextResponse.json({error:{code:'NOT_FOUND'}},{status:404});
  try {
    // Fixed loopback target : PTR_API_URL is no longer read; instrumentation.ts refuses a different value.
    const origin=apiUrl();
    const token=process.env.PTR_API_TOKEN??'';if(token.length<24) throw new Error('API_UNAVAILABLE');
    const body=request.method==='POST'?await request.text():undefined;
    if(body&&Buffer.byteLength(body)>16384) return NextResponse.json({error:{code:'BODY_TOO_LARGE'}},{status:413});
    const streaming=request.method==='GET'&&events.test(path);
    // SSE streams outlive normal requests (the API ends them after 120 s); the client's disconnect still aborts them.
    const result=await fetch(`${origin}/api/${path}`,{method:request.method,headers:{Authorization:`Bearer ${token}`,'X-PTR-Owner':owner,'Content-Type':'application/json'},body,cache:'no-store',redirect:'error',signal:AbortSignal.any([request.signal,AbortSignal.timeout(streaming?130000:35000)])});
    if(!result.ok) {
      let code='API_ERROR';try {const error=await result.json();if(typeof error?.error?.code==='string'&&/^[A-Z_]{1,60}$/.test(error.error.code)) code=error.error.code;} catch { /* Never forward upstream bodies. */ }
      return NextResponse.json({error:{code}},{status:[400,403,404,409,413,429,502,503].includes(result.status)?result.status:502,headers:{'Cache-Control':'no-store'}});
    }
    if(streaming) {
      if(!result.body||!result.headers.get('content-type')?.startsWith('text/event-stream')) return NextResponse.json({error:{code:'API_ERROR'}},{status:502});
      return new Response(result.body,{headers:{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'}});
    }
    const value=await result.json();
    if(path==='personas'&&value.operatorMode===true)Object.assign(value,operatorAvailability(true,value.operatorOptionsAvailable===true,code=>console.warn(code)));
    return NextResponse.json(value,{headers:{'Cache-Control':'no-store'}});
  } catch { return NextResponse.json({error:{code:'API_UNAVAILABLE'}},{status:503}); }
}
export const GET=proxy;
export const POST=proxy;
