import { FrameworkTurnWorker, WorkerOutboxMaintenance } from '../src/turn-worker';
import { LEASE_LOST, type QueuedTurn, type TurnExecutionStore } from '../src/ports';
import type { ChatService } from '../src/chat-service';
const queued:QueuedTurn={turn:{id:'synthetic-turn',sessionId:'synthetic-session',ownerId:'synthetic-owner',clientRequestId:'c1',userText:'hello',sequence:1,state:'pending',createdAt:new Date().toISOString()},input:{sessionId:'synthetic-session',clientRequestId:'c1',text:'hello'},fence:{workerId:'worker-token',attempt:1}};
const dispatch={turnId:queued.turn.id,seq:0};
function executions() {
  return {claimExecution:jest.fn<ReturnType<TurnExecutionStore['claimExecution']>,Parameters<TurnExecutionStore['claimExecution']>>(async()=>queued),
    executionStatus:jest.fn<ReturnType<TurnExecutionStore['executionStatus']>,Parameters<TurnExecutionStore['executionStatus']>>(async()=>'current'),
    executionDispatches:jest.fn<ReturnType<TurnExecutionStore['executionDispatches']>,Parameters<TurnExecutionStore['executionDispatches']>>(async()=>[]),
    repairExecution:jest.fn<ReturnType<TurnExecutionStore['repairExecution']>,Parameters<TurnExecutionStore['repairExecution']>>(async()=>undefined),
    expireQueued:jest.fn<ReturnType<TurnExecutionStore['expireQueued']>,Parameters<TurnExecutionStore['expireQueued']>>(async()=>[])};
}
describe('BullMQ execution and DB-only fencing',()=>{
  test('claim receives unique lock token, never schedules DB heartbeat',async()=>{
    const db=executions(),executeQueued=jest.fn(async()=>undefined),timer=jest.spyOn(global,'setInterval');
    const worker=new FrameworkTurnWorker({chat:{executeQueued} as unknown as ChatService,executions:db,workerId:'worker',maxQueueMs:60000,maxAttempts:3});
    await expect(worker.handle(dispatch,'token')).resolves.toBe('executed');
    expect(db.claimExecution).toHaveBeenCalledWith(dispatch,'worker-token',60000,3);expect(timer).not.toHaveBeenCalled();timer.mockRestore();
  });
  test('terminal/stale delivery refused by DB never executes',async()=>{
    const db=executions();db.claimExecution.mockResolvedValueOnce(undefined);const executeQueued=jest.fn();
    const worker=new FrameworkTurnWorker({chat:{executeQueued} as unknown as ChatService,executions:db,workerId:'worker',maxQueueMs:60000,maxAttempts:3});
    expect(await worker.handle(dispatch,'token')).toBe('skipped');expect(executeQueued).not.toHaveBeenCalled();
  });
  test('framework lock loss uses no-write abort reason',async()=>{
    let controller:AbortController|undefined;
    const executeQueued=jest.fn(async(_q:QueuedTurn,c:AbortController)=>{controller=c;await new Promise<void>(resolve=>c.signal.addEventListener('abort',()=>resolve(),{once:true}));});
    const worker=new FrameworkTurnWorker({chat:{executeQueued} as unknown as ChatService,executions:executions(),workerId:'worker',maxQueueMs:60000,maxAttempts:3});
    const done=worker.handle(dispatch,'token');await new Promise(resolve=>setImmediate(resolve));
    expect(worker.activeTurns).toBe(1);worker.loseLock('token');await done;expect(controller?.signal.reason).toBe(LEASE_LOST);expect(worker.activeTurns).toBe(0);
  });
  test('cancellation committed before subscribe ACK is rechecked before starting a model',async()=>{
    const db=executions();db.executionStatus.mockResolvedValue('cancelled');const executeQueued=jest.fn();
    const worker=new FrameworkTurnWorker({chat:{executeQueued} as unknown as ChatService,executions:db,workerId:'worker',maxQueueMs:60000,maxAttempts:3,
      cancellations:{subscribe:async()=>()=>undefined}});
    await worker.handle(dispatch,'token');expect(executeQueued).not.toHaveBeenCalled();expect(db.executionStatus).toHaveBeenCalledWith(queued.turn.id,queued.fence);
  });
  test.each(['missing ACK','Redis outage'])('%s cannot hide DB cancellation from an active provider',async mode=>{
    const db=executions();let controller:AbortController|undefined;
    const executeQueued=jest.fn(async(_q:QueuedTurn,c:AbortController)=>{controller=c;db.executionStatus.mockResolvedValue('cancelled');
      await new Promise<void>(resolve=>c.signal.addEventListener('abort',()=>resolve(),{once:true}));});
    const worker=new FrameworkTurnWorker({chat:{executeQueued} as unknown as ChatService,executions:db,workerId:'worker',maxQueueMs:60000,maxAttempts:3,cancellationPollMs:5,
      cancellations:{subscribe:()=>mode==='missing ACK'?new Promise(()=>undefined):Promise.reject(new Error('synthetic outage'))}});
    await worker.handle(dispatch,'token');expect(controller?.signal.aborted).toBe(true);expect(controller?.signal.reason).not.toBe(LEASE_LOST);
    const reads=db.executionStatus.mock.calls.length;await new Promise(resolve=>setTimeout(resolve,20));expect(db.executionStatus).toHaveBeenCalledTimes(reads);expect(worker.activeTurns).toBe(0);
  });
  test('subscribe ACK immediately closes cancellation race without waiting for polling',async()=>{
    const db=executions();let ack!:(off:()=>void)=>void,controller:AbortController|undefined;const off=jest.fn();
    const executeQueued=jest.fn(async(_q:QueuedTurn,c:AbortController)=>{controller=c;db.executionStatus.mockResolvedValue('cancelled');ack(off);
      await new Promise<void>(resolve=>c.signal.addEventListener('abort',()=>resolve(),{once:true}));});
    const worker=new FrameworkTurnWorker({chat:{executeQueued} as unknown as ChatService,executions:db,workerId:'worker',maxQueueMs:60000,maxAttempts:3,cancellationPollMs:1000,
      cancellations:{subscribe:()=>new Promise(resolve=>{ack=resolve;})}});
    await worker.handle(dispatch,'token');expect(controller?.signal.aborted).toBe(true);expect(off).toHaveBeenCalledTimes(1);
  });
  test.each(['lost','read outage'])('%s aborts conservatively without renewing or writing ownership',async mode=>{
    const db=executions();let controller:AbortController|undefined;
    const executeQueued=jest.fn(async(_q:QueuedTurn,c:AbortController)=>{controller=c;if(mode==='lost')db.executionStatus.mockResolvedValue('lost');else db.executionStatus.mockRejectedValue(new Error('synthetic DB outage'));
      await new Promise<void>(resolve=>c.signal.addEventListener('abort',()=>resolve(),{once:true}));});
    const worker=new FrameworkTurnWorker({chat:{executeQueued} as unknown as ChatService,executions:db,workerId:'worker',maxQueueMs:60000,maxAttempts:3,cancellationPollMs:5});
    await worker.handle(dispatch,'token');expect(controller?.signal.reason).toBe(LEASE_LOST);expect(db.claimExecution).toHaveBeenCalledTimes(1);expect(db.repairExecution).not.toHaveBeenCalled();
  });
});
describe('worker-local durable outbox',()=>{
  function fixture(stateValue='unknown',fenced=false) {
    const db=executions();db.executionDispatches.mockResolvedValue([{...dispatch,...(fenced?{fence:queued.fence}:{})}]);
    const delivery={publish:jest.fn(async()=>undefined),backlog:async()=>0},state=jest.fn(async()=>stateValue);
    const onEvent=jest.fn();
    const maintenance=new WorkerOutboxMaintenance({executions:db,delivery,state,maxQueueMs:60000,maxAttempts:3,graceMs:2000,intervalMs:1000,onEvent});return {db,delivery,state,maintenance,onEvent};
  }
  test('committed request lost before enqueue is republished without advancing token',async()=>{
    const {db,delivery,maintenance}=fixture();await maintenance.tick();expect(delivery.publish).toHaveBeenCalledWith(dispatch);expect(db.repairExecution).not.toHaveBeenCalled();
  });
  test.each(['active','waiting','delayed','prioritized'])('%s belongs to framework, no second recovery timer',async state=>{
    const {db,delivery,maintenance}=fixture(state,true);await maintenance.tick();expect(db.repairExecution).not.toHaveBeenCalled();expect(delivery.publish).not.toHaveBeenCalled();
  });
  test.each(['unknown','completed'])('%s while DB nonterminal CAS-invalidates old owner before redispatch',async state=>{
    const {db,delivery,maintenance}=fixture(state,true);db.repairExecution.mockResolvedValue({...dispatch,seq:1});await maintenance.tick();
    expect(db.repairExecution).toHaveBeenCalledWith({...dispatch,fence:queued.fence},3);expect(delivery.publish).toHaveBeenCalledWith({...dispatch,seq:1});
  });
  test('unreachable Redis is not missing Redis state',async()=>{
    const {db,state,delivery,maintenance}=fixture('unknown',true);state.mockRejectedValue(new Error('unreachable'));await expect(maintenance.tick()).rejects.toThrow('unreachable');expect(db.repairExecution).not.toHaveBeenCalled();expect(delivery.publish).not.toHaveBeenCalled();
  });
  test('failed job with nonterminal DB is repaired under the bounded DB generation budget',async()=>{
    const {db,delivery,maintenance}=fixture('failed',true);await maintenance.tick();expect(db.repairExecution).toHaveBeenCalledWith({...dispatch,fence:queued.fence},3);expect(delivery.publish).not.toHaveBeenCalled();
  });
  test('maintenance reports expiry, outbox republish and recovery only after successful DB/queue actions',async()=>{
    const missing=fixture();missing.db.expireQueued.mockResolvedValue([{turnId:'synthetic-expired',errorCode:'QUEUE_TIMEOUT'}]);await missing.maintenance.tick();
    expect(missing.onEvent.mock.calls.map(([event])=>event)).toEqual([{type:'failed',turnId:'synthetic-expired',errorCode:'QUEUE_TIMEOUT'},{type:'republished',turnId:dispatch.turnId}]);
    const recover=fixture('completed',true);recover.db.repairExecution.mockResolvedValue({...dispatch,seq:1});await recover.maintenance.tick();expect(recover.onEvent).toHaveBeenCalledWith({type:'requeued',turnId:dispatch.turnId});
    const unavailable=fixture();unavailable.delivery.publish.mockRejectedValue(new Error('synthetic outage'));await expect(unavailable.maintenance.tick()).rejects.toThrow('synthetic outage');expect(unavailable.onEvent).not.toHaveBeenCalled();
  });
});
