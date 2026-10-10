import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ChatSession, ChatReply } from '@ptr/contracts';
import { PostgresConversationStore } from '../src/conversations';
import { PostgresPersonaRepository } from '../src/personas';

// Deliberately refuses all legacy/research targets. Only the fresh framework test container is allowed.
const raw=process.env.PTR_FRAMEWORK_TEST_DATABASE_URL;
function isolated(raw:string|undefined):boolean {
  if(!raw)return false;
  const url=new URL(raw);
  return ['postgres:','postgresql:'].includes(url.protocol)&&url.hostname==='127.0.0.1'&&url.port==='57432'
    &&url.pathname==='/ptr_framework_test'&&url.username==='ptr_framework_tester';
}
const integration=isolated(raw)?describe:describe.skip;
integration('framework generations, durable running outbox, terminal and stale writes',()=>{
  let pool:Pool,store:PostgresConversationStore;const sessions:string[]=[];
  beforeAll(async()=>{pool=new Pool({connectionString:raw});store=new PostgresConversationStore(pool);
    await new PostgresPersonaRepository(pool).importPersona({id:'synthetic-framework-persona',personId:'synthetic-framework-person',revision:'synthetic-v1',label:'Synthetic',language:'ko',reviewStatus:'synthetic',identity:'Fictional',concept:'test',style:[],boundaries:[],sourceRefs:[],greeting:'synthetic'});});
  afterAll(async()=>{for(const id of sessions){await pool.query('DELETE FROM messages WHERE session_id=$1',[id]);await pool.query('DELETE FROM turns WHERE session_id=$1',[id]);await pool.query('DELETE FROM sessions WHERE id=$1',[id]);}await pool?.end();});
  async function fixture() {
    const id=`synthetic-framework-${randomUUID()}`;
    const s:ChatSession={id,ownerId:'synthetic-framework-owner',personId:'synthetic-framework-person',personaId:'synthetic-framework-persona',personaRevision:'synthetic-v1',language:'ko',timezone:'UTC',retrievalMode:'off',createdAt:new Date().toISOString()};
    await store.create(s,{id:randomUUID(),sessionId:id,turnId:null,role:'assistant',content:'synthetic',createdAt:s.createdAt});sessions.push(id);
    const input={sessionId:id,clientRequestId:randomUUID(),text:'synthetic hello'};
    const reserved=await store.reserveTurn(id,s.ownerId,input.clientRequestId,input.text,undefined,input);
    return {s,turn:reserved.turn,dispatch:reserved.dispatch!,reply:{sessionId:id,turnId:reserved.turn.id,messageId:randomUUID(),personId:s.personId,personaRevision:s.personaRevision,responseKind:'small_talk',status:'answered',content:'synthetic answer',claims:[],evidence:[],limitations:[]} as ChatReply};
  }
  test('claim keeps outbox, creates no timed lease; terminal commit removes outbox and duplicate runs no-op',async()=>{
    const {s,turn,dispatch,reply}=await fixture();
    const claim=await store.claimExecution(dispatch,'worker-token-a',60000,3);expect(claim?.fence.attempt).toBe(1);
    expect(await store.executionStatus(turn.id,claim!.fence)).toBe('current');
    expect((await pool.query('SELECT seq FROM turn_outbox WHERE turn_id=$1',[turn.id])).rows).toEqual([{seq:0}]);
    expect((await pool.query('SELECT * FROM turn_leases WHERE turn_id=$1',[turn.id])).rowCount).toBe(0);
    expect(await store.transitionTurn(turn.id,['pending'],'generating',undefined,claim!.fence)).toBe(true);
    await store.transitionTurn(turn.id,['generating'],'validating',undefined,claim!.fence);
    expect(await store.completeTurn(turn.id,reply,claim!.fence)).toBe(true);
    expect(await store.executionStatus(turn.id,claim!.fence)).toBe('lost');
    expect((await pool.query('SELECT * FROM turn_outbox WHERE turn_id=$1',[turn.id])).rowCount).toBe(0);
    expect(await store.claimExecution(dispatch,'worker-token-b',60000,3)).toBeUndefined();
    expect((await store.history(s.id,s.ownerId)).map(m=>m.role)).toEqual(['assistant','user','assistant']);
  });
  test('stalled redelivery advances generation; stale worker cannot write completion or failure',async()=>{
    const {turn,dispatch,reply}=await fixture();const old=await store.claimExecution(dispatch,'old-token',60000,3);
    await store.transitionTurn(turn.id,['pending'],'generating',undefined,old!.fence);
    const current=await store.claimExecution(dispatch,'new-token',60000,3);expect(current?.fence.attempt).toBe(2);
    expect(await store.executionStatus(turn.id,old!.fence)).toBe('lost');expect(await store.executionStatus(turn.id,current!.fence)).toBe('current');
    expect(await store.transitionTurn(turn.id,['pending'],'failed','STALE',old!.fence)).toBe(false);
    await store.transitionTurn(turn.id,['pending'],'generating',undefined,current!.fence);
    await store.transitionTurn(turn.id,['generating'],'validating',undefined,current!.fence);
    expect(await store.completeTurn(turn.id,reply,old!.fence)).toBe(false);expect(await store.completeTurn(turn.id,reply,current!.fence)).toBe(true);
  });
  test('Redis-loss recovery changes seq and invalidates stale token; an old recovery scan cannot invalidate the new owner',async()=>{
    const {turn,dispatch}=await fixture();const old=await store.claimExecution(dispatch,'old-token',60000,3);
    const observed={...dispatch,fence:old!.fence};const next=await store.repairExecution(observed,3);expect(next).toEqual({...dispatch,seq:1});
    expect(await store.claimExecution(dispatch,'late-token',60000,3)).toBeUndefined();
    const current=await store.claimExecution(next!,'new-token',60000,3);expect(current?.fence.attempt).toBe(2);
    expect(await store.repairExecution(observed,3)).toBeUndefined();expect(await store.transitionTurn(turn.id,['pending'],'failed','STALE',old!.fence)).toBe(false);
    expect(await store.transitionTurn(turn.id,['pending'],'failed','SYNTHETIC_DONE',current!.fence)).toBe(true);
  });
  test('DB message-write failure rolls back completion and outbox deletion, then recovery completes exactly one history pair',async()=>{
    const {s,turn,dispatch,reply}=await fixture();const claim=await store.claimExecution(dispatch,'token-a',60000,3);
    await store.transitionTurn(turn.id,['pending'],'generating',undefined,claim!.fence);
    await store.transitionTurn(turn.id,['generating'],'validating',undefined,claim!.fence);
    const greeting=(await store.history(s.id,s.ownerId))[0];
    await expect(store.completeTurn(turn.id,{...reply,messageId:greeting.id},claim!.fence)).rejects.toMatchObject({code:'23505'});
    expect(await store.getTurn(turn.id,s.ownerId)).toMatchObject({state:'validating'});
    expect((await pool.query('SELECT seq FROM turn_outbox WHERE turn_id=$1',[turn.id])).rows).toEqual([{seq:0}]);
    const next=await store.repairExecution({...dispatch,fence:claim!.fence},3);
    const current=await store.claimExecution(next!,'token-b',60000,3);
    await store.transitionTurn(turn.id,['pending'],'generating',undefined,current!.fence);
    await store.transitionTurn(turn.id,['generating'],'validating',undefined,current!.fence);
    expect(await store.completeTurn(turn.id,reply,current!.fence)).toBe(true);
    expect((await store.history(s.id,s.ownerId)).map(message=>message.role)).toEqual(['assistant','user','assistant']);
  });
  test('cancelled execution never accepts a late result and retires durable outbox',async()=>{
    const {s,turn,dispatch,reply}=await fixture();const claim=await store.claimExecution(dispatch,'token-a',60000,3);
    await store.transitionTurn(turn.id,['pending'],'generating',undefined,claim!.fence);expect(await store.cancelTurn(turn.id,s.ownerId)).toBe(true);
    expect(await store.executionStatus(turn.id,claim!.fence)).toBe('cancelled');
    expect(await store.completeTurn(turn.id,reply,claim!.fence)).toBe(false);expect(await store.claimExecution(dispatch,'token-b',60000,3)).toBeUndefined();
    expect((await pool.query('SELECT * FROM turn_outbox WHERE turn_id=$1',[turn.id])).rowCount).toBe(0);
  });
  test('queue age uses DB clock; unclaimed expiry remains QUEUE_TIMEOUT',async()=>{
    const {s,turn,dispatch}=await fixture();await pool.query("UPDATE turn_outbox SET created_at=now()-interval '61 seconds' WHERE turn_id=$1",[turn.id]);
    expect(await store.claimExecution(dispatch,'token',60000,3)).toBeUndefined();expect(await store.getTurn(turn.id,s.ownerId)).toMatchObject({state:'failed',errorCode:'QUEUE_TIMEOUT'});
  });
  test('exhausted framework attempts fail turn, never redispatch',async()=>{
    const {s,turn,dispatch}=await fixture();const claim=await store.claimExecution(dispatch,'token-a',60000,3);
    expect(await store.repairExecution({...dispatch,fence:claim!.fence},3,true)).toBeUndefined();
    expect(await store.getTurn(turn.id,s.ownerId)).toMatchObject({state:'failed',errorCode:'WORKER_LOST'});
  });
});
