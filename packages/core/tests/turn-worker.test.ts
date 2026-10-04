import type { Persona } from '@ptr/contracts';
import { ChatService, CoreError, InMemoryConversationStore, InMemoryPersonaRepository, TurnWorker, type TextProvider } from '../src';

const persona:Persona={id:'persona_synthetic_q',personId:'person_synthetic_q',label:'Synthetic Q',language:'ko',revision:'v1',reviewStatus:'synthetic',identity:'Fictional',concept:'Queue test',style:['brief'],boundaries:['AI disclosure'],sourceRefs:[],greeting:'안녕하세요.'};
const until=async(check:()=>Promise<boolean>,ms=2000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not met');};

function setup(provider:TextProvider={generate:jest.fn(async()=> '반가워요.')},queueMaxDepth=100) {
  const store=new InMemoryConversationStore();
  const personas=new InMemoryPersonaRepository([persona]);
  const chat=new ChatService({store,personas,provider,timeoutMs:1000,queue:{store,maxDepth:queueMaxDepth}});
  const session=(owner='owner_q')=>chat.createSession(owner,{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
  const worker=(id='worker-a',overrides:Partial<ConstructorParameters<typeof TurnWorker>[0]>={})=>new TurnWorker({chat,queue:store,workerId:id,concurrency:4,leaseMs:200,pollMs:5,maxAttempts:2,...overrides});
  return {store,chat,session,worker,provider};
}

describe('queued turn execution',()=>{
  test('queue mode only reserves; nothing runs until a worker claims the turn',async()=>{
    const {chat,session,worker,provider}=setup();
    const s=await session();
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'q1',text:'안녕'});
    expect(turn.state).toBe('pending');
    await new Promise(r=>setTimeout(r,30));
    expect(provider.generate).not.toHaveBeenCalled();
    const w=worker();w.start();
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='completed');
    await w.stop();
    expect(provider.generate).toHaveBeenCalledTimes(1);
    expect((await chat.history('owner_q',s.id)).map(m=>m.role)).toEqual(['assistant','user','assistant']);
  });
  test('the original structured request (intent) survives the queue',async()=>{
    const {chat,session,worker,provider}=setup();
    const s=await session();
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'q-intent',text:'안녕',intent:'unsupported'});
    const w=worker();w.start();
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='completed');
    await w.stop();
    expect((await chat.getTurn('owner_q',turn.id)).reply?.status).toBe('out_of_scope');
    expect(provider.generate).not.toHaveBeenCalled();
  });
  test('backpressure: a full queue rejects new turns with QUEUE_FULL before reserving',async()=>{
    const {chat,session,store}=setup(undefined,2);
    for(let i=0;i<2;i++){const s=await session(`owner_${i}`);await chat.startTurn(`owner_${i}`,{sessionId:s.id,clientRequestId:`x${i}`,text:'안녕'});}
    const s=await session('owner_late');
    await expect(chat.startTurn('owner_late',{sessionId:s.id,clientRequestId:'late',text:'안녕'})).rejects.toEqual(new CoreError('QUEUE_FULL'));
    expect(await store.queueDepth()).toBe(2);
    await expect(chat.startTurn('owner_late',{sessionId:s.id,clientRequestId:'late2',text:'안녕'})).rejects.toEqual(new CoreError('QUEUE_FULL'));
  });
  test('a turn held by a dead worker is requeued after its lease expires and completes elsewhere',async()=>{
    let calls=0;
    const provider:TextProvider={generate:async()=>{calls++;if(calls===1)return new Promise<string>(()=>{});return '반가워요.';}};
    const {chat,session,worker,store}=setup(provider);
    const s=await session();
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'crash',text:'안녕'});
    const dead=worker('worker-dead');dead.start();
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='generating');
    dead.kill(); // simulates SIGKILL: no heartbeat, no cleanup
    const healthy=worker('worker-b');healthy.start();
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='completed',3000);
    await healthy.stop();
    expect(calls).toBe(2);
    expect(await store.queueDepth()).toBe(0);
  });
  test('turns that keep losing their worker fail with WORKER_LOST after maxAttempts and unblock the session',async()=>{
    const provider:TextProvider={generate:()=>new Promise<string>(()=>{})};
    const {chat,session,worker}=setup(provider);
    const s=await session();
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'lost',text:'안녕'});
    for(const id of ['w1','w2']) {
      const w=worker(id);w.start();
      await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='generating');
      w.kill();
      await new Promise(r=>setTimeout(r,250)); // let the lease expire
    }
    const sweeper=worker('w3');sweeper.start();
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='failed',3000);
    await sweeper.stop();
    expect((await chat.getTurn('owner_q',turn.id)).errorCode).toBe('WORKER_LOST');
    await expect(chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'next',text:'다시'})).resolves.toMatchObject({state:'pending'});
  });
  test('user cancellation stops the in-flight provider call through the lease heartbeat',async()=>{
    let aborted=false;
    const provider:TextProvider={generate:(_m,{signal})=>new Promise<string>((_,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));}))};
    const {chat,session,worker}=setup(provider);
    const s=await session();
    const turn=await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'cancel',text:'안녕'});
    const w=worker();w.start();
    await until(async()=>(await chat.getTurn('owner_q',turn.id)).state==='generating');
    expect(await chat.cancelTurn('owner_q',turn.id)).toBe(true);
    await until(async()=>aborted);
    await w.stop();
    expect((await chat.getTurn('owner_q',turn.id)).state).toBe('cancelled');
  });
  test('worker concurrency bounds in-flight provider calls',async()=>{
    let inFlight=0,peak=0;
    const provider:TextProvider={generate:async()=>{inFlight++;peak=Math.max(peak,inFlight);await new Promise(r=>setTimeout(r,30));inFlight--;return '반가워요.';}};
    const {chat,session,worker}=setup(provider);
    const turns:(readonly [string,string])[]=[];
    for(let i=0;i<10;i++){const s=await session(`o${i}`);turns.push([`o${i}`,(await chat.startTurn(`o${i}`,{sessionId:s.id,clientRequestId:`c${i}`,text:'안녕'})).id] as const);}
    const w=worker('w',{concurrency:3});w.start();
    await until(async()=>(await Promise.all(turns.map(([o,id])=>chat.getTurn(o,id)))).every(t=>t.state==='completed'),3000);
    await w.stop();
    expect(peak).toBe(3);
  });
  test('admission control rejects before touching the session and reuses a short-lived depth reading',async()=>{
    const {chat,session,store}=setup(undefined,1);
    const s=await session();await chat.startTurn('owner_q',{sessionId:s.id,clientRequestId:'fill',text:'안녕'});
    const depth=jest.spyOn(store,'queueDepth');const lookup=jest.spyOn(store,'getOwnedSession');
    const late=await session('owner_late');
    for(let i=0;i<20;i++) await expect(chat.startTurn('owner_late',{sessionId:late.id,clientRequestId:`late-${i}`,text:'안녕'})).rejects.toEqual(new CoreError('QUEUE_FULL'));
    expect(lookup).not.toHaveBeenCalled();
    expect(depth.mock.calls.length).toBeLessThanOrEqual(2);
  });
  test('turn failures are reported to the observer as a sanitized code only',async()=>{
    const failures:{turnId:string;code:string}[]=[];
    const store=new InMemoryConversationStore();
    const chat=new ChatService({store,personas:new InMemoryPersonaRepository([persona]),timeoutMs:1000,
      provider:{generate:async()=>{throw new Error('secret upstream body sk-abc');}},onTurnFailure:failure=>failures.push(failure)});
    const s=await chat.createSession('owner_q',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
    const turn=await chat.sendTurn('owner_q',{sessionId:s.id,clientRequestId:'boom',text:'안녕'});
    expect(turn.state).toBe('failed');
    expect(failures).toEqual([{turnId:turn.id,code:'Error'}]);
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
});
