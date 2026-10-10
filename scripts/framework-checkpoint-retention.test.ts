import type { Pool } from 'pg';
import { retainFrameworkCheckpoints } from './framework-checkpoint-retention';
function fixture(ids=['synthetic-expired-turn'],modelThreads:string[]=[]) {
  const query=jest.fn(async(sql:string,_values?:unknown[])=>({rows:sql.startsWith('SELECT current_database')?[{db:'ptr_framework_test',username:'ptr_framework_tester'}]:sql.startsWith('SELECT t.id')?ids.map(id=>({id})):sql.startsWith('SELECT DISTINCT c.thread_id')?[...ids.flatMap(id=>[`turn:${id}`,`character:${id}`]),...modelThreads].map(thread_id=>({thread_id})):[],rowCount:sql.startsWith('DELETE')?2:0}));
  const release=jest.fn(),pool={connect:async()=>({query,release})} as unknown as Pool;
  return {pool,query,release};
}
test('90-day default is dry-run and never reads raw checkpoint fields',async()=>{
  const {pool,query,release}=fixture();const result=await retainFrameworkCheckpoints(pool,{now:new Date('2026-10-10T00:00:00Z')});
  expect(result).toMatchObject({cutoff:'2026-07-12T00:00:00.000Z',applied:false,threadIds:['turn:synthetic-expired-turn','character:synthetic-expired-turn']});
  expect(query.mock.calls.some(([sql])=>sql.startsWith('DELETE'))).toBe(false);expect(query.mock.calls[2][0]).toContain("t.state IN ('completed','failed','cancelled')");
  expect(query.mock.calls[2][0]).not.toMatch(/SELECT (?:checkpoint|blob|metadata|\*)/);expect(release).toHaveBeenCalledTimes(1);
});
test('explicit apply keeps terminal locks and deletion of writes/blobs/checkpoints in one transaction',async()=>{
  const {pool,query}=fixture();const result=await retainFrameworkCheckpoints(pool,{apply:true});
  expect(query.mock.calls.map(([sql])=>sql.split(' ')[0])).toEqual(['BEGIN','SELECT','SELECT','SELECT','DELETE','DELETE','DELETE','COMMIT']);
  expect(query.mock.calls[2][0]).toContain('FOR UPDATE OF t SKIP LOCKED');expect(result.deleted).toEqual({writes:2,blobs:2,checkpoints:2});
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('DELETE')).every(([,values])=>JSON.stringify(values).includes('turn:synthetic-expired-turn'))).toBe(true);
});
test('enumerates model-call threads including orphan writes/blobs without payload reads or wildcard turn binding',async()=>{
  const id='abcdef01-2345-4567-89ab-cdef01234567',thread=`model:${id}:${'a'.repeat(64)}`;
  const {pool,query}=fixture([id],[thread]);const result=await retainFrameworkCheckpoints(pool,{turnIds:[id],apply:true});
  expect(result.threadIds).toContain(thread);
  const selects=query.mock.calls.filter(([sql])=>sql.startsWith('SELECT')).map(([sql])=>sql);
  expect(selects[1]).toContain('checkpoint_writes');expect(selects[1]).toContain('checkpoint_blobs');expect(selects[1]).toContain('checkpoints');
  expect(selects[1]).toContain('[0-9a-f]{64}');expect(selects[1]).toContain('split_part');
  expect(selects[2]).toContain('UNION');expect(selects.join('\n')).not.toMatch(/\bLIKE\b|SELECT (?:checkpoint|blob|metadata|\*)/);
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('DELETE')).every(([,values])=>JSON.stringify(values).includes(thread))).toBe(true);
});
test('empty candidate set never scans or deletes unrelated thread IDs',async()=>{
  const {pool,query}=fixture([]);const result=await retainFrameworkCheckpoints(pool,{apply:true});
  expect(result.threadIds).toEqual([]);expect(query.mock.calls.filter(([sql])=>sql.startsWith('SELECT DISTINCT'))).toHaveLength(0);
});
test.each([0,1,89,90.5])('rejects retention below90 or noninteger before DB access (%s)',async days=>{
  const {pool,query}=fixture();await expect(retainFrameworkCheckpoints(pool,{days})).rejects.toThrow('CHECKPOINT_RETENTION_SCOPE_INVALID');expect(query).not.toHaveBeenCalled();
});
test('a database failure rolls back all deletion statements and releases connection',async()=>{
  const {pool,query,release}=fixture();query.mockImplementationOnce(async()=>({rows:[],rowCount:0})).mockImplementationOnce(async()=>({rows:[{db:'ptr_framework_test',username:'ptr_framework_tester'}],rowCount:0}));
  const original=query.getMockImplementation()!;query.mockImplementation(async(sql,values)=>{if(sql.startsWith('DELETE FROM public.checkpoints'))throw new Error('synthetic rollback');return original(sql,values);});
  await expect(retainFrameworkCheckpoints(pool,{apply:true})).rejects.toThrow('synthetic rollback');expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(release).toHaveBeenCalledTimes(1);
});
