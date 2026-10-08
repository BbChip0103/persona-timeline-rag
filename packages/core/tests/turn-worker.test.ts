import type { Persona } from '@ptr/contracts';
import { ChatService, CoreError, InMemoryConversationStore, InMemoryPersonaRepository, InMemoryTurnDelivery, InMemoryTurnEvents, TurnDispatcher, TurnWorker, createLocalChat, type TextProvider } from '../src';

const persona:Persona={id:'persona_synthetic_q',personId:'person_synthetic_q',label:'Synthetic Q',language:'ko',revision:'v1',reviewStatus:'synthetic',identity:'Fictional',concept:'Queue test',style:['brief'],boundaries:['AI disclosure'],sourceRefs:[],greeting:'안녕하세요.'};
const until=async(check:()=>Promise<boolean>|boolean,ms=2000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not met');};

function setup(provider:TextProvider={generate:jest.fn(async()=> '반가워요.')},maxQueueDepth=100) {
  const store=new InMemoryConversationStore();
  const delivery=new InMemoryTurnDelivery();
  const events=new InMemoryTurnEvents();
  const chat=new ChatService({store,personas:new InMemoryPersonaRepository([persona]),provider,timeoutMs:1000,leases:store,delivery,events,maxQueueDepth});
  const session=(owner='owner_q')=>chat.createSession(owner,{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
  const worker=(id='worker-a',leaseMs=200)=>new TurnWorker({chat,leases:store,workerId:id,leaseMs});
  /** Connects a worker to the delivery queue, like a BullMQ consumer with the given concurrency. */
  const consume=(w:TurnWorker,concurrency=4)=>delivery.consume(d=>w.handle(d).then(()=>undefined),{concurrency});
  const dispatcher=(maxAttempts=2)=>new TurnDispatcher({leases:store,delivery,events,maxAttempts,graceMs:0,intervalMs:20});
  return {store,delivery,events,chat,session,worker,consume,dispatcher,provider};
}

describe('queued turn execution (outbox → delivery → leased worker)',()=>{
  test('startTurn reserves and hands the turn to delivery; nothing runs until a worker consumes it',async()=>{
    const {chat,session,worker,consume,delivery,provider}=setup();
    const s=await session();
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'q1',text:'안녕'});
    expect(turn.state).toBe('pending');
    expect(await delivery.backlog()).toBe(1);
    await new Promise(r=>setTimeout(r,30));
    expect(provider.generate).not.toHaveBeenCalled();
    const stop=consume(worker());
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='completed');
    await stop();
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect((await chat.history('owner_q',s.id)).map(m=>m.role)).toEqual(['assistant','user','assistant']);
  });
  test('the original structured request (intent) survives the queue',async()=>{
    const {chat,session,worker,consume,provider}=setup();
    const s=await session();
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'q-intent',text:'안녕',intent:'unsupported'});
    const stop=consume(worker());
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='completed');
    await stop();
    expect((await chat.getTurn('owner_q',turn.id)).reply?.status).toBe('out_of_scope');
    expect(provider.generate).not.toHaveBeenCalled();
  });
  test('a duplicated delivery of the same dispatch runs the turn once (claim is idempotent)',async()=>{
    const {chat,session,worker,store,provider}=setup();
    const s=await session();
    const {turn,dispatch}=await chat.submitTurn('owner_q',{sessionId:s.id,clientRequestId:'dup',text:'안녕'});
    const w=worker();
    const results=await Promise.all([w.handle(dispatch!),w.handle(dispatch!),worker('worker-b').handle(dispatch!)]);
    expect(results.filter(r=>r==='executed')).toHaveLength(1);
    expect(results.filter(r=>r==='skipped')).toHaveLength(2);
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect(await store.claimTurn(turn.id,'late-worker',200)).toBeUndefined();
  });
  test('state changes are published as events without any model output',async()=>{
    const {chat,session,worker,consume,events}=setup();
    const s=await session();
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'ev',text:'안녕'});
    const stop=consume(worker());
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='completed');
    await stop();
    const mine=events.published.filter(e=>e.turnId===turn.id);
    expect(mine.map(e=>e.state)).toEqual(['generating','validating','completed']);
    expect(JSON.stringify(mine)).not.toContain('반가워요');
  });
  test('if publishing fails after the reservation commits, the outbox lets the dispatcher deliver it later',async()=>{
    const {chat,session,worker,consume,delivery,dispatcher}=setup();
    const s=await session();
    jest.spyOn(delivery,'publish').mockRejectedValueOnce(new Error('redis down'));
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'outbox',text:'안녕'});
    expect(turn.state).toBe('pending');
    expect(await delivery.backlog()).toBe(0);
    const stop=consume(worker());const d=dispatcher();d.start();
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='completed');
    await d.stop();await stop();
  });
  test('a claim that throws once (e.g. DB pool timeout) does not strand the turn: the dispatcher delivers it again',async()=>{
    const {chat,session,worker,consume,store,dispatcher}=setup();
    const s=await session();
    const claim=jest.spyOn(store,'claimTurn').mockRejectedValueOnce(new Error('pool timeout'));
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'claim-error',text:'안녕'});
    const stop=consume(worker());const d=dispatcher();d.start();
    try {await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='completed');}
    finally {await d.stop();await stop();}
    expect(claim.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
  test('Redis trouble does not hang the API: a failing backlog read admits the turn, a hanging cancel notice does not block cancel',async()=>{
    const {chat,session,delivery,events}=setup();
    const s=await session();
    jest.spyOn(delivery,'backlog').mockRejectedValue(new Error('redis down'));
    jest.spyOn(delivery,'publish').mockRejectedValue(new Error('redis down'));
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'redis-down',text:'안녕'});
    expect(turn.state).toBe('pending'); // the outbox entry carries it once Redis is back
    jest.spyOn(events,'publish').mockReturnValue(new Promise(()=>{}));
    await expect(chat.cancelTurn('owner_q',turn.id)).resolves.toBe(true);
  });
  test('a worker whose cancellation subscribe hangs still heartbeats its lease, and one renew error does not abort the turn',async()=>{
    let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
    const provider:TextProvider={generate:async()=>{await gate;return '반가워요.';}};
    const {chat,session,store,delivery}=setup(provider);
    const s=await session();
    const {turn,dispatch}=await chat.submitTurn('owner_q',{sessionId:s.id,clientRequestId:'slow-redis',text:'안녕'});
    const renew=jest.spyOn(store,'renewLease');renew.mockRejectedValueOnce(new Error('pool timeout'));
    const w=new TurnWorker({chat,leases:store,workerId:'w-hang',leaseMs:90,cancellations:{subscribe:()=>new Promise(()=>{})}});
    const running=w.handle(dispatch!);
    await new Promise(r=>setTimeout(r,250)); // well past the 90 ms lease
    expect(renew.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(await store.claimTurn(turn.id,'thief',90)).toBeUndefined(); // lease still held
    release();await running;
    expect((await chat.getTurn('owner_q',turn.id)).state).toBe('completed');
    expect(await delivery.backlog()).toBe(1); // untouched: handle() was called directly
  });
  test('backpressure: a full delivery backlog rejects new turns with QUEUE_FULL before reserving',async()=>{
    const {chat,session,delivery}=setup(undefined,2);
    for(let i=0;i<2;i++){const s=await session(`owner_${i}`);await chat.startTurn(`owner_${i}`,{sessionId:s.id,clientRequestId:`x${i}`,text:'안녕'});}
    const s=await session('owner_late');
    await expect(chat.startTurn('owner_late',{sessionId:s.id,clientRequestId:'late',text:'안녕'})).rejects.toEqual(new CoreError('QUEUE_FULL'));
    expect(await delivery.backlog()).toBe(2);
  });
  test('a turn held by a dead worker is requeued with a new dispatch after its lease expires and completes elsewhere',async()=>{
    let calls=0;
    const provider:TextProvider={generate:async()=>{calls++;if(calls===1)return new Promise<string>(()=>{});return '반가워요.';}};
    const {chat,session,worker,consume,dispatcher,delivery}=setup(provider);
    const s=await session();
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'crash',text:'안녕'});
    const dead=worker('worker-dead');const stopDead=consume(dead);
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='generating');
    dead.kill(); // simulates SIGKILL: no heartbeat, no further writes
    void stopDead();
    const published=jest.spyOn(delivery,'publish');
    const d=dispatcher();d.start();
    const stopHealthy=consume(worker('worker-b'));
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='completed',3000);
    await d.stop();await stopHealthy();
    expect(calls).toBe(2);
    expect(published).toHaveBeenCalledWith({turnId:turn.id,seq:1});
  });
  test('turns that keep losing their worker fail with WORKER_LOST after maxAttempts, publish it, and unblock the session',async()=>{
    const provider:TextProvider={generate:()=>new Promise<string>(()=>{})};
    const {chat,session,worker,dispatcher,store,events}=setup(provider);
    const s=await session();
    const {turn,dispatch}=await chat.submitTurn('owner_q',{sessionId:s.id,clientRequestId:'lost',text:'안녕'});
    let next=dispatch!;
    for(const id of ['w1','w2']) {
      const w=worker(id);void w.handle(next);
      await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='generating');
      w.kill();
      await new Promise(r=>setTimeout(r,250)); // let the lease expire
      if(id==='w1') {
        expect((await store.recoverExpired(2)).requeued).toEqual([turn.id]);
        next=(await store.pendingDispatches(0,10)).find(p=>p.turnId===turn.id)!;expect(next.seq).toBe(1);
      }
    }
    const d=dispatcher();await d.tick();
    expect((await chat.getTurn('owner_q',turn.id))).toMatchObject({state:'failed',errorCode:'WORKER_LOST'});
    expect(events.published).toContainEqual({turnId:turn.id,state:'failed',errorCode:'WORKER_LOST'});
    await expect(chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'next',text:'다시'})).resolves.toMatchObject({state:'pending'});
  });
  test('user cancellation stops the in-flight provider call through the lease heartbeat and is published',async()=>{
    let aborted=false;
    const provider:TextProvider={generate:(_m,{signal})=>new Promise<string>((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));}))};
    const {chat,session,worker,consume,events}=setup(provider);
    const s=await session();
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'cancel',text:'안녕'});
    const stop=consume(worker());
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='generating');
    expect(await chat.cancelTurn('owner_q',turn.id)).toBe(true);
    await until(()=>aborted);
    await stop();
    expect((await chat.getTurn('owner_q',turn.id)).state).toBe('cancelled');
    expect(events.published).toContainEqual({turnId:turn.id,state:'cancelled'});
  });
  test('a worker watching events aborts on cancellation at once, without waiting for its heartbeat',async()=>{
    let aborted=false;
    const provider:TextProvider={generate:(_m,{signal})=>new Promise<string>((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));}))};
    const {chat,session,store,consume,events}=setup(provider);
    const s=await session();
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'cancel-fast',text:'안녕'});
    // A one-minute lease means the heartbeat would only notice after 20 s.
    const stop=consume(new TurnWorker({chat,leases:store,workerId:'w-fast',leaseMs:60_000,cancellations:events}));
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='generating');
    await chat.cancelTurn('owner_q',turn.id);
    await until(()=>aborted,200);
    await stop();
  });
  test('consumer concurrency bounds in-flight provider calls',async()=>{
    let inFlight=0,peak=0;
    const provider:TextProvider={generate:async()=>{inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,30));inFlight--;return '반가워요.';}};
    const {chat,session,worker,consume}=setup(provider);
    const turns:(readonly [string,string])[]=[];
    for(let i=0;i<10;i++){const s=await session(`o${i}`);turns.push([`o${i}`,(await chat.startTurn(`o${i}`,{sessionId:s.id,clientRequestId:`c${i}`,text:'안녕'})).id] as const);}
    const stop=consume(worker('w'),3);
    await until(async()=>(await Promise.all(turns.map(([o,id])=>chat.getTurn(o,id)))).every(t=>t.state==='completed'),3000);
    await stop();
    expect(peak).toBe(3);
  });
  test('admission control rejects before touching the session and reuses a short-lived backlog reading',async()=>{
    const {chat,session,store,delivery}=setup(undefined,1);
    const s=await session();await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'fill',text:'안녕'});
    const backlog=jest.spyOn(delivery,'backlog');const lookup=jest.spyOn(store,'getOwnedSession');
    const late=await session('owner_late');
    for(let i=0;i<20;i++) await expect(chat.startTurn('owner_late',{sessionId:late.id,clientRequestId:`late-${i}`,text:'안녕'})).rejects.toEqual(new CoreError('QUEUE_FULL'));
    expect(lookup).not.toHaveBeenCalled();
    expect(backlog.mock.calls.length).toBeLessThanOrEqual(2);
  });
  test('a concurrent burst cannot overshoot the backlog bound (slots are taken before any await)',async()=>{
    const {chat,session}=setup(undefined,5);
    const sessions=await Promise.all(Array.from({length:20},(_,i)=>session(`burst_${i}`)));
    const results=await Promise.allSettled(sessions.map((s,i)=>chat.startTurn(`burst_${i}`,{sessionId:s.id,clientRequestId:`b${i}`,text:'안녕'})));
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(5);
    expect(results.filter(r=>r.status==='rejected').every(r=>(r as PromiseRejectedResult).reason.code==='QUEUE_FULL')).toBe(true);
  });
  test('a rejected reservation gives its admission slot back',async()=>{
    const {chat,session}=setup(undefined,1);
    const s=await session();
    await expect(chat.startTurn('owner_q',{sessionId:'missing-session',clientRequestId:'x',text:'안녕'})).rejects.toEqual(new CoreError('NOT_FOUND'));
    await expect(chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'ok',text:'안녕'})).resolves.toMatchObject({state:'pending'});
  });
  test('turn failures are reported to the observer as a sanitized code only',async()=>{
    const failures:{turnId:string;code:string}[]=[];
    const store=new InMemoryConversationStore();
    const local=createLocalChat({store,personas:new InMemoryPersonaRepository([persona]),timeoutMs:1000,
      provider:{generate:async()=>{throw new Error('secret upstream body sk-abc');}},onTurnFailure:failure=>failures.push(failure)});
    const s=await local.createSession('owner_q',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
    const turn=await local.sendTurn('owner_q',{sessionId:s.id,clientRequestId:'boom',text:'안녕'});
    expect(turn.state).toBe('failed');
    expect(failures).toEqual([{turnId:turn.id,code:'Error'}]);
  });
  test('an expired lease cannot be renewed, so a turn it may have lost to another claim is aborted',async()=>{
    const {chat,session,store}=setup();
    const s=await session();
    const {turn}=await chat.submitTurn('owner_q',{sessionId:s.id,clientRequestId:'expired',text:'안녕'});
    const claimed=await store.claimTurn(turn.id,'w-slow',20);
    await new Promise(r=>setTimeout(r,40));
    expect(await store.renewLease(turn.id,claimed!.fence,200)).toBe(false);
    expect((await store.claimTurn(turn.id,'w-next',200))?.fence.attempt).toBe(2);
  });
  test('a heartbeat that finds its lease already expired leaves the turn for recovery instead of failing it',async()=>{
    let calls=0;
    const provider:TextProvider={generate:jest.fn(async(_m,{signal})=>{
      if(++calls===1) await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
      return '반가워요.';
    })};
    const {chat,session,store,worker,consume,dispatcher}=setup(provider);
    const s=await session();
    const {turn,dispatch}=await chat.submitTurn('owner_q',{sessionId:s.id,clientRequestId:'late-heartbeat',text:'안녕'});
    // Every renewal of the first worker lands after its 60 ms lease has run out (e.g. a stalled event loop or DB).
    const renew=store.renewLease.bind(store);
    const slowRenew=jest.spyOn(store,'renewLease').mockImplementation(async(...args)=>{await new Promise(r=>setTimeout(r,80));return renew(...args);});
    expect(await worker('w-late',60).handle(dispatch!)).toBe('executed');
    expect((await chat.getTurn('owner_q',turn.id)).state).toBe('generating'); // not failed: the lease, not the turn, was lost
    slowRenew.mockRestore();
    const d=dispatcher(3);await d.tick();
    expect((await chat.getTurn('owner_q',turn.id)).state).toBe('pending');
    const stop=consume(worker('w-next'));d.start();
    try {await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='completed');}
    finally {await d.stop();await stop();}
    expect(provider.generate).toHaveBeenCalledTimes(2);
  });
  test('user cancellation and the turn timeout still end the turn (only a lost lease is left to recovery)',async()=>{
    const failures:{turnId:string;code:string}[]=[];
    const store=new InMemoryConversationStore();const delivery=new InMemoryTurnDelivery();const events=new InMemoryTurnEvents();
    const chat=new ChatService({store,personas:new InMemoryPersonaRepository([persona]),timeoutMs:50,leases:store,delivery,events,maxQueueDepth:10,
      provider:{generate:(_m,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}))},
      onTurnFailure:failure=>failures.push(failure)});
    const s=await chat.createSession('owner_q',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
    const {turn,dispatch}=await chat.submitTurn('owner_q',{sessionId:s.id,clientRequestId:'timeout',text:'안녕'});
    await new TurnWorker({chat,leases:store,workerId:'w-t',leaseMs:5000}).handle(dispatch!);
    expect((await chat.getTurn('owner_q',turn.id))).toMatchObject({state:'failed',errorCode:'TURN_FAILED'});
    expect(failures).toHaveLength(1);
  });
  test('the dispatcher reconciles leases at most once per reconcile interval and publishes WORKER_LOST failures',async()=>{
    const {store,delivery,events}=setup();
    const reconcile=jest.spyOn(store,'reconcileLeases').mockResolvedValueOnce({requeued:[],failed:['t-lost'],dropped:0});
    const d=new TurnDispatcher({leases:store,delivery,events,maxAttempts:3,graceMs:0,intervalMs:10,reconcile:{intervalMs:100,graceMs:15000}});
    d.start();await new Promise(r=>setTimeout(r,150));await d.stop();
    expect(reconcile.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(reconcile.mock.calls.length).toBeLessThanOrEqual(2);
    expect(reconcile).toHaveBeenCalledWith(3,15000);
    expect(events.published).toContainEqual({turnId:'t-lost',state:'failed',errorCode:'WORKER_LOST'});
  });
});
