import type { Pool } from 'pg';
import { receiptRetentionMain, retainFrameworkReceipts } from './framework-receipt-retention';
function fixture() {
  const query=jest.fn(async(sql:string)=>{
    if(sql.includes('current_database'))return {rows:[{db:'ptr_framework_test',username:'ptr_framework_tester'}]};
    if(sql.includes('AS legacy'))return {rows:[{legacy:2,missing:1,unsupported:1}]};
    if(sql.startsWith('SELECT t.id'))return {rows:[{id:'synthetic-terminal'}]};
    if(sql.startsWith('SELECT r.key'))return {rows:[{key:'synthetic-hash'}]};
    if(sql.startsWith('UPDATE ptr_provider_requests'))return {rows:[],rowCount:1};
    return {rows:[]};
  });
  const release=jest.fn();return {query,release,pool:{connect:async()=>({query,release})} as unknown as Pool};
}
test('dry-run reports bounded metadata counts without changing raw receipts or accounting',async()=>{
  const {pool,query}=fixture();const result=await retainFrameworkReceipts(pool,{now:new Date('2030-01-01')});
  expect(result).toEqual({cutoff:'2029-10-03T00:00:00.000Z',receipts:1,scrubbed:0,applied:false,deferred:{legacyUnscoped:2,missingTurn:1,unsupportedKind:1}});
  expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
  expect(query.mock.calls.some(([sql])=>sql.includes('SELECT *'))).toBe(false);
});
test('apply requires exact connected database and locks terminal turns/receipts; changes only raw payload/tombstone marker',async()=>{
  const denied=fixture();await expect(retainFrameworkReceipts(denied.pool,{apply:true})).rejects.toThrow('RECEIPT_RETENTION_CONFIRMATION_REQUIRED');
  expect(denied.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE'))).toBe(false);
  const {pool,query}=fixture();const result=await retainFrameworkReceipts(pool,{apply:true,confirmDatabase:'ptr_framework_test'});
  expect(result.scrubbed).toBe(1);
  const sql=query.mock.calls.map(([value])=>value).join('\n');
  expect(sql).toContain('FOR UPDATE OF t SKIP LOCKED');expect(sql).toContain('FOR UPDATE OF r SKIP LOCKED');
  expect(sql).toContain("t.state IN ('completed','failed','cancelled')");expect(sql).toContain('turn_outbox');
  const update=query.mock.calls.find(([value])=>value.startsWith('UPDATE'))![0];
  expect(update).toContain('response_json=NULL,response_scrubbed_at=');
  for(const column of ['state=','actual_microusd=','reserved_microusd=','generation_id=','updated_at='])expect(update).not.toContain(column);
  expect(sql).not.toContain('DELETE FROM');
});
test('invalid/minimum retention and unknown/missing-confirmation CLI arguments fail before creating a pool',async()=>{
  const pool={} as Pool;
  for(const options of [{days:89},{limit:0},{limit:1001},{now:new Date(NaN)},{requestKeys:[]}])
    await expect(retainFrameworkReceipts(pool,options)).rejects.toThrow('RECEIPT_RETENTION_SCOPE_INVALID');
  await expect(receiptRetentionMain(['--unknown'],{})).rejects.toThrow('RECEIPT_RETENTION_ARGUMENT_INVALID');
  await expect(receiptRetentionMain(['--apply'],{})).rejects.toThrow('RECEIPT_RETENTION_CONFIRMATION_REQUIRED');
});
