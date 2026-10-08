import { CapacityController, CapacityPlanner, MemoryCapacityStore, capacityControllerMode, capacityTarget, type CapacityQueue } from '../src/capacity-controller';
import { MemoryUpstreamRegistry, parseUpstreamAllow, type UpstreamRecord } from '../src/upstream-registry';
import { MemoryGatewayRegistry, parseGatewayAllow } from '../src/gateway-registry';

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
  function setup(options:{leader?:boolean;intervalMs?:number}={}) {
    let now=1_000_000;const registry=new MemoryUpstreamRegistry(()=>now);
    const writes:number[]=[];let concurrency:number|null=null;const counts={active:0,wait:0};
    const queue:CapacityQueue={getGlobalConcurrency:async()=>concurrency,setGlobalConcurrency:async(n:number)=>{concurrency=n;writes.push(n);},
      getJobCounts:async()=>({...counts})};
    const store=new MemoryCapacityStore();if(options.leader===false) store.leader='someone-else';
    const lines:string[]=[];
    const controller=new CapacityController({registry,queue,store,pool:'m',allow:parseUpstreamAllow(undefined),id:'dispatcher-1',
      q:256,headroom:0.25,floor:1,intervalMs:options.intervalMs??5000,log:line=>lines.push(line),now:()=>now});
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
  test('Q = Σ maxQueue of the active gateways in the gateway registry (S6); the env value when none is active or it cannot be read',async()=>{
    let now=1_000_000;const registry=new MemoryUpstreamRegistry(()=>now);const gateways=new MemoryGatewayRegistry();
    let concurrency:number|null=null;
    const queue:CapacityQueue={getGlobalConcurrency:async()=>concurrency,setGlobalConcurrency:async(n:number)=>{concurrency=n;},getJobCounts:async()=>({active:0,wait:0})};
    const store=new MemoryCapacityStore();
    // headroom 4: ceil(S × 5) is above S + Q, so G = S + Q shows the Q in use.
    const controller=new CapacityController({registry,gateways,gatewayAllow:parseGatewayAllow(undefined),queue,store,pool:'m',allow:parseUpstreamAllow(undefined),
      id:'dispatcher-1',q:256,headroom:4,floor:1,log:()=>undefined,now:()=>now});
    await registry.heartbeat(rec('a',18000),1e9);
    expect(await controller.tick()).toMatchObject({sLive:12,q:256,qSource:'env',g:60}); // no gateway registered: min(60, 12 + 256)
    const gw=(id:string,port:number,maxQueue:number,state:'active'|'draining'='active')=>({id,url:`http://127.0.0.1:${port}/v1`,maxQueue,state,startedAt:1,seq:0});
    await gateways.heartbeat(gw('gw-a',56460,8),10000,5000);await gateways.heartbeat(gw('gw-b',56461,4),10000,5000);
    await gateways.heartbeat(gw('gw-c',56462,100,'draining'),10000,5000);await gateways.heartbeat(gw('gw-x',18000,100),10000,5000); // draining, off the allowlist
    now+=60000; // past the hysteresis
    for(let i=0;i<8;i++) {await controller.tick();now+=5000;}
    expect(await controller.tick()).toMatchObject({q:12,qSource:'registry',g:24});
    expect(store.status).toMatchObject({q:'12',qSource:'registry'});
    gateways.down=true;
    expect(await controller.tick()).toMatchObject({q:256,qSource:'env'});
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

describe('capacity controller: review follow-ups',()=>{
  const rec=(id:string,port:number,extra:Partial<UpstreamRecord>={}):UpstreamRecord=>({pool:'m',id,baseUrl:`http://127.0.0.1:${port}/v1`,
    maxSeqs:12,kvCapacityTokens:null,weight:1,state:'active',epoch:'e1',seq:0,...extra});
  function setup(start:number|null=30) {
    let now=1_000_000;const registry=new MemoryUpstreamRegistry(()=>now);
    const writes:number[]=[];let concurrency:number|null=start;const counts={active:0,wait:0};
    const queue:CapacityQueue={getGlobalConcurrency:async()=>concurrency,setGlobalConcurrency:async(n:number)=>{concurrency=n;writes.push(n);},getJobCounts:async()=>({...counts})};
    const store=new MemoryCapacityStore();const lines:string[]=[];
    const make=(id='d1',intervalMs=5000)=>new CapacityController({registry,queue,store,pool:'m',allow:parseUpstreamAllow(undefined),id,q:256,intervalMs,
      log:line=>lines.push(line),now:()=>now});
    return {registry,store,writes,counts,lines,make,advance:(ms:number)=>{now+=ms;},get:()=>concurrency};
  }
  test('S_live = 0 because every record was rejected: G is held (no decay to FLOOR) and a warning names the reasons',async()=>{
    const s=setup();const c=s.make();
    await s.registry.heartbeat(rec('rogue',19999),60000);
    for(let i=0;i<5;i++) expect(await c.tick()).toMatchObject({g:30,reason:'hold_suspect',rejected:1});
    expect(s.writes).toEqual([]);
    expect(s.lines.filter(line=>line.startsWith('WARNING capacity: S_live=0 but 1 registry record(s) rejected (not_allowed:1)'))).toHaveLength(1);
  });
  test('first start (G unset) with every record rejected: G stays unset (no write of FLOOR) and the warning says so',async()=>{
    const s=setup(null);const c=s.make();
    await s.registry.heartbeat(rec('rogue',19999),60000);
    for(let i=0;i<3;i++) expect(await c.tick()).toMatchObject({g:null,target:null,reason:'hold_suspect',rejected:1});
    expect(s.writes).toEqual([]);
    expect(s.lines.filter(line=>line.startsWith('WARNING capacity: S_live=0 but 1 registry record(s) rejected (not_allowed:1); leaving G unset'))).toHaveLength(1);
  });
  test('first start (G unset) with a configuration that looks wrong: G stays unset indefinitely (the 5 min bound is for a set G)',async()=>{
    const s=setup(null);const c=s.make();
    await s.registry.heartbeat(rec('rogue',19999),3600000);
    await c.tick();s.advance(600000);
    expect(await c.tick()).toMatchObject({g:null,reason:'hold_suspect'});
    expect(s.writes).toEqual([]);
    expect(s.lines.some(line=>line.startsWith('WARNING capacity: holding G for'))).toBe(false);
  });
  test('first start (G unset) with live records only in other pools: G stays unset, with the pool warning',async()=>{
    const s=setup(null);const c=s.make();
    await s.registry.heartbeat(rec('a',18000,{pool:'other-model'}),60000);
    expect(await c.tick()).toMatchObject({g:null,reason:'hold_suspect'});
    expect(s.writes).toEqual([]);
    expect(s.lines.some(line=>line.includes('only in other pools (other-model); leaving G unset'))).toBe(true);
  });
  test('the suspect warning names the setting that matches the rejection reason, never PTR_REGISTRY_PREFIX (the records were found under it)',async()=>{
    const s=setup();const c=s.make();
    await s.registry.heartbeat(rec('rogue',19999),60000);
    await c.tick();
    const line=s.lines.find(l=>l.startsWith('WARNING capacity: S_live=0'))!;
    expect(line).toContain('PTR_GATEWAY_UPSTREAM_ALLOW');expect(line).not.toContain('PTR_REGISTRY_PREFIX');
    const t=setup();const d=t.make();
    await t.registry.heartbeat(rec('loop',18000,{baseUrl:'http://localhost:18000/v1'}),60000);
    await d.tick();
    expect(t.lines.find(l=>l.startsWith('WARNING capacity: S_live=0'))).toMatch(/not_loopback:1.*127\.0\.0\.1/);
  });
  test('the suspect hold is bounded (5 min): a real outage of this pool still shrinks G afterwards',async()=>{
    const s=setup();const c=s.make();
    await s.registry.heartbeat(rec('rogue',19999),3600000);
    expect(await c.tick()).toMatchObject({reason:'hold_suspect'});
    s.advance(300000);
    expect((await c.tick()).reason).toBe('decrease_pending');
    expect(s.lines.some(line=>line.startsWith('WARNING capacity: holding G for 300 s without a usable record'))).toBe(true);
  });
  test('S_live = 0 while other pools have live records (pool or prefix mismatch suspected): G is held, with a warning',async()=>{
    const s=setup();const c=s.make();
    await s.registry.heartbeat(rec('a',18000,{pool:'other-model'}),60000);
    for(let i=0;i<4;i++) expect(await c.tick()).toMatchObject({g:30,reason:'hold_suspect'});
    expect(s.lines.some(line=>line.includes('live records exist only in other pools (other-model)'))).toBe(true);
    // A truly empty registry still decays to FLOOR through the hysteresis.
    await s.registry.remove('other-model','a');
    for(let i=0;i<3;i++) await c.tick();
    expect(s.writes).toEqual([23]);
  });
  test('rejected records next to live ones are counted and logged once, not held',async()=>{
    const s=setup(null);const c=s.make();
    await s.registry.heartbeat(rec('a',18000),60000);await s.registry.heartbeat(rec('rogue',19999),60000);
    expect(await c.tick()).toMatchObject({g:15,reason:'init',rejected:1});await c.tick();
    expect(s.lines.filter(line=>line.startsWith('capacity: 1 registry record(s) rejected'))).toHaveLength(1);
  });
  test('G at FLOOR while turns wait for 15 s: one capacity_floor warning per episode',async()=>{
    const s=setup(1);const c=s.make(); // empty (readable) registry: G sits at FLOOR=1
    s.counts.wait=5;s.counts.active=1;
    for(let i=0;i<4;i++) {await c.tick();s.advance(5000);}
    expect(s.lines.filter(line=>line.startsWith('WARNING capacity_floor'))).toHaveLength(1);
  });
  test('leader lease = max(15 s, 3 × interval)',async()=>{
    const s=setup();
    const ttls:number[]=[];const acquire=s.store.acquireLeader.bind(s.store);
    s.store.acquireLeader=async(id:string,ttl:number)=>{ttls.push(ttl);return acquire(id,ttl);};
    await s.make('d1',5000).tick();await s.make('d1',10000).tick();
    expect(ttls).toEqual([15000,30000]);
  });
  test('a new leader starts with fresh hysteresis and does not treat already-draining records as a new drain',async()=>{
    const s=setup();
    await s.registry.heartbeat(rec('a',18000),600000);await s.registry.heartbeat(rec('b',18001),600000);
    await s.registry.setState('m','b','draining');
    const c=s.make();
    expect(await c.tick()).toMatchObject({target:15,g:30,reason:'decrease_pending'}); // b was draining before this leader: no immediate drop
    expect(await c.tick()).toMatchObject({reason:'decrease_pending'});
    s.store.leader='other';expect(await c.tick()).toMatchObject({leader:false});
    s.store.leader=undefined;
    expect(await c.tick()).toMatchObject({reason:'decrease_pending'}); // streak restarted on regaining leadership
    expect(await c.tick()).toMatchObject({reason:'decrease_pending'});
    expect(await c.tick()).toMatchObject({reason:'decrease',g:23});
  });
});

describe('controller mode',()=>{
  test('default on with Redis discovery, off otherwise; explicit values win; anything else is an error',()=>{
    expect(capacityControllerMode({})).toBe('off');
    expect(capacityControllerMode({PTR_GATEWAY_DISCOVERY:'redis'})).toBe('on');
    expect(capacityControllerMode({PTR_GATEWAY_DISCOVERY:'redis',PTR_CAPACITY_CONTROLLER:'off'})).toBe('off');
    expect(capacityControllerMode({PTR_CAPACITY_CONTROLLER:'on'})).toBe('on');
    expect(capacityControllerMode({PTR_CAPACITY_CONTROLLER:'keep'})).toBe('keep');
    expect(capacityControllerMode({PTR_CAPACITY_CONTROLLER:'clear'})).toBe('off'); // 7d34739 name: off now clears
    expect(()=>capacityControllerMode({PTR_CAPACITY_CONTROLLER:'yes'})).toThrow('INVALID_PTR_CAPACITY_CONTROLLER');
  });
});
