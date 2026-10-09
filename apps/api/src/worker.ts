import { randomUUID } from 'node:crypto';
import { TurnWorker } from '@ptr/core';
import { capacityControllerMode, startTurnConsumer } from '@ptr/messaging';
import { WORKER_METRICS_PORT, loadConfig, metricsPort, startMetricsListener } from '@ptr/ops';
import { fetchGatewayCapacity, gatewayCapacityWarning } from '@ptr/providers';
import { readCapacityState, workerCapacityLine } from './capacity';
import { workerObservability } from './observability';
import { createRuntime, gatewayBaseUrls } from './runtime';

/** Turn worker: consumes dispatches from Redis (BullMQ) and runs them under a Postgres lease. Run any number. */
function integer(name:string,fallback:number,min:number,max:number):number {
  const value=Number(process.env[name]??fallback);
  if(!Number.isInteger(value)||value<min||value>max) throw new Error(`INVALID_${name}`);
  return value;
}
async function main() {
  loadConfig('worker',process.env);
  const port=metricsPort(process.env,WORKER_METRICS_PORT);
  // Metrics and JSON log events : turn_finished per turn with its turnId, never text.
  let active=()=>0;
  const observed=workerObservability({activeTurns:()=>active()});
  const runtime=createRuntime(process.env,observed.chatHooks);
  const workerId=process.env.PTR_WORKER_ID??`worker-${randomUUID().slice(0,8)}`;
  // Lease must outlive several heartbeats (lease/3); the dispatcher requeues turns whose lease expired.
  // A turn that waited longer than PTR_TURN_MAX_QUEUE_MS for a worker is not run (the dispatcher fails it with QUEUE_TIMEOUT).
  const worker=new TurnWorker({chat:runtime.chat,leases:runtime.leases,workerId,leaseMs:integer('PTR_LEASE_MS',15000,300,600000),
    maxQueueMs:integer('PTR_TURN_MAX_QUEUE_MS',60000,1000,3600000),cancellations:runtime.eventSource,onError:phase=>observed.log('worker_error',{phase}),
    onFinished:observed.onFinished});
  active=()=>worker.activeTurns;
  const concurrency=integer('PTR_WORKER_CONCURRENCY',32,1,1024), replicas=integer('PTR_WORKER_REPLICAS_HINT',1,1,1024);
  const consumer=startTurnConsumer(process.env.PTR_REDIS_URL??'',dispatch=>worker.handle(dispatch),
    {concurrency,queueName:process.env.PTR_TURN_QUEUE??'turns',onError:()=>observed.log('worker_error',{phase:'queue'})});
  // A failed bind is logged and the worker runs on: observability never blocks turns (D18).
  const listener=await startMetricsListener({port,render:observed.render,onEvent:observed.log});
  process.stdout.write(`Turn worker ${workerId} started\n`);
  // With the capacity controller on, BullMQ's global concurrency enforces the capacity rule; log it once. Only an explicit
  // PTR_CAPACITY_CONTROLLER counts here: the mode derived from PTR_GATEWAY_DISCOVERY=redis (set on workers to read the
  // gateway registry) says nothing about a controller, so the line follows the leader lock (see workerCapacityLine).
  const capacityMode=capacityControllerMode(process.env), explicit=process.env.PTR_CAPACITY_CONTROLLER!==undefined;
  void readCapacityState(process.env).then(state=>{
    const line=workerCapacityLine({mode:capacityMode,explicit,...state});if(line) process.stderr.write(`${line}\n`);
    return state.controllerRunning;
  },()=>{process.stderr.write('capacity check skipped: Redis unavailable\n');return false;}).then(controllerRunning=>{
    // No controller here or elsewhere: advisory, never blocking: Σ worker concurrency (this × PTR_WORKER_REPLICAS_HINT) ≤ gateway caps + queue.
    if((explicit&&capacityMode==='on')||controllerRunning||runtime.providerName!=='gateway') return;
    void fetchGatewayCapacity(gatewayBaseUrls(process.env),process.env.PTR_GATEWAY_TOKEN??'').then(capacity=>{
      const warning=capacity?gatewayCapacityWarning({workerConcurrency:concurrency,replicas,capacity}):'gateway capacity check skipped: no gateway /metrics answered';
      if(warning) process.stderr.write(`${warning}\n`);
    });
  });
  // Graceful: stop taking jobs and let in-flight turns finish; a crash instead leaves them to lease recovery.
  const shutdown=()=>{void consumer.close().then(()=>worker.stop()).then(()=>listener?.close()).then(()=>runtime.close?.()).finally(()=>process.exit(0));};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
void main().catch(()=>{process.stderr.write('WORKER_STARTUP_FAILED\n');process.exitCode=1;});
