import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AdmissionLimiter, GatewayRejection } from './limiter';
import type { ChatCompletionRequest, Upstream } from './upstreams';

export interface GatewayOptions {
  token:string; upstream:Upstream;
  limits:{maxConcurrent:number;maxQueue:number;queueTimeoutMs:number;upstreamTimeoutMs:number};
  maxBodyBytes?:number;
}
export interface GatewayMetrics {
  upstream:string; inFlight:number; queued:number; accepted:number; completed:number; upstreamErrors:number;
  rejected:{queueFull:number;queueTimeout:number};
  /** Milliseconds over the most recent requests (bounded sample). */
  queueWaitMs:{p50:number|null;p95:number|null}; upstreamMs:{p50:number|null;p95:number|null};
}
const SAMPLE=2000;
function percentile(values:number[],p:number):number|null {
  if(!values.length) return null;const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]!;
}
const json=(res:ServerResponse,status:number,body:unknown,headers:Record<string,string>={})=>{
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(body));
};

/**
 * LLM gateway: one OpenAI-compatible entry point in front of one configured upstream (no cross-provider fallback).
 * It bounds concurrent upstream calls, queues a bounded number of requests, rejects the rest before they reach the
 * upstream (marked `X-PTR-Gateway: rejected`, so clients may safely retry), and reports latency/rejection metrics.
 */
export function createGateway(options:GatewayOptions):{server:Server;metrics:()=>GatewayMetrics} {
  if(options.token.length<24||options.token.length>512) throw new Error('INVALID_GATEWAY_TOKEN');
  const expected=createHash('sha256').update(options.token).digest();
  const limiter=new AdmissionLimiter(options.limits);
  const counters={accepted:0,completed:0,upstreamErrors:0,queueFull:0,queueTimeout:0};
  const queueWaits:number[]=[],upstreamTimes:number[]=[];
  const record=(list:number[],value:number)=>{list.push(value);if(list.length>SAMPLE)list.shift();};
  const metrics=():GatewayMetrics=>({upstream:options.upstream.model,inFlight:limiter.inFlight,queued:limiter.queued,
    accepted:counters.accepted,completed:counters.completed,upstreamErrors:counters.upstreamErrors,
    rejected:{queueFull:counters.queueFull,queueTimeout:counters.queueTimeout},
    queueWaitMs:{p50:percentile(queueWaits,0.5),p95:percentile(queueWaits,0.95)},upstreamMs:{p50:percentile(upstreamTimes,0.5),p95:percentile(upstreamTimes,0.95)}});
  const authorized=(req:IncomingMessage)=>{
    const header=req.headers.authorization??'';const supplied=header.startsWith('Bearer ')?header.slice(7):'';
    return !!supplied&&supplied.length<=512&&timingSafeEqual(expected,createHash('sha256').update(supplied).digest());
  };
  async function readBody(req:IncomingMessage):Promise<string|undefined> {
    let size=0;const chunks:Buffer[]=[];
    for await (const chunk of req) {size+=(chunk as Buffer).length;if(size>(options.maxBodyBytes??262144))return undefined;chunks.push(chunk as Buffer);}
    return Buffer.concat(chunks).toString('utf8');
  }
  async function complete(req:IncomingMessage,res:ServerResponse) {
    const raw=await readBody(req);
    if(raw===undefined) return json(res,413,{error:{code:'BODY_TOO_LARGE'}});
    let request:ChatCompletionRequest;
    try {request=JSON.parse(raw);} catch {return json(res,400,{error:{code:'INVALID_INPUT'}});}
    if(!Array.isArray(request?.messages)||!request.messages.length||!request.messages.every(m=>typeof m?.role==='string'&&typeof m?.content==='string'))
      return json(res,400,{error:{code:'INVALID_INPUT'}});
    // The caller's disconnect cancels waiting and the upstream call alike.
    const caller=new AbortController();res.on('close',()=>{if(!res.writableFinished)caller.abort();});
    const queuedAt=performance.now();let release:(()=>void)|undefined;
    try {release=await limiter.acquire(caller.signal);}
    catch(error) {
      const code=error instanceof GatewayRejection?error.code:'CANCELLED';
      if(code==='GATEWAY_QUEUE_FULL'){counters.queueFull++;return json(res,429,{error:{code}},{'Retry-After':'1','X-PTR-Gateway':'rejected'});}
      if(code==='GATEWAY_QUEUE_TIMEOUT'){counters.queueTimeout++;return json(res,503,{error:{code}},{'Retry-After':'1','X-PTR-Gateway':'rejected'});}
      return; // caller already gone
    }
    counters.accepted++;record(queueWaits,performance.now()-queuedAt);
    const started=performance.now();
    const signal=AbortSignal.any([caller.signal,AbortSignal.timeout(options.limits.upstreamTimeoutMs)]);
    try {
      const result=await options.upstream.complete(request,signal);
      if(result.status<200||result.status>=300) {
        counters.upstreamErrors++;
        // Upstream bodies are never forwarded; this is not a gateway rejection, so clients do not auto-retry.
        return json(res,502,{error:{code:`UPSTREAM_HTTP_${result.status}`}});
      }
      res.writeHead(200,{'Content-Type':result.contentType,'Cache-Control':'no-store'});
      if(typeof result.body==='string') res.end(result.body);
      // pipeline handles backpressure and settles when either side closes, so a client that stops reading and
      // disconnects cannot pin this slot on a 'drain' that never comes.
      else await pipeline(Readable.from(result.body),res,{signal});
      counters.completed++;
    } catch {
      if(!caller.signal.aborted){counters.upstreamErrors++;if(!res.headersSent)json(res,signal.aborted?504:502,{error:{code:signal.aborted?'UPSTREAM_TIMEOUT':'UPSTREAM_UNAVAILABLE'}});else res.destroy();}
    } finally {record(upstreamTimes,performance.now()-started);release();}
  }
  const server=createServer((req,res)=>{
    const path=(req.url??'').split('?')[0];
    if(req.method==='GET'&&path==='/healthz') return json(res,200,{ok:true});
    if(!authorized(req)) return json(res,403,{error:{code:'UNAUTHORIZED'}});
    if(req.method==='GET'&&path==='/metrics') return json(res,200,metrics());
    if(req.method==='POST'&&path==='/v1/chat/completions') return void complete(req,res).catch(()=>{if(!res.headersSent)json(res,500,{error:{code:'INTERNAL_ERROR'}});});
    return json(res,404,{error:{code:'NOT_FOUND'}});
  });
  return {server,metrics};
}
