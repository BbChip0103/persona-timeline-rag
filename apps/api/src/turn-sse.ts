import type { Request, Response } from 'express';
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

/**
 * Pushes one turn's progress: subscribe first, then send a store snapshot (so no change between the two is missed),
 * then forward state notices; the end is always read back from the store so the reply passes the public DTO.
 * Two store reads per normal turn instead of one per client poll. If the subscription fails or is slow (Redis
 * trouble), the stream degrades to frequent store re-checks instead of failing.
 */
export async function streamTurn(chat:Pick<ChatService,'getTurn'>,events:TurnEventSource,ownerId:string,turnId:string,request:Request,response:Response,options:SseOptions):Promise<void> {
  let finished=false;let lastRank=-1;let checking:Promise<void>|undefined;let again=false;
  const timers:ReturnType<typeof setInterval>[]=[];
  let unsubscribe:(()=>void)|undefined;
  const finish=()=>{if(finished)return;finished=true;timers.forEach(clearInterval);unsubscribe?.();if(response.headersSent&&!response.writableEnded)response.end();};
  // Registered before any await: a client that leaves early still releases everything below.
  response.on('close',finish);
  await chat.getTurn(ownerId,turnId); // ownership check before any stream starts: NOT_FOUND stays a JSON 404
  if(finished||request.destroyed){finish();return;}
  const send=(event:'turn'|'state',data:unknown)=>{if(!finished)response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
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
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    unsubscribe=await Promise.race([subscription,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('SUBSCRIBE_TIMEOUT')),options.subscribeTimeoutMs);})]);
    subscribed=true;
  } catch {
    // Degraded: store re-checks only. A subscription that still resolves later is released at once.
    subscription.then(off=>off(),()=>undefined);
  } finally {clearTimeout(timer);}
  if(finished){unsubscribe?.();return;}
  response.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
  response.flushHeaders();
  const snapshot=await chat.getTurn(ownerId,turnId).catch(()=>undefined);
  if(!snapshot||finished){finish();return;}
  lastRank=RANK[snapshot.state];send('turn',publicTurn(snapshot));started=true;
  if(ended(snapshot.state)){finish();return;}
  if(endedEarly) void sync();
  timers.push(setInterval(()=>void sync(),subscribed?options.recheckMs:Math.min(options.recheckMs,1000)));
  timers.push(setInterval(()=>{if(!finished)response.write(': ping\n\n');},options.heartbeatMs));
  timers.push(setInterval(finish,options.maxMs));
}
