import { UpstreamConnectError, type ChatCompletionRequest, type RequestContext, type Upstream, type UpstreamResult } from './upstreams';

export interface FailoverOptions {
  /** Consecutive primary connection failures (certain or closed-before-response) that open the breaker. */
  failureThreshold:number;
  /** Consecutive primary timeouts that trigger a `/health` probe while closed (the breaker opens only if it fails). */
  timeoutThreshold:number;
  cooldownMs:number; probeTimeoutMs:number;
  /** 0 = off. The primary must send response headers within this time; the stream after that is not limited. */
  headersTimeoutMs:number;
  /**
   * Fail over a primary connection closed before any response byte. True for a non-billed self-hosted primary
   * (a duplicate generation there costs nothing and the caller never got an answer); false keeps the strict rule.
   */
  failOverOnClose:boolean;
  /** Secondary calls started per rolling minute (protects the shared ledger's call cap during an outage). */
  maxPerMinute:number;
}
export const DEFAULT_FAILOVER:FailoverOptions={failureThreshold:3,timeoutThreshold:3,cooldownMs:30000,probeTimeoutMs:2000,
  headersTimeoutMs:0,failOverOnClose:true,maxPerMinute:120};
export interface FailoverMetrics {
  secondary:string;
  breaker:{state:'closed'|'open'|'half_open';consecutiveFailures:number;consecutiveTimeouts:number;opened:number;probesOk:number;probesFailed:number};
  /** Requests answered (any HTTP status) by each upstream. */
  answered:{primary:number;secondary:number};
  /** Requests sent to the secondary, by reason: a primary connection failure, or the open breaker. */
  failovers:Record<string,number>;
  /** Closed-before-response primary failures surfaced as errors (failOverOnClose off). */
  closedNotFailedOver:number;
  /** Requests refused because the secondary's per-minute ceiling was reached. */
  rateLimited:number; secondaryErrors:number;
}
type Primary=Upstream&{health(signal:AbortSignal):Promise<boolean>};
const isTimeout=(reason:unknown)=>(reason as {name?:unknown})?.name==='TimeoutError';
/** Resolves with `work` unless the caller aborts first (the shared work itself keeps running). */
function untilAborted<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  if(signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve,reject)=>{
    const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));
  });
}

/**
 * Primary (self-hosted engine) with a secondary used only when the primary certainly did not answer: a
 * connection-phase failure, a connection closed before any response byte (`failOverOnClose`), or the breaker is
 * open (the request is then never sent to the primary). It runs inside the gateway's admission slot, so a full
 * gateway queue is still rejected and never spills over. Timeouts after sending, HTTP errors and streams cut
 * mid-response are surfaced, not retried elsewhere.
 * Breaker: `failureThreshold` consecutive connection failures open it for `cooldownMs`; `timeoutThreshold`
 * consecutive timeouts run a `/health` probe that opens it only if the engine is unhealthy. Once the cooldown has
 * passed, one `/health` probe (shared by concurrent callers, each of which may abort) closes it or restarts the
 * cooldown. Any HTTP answer from the primary resets both streaks.
 */
export class FailoverUpstream implements Upstream {
  readonly model:string;
  private readonly options:FailoverOptions;
  private open=false;private openedAt=0;private failures=0;private timeouts=0;private probe:Promise<boolean>|undefined;
  private readonly started:number[]=[];
  private readonly counts={opened:0,probesOk:0,probesFailed:0,primary:0,secondary:0,closedNotFailedOver:0,rateLimited:0,secondaryErrors:0};
  private readonly failovers:Record<string,number>={};
  constructor(private readonly primary:Primary,private readonly secondary:Upstream,options:Partial<FailoverOptions>={}) {
    this.model=primary.model;this.options={...DEFAULT_FAILOVER,...options};
  }
  async ready(signal:AbortSignal):Promise<void> {await this.secondary.ready?.(signal);}
  async complete(request:ChatCompletionRequest,signal:AbortSignal,context?:RequestContext):Promise<UpstreamResult> {
    let reason='breaker_open';
    if(await this.primaryAllowed(signal)) {
      const headers=new AbortController();
      const timer=this.options.headersTimeoutMs?setTimeout(()=>headers.abort(new DOMException('primary headers timeout','TimeoutError')),this.options.headersTimeoutMs):undefined;
      const primarySignal=AbortSignal.any([signal,headers.signal]);
      try {
        // The request key is for billing on the secondary; it is not sent to the engine.
        const result=await this.primary.complete(request,primarySignal);
        this.failures=0;this.timeouts=0;this.counts.primary++;
        return {...result,upstream:'primary'};
      } catch(error) {
        if(!(error instanceof UpstreamConnectError)) {
          // Sent and unanswered in time (the gateway's deadline, the headers timeout, or the HTTP client's own
          // timeout): it may be in the model, so it is never failed over.
          const timeout=isTimeout(error)?error:primarySignal.aborted&&isTimeout(primarySignal.reason)?primarySignal.reason:undefined;
          if(timeout) {
            if(!this.open&&++this.timeouts>=this.options.timeoutThreshold) void this.probeHealth();
            throw timeout;
          }
          throw error;
        }
        if(!this.open&&++this.failures>=this.options.failureThreshold) this.trip();
        if(!error.certain&&!this.options.failOverOnClose) {this.counts.closedNotFailedOver++;throw error;}
        if(signal.aborted) throw error;
        reason=error.reason;
      } finally {clearTimeout(timer);}
    }
    // A caller that already left is neither sent nor counted.
    if(signal.aborted) throw signal.reason;
    const now=Date.now();
    while(this.started.length&&now-this.started[0]!>=60000) this.started.shift();
    if(this.started.length>=this.options.maxPerMinute) {this.counts.rateLimited++;throw new Error('FAILOVER_RATE_LIMITED');}
    this.started.push(now);
    this.failovers[reason]=(this.failovers[reason]??0)+1;
    try {
      const result=await this.secondary.complete(request,signal,context);
      this.counts.secondary++;
      return {...result,upstream:'secondary'};
    } catch(error) {if(!signal.aborted) this.counts.secondaryErrors++;throw error;}
  }
  private trip():void {this.open=true;this.openedAt=Date.now();this.counts.opened++;}
  private primaryAllowed(signal:AbortSignal):boolean|Promise<boolean> {
    if(!this.open) return true;
    if(Date.now()-this.openedAt<this.options.cooldownMs) return false;
    return untilAborted(this.probeHealth(),signal);
  }
  /**
   * One `/health` probe at a time: healthy closes the breaker and clears both streaks; unhealthy opens or re-opens it.
   * A healthy answer never closes a breaker that (re)opened after the probe started (e.g. a timeout probe overtaken
   * by connection failures).
   */
  private probeHealth():Promise<boolean> {
    if(this.probe) return this.probe;
    const generation=this.counts.opened;
    this.probe=this.primary.health(AbortSignal.timeout(this.options.probeTimeoutMs)).catch(()=>false).then(ok=>{
      this.probe=undefined;
      if(ok) {this.counts.probesOk++;if(!this.open||this.counts.opened===generation) {this.open=false;this.failures=0;this.timeouts=0;}}
      else {this.counts.probesFailed++;if(this.open) this.openedAt=Date.now();else this.trip();this.timeouts=0;}
      return ok;
    });
    return this.probe;
  }
  failoverMetrics():FailoverMetrics {
    const state=!this.open?'closed':Date.now()-this.openedAt<this.options.cooldownMs?'open':'half_open';
    return {secondary:this.secondary.model,
      breaker:{state,consecutiveFailures:this.failures,consecutiveTimeouts:this.timeouts,opened:this.counts.opened,probesOk:this.counts.probesOk,probesFailed:this.counts.probesFailed},
      answered:{primary:this.counts.primary,secondary:this.counts.secondary},failovers:{...this.failovers},
      closedNotFailedOver:this.counts.closedNotFailedOver,rateLimited:this.counts.rateLimited,secondaryErrors:this.counts.secondaryErrors};
  }
}
