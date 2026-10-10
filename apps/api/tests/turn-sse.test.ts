import { SseStream } from '@nestjs/core/router/sse-stream';
import { once } from 'node:events';
import { Writable } from 'node:stream';
import type { Request, Response } from 'express';
import type { ChatTurn } from '@ptr/contracts';
import { ExactTurnSseStream, streamTurn } from '../src/turn-sse';

test('real Nest SSE encoder preserves event JSON and comments without new wire IDs',async()=>{
  const encoder=jest.spyOn(SseStream.prototype,'_transform');
  const stream=new ExactTurnSseStream();const chunks:string[]=[];
  stream.on('data',chunk=>chunks.push(String(chunk)));
  const write=(value:Parameters<typeof stream.writeMessage>[0])=>new Promise<void>((resolve,reject)=>stream.writeMessage(value,error=>error?reject(error):resolve()));
  try {
    await write({type:'turn',data:{state:'pending',text:'synthetic\ntext'}});
    await write({comment:'ping'});
    await write({type:'state',data:{state:'generating'}});
    expect(encoder).toHaveBeenCalledTimes(2);
    expect(chunks.join('')).toBe('event: turn\ndata: {"state":"pending","text":"synthetic\\ntext"}\n\n: ping\n\nevent: state\ndata: {"state":"generating"}\n\n');
    expect(chunks.join('')).not.toContain('id:');
  } finally {stream.destroy();encoder.mockRestore();}
});

test('real Nest writeMessage waits for drain instead of advancing on backpressure',async()=>{
  const stream=new ExactTurnSseStream();
  // Let the real SDK implement its drain handling; only simulate a saturated writable buffer.
  const write=jest.spyOn(stream,'write').mockReturnValue(false);
  let completed=false;
  const waiting=new Promise<void>((resolve,reject)=>stream.writeMessage({type:'state',data:{state:'pending'}},error=>{completed=true;error?reject(error):resolve();}));
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(completed).toBe(false);
  stream.emit('drain');await waiting;
  expect(completed).toBe(true);expect(write).toHaveBeenCalledTimes(1);
  write.mockRestore();stream.destroy();
});

test('native SSE stream drains an actual slow Writable before settling queued frames',async()=>{
  let resume=false;let held:(()=>void)|undefined;
  const destination=new Writable({highWaterMark:1,write(_chunk,_encoding,callback){if(resume)callback();else held=callback;}});
  const stream=new ExactTurnSseStream();stream.setMaxListeners(0); // Synthetic concurrent saturation, production serializes writes.
  const writes=jest.spyOn(stream,'write');stream.pipe(destination);
  let completed=0;
  const pending=Array.from({length:64},(_,index)=>new Promise<void>((resolve,reject)=>stream.writeMessage({type:'state',data:{index}},error=>{completed++;error?reject(error):resolve();})));
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(writes.mock.results.some(result=>result.value===false)).toBe(true);expect(completed).toBeLessThan(64);
  resume=true;held?.();await Promise.all(pending);
  const done=once(destination,'finish');stream.end();await done;
  expect(completed).toBe(64);writes.mockRestore();
});

test.each(['pending','completed'] as const)('maximum duration hard-stops an undraining response, including a queued %s snapshot',async(state)=>{
  const response=new Writable({highWaterMark:1,write(_chunk,_encoding,_callback){/* Intentionally never drain. */}}) as Writable&Response;
  response.writeHead=jest.fn().mockReturnValue(response);response.flushHeaders=jest.fn();
  const turn:ChatTurn={id:'synthetic-turn',sessionId:'synthetic-session',ownerId:'synthetic-owner',clientRequestId:'synthetic-request',userText:'synthetic',sequence:1,state,createdAt:'2020-01-01T00:00:00Z'};
  const off=jest.fn();
  try {
    await streamTurn({getTurn:async()=>turn},{subscribe:async()=>off},turn.ownerId,turn.id,{destroyed:false} as Request,response,{recheckMs:10,heartbeatMs:10,maxMs:30,subscribeTimeoutMs:10});
    await new Promise(resolve=>setTimeout(resolve,100));
    expect(off).toHaveBeenCalledTimes(1);
    expect(response.destroyed||response.writableEnded).toBe(true);
  } finally {response.destroy();}
});
