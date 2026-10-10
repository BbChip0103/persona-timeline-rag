import type { Pool } from 'pg';
import { createLocalPool, isIsolatedDatabaseIdentity } from '@ptr/storage';
import { transaction } from '../packages/storage/src/pool';

export interface ReceiptRetentionOptions {
  days?:number;now?:Date;limit?:number;apply?:boolean;confirmDatabase?:string;
  /** Bounded synthetic test/operator scope. Never used to infer a missing turn link. */
  requestKeys?:string[];
}
export interface ReceiptRetentionResult {
  cutoff:string;receipts:number;scrubbed:number;applied:boolean;
  deferred:{legacyUnscoped:number;missingTurn:number;unsupportedKind:number};
}

/** Scrub only expired raw receipts. Accounting, generation IDs, unknown reservations and idempotency keys survive.
 * Legacy/body-only records cannot be safely associated with active turns; report them rather than fabricate links.
 * Serving adapters do not perform schema setup or retention. This is an explicit operations command.
 */
export async function retainFrameworkReceipts(pool:Pool,options:ReceiptRetentionOptions={}):Promise<ReceiptRetentionResult> {
  const days=options.days??90,limit=options.limit??100,now=options.now??new Date();
  if(!Number.isInteger(days)||days<90||!Number.isInteger(limit)||limit<1||limit>1000||!Number.isFinite(now.getTime())
    ||options.requestKeys&&(!options.requestKeys.length||options.requestKeys.length>1000||options.requestKeys.some(key=>typeof key!=='string'||!key||key.length>200)))
    throw new Error('RECEIPT_RETENTION_SCOPE_INVALID');
  const cutoff=new Date(now.getTime()-days*86400000).toISOString();
  return transaction(pool,async client=>{
    const identity=await client.query('SELECT current_database() AS db,current_user AS username');
    const db=identity.rows[0]?.db;
    if(['ptr_split_test','ptr_split_research'].includes(db))throw new Error('SPLIT_RUNTIME_USE_PTR_LLM_RETENTION');
    if(!isIsolatedDatabaseIdentity(db,identity.rows[0]?.username))throw new Error('ISOLATED_DATABASE_REQUIRED');
    if(options.apply&&options.confirmDatabase!==db)throw new Error('RECEIPT_RETENTION_CONFIRMATION_REQUIRED');
    const deferred=await client.query(`SELECT
      count(*) FILTER(WHERE r.request_kind IS NULL OR r.receipt_received_at IS NULL)::int AS legacy,
      count(*) FILTER(WHERE r.request_kind IN ('chat','decision') AND NOT EXISTS(SELECT 1 FROM turns t WHERE t.id=r.turn_id))::int AS missing,
      count(*) FILTER(WHERE r.request_kind IS NOT NULL AND r.request_kind NOT IN ('chat','decision','draft'))::int AS unsupported
      FROM ptr_provider_requests r WHERE r.response_json IS NOT NULL AND COALESCE(r.receipt_received_at,r.updated_at)<$1::timestamptz
        AND ($2::text[] IS NULL OR r.key=ANY($2::text[]))`,[cutoff,options.requestKeys??null]);
    // Lock terminal turns first. A locked/resumable turn cannot race into an eligible state beneath us.
    const turns=await client.query(`SELECT t.id FROM turns t WHERE t.state IN ('completed','failed','cancelled')
      AND t.finished_at<$1::timestamptz AND NOT EXISTS(SELECT 1 FROM turn_outbox o WHERE o.turn_id=t.id)
      AND EXISTS(SELECT 1 FROM ptr_provider_requests r WHERE r.turn_id=t.id AND r.request_kind IN ('chat','decision')
        AND r.response_json IS NOT NULL AND r.response_scrubbed_at IS NULL AND r.receipt_received_at<$1::timestamptz
        AND ($2::text[] IS NULL OR r.key=ANY($2::text[])))
      ORDER BY t.finished_at,t.id LIMIT $3 ${options.apply?'FOR UPDATE OF t SKIP LOCKED':''}`,[cutoff,options.requestKeys??null,limit]);
    const ids=turns.rows.map(row=>String(row.id));
    const candidates=await client.query(`SELECT r.key FROM ptr_provider_requests r
      WHERE r.response_json IS NOT NULL AND r.response_scrubbed_at IS NULL AND r.receipt_received_at<$1::timestamptz
        AND ((r.request_kind='draft' AND r.turn_id IS NULL) OR (r.request_kind IN ('chat','decision') AND r.turn_id=ANY($2::text[])))
        AND ($3::text[] IS NULL OR r.key=ANY($3::text[]))
      ORDER BY r.receipt_received_at,r.key LIMIT $4 ${options.apply?'FOR UPDATE OF r SKIP LOCKED':''}`,[cutoff,ids,options.requestKeys??null,limit]);
    const keys=candidates.rows.map(row=>String(row.key));
    const counts=deferred.rows[0];
    const result:ReceiptRetentionResult={cutoff,receipts:keys.length,scrubbed:0,applied:options.apply===true,
      deferred:{legacyUnscoped:Number(counts.legacy),missingTurn:Number(counts.missing),unsupportedKind:Number(counts.unsupported)}};
    if(options.apply&&keys.length) {
      const changed=await client.query(`UPDATE ptr_provider_requests SET response_json=NULL,response_scrubbed_at=$2::timestamptz
        WHERE key=ANY($1::text[]) AND response_json IS NOT NULL AND response_scrubbed_at IS NULL`,[keys,now.toISOString()]);
      result.scrubbed=changed.rowCount??0;
    }
    return result;
  });
}

export async function receiptRetentionMain(args:string[]=process.argv.slice(2),env:NodeJS.ProcessEnv=process.env):Promise<void> {
  const options:ReceiptRetentionOptions={};
  for(let index=0;index<args.length;index++) {
    if(args[index]==='--apply')options.apply=true;
    else if(args[index]==='--confirm-database')options.confirmDatabase=args[++index];
    else if(args[index]==='--days')options.days=Number(args[++index]);
    else if(args[index]==='--limit')options.limit=Number(args[++index]);
    else throw new Error('RECEIPT_RETENTION_ARGUMENT_INVALID');
  }
  if(options.apply&&!options.confirmDatabase)throw new Error('RECEIPT_RETENTION_CONFIRMATION_REQUIRED');
  const pool=createLocalPool(env.DATABASE_URL??'');
  try {process.stdout.write(`${JSON.stringify(await retainFrameworkReceipts(pool,options))}\n`);}
  finally {await pool.end();}
}
if(process.argv[1]?.endsWith('framework-receipt-retention.ts'))
  void receiptRetentionMain().catch(error=>{process.stderr.write(error instanceof Error&&error.message==='SPLIT_RUNTIME_USE_PTR_LLM_RETENTION'?'SPLIT_RUNTIME_USE_PTR_LLM_RETENTION\n':'RECEIPT_RETENTION_FAILED\n');process.exitCode=1;});
