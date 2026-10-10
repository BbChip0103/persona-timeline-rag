import type { Pool, PoolClient } from 'pg';
import { assertLocalDatabaseUrl } from '@ptr/storage';

export class ProviderError extends Error {
  constructor(public readonly code:string) { super(code); this.name='ProviderError'; }
}
export type RequestState='reserved'|'submitted'|'settled'|'unknown';
export type ProviderRequestKind='chat'|'decision'|'draft'|'embedding';
export interface ProviderRequestScope {kind:ProviderRequestKind;turnId?:string}
export interface BudgetReserveOptions {reservedCallFraction?:number;scope?:ProviderRequestScope}
const turnUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Link only explicit service keys, never infer turns from hashed/body-only/legacy records. */
export function providerRequestScope(requestKey:string|undefined,kind:'chat'|'decision'):ProviderRequestScope|undefined {
  if(!requestKey)return undefined;
  if(/^draft:[^\r\n]{1,400}$/.test(requestKey))return {kind:'draft'};
  const id=kind==='decision'?requestKey.replace(/#w\d+$/,''):requestKey;
  return turnUuid.test(id)?{kind,turnId:id}:undefined;
}
function checkedScope(scope:ProviderRequestScope|undefined):ProviderRequestScope|undefined {
  if(scope&&(!['chat','decision','draft','embedding'].includes(scope.kind)
    ||scope.turnId!==undefined&&!turnUuid.test(scope.turnId)
    ||['chat','decision'].includes(scope.kind)&&!scope.turnId
    ||scope.kind==='draft'&&scope.turnId!==undefined))throw new ProviderError('INVALID_REQUEST_SCOPE');
  return scope;
}
export interface BudgetRequest { key:string; state:RequestState; reservedMicrousd:number; actualMicrousd:number|null; response:unknown|null; generationId:string|null; scope?:ProviderRequestScope; receiptScrubbedAt?:string }
export interface BudgetLedger {
  /**
   * `reservedCallFraction`: refuse a new request (DECISION_SUBCAP) unless that share of call_cap stays free after it;
   * decision calls use it so they can never take the last chat calls. Existing keys replay regardless.
   */
  reserve(key:string,amountMicrousd:number,options?:BudgetReserveOptions):Promise<{created:boolean;request:BudgetRequest}>;
  submitted(key:string):Promise<void>;
  finish(key:string,costMicrousd:number|null,response:unknown|null,generationId:string|null):Promise<void>;
  get(key:string):Promise<BudgetRequest|undefined>;
}
export const MAX_TOTAL_MICROUSD=2_000_000;
/** True when one more call would leave fewer than ceil(callCap·fraction) calls free. */
export function decisionCallsExhausted(calls:number,callCap:number,reservedCallFraction:number):boolean {
  return callCap-calls-1<Math.ceil(callCap*reservedCallFraction);
}
export const MAX_PROVIDER_CALLS=10_000;
// Never reset this singleton budget between runs: all live callers share its ledger.
export const BUDGET_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS ptr_provider_budget (
 id text PRIMARY KEY CHECK(id='global'), cap_microusd bigint NOT NULL CHECK(cap_microusd BETWEEN 0 AND ${MAX_TOTAL_MICROUSD}),
 call_cap integer NOT NULL CHECK(call_cap BETWEEN 0 AND ${MAX_PROVIDER_CALLS}));
INSERT INTO ptr_provider_budget VALUES ('global',${MAX_TOTAL_MICROUSD},${MAX_PROVIDER_CALLS}) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS ptr_provider_requests (
 key text PRIMARY KEY, state text NOT NULL CHECK(state IN ('reserved','submitted','settled','unknown')),
 reserved_microusd bigint NOT NULL CHECK(reserved_microusd >= 0),
 actual_microusd bigint CHECK(actual_microusd >= 0), response_json jsonb,
 generation_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 request_kind text CHECK(request_kind IN ('chat','decision','draft','embedding')),turn_id text,
 receipt_received_at timestamptz,response_scrubbed_at timestamptz);
ALTER TABLE ptr_provider_requests ADD COLUMN IF NOT EXISTS request_kind text;
ALTER TABLE ptr_provider_requests ADD COLUMN IF NOT EXISTS turn_id text;
ALTER TABLE ptr_provider_requests ADD COLUMN IF NOT EXISTS receipt_received_at timestamptz;
ALTER TABLE ptr_provider_requests ADD COLUMN IF NOT EXISTS response_scrubbed_at timestamptz;`;
function mapped(row:Record<string,unknown>):BudgetRequest {
  return {key:String(row.key),state:row.state as RequestState,reservedMicrousd:Number(row.reserved_microusd),
    actualMicrousd:row.actual_microusd===null?null:Number(row.actual_microusd),response:row.response_json??null,
    generationId:row.generation_id===null?null:String(row.generation_id),
    ...(row.request_kind?{scope:{kind:row.request_kind as ProviderRequestKind,...(row.turn_id?{turnId:String(row.turn_id)}:{})}}:{}),
    ...(row.response_scrubbed_at?{receiptScrubbedAt:new Date(row.response_scrubbed_at as string).toISOString()}:{}),
  };
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
  async reserve(key:string,amountMicrousd:number,options?:BudgetReserveOptions):Promise<{created:boolean;request:BudgetRequest}> {
    if (!Number.isSafeInteger(amountMicrousd)||amountMicrousd<1||amountMicrousd>MAX_TOTAL_MICROUSD) throw new ProviderError('BUDGET_EXCEEDED');
    const scope=checkedScope(options?.scope);
    return this.transaction(async client=>{
      const budget=await client.query("SELECT cap_microusd,call_cap FROM ptr_provider_budget WHERE id='global' FOR UPDATE");
      if (!budget.rows[0]) throw new ProviderError('BUDGET_NOT_INITIALIZED');
      const previous=await client.query('SELECT * FROM ptr_provider_requests WHERE key=$1',[key]);
      if (previous.rows[0]) return {created:false,request:mapped(previous.rows[0])};
      const aggregate=await client.query('SELECT COALESCE(SUM(GREATEST(reserved_microusd,COALESCE(actual_microusd,0))) FILTER (WHERE state <> \'settled\'),0)+COALESCE(SUM(actual_microusd) FILTER (WHERE state=\'settled\'),0) AS committed,COUNT(*) AS calls FROM ptr_provider_requests');
      if (Number(aggregate.rows[0].committed)+amountMicrousd>Math.min(Number(budget.rows[0].cap_microusd),MAX_TOTAL_MICROUSD)||Number(aggregate.rows[0].calls)>=Number(budget.rows[0].call_cap)) throw new ProviderError('BUDGET_EXCEEDED');
      if (options?.reservedCallFraction!==undefined&&decisionCallsExhausted(Number(aggregate.rows[0].calls),Number(budget.rows[0].call_cap),options.reservedCallFraction)) throw new ProviderError('DECISION_SUBCAP');
      const inserted=await client.query("INSERT INTO ptr_provider_requests (key,state,reserved_microusd,request_kind,turn_id) VALUES ($1,'reserved',$2,$3,$4) RETURNING *",[key,amountMicrousd,scope?.kind??null,scope?.turnId??null]);
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
      await client.query("UPDATE ptr_provider_requests SET state=CASE WHEN $2::bigint IS NULL THEN 'unknown' ELSE 'settled' END, actual_microusd=$2,response_json=CASE WHEN response_scrubbed_at IS NOT NULL THEN NULL ELSE COALESCE($3::jsonb,response_json) END,receipt_received_at=CASE WHEN response_scrubbed_at IS NULL AND $3::jsonb IS NOT NULL THEN COALESCE(receipt_received_at,now()) ELSE receipt_received_at END,generation_id=COALESCE($4,generation_id),updated_at=now() WHERE key=$1 AND state IN ('reserved','submitted','unknown')",[key,costMicrousd,response===null?null:JSON.stringify(response),generationId]);
    });
  }
  async get(key:string):Promise<BudgetRequest|undefined> {
    const result=await this.pool.query('SELECT * FROM ptr_provider_requests WHERE key=$1',[key]);
    return result.rows[0]?mapped(result.rows[0]):undefined;
  }
}
