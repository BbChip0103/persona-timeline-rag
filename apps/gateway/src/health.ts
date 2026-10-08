export interface BreakerOptions {
  /** Consecutive connection failures (certain or closed-before-response) that open the breaker. */
  failureThreshold:number;
  /** Consecutive timeouts that trigger a `/health` probe while closed (the breaker opens only if it fails). */
  timeoutThreshold:number;
  cooldownMs:number; probeTimeoutMs:number;
}
export type BreakerState='closed'|'open'|'half_open';
export interface BreakerMetrics {state:BreakerState;consecutiveFailures:number;consecutiveTimeouts:number;opened:number;probesOk:number;probesFailed:number}

/** Resolves with `work` unless the caller aborts first (the shared work itself keeps running). */
export function untilAborted<T>(work:Promise<T>,signal:AbortSignal):Promise<T> {
  if(signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve,reject)=>{
    const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});
    work.then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop));
  });
}

/**
 * Circuit breaker of one upstream (moved unchanged out of FailoverUpstream; one per pool member now).
 * `failureThreshold` consecutive connection failures open it for `cooldownMs`; `timeoutThreshold` consecutive timeouts
 * run a `/health` probe that opens it only if the engine is unhealthy. Once the cooldown has passed, one `/health` probe
 * (shared by concurrent callers, each of which may abort) closes it or restarts the cooldown. Any HTTP answer resets
 * both streaks.
 */
export class UpstreamHealth {
  private open=false;private openedAt=0;private failures=0;private timeouts=0;private probe:Promise<boolean>|undefined;
  private readonly counts={opened:0,probesOk:0,probesFailed:0};
  /** `onChange`: called when the breaker opens or closes (a pool wakes requests waiting for a usable upstream). */
  constructor(private readonly check:(signal:AbortSignal)=>Promise<boolean>,private readonly options:BreakerOptions,private readonly onChange?:()=>void) {}
  get isOpen():boolean {return this.open;}
  /** The last close came from a call sent while open that got an answer (not from a /health probe). */
  closedByAnswer=false;
  /** Breaker generation: how many times it has opened. */
  get generation():number {return this.counts.opened;}
  state():BreakerState {return !this.open?'closed':Date.now()-this.openedAt<this.options.cooldownMs?'open':'half_open';}
  /** Whether a call may go to this upstream now; half-open waits for the (shared) probe. */
  allowed(signal:AbortSignal):boolean|Promise<boolean> {
    if(!this.open) return true;
    if(Date.now()-this.openedAt<this.options.cooldownMs) return false;
    return untilAborted(this.probeHealth(),signal);
  }
  /** The upstream answered (any HTTP status). A call sent while the breaker was open (no alternative) also closes it. */
  answered(sentWhileOpenGeneration?:number):void {
    this.failures=0;this.timeouts=0;
    if(this.open&&sentWhileOpenGeneration===this.counts.opened) {this.open=false;this.closedByAnswer=true;this.onChange?.();}
  }
  timedOut():void {if(!this.open&&++this.timeouts>=this.options.timeoutThreshold) void this.probeHealth();}
  connectFailed():void {if(!this.open&&++this.failures>=this.options.failureThreshold) this.trip();}
  private trip():void {this.open=true;this.openedAt=Date.now();this.counts.opened++;this.onChange?.();}
  /**
   * One `/health` probe at a time: healthy closes the breaker and clears both streaks; unhealthy opens or re-opens it.
   * A healthy answer never closes a breaker that (re)opened after the probe started (e.g. a timeout probe overtaken
   * by connection failures).
   */
  probeHealth():Promise<boolean> {
    if(this.probe) return this.probe;
    const generation=this.counts.opened;
    this.probe=this.check(AbortSignal.timeout(this.options.probeTimeoutMs)).catch(()=>false).then(ok=>{
      this.probe=undefined;
      if(ok) {
        this.counts.probesOk++;
        if(!this.open||this.counts.opened===generation) {const was=this.open;this.open=false;this.failures=0;this.timeouts=0;if(was) {this.closedByAnswer=false;this.onChange?.();}}
      }
      else {this.counts.probesFailed++;if(this.open) this.openedAt=Date.now();else this.trip();this.timeouts=0;}
      return ok;
    });
    return this.probe;
  }
  metrics():BreakerMetrics {
    return {state:this.state(),consecutiveFailures:this.failures,consecutiveTimeouts:this.timeouts,opened:this.counts.opened,
      probesOk:this.counts.probesOk,probesFailed:this.counts.probesFailed};
  }
}
