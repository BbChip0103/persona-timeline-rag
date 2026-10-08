import { TurnDispatcher } from '@ptr/core';
import { startCapacityController } from './capacity';
import { createRuntime } from './runtime';

/**
 * Recovery loop: requeues turns whose worker lease expired (or fails them with WORKER_LOST) and re-publishes
 * outbox entries that never reached a worker (publish failures, Redis loss). Safe to run more than one. It also runs the
 * capacity controller (BullMQ global concurrency from the upstream registry; one leader acts), see capacity.ts.
 */
function integer(name:string,fallback:number,min:number,max:number):number {
  const value=Number(process.env[name]??fallback);
  if(!Number.isInteger(value)||value<min||value>max) throw new Error(`INVALID_${name}`);
  return value;
}
async function main() {
  const runtime=createRuntime(process.env);
  const dispatcher=new TurnDispatcher({leases:runtime.leases,delivery:runtime.delivery,events:runtime.events,
    maxAttempts:integer('PTR_MAX_ATTEMPTS',3,1,10),graceMs:integer('PTR_DISPATCH_GRACE_MS',2000,0,600000),
    intervalMs:integer('PTR_DISPATCH_INTERVAL_MS',1000,50,60000),
    // Lease drift repair; the grace is one worker lease (same PTR_LEASE_MS default as the worker).
    reconcile:{intervalMs:integer('PTR_LEASE_RECONCILE_INTERVAL_MS',60000,1000,3600000),graceMs:integer('PTR_LEASE_MS',15000,300,600000)},onError:phase=>process.stderr.write(`dispatcher ${phase} error\n`)});
  const capacity=await startCapacityController(process.env,line=>process.stderr.write(`${line}\n`));
  dispatcher.start();
  process.stdout.write('Turn dispatcher started\n');
  const shutdown=()=>{void dispatcher.stop().then(()=>capacity.stop()).then(()=>runtime.close?.()).finally(()=>process.exit(0));};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
void main().catch(()=>{process.stderr.write('DISPATCHER_STARTUP_FAILED\n');process.exitCode=1;});
