import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ChatSession, Persona } from '@ptr/contracts';
import { PostgresConversationStore, PostgresPersonaRepository } from '@ptr/storage';
import { PostgresBudgetLedger, ProviderError, type ProviderRequestScope } from '@ptr/providers';
import { retainFrameworkReceipts } from './framework-receipt-retention';
const raw=process.env.PTR_FRAMEWORK_TEST_DATABASE_URL;
const enabled=(()=>{if(!raw)return false;const u=new URL(raw);return u.hostname==='127.0.0.1'&&u.port==='57432'&&u.pathname==='/ptr_framework_test'&&u.username==='ptr_framework_tester';})();
(enabled?describe:describe.skip)('real isolated Postgres raw receipt90d retention, perpetual accounting/idempotency tombstone',()=>{
  let pool:Pool,ledger:PostgresBudgetLedger,store:PostgresConversationStore;
  const keys:string[]=[],sessions:string[]=[];
  const persona:Persona={id:'synthetic-receipt-retention-persona',personId:'synthetic-receipt-retention-person',revision:'synthetic-v1',label:'Synthetic',language:'en',reviewStatus:'synthetic',identity:'Fictional',concept:'Synthetic retention',style:[],boundaries:[],sourceRefs:[],greeting:'synthetic'};
  beforeAll(async()=>{pool=new Pool({connectionString:raw});ledger=new PostgresBudgetLedger(pool,raw!);await ledger.initialize();store=new PostgresConversationStore(pool);await new PostgresPersonaRepository(pool).importPersona(persona);});
  afterAll(async()=>{try{await pool.query('DELETE FROM ptr_provider_requests WHERE key=ANY($1::text[])',[keys]);
    for(const id of sessions){await pool.query('DELETE FROM messages WHERE session_id=$1',[id]);await pool.query('DELETE FROM turn_outbox WHERE turn_id IN(SELECT id FROM turns WHERE session_id=$1)',[id]);await pool.query('DELETE FROM turns WHERE session_id=$1',[id]);await pool.query('DELETE FROM sessions WHERE id=$1',[id]);}}
    finally{await pool?.end();}});
  async function turn(old:boolean,terminal=true) {
    const id=`synthetic-receipt-${randomUUID()}`,session:ChatSession={id,ownerId:'synthetic-receipt-owner',personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,language:'en',timezone:'UTC',retrievalMode:'off',createdAt:new Date().toISOString()};
    await store.create(session,{id:randomUUID(),sessionId:id,turnId:null,role:'assistant',content:'synthetic',createdAt:session.createdAt});sessions.push(id);
    const {turn}=await store.reserveTurn(id,session.ownerId,randomUUID(),'synthetic receipt');
    if(terminal)await store.transitionTurn(turn.id,['pending'],'failed','SYNTHETIC_DONE');
    if(old)await pool.query("UPDATE turns SET created_at=now()-interval '91 days',finished_at=CASE WHEN state='failed' THEN now()-interval '91 days' ELSE NULL END WHERE id=$1",[turn.id]);
    return turn.id;
  }
  async function receipt(scope?:ProviderRequestScope,old=true,unknown=false) {
    const key=`synthetic-receipt-${randomUUID()}`;keys.push(key);await ledger.reserve(key,100,{scope});await ledger.submitted(key);
    await ledger.finish(key,unknown?null:7,{synthetic:'raw-conversation-sentinel'},'synthetic-generation');
    if(old)await pool.query("UPDATE ptr_provider_requests SET receipt_received_at=now()-interval '91 days' WHERE key=$1",[key]);
    return key;
  }
  test('only old terminal chat/Jev and standalone drafts scrub; active/recent/legacy/missing/embedding receipts are preserved and reported',async()=>{
    const old=await turn(true),recent=await turn(false),active=await turn(true,false);
    const eligible=await receipt({kind:'chat',turnId:old}),decision=await receipt({kind:'decision',turnId:old},true,true),draft=await receipt({kind:'draft'});
    const protectedKeys=[await receipt({kind:'chat',turnId:recent}),await receipt({kind:'chat',turnId:active}),await receipt({kind:'chat',turnId:old},false),await receipt(),await receipt({kind:'chat',turnId:randomUUID()}),await receipt({kind:'embedding'})];
    const before=await ledger.get(eligible);
    const dry=await retainFrameworkReceipts(pool,{requestKeys:keys});expect(dry).toMatchObject({receipts:3,scrubbed:0,applied:false,deferred:{legacyUnscoped:1,missingTurn:1,unsupportedKind:1}});expect((await ledger.get(eligible))?.response).not.toBeNull();
    const applied=await retainFrameworkReceipts(pool,{requestKeys:keys,apply:true,confirmDatabase:'ptr_framework_test'});expect(applied.scrubbed).toBe(3);
    const after=await ledger.get(eligible);expect(after).toMatchObject({...before,response:null});expect(after?.receiptScrubbedAt).toBeDefined();
    expect((await ledger.reserve(eligible,100,{scope:{kind:'chat',turnId:old}})).created).toBe(false);
    const savedUnknown=await ledger.get(decision);expect(savedUnknown).toMatchObject({state:'unknown',actualMicrousd:null,response:null,generationId:'synthetic-generation'});
    await ledger.finish(decision,null,{synthetic:'must-not-resurrect'},'synthetic-generation');expect((await ledger.get(decision))?.response).toBeNull();
    expect((await ledger.get(decision))?.receiptScrubbedAt).toBe(savedUnknown?.receiptScrubbedAt);
    for(const key of protectedKeys)expect((await ledger.get(key))?.response).not.toBeNull();
    expect((await ledger.get(draft))?.response).toBeNull();
    expect((await retainFrameworkReceipts(pool,{requestKeys:keys,apply:true,confirmDatabase:'ptr_framework_test'})).scrubbed).toBe(0);
  });
  test('a scrubbed completed raw receipt keeps the idempotency tombstone without raw replay',async()=>{
    const id=await turn(true);
    const key=await receipt({kind:'chat',turnId:id});
    const before=await ledger.get(key);
    expect(before).not.toBeNull();
    expect(before?.response).toEqual({synthetic:'raw-conversation-sentinel'});
    await pool.query("UPDATE ptr_provider_requests SET receipt_received_at=now()-interval '91 days' WHERE key=$1",[key]);
    expect((await retainFrameworkReceipts(pool,{requestKeys:[key],apply:true,confirmDatabase:'ptr_framework_test'})).scrubbed).toBe(1);
    const saved=await ledger.reserve(key,100,{scope:{kind:'chat',turnId:id}});
    expect(saved.created).toBe(false);
    expect(saved.request).toMatchObject({...before!,response:null});
    expect(saved.request.response).toBeNull();
    await expect(ledger.submitted(key)).rejects.toEqual(new ProviderError('REQUEST_ALREADY_SUBMITTED'));
  });
  test('locked terminal turn is skipped without waiting or scrubbing; retry after unlock succeeds',async()=>{
    const id=await turn(true),key=await receipt({kind:'decision',turnId:id}),client=await pool.connect();
    try{await client.query('BEGIN');await client.query('SELECT id FROM turns WHERE id=$1 FOR UPDATE',[id]);
      expect((await retainFrameworkReceipts(pool,{requestKeys:[key],apply:true,confirmDatabase:'ptr_framework_test'})).scrubbed).toBe(0);expect((await ledger.get(key))?.response).not.toBeNull();
    }finally{await client.query('ROLLBACK');client.release();}
    expect((await retainFrameworkReceipts(pool,{requestKeys:[key],apply:true,confirmDatabase:'ptr_framework_test'})).scrubbed).toBe(1);
  });
});
