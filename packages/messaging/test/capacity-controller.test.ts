import { CapacityController, CapacityPlanner, MemoryCapacityStore, capacityControllerMode, capacityTarget, type CapacityQueue } from '../src/capacity-controller';
import { MemoryUpstreamRegistry, parseUpstreamAllow, type UpstreamRecord } from '../src/upstream-registry';

describe('capacity target ',()=>{
  test('G* = max(FLOOR, min(ceil(S_live × (1 + headroom)), S_live + Q))',()=>{
    expect(capacityTarget({sLive:12,q:256,headroom:0.25,floor:1})).toBe(15);
    expect(capacityTarget({sLive:24,q:256,headroom:0.25,floor:1})).toBe(30);
    expect(capacityTarget({sLive:24,q:2,headroom:0.25,floor:1})).toBe(26); // the queue bound wins
    expect(capacityTarget({sLive:0,q:256,headroom:0.25,floor:1})).toBe(1); // never 0 (0 would stop everything)
    expect(capacityTarget({sLive:12,q:256,headroom:0,floor:1})).toBe(12);
    expect(capacityTarget({sLive:1,q:0,headroom:0.25,floor:4})).toBe(4);
  });
});

describe('capacity planner: hysteresis',()=>{
  const planner=()=>new CapacityPlanner({q:256,headroom:0.25,floor:1});
  test('unset options fall back to the defaults (headroom 0.25, FLOOR 1)',()=>{
    expect(new CapacityPlanner({q:256,headroom:undefined,floor:undefined}).step({sLive:12,draining:[],current:null}).next).toBe(15);
  });
  test('unset → set at once; increases apply at once',()=>{
    const p=planner();
    expect(p.step({sLive:12,draining:[],current:null})).toEqual({target:15,next:15,reason:'init'});
    expect(p.step({sLive:24,draining:[],current:15})).toEqual({target:30,next:30,reason:'increase'});
    expect(p.step({sLive:24,draining:[],current:30})).toEqual({target:30,next:30,reason:'hold'});
  });
  test('a decrease waits for 3 consecutive lower ticks, then moves at most 25% per tick',()=>{
    const p=planner();
    const step=(current:number)=>p.step({sLive:16,draining:[],current}); // target 20
    expect(step(30)).toMatchObject({next:30,reason:'decrease_pending'});
    expect(step(30)).toMatchObject({next:30,reason:'decrease_pending'});
    expect(step(30)).toMatchObject({target:20,next:23,reason:'decrease'}); // ceil(30 × 0.75)
    expect(step(23)).toMatchObject({next:20,reason:'decrease'});
    expect(step(20)).toMatchObject({next:20,reason:'hold'});
  });
  test('a flap shorter than the hysteresis never lowers G',()=>{
    const p=planner();
    expect(p.step({sLive:12,draining:[],current:30}).next).toBe(30);
    expect(p.step({sLive:12,draining:[],current:30}).next).toBe(30);
    expect(p.step({sLive:24,draining:[],current:30})).toMatchObject({next:30,reason:'hold'}); // back: streak reset
    expect(p.step({sLive:12,draining:[],current:30}).next).toBe(30);
    expect(p.step({sLive:12,draining:[],current:30}).next).toBe(30);
  });
  test('a newly draining upstream lowers G at once (planned shrink)',()=>{
    const p=planner();
    p.step({sLive:24,draining:[],current:30});
    expect(p.step({sLive:12,draining:['pod-b'],current:30})).toEqual({target:15,next:15,reason:'draining'});
    expect(p.step({sLive:12,draining:['pod-b'],current:15})).toMatchObject({next:15,reason:'hold'});
  });
  test('registry unreadable: hold the last value, and those ticks never count toward a decrease',()=>{
    const p=planner();
    p.step({sLive:12,draining:[],current:30});p.step({sLive:12,draining:[],current:30});
    expect(p.step({sLive:null,draining:[],current:30})).toEqual({target:null,next:30,reason:'registry_stale'});
    expect(p.step({sLive:24,draining:[],current:30}).reason).toBe('hold');
    expect(p.step({sLive:null,draining:[],current:null})).toEqual({target:null,next:null,reason:'registry_stale'});
  });
  test('an empty but readable registry goes to FLOOR through the hysteresis',()=>{
    const p=new CapacityPlanner({q:256,headroom:0.25,floor:1});
    const values:number[]=[];let current=15;
    for(let i=0;i<12;i++) {current=p.step({sLive:0,draining:[],current}).next!;values.push(current);}
    // max(target, min(G − 1, ceil(G × 0.75))): always at least one step, so small values still reach FLOOR.
    expect(values).toEqual([15,15,12,9,7,6,5,4,3,2,1,1]);
  });
});

describe('capacity controller',()=>{
  const rec=(id:string,port:number,extra:Partial<UpstreamRecord>={}):UpstreamRecord=>({pool:'m',id,baseUrl:`http://127.0.0.1:${port}/v1`,
    maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active',epoch:'e1',seq:0,...extra});
  function setup(options:{leader?:boolean}={}) {
    let now=1_000_000;const registry=new MemoryUpstreamRegistry(()=>now);
    const writes:number[]=[];let concurrency:number|null=null;const counts={active:0,wait:0};
    const queue:CapacityQueue={getGlobalConcurrency:async()=>concurrency,setGlobalConcurrency:async(n:number)=>{concurrency=n;writes.push(n);},
      getJobCounts:async()=>({...counts})};
    const store=new MemoryCapacityStore();if(options.leader===false) store.leader='someone-else';
    const lines:string[]=[];
    const controller=new CapacityController({registry,queue,store,pool:'m',allow:parseUpstreamAllow(undefined),id:'dispatcher-1',
      q:256,headroom:0.25,floor:1,intervalMs:5000,log:line=>lines.push(line),now:()=>now});
    return {registry,controller,store,writes,counts,lines,advance:(ms:number)=>{now+=ms;},get:()=>concurrency};
  }
  test('counts active, allowlisted upstreams (draining and rejected ones excluded) and writes only on change',async()=>{
    const s=setup();
    await s.registry.heartbeat(rec('a',18000),10000);await s.registry.heartbeat(rec('b',18001),10000);
    await s.registry.heartbeat(rec('rogue',19999),10000);await s.registry.heartbeat(rec('dup',18000,{baseUrl:'http://127.0.0.1:18000/x'}),10000);
    expect(await s.controller.tick()).toMatchObject({leader:true,sLive:24,target:30,g:30,reason:'init'});
    await s.controller.tick();
    expect(s.writes).toEqual([30]);
    await s.registry.setState('m','b','draining');
    expect(await s.controller.tick()).toMatchObject({sLive:12,g:15,reason:'draining'});
    expect(s.writes).toEqual([30,15]);
    expect(s.store.status).toMatchObject({target:'15',sLive:'12',q:'256',g:'15',reason:'draining',writes:'2',leader:'dispatcher-1'});
    expect(s.lines.some(line=>/^capacity G=15 target=15 S_live=12 Q=256 .*reason=draining/.test(line))).toBe(true);
  });
  test('only the leader acts',async()=>{
    const s=setup({leader:false});
    await s.registry.heartbeat(rec('a',18000),10000);
    expect(await s.controller.tick()).toMatchObject({leader:false});
    expect(s.writes).toEqual([]);
  });
  test('registry unreachable: keeps the last G and reports registry_stale',async()=>{
    const s=setup();
    await s.registry.heartbeat(rec('a',18000),10000);await s.controller.tick();
    s.registry.down=true;
    expect(await s.controller.tick()).toMatchObject({reason:'registry_stale',g:15,registryStale:true});
    expect(s.writes).toEqual([15]);
  });
  test('worker_shortage: jobs wait while fewer than G are active for 15 s',async()=>{
    const s=setup();
    await s.registry.heartbeat(rec('a',18000),60000);
    s.counts.wait=10;s.counts.active=4;
    expect((await s.controller.tick()).workerShortage).toBe(false);
    s.advance(10000);expect((await s.controller.tick()).workerShortage).toBe(false);
    s.advance(5000);expect((await s.controller.tick()).workerShortage).toBe(true);
    expect(s.lines.filter(line=>line.startsWith('WARNING worker_shortage'))).toHaveLength(1);
    s.counts.active=15;s.advance(5000);expect((await s.controller.tick()).workerShortage).toBe(false);
  });
});

describe('controller mode',()=>{
  test('default on with Redis discovery, off otherwise; explicit values win; anything else is an error',()=>{
    expect(capacityControllerMode({})).toBe('off');
    expect(capacityControllerMode({PTR_GATEWAY_DISCOVERY:'redis'})).toBe('on');
    expect(capacityControllerMode({PTR_GATEWAY_DISCOVERY:'redis',PTR_CAPACITY_CONTROLLER:'off'})).toBe('off');
    expect(capacityControllerMode({PTR_CAPACITY_CONTROLLER:'on'})).toBe('on');
    expect(capacityControllerMode({PTR_CAPACITY_CONTROLLER:'clear'})).toBe('clear');
    expect(()=>capacityControllerMode({PTR_CAPACITY_CONTROLLER:'yes'})).toThrow('INVALID_PTR_CAPACITY_CONTROLLER');
  });
});
