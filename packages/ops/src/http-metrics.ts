import { createServer, type Server } from 'node:http';
import type { LogFields } from './log';

export const PROM_CONTENT_TYPE='text/plain; version=0.0.4; charset=utf-8';
/** Default listener ports of the roles without their own HTTP server. */
export const WORKER_METRICS_PORT=56442;

/** PTR_METRICS_PORT (per-process listener override): the role default when unset, 0 = no listener, otherwise 1024–65535. */
export function metricsPort(env:NodeJS.ProcessEnv,fallback:number):number {
  const raw=env.PTR_METRICS_PORT;if(raw===undefined) return fallback;
  const port=/^\d+$/.test(raw)?Number(raw):NaN;
  if(port!==0&&!(port>=1024&&port<=65535)) throw new Error('INVALID_PTR_METRICS_PORT');
  return port;
}
/** The `/metrics/prom` answer of any HTTP server: GET only; a failed render is a bare 500. */
export async function servePrometheus(method:string|undefined,render:()=>string|Promise<string>):Promise<{status:number;headers:Record<string,string>;body:string}> {
  if(method!=='GET') return {status:404,headers:{'Content-Type':'application/json'},body:'{"error":{"code":"NOT_FOUND"}}'};
  try {return {status:200,headers:{'Content-Type':PROM_CONTENT_TYPE,'Cache-Control':'no-store'},body:await render()};}
  catch {return {status:500,headers:{'Content-Type':'application/json'},body:'{"error":{"code":"INTERNAL_ERROR"}}'};}
}
/**
 * Loopback listener for `/metrics/prom` (worker). Observability never stops turn processing: a failed bind
 * is logged (`metrics_listener_failed` with the bare error code) and resolves undefined, as does port 0 (disabled).
 */
export async function startMetricsListener(options:{port:number;render:()=>string|Promise<string>;onEvent:(event:string,fields?:LogFields)=>void}):
  Promise<{port:number;close():Promise<void>}|undefined> {
  if(options.port===0) {options.onEvent('metrics_listener_disabled');return undefined;}
  const server:Server=createServer((req,res)=>{
    const path=(req.url??'').split('?')[0];
    // `/healthz`: liveness for Compose healthchecks.
    void (path==='/metrics/prom'?servePrometheus(req.method,options.render)
      :path==='/healthz'&&req.method==='GET'?Promise.resolve({status:200,headers:{'Content-Type':'application/json'},body:'{"ok":true}'})
      :Promise.resolve({status:404,headers:{'Content-Type':'application/json'},body:'{"error":{"code":"NOT_FOUND"}}'}))
      .then(({status,headers,body})=>{res.writeHead(status,headers);res.end(body);});
  });
  try {
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  } catch(error) {
    const code=(error as {code?:unknown})?.code;
    options.onEvent('metrics_listener_failed',{port:options.port,code:typeof code==='string'&&/^[A-Z_]{1,40}$/.test(code)?code:'UNKNOWN'});
    return undefined;
  }
  // A scrape never keeps the process alive at shutdown.
  server.unref();
  return {port:options.port,close:()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();})};
}
