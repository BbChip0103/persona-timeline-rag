import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { ChatSession, Persona } from '@ptr/contracts';
import { PostgresConversationStore, PostgresPersonaRepository } from '@ptr/storage';
import { LiteLLMTextProvider, PostgresBudgetLedger, type ProviderRequestScope } from '@ptr/providers';
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
  test('a real ChatOpenAI adapter cannot rebill after its completed raw receipt expires',async()=>{
    const id=await turn(true);
    const fetcher=jest.fn(async()=>new Response(JSON.stringify({id:'synthetic-generation',object:'chat.completion',created:1,model:'synthetic-model',
      choices:[{index:0,message:{role:'assistant',content:'synthetic private receipt'},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2,cost:0.000001}}),{headers:{'content-type':'application/json'}}));
    const provider=new LiteLLMTextProvider({baseUrl:'http://127.0.0.1:18001/v1',model:'synthetic-model',apiKey:'synthetic-token',fetch:fetcher,billable:{ledger,reservationMicrousd:100}});
    const input=[{role:'user' as const,content:'synthetic receipt request'}],options={signal:new AbortController().signal,requestKey:id};
    await expect(provider.generate(input,options)).resolves.toBe('synthetic private receipt');
    const row=(await pool.query('SELECT key FROM ptr_provider_requests WHERE turn_id=$1',[id])).rows[0];keys.push(row.key);
    await pool.query("UPDATE ptr_provider_requests SET receipt_received_at=now()-interval '91 days' WHERE key=$1",[row.key]);
    const before=await ledger.get(row.key);
    expect((await retainFrameworkReceipts(pool,{requestKeys:[row.key],apply:true,confirmDatabase:'ptr_framework_test'})).scrubbed).toBe(1);
    await expect(provider.generate(input,options)).rejects.toThrow('REQUEST_UNRESOLVED_NO_RESUBMIT');expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await ledger.get(row.key)).toMatchObject({...before,response:null});
  });
  test('locked terminal turn is skipped without waiting or scrubbing; retry after unlock succeeds',async()=>{
    const id=await turn(true),key=await receipt({kind:'decision',turnId:id}),client=await pool.connect();
    try{await client.query('BEGIN');await client.query('SELECT id FROM turns WHERE id=$1 FOR UPDATE',[id]);
      expect((await retainFrameworkReceipts(pool,{requestKeys:[key],apply:true,confirmDatabase:'ptr_framework_test'})).scrubbed).toBe(0);expect((await ledger.get(key))?.response).not.toBeNull();
    }finally{await client.query('ROLLBACK');client.release();}
    expect((await retainFrameworkReceipts(pool,{requestKeys:[key],apply:true,confirmDatabase:'ptr_framework_test'})).scrubbed).toBe(1);
  });
});
