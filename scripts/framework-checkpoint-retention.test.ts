import type { Pool } from 'pg';
import { retainFrameworkCheckpoints } from './framework-checkpoint-retention';
function fixture(ids=['synthetic-expired-turn']) {
  const query=jest.fn(async(sql:string,_values?:unknown[])=>({rows:sql.startsWith('SELECT current_database')?[{db:'ptr_framework_test',username:'ptr_framework_tester'}]:sql.startsWith('SELECT t.id')?ids.map(id=>({id})):[],rowCount:sql.startsWith('DELETE')?2:0}));
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
  expect(query.mock.calls.map(([sql])=>sql.split(' ')[0])).toEqual(['BEGIN','SELECT','SELECT','DELETE','DELETE','DELETE','COMMIT']);
  expect(query.mock.calls[2][0]).toContain('FOR UPDATE OF t SKIP LOCKED');expect(result.deleted).toEqual({writes:2,blobs:2,checkpoints:2});
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('DELETE')).every(([,values])=>JSON.stringify(values).includes('turn:synthetic-expired-turn'))).toBe(true);
});
test.each([0,1,89,90.5])('rejects retention below90 or noninteger before DB access (%s)',async days=>{
  const {pool,query}=fixture();await expect(retainFrameworkCheckpoints(pool,{days})).rejects.toThrow('CHECKPOINT_RETENTION_SCOPE_INVALID');expect(query).not.toHaveBeenCalled();
});
test('a database failure rolls back all deletion statements and releases connection',async()=>{
  const {pool,query,release}=fixture();query.mockImplementationOnce(async()=>({rows:[],rowCount:0})).mockImplementationOnce(async()=>({rows:[{db:'ptr_framework_test',username:'ptr_framework_tester'}],rowCount:0}));
  const original=query.getMockImplementation()!;query.mockImplementation(async(sql,values)=>{if(sql.startsWith('DELETE FROM public.checkpoints'))throw new Error('synthetic rollback');return original(sql,values);});
  await expect(retainFrameworkCheckpoints(pool,{apply:true})).rejects.toThrow('synthetic rollback');expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');expect(release).toHaveBeenCalledTimes(1);
});
