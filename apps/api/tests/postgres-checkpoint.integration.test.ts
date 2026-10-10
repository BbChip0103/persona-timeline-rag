import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { PostgresConversationStore } from '@ptr/storage';
import { setupFrameworkCheckpoints } from '../../../scripts/framework-checkpoints';
import { createRuntime } from '../src/runtime';
const raw=process.env.PTR_FRAMEWORK_TEST_DATABASE_URL;
const redis=process.env.PTR_FRAMEWORK_TEST_REDIS_URL;
const enabled=(()=>{if(!raw||!redis)return false;const u=new URL(raw),r=new URL(redis);return u.hostname==='127.0.0.1'&&u.port==='57432'&&u.pathname==='/ptr_framework_test'&&u.username==='ptr_framework_tester'
  &&r.protocol==='redis:'&&r.hostname==='127.0.0.1'&&r.port==='57479'&&r.pathname==='/0'&&Boolean(r.password)&&!r.search&&!r.hash;})();
(enabled?describe:describe.skip)('production checkpoint schema setup boundary',()=>{
  test('explicit deployment setup is required; runtime/saver construction never migrates',async()=>{
    await setupFrameworkCheckpoints(raw!);
    const pool=new Pool({connectionString:raw}),setup=jest.spyOn(PostgresSaver.prototype,'setup');
    const saver=new PostgresSaver(pool);
    const runtime=createRuntime({DATABASE_URL:raw,PTR_REDIS_URL:redis!,PTR_CHAT_PROVIDER:'fake',PTR_TURN_QUEUE:`checkpoint-composition-${randomUUID().slice(0,8)}`,PTR_EVENTS_NAMESPACE:'checkpoint-composition',PTR_LANGFUSE_ENABLED:'0'});
    try {
      expect(await saver.getTuple({configurable:{thread_id:`synthetic-not-created-${randomUUID()}`}})).toBeUndefined();
      expect(runtime.executionStore).toBeInstanceOf(PostgresConversationStore);expect(setup).not.toHaveBeenCalled();
    } finally {setup.mockRestore();await runtime.close?.();await pool.end();}
  });
});
