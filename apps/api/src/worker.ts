import { randomUUID } from 'node:crypto';
import { TurnWorker } from '@ptr/core';
import { startTurnConsumer } from '@ptr/messaging';
import { createRuntime } from './runtime';

/** Turn worker: consumes dispatches from Redis (BullMQ) and runs them under a Postgres lease. Run any number. */
function integer(name:string,fallback:number,min:number,max:number):number {
  const value=Number(process.env[name]??fallback);
  if(!Number.isInteger(value)||value<min||value>max) throw new Error(`INVALID_${name}`);
  return value;
}
async function main() {
  const runtime=createRuntime(process.env,{onTurnFailure:({code})=>process.stderr.write(`turn failed ${code}\n`)});
  const workerId=process.env.PTR_WORKER_ID??`worker-${randomUUID().slice(0,8)}`;
  // Lease must outlive several heartbeats (lease/3); the dispatcher requeues turns whose lease expired.
  const worker=new TurnWorker({chat:runtime.chat,leases:runtime.leases,workerId,leaseMs:integer('PTR_LEASE_MS',15000,300,600000),
    cancellations:runtime.eventSource,onError:phase=>process.stderr.write(`worker ${phase} error\n`)});
  const consumer=startTurnConsumer(process.env.PTR_REDIS_URL??'',dispatch=>worker.handle(dispatch),
    {concurrency:integer('PTR_WORKER_CONCURRENCY',32,1,1024),queueName:process.env.PTR_TURN_QUEUE??'turns',onError:()=>process.stderr.write('worker queue error\n')});
  process.stdout.write(`Turn worker ${workerId} started\n`);
  // Graceful: stop taking jobs and let in-flight turns finish; a crash instead leaves them to lease recovery.
  const shutdown=()=>{void consumer.close().then(()=>worker.stop()).then(()=>runtime.close?.()).finally(()=>process.exit(0));};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
void main().catch(()=>{process.stderr.write('WORKER_STARTUP_FAILED\n');process.exitCode=1;});
