import type {Pool} from 'pg';
import {PostgresConversationStore} from '../src/conversations';
function harness(rows:Record<string,unknown>[][]=[]) {
 const calls:string[]=[]; const query=jest.fn(async (sql:string)=>{calls.push(sql);const result=sql.startsWith('SELECT')?rows.shift()??[]:[];return {rows:result,rowCount:result.length};});
 const pool={query,connect:async()=>({query,release:jest.fn()})} as unknown as Pool;
 return {store:new PostgresConversationStore(pool),calls};
}
it('session deletion refuses an active turn without modifying content',async()=>{
 const h=harness([[{id:'synthetic-session'}],[{id:'synthetic-active'}]]);
 await expect(h.store.deleteOwnedSession('synthetic-session','synthetic-owner')).rejects.toMatchObject({code:'TURN_ACTIVE'});
 expect(h.calls.at(-1)).toBe('ROLLBACK');expect(h.calls.some(x=>x.startsWith('DELETE'))).toBe(false);
});
it('session deletion locks ownership, erases payloads and preserves durable execution identity',async()=>{
 const h=harness([[{id:'synthetic-session'}],[]]);
 expect(await h.store.deleteOwnedSession('synthetic-session','synthetic-owner')).toBe(true);
 expect(h.calls.join('\n')).toContain('FOR UPDATE');
 expect(h.calls.join('\n')).toContain("context='{}'::jsonb");
 expect(h.calls.join('\n')).toContain("user_text=''");
 expect(h.calls.join('\n')).not.toMatch(/SET (execution_id|result_hash|context_hash)=/);
 expect(h.calls.at(-1)).toBe('COMMIT');
});
it('session deletion is owner scoped and a missing owner cannot mutate data',async()=>{
 const h=harness([[]]);expect(await h.store.deleteOwnedSession('synthetic-session','synthetic-other')).toBe(false);
 expect(h.calls.some(x=>x.startsWith('DELETE'))).toBe(false);
});
it('forgetting records a tombstone and clears owner-persona summaries',async()=>{
 const h=harness([[{persona_id:'synthetic-persona'}]]);await h.store.forgetUserMemory('synthetic-memory','synthetic-owner');
 expect(h.calls.join('\n')).toMatch(/UPDATE user_memories SET forgotten=true/);
 expect(h.calls.join('\n')).toMatch(/UPDATE sessions SET summary=NULL,summary_last_message_id=NULL/);
 expect(h.calls.at(-1)).toBe('COMMIT');
});
it('forget-all clears every summary for the owner and persona',async()=>{
 const h=harness();await h.store.deleteUserMemories('synthetic-owner','synthetic-persona');
 expect(h.calls.join('\n')).toMatch(/UPDATE sessions SET summary=NULL,summary_last_message_id=NULL/);
 expect(h.calls.join('\n')).toMatch(/UPDATE user_memories SET forgotten=true/);
 expect(h.calls.at(-1)).toBe('COMMIT');
});

import {acceptUserMemory,coveredHistory} from '../src/llm-control';
it('memory boundary rejects lack of consent, inferred facts, sensitive text, overlong text',()=>{
 expect(acceptUserMemory(false,'I like tea','tea')).toBe(false);
 expect(acceptUserMemory(true,'I like tea','coffee')).toBe(false);
 expect(acceptUserMemory(true,'my phone is 010-1234-5678','010-1234-5678')).toBe(false);
 expect(acceptUserMemory(true,'병원 다녀왔어','병원')).toBe(false);
 for(const text of ['나는 임신 중이야','나는 천식이 있어','나는 무신론자야','I have cancer','My salary is high','I am Buddhist','I am Catholic'])expect(acceptUserMemory(true,text,text)).toBe(false);
 expect(acceptUserMemory(true,'x'.repeat(121),'x'.repeat(121))).toBe(false);
 expect(acceptUserMemory(true,'I like green tea','green tea')).toBe(true);
 expect(acceptUserMemory(true,'차 좋아','차')).toBe(false);
 expect(acceptUserMemory(true,'😀😀😀😀','😀😀😀😀')).toBe(true);
});

it('summary coverage skips a missing watermark and includes only the exact suffix when present',()=>{
 const history=Array.from({length:41},(_,i)=>({id:`synthetic-${i}`}));
 expect(coveredHistory(history,'synthetic summary','missing')).toEqual({history:history.slice(-40),summaryGap:true});
 expect(coveredHistory(history,'synthetic summary','synthetic-0')).toEqual({history:history.slice(1),summary:{text:'synthetic summary',lastMessageId:'synthetic-0'}});
 expect(coveredHistory(history)).toEqual({history:history.slice(-40)});
});

import {PostgresLlmControl} from '../src/llm-control';
it.each([false,true])('reservation snapshots utterance-time consent (%s)',async consent=>{
 const sessionId='00000000-0000-4000-8000-000000000002';
 const client={release:jest.fn(),query:jest.fn(async(sql:string,values:unknown[]=[])=>{
  if(sql.startsWith('SELECT id,document FROM sessions'))return {rows:[{id:sessionId,document:{userMemoryConsent:consent}}],rowCount:1};
  if(sql.startsWith('INSERT INTO turns'))return {rows:[{id:values[0],session_id:sessionId,owner_id:'synthetic-owner',client_request_id:'synthetic-key',user_text:'synthetic utterance',sequence:1,state:'pending',created_at:new Date()}],rowCount:1};
  return {rows:[],rowCount:0};
 })};
 const store=new PostgresConversationStore({connect:async()=>client} as unknown as Pool);
 await store.reserveTurn(sessionId,'synthetic-owner','synthetic-key','synthetic utterance');
 const insertion=client.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO turns'))!;
 expect(insertion[0]).toContain('user_memory_consent_at_input');
 expect(insertion[1]![7]).toBe(consent);
});
it.each([{consent:false,gap:false},{consent:true,gap:false},{consent:true,gap:true}])('sends forgotten exclusions and consent-bound prior user words (%j)',async({consent,gap})=>{
 const turnId='00000000-0000-4000-8000-000000000001',sessionId='00000000-0000-4000-8000-000000000002',executionId='00000000-0000-4000-8000-000000000003';
 const session={id:sessionId,ownerId:'synthetic-owner',personId:'synthetic-person',personaId:'synthetic-persona',personaRevision:'synthetic-v1',language:'ko',timezone:'UTC',retrievalMode:'off',createdAt:'2026-10-15T00:00:00Z',userMemoryConsent:consent};
 const input={sessionId,clientRequestId:'synthetic-request',text:'hello synthetic'};
 const client={release:jest.fn(),query:jest.fn(async(sql:string,values:unknown[]=[])=>{
  if(sql.includes('FOR UPDATE OF s,t'))return {rows:[{id:turnId,session_id:sessionId,owner_id:session.ownerId,client_request_id:input.clientRequestId,user_text:input.text,sequence:1,state:'pending',dispatch_seq:0,attempts:0,lease_owner:null,request_input:input,session_document:session,created_at:new Date(session.createdAt),summary:gap?'stale synthetic summary':null,summary_last_message_id:gap?'00000000-0000-4000-8000-000000009999':null}],rowCount:1};
  if(sql.startsWith('SELECT * FROM turn_execution_grants'))return {rows:[],rowCount:0};
  if(sql.includes('FROM turn_outbox'))return {rows:[{expired:false}],rowCount:1};
  if(sql.includes('SELECT m.*'))return {rows:gap?Array.from({length:40},(_,i)=>({id:`00000000-0000-4000-8000-${String(i+100).padStart(12,'0')}`,session_id:sessionId,turn_id:turnId,role:'user',content:'synthetic',created_at:new Date(session.createdAt)})):[],rowCount:0};
  if(sql.includes('FROM user_memories'))return {rows:[{id:'00000000-0000-4000-8000-000000000004',kind:'like',text:'blue skies',forgotten:true}],rowCount:1};
  if(sql.includes('FROM sessions prior'))return {rows:[{user_text:'I like green trees'}],rowCount:1};
  if(sql.startsWith('INSERT INTO turn_execution_grants'))return {rows:[{turn_id:turnId,dispatch_seq:0,execution_id:executionId,generation:1,deadline_at:Date.now()+30000,context_hash:'a'.repeat(64),context:values[5]}],rowCount:1};
  return {rows:[],rowCount:0};
 })};
 const control=new PostgresLlmControl({connect:async()=>client} as unknown as Pool,async()=>true);
 const result=await control.start({contractVersion:2,turnId,dispatchSeq:0,executionId,jobId:`t-${turnId}-0`,lockToken:'synthetic-lock'});
 expect(result.status).toBe('granted');
 if(result.status==='granted'){
  expect(result.grant.context.userMemories).toEqual([{id:'00000000-0000-4000-8000-000000000004',kind:'like',text:'blue skies',forgotten:true}]);
  expect(result.grant.context.previousSessionUserSaid).toBe(consent?'I like green trees':undefined);
  if(gap){expect(result.grant.context.summaryGap).toBe(true);expect(result.grant.context.summary).toBeUndefined();}
 }
 expect(client.query.mock.calls.some(([sql])=>sql.includes('UPDATE sessions SET summary=NULL,summary_last_message_id=NULL'))).toBe(gap);
 const priorQuery=client.query.mock.calls.find(([sql])=>sql.includes('FROM sessions prior'))?.[0];
 if(consent){expect(priorQuery).toContain('t.user_memory_consent_at_input');expect(priorQuery).toContain("NOT IN ('refuse','deflect')");expect(priorQuery).not.toContain("prior.document->>'userMemoryConsent'");}
});
it.each([{consent:false,gap:false,forgottenAfterGrant:false},{consent:true,gap:false,forgottenAfterGrant:false},{consent:true,gap:true,forgottenAfterGrant:false},{consent:true,gap:false,forgottenAfterGrant:true}])('completion respects stored consent, summary coverage and forgetting: %j',async({consent,gap,forgottenAfterGrant})=>{
 const turnId='00000000-0000-4000-8000-000000000001',sessionId='00000000-0000-4000-8000-000000000002',executionId='00000000-0000-4000-8000-000000000003';
 const queries:Array<{sql:string;values:unknown[]}>=[];
 const client={release:jest.fn(),query:jest.fn(async(sql:string,values:unknown[]=[])=>{
  queries.push({sql,values});
  if(sql.includes('FOR UPDATE'))return {rows:[{id:turnId,session_id:sessionId,owner_id:'synthetic-owner',dispatch_seq:0,lease_owner:executionId,attempts:1,state:'validating',summary:null,summary_last_message_id:null,user_text:'I like green tea',session_document:{personId:'synthetic-person',personaId:'synthetic-persona',personaRevision:'synthetic-v1',userMemoryConsent:consent}}]};
  if(sql.startsWith('SELECT * FROM turn_execution_grants'))return {rows:[{deadline_at:Date.now()+60000,context:{history:[{id:'00000000-0000-4000-8000-000000000005'}],...(gap?{summaryGap:true}:{}),userMemories:forgottenAfterGrant?[{id:'00000000-0000-4000-8000-000000000006',kind:'like',text:'blue skies',forgotten:false}]:[]}}]};
  if(sql.includes('SELECT text FROM user_memories'))return {rows:forgottenAfterGrant?[{text:'blue skies'}]:[]};
  return {rows:[],rowCount:0};
 })};
 const store=new PostgresLlmControl({connect:async()=>client} as unknown as Pool,async()=>true);
 const reply={sessionId,turnId,messageId:'00000000-0000-4000-8000-000000000004',personId:'synthetic-person',personaRevision:'synthetic-v1',responseKind:'small_talk' as const,status:'answered' as const,content:'synthetic',claims:[],evidence:[],limitations:[]};
 expect(await store.complete({contractVersion:2,turnId,dispatchSeq:0,executionId,generation:1,jobId:`t-${turnId}-0`,lockToken:'synthetic-lock',result:{kind:'completed',reply,summaryUpdate:{text:'synthetic summary',lastMessageId:'00000000-0000-4000-8000-000000000005'},userMemoryOps:[{op:'add',kind:'like',text:'green tea'}]}})).toMatchObject({status:'applied'});
 expect(queries.filter(q=>q.sql.startsWith('UPDATE sessions SET summary='))).toHaveLength(forgottenAfterGrant?0:1);
 if(!forgottenAfterGrant)expect(queries.find(q=>q.sql.startsWith('UPDATE sessions SET summary='))?.values).toEqual([sessionId,'synthetic summary','00000000-0000-4000-8000-000000000005']);
 const inserts=queries.filter(q=>q.sql.includes('INSERT INTO user_memories'));
 expect(inserts).toHaveLength(consent?1:0);
 if(consent){expect(inserts[0]!.sql).toContain('persona_id=$3 AND NOT forgotten)<30');expect(inserts[0]!.sql).toContain('text=$6 OR (forgotten');}
 expect(queries.at(-1)!.sql).toBe('COMMIT');
});

it('drops a failed memory insert without rolling back the completed turn',async()=>{
 const turnId='00000000-0000-4000-8000-000000000001',sessionId='00000000-0000-4000-8000-000000000002',executionId='00000000-0000-4000-8000-000000000003';
 const calls:string[]=[];
 const client={release:jest.fn(),query:jest.fn(async(sql:string)=>{
  calls.push(sql);
  if(sql.includes('FOR UPDATE OF s,t'))return {rows:[{id:turnId,session_id:sessionId,owner_id:'synthetic-owner',dispatch_seq:0,lease_owner:executionId,attempts:1,state:'validating',user_text:'I like green tea',session_document:{personId:'synthetic-person',personaId:'synthetic-persona',personaRevision:'synthetic-v1',userMemoryConsent:true}}]};
  if(sql.startsWith('SELECT * FROM turn_execution_grants'))return {rows:[{deadline_at:Date.now()+60000,context:{history:[],userMemories:[]}}]};
  if(sql.includes('INSERT INTO user_memories'))throw new Error('synthetic trigger refusal');
  return {rows:[],rowCount:0};
 })};
 const store=new PostgresLlmControl({connect:async()=>client} as unknown as Pool,async()=>true);
 const reply={sessionId,turnId,messageId:'00000000-0000-4000-8000-000000000004',personId:'synthetic-person',personaRevision:'synthetic-v1',responseKind:'small_talk' as const,status:'answered' as const,content:'synthetic',claims:[],evidence:[],limitations:[]};
 await expect(store.complete({contractVersion:2,turnId,dispatchSeq:0,executionId,generation:1,jobId:`t-${turnId}-0`,lockToken:'synthetic-lock',result:{kind:'completed',reply,userMemoryOps:[{op:'add',kind:'like',text:'green tea'}]}})).resolves.toMatchObject({status:'applied'});
 expect(calls).toContain('ROLLBACK TO SAVEPOINT memory_insert');
 expect(calls.at(-1)).toBe('COMMIT');
});
