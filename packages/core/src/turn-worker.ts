import type { ChatService } from './chat-service';
import { LEASE_LOST, type TurnDelivery, type TurnDispatch, type TurnEventSource, type TurnEvents, type TurnLeaseStore } from './ports';

export interface TurnWorkerOptions {
  chat:ChatService; leases:TurnLeaseStore; workerId:string;
  /** Lease length; heartbeats renew at a third of it. The dispatcher requeues turns whose lease expired. */
  leaseMs:number;
  /** Cancellation notices abort the provider call at once; the lease heartbeat stays as the backstop. */
  cancellations?:TurnEventSource;
  /** PTR_TURN_MAX_QUEUE_MS: a turn that waited longer than this since it was last queued is not claimed (the dispatcher fails it). Unset = no limit. */
  maxQueueMs?:number;
  onError?:(phase:'claim'|'execute',error:unknown)=>void;
  /** Observability: a claimed turn ended here; queue wait = claim − creation (a requeued turn counts from creation). */
  onFinished?:(event:{turnId:string;queueWaitMs:number;durationMs:number})=>void;
}

/**
 * Historical/local test harness only; production uses FrameworkTurnWorker with no Postgres heartbeat.
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
    try {queued=await this.options.leases.claimTurn(dispatch.turnId,this.options.workerId,this.options.leaseMs,this.options.maxQueueMs);}
    catch(error) {this.options.onError?.('claim',error);throw error;}
    if(!queued||this.dead) return 'skipped';
    const claimedAt=Date.now();
    const controller=new AbortController();
    // Heartbeat first, so nothing else (e.g. a slow Redis subscribe) can let the lease lapse. A single failed renewal
    // is tolerated (transient DB trouble); a lost lease or two failures in a row abort the provider call with
    // LEASE_LOST, which leaves the turn to recovery (a requeue with the next attempt) instead of failing it here.
    let renewFailures=0;
    const heartbeat=setInterval(()=>{
      void this.options.leases.renewLease(queued.turn.id,queued.fence,this.options.leaseMs)
        .then(held=>{renewFailures=0;if(!held) controller.abort(LEASE_LOST);},()=>{if(++renewFailures>=2) controller.abort(LEASE_LOST);});
    },Math.max(5,Math.floor(this.options.leaseMs/3)));
    // Cancellation notices are an accelerator, not a dependency: never awaited.
    let unsubscribe:(()=>void)|undefined;let finished=false;
    void this.options.cancellations?.subscribe(queued.turn.id,event=>{if(event.state==='cancelled') controller.abort();})
      .then(off=>{if(finished) off();else unsubscribe=off;},()=>undefined);
    const done=this.options.chat.executeQueued(queued,controller)
      .catch(error=>this.options.onError?.('execute',error))
      .finally(()=>{
        finished=true;clearInterval(heartbeat);unsubscribe?.();this.inFlight.delete(queued.turn.id);
        this.options.onFinished?.({turnId:queued.turn.id,queueWaitMs:Math.max(0,claimedAt-Date.parse(queued.turn.createdAt)),durationMs:Date.now()-claimedAt});
      });
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
  /** Lease drift repair (reconcileLeases), run at most once per intervalMs; graceMs should be at least one lease. */
  reconcile?:{intervalMs:number;graceMs:number};
  /**
   * PTR_TURN_MAX_QUEUE_MS: pending turns no worker holds fail once they waited this long since they were last queued
   * (QUEUE_TIMEOUT, or WORKER_LOST for a requeued one). Unset = no limit.
   */
  maxQueueMs?:number;
  onError?:(phase:'recover'|'reconcile'|'expire'|'dispatch',error:unknown)=>void;
  /** Observability: each requeue, failure (with its code) and outbox re-publish, by turn id. */
  onEvent?:(event:TurnDispatcherEvent)=>void;
}
export type TurnDispatcherEvent={type:'requeued';turnId:string}|{type:'failed';turnId:string;errorCode:'WORKER_LOST'|'QUEUE_TIMEOUT'}|{type:'republished';turnId:string};

/**
 * Historical/local lease harness only; the default production worker uses WorkerOutboxMaintenance.
 * Recovery loop: requeues expired leases (or fails them with WORKER_LOST), fails turns that waited too long for a
 * worker (QUEUE_TIMEOUT; WORKER_LOST for a requeued one) and re-publishes undelivered outbox entries.
 */
export class TurnDispatcher {
  private timer?:ReturnType<typeof setInterval>;
  private running?:Promise<void>;
  private reconciledAt=0;
  constructor(private readonly options:TurnDispatcherOptions) {}
  start():void {
    if(this.timer) return;
    const run=()=>{this.running??=this.tick().finally(()=>{this.running=undefined;});};
    run();this.timer=setInterval(run,this.options.intervalMs);
  }
  async stop():Promise<void> { if(this.timer) clearInterval(this.timer);this.timer=undefined;await this.running; }
  async tick():Promise<void> {
    const report=this.options.onEvent??(()=>undefined);
    const recovered=async({requeued,failed}:{requeued:string[];failed:string[]})=>{
      for(const turnId of requeued) report({type:'requeued',turnId});
      for(const turnId of failed) {
        report({type:'failed',turnId,errorCode:'WORKER_LOST'});
        await this.options.events?.publish({turnId,state:'failed',errorCode:'WORKER_LOST'}).catch(()=>undefined);
      }
    };
    try {await recovered(await this.options.leases.recoverExpired(this.options.maxAttempts));}
    catch(error) {this.options.onError?.('recover',error);}
    const reconcile=this.options.reconcile;
    if(reconcile&&Date.now()-this.reconciledAt>=reconcile.intervalMs) {
      this.reconciledAt=Date.now();
      try {await recovered(await this.options.leases.reconcileLeases(this.options.maxAttempts,reconcile.graceMs));}
      catch(error) {this.options.onError?.('reconcile',error);}
    }
    if(this.options.maxQueueMs!==undefined) try {
      for(const {turnId,errorCode} of await this.options.leases.expireQueued(this.options.maxQueueMs)) {
        report({type:'failed',turnId,errorCode});
        await this.options.events?.publish({turnId,state:'failed',errorCode}).catch(()=>undefined);
      }
    } catch(error) {this.options.onError?.('expire',error);}
    try {
      for(const dispatch of await this.options.leases.pendingDispatches(this.options.graceMs,this.options.batch??500)) {
        await this.options.delivery.publish(dispatch);report({type:'republished',turnId:dispatch.turnId});
      }
    } catch(error) {this.options.onError?.('dispatch',error);}
  }
}

/** Framework execution: no DB heartbeat, lease expiry or retry loop. BullMQ owns those responsibilities. */
export class FrameworkTurnWorker {
  private readonly inFlight=new Map<string,{controller:AbortController;done:Promise<void>}>();
  constructor(private readonly options:Omit<TurnWorkerOptions,'leases'|'leaseMs'>&{
    executions:import('./ports').TurnExecutionStore;maxAttempts:number;maxQueueMs:number;
    /** Read-only cancellation/generation checks; this never renews DB or queue ownership. Default 500 ms. */
    cancellationPollMs?:number;
  }) {}
  get activeTurns():number {return this.inFlight.size;}
  async handle(dispatch:TurnDispatch,executionId:string):Promise<'executed'|'skipped'> {
    const queued=await this.options.executions.claimExecution(dispatch,`${this.options.workerId}-${executionId}`,this.options.maxQueueMs,this.options.maxAttempts);
    if(!queued) return 'skipped';
    const started=Date.now(),controller=new AbortController();
    let off:(()=>void)|undefined,finished=false,poll:ReturnType<typeof setTimeout>|undefined;
    let read:Promise<void>|undefined,failures=0;
    const check=():Promise<void>=>{
      if(finished||controller.signal.aborted)return Promise.resolve();
      return read??=(async()=>{
        let deadline:ReturnType<typeof setTimeout>|undefined;
        try {
          const status=await Promise.race([this.options.executions.executionStatus(queued.turn.id,queued.fence),
            new Promise<never>((_resolve,reject)=>{deadline=setTimeout(()=>reject(new Error('EXECUTION_STATUS_TIMEOUT')),1000);})]);
          failures=0;
          if(status==='cancelled')controller.abort();else if(status==='lost')controller.abort(LEASE_LOST);
        } catch {if(++failures>=2)controller.abort(LEASE_LOST);}
        finally {clearTimeout(deadline);}
      })().finally(()=>{read=undefined;});
    };
    const schedule=()=>{
      if(!finished&&!controller.signal.aborted)poll=setTimeout(()=>{
        void check().finally(schedule);
      },Math.max(5,Math.min(1000,this.options.cancellationPollMs??500)));
    };
    void this.options.cancellations?.subscribe(queued.turn.id,event=>{if(event.state==='cancelled')controller.abort();})
      .then(unsubscribe=>{if(finished)unsubscribe();else {off=unsubscribe;void check();}},()=>undefined);
    const done=(async()=>{
      await check();
      if(controller.signal.aborted)return;
      schedule();await this.options.chat.executeQueued(queued,controller);
    })().finally(()=>{
      finished=true;clearTimeout(poll);off?.();this.inFlight.delete(executionId);
      this.options.onFinished?.({turnId:queued.turn.id,queueWaitMs:Math.max(0,started-Date.parse(queued.turn.createdAt)),durationMs:Date.now()-started});
    });
    this.inFlight.set(executionId,{controller,done});
    await done;return 'executed';
  }
  /** Called on the framework's lock-loss notification. No DB writes occur on this abort path. */
  loseLock(executionId:string):void {this.inFlight.get(executionId)?.controller.abort(LEASE_LOST);}
  async stop():Promise<void> {await Promise.all([...this.inFlight.values()].map(entry=>entry.done));}
}

/** Worker-local outbox reconciliation. Queue state, not a second lease clock, decides redispatch. */
export class WorkerOutboxMaintenance {
  private timer?:ReturnType<typeof setInterval>;
  private running?:Promise<void>;
  constructor(private readonly options:{executions:import('./ports').TurnExecutionStore;delivery:TurnDelivery;
    state(dispatch:TurnDispatch):Promise<string>;events?:TurnEvents;maxQueueMs:number;maxAttempts:number;
    graceMs:number;intervalMs:number;batch?:number;onError?:(error:unknown)=>void;onEvent?:(event:TurnDispatcherEvent)=>void}) {}
  start():void {
    if(this.timer)return;
    const run=()=>{this.running??=this.tick().catch(error=>this.options.onError?.(error)).finally(()=>{this.running=undefined;});};
    run();this.timer=setInterval(run,this.options.intervalMs);
  }
  async stop():Promise<void> {clearInterval(this.timer);this.timer=undefined;await this.running;}
  async tick():Promise<void> {
    for(const {turnId,errorCode} of await this.options.executions.expireQueued(this.options.maxQueueMs)) {
      await this.options.events?.publish({turnId,state:'failed',errorCode}).catch(()=>undefined);
      this.options.onEvent?.({type:'failed',turnId,errorCode});
    }
    for(const entry of await this.options.executions.executionDispatches(this.options.graceMs,this.options.batch??500)) {
      // A Redis command failure is not evidence that a job disappeared: leave DB generation untouched.
      const state=await this.options.state(entry);
      if(['active','waiting','wait','delayed','prioritized','waiting-children'].includes(state)) continue;
      if(state==='unknown'&&!entry.fence) {await this.options.delivery.publish(entry);this.options.onEvent?.({type:'republished',turnId:entry.turnId});continue;}
      if(!['unknown','completed','failed'].includes(state)) continue;
      const next=await this.options.executions.repairExecution(entry,this.options.maxAttempts);
      if(next) {await this.options.delivery.publish(next);this.options.onEvent?.({type:'requeued',turnId:next.turnId});}
    }
  }
}
