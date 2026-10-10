import type {Pool} from 'pg';
import {PostgresLlmControl,canonicalHash} from '../src/llm-control';
const request={contractVersion:1 as const,turnId:'00000000-0000-4000-8000-000000000001',dispatchSeq:0,jobId:'t-00000000-0000-4000-8000-000000000001-0',lockToken:'synthetic-lock',executionId:'00000000-0000-4000-8000-000000000002'};
it('locks authoritative app row before consulting Redis, and cannot claim on failed token',async()=>{
  const order:string[]=[];
  const client={query:jest.fn(async(sql:string)=>{order.push(sql.includes('FOR UPDATE')?'row-lock':sql);if(sql.includes('FOR UPDATE'))return {rows:[{id:request.turnId,dispatch_seq:0,state:'pending'}]};return {rows:[]};}),release:jest.fn()};
  const pool={connect:jest.fn(async()=>client)} as unknown as Pool;
  const store=new PostgresLlmControl(pool,async()=>{order.push('redis-token');return false;});
  expect(await store.start(request)).toEqual({contractVersion:1,status:'lost'});
  expect(order.indexOf('row-lock')).toBeLessThan(order.indexOf('redis-token'));
  expect(order.filter(x=>x.startsWith('UPDATE'))).toEqual([]);
  expect(order.at(-1)).toBe('COMMIT');
});
it('Redis outage rolls back rather than granting during an unverifiable lock',async()=>{
  const client={query:jest.fn(async(sql:string)=>({rows:sql.includes('FOR UPDATE')?[{id:request.turnId,dispatch_seq:0,state:'pending'}]:[]})),release:jest.fn()};
  const store=new PostgresLlmControl({connect:async()=>client} as unknown as Pool,async()=>{throw new Error('REDIS_DOWN');});
  await expect(store.start(request)).rejects.toThrow('REDIS_DOWN');
  expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
});
it('canonical result receipt hash ignores transport JSON object ordering but not result changes',()=>{expect(canonicalHash({a:1,b:{c:2,d:3}})).toBe(canonicalHash({b:{d:3,c:2},a:1}));expect(canonicalHash({a:1})).not.toBe(canonicalHash({a:2}));});
it('bounded LIMIT101 probes overflow and commits CONTEXT_LIMIT rather than silently slicing last100',async()=>{
  const client={query:jest.fn(async(sql:string)=>{
    if(sql.includes('FOR UPDATE'))return {rows:[{id:request.turnId,dispatch_seq:0,state:'pending',request_input:{text:'synthetic'},attempts:0,lease_owner:null,session_id:'synthetic-session'}]};
    if(sql.includes('FROM turn_outbox'))return {rows:[{expired:false}]};
    if(sql.includes('SELECT m.*')){expect(sql).toContain('LIMIT 101');return {rows:Array.from({length:101},(_,i)=>({id:`synthetic-${i}`,session_id:'synthetic-session',turn_id:null,role:'assistant',content:'synthetic message',created_at:new Date()}))};}
    return {rows:[]};
  }),release:jest.fn()};
  const control=new PostgresLlmControl({connect:async()=>client} as unknown as Pool,async()=>true);
  expect(await control.start(request)).toEqual({contractVersion:1,status:'lost'});
  expect(client.query).toHaveBeenCalledWith(expect.stringContaining("state='failed'"),[request.turnId,'CONTEXT_LIMIT']);
  expect(client.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO turn_execution_grants'))).toBe(false);
});
