import type { Pool } from 'pg';
import { createLocalPool, isIsolatedDatabaseIdentity } from '@ptr/storage';
import { transaction } from '../packages/storage/src/pool';

export interface CheckpointRetentionOptions {days?:number;now?:Date;limit?:number;apply?:boolean;turnIds?:string[]}
export interface CheckpointRetentionResult {cutoff:string;turnIds:string[];threadIds:string[];applied:boolean;deleted:{writes:number;blobs:number;checkpoints:number}}
const tables=[['checkpoint_writes','writes'],['checkpoint_blobs','blobs'],['checkpoints','checkpoints']] as const;
const modelThreadPattern='^model:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{64}$';
const allThreads=tables.map(([table])=>`SELECT thread_id FROM public.${table}`).join(' UNION ');

/** Default public-schema PostgresSaver tables. Enumerates IDs/timestamps only: never reads checkpoint payloads.
 * PostgresSaver.deleteThread owns its own transaction; using its three known tables here keeps terminal row locks
 * and model-call/legacy stage deletions in ONE transaction instead of committing between threads.
 */
export async function retainFrameworkCheckpoints(pool:Pool,options:CheckpointRetentionOptions={}):Promise<CheckpointRetentionResult> {
  const days=options.days??90,limit=options.limit??100,now=options.now??new Date();
  if(!Number.isInteger(days)||days<90||!Number.isInteger(limit)||limit<1||limit>1000||!Number.isFinite(now.getTime())
    ||options.turnIds?.some(id=>typeof id!=='string'||id.length<1||id.length>200)||options.turnIds&&options.turnIds.length>1000)
    throw new Error('CHECKPOINT_RETENTION_SCOPE_INVALID');
  const cutoff=new Date(now.getTime()-days*86400000).toISOString();
  return transaction(pool,async client=>{
    const identity=await client.query('SELECT current_database() AS db,current_user AS username');
    if(!isIsolatedDatabaseIdentity(identity.rows[0]?.db,identity.rows[0]?.username))throw new Error('ISOLATED_DATABASE_REQUIRED');
    const candidates=await client.query(`SELECT t.id FROM turns t
      WHERE t.state IN ('completed','failed','cancelled') AND t.finished_at < $1::timestamptz
        AND ($2::text[] IS NULL OR t.id=ANY($2::text[]))
        AND EXISTS(SELECT 1 FROM (${allThreads}) c WHERE c.thread_id IN ('turn:'||t.id,'character:'||t.id)
          OR (c.thread_id ~ '${modelThreadPattern}' AND split_part(c.thread_id,':',2)=t.id))
      ORDER BY t.finished_at,t.id LIMIT $3 ${options.apply?'FOR UPDATE OF t SKIP LOCKED':''}`,
    [cutoff,options.turnIds??null,limit]);
    const turnIds=candidates.rows.map(row=>String(row.id));
    // Enumerate all tables: a crash can leave only pending writes or blobs. Exact equality binds the turn,
    // and a full anchored grammar rejects malformed fingerprints without treating IDs as LIKE patterns.
    const threads=turnIds.length?await client.query(`SELECT DISTINCT c.thread_id FROM (${allThreads}) c
      WHERE c.thread_id=ANY($1::text[]) OR (c.thread_id ~ '${modelThreadPattern}' AND split_part(c.thread_id,':',2)=ANY($2::text[]))
      ORDER BY c.thread_id`,[turnIds.flatMap(id=>[`turn:${id}`,`character:${id}`]),turnIds]):{rows:[]};
    const threadIds=threads.rows.map(row=>String(row.thread_id));
    const result:CheckpointRetentionResult={cutoff,turnIds,threadIds,applied:options.apply===true,deleted:{writes:0,blobs:0,checkpoints:0}};
    if(options.apply&&threadIds.length)for(const [table,label] of tables)
      result.deleted[label]=(await client.query(`DELETE FROM public.${table} WHERE thread_id=ANY($1::text[])`,[threadIds])).rowCount??0;
    return result;
  });
}

export async function checkpointRetentionMain(args:string[]=process.argv.slice(2),env:NodeJS.ProcessEnv=process.env):Promise<void> {
  const options:CheckpointRetentionOptions={};
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--apply')options.apply=true;
    else if(args[i]==='--days')options.days=Number(args[++i]);
    else if(args[i]==='--limit')options.limit=Number(args[++i]);
    else throw new Error('CHECKPOINT_RETENTION_ARGUMENT_INVALID');
  }
  const pool=createLocalPool(env.DATABASE_URL??'');
  try {
    const result=await retainFrameworkCheckpoints(pool,options);
    // No IDs, raw data, credentials or connection targets in CLI output.
    process.stdout.write(`${JSON.stringify({cutoff:result.cutoff,turns:result.turnIds.length,threads:result.threadIds.length,applied:result.applied,deleted:result.deleted})}\n`);
  } finally {await pool.end();}
}
if(process.argv[1]?.endsWith('framework-checkpoint-retention.ts'))
  void checkpointRetentionMain().catch(()=>{process.stderr.write('CHECKPOINT_RETENTION_FAILED\n');process.exitCode=1;});
