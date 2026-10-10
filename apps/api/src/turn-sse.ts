import type { Request, Response } from 'express';
import type { MessageEvent } from '@nestjs/common';
import { SseStream } from '@nestjs/core/router/sse-stream';
import { EMPTY, Observable, Subject, Subscription, catchError, concatMap, firstValueFrom, from, fromEvent, interval, take, timeout, timer } from 'rxjs';
import type { ChatTurn } from '@ptr/contracts';
import type { ChatService, TurnEventSource } from '@ptr/core';
import { publicTurn } from './public-turn';

export interface SseOptions {
  /** Store re-check interval: covers pub/sub notices lost in transit (Redis pub/sub does not store them). */
  recheckMs:number;
  /** Comment frame interval that keeps idle proxies from closing the stream. */
  heartbeatMs:number;
  /** The server ends long streams; clients reconnect and get a fresh snapshot. */
  maxMs:number;
  /** How long to wait for the pub/sub subscription before streaming on store re-checks alone. */
  subscribeTimeoutMs:number;
}
export const DEFAULT_SSE:SseOptions={recheckMs:5000,heartbeatMs:15000,maxMs:120000,subscribeTimeoutMs:2000};
const ended=(state:ChatTurn['state'])=>state==='completed'||state==='failed'||state==='cancelled';
const RANK:Record<ChatTurn['state'],number>={pending:0,retrieving:1,generating:2,validating:3,completed:4,failed:4,cancelled:4};
type TurnFrame=MessageEvent|{comment:'ping'};

/** Nest 10 encodes JSON and handles drain. Only its unsupported comment/no-ID wire policy is adapted. */
export class ExactTurnSseStream extends SseStream {
  override writeMessage(message:TurnFrame,callback:(error:Error|null|undefined)=>void):void {
    // Prevent the SDK from inventing an event ID; the sentinel is removed before encoding.
    super.writeMessage('comment' in message?{...message,data:'',id:'internal'}:{...message,id:'internal'},callback);
  }
  override _transform(message:TurnFrame,encoding:string,callback:(error?:Error|null)=>void):void {
    if('comment' in message){this.push(': ping\n\n');callback();return;}
    super._transform({type:message.type,data:message.data},encoding,callback);
  }
}

/**
 * Pushes one turn's progress: subscribe first, then send a store snapshot (so no change between the two is missed),
 * then forward state notices; the end is always read back from the store so the reply passes the public DTO.
 * Two store reads per normal turn instead of one per client poll. If the subscription fails or is slow (Redis
 * trouble), the stream degrades to frequent store re-checks instead of failing.
 */
export async function streamTurn(chat:Pick<ChatService,'getTurn'>,events:TurnEventSource,ownerId:string,turnId:string,request:Request,response:Response,options:SseOptions):Promise<void> {
  let finished=false;let lastRank=-1;let checking:Promise<void>|undefined;let again=false;
  const clocks=new Subscription(),lifetime=new Subscription();
  const frames=new Subject<TurnFrame>();
  let stream:ExactTurnSseStream|undefined,transport:Subscription|undefined;
  let unsubscribe:(()=>void)|undefined;
  const release=()=>{const off=unsubscribe;unsubscribe=undefined;off?.();};
  const finish=()=>{if(finished)return;finished=true;clocks.unsubscribe();release();frames.complete();};
  const cancelTransport=()=>{
    finished=true;clocks.unsubscribe();release();transport?.unsubscribe();frames.complete();stream?.destroy();lifetime.unsubscribe();
  };
  const hardStop=()=>{
    const blocked=response.writableNeedDrain||response.writableLength>0;
    cancelTransport();
    // Ending the encoder is not enough: an undraining destination never receives its EOF.
    if(blocked)response.destroy();
    else if(!response.writableEnded)response.end();
  };
  // Registered before any await: a client that leaves early still releases everything below.
  lifetime.add(fromEvent(response,'close').pipe(take(1)).subscribe(cancelTransport));
  try {await chat.getTurn(ownerId,turnId);} // NOT_FOUND remains JSON before any SSE headers.
  catch(error){lifetime.unsubscribe();throw error;}
  if(finished||request.destroyed){finish();lifetime.unsubscribe();return;}
  const send=(event:'turn'|'state',data:Record<string,unknown>|ChatTurn)=>{if(!finished)frames.next({type:event,data});};
  const forward=(state:ChatTurn['state'])=>{if(RANK[state]>lastRank){lastRank=RANK[state];send('state',{state});}}; // never backwards
  const sync=():Promise<void>=>{
    if(checking){again=true;return checking;} // a newer notice arrived mid-read: read again afterwards
    checking=chat.getTurn(ownerId,turnId).then(turn=>{
      if(finished)return;
      if(ended(turn.state)){send('turn',publicTurn(turn));finish();}
      else forward(turn.state);
    }).catch(()=>finish()).finally(()=>{checking=undefined;if(again&&!finished){again=false;void sync();}});
    return checking;
  };
  // Until the snapshot is out, notices are only remembered: the snapshot covers them, and a frame never precedes it.
  let started=false,endedEarly=false;
  const listener=(event:{state:ChatTurn['state']})=>{
    if(!started){endedEarly||=ended(event.state);return;}
    if(ended(event.state)) void sync(); // the final reply comes from the store, never from the notice
    else forward(event.state);
  };
  let subscribed=false;
  const subscription=events.subscribe(turnId,listener);
  try {
    unsubscribe=await firstValueFrom(from(subscription).pipe(timeout(options.subscribeTimeoutMs)));
    subscribed=true;
  } catch {
    // Degraded: store re-checks only. A subscription that still resolves later is released at once.
    subscription.then(off=>off(),()=>undefined);
  }
  if(finished){release();return;}
  stream=new ExactTurnSseStream(request);
  stream.on('error',hardStop);
  stream.pipe(response);
  const writer=stream;
  transport=frames.pipe(
    concatMap(frame=>new Observable<void>(subscriber=>{
      writer.writeMessage(frame,error=>{if(error)subscriber.error(error);else subscriber.complete();});
    })),
    // Never invoke Nest's default SSE error path, which sends Error.message to the client.
    catchError(()=>EMPTY),
  ).subscribe({complete:()=>{clocks.unsubscribe();release();writer.end();}});
  // Keep this bound alive while a final frame drains, even after logical completion stops polling.
  lifetime.add(timer(options.maxMs).subscribe(hardStop));
  const snapshot=await chat.getTurn(ownerId,turnId).catch(()=>undefined);
  if(!snapshot||finished){finish();return;}
  lastRank=RANK[snapshot.state];send('turn',publicTurn(snapshot));started=true;
  if(ended(snapshot.state)){finish();return;}
  if(endedEarly) void sync();
  clocks.add(interval(subscribed?options.recheckMs:Math.min(options.recheckMs,1000)).subscribe(()=>void sync()));
  clocks.add(interval(options.heartbeatMs).subscribe(()=>{if(!finished)frames.next({comment:'ping'});}));
}
