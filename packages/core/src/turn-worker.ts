import type { ChatService } from './chat-service';
import type { TurnDelivery, TurnDispatch, TurnEventSource, TurnEvents, TurnLeaseStore } from './ports';

export interface TurnWorkerOptions {
  chat:ChatService; leases:TurnLeaseStore; workerId:string;
  /** Lease length; heartbeats renew at a third of it. The dispatcher requeues turns whose lease expired. */
  leaseMs:number;
  /** Cancellation notices abort the provider call at once; the lease heartbeat stays as the backstop. */
  cancellations?:TurnEventSource;
  onError?:(phase:'claim'|'execute',error:unknown)=>void;
}

/**
 * Executes dispatched turns. Delivery (BullMQ) decides when and how many run; the Postgres lease decides
 * whether this worker may run a turn at all, so duplicated or stale deliveries are skipped.
 */
export class TurnWorker {
  private dead=false;
  private readonly inFlight=new Map<string,{controller:AbortController;heartbeat:ReturnType<typeof setInterval>;done:Promise<void>}>();
  constructor(private readonly options:TurnWorkerOptions) {}
  get activeTurns():number { return this.inFlight.size; }
  /** Delivery handler: runs one dispatched turn to its end, or does nothing if it is not claimable by this worker. */
  async handle(dispatch:TurnDispatch):Promise<'executed'|'skipped'> {
    if(this.dead) return 'skipped';
    let queued;
    try {queued=await this.options.leases.claimTurn(dispatch.turnId,this.options.workerId,this.options.leaseMs);}
    catch(error) {this.options.onError?.('claim',error);throw error;}
    if(!queued||this.dead) return 'skipped';
    const controller=new AbortController();
    const unsubscribe=await this.options.cancellations?.subscribe(queued.turn.id,event=>{if(event.state==='cancelled') controller.abort();})
      .catch(()=>undefined);
    // Lost or cancelled leases abort the provider call; renewal failures are treated as lost.
    const heartbeat=setInterval(()=>{
      void this.options.leases.renewLease(queued.turn.id,queued.fence,this.options.leaseMs)
        .then(held=>{if(!held) controller.abort();},()=>controller.abort());
    },Math.max(5,Math.floor(this.options.leaseMs/3)));
    const done=this.options.chat.executeQueued(queued,controller)
      .catch(error=>this.options.onError?.('execute',error))
      .finally(()=>{clearInterval(heartbeat);unsubscribe?.();this.inFlight.delete(queued.turn.id);});
    this.inFlight.set(queued.turn.id,{controller,heartbeat,done});
    await done;
    return 'executed';
  }
  /** Graceful: in-flight turns finish (their own timeout still applies); the delivery consumer stops taking new work. */
  async stop():Promise<void> { await Promise.all([...this.inFlight.values()].map(entry=>entry.done)); }
  /** Test hook for a crash: no further heartbeats or claims are scheduled by this worker. */
  kill():void {
    this.dead=true;
    for(const entry of this.inFlight.values()) clearInterval(entry.heartbeat);
  }
}

export interface TurnDispatcherOptions {
  leases:TurnLeaseStore; delivery:TurnDelivery; events?:TurnEvents;
  maxAttempts:number;
  /** Outbox entries younger than this are left to the API's own publish; also the re-publish interval per entry. */
  graceMs:number;
  intervalMs:number; batch?:number;
  onError?:(phase:'recover'|'dispatch',error:unknown)=>void;
}

/** Recovery loop: requeues expired leases (or fails them with WORKER_LOST) and re-publishes undelivered outbox entries. */
export class TurnDispatcher {
  private timer?:ReturnType<typeof setInterval>;
  private running?:Promise<void>;
  constructor(private readonly options:TurnDispatcherOptions) {}
  start():void {
    if(this.timer) return;
    const run=()=>{this.running??=this.tick().finally(()=>{this.running=undefined;});};
    run();this.timer=setInterval(run,this.options.intervalMs);
  }
  async stop():Promise<void> { if(this.timer) clearInterval(this.timer);this.timer=undefined;await this.running; }
  async tick():Promise<void> {
    try {
      const {failed}=await this.options.leases.recoverExpired(this.options.maxAttempts);
      for(const turnId of failed) await this.options.events?.publish({turnId,state:'failed',errorCode:'WORKER_LOST'}).catch(()=>undefined);
    } catch(error) {this.options.onError?.('recover',error);}
    try {
      for(const dispatch of await this.options.leases.pendingDispatches(this.options.graceMs,this.options.batch??500))
        await this.options.delivery.publish(dispatch);
    } catch(error) {this.options.onError?.('dispatch',error);}
  }
}
