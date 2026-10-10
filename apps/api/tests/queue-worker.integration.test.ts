import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { Queue } from 'bullmq';
import { FrameworkTurnWorker, WorkerOutboxMaintenance } from '@ptr/core';
import { createRedisConnection, REDIS_PREFIX } from '@ptr/messaging';
import { turnWorkerModule } from '../src/queue-worker';

const raw=process.env.PTR_FRAMEWORK_TEST_REDIS_URL;
const enabled=(()=>{if(!raw)return false;const url=new URL(raw);return url.protocol==='redis:'&&url.hostname==='127.0.0.1'&&url.port==='57479';})();
const integration=enabled?describe:describe.skip;
const until=async(check:()=>Promise<boolean>,ms=7000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('framework queue condition timeout');};
integration('real Nest BullMQ lifecycle in new isolated Redis only',()=>{
  test('framework discovers factory WorkerHost, consumes bounded jobs and closes all owned clients',async()=>{
    const queueName=`framework-${randomUUID().slice(0,8)}`,connection=createRedisConnection(raw!);
    const queue=new Queue(queueName,{connection,prefix:REDIS_PREFIX});
    const calls:{turnId:string;seq:number}[]=[];
    const turns={handle:async(value:{turnId:string;seq:number})=>{calls.push(value);},loseLock:()=>undefined,stop:async()=>undefined} as unknown as FrameworkTurnWorker;
    const maintenance={start:()=>undefined,stop:async()=>undefined} as WorkerOutboxMaintenance;
    const app=await NestFactory.createApplicationContext(turnWorkerModule({redisUrl:raw!,queueName,concurrency:2,lockDuration:1000,maxStalledCount:2,turns,maintenance,onError:()=>undefined}),{logger:false});
    try {
      for(let i=0;i<3;i++)await queue.add('turn',{turnId:`synthetic-turn-${i}`,seq:0},{jobId:`synthetic-${i}`});
      await until(async()=>(await queue.getJobCounts('completed')).completed===3);
      expect(calls).toHaveLength(3);expect(calls.map(call=>call.turnId).sort()).toEqual(['synthetic-turn-0','synthetic-turn-1','synthetic-turn-2']);
    } finally {await app.close();await queue.obliterate({force:true});await queue.close();connection.disconnect();}
  },15000);
  test('real lost lock emits framework notification and stalled recovery redelivers the same dispatch',async()=>{
    const queueName=`framework-stall-${randomUUID().slice(0,8)}`,connection=createRedisConnection(raw!);
    const queue=new Queue(queueName,{connection,prefix:REDIS_PREFIX});
    const tokens:string[]=[];let firstDone:(()=>void)|undefined;let aborted=0;
    const turns={handle:async(_value:unknown,token:string)=>{tokens.push(token);if(tokens.length===1)await new Promise<void>(resolve=>{firstDone=resolve;});},
      loseLock:()=>{aborted++;firstDone?.();},stop:async()=>{firstDone?.();}} as unknown as FrameworkTurnWorker;
    const maintenance={start:()=>undefined,stop:async()=>undefined} as WorkerOutboxMaintenance;
    const app=await NestFactory.createApplicationContext(turnWorkerModule({redisUrl:raw!,queueName,concurrency:2,lockDuration:600,maxStalledCount:2,turns,maintenance,onError:()=>undefined}),{logger:false});
    try {
      await queue.add('turn',{turnId:'synthetic-stalled-turn',seq:0},{jobId:'synthetic-stalled-job'});
      await until(async()=>tokens.length===1);
      // Remove only this synthetic job's lock in the fresh throwaway Redis. No shared queue/flush operation.
      await connection.del(queue.toKey('synthetic-stalled-job:lock'));
      await until(async()=>(await queue.getJobCounts('completed')).completed===1,12000);
      expect(tokens).toHaveLength(2);expect(new Set(tokens).size).toBe(2);expect(aborted).toBeGreaterThan(0);
    } finally {firstDone?.();await app.close();await queue.obliterate({force:true});await queue.close();connection.disconnect();}
  },20000);

});
