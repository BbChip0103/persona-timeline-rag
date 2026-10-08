import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { REQUEST_KEY } from '@ptr/providers';
import type { FailoverMetrics, PoolMetrics } from './pool';
import { AdmissionLimiter, GatewayRejection } from './limiter';
import type { ChatCompletionRequest, RequestContext, Upstream } from './upstreams';

export interface GatewayOptions {
  token:string; upstream:Upstream;
  limits:{maxConcurrent:number;maxQueue:number;queueTimeoutMs:number;upstreamTimeoutMs:number};
  maxBodyBytes?:number;
}
export interface GatewayMetrics {
  upstream:string; inFlight:number; queued:number; accepted:number; completed:number; upstreamErrors:number;
  rejected:{queueFull:number;queueTimeout:number;draining:number};
  /** Graceful drain started (SIGTERM, §6.3): queued and new requests get the marked 503 `draining`. */
  draining:boolean;
  /** Milliseconds over the most recent requests (bounded sample). */
  queueWaitMs:{p50:number|null;p95:number|null}; upstreamMs:{p50:number|null;p95:number|null};
  /** Only when failover is configured. */
  failover?:FailoverMetrics;
  /** Only for upstream pools (PTR_GATEWAY_UPSTREAMS_FILE or PTR_GATEWAY_DISCOVERY=redis): members, per-upstream state, registry health. */
  pool?:PoolMetrics;
  /** Admission capacity: upstream concurrency cap + queue bound. Workers warn when Σ worker concurrency exceeds `total`. */
  capacity:{maxConcurrent:number;maxQueue:number;total:number};
}
const SAMPLE=2000;
function percentile(values:number[],p:number):number|null {
  if(!values.length) return null;const sorted=[...values].sort((a,b)=>a-b);
  return sorted[Math.min(sorted.length-1,Math.ceil(p*sorted.length)-1)]!;
}
/**
 * Retry-After for a full queue: the queue drains in ceil(queued/maxConcurrent) rounds of about one mean upstream call
 * each, clamped to 1–5 s (1 before any call has completed). Request counts only; token-aware estimates come with credits.
 */
export function queueFullRetryAfterSeconds(queued:number,maxConcurrent:number,meanUpstreamMs:number|null):number {
  if(meanUpstreamMs===null) return 1;
  return Math.min(5,Math.max(1,Math.ceil(Math.ceil(queued/maxConcurrent)*meanUpstreamMs/1000)));
}
const json=(res:ServerResponse,status:number,body:unknown,headers:Record<string,string>={})=>{
  res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store',...headers});res.end(JSON.stringify(body));
};

/** The marked drain rejection: nothing was sent upstream, so the client may resend it to its next gateway at once. */
const DRAINING_HEADERS={'Retry-After':'1','X-PTR-Gateway':'rejected','X-PTR-Gateway-Reason':'draining','Connection':'close'};
export interface Gateway {
  server:Server; metrics:()=>GatewayMetrics;
  /**
   * Graceful drain : /healthz answers 503, queued and new requests get the marked 503 `draining` at once
   * (never sent upstream), idle keep-alive connections are closed and every later response closes its connection.
   * Calls already sent upstream finish. Idempotent.
   */
  drain:()=>void;
  /** Resolves once no request is being handled (the in-flight calls of a drain have finished). */
  idle:()=>Promise<void>;
}
/**
 * LLM gateway: one OpenAI-compatible entry point in front of one configured upstream (optionally a FailoverUpstream).
 * It bounds concurrent upstream calls, queues a bounded number of requests, rejects the rest before they reach the
 * upstream (marked `X-PTR-Gateway: rejected`, so clients may safely retry), and reports latency/rejection metrics.
 */
export function createGateway(options:GatewayOptions):Gateway {
  if(options.token.length<24||options.token.length>512) throw new Error('INVALID_GATEWAY_TOKEN');
  const expected=createHash('sha256').update(options.token).digest();
  const limiter=new AdmissionLimiter(options.limits);
  const counters={accepted:0,completed:0,upstreamErrors:0,queueFull:0,queueTimeout:0,draining:0};
  let draining=false, active=0;const idleWaiters:(()=>void)[]=[];
  /** Keep-alive: while draining every response closes its connection. */
  const closing=():Record<string,string>=>draining?{'Connection':'close'}:{};
  const refuseDraining=(res:ServerResponse)=>{counters.draining++;json(res,503,{error:{code:'GATEWAY_DRAINING'}},DRAINING_HEADERS);};
  const queueWaits:number[]=[],upstreamTimes:number[]=[];
  const record=(list:number[],value:number)=>{list.push(value);if(list.length>SAMPLE)list.shift();};
  let meanUpstreamMs:number|null=null; // EWMA of successful calls, for Retry-After
  const {maxConcurrent,maxQueue}=options.limits;
  // A pool that owns admission (S3) replaces this limiter: bands, credits and its own queue bound.
  const owned=options.upstream.admission?.bind(options.upstream);
  const capacity=()=>{if(!owned) return {maxConcurrent,maxQueue,total:maxConcurrent+maxQueue};const a=owned();return {maxConcurrent:a.maxConcurrent,maxQueue:a.maxQueue,total:a.maxConcurrent+a.maxQueue};};
  const metrics=():GatewayMetrics=>({upstream:options.upstream.model,inFlight:owned?owned().inFlight:limiter.inFlight,queued:owned?owned().queued:limiter.queued,
    accepted:counters.accepted,completed:counters.completed,upstreamErrors:counters.upstreamErrors,
    rejected:{queueFull:counters.queueFull,queueTimeout:counters.queueTimeout,draining:counters.draining},draining,
    queueWaitMs:{p50:percentile(queueWaits,0.5),p95:percentile(queueWaits,0.95)},upstreamMs:{p50:percentile(upstreamTimes,0.5),p95:percentile(upstreamTimes,0.95)},
    ...(options.upstream.failoverMetrics?{failover:options.upstream.failoverMetrics()}:{}),
    ...(options.upstream.poolMetrics?{pool:options.upstream.poolMetrics()}:{}),
    capacity:capacity()});
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
    if(draining) {req.resume();return refuseDraining(res);}
    active++;
    try {await handle(req,res);}
    finally {
      if(--active===0) for(const resolve of idleWaiters.splice(0)) resolve();
      // A response that ended while draining leaves an idle keep-alive connection behind: close it.
      if(draining) setImmediate(()=>server.closeIdleConnections());
    }
  }
  async function handle(req:IncomingMessage,res:ServerResponse) {
    const raw=await readBody(req);
    if(draining) return refuseDraining(res);
    if(raw===undefined) return json(res,413,{error:{code:'BODY_TOO_LARGE'}});
    let request:ChatCompletionRequest;
    try {request=JSON.parse(raw);} catch {return json(res,400,{error:{code:'INVALID_INPUT'}});}
    if(!Array.isArray(request?.messages)||!request.messages.length||!request.messages.every(m=>typeof m?.role==='string'&&typeof m?.content==='string'))
      return json(res,400,{error:{code:'INVALID_INPUT'}});
    // Optional per-turn key (the worker's turn id): scopes a billable upstream's ledger entry; never sent upstream.
    const requestKey=req.headers['x-ptr-request-key'];
    if(requestKey!==undefined&&(typeof requestKey!=='string'||!REQUEST_KEY.test(requestKey))) return json(res,400,{error:{code:'INVALID_INPUT'}});
    // X-PTR-Priority (band: 1 follow-up call of a running turn, 0 first call, −1 batch) and X-PTR-Flow (DRR key).
    const priority=req.headers['x-ptr-priority'], flow=req.headers['x-ptr-flow'];
    if(priority!==undefined&&!['1','0','-1'].includes(String(priority))) return json(res,400,{error:{code:'INVALID_INPUT'}});
    if(flow!==undefined&&(typeof flow!=='string'||!/^[0-9a-f]{1,32}$/.test(flow))) return json(res,400,{error:{code:'INVALID_INPUT'}});
    const context:RequestContext={...(requestKey!==undefined?{requestKey}:{}),...(priority!==undefined?{priority:Number(priority) as 1|0|-1}:{}),
      ...(flow!==undefined?{flow:flow as string}:{})};
    // The caller's disconnect cancels waiting and the upstream call alike.
    const caller=new AbortController();res.on('close',()=>{if(!res.writableFinished)caller.abort();});
    const queuedAt=performance.now();let release:(()=>void)|undefined;
    try {release=owned?()=>undefined:await limiter.acquire(caller.signal);}
    catch(error) {
      const code=error instanceof GatewayRejection?error.code:'CANCELLED';
      // X-PTR-Gateway-Reason tells clients why (queue_full / queue_timeout; draining later sends them to the next URL).
      if(code==='GATEWAY_QUEUE_FULL'){counters.queueFull++;return json(res,429,{error:{code}},
        {'Retry-After':String(queueFullRetryAfterSeconds(limiter.queued,maxConcurrent,meanUpstreamMs)),'X-PTR-Gateway':'rejected','X-PTR-Gateway-Reason':'queue_full'});}
      if(code==='GATEWAY_QUEUE_TIMEOUT'){counters.queueTimeout++;return json(res,503,{error:{code}},{'Retry-After':'1','X-PTR-Gateway':'rejected','X-PTR-Gateway-Reason':'queue_timeout'});}
      if(code==='GATEWAY_DRAINING') return refuseDraining(res);
      return; // caller already gone
    }
    // With a pool that owns admission the wait happens inside complete(): see pool.queue.waitMs instead.
    counters.accepted++;if(!owned) record(queueWaits,performance.now()-queuedAt);
    const started=performance.now();
    const signal=AbortSignal.any([caller.signal,AbortSignal.timeout(options.limits.upstreamTimeoutMs)]);
    try {
      const result=await options.upstream.complete(request,signal,Object.keys(context).length?context:undefined);
      // Which upstream answered, only when failover is configured.
      const served:Record<string,string>=result.upstream?{'X-PTR-Upstream':result.upstream}:{};
      if(result.status<200||result.status>=300) {
        counters.upstreamErrors++;
        // Upstream bodies are never forwarded; this is not a gateway rejection, so clients do not auto-retry.
        return json(res,502,{error:{code:`UPSTREAM_HTTP_${result.status}`}},{...served,...closing()});
      }
      res.writeHead(200,{'Content-Type':result.contentType,'Cache-Control':'no-store',...served,...closing()});
      if(typeof result.body==='string') res.end(result.body);
      // pipeline handles backpressure and settles when either side closes, so a client that stops reading and
      // disconnects cannot pin this slot on a 'drain' that never comes.
      else await pipeline(Readable.from(result.body),res,{signal});
      counters.completed++;
      // Successful calls only: fast failures would shorten the estimate and hung ones lengthen it.
      const elapsed=performance.now()-started;meanUpstreamMs=meanUpstreamMs===null?elapsed:meanUpstreamMs+0.1*(elapsed-meanUpstreamMs);
    } catch(error) {
      // A pool refused or timed out the request in its own queue: nothing was sent, so it is a marked (retryable) rejection.
      if(error instanceof GatewayRejection&&error.code!=='CANCELLED'&&!caller.signal.aborted&&!res.headersSent) {
        if(error.code==='GATEWAY_DRAINING') return refuseDraining(res);
        if(error.code==='GATEWAY_QUEUE_TIMEOUT') {counters.queueTimeout++;
          return json(res,503,{error:{code:error.code}},{'Retry-After':'1','X-PTR-Gateway':'rejected','X-PTR-Gateway-Reason':'queue_timeout'});}
        counters.queueFull++;
        return json(res,429,{error:{code:error.code}},{'Retry-After':String(error.retryAfterSeconds??1),'X-PTR-Gateway':'rejected',
          'X-PTR-Gateway-Reason':error.code==='GATEWAY_SATURATED'?'saturated':'queue_full'});
      }
      // A timeout: the gateway's own, or a failover primary's headers deadline (a TimeoutError from the upstream).
      const timedOut=signal.aborted||(error as {name?:unknown})?.name==='TimeoutError';
      if(!caller.signal.aborted){counters.upstreamErrors++;if(!res.headersSent)json(res,timedOut?504:502,{error:{code:timedOut?'UPSTREAM_TIMEOUT':'UPSTREAM_UNAVAILABLE'}},closing());else res.destroy();}
    } finally {record(upstreamTimes,performance.now()-started);release();}
  }
  const server=createServer((req,res)=>{
    const path=(req.url??'').split('?')[0];
    if(req.method==='GET'&&path==='/healthz') return draining?json(res,503,{ok:false,draining:true},{'Connection':'close'}):json(res,200,{ok:true});
    if(!authorized(req)) return json(res,403,{error:{code:'UNAUTHORIZED'}});
    if(req.method==='GET'&&path==='/metrics') return json(res,200,metrics());
    if(req.method==='POST'&&path==='/v1/chat/completions') return void complete(req,res).catch(()=>{if(!res.headersSent)json(res,500,{error:{code:'INTERNAL_ERROR'}});});
    return json(res,404,{error:{code:'NOT_FOUND'}});
  });
  const drain=()=>{
    if(draining) return;draining=true;
    limiter.drain();options.upstream.drain?.();
    server.closeIdleConnections();
  };
  const idle=()=>active===0?Promise.resolve():new Promise<void>(resolve=>idleWaiters.push(resolve));
  return {server,metrics,drain,idle};
}
