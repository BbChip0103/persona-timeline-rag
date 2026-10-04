import { randomUUID } from 'node:crypto';
import { TurnWorker } from '@ptr/core';
import { createRuntime } from './runtime';

/** Goal2 turn worker: run N of these next to an API started with PTR_EXECUTION=queue. */
function integer(name:string,fallback:number,min:number,max:number):number {
  const value=Number(process.env[name]??fallback);
  if(!Number.isInteger(value)||value<min||value>max) throw new Error(`INVALID_${name}`);
  return value;
}
async function main() {
  const runtime=createRuntime({...process.env,PTR_EXECUTION:'queue'});
  if(!runtime.queue) throw new Error('QUEUE_UNAVAILABLE');
  const workerId=process.env.PTR_WORKER_ID??`worker-${randomUUID().slice(0,8)}`;
  // Lease must outlive several heartbeats (lease/3) and be shorter than recovery expectations.
  const worker=new TurnWorker({chat:runtime.chat,queue:runtime.queue,workerId,
    concurrency:integer('PTR_WORKER_CONCURRENCY',32,1,1024),leaseMs:integer('PTR_LEASE_MS',15000,300,600000),
    pollMs:integer('PTR_WORKER_POLL_MS',50,5,10000),maxAttempts:integer('PTR_MAX_ATTEMPTS',3,1,10),
    onError:phase=>process.stderr.write(`worker ${phase} error\n`)});
  worker.start();
  process.stdout.write(`Turn worker ${workerId} started\n`);
  const shutdown=()=>{void worker.stop().then(()=>runtime.close?.()).finally(()=>process.exit(0));};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
void main().catch(()=>{process.stderr.write('WORKER_STARTUP_FAILED\n');process.exitCode=1;});
