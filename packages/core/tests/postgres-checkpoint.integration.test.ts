import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import type { Persona, SourcePost, ChatReply } from '@ptr/contracts';
import { PostgresConversationStore, PostgresPersonaRepository } from '@ptr/storage';
import { CheckpointedTextProvider } from '../src/checkpointed-provider';
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
      validateInput:jest.fn<ReturnType<GuardrailsClient['validateInput']>,Parameters<GuardrailsClient['validateInput']>>(async input=>({revision:'reply-guard-v9',...safetyAction(input.probabilities,input.thresholds)})),
      validateReply:jest.fn<ReturnType<GuardrailsClient['validateReply']>,Parameters<GuardrailsClient['validateReply']>>(async input=>({revision:'reply-guard-v9',content:input.reply}))};
    return {provider,retrieval,assess,guardrails};
  }
  function service(db:Pool,saver:PostgresSaver,p:ReturnType<typeof ports>,extra:Partial<ChatServiceOptions>={}) {
    const store=new PostgresConversationStore(db);
    const chat=new ChatService({store,leases:store,personas:new PostgresPersonaRepository(db),delivery:new InMemoryTurnDelivery(),
      provider:new CheckpointedTextProvider(p.provider,{checkpointer:saver,identity:'synthetic-pg-model-v1'}),retrieval:p.retrieval,guardrails:p.guardrails,
      inputSafety:{classifier:{name:'synthetic/jev',assess:p.assess},thresholds:DEFAULT_SAFETY_THRESHOLDS,timeoutMs:500},
      timeoutMs:5000,...extra});
    const worker=new FrameworkTurnWorker({chat,executions:store,workerId:'synthetic-checkpoint-worker',maxQueueMs:60000,maxAttempts:3});
    return {store,chat,worker};
  }
  async function reserve(chat:ChatService,text='그 게시물 기억나?') {
    const session=await chat.createSession('synthetic-checkpoint-owner',{personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,retrievalMode:'lexical',ragCondition:'caption',executionProfile:'agent_loop'});
    sessions.push(session.id);
    const value=await chat.submitTurn(session.ownerId,{sessionId:session.id,clientRequestId:randomUUID(),text,...(text==='안녕'?{intent:'small_talk' as const}:{})});
    return {...value,session};
  }
  async function modelThreads(db:Pool,turnId:string):Promise<string[]> {
    const rows=await db.query<{thread_id:string;checkpoint_ns:string}>(
      `SELECT thread_id,checkpoint_ns FROM checkpoints WHERE thread_id ~ $1 OR thread_id=ANY($2::text[])
       UNION SELECT thread_id,checkpoint_ns FROM checkpoint_blobs WHERE thread_id ~ $1 OR thread_id=ANY($2::text[])
       UNION SELECT thread_id,checkpoint_ns FROM checkpoint_writes WHERE thread_id ~ $1 OR thread_id=ANY($2::text[])`,
      [`^model:${turnId}:[0-9a-f]{64}$`,[`turn:${turnId}`,`character:${turnId}`]]);
    for(const row of rows.rows)if(!threads.includes(row.thread_id))threads.push(row.thread_id);
    expect(rows.rows.every(row=>row.thread_id.startsWith(`model:${turnId}:`)&&row.checkpoint_ns==='')).toBe(true);
    return [...new Set(rows.rows.map(row=>row.thread_id))];
  }
  test.each(['commit outage','real fencing CAS false'])('new saver/pool/worker resume %s with costly response replay and cheap stage restart',async mode=>{
    const firstPool=pool(),firstSaver=new PostgresSaver(firstPool),p=ports();
    const first=service(firstPool,firstSaver,p),reservation=await reserve(first.chat);
    let originalReply:ChatReply|undefined;let oldFence:LeaseFence|undefined;
    const complete=first.store.completeTurn.bind(first.store);
    jest.spyOn(first.store,'completeTurn').mockImplementationOnce(async(id,reply,fence)=>{
      originalReply=reply;oldFence=fence;
      if(mode==='commit outage') {first.worker.loseLock('first-token');throw new Error('synthetic commit outage');}
      // Another actual lock holder advances the DB generation just before this worker's final write.
      // No explicit loseLock: completeTurn(false) must leave the uncommitted attempt restartable.
      const replacement=await first.store.claimExecution(reservation.dispatch!,'synthetic-cas-new-owner',60000,3);
      expect(replacement?.fence.attempt).toBe(2);
      const accepted=await complete(id,reply,fence);expect(accepted).toBe(false);return accepted;
    });
    await first.worker.handle(reservation.dispatch!,'first-token');await pause(60);
    expect(await first.chat.getTurn(reservation.session.ownerId,reservation.turn.id)).toMatchObject({state:mode==='commit outage'?'validating':'pending'});
    const receipts=await modelThreads(firstPool,reservation.turn.id);expect(receipts).toHaveLength(1);
    const checkpoint=await firstSaver.getTuple({configurable:{thread_id:receipts[0],checkpoint_ns:''}});
    expect((checkpoint?.checkpoint.channel_values.call as {receipt?:{rawResponse:string}})?.receipt?.rawResponse).toBe(final);
    expect(JSON.stringify(checkpoint)).not.toContain(persona.identity);expect(JSON.stringify(checkpoint)).not.toContain(reservation.turn.userText);
    await close(firstPool); // Destroy every first-attempt client; only actual Postgres bytes survive.
    const secondPool=pool(),secondSaver=new PostgresSaver(secondPool);
    let entered!:()=>void,release!:()=>void;
    const atPersist=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const second=service(secondPool,secondSaver,p,{observeStage:async<T>(name:string,work:()=>Promise<T>)=>{if(name==='persist'){entered();await gate;}return work();}});
    const resumed=second.worker.handle(reservation.dispatch!,'second-token');await atPersist;
    try {expect(await second.store.completeTurn(reservation.turn.id,originalReply!,oldFence)).toBe(false);}finally{release();}
    await resumed;
    const done=await second.chat.getTurn(reservation.session.ownerId,reservation.turn.id);
    expect(done.state).toBe('completed');expect(done.reply?.messageId).not.toBe(originalReply!.messageId);
    expect(p.provider.generate).toHaveBeenCalledTimes(1);expect(p.retrieval.search).toHaveBeenCalledTimes(2);
    expect(p.assess).toHaveBeenCalledTimes(2);expect(p.guardrails.validateInput).toHaveBeenCalledTimes(2);expect(p.guardrails.validateReply).toHaveBeenCalledTimes(2);
    expect((await second.chat.history(reservation.session.ownerId,reservation.session.id)).map(message=>message.role)).toEqual(['assistant','user','assistant']);
    await expect(second.worker.handle(reservation.dispatch!,'duplicate-token')).resolves.toBe('skipped');expect(p.provider.generate).toHaveBeenCalledTimes(1);
  },20000);
  test('completed costly tool request survives lock loss while cheap tool and safety execute again',async()=>{
    const firstPool=pool(),firstSaver=new PostgresSaver(firstPool),p=ports();
    p.provider.generate.mockResolvedValueOnce(tool).mockResolvedValue(final);
    const first=service(firstPool,firstSaver,p),reservation=await reserve(first.chat,'안녕');
    p.retrieval.search.mockImplementationOnce(async()=>{first.worker.loseLock('tool-token');return [source];});
    await first.worker.handle(reservation.dispatch!,'tool-token');await pause(100);
    expect(p.provider.generate).toHaveBeenCalledTimes(1);
    const receipts=await modelThreads(firstPool,reservation.turn.id);expect(receipts).toHaveLength(1);
    const saved=await firstSaver.getTuple({configurable:{thread_id:receipts[0],checkpoint_ns:''}});
    expect((saved?.checkpoint.channel_values.call as {receipt?:{rawResponse:string}})?.receipt?.rawResponse).toBe(tool);
    expect(JSON.stringify(saved)).not.toContain(persona.identity);expect(JSON.stringify(saved)).not.toContain(source.id);
    await close(firstPool);
    const secondPool=pool(),secondSaver=new PostgresSaver(secondPool),second=service(secondPool,secondSaver,p);
    await second.worker.handle(reservation.dispatch!,'tool-resume-token');
    const done=await second.chat.getTurn(reservation.session.ownerId,reservation.turn.id);
    expect(done.state).toBe('completed');expect(await modelThreads(secondPool,reservation.turn.id)).toHaveLength(2);expect(done.reply?.agent).toMatchObject({modelCalls:2,toolCalls:1});
    expect(p.provider.generate).toHaveBeenCalledTimes(2);expect(p.retrieval.search).toHaveBeenCalledTimes(2);expect(p.assess).toHaveBeenCalledTimes(2);
    expect(p.guardrails.validateInput).toHaveBeenCalledTimes(2);expect(p.guardrails.validateReply).toHaveBeenCalledTimes(1);
  },20000);
  test('successful pending costly receipt replays after model-node lock loss across fresh pools',async()=>{
    const firstPool=pool(),firstSaver=new PostgresSaver(firstPool),p=ports();
    const first=service(firstPool,firstSaver,p),reservation=await reserve(first.chat);
    p.provider.generate.mockImplementationOnce(async()=>{first.worker.loseLock('pending-token');return final;});
    await first.worker.handle(reservation.dispatch!,'pending-token');await pause(100);
    const receipts=await modelThreads(firstPool,reservation.turn.id);expect(receipts).toHaveLength(1);
    const saved=await firstSaver.getTuple({configurable:{thread_id:receipts[0],checkpoint_ns:''}});
    expect(saved?.pendingWrites?.some(([,channel,value])=>channel==='__return__'&&!!value&&typeof value==='object'&&'rawResponse' in value&&value.rawResponse===final)).toBe(true);
    await close(firstPool);
    const secondPool=pool(),second=service(secondPool,new PostgresSaver(secondPool),p);
    await second.worker.handle(reservation.dispatch!,'pending-resume-token');
    expect((await second.chat.getTurn(reservation.session.ownerId,reservation.turn.id)).state).toBe('completed');
    expect(p.provider.generate).toHaveBeenCalledTimes(1);expect(p.retrieval.search).toHaveBeenCalledTimes(2);expect(p.assess).toHaveBeenCalledTimes(2);
    expect(p.guardrails.validateInput).toHaveBeenCalledTimes(2);expect(p.guardrails.validateReply).toHaveBeenCalledTimes(1);
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
    await first.worker.handle(reservation.dispatch!,'gap-token');await pause(100);expect(upstreamReturned).toBe(true);await modelThreads(firstPool,reservation.turn.id);await close(firstPool);
    const secondPool=pool(),secondSaver=new PostgresSaver(secondPool),second=service(secondPool,secondSaver,p);
    await second.worker.handle(reservation.dispatch!,'gap-resume-token');
    expect((await second.chat.getTurn(reservation.session.ownerId,reservation.turn.id)).state).toBe('completed');
    // Intentional risk evidence, not an exactly-once claim. Billable calls need the independent durable provider ledger.
    expect(p.provider.generate).toHaveBeenCalledTimes(2);expect(p.assess).toHaveBeenCalledTimes(2);expect(p.retrieval.search).toHaveBeenCalledTimes(2);
  },20000);

});
