import type { Persona } from '@ptr/contracts';
import { ChatService, InMemoryConversationStore, InMemoryPersonaRepository, InMemoryTurnDelivery, InMemoryTurnEvents, TurnDispatcher, TurnWorker, type TextProvider, type TurnDispatcherEvent } from '../src';

const persona:Persona={id:'persona_synthetic_s',personId:'person_synthetic_s',label:'Synthetic S',language:'ko',revision:'v1',reviewStatus:'synthetic',identity:'Fictional',concept:'Serving test',style:['brief'],boundaries:['AI disclosure'],sourceRefs:[],greeting:'안녕하세요.'};
const until=async(check:()=>Promise<boolean>|boolean,ms=2000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,5));}throw new Error('condition not met');};

function setup(provider:TextProvider,hooks:Partial<ConstructorParameters<typeof ChatService>[0]>={}) {
  const store=new InMemoryConversationStore(), delivery=new InMemoryTurnDelivery(), events=new InMemoryTurnEvents();
  const chat=new ChatService({store,personas:new InMemoryPersonaRepository([persona]),provider,timeoutMs:1000,leases:store,delivery,events,...hooks});
  const run=async(executionProfile:'legacy'|'agent_loop'='legacy',onFinished?:ConstructorParameters<typeof TurnWorker>[0]['onFinished']) => {
    const session=await chat.createSession('owner_s',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC',executionProfile});
    const {turn,dispatch}=await chat.submitTurn('owner_s',{sessionId:session.id,clientRequestId:`c-${Math.random()}`,text:'안녕'});
    await new TurnWorker({chat,leases:store,workerId:'w',leaseMs:500,...(onFinished?{onFinished}:{})}).handle(dispatch!);
    return chat.getTurn('owner_s',turn.id);
  };
  return {chat,store,delivery,events,run};
}

describe('reply.serving : which upstream answered each model call',()=>{
  test('the upstream each call reports is recorded per call; secondary calls are counted',async()=>{
    const answers=['primary','secondary'];
    const provider:TextProvider={generate:jest.fn(async(_messages,options)=>{options.onServed?.(answers.shift()!);return '반가워요.';})};
    const {run}=setup(provider);
    expect((await run()).reply?.serving).toEqual({calls:1,upstreams:['primary'],secondaryCalls:0});
    expect((await run()).reply?.serving).toEqual({calls:1,upstreams:['secondary'],secondaryCalls:1});
  });
  test('the agent path records every model call of the turn',async()=>{
    const provider:TextProvider={generate:jest.fn(async(_messages,options)=>{options.onServed?.('fake');
      return JSON.stringify({status:'insufficient_evidence',message:'연구용 AI 시뮬레이션이에요.',evidenceRefs:[],variableUpdates:{}});})};
    const turn=await setup(provider).run('agent_loop');
    expect(turn.state).toBe('completed');
    expect(turn.reply?.serving).toEqual({calls:1,upstreams:['fake'],secondaryCalls:0});
  });
  test('a provider that does not report is recorded as unknown; a malformed label too (never free text)',async()=>{
    const labels=[undefined,'Primary Engine at http://x'];
    const provider:TextProvider={generate:async(_messages,options)=>{const label=labels.shift();if(label!==undefined) options.onServed?.(label);return '반가워요.';}};
    const {run}=setup(provider);
    expect((await run()).reply?.serving).toEqual({calls:1,upstreams:['unknown'],secondaryCalls:0});
    expect((await run()).reply?.serving).toEqual({calls:1,upstreams:['unknown'],secondaryCalls:0});
  });
  test('no model call (a fixed refusal) records no serving',async()=>{
    const provider:TextProvider={generate:jest.fn(async()=> '반가워요.')};
    const {chat,store}=setup(provider);
    const session=await chat.createSession('owner_s',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
    const {turn,dispatch}=await chat.submitTurn('owner_s',{sessionId:session.id,clientRequestId:'refuse',text:'안녕',intent:'unsupported'});
    await new TurnWorker({chat,leases:store,workerId:'w',leaseMs:500}).handle(dispatch!);
    const done=await chat.getTurn('owner_s',turn.id);
    expect(done.state).toBe('completed');expect(done.reply?.serving).toBeUndefined();expect(provider.generate).not.toHaveBeenCalled();
  });
});

describe('observability hooks',()=>{
  test('onTurnCompleted gets the turn id and the stored reply; the worker reports queue wait and duration',async()=>{
    const completed:{turnId:string;serving:unknown}[]=[];const finished:{turnId:string;queueWaitMs:number;durationMs:number}[]=[];
    const provider:TextProvider={generate:async(_messages,options)=>{options.onServed?.('primary');await new Promise(r=>setTimeout(r,30));return '반가워요.';}};
    const {run}=setup(provider,{onTurnCompleted:({turnId,reply})=>completed.push({turnId,serving:reply.serving})});
    const turn=await run('legacy',event=>finished.push(event));
    expect(completed).toEqual([{turnId:turn.id,serving:{calls:1,upstreams:['primary'],secondaryCalls:0}}]);
    expect(finished).toHaveLength(1);expect(finished[0]!.turnId).toBe(turn.id);
    expect(finished[0]!.durationMs).toBeGreaterThanOrEqual(25);expect(finished[0]!.queueWaitMs).toBeGreaterThanOrEqual(0);
  });
  test('a turn failed for CONTEXT_LIMIT is reported to onTurnFailure (never counted as abandoned)',async()=>{
    const failures:{turnId:string;code:string}[]=[];
    const {chat,store}=setup({generate:async()=> '반가워요.'},{maxHistoryMessages:0,onTurnFailure:failure=>failures.push(failure)});
    const session=await chat.createSession('owner_s',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
    const {turn,dispatch}=await chat.submitTurn('owner_s',{sessionId:session.id,clientRequestId:'ctx',text:'안녕'});
    await new TurnWorker({chat,leases:store,workerId:'w',leaseMs:500}).handle(dispatch!);
    expect((await chat.getTurn('owner_s',turn.id)).errorCode).toBe('CONTEXT_LIMIT');
    expect(failures).toEqual([{turnId:turn.id,code:'CONTEXT_LIMIT'}]);
  });
  test('the dispatcher reports requeues, failures with their code and republished dispatches',async()=>{
    const provider:TextProvider={generate:async()=> '반가워요.'};
    const {chat,store,delivery,events}=setup(provider);
    const seen:TurnDispatcherEvent[]=[];
    const session=await chat.createSession('owner_s',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
    const {turn}=await chat.submitTurn('owner_s',{sessionId:session.id,clientRequestId:'lost',text:'안녕'});
    // A worker claims and dies: its lease expires, the dispatcher requeues (attempt 1) and then fails it (WORKER_LOST).
    const dead=new TurnWorker({chat,leases:store,workerId:'dead',leaseMs:30});
    const claimed=await store.claimTurn(turn.id,'dead',30);expect(claimed).toBeDefined();dead.kill();
    const dispatcher=new TurnDispatcher({leases:store,delivery,events,maxAttempts:1,graceMs:0,intervalMs:10,onEvent:event=>seen.push(event)});
    await new Promise(r=>setTimeout(r,60));
    await dispatcher.tick();
    await until(()=>seen.some(event=>event.type==='failed'));
    expect(seen).toContainEqual({type:'failed',turnId:turn.id,errorCode:'WORKER_LOST'});
    const {turn:second}=await chat.submitTurn('owner_s',{sessionId:session.id,clientRequestId:'again',text:'안녕'});
    await dispatcher.tick();
    expect(seen).toContainEqual({type:'republished',turnId:second.id});
  });
  test('an expired lease with attempts left is reported as a requeue',async()=>{
    const {chat,store,delivery,events}=setup({generate:async()=> '반가워요.'});
    const seen:TurnDispatcherEvent[]=[];
    const session=await chat.createSession('owner_s',{personaId:persona.id,personId:persona.personId,personaRevision:persona.revision,retrievalMode:'off',timezone:'UTC'});
    const {turn}=await chat.submitTurn('owner_s',{sessionId:session.id,clientRequestId:'requeue',text:'안녕'});
    expect(await store.claimTurn(turn.id,'dead',30)).toBeDefined();
    await new Promise(r=>setTimeout(r,60));
    await new TurnDispatcher({leases:store,delivery,events,maxAttempts:3,graceMs:0,intervalMs:10,onEvent:event=>seen.push(event)}).tick();
    expect(seen).toContainEqual({type:'requeued',turnId:turn.id});
  });
});
