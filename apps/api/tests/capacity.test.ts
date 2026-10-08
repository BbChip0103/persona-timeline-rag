import { capacitySettings, workerCapacityLine } from '../src/capacity';

describe('capacity controller settings (dispatcher)',()=>{
  const redis={PTR_GATEWAY_DISCOVERY:'redis',PTR_GATEWAY_POOL:'gemma-4-e4b-fp8'};
  test('defaults: on with Redis discovery; headroom 0.25, FLOOR 1, 5 s, Q = PTR_GATEWAY_MAX_QUEUE (256), queue turns',()=>{
    expect(capacitySettings(redis)).toMatchObject({mode:'on',pool:'gemma-4-e4b-fp8',headroom:0.25,floor:1,intervalMs:5000,q:256,queueName:'turns',prefix:'ptr:llm'});
    expect(capacitySettings({}).mode).toBe('off');
    expect(capacitySettings({...redis,PTR_GATEWAY_MAX_QUEUE:'64',PTR_CAPACITY_HEADROOM:'0.5',PTR_CAPACITY_FLOOR:'4',PTR_TURN_QUEUE:'loadtest-turns'}))
      .toMatchObject({q:64,headroom:0.5,floor:4,queueName:'loadtest-turns'});
    expect(capacitySettings({PTR_CAPACITY_CONTROLLER:'on',PTR_SELFHOSTED_MODEL:'m'}).pool).toBe('m');
  });
  test('invalid values fail at startup',()=>{
    for(const [name,value] of [['PTR_CAPACITY_HEADROOM','-0.1'],['PTR_CAPACITY_HEADROOM','5'],['PTR_CAPACITY_FLOOR','0'],['PTR_CAPACITY_INTERVAL_MS','10'],['PTR_GATEWAY_MAX_QUEUE','-1']] as const)
      expect(()=>capacitySettings({...redis,[name]:value})).toThrow(`INVALID_${name}`);
    expect(()=>capacitySettings({PTR_CAPACITY_CONTROLLER:'on'})).toThrow('INVALID_PTR_CAPACITY_POOL');
    expect(()=>capacitySettings({...redis,PTR_TURN_QUEUE:'a:b'})).toThrow('INVALID_PTR_TURN_QUEUE');
  });
});

describe('worker startup line',()=>{
  test('controller on: only the current G is logged (the S1 Σ-concurrency warning is for off)',()=>{
    expect(workerCapacityLine({mode:'on',globalConcurrency:30})).toBe('capacity controller on: global concurrency G=30 (PTR_WORKER_CONCURRENCY is a local cap only)');
    expect(workerCapacityLine({mode:'on',globalConcurrency:null})).toBe('capacity controller on: global concurrency G=unset (PTR_WORKER_CONCURRENCY is a local cap only)');
    expect(workerCapacityLine({mode:'off',globalConcurrency:12})).toBeNull();
  });
});
