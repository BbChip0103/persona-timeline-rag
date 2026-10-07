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
}
export const DEFAULT_SSE:SseOptions={recheckMs:5000,heartbeatMs:15000,maxMs:120000};
const ended=(state:ChatTurn['state'])=>state==='completed'||state==='failed'||state==='cancelled';

/**
 * Pushes one turn's progress: subscribe first, then send a store snapshot (so no change between the two is missed),
 * then forward state notices; the end is always read back from the store so the reply passes the public DTO.
 * Two store reads per normal turn instead of one per client poll.
 */
export async function streamTurn(chat:ChatService,events:TurnEventSource,ownerId:string,turnId:string,request:Request,response:Response,options:SseOptions):Promise<void> {
  await chat.getTurn(ownerId,turnId); // ownership check before any stream starts: NOT_FOUND stays a JSON 404
  let finished=false;let lastState:string|undefined;let checking:Promise<void>|undefined;
  const timers:ReturnType<typeof setInterval>[]=[];
  let unsubscribe:(()=>void)|undefined;
  const finish=()=>{if(finished)return;finished=true;timers.forEach(clearInterval);unsubscribe?.();response.end();};
  const send=(event:'turn'|'state',data:unknown)=>{if(!finished)response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);};
  const sync=()=>{checking??=chat.getTurn(ownerId,turnId).then(turn=>{
    if(finished)return;
    if(ended(turn.state)){send('turn',publicTurn(turn));finish();}
    else if(turn.state!==lastState){lastState=turn.state;send('state',{state:turn.state});}
  }).catch(()=>finish()).finally(()=>{checking=undefined;});return checking;};
  request.on('close',finish);
  response.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});
  response.flushHeaders();
  // Until the snapshot is out, notices are only remembered: the snapshot covers them, and a frame never precedes it.
  let started=false,endedEarly=false;
  unsubscribe=await events.subscribe(turnId,event=>{
    if(!started){endedEarly||=ended(event.state);return;}
    if(ended(event.state)) void sync(); // the final reply comes from the store, never from the notice
    else if(event.state!==lastState){lastState=event.state;send('state',{state:event.state});}
  });
  if(finished){unsubscribe();return;}
  const snapshot=await chat.getTurn(ownerId,turnId).catch(()=>undefined);
  if(!snapshot){finish();return;}
  lastState=snapshot.state;send('turn',publicTurn(snapshot));started=true;
  if(ended(snapshot.state)){finish();return;}
  if(endedEarly) void sync();
  timers.push(setInterval(()=>void sync(),options.recheckMs));
  timers.push(setInterval(()=>{if(!finished)response.write(': ping\n\n');},options.heartbeatMs));
  timers.push(setInterval(finish,options.maxMs));
}
