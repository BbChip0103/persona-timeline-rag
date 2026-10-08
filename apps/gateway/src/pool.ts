import type { UpstreamRecord } from '@ptr/messaging';
import { UpstreamHealth, type BreakerMetrics, type BreakerOptions, type BreakerState } from './health';
import { GatewayRejection } from './limiter';
import type { SourceMetrics, UpstreamSource } from './sources';
import { OpenAICompatibleUpstream, UpstreamConnectError, type ChatCompletionRequest, type RequestContext, type Upstream, type UpstreamResult } from './upstreams';

export interface FailoverOptions extends BreakerOptions {
  /** 0 = off. The primary must send response headers within this time; the stream after that is not limited. */
  headersTimeoutMs:number;
  /**
   * Treat a primary connection closed before any response byte like a connection failure (another primary, then the
   * secondary). True for a non-billed self-hosted primary (a duplicate generation there costs nothing and the caller
   * never got an answer); false keeps the strict rule.
   */
  failOverOnClose:boolean;
  /** Secondary calls started per rolling minute (protects the shared ledger's call cap during an outage). */
  maxPerMinute:number;
}
export const DEFAULT_FAILOVER:FailoverOptions={failureThreshold:3,timeoutThreshold:3,cooldownMs:30000,probeTimeoutMs:2000,
  headersTimeoutMs:0,failOverOnClose:true,maxPerMinute:120};
export interface FailoverMetrics {
  secondary:string;
  /** Primary breaker; with several primaries: closed if any is closed, counts summed, streaks the largest. */
  breaker:BreakerMetrics;
  /** Requests answered (any HTTP status) by the primaries and by the secondary. */
  answered:{primary:number;secondary:number};
  /** Requests sent to the secondary, by reason: a primary connection failure, the open breakers, or no registered primary. */
  failovers:Record<string,number>;
  /** Closed-before-response primary failures surfaced as errors (failOverOnClose off). */
  closedNotFailedOver:number;
  /** Requests refused because the secondary's per-minute ceiling was reached. */
  rateLimited:number; secondaryErrors:number;
}
/** A primary: an upstream with an engine `/health` check (OpenAICompatibleUpstream). */
export type Primary=Upstream&{health(signal:AbortSignal):Promise<boolean>};
export interface UpstreamMemberMetrics {
  id:string; epoch:string; state:'active'|'draining'|'gone';
  inFlight:number;
  /** Current per-upstream concurrency limit: maxSeqs, ramped during slow start (null = unlimited). */
  limit:number|null; maxSeqs:number|null; weight:number; slowStart:boolean; breaker:BreakerState;
  dispatched:number; answered:number; connectFailures:number;
}
export interface PoolMetrics {
  pool:string;
  /** Members by state; `ramping` ⊂ active (slow start), `gone` = left the source but still finishing calls. */
  members:{active:number;ramping:number;draining:number;gone:number;breakerOpen:number};
  /** Requests waiting for a free upstream slot (bounded by the gateway queue timeout). */
  waiting:number;
  /** Requests resent to another primary after a connection failure (nothing reached the first one). */
  retriedOnOtherPrimary:number;
  events:{added:number;removed:number;replaced:number;invalid:number};
  upstreams:UpstreamMemberMetrics[];
  registry?:SourceMetrics;
}
export interface PoolOptions {
  /** Pool name = the model name sent to every engine in it. */
  model:string;
  source:UpstreamSource;
  /** Builds the client of one record (default: OpenAICompatibleUpstream on its baseUrl). */
  create?:(record:UpstreamRecord)=>Primary;
  /** Used only when every primary is unavailable (breaker open, draining, none registered) or failed to connect. */
  secondary?:Upstream;
  failover?:Partial<FailoverOptions>;
  /** Primaries tried per request on connection failures (design §5, PTR_GATEWAY_PRIMARY_ATTEMPTS). Default 2. */
  primaryAttempts?:number;
  /** Linear ramp of a newly added upstream's limit (PTR_GATEWAY_SLOW_START_MS). Default 30000; 0 = off. */
  slowStartMs?:number;
  /** Longest wait for a free upstream slot before a marked 503 GATEWAY_QUEUE_TIMEOUT. Default 10000. */
  queueTimeoutMs?:number;
  /** Clock for slow start (tests). */
  now?:()=>number;
}

const isTimeout=(reason:unknown)=>(reason as {name?:unknown})?.name==='TimeoutError';
const RAMP_TICK_MS=250;
class Member {
  inFlight=0;dispatched=0;answered=0;connectFailures=0;gone=false;
  constructor(public record:UpstreamRecord,readonly upstream:Primary,readonly health:UpstreamHealth,readonly addedAt:number) {}
}
/** Releases the upstream slot when the relayed stream ends, fails, is closed by its consumer, or the call is aborted. */
function releasing(body:AsyncIterable<Uint8Array>,release:()=>void,signal:AbortSignal):AsyncIterable<Uint8Array> {
  const onAbort=()=>release();
  const done=()=>{signal.removeEventListener('abort',onAbort);release();};
  if(signal.aborted) release();else signal.addEventListener('abort',onAbort,{once:true});
  return {[Symbol.asyncIterator]() {
    const iterator=body[Symbol.asyncIterator]();
    return {
      async next() {
        try {const result=await iterator.next();if(result.done) done();return result;} catch(error) {done();throw error;}
      },
      async return(value?:unknown) {done();await iterator.return?.(value);return {done:true as const,value:undefined};},
    };
  }};
}

/**
 * One model's upstreams (routing ): the member set follows an UpstreamSource (static list, file or
 * Redis registry), each member has its own breaker (UpstreamHealth) and concurrency limit (`maxSeqs`, ramped by slow
 * start when added), and a request goes to the member with the fewest calls in flight that has room (ties rotate).
 * This is the interim selection; scored routing with token credits replaces it in S3. Without room anywhere the
 * request waits (no spillover). Draining or departed members take no new calls and finish the ones they have.
 * Connection failures (nothing reached the engine; with `failOverOnClose` also a close before any response byte) are
 * retried on another member, then on the optional secondary; timeouts, HTTP errors and streams cut mid-response are
 * surfaced as before. With one member this is exactly the single-upstream (and FailoverUpstream) behaviour: an open
 * breaker with no other member and no secondary still sends to it, as a plain upstream without a breaker would.
 */
export class UpstreamPool implements Upstream {
  readonly model:string;
  readonly failoverMetrics?:()=>FailoverMetrics;
  private readonly options:FailoverOptions;
  private readonly members=new Map<string,Member>();
  private readonly retiring=new Set<Member>();
  private readonly waiters=new Set<()=>void>();
  private readonly now:()=>number;
  private readonly create:(record:UpstreamRecord)=>Primary;
  private readonly stopSource:()=>void;
  private startingUp=true;private rr=0;
  private readonly started:number[]=[];
  private readonly counts={primary:0,secondary:0,closedNotFailedOver:0,rateLimited:0,secondaryErrors:0,retried:0};
  private readonly failovers:Record<string,number>={};
  private readonly events={added:0,removed:0,replaced:0,invalid:0};
  constructor(private readonly pool:PoolOptions) {
    this.model=pool.model;this.options={...DEFAULT_FAILOVER,...pool.failover};this.now=pool.now??Date.now;
    this.create=pool.create??(record=>new OpenAICompatibleUpstream({baseUrl:record.baseUrl,model:pool.model}));
    if(pool.secondary) this.failoverMetrics=()=>this.secondaryMetrics();
    this.sync();this.startingUp=false;
    this.stopSource=pool.source.onChange(()=>this.sync());
  }
  /** Loads the source (first registry poll; members found now start at full capacity), then checks the secondary. */
  async ready(signal:AbortSignal):Promise<void> {
    this.startingUp=true;
    try {await this.pool.source.start?.();} finally {this.startingUp=false;}
    await this.pool.secondary?.ready?.(signal);
  }
  async close():Promise<void> {this.stopSource();await this.pool.source.close?.();}

  async complete(request:ChatCompletionRequest,signal:AbortSignal,context?:RequestContext):Promise<UpstreamResult> {
    const tried=new Set<Member>();let reason='breaker_open';let lastError:unknown;let waitUntil:number|undefined;
    const deadline=()=>waitUntil??=Date.now()+(this.pool.queueTimeoutMs??10000);
    const attempts=Math.max(1,this.pool.primaryAttempts??2);
    for(let attempt=0;attempt<attempts;attempt++) {
      let picked:Awaited<ReturnType<UpstreamPool['pick']>>;
      try {picked=await this.pick(signal,tried,deadline);}
      catch(error) {
        // After a failed attempt the request may have reached an engine (closed before response): no other upstream
        // in time must not become a marked "nothing was sent" rejection. Fall through to the secondary or the error.
        if(attempt>0&&error instanceof GatewayRejection) break;
        throw error;
      }
      if(!picked.member) {if(picked.none) reason=picked.none;break;}
      tried.add(picked.member);if(attempt>0) this.counts.retried++;
      try {return await this.callPrimary(picked.member,request,signal,picked.openGeneration);}
      catch(error) {
        if(!(error instanceof UpstreamConnectError)) throw error;
        if(!error.certain&&!this.options.failOverOnClose) {this.counts.closedNotFailedOver++;throw error;}
        if(signal.aborted) throw error;
        reason=error.reason;lastError=error;
      }
    }
    const secondary=this.pool.secondary;
    if(!secondary) throw lastError;
    // A caller that already left is neither sent nor counted.
    if(signal.aborted) throw signal.reason;
    const now=Date.now();
    while(this.started.length&&now-this.started[0]!>=60000) this.started.shift();
    if(this.started.length>=this.options.maxPerMinute) {this.counts.rateLimited++;throw new Error('FAILOVER_RATE_LIMITED');}
    this.started.push(now);
    this.failovers[reason]=(this.failovers[reason]??0)+1;
    try {
      const result=await secondary.complete(request,signal,context);
      this.counts.secondary++;
      return {...result,upstream:'secondary'};
    } catch(error) {if(!signal.aborted) this.counts.secondaryErrors++;throw error;}
  }

  /**
   * A member with room, or why there is none: 'no_upstream' / 'breaker_open' (secondary configured), or nothing left
   * after a failed attempt. Waits while every usable member is full, or (no secondary) while none is registered.
   */
  private async pick(signal:AbortSignal,tried:Set<Member>,deadline:()=>number):Promise<{member?:Member;openGeneration?:number;none?:string}> {
    for(;;) {
      const live=[...this.members.values()].filter(member=>member.record.state==='active'&&!tried.has(member));
      if(!live.length) {
        if(this.pool.secondary||tried.size) return {none:tried.size?undefined:'no_upstream'};
        await this.waitForChange(signal,deadline());continue;
      }
      let usable=live.filter(member=>member.health.state()==='closed');
      const halfOpen=live.filter(member=>member.health.state()==='half_open');
      // With a secondary as the alternative, a half-open primary is probed before use (FailoverUpstream behaviour).
      // Otherwise probe in the background: others serve meanwhile, or (no alternative) the request goes out at once.
      if(!usable.length&&this.pool.secondary) {
        let changed=false;
        for(const member of halfOpen) if(await member.health.allowed(signal)) {
          // The membership may have changed during the probe: never dispatch to a member that left or is draining.
          if(this.members.get(member.record.id)===member&&member.record.state==='active') usable=[member];else changed=true;
          break;
        }
        if(changed) continue;
      }
      else for(const member of halfOpen) void member.health.probeHealth();
      if(!usable.length) {
        if(this.pool.secondary) return {none:'breaker_open'};
        usable=live; // no alternative at all: try anyway, as a plain upstream without a breaker would
      }
      const now=this.now();
      const room=usable.filter(member=>member.inFlight<this.limit(member,now));
      if(room.length) {
        const least=Math.min(...room.map(member=>member.inFlight));
        const tied=room.filter(member=>member.inFlight===least);
        const member=tied.length>1?tied[this.rr++%tied.length]!:tied[0]!;
        member.inFlight++;member.dispatched++;
        return {member,...(member.health.isOpen?{openGeneration:member.health.generation}:{})};
      }
      await this.waitForChange(signal,deadline());
    }
  }
  private async callPrimary(member:Member,request:ChatCompletionRequest,signal:AbortSignal,openGeneration:number|undefined):Promise<UpstreamResult> {
    let released=false;
    const release=()=>{if(released) return;released=true;this.release(member);};
    const headers=new AbortController();
    const timer=this.options.headersTimeoutMs?setTimeout(()=>headers.abort(new DOMException('primary headers timeout','TimeoutError')),this.options.headersTimeoutMs):undefined;
    const primarySignal=AbortSignal.any([signal,headers.signal]);
    try {
      // The request key is for billing on the secondary; it is not sent to the engine.
      const result=await member.upstream.complete(request,primarySignal);
      member.health.answered(openGeneration);member.answered++;this.counts.primary++;
      const body=typeof result.body==='string'?(release(),result.body):releasing(result.body,release,signal);
      return {...result,body,...(this.pool.secondary?{upstream:'primary' as const}:{})};
    } catch(error) {
      release();
      if(!(error instanceof UpstreamConnectError)) {
        // Sent and unanswered in time (the gateway's deadline, the headers timeout, or the HTTP client's own
        // timeout): it may be in the model, so it is never retried elsewhere.
        const timeout=isTimeout(error)?error:primarySignal.aborted&&isTimeout(primarySignal.reason)?primarySignal.reason:undefined;
        if(timeout) {member.health.timedOut();throw timeout;}
        throw error;
      }
      member.connectFailures++;member.health.connectFailed();
      throw error;
    } finally {clearTimeout(timer);}
  }
  private limit(member:Member,now:number):number {
    const max=member.record.maxSeqs, ramp=this.pool.slowStartMs??30000;
    if(!Number.isFinite(max)||ramp<=0) return max;
    return Math.max(1,Math.floor(max*Math.min(1,(now-member.addedAt)/ramp)));
  }
  private ramping(member:Member,now:number):boolean {return now-member.addedAt<(this.pool.slowStartMs??30000);}
  private release(member:Member):void {
    member.inFlight--;
    if(member.gone&&member.inFlight<=0) this.retiring.delete(member);
    this.wake();
  }
  private wake():void {for(const waiter of [...this.waiters]) waiter();}
  /** Resolves on any change (a slot freed, membership changed, or a slow-start tick); rejects at the deadline or on abort. */
  private waitForChange(signal:AbortSignal,deadlineAt:number):Promise<void> {
    if(signal.aborted) return Promise.reject(signal.reason);
    const remaining=deadlineAt-Date.now();
    if(remaining<=0) return Promise.reject(new GatewayRejection('GATEWAY_QUEUE_TIMEOUT'));
    const now=this.now();
    // Re-check on a short tick while a limit is ramping or a breaker is open (its cooldown ends without any event).
    const ramping=[...this.members.values()].some(member=>this.ramping(member,now)||member.health.isOpen);
    return new Promise<void>((resolve,reject)=>{
      const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);this.waiters.delete(wake);};
      const wake=()=>{cleanup();resolve();};
      const onAbort=()=>{cleanup();reject(signal.reason);};
      const timer=setTimeout(()=>{cleanup();if(Date.now()>=deadlineAt) reject(new GatewayRejection('GATEWAY_QUEUE_TIMEOUT'));else resolve();},
        ramping?Math.min(remaining,RAMP_TICK_MS):remaining);
      signal.addEventListener('abort',onAbort,{once:true});this.waiters.add(wake);
    });
  }
  /** Applies the source's snapshot: add (slow start unless loading at startup), update, drain, retire. */
  private sync():void {
    const now=this.now(), seen=new Set<string>();
    const breaker={failureThreshold:this.options.failureThreshold,timeoutThreshold:this.options.timeoutThreshold,
      cooldownMs:this.options.cooldownMs,probeTimeoutMs:this.options.probeTimeoutMs};
    for(const record of this.pool.source.snapshot()) {
      seen.add(record.id);
      let member=this.members.get(record.id);
      // A new epoch (engine restarted) or another address is a new upstream: fresh breaker, slow start again.
      if(member&&(member.record.epoch!==record.epoch||member.record.baseUrl!==record.baseUrl)) {this.retire(member);this.events.replaced++;member=undefined;}
      if(member) {member.record=record;continue;}
      if(record.state!=='active') continue;
      let upstream:Primary;
      try {upstream=this.create(record);} catch {this.events.invalid++;continue;}
      this.members.set(record.id,new Member(record,upstream,new UpstreamHealth(probe=>upstream.health(probe),breaker,()=>this.wake()),this.startingUp?-Infinity:now));
      if(!this.startingUp) this.events.added++;
    }
    for(const member of [...this.members.values()]) if(!seen.has(member.record.id)) {this.retire(member);this.events.removed++;}
    this.wake();
  }
  private retire(member:Member):void {
    this.members.delete(member.record.id);member.gone=true;
    if(member.inFlight>0) this.retiring.add(member);
  }
  poolMetrics():PoolMetrics {
    const now=this.now();
    const upstreams=[...this.members.values(),...this.retiring].map((member):UpstreamMemberMetrics=>{
      const limit=this.limit(member,now);
      return {id:member.record.id,epoch:member.record.epoch,state:member.gone?'gone':member.record.state,inFlight:member.inFlight,
        limit:Number.isFinite(limit)?limit:null,maxSeqs:Number.isFinite(member.record.maxSeqs)?member.record.maxSeqs:null,weight:member.record.weight,
        slowStart:!member.gone&&this.ramping(member,now),breaker:member.health.state(),
        dispatched:member.dispatched,answered:member.answered,connectFailures:member.connectFailures};
    });
    const count=(check:(u:UpstreamMemberMetrics)=>boolean)=>upstreams.filter(check).length;
    return {pool:this.model,
      members:{active:count(u=>u.state==='active'),ramping:count(u=>u.state==='active'&&u.slowStart),draining:count(u=>u.state==='draining'),
        gone:count(u=>u.state==='gone'),breakerOpen:count(u=>u.state!=='gone'&&u.breaker!=='closed')},
      waiting:this.waiters.size,retriedOnOtherPrimary:this.counts.retried,events:{...this.events},upstreams,
      ...(this.pool.source.metrics?{registry:this.pool.source.metrics()}:{})};
  }
  private secondaryMetrics():FailoverMetrics {
    const breakers=[...this.members.values()].map(member=>member.health.metrics());
    const state:BreakerState=!breakers.length?'open':breakers.some(b=>b.state==='closed')?'closed':breakers.some(b=>b.state==='half_open')?'half_open':'open';
    const sum=(key:'opened'|'probesOk'|'probesFailed')=>breakers.reduce((total,b)=>total+b[key],0);
    const max=(key:'consecutiveFailures'|'consecutiveTimeouts')=>breakers.reduce((top,b)=>Math.max(top,b[key]),0);
    return {secondary:this.pool.secondary!.model,
      breaker:{state,consecutiveFailures:max('consecutiveFailures'),consecutiveTimeouts:max('consecutiveTimeouts'),opened:sum('opened'),probesOk:sum('probesOk'),probesFailed:sum('probesFailed')},
      answered:{primary:this.counts.primary,secondary:this.counts.secondary},failovers:{...this.failovers},
      closedNotFailedOver:this.counts.closedNotFailedOver,rateLimited:this.counts.rateLimited,secondaryErrors:this.counts.secondaryErrors};
  }
}
