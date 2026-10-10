export class WebApiError extends Error {
  constructor(code:string,readonly status:number){super(code);}
}
/** Same-origin BFF only; no automatic requests/retries or browser credentials beyond its cookie. */
export async function requestApi<T>(path:string,body?:unknown,signal?:AbortSignal,onUnauthorized?:()=>void):Promise<T> {
  const response=await fetch(`/api/proxy/${path}`,{method:body===undefined?'GET':'POST',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal});
  const result=await response.json();
  if(!response.ok) {if(response.status===403)onUnauthorized?.();throw new WebApiError(typeof result?.error?.code==='string'?result.error.code:'API_UNAVAILABLE',response.status);}
  return result as T;
}
