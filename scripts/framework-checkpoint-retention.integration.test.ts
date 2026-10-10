import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint';
import type { ChatSession, Persona } from '@ptr/contracts';
import { PostgresConversationStore, PostgresPersonaRepository } from '@ptr/storage';
import { retainFrameworkCheckpoints } from './framework-checkpoint-retention';
const raw=process.env.PTR_FRAMEWORK_TEST_DATABASE_URL;
const enabled=(()=>{if(!raw)return false;const u=new URL(raw);return u.hostname==='127.0.0.1'&&u.port==='57432'&&u.pathname==='/ptr_framework_test'&&u.username==='ptr_framework_tester';})();
(enabled?describe:describe.skip)('real isolated Postgres checkpoint90day terminal-only retention',()=>{
  let pool:Pool,store:PostgresConversationStore,saver:PostgresSaver;const sessions:string[]=[],threads:string[]=[];
  const persona:Persona={id:'synthetic-checkpoint-retention-persona',personId:'synthetic-checkpoint-retention-person',revision:'synthetic-v1',label:'Synthetic',language:'ko',reviewStatus:'synthetic',identity:'Fictional',concept:'Synthetic retention',style:[],boundaries:[],sourceRefs:[],greeting:'synthetic'};
  beforeAll(async()=>{pool=new Pool({connectionString:raw});store=new PostgresConversationStore(pool);saver=new PostgresSaver(pool);await saver.setup();await new PostgresPersonaRepository(pool).importPersona(persona);});
  afterAll(async()=>{try{for(const thread of threads)await saver.deleteThread(thread);for(const id of sessions){await pool.query('DELETE FROM messages WHERE session_id=$1',[id]);await pool.query('DELETE FROM turns WHERE session_id=$1',[id]);await pool.query('DELETE FROM sessions WHERE id=$1',[id]);}}finally{await pool?.end();}});
  async function fixture(expired:boolean,terminal=true) {
    const id=`synthetic-retention-${randomUUID()}`;const session:ChatSession={id,ownerId:'synthetic-retention-owner',personId:persona.personId,personaId:persona.id,personaRevision:persona.revision,language:'ko',timezone:'UTC',retrievalMode:'off',createdAt:new Date().toISOString()};
    await store.create(session,{id:randomUUID(),sessionId:id,turnId:null,role:'assistant',content:'synthetic',createdAt:session.createdAt});sessions.push(id);
    const input={sessionId:id,clientRequestId:randomUUID(),text:'synthetic retention'};const {turn}=await store.reserveTurn(id,session.ownerId,input.clientRequestId,input.text);
    if(terminal)await store.transitionTurn(turn.id,['pending'],'failed','SYNTHETIC_DONE');
    if(expired)await pool.query("UPDATE turns SET created_at=now()-interval '91 days',finished_at=CASE WHEN state='failed' THEN now()-interval '91 days' ELSE NULL END WHERE id=$1",[turn.id]);
    for(const thread of [`turn:${turn.id}`,`character:${turn.id}`,`model:${turn.id}:${'a'.repeat(64)}`,`model:${turn.id}:${'b'.repeat(64)}`]) {
      threads.push(thread);const checkpoint={...emptyCheckpoint(),channel_values:{synthetic:'synthetic retention sentinel'},channel_versions:{synthetic:'1'}};
      const config=await saver.put({configurable:{thread_id:thread,checkpoint_ns:''}},checkpoint,{source:'input',step:-1,parents:{}},{synthetic:'1'});
      await saver.putWrites(config,[['synthetic','synthetic pending write']],`synthetic-task-${randomUUID()}`);
    }
    return turn.id;
  }
  async function counts(id:string) {
    const result:number[]=[];for(const table of ['checkpoint_writes','checkpoint_blobs','checkpoints'])result.push((await pool.query(`SELECT count(*)::int AS n FROM public.${table} WHERE thread_id=ANY($1::text[])`,[[`turn:${id}`,`character:${id}`,`model:${id}:${'a'.repeat(64)}`,`model:${id}:${'b'.repeat(64)}`]])).rows[0].n);
    return result;
  }
  test('dryrun preserves all rows; apply deletes only expired terminal threads across all three tables, never live/recent ones',async()=>{
    const expired=await fixture(true),recent=await fixture(false),active=await fixture(true,false),turnIds=[expired,recent,active];
    const before=await counts(expired);expect(before.every(count=>count>0)).toBe(true);
    const dry=await retainFrameworkCheckpoints(pool,{turnIds});expect(dry.turnIds).toEqual([expired]);expect(await counts(expired)).toEqual(before);
    const applied=await retainFrameworkCheckpoints(pool,{turnIds,apply:true});expect(applied.turnIds).toEqual([expired]);expect(applied.deleted).toEqual({writes:4,blobs:4,checkpoints:4});
    expect(await counts(expired)).toEqual([0,0,0]);expect((await counts(recent)).every(count=>count>0)).toBe(true);expect((await counts(active)).every(count=>count>0)).toBe(true);
    expect((await retainFrameworkCheckpoints(pool,{turnIds,apply:true})).turnIds).toEqual([]);
  });
  test('discovers model-only orphan writes/blobs but rejects malformed fingerprints and wildcard turn scopes',async()=>{
    const id=await fixture(true),onlyWrites=`model:${id}:${'c'.repeat(64)}`,onlyBlobs=`model:${id}:${'d'.repeat(64)}`;
    const malformed=[`model:${id}:${'A'.repeat(64)}`,`model:${id}:${'e'.repeat(63)}`,`model:${id}:${'f'.repeat(64)}:extra`];
    for(const thread of [onlyWrites,onlyBlobs,...malformed]) {
      threads.push(thread);const checkpoint={...emptyCheckpoint(),channel_values:{synthetic:'sentinel'},channel_versions:{synthetic:'1'}};
      const config=await saver.put({configurable:{thread_id:thread,checkpoint_ns:''}},checkpoint,{source:'input',step:-1,parents:{}},{synthetic:'1'});
      await saver.putWrites(config,[['synthetic','pending']],`synthetic-${randomUUID()}`);
    }
    for(const table of ['checkpoint_writes','checkpoint_blobs','checkpoints']) {
      await pool.query(`DELETE FROM public.${table} WHERE thread_id=ANY($1::text[])`,[[`turn:${id}`,`character:${id}`,`model:${id}:${'a'.repeat(64)}`,`model:${id}:${'b'.repeat(64)}`]]);
      if(table!=='checkpoint_writes')await pool.query(`DELETE FROM public.${table} WHERE thread_id=$1`,[onlyWrites]);
      if(table!=='checkpoint_blobs')await pool.query(`DELETE FROM public.${table} WHERE thread_id=$1`,[onlyBlobs]);
    }
    expect((await retainFrameworkCheckpoints(pool,{turnIds:[`${id}%`],apply:true})).turnIds).toEqual([]);
    const result=await retainFrameworkCheckpoints(pool,{turnIds:[id],apply:true});
    expect(result.threadIds.sort()).toEqual([onlyWrites,onlyBlobs].sort());expect(result.deleted).toEqual({writes:1,blobs:1,checkpoints:0});
    for(const table of ['checkpoint_writes','checkpoint_blobs','checkpoints'])
      expect((await pool.query(`SELECT count(*)::int AS n FROM public.${table} WHERE thread_id=ANY($1::text[])`,[malformed])).rows[0].n).toBe(3);
  });
  test('concurrent terminal row lock is skipped, not waited for or deleted',async()=>{
    const expired=await fixture(true),client=await pool.connect();
    try {await client.query('BEGIN');await client.query('SELECT id FROM turns WHERE id=$1 FOR UPDATE',[expired]);
      const result=await retainFrameworkCheckpoints(pool,{turnIds:[expired],apply:true});expect(result.turnIds).toEqual([]);expect((await counts(expired)).every(count=>count>0)).toBe(true);
    } finally {await client.query('ROLLBACK');client.release();}
    expect((await retainFrameworkCheckpoints(pool,{turnIds:[expired],apply:true})).turnIds).toEqual([expired]);
  });
});
