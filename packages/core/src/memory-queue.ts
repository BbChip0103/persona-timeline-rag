import type { TurnDelivery, TurnDispatch, TurnEvent, TurnEventSource, TurnEvents } from './ports';

const key=(dispatch:TurnDispatch)=>`${dispatch.turnId}:${dispatch.seq}`;

/**
 * Single-process stand-in for the BullMQ delivery queue (tests and offline tooling).
 * Mirrors the properties the system relies on: a dispatch is accepted once while it is waiting or running (jobId
 * dedupe), a finished one can be published again (the BullMQ adapter replaces finished jobs), consumers take
 * waiting dispatches up to their concurrency, and backlog counts dispatches no consumer has taken yet.
 */
export class InMemoryTurnDelivery implements TurnDelivery {
  private readonly seen=new Set<string>();
  private readonly waiting:TurnDispatch[]=[];
  private readonly handled=new Map<string,{promise:Promise<void>;resolve:()=>void}>();
  private readonly consumers=new Set<()=>void>();
  async publish(dispatch:TurnDispatch):Promise<void> {
    if(this.seen.has(key(dispatch))) return;
    this.seen.add(key(dispatch));this.waiting.push({...dispatch});this.settledEntry(dispatch);
    for(const wake of this.consumers) wake();
  }
  async backlog():Promise<number> { return this.waiting.length; }
  /** Resolves once a consumer has finished handling this dispatch (successfully or not). */
  whenHandled(dispatch:TurnDispatch):Promise<void> { return this.settledEntry(dispatch).promise; }
  /** Starts a consumer; the returned function stops taking work and waits for in-flight handlers. */
  consume(handler:(dispatch:TurnDispatch)=>Promise<void>,options:{concurrency:number}):()=>Promise<void> {
    let running=true;const inFlight=new Set<Promise<void>>();
    const pump=()=>{
      while(running&&inFlight.size<options.concurrency&&this.waiting.length) {
        const dispatch=this.waiting.shift()!;
        const done:Promise<void>=handler(dispatch).catch(()=>undefined).finally(()=>{
          inFlight.delete(done);this.seen.delete(key(dispatch));this.settledEntry(dispatch).resolve();pump();});
        inFlight.add(done);
      }
    };
    this.consumers.add(pump);queueMicrotask(pump);
    return async()=>{running=false;this.consumers.delete(pump);await Promise.all([...inFlight]);};
  }
  private settledEntry(dispatch:TurnDispatch) {
    let entry=this.handled.get(key(dispatch));
    if(!entry){let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});entry={promise,resolve};this.handled.set(key(dispatch),entry);}
    return entry;
  }
}

/** Single-process stand-in for Redis pub/sub turn events; keeps a log for assertions. */
export class InMemoryTurnEvents implements TurnEvents, TurnEventSource {
  readonly published:TurnEvent[]=[];
  private readonly listeners=new Map<string,Set<(event:TurnEvent)=>void>>();
  async publish(event:TurnEvent):Promise<void> {
    this.published.push({...event});
    for(const listener of this.listeners.get(event.turnId)??[]) listener({...event});
  }
  async subscribe(turnId:string,listener:(event:TurnEvent)=>void):Promise<()=>void> {
    const set=this.listeners.get(turnId)??new Set();set.add(listener);this.listeners.set(turnId,set);
    return ()=>{set.delete(listener);if(!set.size)this.listeners.delete(turnId);};
  }
}
