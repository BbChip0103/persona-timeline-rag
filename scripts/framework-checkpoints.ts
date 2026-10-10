import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { createLocalPool, isIsolatedDatabaseIdentity } from '@ptr/storage';
/** Explicit schema setup, separate from serving. Never loads private environment files or imports corpus data. */
export async function setupFrameworkCheckpoints(databaseUrl:string):Promise<void> {
  const pool=createLocalPool(databaseUrl);
  try {
    const result=await pool.query('SELECT current_database() AS db,current_user AS username');
    if(!isIsolatedDatabaseIdentity(result.rows[0]?.db,result.rows[0]?.username))throw new Error('ISOLATED_DATABASE_REQUIRED');
    await new PostgresSaver(pool).setup();
  } finally {await pool.end();}
}
if(process.argv[1]?.endsWith('framework-checkpoints.ts')) {
  void setupFrameworkCheckpoints(process.env.DATABASE_URL??'').then(()=>{process.stdout.write('Framework checkpoint schema ready\n');},()=>{
    process.stderr.write('FRAMEWORK_CHECKPOINT_SETUP_FAILED\n');process.exitCode=1;
  });
}
