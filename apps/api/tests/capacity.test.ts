import { capacitySettings, clearWhenNoLeader, startCapacityControllerSafely, workerCapacityLine } from '../src/capacity';

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
    expect(()=>capacitySettings({...redis,PTR_REGISTRY_PREFIX:'ptr:turns'})).toThrow('INVALID_PTR_REGISTRY_PREFIX');
  });
});

describe('worker startup line',()=>{
  const line=(mode:'on'|'off'|'keep',explicit:boolean,globalConcurrency:number|null,controllerRunning=false)=>workerCapacityLine({mode,explicit,globalConcurrency,controllerRunning});
  test('controller on: only the current G is logged (the S1 Σ-concurrency warning is for off)',()=>{
    // Only an explicit PTR_CAPACITY_CONTROLLER counts on a worker: a mode derived from PTR_GATEWAY_DISCOVERY=redis (which
    // workers now set to read the gateway registry) says nothing about a controller, so the line follows the leader lock.
    expect(line('on',false,30)).toBe('capacity: global concurrency G=30 is set on the turn queue and no controller leader is alive (PTR_CAPACITY_CONTROLLER unset here): at most 30 turns run');
    expect(line('on',false,30,true)).toBe('capacity controller running elsewhere: global concurrency G=30 (PTR_WORKER_CONCURRENCY is a local cap only)');
    expect(line('on',false,null)).toBeNull();
    expect(line('on',true,null)).toBe('capacity controller on: global concurrency G=unset (PTR_WORKER_CONCURRENCY is a local cap only)');
    expect(line('off',true,null)).toBeNull();
    expect(line('off',true,12)).toBe('WARNING capacity controller off but global concurrency G=12 is set on the turn queue: a dispatcher in off mode clears it at startup; until then at most 12 turns run');
    expect(line('keep',true,12)).toBe('capacity controller keep: global concurrency G=12 left as set (nothing adjusts it)');
  });
  test('mixed fleet: a worker without PTR_CAPACITY_CONTROLLER (or PTR_GATEWAY_DISCOVERY) never warns when a controller runs or G is set',()=>{
    expect(line('off',false,30,true)).toBe('capacity controller running elsewhere: global concurrency G=30 (PTR_WORKER_CONCURRENCY is a local cap only)');
    expect(line('off',false,12)).toBe('capacity: global concurrency G=12 is set on the turn queue and no controller leader is alive (PTR_CAPACITY_CONTROLLER unset here): at most 12 turns run');
    expect(line('off',false,null)).toBeNull();
  });
  test('a warning only when this process explicitly says off/keep while a controller leader runs (another mode)',()=>{
    expect(line('off',true,30,true)).toBe('WARNING PTR_CAPACITY_CONTROLLER=off here, but a capacity controller leader is running (G=30): use the same mode in every process');
    expect(line('keep',true,30,true)).toBe('WARNING PTR_CAPACITY_CONTROLLER=keep here, but a capacity controller leader is running (G=30): use the same mode in every process');
    expect(line('on',true,30,true)).toBe('capacity controller on: global concurrency G=30 (PTR_WORKER_CONCURRENCY is a local cap only)');
  });
});

describe('off mode during a rolling restart (on → off)',()=>{
  function setup(g:number|null,leaders:boolean[]) {
    let concurrency=g;const lines:string[]=[];let checks=0;const timers:(()=>void)[]=[];
    const queue={getGlobalConcurrency:async()=>concurrency,removeGlobalConcurrency:async()=>{concurrency=null;}};
    const handle=clearWhenNoLeader({queue,queueName:'turns',leaderAlive:async()=>leaders[Math.min(checks++,leaders.length-1)]!,log:l=>lines.push(l),recheckMs:15000,
      schedule:(fn)=>{timers.push(fn);return ()=>undefined;}});
    const fire=async()=>{const fn=timers.shift();fn?.();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));};
    return {handle,lines,fire,get:()=>concurrency,pending:()=>timers.length};
  }
  test('no leader: G is removed at once',async()=>{
    const s=setup(30,[false]);await s.handle.started;
    expect(s.get()).toBeNull();expect(s.lines).toEqual(['capacity controller off: removed global concurrency 30 from turns']);
    expect(s.pending()).toBe(0);
  });
  test('a leader is still alive: warn once, re-check every lease interval, clear once it is gone',async()=>{
    const s=setup(30,[true,true,false]);await s.handle.started;
    expect(s.get()).toBe(30);
    expect(s.lines).toEqual(['WARNING capacity controller off here, but another dispatcher leads the controller: global concurrency 30 left as set; re-checking every 15 s and removing it once no leader is alive (use the same PTR_CAPACITY_CONTROLLER everywhere)']);
    await s.fire();expect(s.get()).toBe(30);expect(s.lines).toHaveLength(1);
    await s.fire();expect(s.get()).toBeNull();
    expect(s.lines.at(-1)).toBe('capacity controller off: removed global concurrency 30 from turns');
    expect(s.pending()).toBe(0);
  });
  test('Redis unavailable on the first check or a re-check: logged, and checked again one lease interval later',async()=>{
    let concurrency:number|null=30, fail=2;const lines:string[]=[];const timers:(()=>void)[]=[];let leader=true;
    const queue={getGlobalConcurrency:async()=>{if(fail>0){fail--;throw new Error('down');}return concurrency;},removeGlobalConcurrency:async()=>{concurrency=null;}};
    const handle=clearWhenNoLeader({queue,queueName:'turns',leaderAlive:async()=>leader,log:l=>lines.push(l),recheckMs:15000,schedule:fn=>{timers.push(fn);return ()=>undefined;}});
    const settle=async()=>{for(let i=0;i<5;i++) await new Promise(r=>setImmediate(r));};
    await handle.started;await settle();
    expect(lines).toEqual(['capacity check skipped: Redis unavailable']);expect(timers).toHaveLength(1);
    timers.shift()!();await settle(); // fails again
    expect(lines).toHaveLength(2);expect(timers).toHaveLength(1);
    timers.shift()!();await settle(); // leader alive: warn, re-check
    expect(lines.at(-1)).toMatch(/^WARNING capacity controller off here/);expect(timers).toHaveLength(1);
    leader=false;timers.shift()!();await settle();
    expect(concurrency).toBeNull();expect(timers).toHaveLength(0);
    handle.stop();
  });
  test('G unset: nothing to do',async()=>{
    const s=setup(null,[true]);await s.handle.started;
    expect(s.lines).toEqual([]);expect(s.pending()).toBe(0);
  });
});

describe('dispatcher keeps running when the controller cannot start',()=>{
  test('a configuration error disables the controller with one log line; lease recovery and the outbox go on',async()=>{
    const lines:string[]=[];
    const capacity=await startCapacityControllerSafely({PTR_CAPACITY_CONTROLLER:'on'},line=>lines.push(line));
    await capacity.stop();
    expect(lines).toEqual(['WARNING capacity controller disabled (INVALID_PTR_CAPACITY_POOL): turn dispatch, lease recovery and the outbox continue without it']);
  });
});
