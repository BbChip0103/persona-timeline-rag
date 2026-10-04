import type { ChatService } from './chat-service';
import type { QueuedTurn, TurnQueue } from './ports';

export interface TurnWorkerOptions {
  chat:ChatService; queue:TurnQueue; workerId:string;
  /** Max turns this worker executes at once (provider/DB pressure bound per process). */
  concurrency:number;
  /** Lease length; heartbeats renew at a third of it, recovery sweeps at half of it. */
  leaseMs:number; pollMs:number; maxAttempts:number;
  onError?:(phase:'claim'|'recover'|'execute',error:unknown)=>void;
}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** Claims leased turns from the durable queue and executes them with fenced writes. */
export class TurnWorker {
  private running=false;
  private dead=false;
  private loop?:Promise<void>;
  private recovery?:ReturnType<typeof setInterval>;
  private readonly inFlight=new Map<string,{controller:AbortController;heartbeat:ReturnType<typeof setInterval>;done:Promise<void>}>();
  constructor(private readonly options:TurnWorkerOptions) {}
  get activeTurns():number { return this.inFlight.size; }
  start():void {
    if(this.running) return;
    this.running=true;
    const sweep=()=>{void this.options.queue.recoverExpired(this.options.maxAttempts).catch(error=>this.options.onError?.('recover',error));};
    sweep();this.recovery=setInterval(sweep,Math.max(10,Math.floor(this.options.leaseMs/2)));
    this.loop=this.claimLoop();
  }
  /** Graceful: stop claiming, let in-flight turns finish (their own timeout still applies). */
  async stop():Promise<void> {
    this.running=false;if(this.recovery) clearInterval(this.recovery);
    await this.loop;await Promise.all([...this.inFlight.values()].map(entry=>entry.done));
  }
  /** Test hook for a crash: no further heartbeats, claims or writes are scheduled by this worker. */
  kill():void {
    this.dead=true;this.running=false;if(this.recovery) clearInterval(this.recovery);
    for(const entry of this.inFlight.values()) clearInterval(entry.heartbeat);
  }
  private async claimLoop():Promise<void> {
    while(this.running) {
      const free=this.options.concurrency-this.inFlight.size;
      let claimed:QueuedTurn[]=[];
      if(free>0) {
        try {claimed=await this.options.queue.claimTurns(this.options.workerId,this.options.leaseMs,free);}
        catch(error) {this.options.onError?.('claim',error);}
      }
      if(this.dead) return;
      for(const queued of claimed) this.execute(queued);
      if(!claimed.length) await sleep(this.options.pollMs);
    }
  }
  private execute(queued:QueuedTurn):void {
    const controller=new AbortController();
    // Lost or cancelled leases abort the provider call; renewal failures are treated as lost.
    const heartbeat=setInterval(()=>{
      void this.options.queue.renewLease(queued.turn.id,queued.fence,this.options.leaseMs)
        .then(held=>{if(!held) controller.abort();},()=>controller.abort());
    },Math.max(5,Math.floor(this.options.leaseMs/3)));
    const done=this.options.chat.executeQueued(queued,controller)
      .catch(error=>this.options.onError?.('execute',error))
      .finally(()=>{clearInterval(heartbeat);this.inFlight.delete(queued.turn.id);});
    this.inFlight.set(queued.turn.id,{controller,heartbeat,done});
  }
}
