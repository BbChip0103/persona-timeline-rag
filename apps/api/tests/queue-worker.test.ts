import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TurnQueueProcessor } from '../src/queue-worker';
import { FrameworkTurnWorker } from '@ptr/core';
import type { Job } from 'bullmq';
describe('Nest WorkerHost turn processor',()=>{
  test('default entrypoint owns maintenance/metrics in the Nest worker, never starts legacy dispatcher',()=>{
    const source=readFileSync(resolve(__dirname,'../src/worker.ts'),'utf8');
    const manifest=JSON.parse(readFileSync(resolve(__dirname,'../../../package.json'),'utf8'));
    expect(source).toContain('NestFactory.createApplicationContext(turnWorkerModule(');
    expect(source).toContain('new WorkerOutboxMaintenance(');expect(source).toContain('workerMaintenanceObservability(observed.registry');
    expect(source).toContain('onEvent:maintenanceObserved.onEvent');expect(source).toContain('render:observed.render');
    expect(source).not.toMatch(/\bTurnDispatcher\b|\bnew Worker\(/);expect(manifest.scripts).not.toHaveProperty('dev:dispatcher');
  });
  test('forwards framework lock token and ignores malformed jobs',async()=>{
    const turns={handle:jest.fn(async()=>undefined),loseLock:jest.fn()} as unknown as FrameworkTurnWorker;const processor=new TurnQueueProcessor(turns);
    await processor.process({id:'synthetic-job',data:{turnId:'synthetic-turn',seq:0}} as Job,'synthetic-token');
    expect(turns.handle).toHaveBeenCalledWith({turnId:'synthetic-turn',seq:0},'synthetic-token');
    await processor.process({id:'bad',data:{turnId:'private',seq:-1}} as Job,'bad-token');expect(turns.handle).toHaveBeenCalledTimes(1);
  });
  test('lock renewal failure aborts exact execution, completion retires mapping',async()=>{
    let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;});
    const turns={handle:jest.fn(()=>waiting),loseLock:jest.fn()} as unknown as FrameworkTurnWorker;const processor=new TurnQueueProcessor(turns);
    const done=processor.process({id:'synthetic-job',data:{turnId:'synthetic-turn',seq:0}} as Job,'token');
    processor.lockRenewalFailed(['synthetic-job']);expect(turns.loseLock).toHaveBeenCalledWith('token');release();await done;
    (turns.loseLock as jest.Mock).mockClear();processor.stalled('synthetic-job');expect(turns.loseLock).not.toHaveBeenCalled();
  });
});
