import { NextResponse } from 'next/server';
import { COOKIE_NAME, equal, sameOrigin, saveOwnerSession } from '../../../lib/auth';
import { loginBlocked, failedLogin, successfulLogin } from '../../../lib/login-limiter';
export const runtime='nodejs';
export async function POST(request:Request) {
  if(!sameOrigin(request)) return NextResponse.json({error:{code:'FORBIDDEN_ORIGIN'}},{status:403});
  if(await loginBlocked()) return NextResponse.json({error:{code:'LOGIN_RATE_LIMIT'}},{status:429});
  try {
    const expected=process.env.PTR_UI_PASSWORD??'';
    if(expected.length<12) return NextResponse.json({error:{code:'AUTH_UNAVAILABLE'}},{status:503});
    const raw=await request.text(); if(raw.length>2048) return NextResponse.json({error:{code:'INVALID_INPUT'}},{status:413});
    const body=JSON.parse(raw) as {password?:unknown};
    if(typeof body.password!=='string'||!equal(body.password,expected)) {await failedLogin();return NextResponse.json({error:{code:'UNAUTHORIZED'}},{status:403});}
    const response=NextResponse.json({ok:true},{headers:{'Cache-Control':'no-store'}});
    await saveOwnerSession(request,response);await successfulLogin();return response;
  } catch { return NextResponse.json({error:{code:'AUTH_UNAVAILABLE'}},{status:503}); }
}
export async function DELETE(request:Request) {
  if(!sameOrigin(request)) return NextResponse.json({error:{code:'FORBIDDEN_ORIGIN'}},{status:403});
  // Logout is not credential-gated: native Next cookie expiration works even with missing session configuration.
  const response=NextResponse.json({ok:true});response.cookies.set(COOKIE_NAME,'',{httpOnly:true,sameSite:'strict',secure:false,path:'/',maxAge:0});return response;
}
