import { NextResponse } from 'next/server';
import { COOKIE_NAME, equal, sameOrigin, signOwnerCookie } from '../../../lib/auth';
export const runtime='nodejs';
const failures:{count:number;expires:number}={count:0,expires:0};
export async function POST(request:Request) {
  if(!sameOrigin(request)) return NextResponse.json({error:{code:'FORBIDDEN_ORIGIN'}},{status:403});
  if(Date.now()>failures.expires) {failures.count=0;failures.expires=Date.now()+60000;}
  if(failures.count>=10) return NextResponse.json({error:{code:'LOGIN_RATE_LIMIT'}},{status:429});
  try {
    const expected=process.env.PTR_UI_PASSWORD??'';
    if(expected.length<12) return NextResponse.json({error:{code:'AUTH_UNAVAILABLE'}},{status:503});
    const raw=await request.text(); if(raw.length>2048) return NextResponse.json({error:{code:'INVALID_INPUT'}},{status:413});
    const body=JSON.parse(raw) as {password?:unknown};
    if(typeof body.password!=='string'||!equal(body.password,expected)) {failures.count++;return NextResponse.json({error:{code:'UNAUTHORIZED'}},{status:403});}
    const response=NextResponse.json({ok:true},{headers:{'Cache-Control':'no-store'}});
    response.cookies.set(COOKIE_NAME,signOwnerCookie(),{httpOnly:true,sameSite:'strict',secure:false,path:'/',maxAge:7*24*60*60});
    failures.count=0;return response;
  } catch { return NextResponse.json({error:{code:'AUTH_UNAVAILABLE'}},{status:503}); }
}
export async function DELETE(request:Request) {
  if(!sameOrigin(request)) return NextResponse.json({error:{code:'FORBIDDEN_ORIGIN'}},{status:403});
  const response=NextResponse.json({ok:true});response.cookies.set(COOKIE_NAME,'',{httpOnly:true,sameSite:'strict',secure:false,path:'/',maxAge:0});return response;
}
