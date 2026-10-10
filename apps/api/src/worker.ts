import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import { FrameworkTurnWorker, WorkerOutboxMaintenance } from '@ptr/core';
import { REDIS_PREFIX, createRedisConnection } from '@ptr/messaging';
import { WORKER_METRICS_PORT, loadFrameworkConfig, metricsPort, startMetricsListener } from '@ptr/ops';
import { workerMaintenanceObservability, workerObservability } from './observability';
import { createRuntime } from './runtime';
import { queueDispatchState, turnWorkerModule } from './queue-worker';

function integer(name:string,fallback:number,min:number,max:number):number {
  const value=Number(process.env[name]??fallback);
  if(!Number.isInteger(value)||value<min||value>max)throw new Error(`INVALID_${name}`);
  return value;
}
async function main() {
  // Retained only for frozen TypeScript baseline comparisons; production jobs belong to Python.
  if(process.env.PTR_LLM_SERVICE_MODE!=='legacy')throw new Error('LEGACY_WORKER_DISABLED');
  loadFrameworkConfig('worker',process.env);
  let active=()=>0;
  const observed=workerObservability({activeTurns:()=>active()});
  const runtime=createRuntime(process.env,observed.chatHooks);
  const workerId=process.env.PTR_WORKER_ID??`worker-${randomUUID().slice(0,8)}`;
  const maxQueueMs=integer('PTR_TURN_MAX_QUEUE_MS',60000,1000,3600000),maxAttempts=integer('PTR_MAX_ATTEMPTS',3,1,10);
  const turns=new FrameworkTurnWorker({chat:runtime.chat,executions:runtime.executionStore,workerId,maxQueueMs,maxAttempts,
    cancellations:runtime.eventSource,onFinished:observed.onFinished});active=()=>turns.activeTurns;
  const redisUrl=process.env.PTR_REDIS_URL??'',queueName=process.env.PTR_TURN_QUEUE??'turns';
  const connection=createRedisConnection(redisUrl);connection.on('error',()=>undefined);
  const queue=new Queue(queueName,{connection,prefix:REDIS_PREFIX});
  const maintenanceObserved=workerMaintenanceObservability(observed.registry,{queueWaiting:()=>queue.getWaitingCount(),oldestPendingAgeSeconds:()=>runtime.oldestPendingAgeSeconds()});
  const maintenance=new WorkerOutboxMaintenance({executions:runtime.executionStore,delivery:runtime.delivery,
    events:runtime.events,state:queueDispatchState(queue),maxQueueMs,maxAttempts,
    graceMs:integer('PTR_DISPATCH_GRACE_MS',2000,0,600000),intervalMs:integer('PTR_DISPATCH_INTERVAL_MS',1000,50,60000),
    onEvent:maintenanceObserved.onEvent,onError:()=>observed.log('worker_error',{phase:'outbox'})});
  const app=await NestFactory.createApplicationContext(turnWorkerModule({redisUrl,queueName,
    concurrency:integer('PTR_WORKER_CONCURRENCY',32,1,1024),lockDuration:integer('PTR_QUEUE_LOCK_MS',30000,300,600000),
    maxStalledCount:Math.max(0,maxAttempts-1),turns,maintenance,onError:()=>observed.log('worker_error',{phase:'queue'})}),{logger:false});
  const listener=await startMetricsListener({port:metricsPort(process.env,WORKER_METRICS_PORT),render:observed.render,onEvent:observed.log});
  process.stdout.write(`Nest BullMQ worker ${workerId} started\n`);
  let closing=false;
  const shutdown=()=>{if(closing)return;closing=true;
    void app.close().then(()=>queue.close()).then(()=>connection.disconnect()).then(()=>listener?.close()).then(()=>runtime.close?.())
      .then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
void main().catch(()=>{process.stderr.write('WORKER_STARTUP_FAILED\n');process.exitCode=1;});
