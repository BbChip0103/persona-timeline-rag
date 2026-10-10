import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {ChatSession} from '@ptr/contracts';
import type {Reply} from '../../../contracts/llm/v1/generated';
import {createLocalPool} from '../src/pool';
import {PostgresConversationStore} from '../src/conversations';
import {PostgresLlmControl} from '../src/llm-control';
import type {Binding,CompleteRequest,StartRequest} from '../../../contracts/llm/v1/validate';
const raw=process.env.PTR_SPLIT_TEST_APP_DATABASE_URL;
const safe=()=>{if(!raw)return false;const u=new URL(raw);return u.hostname==='127.0.0.1'&&u.port==='58432'&&u.pathname==='/ptr_split_test'&&u.username==='ptr_split_app';};
const suite=safe()?describe:describe.skip;
suite('split app durable Start/Complete handshake synthetic PG',()=>{
  let pool:Pool,store:PostgresConversationStore,control:PostgresLlmControl;const sessions:string[]=[];let lock='';
  beforeAll(()=>{pool=createLocalPool(raw!,{schema:'app'});store=new PostgresConversationStore(pool);control=new PostgresLlmControl(pool,async request=>request.lockToken===lock);});
  afterAll(async()=>{for(const id of sessions){await pool.query('DELETE FROM messages WHERE session_id=$1',[id]);await pool.query('DELETE FROM turn_execution_grants WHERE turn_id IN(SELECT id FROM turns WHERE session_id=$1)',[id]);await pool.query('DELETE FROM turn_outbox WHERE turn_id IN(SELECT id FROM turns WHERE session_id=$1)',[id]);await pool.query('DELETE FROM turns WHERE session_id=$1',[id]);await pool.query('DELETE FROM sessions WHERE id=$1',[id]);}await pool?.end();});
  async function fixture() {
    const id=randomUUID();const session:ChatSession={id,ownerId:'owner_synthetic_control',personId:'synthetic-person',personaId:'synthetic-persona',personaRevision:'synthetic-v1',language:'ko',timezone:'UTC',retrievalMode:'off',executionProfile:'agent_loop',createdAt:new Date().toISOString()};
    await store.create(session,{id:randomUUID(),sessionId:id,turnId:null,role:'assistant',content:'synthetic greeting',createdAt:session.createdAt});sessions.push(id);
    const input={sessionId:id,clientRequestId:randomUUID(),text:'synthetic hello'};
    const reserved=await store.reserveTurn(id,session.ownerId,input.clientRequestId,input.text,undefined,input);
    lock='synthetic-current';const request:StartRequest={contractVersion:1,turnId:reserved.turn.id,dispatchSeq:0,jobId:`t-${reserved.turn.id}-0`,lockToken:lock,executionId:randomUUID()};
    const reply:Reply={sessionId:id,turnId:reserved.turn.id,messageId:randomUUID(),personId:session.personId,personaRevision:session.personaRevision,responseKind:'small_talk',status:'answered',content:'synthetic reply',claims:[],evidence:[],limitations:[]};
    return {session,request,reply};
  }
  async function claimed() {const f=await fixture(),response=await control.start(f.request);if(response.status!=='granted')throw new Error('EXPECTED_GRANT');return {...f,grant:response.grant,binding:{...f.request,generation:response.grant.generation} as Binding};}
  test('lost Start ACK returns exact same durable snapshot/generation; no timed DB heartbeat',async()=>{
    const f=await claimed();expect(await control.start(f.request)).toEqual({contractVersion:1,status:'granted',grant:f.grant});
    expect(await control.snapshot(f.binding)).toEqual({contractVersion:1,status:'granted',grant:f.grant});expect(f.grant.context.history).toHaveLength(1);expect(f.grant.context.session.executionProfile).toBe('agent_loop');
    expect((await pool.query('SELECT * FROM turn_leases WHERE turn_id=$1',[f.request.turnId])).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM turn_outbox WHERE turn_id=$1',[f.request.turnId])).rowCount).toBe(1);
  });
  test('reclaimed queue token issues fresh fencing generation; old result cannot publish',async()=>{
    const f=await claimed();lock='synthetic-reclaimed';const fresh={...f.request,executionId:randomUUID(),lockToken:lock};
    const response=await control.start(fresh);expect(response.status).toBe('granted');if(response.status!=='granted')return;
    expect(response.grant.generation).toBe(2);expect(await control.status(f.binding)).toEqual({contractVersion:1,status:'lost'});
    expect(await control.complete({...f.binding,result:{kind:'completed',reply:f.reply}})).toEqual({contractVersion:1,status:'lost'});
  });
  test('Complete commit ACK loss replays after lock expiry, result equality rejects mutations',async()=>{
    const f=await claimed(),request:CompleteRequest={...f.binding,result:{kind:'completed',reply:f.reply}};
    expect(await control.complete(request)).toEqual({contractVersion:1,status:'applied'});lock='expired';
    expect(await control.complete(request)).toEqual({contractVersion:1,status:'alreadyApplied'});
    await expect(control.complete({...request,result:{kind:'completed',reply:{...f.reply,content:'changed synthetic'}}})).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
    expect((await store.history(f.session.id,f.session.ownerId)).map(m=>m.role)).toEqual(['assistant','user','assistant']);
    expect((await pool.query('SELECT * FROM turn_outbox WHERE turn_id=$1',[f.request.turnId])).rowCount).toBe(0);
  });
  test('message write failure atomically rolls back reply/ACK/outbox; exact retry completes once',async()=>{
    const f=await claimed();const greeting=(await store.history(f.session.id,f.session.ownerId))[0];
    await expect(control.complete({...f.binding,result:{kind:'completed',reply:{...f.reply,messageId:greeting.id}}})).rejects.toMatchObject({code:'23505'});
    expect((await store.getTurn(f.request.turnId,f.session.ownerId))?.state).toBe('pending');
    expect((await pool.query('SELECT result_hash FROM turn_execution_grants WHERE execution_id=$1',[f.request.executionId])).rows[0].result_hash).toBeNull();
    expect((await pool.query('SELECT * FROM turn_outbox WHERE turn_id=$1',[f.request.turnId])).rowCount).toBe(1);
    expect((await control.complete({...f.binding,result:{kind:'completed',reply:f.reply}})).status).toBe('applied');
  });
  test('bounded snapshot retains previous pinned evidence, prompt metadata, variables and distinct support/lore safety',async()=>{
    const f=await claimed(),card={sourceId:'synthetic-source',personId:f.session.personId,sourceUrl:'https://example.com/synthetic',postedAt:'2026-10-10T00:00:00Z',eventDate:null,snapshot:'synthetic-snapshot',hash:'synthetic-hash',quote:'synthetic evidence'};
    const previous:Reply={...f.reply,evidence:[card],sourceContext:{revision:'synthetic-source-context',references:[card]},promptEvidence:{sourceIds:['synthetic-source'],annotationIds:[],omittedAnnotations:0,promptBytes:100},agent:{revision:'synthetic-agent',promptRevision:'synthetic-prompt',modelCalls:1,toolCalls:0,variables:{conversationTopic:'synthetic-topic',tone:'warm'},steps:[],validator:'disabled'},inputSafety:{decidedBy:'rule',action:'support',category:'self_harm',fired:['self_harm']},personaContext:{loreIds:['synthetic-lore'],loreOmitted:0}};
    expect((await control.complete({...f.binding,result:{kind:'completed',reply:previous}})).status).toBe('applied');
    const input={sessionId:f.session.id,clientRequestId:randomUUID(),text:'synthetic followup'},reserved=await store.reserveTurn(f.session.id,f.session.ownerId,input.clientRequestId,input.text,undefined,input);
    const request={...f.request,turnId:reserved.turn.id,jobId:`t-${reserved.turn.id}-0`,executionId:randomUUID()},next=await control.start(request);if(next.status!=='granted')throw new Error('EXPECTED_GRANT');
    expect(next.grant.context.history).toHaveLength(3);expect(next.grant.context.previousReply).toEqual(previous);
    expect(next.grant.context.refusedTurnIds).toEqual([]);expect(next.grant.context.loreExcludedTurnIds).toContain(f.request.turnId);
  });
  test('expired same grant may report TURN_TIMEOUT once and replay durable failure ACK',async()=>{
    const f=await claimed();await pool.query('UPDATE turn_execution_grants SET deadline_at=0 WHERE execution_id=$1',[f.request.executionId]);
    const request:CompleteRequest={...f.binding,result:{kind:'failed',errorCode:'TURN_TIMEOUT'}};
    expect((await control.complete(request)).status).toBe('applied');expect((await control.complete(request)).status).toBe('alreadyApplied');
    expect(await store.getTurn(f.request.turnId,f.session.ownerId)).toMatchObject({state:'failed',errorCode:'TURN_TIMEOUT'});
  });
  test('receipt/row-lock deadline crossing terminalizes current owner without publishing or redispatch',async()=>{
    const f=await claimed();await pool.query('UPDATE turn_execution_grants SET deadline_at=0 WHERE execution_id=$1',[f.request.executionId]);
    const complete:CompleteRequest={...f.binding,result:{kind:'completed',reply:f.reply}};
    expect((await control.complete(complete)).status).toBe('lost');
    expect(await store.getTurn(f.request.turnId,f.session.ownerId)).toMatchObject({state:'failed',errorCode:'TURN_TIMEOUT'});
    expect((await pool.query('SELECT * FROM messages WHERE turn_id=$1',[f.request.turnId])).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM turn_outbox WHERE turn_id=$1',[f.request.turnId])).rowCount).toBe(0);
    expect((await control.start({...f.request,executionId:randomUUID()})).status).toBe('lost');
    expect((await control.complete(complete)).status).toBe('lost');
  });
  test('101 prior history messages fail CONTEXT_LIMIT without silently truncating or granting a model call',async()=>{
    const f=await fixture();
    for(let i=0;i<50;i++) {
      const id=randomUUID();
      await pool.query("INSERT INTO turns(id,session_id,owner_id,client_request_id,user_text,sequence,state) VALUES($1,$2,$3,$1,'synthetic', $4,'completed')",[id,f.session.id,f.session.ownerId,i+2]);
      await pool.query("INSERT INTO messages(id,session_id,turn_id,role,content,created_at) VALUES($1,$2,$3,'user','synthetic prior user',now()),($4,$2,$3,'assistant','synthetic prior assistant',now())",[randomUUID(),f.session.id,id,randomUUID()]);
    }
    expect((await store.history(f.session.id,f.session.ownerId))).toHaveLength(101);
    expect(await control.start(f.request)).toEqual({contractVersion:1,status:'lost'});
    expect(await store.getTurn(f.request.turnId,f.session.ownerId)).toMatchObject({state:'failed',errorCode:'CONTEXT_LIMIT'});
    expect((await pool.query('SELECT * FROM turn_execution_grants WHERE turn_id=$1',[f.request.turnId])).rowCount).toBe(0);
    expect((await pool.query('SELECT * FROM turn_outbox WHERE turn_id=$1',[f.request.turnId])).rowCount).toBe(0);
  });
  test('cancellation, deadline and immutable persona bindings fence publication',async()=>{
    const cancelled=await claimed();await store.cancelTurn(cancelled.request.turnId,cancelled.session.ownerId);
    expect((await control.complete({...cancelled.binding,result:{kind:'completed',reply:cancelled.reply}})).status).toBe('cancelled');
    const expired=await claimed();await pool.query('UPDATE turn_execution_grants SET deadline_at=0 WHERE execution_id=$1',[expired.request.executionId]);
    expect((await control.status(expired.binding)).status).toBe('lost');expect((await control.complete({...expired.binding,result:{kind:'completed',reply:expired.reply}})).status).toBe('lost');
    const bound=await claimed();await expect(control.complete({...bound.binding,result:{kind:'completed',reply:{...bound.reply,personId:'synthetic-wrong-person'}}})).rejects.toMatchObject({code:'INVALID_INPUT'});
  });
});
