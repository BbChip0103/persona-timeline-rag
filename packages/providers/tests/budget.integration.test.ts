import { createLocalPool } from '@ptr/storage';
import { MAX_TOTAL_MICROUSD, PostgresBudgetLedger, decisionCallsExhausted } from '../src';

// Explicit test-only credential injection; never searches env files or touches shared DBs.
const databaseUrl=process.env.GOAL1_TEST_DATABASE_URL;
const enabled=process.env.GOAL1_TEST_BUDGET_DB==='true'&&Boolean(databaseUrl);
(enabled?describe:describe.skip)('dedicated local Postgres durable aggregate budget',()=>{
  const prefix=`synthetic-provider-test-${process.pid}-${Date.now()}-`;
  const pool=enabled?createLocalPool(databaseUrl!):undefined;
  const ledger=enabled?new PostgresBudgetLedger(pool!,databaseUrl!):undefined;
  beforeAll(async()=>{await ledger!.initialize();});
  afterAll(async()=>{
    // Only this run's synthetic, never-submitted/nonbillable test rows are removed.
    await pool!.query('DELETE FROM ptr_provider_requests WHERE key LIKE $1',[`${prefix}%`]);
    await pool!.end();
  });
  test('concurrent independent connections cannot reserve beyond the singleton cap',async()=>{
    const result=await pool!.query("SELECT COALESCE(SUM(CASE WHEN state='settled' THEN actual_microusd ELSE GREATEST(reserved_microusd,COALESCE(actual_microusd,0)) END),0) AS committed FROM ptr_provider_requests");
    const available=MAX_TOTAL_MICROUSD-Number(result.rows[0].committed);
    expect(available).toBeGreaterThan(10);
    const amount=Math.ceil(available*0.6);
    const reservations=await Promise.allSettled([ledger!.reserve(prefix+'a',amount),ledger!.reserve(prefix+'b',amount)]);
    expect(reservations.filter(value=>value.status==='fulfilled')).toHaveLength(1);
    expect(reservations.filter(value=>value.status==='rejected')).toHaveLength(1);
    for(const key of [prefix+'a',prefix+'b']) if(await ledger!.get(key)) await ledger!.finish(key,0,null,null);
  });
  test('duplicates are atomic; unknown and cached completed data survive new ledger instance',async()=>{
    const key=prefix+'durable';
    const results=await Promise.all([ledger!.reserve(key,100),ledger!.reserve(key,100)]);
    expect(results.filter(value=>value.created)).toHaveLength(1);
    await ledger!.submitted(key);
    await ledger!.finish(key,null,{synthetic:'cached-result'},'synthetic-generation-id');
    const restarted=new PostgresBudgetLedger(pool!,databaseUrl!);
    const duplicate=await restarted.reserve(key,100);
    expect(duplicate.created).toBe(false);
    expect(duplicate.request).toMatchObject({state:'unknown',reservedMicrousd:100,actualMicrousd:null,response:{synthetic:'cached-result'},generationId:'synthetic-generation-id'});
    await restarted.finish(key,1,null,null);
    expect((await ledger!.get(key))?.actualMicrousd).toBe(1);
  });
  test('cap cannot be bypassed with unsafe pools or invalid reservation amounts',async()=>{
    expect(()=>new PostgresBudgetLedger({options:{connectionString:'postgresql://unsafe:unsafe@external/x'}} as never,databaseUrl!)).toThrow('UNSAFE_DATABASE_POOL');
    for(const amount of [0,-1,0.1,MAX_TOTAL_MICROUSD+1,Number.NaN]) await expect(ledger!.reserve(prefix+'invalid',amount)).rejects.toThrow('BUDGET_EXCEEDED');
  });
  test('decision sub-cap is checked in the reservation transaction; existing keys still replay',async()=>{
    const budget=await pool!.query("SELECT b.call_cap,(SELECT count(*) FROM ptr_provider_requests) AS calls FROM ptr_provider_budget b WHERE b.id='global'");
    const callCap=Number(budget.rows[0].call_cap),calls=Number(budget.rows[0].calls);
    // Keep every remaining call free for chat: refused whatever the ledger holds; the shared global cap is never changed.
    const share=(callCap-calls)/callCap;
    expect(decisionCallsExhausted(calls,callCap,share)).toBe(true);
    await expect(ledger!.reserve(prefix+'subcap',1,{reservedCallFraction:share})).rejects.toThrow('DECISION_SUBCAP');
    expect(await ledger!.get(prefix+'subcap')).toBeUndefined();
    const saved=await ledger!.reserve(prefix+'subcap',1,{reservedCallFraction:0});
    expect(saved.created).toBe(true);
    expect((await ledger!.reserve(prefix+'subcap',1,{reservedCallFraction:share})).created).toBe(false);
    await ledger!.finish(prefix+'subcap',0,null,null);
  });
});
