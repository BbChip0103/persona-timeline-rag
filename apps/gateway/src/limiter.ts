export class GatewayRejection extends Error {
  constructor(readonly code:'GATEWAY_QUEUE_FULL'|'GATEWAY_QUEUE_TIMEOUT'|'CANCELLED') { super(code); this.name='GatewayRejection'; }
}
interface Waiter { grant:()=>void; reject:(error:GatewayRejection)=>void }

/**
 * Admission in front of one upstream: at most `maxConcurrent` calls run, at most `maxQueue` wait (FIFO), and a
 * waiter gives up after `queueTimeoutMs`. Rejections happen before anything is sent upstream.
 */
export class AdmissionLimiter {
  private running=0;
  private readonly waiting:Waiter[]=[];
  constructor(private readonly limits:{maxConcurrent:number;maxQueue:number;queueTimeoutMs:number}) {}
  get inFlight():number { return this.running; }
  get queued():number { return this.waiting.length; }
  /** Resolves with a release function once a slot is held; the caller must release exactly once. */
  async acquire(signal:AbortSignal):Promise<()=>void> {
    if(signal.aborted) throw new GatewayRejection('CANCELLED');
    if(this.running<this.limits.maxConcurrent&&!this.waiting.length) {this.running++;return this.releaser();}
    if(this.waiting.length>=this.limits.maxQueue) throw new GatewayRejection('GATEWAY_QUEUE_FULL');
    await new Promise<void>((resolve,reject)=>{
      const leave=(error:GatewayRejection)=>{const index=this.waiting.indexOf(waiter);if(index>=0)this.waiting.splice(index,1);cleanup();reject(error);};
      const timer=setTimeout(()=>leave(new GatewayRejection('GATEWAY_QUEUE_TIMEOUT')),this.limits.queueTimeoutMs);
      const onAbort=()=>leave(new GatewayRejection('CANCELLED'));
      const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',onAbort);};
      const waiter:Waiter={grant:()=>{cleanup();resolve();},reject:leave};
      signal.addEventListener('abort',onAbort,{once:true});
      this.waiting.push(waiter);
    });
    return this.releaser();
  }
  private releaser():()=>void {
    let released=false;
    return ()=>{
      if(released) return;released=true;
      const next=this.waiting.shift();
      if(next) next.grant(); // the slot passes straight to the next waiter
      else this.running--;
    };
  }
}
