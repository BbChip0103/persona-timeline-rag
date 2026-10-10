import { createRuntime } from '../src/runtime';
import { FrameworkTelemetry } from '@ptr/ops';
import type { QueuedTurn, ConversationStore } from '@ptr/core';
import type { ChatReply } from '@ptr/contracts';
const env={DATABASE_URL:'postgresql://ptr_framework_tester:synthetic-password@127.0.0.1:57432/ptr_framework_test',
  PTR_REDIS_URL:'redis://:synthetic-password@127.0.0.1:57479/0',PTR_CHAT_PROVIDER:'fake'};
test('root turn telemetry records sanitized terminal outcome even though executeQueued returns void',async()=>{
  const outputs:unknown[]=[];
  const updates:unknown[]=[];
  const telemetry={turn:jest.fn(async(_ctx:unknown,work:(span:{update:(values:unknown)=>void})=>Promise<unknown>)=>{const output=await work({update:values=>updates.push(values)});outputs.push(output);return output;}),stage:jest.fn(),shutdown:jest.fn(async()=>{})};
  const runtime=createRuntime(env,{telemetry:telemetry as unknown as FrameworkTelemetry});
  const queued={turn:{id:'synthetic-turn',sessionId:'synthetic-session',ownerId:'synthetic-owner'},input:{text:'synthetic input'},fence:{workerId:'w',attempt:1}} as QueuedTurn;
  const session=jest.spyOn(runtime.executionStore as unknown as ConversationStore,'getOwnedSession').mockResolvedValue({personId:'synthetic-person',personaRevision:'v1'} as never);
  const getTurn=jest.spyOn(runtime.executionStore as unknown as ConversationStore,'getTurn').mockResolvedValue({state:'completed',reply:{status:'answered',content:'private-sentinel',limitations:[],replyGuard:{action:'none'},inputSafety:{action:'none'},agent:{steps:[]}} as unknown as ChatReply} as never);
  const options=(runtime.chat as unknown as {options:{observeTurn:<T>(input:QueuedTurn,work:()=>Promise<T>)=>Promise<T>}}).options;
  try {
    await options.observeTurn(queued,async()=>undefined);
    expect(updates[0]).toMatchObject({metadata:{outcome:'completed'}});
    expect((updates[0] as {metadata:unknown}).metadata).toMatchObject({state:'completed',outcome:'completed',status:'answered',guard:'none',safety:'none'});
    expect(JSON.stringify(updates)).not.toContain('private-sentinel');
    getTurn.mockResolvedValue({state:'failed',errorCode:'TURN_FAILED'} as never);
    await options.observeTurn(queued,async()=>undefined);expect((updates[1] as {metadata:unknown}).metadata).toMatchObject({outcome:'failed',errorCode:'TURN_FAILED'});
    getTurn.mockImplementation(async()=>{throw new Error('private-error-sentinel');});
    await options.observeTurn(queued,async()=>undefined);expect((updates[2] as {metadata:unknown}).metadata).toMatchObject({state:'unknown',outcome:'interrupted'});
  } finally {session.mockRestore();getTurn.mockRestore();await runtime.close?.();}
});
