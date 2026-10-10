import { randomUUID } from 'node:crypto';
import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { FrameworkTurnWorker, WorkerOutboxMaintenance, type TurnDispatch } from '@ptr/core';
import { REDIS_PREFIX, assertLocalRedisUrl, turnJobId } from '@ptr/messaging';

function dispatch(value:unknown):TurnDispatch|undefined {
  const candidate=value as TurnDispatch;
  return candidate&&typeof candidate.turnId==='string'&&candidate.turnId.length>0&&candidate.turnId.length<=200
    &&Number.isInteger(candidate.seq)&&candidate.seq>=0 ? {turnId:candidate.turnId,seq:candidate.seq} : undefined;
}

/** Nest owns worker creation, BullMQ lock renewal/stalled recovery, lifecycle and graceful drain. */
export class TurnQueueProcessor extends WorkerHost {
  private readonly executions=new Map<string,string>();
  constructor(private readonly turns:FrameworkTurnWorker,private readonly onError:(error:unknown)=>void=()=>undefined) {super();}
  async process(job:Job,token?:string):Promise<void> {
    const value=dispatch(job.data);if(!value)return;
    const id=token??randomUUID();this.executions.set(job.id!,id);
    try {await this.turns.handle(value,id);}
    finally {if(this.executions.get(job.id!)===id)this.executions.delete(job.id!);}
  }
  @OnWorkerEvent('stalled')
  stalled(jobId:string):void {const id=this.executions.get(jobId);if(id)this.turns.loseLock(id);}
  @OnWorkerEvent('lockRenewalFailed')
  lockRenewalFailed(jobIds:string[]):void {for(const jobId of jobIds)this.stalled(jobId);}
  @OnWorkerEvent('error')
  error(error:Error):void {this.onError(error);}
}

export function turnWorkerModule(options:{redisUrl:string;queueName:string;concurrency:number;lockDuration:number;
  maxStalledCount:number;turns:FrameworkTurnWorker;maintenance:WorkerOutboxMaintenance;onError(error:unknown):void}):DynamicModule {
  class ScopedProcessor extends TurnQueueProcessor {}
  Processor(options.queueName,{concurrency:options.concurrency,lockDuration:options.lockDuration,
    stalledInterval:options.lockDuration,maxStalledCount:options.maxStalledCount})(ScopedProcessor);
  const url=new URL(assertLocalRedisUrl(options.redisUrl));
  // Pass options, not a shared client: framework queues/workers own and close their own connections.
  const connection={host:url.hostname,port:Number(url.port),db:Number(url.pathname.slice(1)||0),
    ...(url.username?{username:decodeURIComponent(url.username)}:{}),...(url.password?{password:decodeURIComponent(url.password)}:{}),
    maxRetriesPerRequest:null,connectionName:'ptr'};
  class Lifecycle {
    onModuleInit():void {options.maintenance.start();}
    async onModuleDestroy():Promise<void> {await options.maintenance.stop();}
    async onApplicationShutdown():Promise<void> {await options.turns.stop();}
  }
  @Module({}) class TurnWorkerModule {}
  return {module:TurnWorkerModule,imports:[BullModule.forRoot({connection,prefix:REDIS_PREFIX}),
    BullModule.registerQueue({name:options.queueName})],providers:[
    {provide:ScopedProcessor,useFactory:()=>new ScopedProcessor(options.turns,options.onError)},Lifecycle]};
}

/** Queue lookup stays fail-fast. An unreachable Redis must not be treated as a missing queue job. */
export const queueDispatchState=(queue:{getJobState(id:string):Promise<string>})=>(value:TurnDispatch)=>queue.getJobState(turnJobId(value));
