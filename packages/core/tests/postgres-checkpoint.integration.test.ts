import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Persona, SourcePost, ChatReply } from '@ptr/contracts';
import { PostgresConversationStore, PostgresPersonaRepository } from '@ptr/storage';
import { ChatService, type ChatServiceOptions } from '../src/chat-service';
import { FrameworkTurnWorker } from '../src/turn-worker';
import { DEFAULT_SAFETY_THRESHOLDS, SAFETY_CATEGORIES, safetyAction } from '../src/input-safety';
import { InMemoryTurnDelivery } from '../src/memory-queue';
import type { LeaseFence } from '../src/ports';
import type { GuardrailsClient } from '../src/guardrails';

const raw=process.env.PTR_FRAMEWORK_TEST_DATABASE_URL;
const enabled=(()=>{if(!raw)return false;const url=new URL(raw);return url.hostname==='127.0.0.1'&&url.port==='57432'&&url.pathname==='/ptr_framework_test'&&url.username==='ptr_framework_tester';})();
const integration=enabled?describe:describe.skip;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const zero=Object.fromEntries(SAFETY_CATEGORIES.map(category=>[category,0.01])) as typeof DEFAULT_SAFETY_THRESHOLDS;
const persona:Persona={id:'synthetic-pg-checkpoint-persona',personId:'synthetic-pg-checkpoint-person',revision:'synthetic-v1',label:'Synthetic',language:'ko',reviewStatus:'synthetic',identity:'Fictional painter',concept:'Synthetic test',style:['brief'],boundaries:['AI simulation'],sourceRefs:[],greeting:'안녕'};
const source:SourcePost={id:'synthetic-pg-checkpoint-post',personId:persona.personId,caption:'합성 숲을 그렸어.',postedAt:'2024-01-01T00:00:00Z',eventDate:null,sourceUrl:'https://example.invalid/synthetic-checkpoint',hash:'synthetic-hash',snapshot:'synthetic-v1',unsafe:false};
const final=JSON.stringify({status:'answered',message:'합성 숲 그렸었지!',evidenceRefs:[{sourceId:source.id,quote:source.caption}],variableUpdates:{tone:'warm'}});
const tool=JSON.stringify({status:'answered',message:'',evidenceRefs:[],variableUpdates:{},function:{name:'timeline_search',arguments:{query:'합성 숲'}}});

integration('real Postgres LangGraph checkpoint recovery through public turn execution',()=>{
  const sessions:string[]=[],threads:string[]=[];const pools=new Set<Pool>();let cleanupPool:Pool;
  function pool() {const result=new Pool({connectionString:raw,connectionTimeoutMillis:3000});pools.add(result);return result;}
  async function close(value:Pool) {pools.delete(value);await value.end();}
  beforeAll(async()=>{
    // Schema creation is an explicitly invoked deployment command, not a side effect of serving or construction.
    cleanupPool=pool();await new PostgresSaver(cleanupPool).setup();
    await new PostgresPersonaRepository(cleanupPool).importPersona(persona);
  });
  afterEach(()=>jest.restoreAllMocks());
  afterAll(async()=>{
    try {
      const saver=new PostgresSaver(cleanupPool);
      for(const thread of threads)await saver.deleteThread(thread);
      for(const sessionId of sessions) {
        await cleanupPool.query('DELETE FROM messages WHERE session_id=$1',[sessionId]);
        await cleanupPool.query('DELETE FROM turns WHERE session_id=$1',[sessionId]);
        await cleanupPool.query('DELETE FROM sessions WHERE id=$1',[sessionId]);
      }
    } finally {for(const value of [...pools])await close(value);}
  });
  function ports() {
    const provider={generate:jest.fn(async()=>final)};
    const retrieval={search:jest.fn(async()=>[source])};
    const assess=jest.fn(async()=>({safety:zero}));
    const guardrails:jest.Mocked<Pick<GuardrailsClient,'validateInput'|'validateReply'>>={
      validateInput:jest.fn<ReturnType<GuardrailsClient['validateInput']>,Parameters<GuardrailsClient['validateInput']>>(async input=>({revision:'reply-guard-v7',...safetyAction(input.probabilities,input.thresholds)})),
      validateReply:jest.fn<ReturnType<GuardrailsClient['validateReply']>,Parameters<GuardrailsClient['validateReply']>>(async input=>({revision:'reply-guard-v7',content:input.reply}))};
    return {provider,retrieval,assess,guardrails};
  }
  function service(db:Pool,saver:PostgresSaver,p:ReturnType<typeof ports>,extra:Partial<ChatServiceOptions>={}) {
    const store=new PostgresConversationStore(db);
    const chat=new ChatService({store,leases:store,personas:new PostgresPersonaRepository(db),delivery:new InMemoryTurnDelivery(),
      provider:p.provider,retrieval:p.retrieval,guardrails:p.guardrails,
      inputSafety:{classifier:{name:'synthetic/jev',assess:p.assess},thresholds:DEFAULT_SAFETY_THRESHOLDS,timeoutMs:500},
      agentCheckpoint:{checkpointer:saver},timeoutMs:5000,...extra});
    const worker=new FrameworkTurnWorker({chat,executions:store,workerId:'synthetic-checkpoint-worker',maxQueueMs:60000,maxAttempts:3});
    return {store,chat,worker};
  }
  async function reserve(chat:ChatService,text='그 게시물 기억나?') {
    const session=await chat.createSession('synthetic-checkpoint-owner',{personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,retrievalMode:'lexical',ragCondition:'caption',executionProfile:'agent_loop'});
    sessions.push(session.id);
    const value=await chat.submitTurn(session.ownerId,{sessionId:session.id,clientRequestId:randomUUID(),text,...(text==='안녕'?{intent:'small_talk' as const}:{})});
    threads.push(`turn:${value.turn.id}`,`character:${value.turn.id}`);
    return {...value,session};
  }
  test.each(['commit outage','real fencing CAS false'])('new saver/pool/worker resume %s with stable message id and no repeated Jev/model/search/guards',async mode=>{
    const firstPool=pool(),firstSaver=new PostgresSaver(firstPool),p=ports();
    const first=service(firstPool,firstSaver,p),reservation=await reserve(first.chat);
    let originalMessageId:string|undefined;let oldFence:LeaseFence|undefined;
    const complete=first.store.completeTurn.bind(first.store);
    jest.spyOn(first.store,'completeTurn').mockImplementationOnce(async(id,reply,fence)=>{
      originalMessageId=reply.messageId;oldFence=fence;
      if(mode==='commit outage') {first.worker.loseLock('first-token');throw new Error('synthetic commit outage');}
      // Another actual lock holder advances the DB generation just before this worker's final write.
      // No explicit loseLock: completeTurn(false) itself must leave the durable persist node resumable.
      const replacement=await first.store.claimExecution(reservation.dispatch!,'synthetic-cas-new-owner',60000,3);
      expect(replacement?.fence.attempt).toBe(2);
      const accepted=await complete(id,reply,fence);expect(accepted).toBe(false);return accepted;
    });
    await first.worker.handle(reservation.dispatch!,'first-token');await pause(60);
    expect(await first.chat.getTurn(reservation.session.ownerId,reservation.turn.id)).toMatchObject({state:mode==='commit outage'?'validating':'pending'});
    const checkpoint=await firstSaver.getTuple({configurable:{thread_id:`turn:${reservation.turn.id}`}});
    expect((checkpoint?.checkpoint.channel_values.frame as {reply?:ChatReply})?.reply?.messageId).toBe(originalMessageId);
    await close(firstPool); // Destroy every first-attempt client; only actual Postgres bytes survive.
    const secondPool=pool(),secondSaver=new PostgresSaver(secondPool);
    let entered!:()=>void,release!:()=>void;
    const atPersist=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const second=service(secondPool,secondSaver,p,{observeStage:async<T>(name:string,work:()=>Promise<T>)=>{if(name==='persist'){entered();await gate;}return work();}});
    const resumed=second.worker.handle(reservation.dispatch!,'second-token');await atPersist;
    const savedReply=(checkpoint?.checkpoint.channel_values.frame as {reply:ChatReply}).reply;
    try {expect(await second.store.completeTurn(reservation.turn.id,savedReply,oldFence)).toBe(false);}finally{release();}
    await resumed;
    const done=await second.chat.getTurn(reservation.session.ownerId,reservation.turn.id);
    expect(done.state).toBe('completed');expect(done.reply?.messageId).toBe(originalMessageId);
    expect(p.provider.generate).toHaveBeenCalledTimes(1);expect(p.retrieval.search).toHaveBeenCalledTimes(1);
    expect(p.assess).toHaveBeenCalledTimes(1);expect(p.guardrails.validateInput).toHaveBeenCalledTimes(1);expect(p.guardrails.validateReply).toHaveBeenCalledTimes(1);
    expect((await second.chat.history(reservation.session.ownerId,reservation.session.id)).map(message=>message.role)).toEqual(['assistant','user','assistant']);
    await expect(second.worker.handle(reservation.dispatch!,'duplicate-token')).resolves.toBe('skipped');expect(p.provider.generate).toHaveBeenCalledTimes(1);
  },20000);
  test('nested successful tool task survives lock-loss restart with durable saver, not another model/tool/Jev call',async()=>{
    const firstPool=pool(),firstSaver=new PostgresSaver(firstPool),p=ports();
    p.provider.generate.mockResolvedValueOnce(tool).mockResolvedValue(final);
    const first=service(firstPool,firstSaver,p),reservation=await reserve(first.chat,'안녕');
    p.retrieval.search.mockImplementationOnce(async()=>{first.worker.loseLock('tool-token');return [source];});
    await first.worker.handle(reservation.dispatch!,'tool-token');await pause(100);
    expect(p.provider.generate).toHaveBeenCalledTimes(1);
    // Nested graphs inherit the outer immutable turn thread and use child checkpoint namespaces.
    const nested=await firstPool.query('SELECT count(*)::int AS n FROM checkpoints WHERE thread_id=ANY($1::text[]) AND checkpoint_ns<>$2',[[`turn:${reservation.turn.id}`,`character:${reservation.turn.id}`],'']);
    expect(nested.rows[0].n).toBeGreaterThan(0);
    const namespaces=(await firstPool.query('SELECT DISTINCT checkpoint_ns FROM checkpoints WHERE thread_id=$1',[`character:${reservation.turn.id}`])).rows;
    let durableToolResult=false;
    for(const row of namespaces){const saved=await firstSaver.getTuple({configurable:{thread_id:`character:${reservation.turn.id}`,checkpoint_ns:row.checkpoint_ns}});
      if(saved?.pendingWrites?.some(([,channel,value])=>channel==='__return__'&&Array.isArray(value)&&value.some(item=>item&&typeof item==='object'&&'id' in item&&item.id===source.id)))durableToolResult=true;}
    expect(durableToolResult).toBe(true);await close(firstPool);
    const secondPool=pool(),secondSaver=new PostgresSaver(secondPool),second=service(secondPool,secondSaver,p);
    await second.worker.handle(reservation.dispatch!,'tool-resume-token');
    const done=await second.chat.getTurn(reservation.session.ownerId,reservation.turn.id);
    expect(done.state).toBe('completed');expect(done.reply?.agent).toMatchObject({modelCalls:2,toolCalls:1});
    expect(p.provider.generate).toHaveBeenCalledTimes(2);expect(p.retrieval.search).toHaveBeenCalledTimes(1);expect(p.assess).toHaveBeenCalledTimes(1);
    expect(p.guardrails.validateInput).toHaveBeenCalledTimes(1);expect(p.guardrails.validateReply).toHaveBeenCalledTimes(1);
  },20000);
  test('a response lost before its first durable task write is not exactly-once for an unjournaled synthetic model',async()=>{
    const firstPool=pool(),firstSaver=new PostgresSaver(firstPool),p=ports();
    const first=service(firstPool,firstSaver,p),reservation=await reserve(first.chat);
    let upstreamReturned=false;
    p.provider.generate.mockImplementationOnce(async()=>{
      // The synthetic upstream has produced a response, but the process loses ownership before its adapter can
      // return/record a successful task. An actual abrupt process exit in this gap loses the same volatile result.
      upstreamReturned=true;first.worker.loseLock('gap-token');return new Promise<string>(()=>undefined);
    });
    await first.worker.handle(reservation.dispatch!,'gap-token');await pause(100);expect(upstreamReturned).toBe(true);await close(firstPool);
    const secondPool=pool(),secondSaver=new PostgresSaver(secondPool),second=service(secondPool,secondSaver,p);
    await second.worker.handle(reservation.dispatch!,'gap-resume-token');
    expect((await second.chat.getTurn(reservation.session.ownerId,reservation.turn.id)).state).toBe('completed');
    // Intentional risk evidence, not an exactly-once claim. Billable calls need the independent durable provider ledger.
    expect(p.provider.generate).toHaveBeenCalledTimes(2);expect(p.assess).toHaveBeenCalledTimes(1);expect(p.retrieval.search).toHaveBeenCalledTimes(1);
  },20000);

});
