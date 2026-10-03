import type { Pool, PoolClient } from 'pg';
import { assertLocalDatabaseUrl } from '@ptr/storage';

export class ProviderError extends Error {
  constructor(public readonly code:string) { super(code); this.name='ProviderError'; }
}
export type RequestState='reserved'|'submitted'|'settled'|'unknown';
export interface BudgetRequest { key:string; state:RequestState; reservedMicrousd:number; actualMicrousd:number|null; response:unknown|null; generationId:string|null }
export interface BudgetLedger {
  reserve(key:string,amountMicrousd:number):Promise<{created:boolean;request:BudgetRequest}>;
  submitted(key:string):Promise<void>;
  finish(key:string,costMicrousd:number|null,response:unknown|null,generationId:string|null):Promise<void>;
  get(key:string):Promise<BudgetRequest|undefined>;
}
export const MAX_TOTAL_MICROUSD=1_000_000;
// Never reset this singleton budget between runs: all live callers share its ledger.
export const BUDGET_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS ptr_provider_budget (
 id text PRIMARY KEY CHECK(id='global'), cap_microusd bigint NOT NULL CHECK(cap_microusd BETWEEN 0 AND 1000000),
 call_cap integer NOT NULL CHECK(call_cap BETWEEN 0 AND 1000));
INSERT INTO ptr_provider_budget VALUES ('global',1000000,1000) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ptr_provider_requests (
 key text PRIMARY KEY, state text NOT NULL CHECK(state IN ('reserved','submitted','settled','unknown')),
 reserved_microusd bigint NOT NULL CHECK(reserved_microusd >= 0),
 actual_microusd bigint CHECK(actual_microusd >= 0), response_json jsonb,
 generation_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());`;
function mapped(row:Record<string,unknown>):BudgetRequest {
  return {key:String(row.key),state:row.state as RequestState,reservedMicrousd:Number(row.reserved_microusd),
    actualMicrousd:row.actual_microusd===null?null:Number(row.actual_microusd),response:row.response_json??null,
    generationId:row.generation_id===null?null:String(row.generation_id)};
}
export class PostgresBudgetLedger implements BudgetLedger {
  constructor(private readonly pool:Pool,databaseUrl:string) {
    assertLocalDatabaseUrl(databaseUrl);
    // A safe URL argument cannot authorize an unrelated externally configured pool.
    const config=pool.options;
    if (config.connectionString!==databaseUrl || config.host || config.port || config.user || config.database || config.ssl) throw new ProviderError('UNSAFE_DATABASE_POOL');
  }
  async initialize():Promise<void> { await this.pool.query(BUDGET_SCHEMA_SQL); }
  private async transaction<T>(run:(client:PoolClient)=>Promise<T>):Promise<T> {
    const client=await this.pool.connect();
    try { await client.query('BEGIN'); const result=await run(client); await client.query('COMMIT'); return result; }
    catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
  async reserve(key:string,amountMicrousd:number):Promise<{created:boolean;request:BudgetRequest}> {
    if (!Number.isSafeInteger(amountMicrousd)||amountMicrousd<1||amountMicrousd>MAX_TOTAL_MICROUSD) throw new ProviderError('BUDGET_EXCEEDED');
    return this.transaction(async client=>{
      const budget=await client.query("SELECT cap_microusd,call_cap FROM ptr_provider_budget WHERE id='global' FOR UPDATE");
      if (!budget.rows[0]) throw new ProviderError('BUDGET_NOT_INITIALIZED');
      const previous=await client.query('SELECT * FROM ptr_provider_requests WHERE key=$1',[key]);
      if (previous.rows[0]) return {created:false,request:mapped(previous.rows[0])};
      const aggregate=await client.query('SELECT COALESCE(SUM(GREATEST(reserved_microusd,COALESCE(actual_microusd,0))) FILTER (WHERE state <> \'settled\'),0)+COALESCE(SUM(actual_microusd) FILTER (WHERE state=\'settled\'),0) AS committed,COUNT(*) AS calls FROM ptr_provider_requests');
      if (Number(aggregate.rows[0].committed)+amountMicrousd>Math.min(Number(budget.rows[0].cap_microusd),MAX_TOTAL_MICROUSD)||Number(aggregate.rows[0].calls)>=Number(budget.rows[0].call_cap)) throw new ProviderError('BUDGET_EXCEEDED');
      const inserted=await client.query("INSERT INTO ptr_provider_requests (key,state,reserved_microusd) VALUES ($1,'reserved',$2) RETURNING *",[key,amountMicrousd]);
      return {created:true,request:mapped(inserted.rows[0])};
    });
  }
  async submitted(key:string):Promise<void> {
    const result=await this.pool.query("UPDATE ptr_provider_requests SET state='submitted',updated_at=now() WHERE key=$1 AND state='reserved'",[key]);
    if (result.rowCount!==1) throw new ProviderError('REQUEST_ALREADY_SUBMITTED');
  }
  async finish(key:string,costMicrousd:number|null,response:unknown|null,generationId:string|null):Promise<void> {
    if (costMicrousd!==null&&(!Number.isSafeInteger(costMicrousd)||costMicrousd<0)) throw new ProviderError('INVALID_COST');
    await this.transaction(async client=>{
      await client.query("SELECT id FROM ptr_provider_budget WHERE id='global' FOR UPDATE");
      await client.query("UPDATE ptr_provider_requests SET state=CASE WHEN $2::bigint IS NULL THEN 'unknown' ELSE 'settled' END, actual_microusd=$2,response_json=COALESCE($3::jsonb,response_json),generation_id=COALESCE($4,generation_id),updated_at=now() WHERE key=$1 AND state IN ('reserved','submitted','unknown')",[key,costMicrousd,response===null?null:JSON.stringify(response),generationId]);
    });
  }
  async get(key:string):Promise<BudgetRequest|undefined> {
    const result=await this.pool.query('SELECT * FROM ptr_provider_requests WHERE key=$1',[key]);
    return result.rows[0]?mapped(result.rows[0]):undefined;
  }
}
